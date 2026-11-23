#!/usr/bin/env bash
#
# Regression tests for Claude PR review conversion in
# .github/workflows/claude-code.yml and its CI wiring in
# .github/workflows/self-audit.yml (LAB-5196).
#
# Extracts and executes the REAL workflow step scripts from
# .github/workflows/claude-code.yml at run time using python3 + PyYAML
# (never duplicates workflow logic):
#
#   1. Static & security contract (INV-7 / CASE-7A): env wiring for
#      REVIEW_HEAD_SHA and EXEC_FILE, zero ${{ }} inside script/run bodies,
#      hardcoded event: 'COMMENT', unwidened CLAUDE_HARDENED_ARGS, and
#      self-audit.yml paths + job step wiring.
#   2. Build review context (PR diff + changed files): executed in a real
#      temp git merge repo to assert head_sha=<40-hex HEAD^2> is written to
#      $GITHUB_OUTPUT.
#   3. Reset graphify query log: executed against a stub `gh` serving
#      paginated comments (Markdown, HTML, custom heading, non-review bot,
#      human, ghost user: null) to assert ALL github-actions[bot] comment
#      IDs are captured in $CLAUDE_REVIEW_PRIOR_IDS, plus listing-failure
#      fallback.
#   4. Convert to PR review: executed inside real `node` via
#      `async (github, context, core, require) => { <extracted script> }`
#      against a table-driven suite covering INV-1..INV-6 (CASE-1A..CASE-6B,
#      plus prompt-injection isolation, missing-EXEC_FILE fallback, and
#      unused-verdict-before-SHA-check).
#
# Requires: bash (3.2+), python3 with PyYAML, node, git, jq.
#
# Usage: bash test/claude-convert-review.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORKFLOW="${CLAUDE_WORKFLOW:-$REPO_ROOT/.github/workflows/claude-code.yml}"
SELF_AUDIT="${SELF_AUDIT_WORKFLOW:-$REPO_ROOT/.github/workflows/self-audit.yml}"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

EXTRACT="$WORKDIR/extracted"
mkdir -p "$EXTRACT" "$WORKDIR/bin"

PASS=0
FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  printf '          expected: [%s]\n' "$2"
  printf '          actual:   [%s]\n' "$3"
  FAIL=$((FAIL + 1))
}
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
section()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

for dep in python3 node git jq; do
  command -v "$dep" >/dev/null 2>&1 || { echo "ERROR: $dep is required" >&2; exit 1; }
done

# ── 1. Static & security contract + workflow step extraction (CASE-7A) ──────
section "Static & security contract (INV-7 / CASE-7A) + step extraction"

python3 - "$WORKFLOW" "$SELF_AUDIT" "$EXTRACT" > "$WORKDIR/static.tsv" <<'PY' || { echo "ERROR: workflow extraction failed" >&2; exit 1; }
import pathlib
import re
import shlex
import sys
import yaml

wf_path = pathlib.Path(sys.argv[1])
audit_path = pathlib.Path(sys.argv[2])
out = pathlib.Path(sys.argv[3])

wf = yaml.safe_load(wf_path.read_text(encoding="utf-8"))
audit = yaml.safe_load(audit_path.read_text(encoding="utf-8"))


def check(name, cond, expected="", actual=""):
    if cond:
        print("PASS\t%s" % name)
    else:
        print("FAIL\t%s\t%s\t%s" % (name, expected, str(actual).replace("\n", " ")))


job = (wf.get("jobs") or {}).get("claude-code-action") or {}
steps = job.get("steps") or []


def find_step(pred):
    for i, st in enumerate(steps):
        if pred(st):
            return i, st
    return None, None


_, ctx_step = find_step(lambda s: s.get("id") == "context")
_, reset_step = find_step(lambda s: s.get("name") == "Reset graphify query log")
_, conv_step = find_step(lambda s: s.get("name") == "Convert to PR review")

check("CASE-7A: Build review context step (id=context) exists", ctx_step is not None)
check("CASE-7A: Reset graphify query log step exists", reset_step is not None)
check("CASE-7A: Convert to PR review step exists", conv_step is not None)

if ctx_step is not None:
    ctx_run = ctx_step.get("run") or ""
    check("CASE-7A: Build review context run: has zero ${{ expressions", "${{" not in ctx_run, "none", "contains ${{")
    (out / "build-context.sh").write_text(ctx_run, encoding="utf-8")

if reset_step is not None:
    reset_run = reset_step.get("run") or ""
    check("CASE-7A: Reset graphify query log run: has zero ${{ expressions", "${{" not in reset_run, "none", "contains ${{")
    (out / "reset-graphify.sh").write_text(reset_run, encoding="utf-8")

if conv_step is not None:
    conv_uses = str(conv_step.get("uses") or "")
    conv_env = conv_step.get("env") or {}
    conv_script = str((conv_step.get("with") or {}).get("script") or "")

    check(
        "CASE-7A: Convert to PR review pins actions/github-script by 40-hex SHA",
        bool(re.fullmatch(r"actions/github-script@[0-9a-f]{40}", conv_uses)),
        "actions/github-script@<40-hex>",
        conv_uses,
    )
    check(
        "CASE-7A: Convert to PR review passes REVIEW_HEAD_SHA via env from steps.context.outputs.head_sha",
        bool(re.fullmatch(r"\$\{\{\s*steps\.context\.outputs\.head_sha\s*\}\}", str(conv_env.get("REVIEW_HEAD_SHA", "")).strip())),
        "${{ steps.context.outputs.head_sha }}",
        conv_env.get("REVIEW_HEAD_SHA", "<missing>"),
    )
    check(
        "CASE-7A: Convert to PR review passes EXEC_FILE via env from retry||primary execution_file",
        bool(
            re.fullmatch(
                r"\$\{\{\s*steps\.claude-review-retry\.outputs\.execution_file\s*\|\|\s*steps\.claude-review\.outputs\.execution_file\s*\}\}",
                str(conv_env.get("EXEC_FILE", "")).strip(),
            )
        ),
        "${{ steps.claude-review-retry.outputs.execution_file || steps.claude-review.outputs.execution_file }}",
        conv_env.get("EXEC_FILE", "<missing>"),
    )
    check(
        "CASE-7A: Convert to PR review with.script has zero ${{ expressions",
        "${{" not in conv_script,
        "none",
        "contains ${{",
    )
    has_comment_event = bool(re.search(r"event\s*:\s*['\"]COMMENT['\"]", conv_script))
    has_non_comment_event = bool(
        re.search(r"event\s*:\s*(?:['\"](?:APPROVE|REQUEST_CHANGES)['\"]|process\.env\b)", conv_script)
    )
    check(
        "CASE-7A: Convert to PR review hardcodes event: 'COMMENT' in pulls.createReview",
        has_comment_event and not has_non_comment_event,
        "hardcoded event: 'COMMENT' only",
        "has_comment=%s has_non_comment=%s" % (has_comment_event, has_non_comment_event),
    )
    (out / "convert-review.js").write_text(conv_script, encoding="utf-8")

# ── CLAUDE_HARDENED_ARGS security posture ──
hardened_raw = str((job.get("env") or {}).get("CLAUDE_HARDENED_ARGS") or "")
stripped = "\n".join(line for line in hardened_raw.splitlines() if not line.strip().startswith("#"))
stripped = re.sub(r"\$\{\{.*?\}\}", "EXPR", stripped)
toks = shlex.split(stripped) if stripped.strip() else []
flags = {}
cur = None
for t in toks:
    if t.startswith("--"):
        cur = t[2:]
        flags.setdefault(cur, [])
    elif cur is not None:
        flags[cur].append(t)


def tool_list(*names):
    vals = []
    for n in names:
        for v in flags.get(n, []):
            vals += [x.strip() for x in v.split(",") if x.strip()]
    return vals


allowed = set(tool_list("allowedTools", "allowed-tools"))
disallowed = set(tool_list("disallowedTools", "disallowed-tools"))
expected_allowed = {
    "Bash(gh pr comment:*)",
    "Bash(gh pr view:*)",
    "Bash(graphify query:*)",
    "Bash(graphify explain:*)",
    "Bash(graphify path:*)",
    "Read",
    "Grep",
    "Glob",
}

check(
    "CASE-7A: CLAUDE_HARDENED_ARGS allowedTools stays unwidened",
    allowed == expected_allowed,
    sorted(expected_allowed),
    sorted(allowed),
)
check(
    "CASE-7A: CLAUDE_HARDENED_ARGS keeps Bash(gh pr review:*) absent from allowedTools",
    "Bash(gh pr review:*)" not in allowed,
    "absent",
    sorted(allowed),
)
check(
    "CASE-7A: CLAUDE_HARDENED_ARGS keeps Bash(gh api:*) in disallowedTools",
    "Bash(gh api:*)" in disallowed and "Bash(gh api:*)" not in allowed,
    "in disallowedTools and not in allowedTools",
    "disallowed=%s" % ("Bash(gh api:*)" in disallowed),
)

# ── self-audit.yml wiring ──
audit_on = audit.get("on")
if audit_on is None:
    audit_on = audit.get(True) or {}
pr_paths = ((audit_on.get("pull_request") or {}).get("paths") or [])
push_paths = ((audit_on.get("push") or {}).get("paths") or [])
target_test = "test/claude-convert-review.test.sh"

check(
    "CASE-7A: self-audit.yml wires test/claude-convert-review.test.sh in on.pull_request.paths",
    target_test in pr_paths,
    target_test,
    "missing",
)
check(
    "CASE-7A: self-audit.yml wires test/claude-convert-review.test.sh in on.push.paths",
    target_test in push_paths,
    target_test,
    "missing",
)

audit_steps = ((audit.get("jobs") or {}).get("audit") or {}).get("steps") or []
pyyaml_idx = next((i for i, s in enumerate(audit_steps) if "PyYAML" in str(s.get("run") or "") or "PyYAML" in str(s.get("name") or "")), -1)
test_idx = next((i for i, s in enumerate(audit_steps) if target_test in str(s.get("run") or "")), -1)
check(
    "CASE-7A: self-audit.yml audit job runs test/claude-convert-review.test.sh after PyYAML install",
    test_idx != -1 and pyyaml_idx != -1 and test_idx > pyyaml_idx,
    "step index > PyYAML step (%s)" % pyyaml_idx,
    "test_idx=%s pyyaml_idx=%s" % (test_idx, pyyaml_idx),
)
PY

while IFS=$'\t' read -r verdict name exp act; do
  if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
done < "$WORKDIR/static.tsv"

if [ ! -s "$EXTRACT/build-context.sh" ] || [ ! -s "$EXTRACT/reset-graphify.sh" ] || [ ! -s "$EXTRACT/convert-review.js" ]; then
  printf '\n  passed: %d   failed: %d  (extracted step missing — behavioural cases not run)\n' "$PASS" "$((FAIL + 1))"
  exit 1
fi

section "Syntax checks on extracted workflow steps"
for sh_file in build-context.sh reset-graphify.sh; do
  if bash -n "$EXTRACT/$sh_file" 2>"$WORKDIR/$sh_file.syn"; then
    ok "bash -n $sh_file"
  else
    bad "bash -n $sh_file" "clean parse" "$(cat "$WORKDIR/$sh_file.syn")"
  fi
done
{
  printf 'async function _check(github, context, core, require) {\n'
  cat "$EXTRACT/convert-review.js"
  printf '\n}\n'
} > "$WORKDIR/convert-review-check.js"
if node --check "$WORKDIR/convert-review-check.js" 2>"$WORKDIR/convert.syn"; then
  ok "node --check convert-review.js"
else
  bad "node --check convert-review.js" "clean parse" "$(cat "$WORKDIR/convert.syn")"
fi

# ── 2. Build review context (real temp git merge repo) ──────────────────────
section "Build review context — captures HEAD^2 as head_sha in GITHUB_OUTPUT"

GIT_REPO="$WORKDIR/pr-merge-repo"
CTX_TEMP="$WORKDIR/ctx-temp"
CTX_OUT="$WORKDIR/ctx.output"
CTX_LOG="$WORKDIR/ctx.log"
mkdir -p "$GIT_REPO" "$CTX_TEMP"
: > "$CTX_OUT"

(
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_AUTHOR_NAME="Test Author"
  export GIT_AUTHOR_EMAIL="test@example.com"
  export GIT_COMMITTER_NAME="Test Author"
  export GIT_COMMITTER_EMAIL="test@example.com"
  cd "$GIT_REPO" || exit 1
  git -c init.defaultBranch=main -c core.hooksPath=/dev/null init -q
  printf 'base\n' > app.sh
  git add app.sh
  git commit -q -m "base commit"
  git checkout -q -b pr-branch
  printf 'pr change\n' >> app.sh
  mkdir -p generated
  printf 'artifact\n' > generated/skip.txt
  git add app.sh generated/skip.txt
  git commit -q -m "PR head commit"
  git rev-parse HEAD > "$WORKDIR/expected-head2.sha"
  git checkout -q main
  printf 'main advance\n' > other.txt
  git add other.txt
  git commit -q -m "advance main"
  git merge -q --no-ff pr-branch -m "Merge PR into main"
) || { echo "ERROR: failed to build temp git merge repo" >&2; exit 1; }

EXPECTED_HEAD2="$(cat "$WORKDIR/expected-head2.sha")"
ACTUAL_HEAD2="$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$GIT_REPO" rev-parse HEAD^2)"
assert_eq "fixture merge repo HEAD^2 matches PR head commit" "$EXPECTED_HEAD2" "$ACTUAL_HEAD2"

(
  cd "$GIT_REPO" || exit 1
  env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GITHUB_OUTPUT="$CTX_OUT" \
    RUNNER_TEMP="$CTX_TEMP" \
    REVIEW_EXCLUDE_PATHSPECS="generated/" \
    bash --noprofile --norc -eo pipefail "$EXTRACT/build-context.sh"
) > "$CTX_LOG" 2>&1
CTX_RC=$?

assert_eq "Build review context exits 0" "0" "$CTX_RC"
CTX_HEAD_SHA="$(sed -n 's/^head_sha=//p' "$CTX_OUT" | tail -n 1)"
assert_eq "Build review context writes head_sha=<HEAD^2> to GITHUB_OUTPUT" "$EXPECTED_HEAD2" "$CTX_HEAD_SHA"
if [ -s "$GIT_REPO/.claude-review/pr.diff" ] && grep -q '^app\.sh$' "$GIT_REPO/.claude-review/changed-files.txt"; then
  ok "Build review context writes scoped pr.diff and changed-files.txt"
else
  bad "Build review context writes scoped pr.diff and changed-files.txt" "non-empty diff with app.sh" "$(cat "$CTX_LOG")"
fi

# ── 3. Reset graphify query log (paginated stub gh) ─────────────────────────
section "Reset graphify query log — snapshots ALL github-actions[bot] comments"

# Provide a GNU-date `-d` compatible wrapper ONLY when host `date` is BSD date
# (macOS); on Ubuntu CI runners, real GNU `date` is used untouched.
if ! date -u -d 'Sun, 26 Jul 2026 10:10:00 GMT' +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
  cat > "$WORKDIR/bin/date" <<'DATESTUB'
#!/usr/bin/env bash
set -eu
d_spec=""
fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -u) shift ;;
    -d) d_spec="$2"; shift 2 ;;
    +*) fmt="${1#+}"; shift ;;
    *) shift ;;
  esac
done
python3 - "$d_spec" "$fmt" <<'PY'
import datetime, email.utils, re, sys
spec, fmt = sys.argv[1], sys.argv[2] or "%Y-%m-%dT%H:%M:%SZ"
m = re.fullmatch(r"([+-]?\d+)\s*seconds?", spec.strip())
if m:
    dt = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=int(m.group(1)))
elif spec.strip():
    dt = email.utils.parsedate_to_datetime(spec).astimezone(datetime.timezone.utc)
else:
    dt = datetime.datetime.now(datetime.timezone.utc)
print(dt.strftime(fmt))
PY
DATESTUB
  chmod +x "$WORKDIR/bin/date"
fi

# Stub `gh` serving paginated `issues/<N>/comments` (applying --jq per page)
# and `gh api -i rate_limit` (emitting a Date header).
cat > "$WORKDIR/bin/gh" <<'GHSTUB'
#!/usr/bin/env bash
set -u
[ "${1:-}" = "api" ] || { echo "stub gh: unsupported: $*" >&2; exit 64; }
shift
path=""; paginate=n; jqf=""; include_headers=n
while [ $# -gt 0 ]; do
  case "$1" in
    --paginate) paginate=y; shift ;;
    --jq|-q)    jqf="$2"; shift 2 ;;
    -i|--include) include_headers=y; shift ;;
    -*)         echo "stub gh: unknown flag $1" >&2; exit 64 ;;
    *)          path="$1"; shift ;;
  esac
done
echo "GET $path paginate=$paginate headers=$include_headers" >> "$GH_LOG"
if [ "$path" = "rate_limit" ]; then
  printf 'HTTP/2 200\r\nDate: Sun, 26 Jul 2026 10:10:00 GMT\r\n\r\n{}\n'
  exit 0
fi
if [ "${GH_FAIL_COMMENTS:-0}" = "1" ]; then
  echo "gh: Server Error (HTTP 500)" >&2
  exit 1
fi
for p in "$GH_PAGES"/page-*.json; do
  [ -f "$p" ] || continue
  if [ -n "$jqf" ]; then
    jq -r "$jqf" "$p" || exit 1
  else
    cat "$p"
  fi
  [ "$paginate" = y ] || break
done
GHSTUB
chmod +x "$WORKDIR/bin/gh"

run_reset_step() {
  local tag="$1"; shift
  local pages_dir="$WORKDIR/reset-pages-$tag"
  local rtemp="$WORKDIR/reset-temp-$tag"
  local genv="$WORKDIR/reset-env-$tag"
  local ghlog="$WORKDIR/reset-gh-$tag.log"
  local steprout="$WORKDIR/reset-out-$tag.log"
  mkdir -p "$pages_dir" "$rtemp"
  : > "$genv"
  : > "$ghlog"
  cat > "$pages_dir/page-1.json" <<'JSON'
[
  {"id": 1001, "user": {"login": "github-actions[bot]"}, "body": "## Claude Review\nPrior markdown review."},
  {"id": 1002, "user": {"login": "github-actions[bot]"}, "body": "<h2>Claude Review</h2>\nPrior HTML review."},
  {"id": 1003, "user": {"login": "octocat"}, "body": "## Claude Review\nHuman comment."},
  {"id": 1004, "user": null, "body": "## Claude Review\nDeleted ghost user."}
]
JSON
  cat > "$pages_dir/page-2.json" <<'JSON'
[
  {"id": 1005, "user": {"login": "github-actions[bot]"}, "body": "## Summary\nOrator custom prompt review."},
  {"id": 1006, "user": {"login": "github-actions[bot]"}, "body": "Coverage report: 98%."},
  {"id": 1007, "user": {"login": "github-actions[bot]"}, "body": "## Codex Review\n⚠️ Codex review did not complete."}
]
JSON
  (
    cd "$WORKDIR" || exit 1
    env PATH="$WORKDIR/bin:$PATH" \
      RUNNER_TEMP="$rtemp" \
      GITHUB_ENV="$genv" \
      GH_TOKEN=dummy \
      REPO=praetorian-inc/palatine \
      PR_NUMBER=385 \
      GH_PAGES="$pages_dir" \
      GH_LOG="$ghlog" \
      "$@" \
      bash --noprofile --norc -eo pipefail "$EXTRACT/reset-graphify.sh"
  ) > "$steprout" 2>&1
  RESET_RC=$?
  RESET_ENV="$genv"
  RESET_GHLOG="$ghlog"
  RESET_LOG="$steprout"
}

run_reset_step "all-bots"
assert_eq "Reset graphify query log exits 0 on paginated mixed comments" "0" "$RESET_RC"
if grep -q 'GET repos/praetorian-inc/palatine/issues/385/comments paginate=y' "$RESET_GHLOG"; then
  ok "Reset graphify query log paginates issue comments"
else
  bad "Reset graphify query log paginates issue comments" "paginate=y" "$(cat "$RESET_GHLOG")"
fi
PRIOR_PATH="$(sed -n 's/^CLAUDE_REVIEW_PRIOR_IDS=//p' "$RESET_ENV" | tail -n 1)"
if [ -n "$PRIOR_PATH" ] && [ -f "$PRIOR_PATH" ]; then
  PRIOR_JSON="$(jq -c 'sort' "$PRIOR_PATH" 2>/dev/null || echo "<invalid-json>")"
else
  PRIOR_JSON="<missing-file>"
fi
assert_eq "Reset graphify query log records ALL github-actions[bot] IDs (excl human + ghost)" "[1001,1002,1005,1006,1007]" "$PRIOR_JSON"
STARTED_AT="$(sed -n 's/^CLAUDE_REVIEW_STARTED_AT=//p' "$RESET_ENV" | tail -n 1)"
assert_eq "Reset graphify query log records GitHub Date header as CLAUDE_REVIEW_STARTED_AT" "2026-07-26T10:10:00Z" "$STARTED_AT"
FALLBACK_FLAG="$(sed -n 's/^CLAUDE_REVIEW_STARTED_AT_FALLBACK=//p' "$RESET_ENV" | tail -n 1)"
assert_eq "Reset graphify query log sets FALLBACK=0 when Date header succeeds" "0" "$FALLBACK_FLAG"

run_reset_step "list-fail" GH_FAIL_COMMENTS=1
assert_eq "Reset graphify query log exits 0 when comment listing fails" "0" "$RESET_RC"
PRIOR_FAIL_PATH="$(sed -n 's/^CLAUDE_REVIEW_PRIOR_IDS=//p' "$RESET_ENV" | tail -n 1)"
if [ -n "$PRIOR_FAIL_PATH" ] && [ -f "$PRIOR_FAIL_PATH" ] && [ ! -s "$PRIOR_FAIL_PATH" ]; then
  ok "Reset graphify query log writes empty priorIds file on listing failure"
else
  bad "Reset graphify query log writes empty priorIds file on listing failure" "0-byte file" "$(cat "${PRIOR_FAIL_PATH:-/dev/null}" 2>/dev/null)"
fi
if grep -q '^::warning::' "$RESET_LOG"; then
  ok "Reset graphify query log emits ::warning on listing failure"
else
  bad "Reset graphify query log emits ::warning on listing failure" "::warning::..." "$(cat "$RESET_LOG")"
fi

# ── 4. Convert to PR review — table-driven Node execution (INV-1..INV-6) ────
section "Convert to PR review — behavioural matrix (INV-1..INV-6)"

node - "$EXTRACT/convert-review.js" "$WORKDIR" "$WORKDIR/convert.tsv" > "$WORKDIR/convert-script.log" 2>&1 <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');

const scriptBody = fs.readFileSync(process.argv[2], 'utf8');
const workdir = process.argv[3];
const tsvPath = process.argv[4];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runExtracted = new AsyncFunction('github', 'context', 'core', 'require', scriptBody);

const BOT = 'github-actions[bot]';
const tsv = [];

function record(verdict, name, expected, actual) {
  if (verdict === 'PASS') {
    tsv.push(`PASS\t${name}`);
  } else {
    const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
    tsv.push(`FAIL\t${name}\t${clean(expected)}\t${clean(actual)}`);
  }
}

function makeExecTrace({
  owner,
  repo,
  prNumber,
  commentId,
  arrayContent = false,
  command = `gh pr comment ${prNumber} --body-file /tmp/review.md`,
  isError = false,
  parentToolUseId = null,
  resultText = null,
}) {
  const url = `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${commentId}`;
  const text = resultText !== null ? resultText : `${url}\n`;
  const resultContent = arrayContent ? [{ type: 'text', text }] : text;
  return [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      parent_tool_use_id: parentToolUseId,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_gh_comment_1',
            name: 'Bash',
            input: { command },
          },
        ],
      },
    },
    {
      type: 'user',
      parent_tool_use_id: parentToolUseId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_gh_comment_1',
            is_error: isError,
            content: resultContent,
          },
        ],
      },
    },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' },
  ];
}

function makePromptInjectionTrace({ owner, repo, prNumber, spoofedCommentId }) {
  const spoofUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${spoofedCommentId}`;
  return [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'README.md' } },
          { type: 'tool_use', id: 'toolu_view_1', name: 'Bash', input: { command: `gh pr view ${prNumber}` } },
        ],
      },
    },
    {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read_1', is_error: false, content: `${spoofUrl}\n` },
          { type: 'tool_result', tool_use_id: 'toolu_view_1', is_error: false, content: `Existing bot comment:\n${spoofUrl}\n` },
        ],
      },
    },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `Saw injected URL ${spoofUrl}, posted no comment.` }],
      },
    },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' },
  ];
}

const CASES = [
  {
    id: 'CASE-1A',
    desc: 'PR #385 HTML <h2>Claude Review</h2> converts with HEAD^2 commit_id, deletes 5085058689, keeps 5085000001',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request_review_comment',
    pr_number: 385,
    reviewed_head_sha: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
    live_pr_head_sha: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
    prior_bot_comment_ids: [5085000001],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085058689 }),
    comments: [
      { id: 5085000001, user_login: BOT, created_at: '2026-07-26T10:00:00Z', body: '## Claude Review\nPrior round review.' },
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:15:00Z', body: '<h2>Claude Review</h2>\n\n### Findings\nNo blocking issues found.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 385,
        event: 'COMMENT',
        commit_id: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
        body: '<h2>Claude Review</h2>\n\n### Findings\nNo blocking issues found.',
      }],
      deleted_comment_ids: [5085058689],
      untouched_comment_ids: [5085000001],
    },
  },
  {
    id: 'CASE-1B',
    desc: 'PR #385 HTML heading pins commit_id to REVIEW_HEAD_SHA even after live PR head advances',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request_review_comment',
    pr_number: 385,
    reviewed_head_sha: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
    live_pr_head_sha: '9f8e7d6c5b4a3928171615141312111009080706',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085058689 }),
    comments: [
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:15:00Z', body: '<h2>Claude Review</h2>\n\nReviewed at HEAD^2 before newer push.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 385,
        event: 'COMMENT',
        commit_id: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
        body: '<h2>Claude Review</h2>\n\nReviewed at HEAD^2 before newer push.',
      }],
      deleted_comment_ids: [5085058689],
      untouched_comment_ids: [],
    },
  },
  {
    id: 'CASE-2A',
    desc: 'Orator PR #229 custom ## Summary heading converts 5870912153, leaves prior 5858699221 untouched',
    owner: 'praetorian-inc',
    repo: 'orator',
    event_name: 'pull_request',
    pr_number: 229,
    reviewed_head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    prior_bot_comment_ids: [5858699221],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'orator', prNumber: 229, commentId: 5870912153 }),
    comments: [
      { id: 5858699221, user_login: BOT, created_at: '2026-09-27T14:00:00Z', body: '## Summary\nPrior unconverted run comment.' },
      { id: 5870912153, user_login: BOT, created_at: '2026-09-28T15:30:00Z', body: '## Summary\n\nCustom caller prompt review without Claude Review heading.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 229,
        event: 'COMMENT',
        commit_id: 'abcdef1234567890abcdef1234567890abcdef12',
        body: '## Summary\n\nCustom caller prompt review without Claude Review heading.',
      }],
      deleted_comment_ids: [5870912153],
      untouched_comment_ids: [5858699221],
    },
  },
  {
    id: 'CASE-3A',
    desc: 'Standard ## Claude Review on pull_request converts with commit_id=HEAD^2',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '1111222233334444555566667777888899990000',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085010001 }),
    comments: [
      { id: 5085010001, user_login: BOT, created_at: '2026-07-26T09:00:00Z', body: '## Claude Review\n\nStandard PR opened review.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 385,
        event: 'COMMENT',
        commit_id: '1111222233334444555566667777888899990000',
        body: '## Claude Review\n\nStandard PR opened review.',
      }],
      deleted_comment_ids: [5085010001],
      untouched_comment_ids: [],
    },
  },
  {
    id: 'CASE-3B',
    desc: 'Standard ## Claude Review on pull_request_review_comment (array tool_result) converts with HEAD^2',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request_review_comment',
    pr_number: 385,
    reviewed_head_sha: '2222333344445555666677778888999900001111',
    prior_bot_comment_ids: [5085010001],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085020002, arrayContent: true }),
    comments: [
      { id: 5085010001, user_login: BOT, created_at: '2026-07-26T09:00:00Z', body: '## Claude Review\n\nRound 1 comment.' },
      { id: 5085020002, user_login: BOT, created_at: '2026-07-26T09:30:00Z', body: '## Claude Review\n\nInline @claude re-review comment.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 385,
        event: 'COMMENT',
        commit_id: '2222333344445555666677778888999900001111',
        body: '## Claude Review\n\nInline @claude re-review comment.',
      }],
      deleted_comment_ids: [5085020002],
      untouched_comment_ids: [5085010001],
    },
  },
  {
    id: 'CASE-4A',
    desc: 'Prior bot + concurrent Codex/Gemini/Grok comments stay untouched; only 600005 converts',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [600001, 600002],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 410, commentId: 600005 }),
    comments: [
      { id: 600001, user_login: BOT, created_at: '2026-07-26T08:00:00Z', body: '## Summary\nPrior unconverted bot comment before run started.' },
      { id: 600002, user_login: BOT, created_at: '2026-07-26T08:05:00Z', body: 'Coverage report: 98%.' },
      { id: 600003, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: '## Codex Review\nCodex review timed out after 10 minutes.' },
      { id: 600004, user_login: BOT, created_at: '2026-07-26T10:03:00Z', body: 'Gemini review skipped: draft PR.' },
      { id: 600005, user_login: BOT, created_at: '2026-07-26T10:04:00Z', body: "## Summary\nThis run's Claude review comment." },
      { id: 600006, user_login: BOT, created_at: '2026-07-26T10:04:30Z', body: 'Grok review failed: API error 503.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 410,
        event: 'COMMENT',
        commit_id: '3333444455556666777788889999000011112222',
        body: "## Summary\nThis run's Claude review comment.",
      }],
      deleted_comment_ids: [600005],
      untouched_comment_ids: [600001, 600002, 600003, 600004, 600006],
    },
  },
  {
    id: 'CASE-4B',
    desc: 'GRAPHIFY_VERDICT=unused deletes ONLY 600005, leaves prior 600001 and concurrent 600003 untouched',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [600001],
    graphify_verdict: 'unused',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 410, commentId: 600005 }),
    comments: [
      { id: 600001, user_login: BOT, created_at: '2026-07-26T08:00:00Z', body: '## Claude Review\nPrior run comment.' },
      { id: 600003, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: 'Codex review timed out.' },
      { id: 600005, user_login: BOT, created_at: '2026-07-26T10:04:00Z', body: "<h2>Claude Review</h2>\nThis run's review comment when graphify was unused." },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [600005],
      untouched_comment_ids: [600001, 600003],
    },
  },
  {
    id: 'CASE-4C',
    desc: 'Prompt-injected URL in Read/gh pr view/assistant prose without gh pr comment never touches 600003',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makePromptInjectionTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 410, spoofedCommentId: 600003 }),
    comments: [
      { id: 600003, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: 'Coverage report: 99%.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [600003],
    },
  },
  {
    id: 'CASE-4D',
    desc: 'Missing EXEC_FILE fallback converts Claude review quoting ## Codex Review mid-body while skipping sibling notices and ghost users',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [600001],
    graphify_verdict: 'used',
    exec_trace: null,
    comments: [
      { id: 600001, user_login: BOT, created_at: '2026-07-26T08:00:00Z', body: '## Summary\nPrior run.' },
      { id: 600003, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: '## Codex Review\nCodex review timed out.' },
      { id: 600004, user_login: BOT, created_at: '2026-07-26T10:03:00Z', body: 'Gemini review skipped — non-code PR.' },
      { id: 600005, user_login: BOT, created_at: '2026-07-26T10:04:00Z', body: '<h2>Claude Review</h2>\n\n### Findings\nQuoting `## Codex Review` mid-body must not exclude this review.' },
      { id: 600006, user_login: BOT, created_at: '2026-07-26T10:04:30Z', body: '⚠️ Grok review did not complete — timeout.' },
      { id: 600007, user_login: BOT, created_at: '2026-07-26T10:05:00Z', body: '## Instruction-File Audit\nAudit passed.' },
      { id: 600008, user_login: null, created_at: '2026-07-26T10:05:30Z', body: '## Claude Review\nDeleted ghost user.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 410,
        event: 'COMMENT',
        commit_id: '3333444455556666777788889999000011112222',
        body: '<h2>Claude Review</h2>\n\n### Findings\nQuoting `## Codex Review` mid-body must not exclude this review.',
      }],
      deleted_comment_ids: [600005],
      untouched_comment_ids: [600001, 600003, 600004, 600006, 600007, 600008],
    },
  },
  {
    id: 'CASE-4E-used',
    desc: 'Errored gh pr comment tool_result (is_error: true) never converts or deletes concurrent unrelated bot comment 7001',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({
      owner: 'praetorian-inc',
      repo: 'palatine',
      prNumber: 410,
      commentId: 7001,
      isError: true,
      resultText: 'HTTP 422: Validation Failed\n',
    }),
    comments: [
      { id: 7001, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: 'Coverage report: 99%.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [7001],
    },
  },
  {
    id: 'CASE-4E-unused',
    desc: 'Errored gh pr comment tool_result (is_error: true) under GRAPHIFY_VERDICT=unused never deletes concurrent bot comment 7001',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [],
    graphify_verdict: 'unused',
    exec_trace: makeExecTrace({
      owner: 'praetorian-inc',
      repo: 'palatine',
      prNumber: 410,
      commentId: 7001,
      isError: true,
      resultText: 'HTTP 422: Validation Failed\n',
    }),
    comments: [
      { id: 7001, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: 'Coverage report: 99%.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [7001],
    },
  },
  {
    id: 'CASE-4F-compound',
    desc: 'Compound allowed Bash command (gh pr view && gh pr comment) converts & deletes 7002 with commit_id=HEAD^2',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({
      owner: 'praetorian-inc',
      repo: 'palatine',
      prNumber: 410,
      commentId: 7002,
      command: 'gh pr view 410 --json title && gh pr comment 410 --body "## Summary\\nReview"',
    }),
    comments: [
      { id: 7002, user_login: BOT, created_at: '2026-07-26T10:04:00Z', body: '## Summary\nReview posted via compound command.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 410,
        event: 'COMMENT',
        commit_id: '3333444455556666777788889999000011112222',
        body: '## Summary\nReview posted via compound command.',
      }],
      deleted_comment_ids: [7002],
      untouched_comment_ids: [],
    },
  },
  {
    id: 'CASE-4F-multiline-unused',
    desc: 'Multiline allowed Bash command (gh pr view\\ngh pr comment) under GRAPHIFY_VERDICT=unused deletes 7003',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [],
    graphify_verdict: 'unused',
    exec_trace: makeExecTrace({
      owner: 'praetorian-inc',
      repo: 'palatine',
      prNumber: 410,
      commentId: 7003,
      command: 'gh pr view 410 --json title\ngh pr comment 410 --body "<h2>Claude Review</h2>"',
    }),
    comments: [
      { id: 7003, user_login: BOT, created_at: '2026-07-26T10:04:00Z', body: '<h2>Claude Review</h2>\nUnverified multiline review.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [7003],
      untouched_comment_ids: [],
    },
  },
  {
    id: 'CASE-4F-quoted-negative',
    desc: 'Negative control: gh pr comment inside quotes or # comment with injected URL never matches or touches 7004',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({
      owner: 'praetorian-inc',
      repo: 'palatine',
      prNumber: 410,
      commentId: 7004,
      command: '# gh pr comment 410\ngraphify query "gh pr comment" && graphify explain \'gh pr comment\'',
    }),
    comments: [
      { id: 7004, user_login: BOT, created_at: '2026-07-26T10:04:00Z', body: 'Coverage report: 99%.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [7004],
    },
  },
  {
    id: 'CASE-4G-subagent',
    desc: 'Subagent parent_tool_use_id running gh pr comment is ignored and never touches 7005',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({
      owner: 'praetorian-inc',
      repo: 'palatine',
      prNumber: 410,
      commentId: 7005,
      parentToolUseId: 'toolu_sub',
    }),
    comments: [
      { id: 7005, user_login: BOT, created_at: '2026-07-26T10:04:00Z', body: 'Coverage report: 99%.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [7005],
    },
  },
  {
    id: 'CASE-4H-corrupt-exec',
    desc: 'Corrupt non-JSON EXEC_FILE falls back safely while tolerating body: null and skipping sibling notices',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 410,
    reviewed_head_sha: '3333444455556666777788889999000011112222',
    prior_bot_comment_ids: [7000],
    graphify_verdict: 'used',
    exec_raw: '{truncated corrupt json',
    comments: [
      { id: 7000, user_login: BOT, created_at: '2026-07-26T08:00:00Z', body: '## Claude Review\nPrior run.' },
      { id: 7006, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: null },
      { id: 7007, user_login: BOT, created_at: '2026-07-26T10:03:00Z', body: '## Codex Review\nTimed out.' },
      { id: 7008, user_login: BOT, created_at: '2026-07-26T10:04:00Z', body: '<h2>Claude Review</h2>\nRecovered on corrupt EXEC_FILE fallback.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 410,
        event: 'COMMENT',
        commit_id: '3333444455556666777788889999000011112222',
        body: '<h2>Claude Review</h2>\nRecovered on corrupt EXEC_FILE fallback.',
      }],
      deleted_comment_ids: [7008],
      untouched_comment_ids: [7000, 7006, 7007],
    },
  },
  {
    id: 'CASE-5A',
    desc: 'pulls.createReview 422 calls core.setFailed and leaves 5085058689 undeleted',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085058689 }),
    comments: [
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:15:00Z', body: '<h2>Claude Review</h2>\nReview body.' },
    ],
    api_fault: { operation: 'pulls.createReview', status: 422, message: 'Unprocessable Entity: commit_id is not part of the pull request' },
    expected: {
      step_failed: true,
      core_set_failed_called: true,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [5085058689],
    },
  },
  {
    id: 'CASE-5B',
    desc: 'Missing REVIEW_HEAD_SHA calls core.setFailed with 0 reviews and 0 deletions',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085058689 }),
    comments: [
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:15:00Z', body: '## Claude Review\nReview body.' },
    ],
    expected: {
      step_failed: true,
      core_set_failed_called: true,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [5085058689],
    },
  },
  {
    id: 'CASE-5C',
    desc: 'Invalid REVIEW_HEAD_SHA calls core.setFailed with 0 reviews and 0 deletions',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: 'not-a-40-hex-sha',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085058689 }),
    comments: [
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:15:00Z', body: '## Claude Review\nReview body.' },
    ],
    expected: {
      step_failed: true,
      core_set_failed_called: true,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [5085058689],
    },
  },
  {
    id: 'CASE-5D',
    desc: 'GRAPHIFY_VERDICT=unused deleteComment 500 calls core.setFailed',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
    prior_bot_comment_ids: [],
    graphify_verdict: 'unused',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085058689 }),
    comments: [
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:15:00Z', body: '<h2>Claude Review</h2>\nReview body with unused graphify.' },
    ],
    api_fault: { operation: 'issues.deleteComment', status: 500, message: 'Internal Server Error' },
    expected: {
      step_failed: true,
      core_set_failed_called: true,
      created_reviews: [],
      deleted_comment_ids: [],
      untouched_comment_ids: [5085058689],
    },
  },
  {
    id: 'CASE-5E',
    desc: 'GRAPHIFY_VERDICT=unused deletes comment even when REVIEW_HEAD_SHA is empty (fail-closed deletion precedes SHA check)',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '',
    prior_bot_comment_ids: [],
    graphify_verdict: 'unused',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085058689 }),
    comments: [
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:15:00Z', body: '<h2>Claude Review</h2>\nUnverified review with empty SHA.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [5085058689],
      untouched_comment_ids: [],
    },
  },
  {
    id: 'CASE-5F-delete-after-create',
    desc: 'Normal-path deleteComment 500 after pulls.createReview succeeds calls core.setFailed',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
    prior_bot_comment_ids: [],
    graphify_verdict: 'used',
    exec_trace: makeExecTrace({ owner: 'praetorian-inc', repo: 'palatine', prNumber: 385, commentId: 5085058689 }),
    comments: [
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:15:00Z', body: '<h2>Claude Review</h2>\nReview created before delete fails.' },
    ],
    api_fault: { operation: 'issues.deleteComment', status: 500, message: 'Internal Server Error' },
    expected: {
      step_failed: true,
      core_set_failed_called: true,
      created_reviews: [{
        pull_number: 385,
        event: 'COMMENT',
        commit_id: '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c',
        body: '<h2>Claude Review</h2>\nReview created before delete fails.',
      }],
      deleted_comment_ids: [],
      untouched_comment_ids: [5085058689],
    },
  },
  {
    id: 'CASE-6A',
    desc: 'Unavailable priorIds falls back to CLAUDE_REVIEW_STARTED_AT (FALLBACK=0), leaves prior 5085000001 untouched',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '4444555566667777888899990000111122223333',
    prior_bot_comment_ids: null,
    prior_empty_file: true,
    claude_review_started_at: '2026-07-26T10:10:00Z',
    claude_review_started_at_fallback: '0',
    graphify_verdict: 'used',
    exec_trace: null,
    comments: [
      { id: 5085000001, user_login: BOT, created_at: '2026-07-26T10:05:00Z', body: '## Claude Review\nPrior run comment posted before CLAUDE_REVIEW_STARTED_AT.' },
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:12:00Z', body: '<h2>Claude Review</h2>\nCurrent run comment posted after CLAUDE_REVIEW_STARTED_AT.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 385,
        event: 'COMMENT',
        commit_id: '4444555566667777888899990000111122223333',
        body: '<h2>Claude Review</h2>\nCurrent run comment posted after CLAUDE_REVIEW_STARTED_AT.',
      }],
      deleted_comment_ids: [5085058689],
      untouched_comment_ids: [5085000001],
    },
  },
  {
    id: 'CASE-6B',
    desc: 'Unavailable priorIds with FALLBACK=1 converts & deletes ONLY newest 5085058689, leaves 5085000001 untouched',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '4444555566667777888899990000111122223333',
    prior_bot_comment_ids: null,
    claude_review_started_at: '2026-07-26T10:00:00Z',
    claude_review_started_at_fallback: '1',
    graphify_verdict: 'used',
    exec_trace: null,
    comments: [
      { id: 5085000001, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: '## Claude Review\nEarlier comment inside fallback timestamp window.' },
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:12:00Z', body: '<h2>Claude Review</h2>\nNewest review comment in fallback window.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [{
        pull_number: 385,
        event: 'COMMENT',
        commit_id: '4444555566667777888899990000111122223333',
        body: '<h2>Claude Review</h2>\nNewest review comment in fallback window.',
      }],
      deleted_comment_ids: [5085058689],
      untouched_comment_ids: [5085000001],
    },
  },
  {
    id: 'CASE-6B-unused',
    desc: 'Unavailable priorIds with FALLBACK=1 and GRAPHIFY_VERDICT=unused deletes ONLY newest 5085058689',
    owner: 'praetorian-inc',
    repo: 'palatine',
    event_name: 'pull_request',
    pr_number: 385,
    reviewed_head_sha: '4444555566667777888899990000111122223333',
    prior_bot_comment_ids: null,
    claude_review_started_at: '2026-07-26T10:00:00Z',
    claude_review_started_at_fallback: '1',
    graphify_verdict: 'unused',
    exec_trace: null,
    comments: [
      { id: 5085000001, user_login: BOT, created_at: '2026-07-26T10:02:00Z', body: '## Claude Review\nEarlier comment inside fallback timestamp window.' },
      { id: 5085058689, user_login: BOT, created_at: '2026-07-26T10:12:00Z', body: '<h2>Claude Review</h2>\nNewest review comment in fallback window.' },
    ],
    expected: {
      step_failed: false,
      core_set_failed_called: false,
      created_reviews: [],
      deleted_comment_ids: [5085058689],
      untouched_comment_ids: [5085000001],
    },
  },
];

async function runCase(tc) {
  const caseDir = path.join(workdir, `case-${tc.id}`);
  fs.mkdirSync(caseDir, { recursive: true });

  const envKeys = [
    'CLAUDE_REVIEW_PRIOR_IDS',
    'CLAUDE_REVIEW_STARTED_AT',
    'CLAUDE_REVIEW_STARTED_AT_FALLBACK',
    'GRAPHIFY_VERDICT',
    'REVIEW_HEAD_SHA',
    'EXEC_FILE',
    'GITHUB_SERVER_URL',
  ];
  const savedEnv = {};
  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  if (Array.isArray(tc.prior_bot_comment_ids)) {
    const priorPath = path.join(caseDir, 'prior-ids.json');
    fs.writeFileSync(priorPath, JSON.stringify(tc.prior_bot_comment_ids), 'utf8');
    process.env.CLAUDE_REVIEW_PRIOR_IDS = priorPath;
  } else if (tc.prior_empty_file) {
    const priorPath = path.join(caseDir, 'prior-ids.json');
    fs.writeFileSync(priorPath, '', 'utf8');
    process.env.CLAUDE_REVIEW_PRIOR_IDS = priorPath;
  }

  if (tc.claude_review_started_at !== undefined) {
    process.env.CLAUDE_REVIEW_STARTED_AT = tc.claude_review_started_at;
  }
  if (tc.claude_review_started_at_fallback !== undefined) {
    process.env.CLAUDE_REVIEW_STARTED_AT_FALLBACK = tc.claude_review_started_at_fallback;
  }
  if (tc.graphify_verdict !== undefined) {
    process.env.GRAPHIFY_VERDICT = tc.graphify_verdict;
  }
  if (tc.reviewed_head_sha !== undefined) {
    process.env.REVIEW_HEAD_SHA = tc.reviewed_head_sha;
  }
  if (typeof tc.exec_raw === 'string') {
    const execPath = path.join(caseDir, 'execution.json');
    fs.writeFileSync(execPath, tc.exec_raw, 'utf8');
    process.env.EXEC_FILE = execPath;
  } else if (tc.exec_trace !== null && tc.exec_trace !== undefined) {
    const execPath = path.join(caseDir, 'execution.json');
    fs.writeFileSync(execPath, JSON.stringify(tc.exec_trace), 'utf8');
    process.env.EXEC_FILE = execPath;
  } else {
    process.env.EXEC_FILE = '';
  }
  process.env.GITHUB_SERVER_URL = 'https://github.com';

  const commentObjects = tc.comments.map((c) => ({
    id: c.id,
    user: c.user_login === null ? null : { login: c.user_login },
    created_at: c.created_at,
    body: c.body,
    html_url: `https://github.com/${tc.owner}/${tc.repo}/pull/${tc.pr_number}#issuecomment-${c.id}`,
  }));

  const createdReviews = [];
  const deletedIds = [];
  const failedMessages = [];
  let uncaughtError = null;

  const github = {
    paginate: async (endpoint, params, mapFn) => {
      const res = await endpoint(params);
      return mapFn ? mapFn(res) : res.data;
    },
    rest: {
      issues: {
        listComments: async (params) => {
          if (params.owner !== tc.owner || params.repo !== tc.repo || params.issue_number !== tc.pr_number) {
            throw new Error(`unexpected listComments params: ${JSON.stringify(params)}`);
          }
          return { data: JSON.parse(JSON.stringify(commentObjects)) };
        },
        deleteComment: async (params) => {
          if (tc.api_fault && tc.api_fault.operation === 'issues.deleteComment') {
            const err = new Error(tc.api_fault.message);
            err.status = tc.api_fault.status;
            throw err;
          }
          deletedIds.push(params.comment_id);
          return { status: 204 };
        },
      },
      pulls: {
        get: async () => ({
          data: { head: { sha: tc.live_pr_head_sha || tc.reviewed_head_sha || '' } },
        }),
        createReview: async (params) => {
          if (tc.api_fault && tc.api_fault.operation === 'pulls.createReview') {
            const err = new Error(tc.api_fault.message);
            err.status = tc.api_fault.status;
            throw err;
          }
          createdReviews.push({
            pull_number: params.pull_number,
            event: params.event,
            commit_id: Object.prototype.hasOwnProperty.call(params, 'commit_id') ? params.commit_id : null,
            body: params.body,
          });
          return { data: { id: 900000 + createdReviews.length } };
        },
      },
    },
  };

  const context = {
    eventName: tc.event_name,
    repo: { owner: tc.owner, repo: tc.repo },
    payload: {
      pull_request: {
        number: tc.pr_number,
        head: { sha: tc.live_pr_head_sha || tc.reviewed_head_sha || '' },
      },
    },
  };

  const core = {
    setFailed: (msg) => { failedMessages.push(String(msg)); },
    warning: () => {},
    info: () => {},
    notice: () => {},
    error: () => {},
  };

  try {
    await runExtracted(github, context, core, require);
  } catch (err) {
    uncaughtError = err;
  } finally {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }

  const deletedSet = new Set(deletedIds);
  const actual = {
    step_failed: failedMessages.length > 0 || uncaughtError !== null,
    core_set_failed_called: failedMessages.length > 0,
    created_reviews: createdReviews,
    deleted_comment_ids: deletedIds,
    untouched_comment_ids: tc.comments.map((c) => c.id).filter((id) => !deletedSet.has(id)),
  };

  const label = `${tc.id}: ${tc.desc}`;
  if (uncaughtError !== null) {
    record('FAIL', label, JSON.stringify(tc.expected), `uncaught error: ${uncaughtError.message}`);
    return;
  }
  const expStr = JSON.stringify(tc.expected);
  const actStr = JSON.stringify(actual);
  if (expStr === actStr) {
    record('PASS', label, '', '');
  } else {
    record('FAIL', label, expStr, actStr);
  }
}

(async () => {
  for (const tc of CASES) {
    await runCase(tc);
  }
  fs.writeFileSync(tsvPath, `${tsv.join('\n')}\n`, 'utf8');
})();
NODE
NODE_RC=$?
if [ "$NODE_RC" -ne 0 ] || [ ! -s "$WORKDIR/convert.tsv" ]; then
  bad "Convert to PR review node harness executed" "exit 0 + non-empty TSV" "rc=$NODE_RC $(cat "$WORKDIR/convert-script.log")"
else
  while IFS=$'\t' read -r verdict name exp act; do
    if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
  done < "$WORKDIR/convert.tsv"
fi

# ═════════════════════════════════════════════════════════════════════════════
printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
