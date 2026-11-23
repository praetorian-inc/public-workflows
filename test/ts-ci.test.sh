#!/usr/bin/env bash
#
# Tests for .github/workflows/ts-ci.yml:
#   * Static contract (workflow permissions: contents: read, extracted step
#     shapes, env: mappings, working-directory, default shell, no ${{ }} in run:)
#   * jobs.preflight.steps[id=check]  — PR changed-file detection, non-PR
#     bypass, and fail-open behavior
#   * jobs.test.steps[name="Run tests"] — failing script stderr preservation,
#     dash-prefixed script execution, missing/invalid scripts, passing scripts
#
# Both `run:` blocks are EXTRACTED from the workflow YAML at runtime, never
# mirrored, and executed via `bash -e` (GitHub Actions' default Linux shell).
#
# Requires: bash (3.2+), python3 with PyYAML, jq, node, npm.
# Usage: bash test/ts-ci.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORKFLOW="${TS_CI_WORKFLOW:-$REPO_ROOT/.github/workflows/ts-ci.yml}"
FIXTURE_DIR="$REPO_ROOT/_test-fixtures/ts-minimal"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

EXTRACT="$WORKDIR/extracted"
mkdir -p "$EXTRACT" "$WORKDIR/bin" "$WORKDIR/home" "$WORKDIR/tmp" "$WORKDIR/npm-cache"

PASS=0
FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  printf '          expected: [%s]\n' "$2"
  printf '          actual:   [%s]\n' "$3"
  FAIL=$((FAIL + 1))
}
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for dep in python3 jq node npm; do
  command -v "$dep" >/dev/null 2>&1 || { echo "ERROR: $dep is required" >&2; exit 1; }
done
[ -f "$WORKFLOW" ] || { echo "ERROR: workflow not found: $WORKFLOW" >&2; exit 1; }
[ -f "$FIXTURE_DIR/package.json" ] || { echo "ERROR: fixture not found: $FIXTURE_DIR/package.json" >&2; exit 1; }

# ── Static contract & extraction of real run: blocks ─────────────────────────
section "Static contract — $(basename "$WORKFLOW")"

python3 - "$WORKFLOW" "$EXTRACT" > "$WORKDIR/static.tsv" <<'PY' || { echo "ERROR: static extraction failed" >&2; exit 1; }
import pathlib
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as fh:
    wf = yaml.safe_load(fh)
out = pathlib.Path(sys.argv[2])


def check(name, cond, expected="", actual=""):
    if cond:
        print("PASS\t%s" % name)
    else:
        print("FAIL\t%s\t%s\t%s" % (name, expected, str(actual).replace("\n", " ")))


def check_step(label, job, step, want_env, filename, want_wd=None):
    body = step.get("run") or ""
    check("%s is a plain run: step (no uses:)" % label, bool(body) and "uses" not in step, "run only", step.get("uses"))
    check("%s run: has no ${{ }} expressions" % label, "${{" not in body, "none", "contains ${{")
    shells = [s for s in (
        step.get("shell"),
        ((job.get("defaults") or {}).get("run") or {}).get("shell"),
        ((wf.get("defaults") or {}).get("run") or {}).get("shell"),
    ) if s]
    check("%s runs in the default shell (bash -e, no pipefail)" % label, not shells, "no shell: override", shells)
    if want_wd is not None:
        check("%s sets working-directory to %s" % (label, want_wd), step.get("working-directory") == want_wd, want_wd, step.get("working-directory"))
    env = step.get("env") or {}
    check("%s env: maps expected inputs/context" % label, env == want_env, want_env, env)
    (out / filename).write_text(body, encoding="utf-8")


check("workflow permissions are contents: read only", wf.get("permissions") == {"contents": "read"}, "{'contents': 'read'}", wf.get("permissions"))

jobs = wf.get("jobs") or {}
preflight = jobs.get("preflight") or {}
pf_step = next((s for s in preflight.get("steps") or [] if s.get("id") == "check"), None)
check("jobs.preflight has step id: check", pf_step is not None, "step id=check", "none")
if pf_step is not None:
    check_step(
        "preflight check",
        preflight,
        pf_step,
        {
            "GH_TOKEN": "${{ secrets.GITHUB_TOKEN }}",
            "EVENT_NAME": "${{ github.event_name }}",
            "REPO": "${{ github.repository }}",
            "BASE_SHA": "${{ github.event.pull_request.base.sha }}",
            "HEAD_SHA": "${{ github.event.pull_request.head.sha }}",
        },
        "preflight.sh",
    )

test_job = jobs.get("test") or {}
rt_step = next((s for s in test_job.get("steps") or [] if s.get("name") == "Run tests"), None)
check("jobs.test has step name: Run tests", rt_step is not None, "step name='Run tests'", "none")
if rt_step is not None:
    check_step(
        "Run tests",
        test_job,
        rt_step,
        {"TEST_SCRIPT": "${{ inputs.test-script }}"},
        "run-tests.sh",
        want_wd="${{ inputs.working-directory }}",
    )
PY

while IFS=$'\t' read -r verdict name exp act; do
  if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
done < "$WORKDIR/static.tsv"

if [ ! -s "$EXTRACT/preflight.sh" ] || [ ! -s "$EXTRACT/run-tests.sh" ]; then
  printf '\n  passed: %d   failed: %d  (extracted step missing — behavioral cases not run)\n' "$PASS" "$((FAIL + 1))"
  exit 1
fi

section "Syntax checks on extracted steps"
for s in preflight.sh run-tests.sh; do
  if bash -n "$EXTRACT/$s" 2>"$WORKDIR/$s.syn"; then
    ok "bash -n $s"
  else
    bad "bash -n $s" "clean parse" "$(cat "$WORKDIR/$s.syn")"
  fi
done

# ── Stub `gh` for preflight behavioral tests ─────────────────────────────────
# Validates `gh api repos/<owner>/<repo>/compare/<base>...<head> --jq <expr>`
# and applies real `jq -r` against a compare-API JSON fixture payload.
cat > "$WORKDIR/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -eu
if [ -n "${GH_CALL_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$GH_CALL_LOG"
fi
[ "${1:-}" = "api" ] || { echo "stub gh: unsupported command: $*" >&2; exit 64; }
shift
path=""
jqf=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq|-q) jqf="$2"; shift 2 ;;
    -*)      echo "stub gh: unsupported flag: $1" >&2; exit 64 ;;
    *)       path="$1"; shift ;;
  esac
done
case "$path" in
  repos/*/*/compare/*...*) ;;
  *) echo "stub gh: unexpected api path: $path" >&2; exit 64 ;;
esac
if [ "${GH_FAIL:-0}" = "1" ]; then
  echo "gh: HTTP 500" >&2
  exit 1
fi
if [ -n "$jqf" ]; then
  jq -r "$jqf" "$GH_RESPONSE_FILE"
else
  cat "$GH_RESPONSE_FILE"
fi
STUB
chmod +x "$WORKDIR/bin/gh"

# ── Runner helpers ───────────────────────────────────────────────────────────
RUN=0
RC=0
OUT=""
STDOUT=""
STDERR=""
GH_LOG=""

outv() { # outv <key> — last value written for that GITHUB_OUTPUT key
  awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { printf "%s", v }' "$OUT"
}

# run_preflight <event_name> <gh_fail> [changed_file ...]
run_preflight() {
  local event_name="$1"
  local gh_fail="$2"
  shift 2
  RUN=$((RUN + 1))
  OUT="$WORKDIR/pf-out.$RUN"
  STDOUT="$WORKDIR/pf-stdout.$RUN"
  STDERR="$WORKDIR/pf-stderr.$RUN"
  GH_LOG="$WORKDIR/pf-gh.$RUN"
  local resp="$WORKDIR/pf-resp.$RUN.json"
  : > "$OUT"
  : > "$GH_LOG"
  if [ $# -eq 0 ]; then
    printf '{"files":[]}\n' > "$resp"
  else
    printf '%s\n' "$@" | jq -Rn '[inputs | {filename: .}] | {files: .}' > "$resp"
  fi
  (
    cd "$WORKDIR" || exit 1
    env -i \
      PATH="$WORKDIR/bin:$PATH" \
      HOME="$WORKDIR/home" \
      TMPDIR="$WORKDIR/tmp" \
      GH_TOKEN=dummy \
      EVENT_NAME="$event_name" \
      REPO="praetorian-inc/public-workflows" \
      BASE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
      HEAD_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
      GITHUB_OUTPUT="$OUT" \
      GH_FAIL="$gh_fail" \
      GH_RESPONSE_FILE="$resp" \
      GH_CALL_LOG="$GH_LOG" \
      bash -e "$EXTRACT/preflight.sh"
  ) >"$STDOUT" 2>"$STDERR"
  RC=$?
}

preflight_case() { # preflight_case <label> <expected_has_ts> <event_name> <gh_fail> [changed_file ...]
  local label="$1" expected="$2" event_name="$3" gh_fail="$4"
  shift 4
  run_preflight "$event_name" "$gh_fail" "$@"
  local got
  got="$(outv has_ts)"
  if [ "$RC" -eq 0 ] && [ "$got" = "$expected" ]; then
    ok "$label"
  else
    bad "$label" "rc=0, has_ts=$expected" "rc=$RC, has_ts=$got, stderr=$(tr '\n' ' ' < "$STDERR")"
  fi
}

# run_tests_step <fixture_mode> <test_script> [override_key] [override_val]
# fixture_mode: as-is | set-script | no-pkg | no-scripts | null-scripts
run_tests_step() {
  local mode="$1" test_script="$2" ov_key="${3:-}" ov_val="${4:-}"
  RUN=$((RUN + 1))
  local d="$WORKDIR/rt-fixture.$RUN"
  STDOUT="$WORKDIR/rt-stdout.$RUN"
  STDERR="$WORKDIR/rt-stderr.$RUN"
  cp -R "$FIXTURE_DIR" "$d"
  case "$mode" in
    as-is) ;;
    set-script)
      jq --arg k "$ov_key" --arg v "$ov_val" '.scripts[$k] = $v' "$d/package.json" > "$d/package.json.tmp"
      mv "$d/package.json.tmp" "$d/package.json"
      ;;
    no-pkg)
      rm -f "$d/package.json"
      ;;
    no-scripts)
      jq 'del(.scripts)' "$d/package.json" > "$d/package.json.tmp"
      mv "$d/package.json.tmp" "$d/package.json"
      ;;
    null-scripts)
      jq '.scripts = null' "$d/package.json" > "$d/package.json.tmp"
      mv "$d/package.json.tmp" "$d/package.json"
      ;;
    *)
      echo "ERROR: unknown fixture mode: $mode" >&2
      exit 1
      ;;
  esac
  (
    cd "$d" || exit 1
    env -i \
      PATH="$PATH" \
      HOME="$WORKDIR/home" \
      TMPDIR="$WORKDIR/tmp" \
      npm_config_cache="$WORKDIR/npm-cache" \
      npm_config_update_notifier=false \
      TEST_SCRIPT="$test_script" \
      bash -e "$EXTRACT/run-tests.sh"
  ) >"$STDOUT" 2>"$STDERR"
  RC=$?
}

# ── INV-1 / CASE-1: Preflight matches subdirectory & root TS manifests/configs
section "INV-1 / CASE-1 — preflight emits has_ts=true for subdirectory and root TS manifests/configs"

for path in \
  "_test-fixtures/ts-minimal/package.json" \
  "subdir/package-lock.json" \
  "subdir/tsconfig.json" \
  "subdir/tsconfig.build.json" \
  "subdir/tsconfig.jsonc" \
  "subdir/vitest.config.ts" \
  "subdir/vitest.config.mts" \
  "subdir/vitest.config.cts" \
  "subdir/eslint.config.mjs" \
  "subdir/eslint.config.mts" \
  "subdir/.eslintrc" \
  "subdir/.eslintrc.json" \
  "subdir/.eslintrc.yml" \
  "src/index.ts" \
  "package.json" \
  "package-lock.json" \
  "tsconfig.json" \
  "tsconfig.jsonc"; do
  preflight_case "PR modifying $path -> has_ts=true" "true" "pull_request" "0" "$path"
done

preflight_case "PR modifying README.md + subdir/package.json -> has_ts=true" \
  "true" "pull_request" "0" "README.md" "subdir/package.json"

# ── INV-2 / CASE-2A: Preflight skips non-TS-only PR diffs ────────────────────
section "INV-2 / CASE-2A — preflight emits has_ts=false for non-TS-only PR diffs"

for path in \
  "README.md" \
  "subdir/my-package.json" \
  "subdir/my-package-lock.json" \
  "subdir/package-lock_json" \
  "subdir/my-tsconfig.json" \
  "subdir/my.eslintrc.json" \
  "subdir/my-vitest.config.mts" \
  "subdir/my-eslint.config.mts" \
  "docs/package.json.md" \
  "docs/package-lock.json.bak" \
  "docs/tsconfig-migration.md" \
  "docs/eslint.config-notes.md" \
  "docs/vitest.config-notes.md" \
  "docs/.eslintrc-notes.md"; do
  preflight_case "PR modifying $path -> has_ts=false" "false" "pull_request" "0" "$path"
done

preflight_case "PR modifying no files -> has_ts=false" "false" "pull_request" "0"

# ── INV-2 / CASE-2B: Non-PR events and fail-open paths emit has_ts=true ──────
section "INV-2 / CASE-2B — non-PR events and fail-open paths emit has_ts=true"

for ev in push workflow_dispatch; do
  run_preflight "$ev" "0" "README.md"
  got="$(outv has_ts)"
  if [ "$RC" -eq 0 ] && [ "$got" = "true" ] && [ ! -s "$GH_LOG" ]; then
    ok "$ev event with README.md -> has_ts=true (no gh api call)"
  else
    bad "$ev event with README.md -> has_ts=true (no gh api call)" \
      "rc=0, has_ts=true, gh_calls=0" \
      "rc=$RC, has_ts=$got, gh_calls=$(wc -l < "$GH_LOG" | tr -d ' ')"
  fi
done

preflight_case "PR with gh api error -> has_ts=true (fail open)" "true" "pull_request" "1" "README.md"

MANY_FILES=()
i=1
while [ "$i" -le 300 ]; do
  MANY_FILES+=("docs/file-$i.md")
  i=$((i + 1))
done
preflight_case "PR with 300 non-TS files -> has_ts=true (300-file cap fail open)" \
  "true" "pull_request" "0" "${MANY_FILES[@]}"

# ── INV-3 / CASE-3: Run tests preserves stderr and exits non-zero on failure ─
section "INV-3 / CASE-3 — Run tests exits non-zero and preserves stderr on failing script"

run_tests_step "set-script" "test:fail" "test:fail" \
  "node -e \"console.error('TEST_STDERR_DIAGNOSTIC'); process.exit(1)\""
if [ "$RC" -ne 0 ] && grep -qF -- "TEST_STDERR_DIAGNOSTIC" "$STDERR" && ! grep -qF -- "Tests passed" "$STDOUT"; then
  ok "failing test:fail exits non-zero and preserves TEST_STDERR_DIAGNOSTIC on stderr"
else
  bad "failing test:fail exits non-zero and preserves TEST_STDERR_DIAGNOSTIC on stderr" \
    "rc!=0, stderr contains TEST_STDERR_DIAGNOSTIC" \
    "rc=$RC, stderr=[$(tr '\n' ' ' < "$STDERR")], stdout=[$(tr '\n' ' ' < "$STDOUT")]"
fi

run_tests_step "set-script" "-s" "-s" \
  "node -e \"console.log('PASS_DASH_SCRIPT'); console.error('ERR_DASH_SCRIPT'); process.exit(3)\""
if [ "$RC" -eq 3 ] && grep -qF -- "PASS_DASH_SCRIPT" "$STDOUT" && grep -qF -- "ERR_DASH_SCRIPT" "$STDERR"; then
  ok "dash-prefixed script '-s' executes (not parsed as npm flag) and preserves rc/stdout/stderr"
else
  bad "dash-prefixed script '-s' executes (not parsed as npm flag) and preserves rc/stdout/stderr" \
    "rc=3, stdout contains PASS_DASH_SCRIPT, stderr contains ERR_DASH_SCRIPT" \
    "rc=$RC, stdout=[$(tr '\n' ' ' < "$STDOUT")], stderr=[$(tr '\n' ' ' < "$STDERR")]"
fi

# ── INV-4 / CASE-4: Run tests rejects missing/invalid test-script ────────────
section "INV-4 / CASE-4 — Run tests exits non-zero naming missing/invalid test-script"

missing_script_case() { # missing_script_case <label> <mode> <test_script> [ov_key] [ov_val]
  local label="$1" mode="$2" script="$3" ov_key="${4:-}" ov_val="${5:-}"
  run_tests_step "$mode" "$script" "$ov_key" "$ov_val"
  local combined="$WORKDIR/rt-combined.$RUN"
  cat "$STDOUT" "$STDERR" > "$combined"
  if [ "$RC" -eq 0 ]; then
    bad "$label" "rc!=0 naming missing script" "rc=0, out=[$(tr '\n' ' ' < "$combined")]"
    return
  fi
  if grep -qF -- "Tests passed" "$combined"; then
    bad "$label" "no 'Tests passed' message" "rc=$RC, out=[$(tr '\n' ' ' < "$combined")]"
    return
  fi
  local trimmed="${script//[[:space:]]/}"
  if [ -n "$trimmed" ]; then
    if grep -qF -- "$script" "$combined"; then ok "$label"
    else bad "$label" "error naming '$script'" "rc=$RC, out=[$(tr '\n' ' ' < "$combined")]"; fi
  else
    if [ -s "$combined" ]; then ok "$label"
    else bad "$label" "non-empty error output" "rc=$RC, out=[]"; fi
  fi
}

missing_script_case "absent script 'nonexistent-script' in _test-fixtures/ts-minimal" "as-is" "nonexistent-script"
missing_script_case "missing package.json with TEST_SCRIPT=test" "no-pkg" "test"
missing_script_case "package.json missing .scripts key" "no-scripts" "missing-scripts-key"
missing_script_case "package.json with .scripts: null" "null-scripts" "null-scripts"
missing_script_case "package.json script value is empty string ''" "set-script" "empty-script" "empty-script" ""
missing_script_case "package.json script value is whitespace '   '" "set-script" "blank-script" "blank-script" "   "
missing_script_case "empty TEST_SCRIPT ''" "as-is" ""
missing_script_case "whitespace TEST_SCRIPT '   '" "as-is" "   "

# ── Guard duality: Run tests succeeds on defined passing scripts ─────────────
section "Run tests — defined passing scripts succeed"

passing_script_case() { # passing_script_case <label> <test_script> <marker>
  local label="$1" script="$2" marker="$3"
  run_tests_step "set-script" "$script" "$script" "node -e \"console.log('$marker')\""
  if [ "$RC" -eq 0 ] && grep -qF -- "$marker" "$STDOUT"; then
    ok "$label"
  else
    bad "$label" "rc=0, stdout contains $marker" \
      "rc=$RC, stdout=[$(tr '\n' ' ' < "$STDOUT")], stderr=[$(tr '\n' ' ' < "$STDERR")]"
  fi
}

passing_script_case "defined default script 'test' runs and succeeds" "test" "PASS_DEFAULT_TEST"
passing_script_case "defined colon/hyphen script 'test:unit-1' runs and succeeds" "test:unit-1" "PASS_COLON_HYPHEN_TEST"

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
