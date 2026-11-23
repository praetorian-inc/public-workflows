#!/usr/bin/env bash
#
# Tests for .github/workflows/go-sec.yml, job govulncheck, step
# "Run govulncheck (SARIF)".
#
# govulncheck exits 0 in SARIF mode even when it finds vulnerabilities (exit 3
# is a text-mode signal only), so a gate on exit code 3 can never trip. The step
# counts SARIF results at level "error" instead (the code calls the vulnerable
# symbol; "warning" = package imported only, "note" = module required only).
# With FAIL_ON_FINDINGS=true it fails when that count is above 0 or the exit
# code is 3, and fails closed when the SARIF is missing or malformed. A tool
# error (exit other than 0 or 3) fails with the tool's own exit code in either
# mode. The SARIF file left on disk is always valid JSON.
#
# The step's real `run:` block is EXTRACTED from the workflow YAML at run time,
# never mirrored, and run the way GitHub runs `shell: bash`
# (`bash --noprofile --norc -eo pipefail`) with exactly the variables its env:
# block declares. A stub govulncheck first on PATH replays a fixture file and an
# exit code; each case runs in its own fresh directory because the step writes
# govulncheck-results.sarif to the working directory.
#
# Requires: bash (3.2+), python3 with PyYAML.
#
# Usage: bash test/go-sec-govulncheck-sarif-gate.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# GO_SEC_WORKFLOW points the suite at another copy (used to mutation-test it).
WORKFLOW="${GO_SEC_WORKFLOW:-$REPO_ROOT/.github/workflows/go-sec.yml}"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

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

command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required" >&2; exit 1; }
python3 -c 'import yaml' 2>/dev/null || { echo "ERROR: python3 PyYAML is required" >&2; exit 1; }

# ── Static contract: extract the real step ───────────────────────────────────
section "Static contract — the step the cases run"

python3 - "$WORKFLOW" "$WORKDIR" > "$WORKDIR/static.tsv" <<'PY' || { echo "ERROR: static extraction failed" >&2; exit 1; }
import pathlib
import sys

import yaml

wf = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
out = pathlib.Path(sys.argv[2])
STEP_NAME = "Run govulncheck (SARIF)"


def check(name, cond, expected="", actual=""):
    if cond:
        print("PASS\t%s" % name)
    else:
        print("FAIL\t%s\t%s\t%s" % (name, expected, str(actual).replace("\n", " ")))


job = (wf.get("jobs") or {}).get("govulncheck") or {}
step = next((s for s in job.get("steps") or [] if s.get("name") == STEP_NAME), None)
check("job govulncheck has the step '%s'" % STEP_NAME, step is not None, "a step with that name", "none")
if step is None:
    sys.exit(0)

body = step.get("run") or ""
check("step is a plain run: step (no uses:)", bool(body) and "uses" not in step, "run only", step.get("uses"))
check("run: body has no ${{ }} expressions (values arrive via env:)", "${{" not in body, "none", "contains ${{")
check("step sets shell: bash", step.get("shell") == "bash", "bash", step.get("shell"))
check("run: body invokes govulncheck -format sarif", "govulncheck -format sarif" in body, "govulncheck -format sarif", "absent")

env = step.get("env") or {}
want = {
    "FAIL_ON_FINDINGS": "${{ inputs.fail-on-findings }}",
    "GOVULNCHECK_PACKAGE": "${{ inputs.govulncheck-package }}",
}
check("env: maps exactly FAIL_ON_FINDINGS and GOVULNCHECK_PACKAGE", env == want, want, env)

(out / "step.sh").write_text(body)
PY

while IFS=$'\t' read -r verdict name exp act; do
  if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
done < "$WORKDIR/static.tsv"

if [ ! -s "$WORKDIR/step.sh" ]; then
  printf '\n  passed: %d   failed: %d  (step missing — behavioural cases not run)\n' "$PASS" "$((FAIL + 1))"
  exit 1
fi

section "Syntax checks"
if bash -n "$WORKDIR/step.sh" 2>"$WORKDIR/step.syn"; then
  ok "bash -n step.sh"
else
  bad "bash -n step.sh" "clean parse" "$(cat "$WORKDIR/step.syn")"
fi

# ── Stub govulncheck and SARIF fixtures ──────────────────────────────────────
STUBDIR="$WORKDIR/bin"
FIXDIR="$WORKDIR/fixtures"
mkdir -p "$STUBDIR" "$FIXDIR"

cat > "$STUBDIR/govulncheck" <<'STUB'
#!/bin/sh
# Replays $STUB_SARIF on stdout (if set) and exits $STUB_EXIT.
if [ -n "${STUB_SARIF:-}" ]; then cat "$STUB_SARIF"; fi
exit "${STUB_EXIT:-0}"
STUB
chmod +x "$STUBDIR/govulncheck"

# sarif <file> [level ...]: one GO-2026-000N result per level, in order.
sarif() {
  local file="$1" n=0 level sep="" results=""
  shift
  for level in "$@"; do
    n=$((n + 1))
    results="${results}${sep}{\"ruleId\":\"GO-2026-000${n}\",\"level\":\"${level}\",\"message\":{\"text\":\"finding ${n} at ${level} level\"}}"
    sep=","
  done
  printf '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"govulncheck"}},"results":[%s]}]}\n' "$results" > "$file"
}

sarif "$FIXDIR/clean.sarif"
sarif "$FIXDIR/one-error.sarif" error
sarif "$FIXDIR/mixed.sarif" note warning error note
sarif "$FIXDIR/uncalled.sarif" warning note note
printf '{"version":"2.1.0","runs":[{"tool":{"driver":{"na' > "$FIXDIR/malformed.sarif"
# Valid JSON that is not a SARIF log: no top-level runs list.
printf '{}\n' > "$FIXDIR/empty-object.sarif"
printf '[]\n' > "$FIXDIR/empty-array.sarif"

# runs_empty <file>: true when the file is a JSON object whose runs is [].
runs_empty() {
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get('runs') == [] else 1)" "$1" 2>/dev/null
}

# run_case <fail-on-findings> <sarif-fixture|""> <stub-exit>
# Runs the extracted step in a fresh directory; leaves the exit status in RC,
# stdout+stderr in OUT and the directory in CASE_DIR.
run_case() {
  CASE_DIR="$(mktemp -d "$WORKDIR/case.XXXXXX")"
  OUT="$(
    cd "$CASE_DIR" && env -i PATH="$STUBDIR:$PATH" \
      FAIL_ON_FINDINGS="$1" GOVULNCHECK_PACKAGE=./... \
      STUB_SARIF="$2" STUB_EXIT="$3" \
      bash --noprofile --norc -eo pipefail "$WORKDIR/step.sh" 2>&1
  )"
  RC=$?
}

# expect <name> <want-rc> <substring>: asserts on the last run_case. A passing
# run (want-rc 0) must also print no ::error:: line.
expect() {
  local name="$1" want_rc="$2" sub="$3" good=1
  [ "$RC" -eq "$want_rc" ] || good=0
  printf '%s' "$OUT" | grep -qF -- "$sub" || good=0
  if [ "$want_rc" -eq 0 ] && printf '%s' "$OUT" | grep -q '^::error::'; then good=0; fi
  if [ "$good" -eq 1 ]; then
    ok "$name"
  else
    bad "$name" "rc=$want_rc and [$sub]" "rc=$RC, $(printf '%s' "$OUT" | tr '\n' '|')"
  fi
}

# ── Enforcing ────────────────────────────────────────────────────────────────
section "fail-on-findings=true"
run_case true "$FIXDIR/one-error.sarif" 0
expect "error result + exit 0 -> fails" 1 "reported 1 reachable vulnerability finding(s)"
expect "error result + exit 0 -> counts 1" 1 "(SARIF level=error): 1"
expect "reachable finding's ruleId is printed" 1 "GO-2026-0001"
expect "reachable finding's text is printed" 1 "finding 1 at error level"

run_case true "$FIXDIR/mixed.sarif" 0
expect "mixed (note, warning, error, note) -> fails and counts 1" 1 "(SARIF level=error): 1"
expect "mixed -> prints the error result only" 1 "GO-2026-0003"
if printf '%s' "$OUT" | grep -qE 'GO-2026-000[124]'; then
  bad "mixed -> note and warning results are not printed" "no GO-2026-0001/2/4" "$(printf '%s' "$OUT" | tr '\n' '|')"
else
  ok "mixed -> note and warning results are not printed"
fi

run_case true "$FIXDIR/uncalled.sarif" 0
expect "warning/note only -> passes with count 0" 0 "(SARIF level=error): 0"

run_case true "$FIXDIR/clean.sarif" 0
expect "clean -> passes" 0 "(SARIF level=error): 0"

run_case true "$FIXDIR/clean.sarif" 3
expect "clean + exit 3 -> fails" 1 "reported 0 reachable vulnerability finding(s)"

run_case true "$FIXDIR/malformed.sarif" 0
expect "malformed + exit 0 -> fails closed" 1 "SARIF was missing or malformed"

run_case true "" 0
expect "no output + exit 0 -> fails closed" 1 "SARIF was missing or malformed"

run_case true "$FIXDIR/empty-object.sarif" 0
expect "{} + exit 0 -> fails closed" 1 "SARIF was missing or malformed"
EMPTY_OBJ_DIR="$CASE_DIR"

run_case true "$FIXDIR/empty-array.sarif" 0
expect "[] + exit 0 -> fails closed" 1 "SARIF was missing or malformed"

# ── Observe-only ─────────────────────────────────────────────────────────────
section "fail-on-findings=false"
run_case false "$FIXDIR/one-error.sarif" 0
expect "error result -> passes and reports count 1" 0 "(SARIF level=error): 1"
expect "error result -> still logs the finding" 0 "GO-2026-0001"

run_case false "$FIXDIR/malformed.sarif" 0
expect "malformed -> passes with the invalid-SARIF warning" 0 "did not produce valid SARIF"

run_case false "$FIXDIR/empty-object.sarif" 0
expect "{} -> passes with the invalid-SARIF warning" 0 "did not produce valid SARIF"

run_case false "$FIXDIR/clean.sarif" 3
expect "exit 3 -> passes" 0 "govulncheck exit code: 3"

# ── Tool errors ──────────────────────────────────────────────────────────────
section "Tool errors keep the tool's exit code"
run_case false "$FIXDIR/clean.sarif" 1
expect "exit 1 observe-only -> rc 1" 1 "govulncheck tooling error (exit=1)"

run_case true "$FIXDIR/clean.sarif" 2
expect "exit 2 enforcing -> rc 2" 2 "govulncheck tooling error (exit=2)"

# ── Artifact ─────────────────────────────────────────────────────────────────
section "The SARIF file left for the upload step"
run_case true "$FIXDIR/malformed.sarif" 0
if [ "$RC" -ne 0 ] && runs_empty "$CASE_DIR/govulncheck-results.sarif"; then
  ok "failing enforcing run on malformed input leaves valid JSON with runs == []"
else
  bad "failing enforcing run on malformed input leaves valid JSON with runs == []" \
    "rc!=0 and runs == []" "rc=$RC, $(head -c 200 "$CASE_DIR/govulncheck-results.sarif" 2>&1)"
fi

if runs_empty "$EMPTY_OBJ_DIR/govulncheck-results.sarif"; then
  ok "failing enforcing run on {} replaces the file with the valid empty SARIF"
else
  bad "failing enforcing run on {} replaces the file with the valid empty SARIF" \
    "runs == []" "$(head -c 200 "$EMPTY_OBJ_DIR/govulncheck-results.sarif" 2>&1)"
fi

run_case true "$FIXDIR/mixed.sarif" 0
if [ "$RC" -ne 0 ] && cmp -s "$FIXDIR/mixed.sarif" "$CASE_DIR/govulncheck-results.sarif"; then
  ok "failing enforcing run on a valid fixture leaves the file byte-identical"
else
  bad "failing enforcing run on a valid fixture leaves the file byte-identical" \
    "rc!=0 and identical to the fixture" "rc=$RC, $(head -c 200 "$CASE_DIR/govulncheck-results.sarif" 2>&1)"
fi

printf '\n  passed: %d   failed: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
