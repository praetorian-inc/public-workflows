#!/usr/bin/env bash
# Regression tests for Claude PR review conversion in .github/workflows/claude-code.yml
# and CI wiring in .github/workflows/self-audit.yml (LAB-5196).
# Extracts and runs the REAL workflow steps via python3 + PyYAML (never duplicates logic).
# Requires: bash (3.2+), python3 with PyYAML, node, git, jq.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORKFLOW="${CLAUDE_WORKFLOW:-$REPO_ROOT/.github/workflows/claude-code.yml}"
SELF_AUDIT="${SELF_AUDIT_WORKFLOW:-$REPO_ROOT/.github/workflows/self-audit.yml}"
WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT
EXTRACT="$WORKDIR/extracted"
mkdir -p "$EXTRACT" "$WORKDIR/bin"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n          expected: [%s]\n          actual:   [%s]\n' "$1" "$2" "$3"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
section()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

for dep in python3 node git jq; do
  command -v "$dep" >/dev/null 2>&1 || { echo "ERROR: $dep is required" >&2; exit 1; }
done

# ── 1. Static & security contract + step extraction (INV-7 / CASE-7A) ───────
section "Static & security contract (INV-7 / CASE-7A) + step extraction"

python3 - "$WORKFLOW" "$SELF_AUDIT" "$EXTRACT" > "$WORKDIR/static.tsv" <<'PY' || { echo "ERROR: workflow extraction failed" >&2; exit 1; }
import pathlib, re, sys, yaml

wf = yaml.safe_load(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
audit = yaml.safe_load(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
out = pathlib.Path(sys.argv[3])
check = lambda n, c, e="", a="": print("PASS\t%s" % n if c else "FAIL\t%s\t%s\t%s" % (n, e, str(a).replace("\n", " ")))

job = (wf.get("jobs") or {}).get("claude-code-action") or {}
steps = job.get("steps") or []
ctx_step = next((s for s in steps if s.get("id") == "context"), None)
reset_step = next((s for s in steps if s.get("name") == "Reset graphify query log"), None)
conv_step = next((s for s in steps if s.get("name") == "Convert to PR review"), None)

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
    check("CASE-7A: Convert to PR review pins actions/github-script by 40-hex SHA",
          bool(re.fullmatch(r"actions/github-script@[0-9a-f]{40}", conv_uses)), "actions/github-script@<40-hex>", conv_uses)
    check("CASE-7A: Convert to PR review passes REVIEW_HEAD_SHA via env from steps.context.outputs.head_sha",
          bool(re.fullmatch(r"\$\{\{\s*steps\.context\.outputs\.head_sha\s*\}\}", str(conv_env.get("REVIEW_HEAD_SHA", "")).strip())),
          "${{ steps.context.outputs.head_sha }}", conv_env.get("REVIEW_HEAD_SHA", "<missing>"))
    check("CASE-7A: Convert to PR review passes EXEC_FILE via env from retry||primary execution_file",
          bool(re.fullmatch(r"\$\{\{\s*steps\.claude-review-retry\.outputs\.execution_file\s*\|\|\s*steps\.claude-review\.outputs\.execution_file\s*\}\}",
                            str(conv_env.get("EXEC_FILE", "")).strip())),
          "${{ steps.claude-review-retry.outputs.execution_file || steps.claude-review.outputs.execution_file }}",
          conv_env.get("EXEC_FILE", "<missing>"))
    check("CASE-7A: Convert to PR review with.script has zero ${{ expressions", "${{" not in conv_script, "none", "contains ${{")
    has_comment = bool(re.search(r"event\s*:\s*['\"]COMMENT['\"]", conv_script))
    has_other = bool(re.search(r"event\s*:\s*(?:['\"](?:APPROVE|REQUEST_CHANGES)['\"]|process\.env\b)", conv_script))
    check("CASE-7A: Convert to PR review hardcodes event: 'COMMENT' in pulls.createReview",
          has_comment and not has_other, "hardcoded event: 'COMMENT' only", "comment=%s other=%s" % (has_comment, has_other))
    (out / "convert-review.js").write_text(conv_script, encoding="utf-8")

hardened = str((job.get("env") or {}).get("CLAUDE_HARDENED_ARGS") or "")
allow_m, disallow_m = re.search(r'--allowedTools\s+"([^"]+)"', hardened), re.search(r'--disallowedTools\s+"([^"]+)"', hardened)
allow_tools = {t.strip() for t in (allow_m.group(1) if allow_m else "").split(",") if t.strip()}
disallow_tools = {t.strip() for t in (disallow_m.group(1) if disallow_m else "").split(",") if t.strip()}
forbidden = {"Bash(gh pr review:*)", "Bash(gh api:*)", "Write", "Edit", "MultiEdit"}
check("CASE-7A: CLAUDE_HARDENED_ARGS stays unwidened (no forbidden tools/flags; gh api disallowed)",
      bool(allow_tools) and not (allow_tools & forbidden) and "dangerously-skip-permissions" not in hardened and "Bash(gh api:*)" in disallow_tools,
      "unwidened allowlist + gh api disallowed", "allowed=%s" % sorted(allow_tools))

audit_on = audit.get("on") if audit.get("on") is not None else (audit.get(True) or {})
target_test = "test/claude-convert-review.test.sh"
check("CASE-7A: self-audit.yml wires test/claude-convert-review.test.sh in on.pull_request.paths",
      target_test in ((audit_on.get("pull_request") or {}).get("paths") or []), target_test, "missing")
check("CASE-7A: self-audit.yml wires test/claude-convert-review.test.sh in on.push.paths",
      target_test in ((audit_on.get("push") or {}).get("paths") or []), target_test, "missing")
audit_steps = ((audit.get("jobs") or {}).get("audit") or {}).get("steps") or []
pyyaml_idx = next((i for i, s in enumerate(audit_steps) if "PyYAML" in str(s.get("run") or "") or "PyYAML" in str(s.get("name") or "")), -1)
test_idx = next((i for i, s in enumerate(audit_steps) if target_test in str(s.get("run") or "")), -1)
check("CASE-7A: self-audit.yml audit job runs test/claude-convert-review.test.sh after PyYAML install",
      test_idx != -1 and pyyaml_idx != -1 and test_idx > pyyaml_idx,
      "step index > PyYAML step (%s)" % pyyaml_idx, "test_idx=%s pyyaml_idx=%s" % (test_idx, pyyaml_idx))
PY

while IFS=$'\t' read -r verdict name exp act; do
  if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
done < "$WORKDIR/static.tsv"

if [ ! -s "$EXTRACT/build-context.sh" ] || [ ! -s "$EXTRACT/reset-graphify.sh" ] || [ ! -s "$EXTRACT/convert-review.js" ]; then
  printf '\n  passed: %d   failed: %d  (extracted step missing)\n' "$PASS" "$((FAIL + 1))"; exit 1
fi

section "Syntax checks on extracted workflow steps"
for sh_file in build-context.sh reset-graphify.sh; do
  if bash -n "$EXTRACT/$sh_file" 2>"$WORKDIR/$sh_file.syn"; then ok "bash -n $sh_file"
  else bad "bash -n $sh_file" "clean parse" "$(cat "$WORKDIR/$sh_file.syn")"; fi
done
{ printf 'async function _check(github, context, core, require) {\n'; cat "$EXTRACT/convert-review.js"; printf '\n}\n'; } > "$WORKDIR/convert-review-check.js"
if node --check "$WORKDIR/convert-review-check.js" 2>"$WORKDIR/convert.syn"; then ok "node --check convert-review.js"
else bad "node --check convert-review.js" "clean parse" "$(cat "$WORKDIR/convert.syn")"; fi

# ── 2. Build review context (real temp git merge repo) ──────────────────────
section "Build review context — captures HEAD^2 as head_sha in GITHUB_OUTPUT"

GIT_REPO="$WORKDIR/pr-merge-repo"; CTX_TEMP="$WORKDIR/ctx-temp"; CTX_OUT="$WORKDIR/ctx.output"; CTX_LOG="$WORKDIR/ctx.log"
mkdir -p "$GIT_REPO" "$CTX_TEMP"; : > "$CTX_OUT"
(
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  export GIT_AUTHOR_NAME="Test" GIT_AUTHOR_EMAIL="t@example.com" GIT_COMMITTER_NAME="Test" GIT_COMMITTER_EMAIL="t@example.com"
  cd "$GIT_REPO" || exit 1
  git -c init.defaultBranch=main -c core.hooksPath=/dev/null init -q
  printf 'base\n' > app.sh && git add app.sh && git commit -q -m "base"
  git checkout -q -b pr-branch
  mkdir -p generated && printf 'pr\n' >> app.sh && printf 'gen\n' > generated/skip.txt
  git add app.sh generated/skip.txt && git commit -q -m "pr head"
  git rev-parse HEAD > "$WORKDIR/expected-head2.sha"
  git checkout -q main
  printf 'main\n' > other.txt && git add other.txt && git commit -q -m "main"
  git merge -q --no-ff pr-branch -m "Merge PR"
) || { echo "ERROR: failed to build temp git merge repo" >&2; exit 1; }

EXPECTED_HEAD2="$(cat "$WORKDIR/expected-head2.sha")"
assert_eq "fixture merge repo HEAD^2 matches PR head commit" \
  "$EXPECTED_HEAD2" "$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$GIT_REPO" rev-parse HEAD^2)"
(
  cd "$GIT_REPO" || exit 1
  env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GITHUB_OUTPUT="$CTX_OUT" \
    RUNNER_TEMP="$CTX_TEMP" REVIEW_EXCLUDE_PATHSPECS="generated/" \
    bash --noprofile --norc -eo pipefail "$EXTRACT/build-context.sh"
) > "$CTX_LOG" 2>&1
assert_eq "Build review context exits 0" "0" "$?"
assert_eq "Build review context writes head_sha=<HEAD^2> to GITHUB_OUTPUT" \
  "$EXPECTED_HEAD2" "$(sed -n 's/^head_sha=//p' "$CTX_OUT" | tail -n 1)"
if [ -s "$GIT_REPO/.claude-review/pr.diff" ] && grep -q '^app\.sh$' "$GIT_REPO/.claude-review/changed-files.txt"; then
  ok "Build review context writes scoped pr.diff and changed-files.txt"
else bad "Build review context writes scoped pr.diff and changed-files.txt" "non-empty diff with app.sh" "$(cat "$CTX_LOG")"; fi

# ── 3. Reset graphify query log (paginated stub gh) ─────────────────────────
section "Reset graphify query log — snapshots ALL github-actions[bot] comments"

if ! date -u -d 'Sun, 26 Jul 2026 10:10:00 GMT' +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
  cat > "$WORKDIR/bin/date" <<'DATESTUB'
#!/usr/bin/env bash
set -eu
d_spec=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in -u) shift ;; -d) d_spec="$2"; shift 2 ;; +*) fmt="${1#+}"; shift ;; *) shift ;; esac
done
python3 - "$d_spec" "$fmt" <<'PY'
import datetime, email.utils, re, sys
spec, fmt = sys.argv[1], sys.argv[2] or "%Y-%m-%dT%H:%M:%SZ"
m = re.fullmatch(r"([+-]?\d+)\s*seconds?", spec.strip())
dt = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=int(m.group(1))) if m
      else email.utils.parsedate_to_datetime(spec).astimezone(datetime.timezone.utc) if spec.strip()
      else datetime.datetime.now(datetime.timezone.utc))
print(dt.strftime(fmt))
PY
DATESTUB
  chmod +x "$WORKDIR/bin/date"
fi

cat > "$WORKDIR/bin/gh" <<'GHSTUB'
#!/usr/bin/env bash
set -u
[ "${1:-}" = "api" ] || { echo "stub gh: unsupported: $*" >&2; exit 64; }
shift; path=""; paginate=n; jqf=""; include_headers=n
while [ $# -gt 0 ]; do
  case "$1" in
    --paginate) paginate=y; shift ;; --jq|-q) jqf="$2"; shift 2 ;; -i|--include) include_headers=y; shift ;;
    -*) echo "stub gh: unknown flag $1" >&2; exit 64 ;; *) path="$1"; shift ;;
  esac
done
echo "GET $path paginate=$paginate headers=$include_headers" >> "$GH_LOG"
if [ "$path" = "rate_limit" ]; then printf 'HTTP/2 200\r\nDate: Sun, 26 Jul 2026 10:10:00 GMT\r\n\r\n{}\n'; exit 0; fi
[ "${GH_FAIL_COMMENTS:-0}" = "1" ] && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
for p in "$GH_PAGES"/page-*.json; do
  [ -f "$p" ] || continue
  if [ -n "$jqf" ]; then jq -r "$jqf" "$p" || exit 1; else cat "$p"; fi
  [ "$paginate" = y ] || break
done
GHSTUB
chmod +x "$WORKDIR/bin/gh"

run_reset_step() {
  local tag="$1"; shift
  local pages_dir="$WORKDIR/reset-pages-$tag" rtemp="$WORKDIR/reset-temp-$tag"
  local genv="$WORKDIR/reset-env-$tag" ghlog="$WORKDIR/reset-gh-$tag.log" steprout="$WORKDIR/reset-out-$tag.log"
  mkdir -p "$pages_dir" "$rtemp"; : > "$genv"; : > "$ghlog"
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
    env PATH="$WORKDIR/bin:$PATH" RUNNER_TEMP="$rtemp" GITHUB_ENV="$genv" GH_TOKEN=dummy \
      REPO=praetorian-inc/palatine PR_NUMBER=385 GH_PAGES="$pages_dir" GH_LOG="$ghlog" "$@" \
      bash --noprofile --norc -eo pipefail "$EXTRACT/reset-graphify.sh"
  ) > "$steprout" 2>&1
  RESET_RC=$?; RESET_ENV="$genv"; RESET_GHLOG="$ghlog"; RESET_LOG="$steprout"
}

run_reset_step "all-bots"
assert_eq "Reset graphify query log exits 0 on paginated mixed comments" "0" "$RESET_RC"
if grep -q 'GET repos/praetorian-inc/palatine/issues/385/comments paginate=y' "$RESET_GHLOG"; then
  ok "Reset graphify query log paginates issue comments"
else bad "Reset graphify query log paginates issue comments" "paginate=y" "$(cat "$RESET_GHLOG")"; fi
PRIOR_PATH="$(sed -n 's/^CLAUDE_REVIEW_PRIOR_IDS=//p' "$RESET_ENV" | tail -n 1)"
PRIOR_JSON="$( [ -n "$PRIOR_PATH" ] && [ -f "$PRIOR_PATH" ] && jq -c 'sort' "$PRIOR_PATH" 2>/dev/null || echo "<missing>" )"
assert_eq "Reset graphify query log records ALL github-actions[bot] IDs (excl human + ghost)" "[1001,1002,1005,1006,1007]" "$PRIOR_JSON"
assert_eq "Reset graphify query log records GitHub Date header as CLAUDE_REVIEW_STARTED_AT" \
  "2026-07-26T10:10:00Z" "$(sed -n 's/^CLAUDE_REVIEW_STARTED_AT=//p' "$RESET_ENV" | tail -n 1)"
assert_eq "Reset graphify query log sets FALLBACK=0 when Date header succeeds" \
  "0" "$(sed -n 's/^CLAUDE_REVIEW_STARTED_AT_FALLBACK=//p' "$RESET_ENV" | tail -n 1)"

run_reset_step "list-fail" GH_FAIL_COMMENTS=1
assert_eq "Reset graphify query log exits 0 when comment listing fails" "0" "$RESET_RC"
PRIOR_FAIL_PATH="$(sed -n 's/^CLAUDE_REVIEW_PRIOR_IDS=//p' "$RESET_ENV" | tail -n 1)"
if [ -n "$PRIOR_FAIL_PATH" ] && [ -f "$PRIOR_FAIL_PATH" ] && [ ! -s "$PRIOR_FAIL_PATH" ]; then
  ok "Reset graphify query log writes empty priorIds file on listing failure"
else bad "Reset graphify query log writes empty priorIds file on listing failure" "0-byte file" "$(cat "${PRIOR_FAIL_PATH:-/dev/null}" 2>/dev/null)"; fi
if grep -q '^::warning::' "$RESET_LOG"; then ok "Reset graphify query log emits ::warning on listing failure"
else bad "Reset graphify query log emits ::warning on listing failure" "::warning::..." "$(cat "$RESET_LOG")"; fi

# ── 4. Convert to PR review — table-driven Node execution (INV-1..INV-6) ────
section "Convert to PR review — behavioural matrix (INV-1..INV-6)"

node - "$EXTRACT/convert-review.js" "$WORKDIR" "$WORKDIR/convert.tsv" > "$WORKDIR/convert-script.log" 2>&1 <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');

const scriptBody = fs.readFileSync(process.argv[2], 'utf8');
const workdir = process.argv[3];
const tsvPath = process.argv[4];
const runExtracted = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', 'require', scriptBody);

const BOT = 'github-actions[bot]';
const COV = 'Coverage report: 99%.';
const SHA_385 = '24b97dcb7a8ce7f392bb7d1ee4cf974fb5bb517c';
const SHA_410 = '3333444455556666777788889999000011112222';
const SHA_6 = '4444555566667777888899990000111122223333';
const urlFor = (owner, repo, pr, id) => `https://github.com/${owner}/${repo}/pull/${pr}#issuecomment-${id}`;
const U = (id, pr = 410, repo = 'palatine') => urlFor('praetorian-inc', repo, pr, id);
const bot = (id, body, created_at = '2026-07-26T10:04:00Z', user_login = BOT) => ({ id, user_login, created_at, body });
const rev = (body, pull_number = 410, commit_id = SHA_410) => ({ pull_number, event: 'COMMENT', commit_id, body });
const converted = (id, body, pr = 410, sha = SHA_410) => ({ created_reviews: [rev(body, pr, sha)], deleted_comment_ids: [id] });

function trace(calls) {
  const entries = [{ type: 'system', subtype: 'init' }];
  (Array.isArray(calls) ? calls : [calls]).forEach((c, idx) => {
    const toolId = c.toolId || `toolu_gh_comment_${idx + 1}`;
    const pr = c.prNumber || 410, repo = c.repo || 'palatine';
    const text = c.resultText !== undefined ? c.resultText : `${U(c.commentId, pr, repo)}\n`;
    const parent = c.parentToolUseId === undefined ? null : c.parentToolUseId;
    entries.push(
      { type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: toolId, name: c.name || 'Bash',
          input: c.input || { command: c.command || `gh pr comment ${pr} --body-file /tmp/review.md` } },
      ] } },
      { type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: toolId, is_error: Boolean(c.isError),
          content: c.arrayContent ? [{ type: 'text', text }] : text },
      ] } }
    );
  });
  entries.push({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
  return entries;
}

function makeCase(id, desc, overrides) {
  const tc = {
    id, desc, owner: 'praetorian-inc', repo: 'palatine', event_name: 'pull_request',
    pr_number: 410, reviewed_head_sha: SHA_410, prior_bot_comment_ids: [],
    graphify_verdict: 'used', exec_trace: null, comments: [], ...overrides,
  };
  const exp = { step_failed: false, core_set_failed_called: false, created_reviews: [], deleted_comment_ids: [], ...(overrides.expected || {}) };
  if (exp.untouched_comment_ids === undefined) {
    const del = new Set(exp.deleted_comment_ids);
    exp.untouched_comment_ids = tc.comments.map((c) => c.id).filter((cid) => !del.has(cid));
  }
  tc.expected = exp;
  return tc;
}

const CASES = [
  // INV-1..INV-3: HTML, custom prompt, standard Markdown + HEAD^2 pin
  makeCase('CASE-1A', 'PR #385 HTML <h2>Claude Review</h2> converts with HEAD^2 commit_id, deletes 5085058689, keeps 5085000001', {
    event_name: 'pull_request_review_comment', pr_number: 385, reviewed_head_sha: SHA_385, live_pr_head_sha: SHA_385,
    prior_bot_comment_ids: [5085000001], exec_trace: trace({ prNumber: 385, commentId: 5085058689 }),
    comments: [bot(5085000001, '## Claude Review\nPrior round review.', '2026-07-26T10:00:00Z'), bot(5085058689, '<h2>Claude Review</h2>\n\n### Findings\nNo blocking issues found.', '2026-07-26T10:15:00Z')],
    expected: converted(5085058689, '<h2>Claude Review</h2>\n\n### Findings\nNo blocking issues found.', 385, SHA_385),
  }),
  makeCase('CASE-1B', 'PR #385 HTML heading pins commit_id to REVIEW_HEAD_SHA even after live PR head advances', {
    event_name: 'pull_request_review_comment', pr_number: 385, reviewed_head_sha: SHA_385,
    live_pr_head_sha: '9f8e7d6c5b4a3928171615141312111009080706', exec_trace: trace({ prNumber: 385, commentId: 5085058689 }),
    comments: [bot(5085058689, '<h2>Claude Review</h2>\n\nReviewed at HEAD^2 before newer push.', '2026-07-26T10:15:00Z')],
    expected: converted(5085058689, '<h2>Claude Review</h2>\n\nReviewed at HEAD^2 before newer push.', 385, SHA_385),
  }),
  makeCase('CASE-2A', 'Orator PR #229 custom ## Summary heading converts 5870912153, leaves prior 5858699221 untouched', {
    repo: 'orator', pr_number: 229, reviewed_head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    prior_bot_comment_ids: [5858699221], exec_trace: trace({ repo: 'orator', prNumber: 229, commentId: 5870912153 }),
    comments: [bot(5858699221, '## Summary\nPrior unconverted run comment.', '2026-09-27T14:00:00Z'), bot(5870912153, '## Summary\n\nCustom caller prompt review without Claude Review heading.', '2026-09-28T15:30:00Z')],
    expected: converted(5870912153, '## Summary\n\nCustom caller prompt review without Claude Review heading.', 229, 'abcdef1234567890abcdef1234567890abcdef12'),
  }),
  makeCase('CASE-3A', 'Standard ## Claude Review on pull_request converts with commit_id=HEAD^2', {
    pr_number: 385, reviewed_head_sha: '1111222233334444555566667777888899990000', exec_trace: trace({ prNumber: 385, commentId: 5085010001 }),
    comments: [bot(5085010001, '## Claude Review\n\nStandard PR opened review.', '2026-07-26T09:00:00Z')],
    expected: converted(5085010001, '## Claude Review\n\nStandard PR opened review.', 385, '1111222233334444555566667777888899990000'),
  }),
  makeCase('CASE-3B', 'Standard ## Claude Review on pull_request_review_comment (array tool_result) converts with HEAD^2', {
    event_name: 'pull_request_review_comment', pr_number: 385, reviewed_head_sha: '2222333344445555666677778888999900001111',
    prior_bot_comment_ids: [5085010001], exec_trace: trace({ prNumber: 385, commentId: 5085020002, arrayContent: true }),
    comments: [bot(5085010001, '## Claude Review\n\nRound 1 comment.', '2026-07-26T09:00:00Z'), bot(5085020002, '## Claude Review\n\nInline @claude re-review comment.', '2026-07-26T09:30:00Z')],
    expected: converted(5085020002, '## Claude Review\n\nInline @claude re-review comment.', 385, '2222333344445555666677778888999900001111'),
  }),

  // INV-4: Isolation, fallback, spoofing, subagents, edge branches
  makeCase('CASE-4A', 'Prior bot + concurrent Codex/Gemini/Grok comments stay untouched; only 600005 converts', {
    prior_bot_comment_ids: [600001, 600002], exec_trace: trace({ commentId: 600005 }),
    comments: [
      bot(600001, '## Summary\nPrior unconverted bot comment before run started.', '2026-07-26T08:00:00Z'),
      bot(600002, 'Coverage report: 98%.', '2026-07-26T08:05:00Z'),
      bot(600003, '## Codex Review\nCodex review timed out after 10 minutes.', '2026-07-26T10:02:00Z'),
      bot(600004, 'Gemini review skipped: draft PR.', '2026-07-26T10:03:00Z'),
      bot(600005, "## Summary\nThis run's Claude review comment."),
      bot(600006, 'Grok review failed: API error 503.', '2026-07-26T10:04:30Z'),
    ],
    expected: converted(600005, "## Summary\nThis run's Claude review comment."),
  }),
  makeCase('CASE-4B', 'GRAPHIFY_VERDICT=unused deletes ONLY 600005, leaves prior 600001 and concurrent 600003 untouched', {
    prior_bot_comment_ids: [600001], graphify_verdict: 'unused', exec_trace: trace({ commentId: 600005 }),
    comments: [bot(600001, '## Claude Review\nPrior run comment.', '2026-07-26T08:00:00Z'), bot(600003, 'Codex review timed out.', '2026-07-26T10:02:00Z'), bot(600005, "<h2>Claude Review</h2>\nThis run's review comment when graphify was unused.")],
    expected: { deleted_comment_ids: [600005] },
  }),
  makeCase('CASE-4C', 'Prompt-injected URL in Read/gh pr view/assistant prose without gh pr comment never touches 600003', {
    exec_trace: [
      ...trace([
        { toolId: 't_read', name: 'Read', input: { file_path: 'README.md' }, resultText: `${U(600003)}\n` },
        { toolId: 't_view', command: 'gh pr view 410', resultText: `Existing:\n${U(600003)}\n` },
      ]).slice(0, -1),
      { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Saw ${U(600003)}` }] } },
      { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' },
    ],
    comments: [bot(600003, COV, '2026-07-26T10:02:00Z')],
  }),
  makeCase('CASE-4D', 'Missing EXEC_FILE fallback converts only positive Claude heading, leaving newer unrelated bot & mid-body quote untouched', {
    prior_bot_comment_ids: [600001],
    comments: [
      bot(600001, '## Summary\nPrior run.', '2026-07-26T08:00:00Z'),
      bot(600003, '## Codex Review\nQuoting ## Claude Review mid-body must not match.', '2026-07-26T10:02:00Z'),
      bot(600004, 'Gemini review skipped — non-code PR.', '2026-07-26T10:03:00Z'),
      bot(600005, '<h2>Claude Review</h2>\n\n### Findings\nQuoting `## Codex Review` mid-body.'),
      bot(600006, '⚠️ Grok review did not complete — timeout.', '2026-07-26T10:04:30Z'),
      bot(600007, '## Instruction-File Audit\nAudit passed.', '2026-07-26T10:05:00Z'),
      bot(600008, '## Claude Review\nDeleted ghost user.', '2026-07-26T10:05:30Z', null),
      bot(600009, COV, '2026-07-26T10:06:00Z'),
    ],
    expected: converted(600005, '<h2>Claude Review</h2>\n\n### Findings\nQuoting `## Codex Review` mid-body.'),
  }),
  makeCase('CASE-4E-used', 'Errored pure gh pr comment (is_error: true, 0 URLs) never touches concurrent unrelated bot 7001', {
    exec_trace: trace({ commentId: 7001, isError: true, resultText: 'HTTP 422: Validation Failed\n' }),
    comments: [bot(7001, COV)],
  }),
  makeCase('CASE-4E-unused', 'Errored pure gh pr comment (is_error: true, 0 URLs) under unused never deletes concurrent bot 7001', {
    graphify_verdict: 'unused', exec_trace: trace({ commentId: 7001, isError: true, resultText: 'HTTP 422: Validation Failed\n' }),
    comments: [bot(7001, COV)],
  }),
  makeCase('CASE-4F-compound-spoof-used', 'Compound gh pr view && gh pr comment with spoofed + genuine URLs converts only Claude 7002, leaves 7099 untouched', {
    exec_trace: trace({ command: 'gh pr view 410 && gh pr comment 410 --body "<h2>Claude Review</h2>\nReal review."', resultText: `${U(7099)}\n${U(7002)}\n` }),
    comments: [bot(7002, '<h2>Claude Review</h2>\nReal review.'), bot(7099, COV, '2026-07-26T10:04:30Z')],
    expected: converted(7002, '<h2>Claude Review</h2>\nReal review.'),
  }),
  makeCase('CASE-4F-compound-spoof-unused', 'Compound gh pr view && gh pr comment with spoofed + genuine URLs under unused deletes only 7002, leaves 7099 untouched', {
    graphify_verdict: 'unused',
    exec_trace: trace({ command: 'gh pr view 410 && gh pr comment 410 --body "<h2>Claude Review</h2>\nReal review."', resultText: `${U(7099)}\n${U(7002)}\n` }),
    comments: [bot(7002, '<h2>Claude Review</h2>\nReal review.'), bot(7099, COV, '2026-07-26T10:04:30Z')],
    expected: { deleted_comment_ids: [7002] },
  }),
  makeCase('CASE-4F-subshell-spoof', 'Subshell gh pr comment --body "$(gh pr view 410 >&2)" spoofing 7004 leaves 7004 untouched', {
    exec_trace: trace({ command: 'gh pr comment 410 --body "$(gh pr view 410 >&2)"', commentId: 7004 }),
    comments: [bot(7004, COV)],
  }),
  makeCase('CASE-4F-heredoc-pure', 'Standalone gh pr comment with $(cat <<EOF) quoted heredoc converts custom ## Summary cleanly', {
    exec_trace: trace({ command: "gh pr comment 410 --body \"$(cat <<'EOF'\n## Summary\nDon't break; foo && bar\nEOF\n)\"", commentId: 7015 }),
    comments: [bot(7015, "## Summary\nDon't break; foo && bar"), bot(7016, COV, '2026-07-26T10:04:30Z')],
    expected: converted(7015, "## Summary\nDon't break; foo && bar"),
  }),
  makeCase('CASE-4F-heredoc-stdin-pure', 'Standalone gh pr comment --body-file - <<EOF converts custom ## Summary cleanly', {
    exec_trace: trace({ command: "gh pr comment 410 --body-file - <<'EOF'\n## Summary\nLine; a && b\nEOF", commentId: 7025 }),
    comments: [bot(7025, '## Summary\nLine; a && b'), bot(7026, COV, '2026-07-26T10:04:30Z')],
    expected: converted(7025, '## Summary\nLine; a && b'),
  }),
  makeCase('CASE-4F-brace-unused', 'Brace-grouped { gh pr comment ...; } under unused deletes 7017, leaves Coverage 7018 untouched', {
    graphify_verdict: 'unused',
    exec_trace: trace({ command: '{ gh pr comment 410 --body "<h2>Claude Review</h2>\nBraced review."; }', commentId: 7017 }),
    comments: [bot(7017, '<h2>Claude Review</h2>\nBraced review.'), bot(7018, COV, '2026-07-26T10:04:30Z')],
    expected: { deleted_comment_ids: [7017] },
  }),
  makeCase('CASE-4F-compound-error-unused', 'Compound gh pr comment && gh pr view 999999 (is_error: true) under unused deletes unverified 7003, leaves 7020 untouched', {
    graphify_verdict: 'unused',
    exec_trace: trace({ command: 'gh pr comment 410 --body "<h2>Claude Review</h2>\nUnverified." && gh pr view 999999', isError: true, resultText: `Exit code 1\n${U(7003)}\nno pull requests found\n` }),
    comments: [bot(7003, '<h2>Claude Review</h2>\nUnverified.'), bot(7020, COV, '2026-07-26T10:04:30Z')],
    expected: { deleted_comment_ids: [7003] },
  }),
  makeCase('CASE-4F-quoted-negative', 'Negative control: gh pr comment inside quotes or # comment never matches or touches 7004', {
    exec_trace: trace({ command: "# gh pr comment 410\ngraphify query \"gh pr comment\" && graphify explain 'gh pr comment'", commentId: 7004 }),
    comments: [bot(7004, COV)],
  }),
  makeCase('CASE-4G-subagent-used', 'Subagent standalone gh pr comment posting custom ## Summary converts & deletes 7005, leaves 7019 untouched', {
    exec_trace: trace({ commentId: 7005, parentToolUseId: 'toolu_sub' }),
    comments: [bot(7005, '## Summary\nSubagent review.'), bot(7019, COV, '2026-07-26T10:04:30Z')],
    expected: converted(7005, '## Summary\nSubagent review.'),
  }),
  makeCase('CASE-4G-subagent-unused', 'Subagent standalone gh pr comment under unused deletes 7005 fail-closed, leaves 7019 untouched', {
    graphify_verdict: 'unused', exec_trace: trace({ commentId: 7005, parentToolUseId: 'toolu_sub' }),
    comments: [bot(7005, '## Summary\nSubagent unverified review.'), bot(7019, COV, '2026-07-26T10:04:30Z')],
    expected: { deleted_comment_ids: [7005] },
  }),
  makeCase('CASE-4H-corrupt-unused', 'Corrupt EXEC_FILE under unused tolerates body: null (7006), deletes only 7008, leaves newer Coverage 7009 untouched', {
    prior_bot_comment_ids: [7000], graphify_verdict: 'unused', exec_raw: '{truncated corrupt json',
    comments: [
      bot(7000, '## Claude Review\nPrior run.', '2026-07-26T08:00:00Z'), bot(7006, null, '2026-07-26T10:02:00Z'),
      bot(7007, '## Codex Review\nTimed out.', '2026-07-26T10:03:00Z'), bot(7008, '<h2>Claude Review</h2>\nUnverified.'),
      bot(7009, COV, '2026-07-26T10:05:00Z'),
    ],
    expected: { deleted_comment_ids: [7008] },
  }),
  makeCase('CASE-4I-no-url-fallthrough', 'Pure gh pr comment with empty stdout falls through to positive heading, converts only 7010, leaves newer 7011 untouched', {
    exec_trace: trace({ resultText: '' }),
    comments: [bot(7010, '<h2>Claude Review</h2>\nFallback review.'), bot(7011, COV, '2026-07-26T10:05:00Z')],
    expected: converted(7010, '<h2>Claude Review</h2>\nFallback review.'),
  }),
  makeCase('CASE-4J-exec-id-in-prior', 'Pure gh pr comment returning priorIds member 7000 keeps ours empty without falling through to else', {
    prior_bot_comment_ids: [7000], exec_trace: trace({ commentId: 7000 }),
    comments: [bot(7000, '## Claude Review\nPrior run.', '2026-07-26T08:00:00Z'), bot(7012, '<h2>Claude Review</h2>\nOther.'), bot(7013, COV, '2026-07-26T10:05:00Z')],
  }),
  makeCase('CASE-4K-help-noop', 'Intact EXEC_FILE with gh pr comment --help (0 URLs) under unused leaves Coverage 7021 untouched', {
    graphify_verdict: 'unused', exec_trace: trace({ command: 'gh pr comment --help', resultText: 'Usage: gh pr comment\n' }),
    comments: [bot(7021, COV)],
  }),

  // INV-5: Loud failures (core.setFailed) & fail-closed deletion order
  makeCase('CASE-5A', 'pulls.createReview 422 calls core.setFailed and leaves 5085058689 undeleted', {
    pr_number: 385, reviewed_head_sha: SHA_385, exec_trace: trace({ prNumber: 385, commentId: 5085058689 }),
    comments: [bot(5085058689, '<h2>Claude Review</h2>\nReview body.', '2026-07-26T10:15:00Z')],
    api_fault: { operation: 'pulls.createReview', status: 422, message: 'Unprocessable Entity: commit_id is not part of the pull request' },
    expected: { step_failed: true, core_set_failed_called: true },
  }),
  makeCase('CASE-5B', 'Missing REVIEW_HEAD_SHA calls core.setFailed with 0 reviews and 0 deletions', {
    pr_number: 385, reviewed_head_sha: '', exec_trace: trace({ prNumber: 385, commentId: 5085058689 }),
    comments: [bot(5085058689, '## Claude Review\nReview body.', '2026-07-26T10:15:00Z')],
    expected: { step_failed: true, core_set_failed_called: true },
  }),
  makeCase('CASE-5C', 'Invalid REVIEW_HEAD_SHA calls core.setFailed with 0 reviews and 0 deletions', {
    pr_number: 385, reviewed_head_sha: 'not-a-40-hex-sha', exec_trace: trace({ prNumber: 385, commentId: 5085058689 }),
    comments: [bot(5085058689, '## Claude Review\nReview body.', '2026-07-26T10:15:00Z')],
    expected: { step_failed: true, core_set_failed_called: true },
  }),
  makeCase('CASE-5D', 'GRAPHIFY_VERDICT=unused deleteComment 500 calls core.setFailed', {
    pr_number: 385, reviewed_head_sha: SHA_385, graphify_verdict: 'unused', exec_trace: trace({ prNumber: 385, commentId: 5085058689 }),
    comments: [bot(5085058689, '<h2>Claude Review</h2>\nReview body with unused graphify.', '2026-07-26T10:15:00Z')],
    api_fault: { operation: 'issues.deleteComment', status: 500, message: 'Internal Server Error' },
    expected: { step_failed: true, core_set_failed_called: true },
  }),
  makeCase('CASE-5E', 'GRAPHIFY_VERDICT=unused deletes comment even when REVIEW_HEAD_SHA is empty', {
    pr_number: 385, reviewed_head_sha: '', graphify_verdict: 'unused', exec_trace: trace({ prNumber: 385, commentId: 5085058689 }),
    comments: [bot(5085058689, '<h2>Claude Review</h2>\nUnverified review with empty SHA.', '2026-07-26T10:15:00Z')],
    expected: { deleted_comment_ids: [5085058689] },
  }),
  makeCase('CASE-5E-multi-unused', 'GRAPHIFY_VERDICT=unused continues deleting 2nd doomed comment after 1st deleteComment fails', {
    pr_number: 385, reviewed_head_sha: SHA_385, graphify_verdict: 'unused',
    exec_trace: trace([{ prNumber: 385, commentId: 5085058689 }, { prNumber: 385, commentId: 5085058690 }]),
    comments: [bot(5085058689, '<h2>Claude Review</h2>\nFirst doomed.', '2026-07-26T10:14:00Z'), bot(5085058690, '<h2>Claude Review</h2>\nSecond doomed.', '2026-07-26T10:15:00Z')],
    api_fault: { operation: 'issues.deleteComment', comment_id: 5085058689, status: 500, message: 'Internal Server Error' },
    expected: { step_failed: true, core_set_failed_called: true, deleted_comment_ids: [5085058690] },
  }),
  makeCase('CASE-5F-delete-after-create', 'Normal-path deleteComment 500 after pulls.createReview succeeds calls core.setFailed', {
    pr_number: 385, reviewed_head_sha: SHA_385, exec_trace: trace({ prNumber: 385, commentId: 5085058689 }),
    comments: [bot(5085058689, '<h2>Claude Review</h2>\nReview created before delete fails.', '2026-07-26T10:15:00Z')],
    api_fault: { operation: 'issues.deleteComment', status: 500, message: 'Internal Server Error' },
    expected: { step_failed: true, core_set_failed_called: true, created_reviews: [rev('<h2>Claude Review</h2>\nReview created before delete fails.', 385, SHA_385)] },
  }),

  // INV-6: Unavailable priorIds fallback & single-newest bound
  makeCase('CASE-6A', 'Unavailable priorIds falls back to CLAUDE_REVIEW_STARTED_AT (FALLBACK=0), leaves prior 5085000001 untouched', {
    pr_number: 385, reviewed_head_sha: SHA_6, prior_bot_comment_ids: null, prior_empty_file: true,
    claude_review_started_at: '2026-07-26T10:10:00Z', claude_review_started_at_fallback: '0',
    comments: [bot(5085000001, '## Claude Review\nPrior run comment posted before CLAUDE_REVIEW_STARTED_AT.', '2026-07-26T10:05:00Z'), bot(5085058689, '<h2>Claude Review</h2>\nCurrent run comment posted after CLAUDE_REVIEW_STARTED_AT.', '2026-07-26T10:12:00Z')],
    expected: converted(5085058689, '<h2>Claude Review</h2>\nCurrent run comment posted after CLAUDE_REVIEW_STARTED_AT.', 385, SHA_6),
  }),
  makeCase('CASE-6B', 'Unavailable priorIds with FALLBACK=1 converts & deletes ONLY newest 5085058689, leaves 5085000001 untouched', {
    pr_number: 385, reviewed_head_sha: SHA_6, prior_bot_comment_ids: null,
    claude_review_started_at: '2026-07-26T10:00:00Z', claude_review_started_at_fallback: '1',
    comments: [bot(5085000001, '## Claude Review\nEarlier comment inside fallback timestamp window.', '2026-07-26T10:02:00Z'), bot(5085058689, '<h2>Claude Review</h2>\nNewest review comment in fallback window.', '2026-07-26T10:12:00Z')],
    expected: converted(5085058689, '<h2>Claude Review</h2>\nNewest review comment in fallback window.', 385, SHA_6),
  }),
  makeCase('CASE-6B-unused', 'Unavailable priorIds with FALLBACK=1 and GRAPHIFY_VERDICT=unused deletes ONLY newest 5085058689', {
    pr_number: 385, reviewed_head_sha: SHA_6, prior_bot_comment_ids: null, graphify_verdict: 'unused',
    claude_review_started_at: '2026-07-26T10:00:00Z', claude_review_started_at_fallback: '1',
    comments: [bot(5085000001, '## Claude Review\nEarlier comment inside fallback timestamp window.', '2026-07-26T10:02:00Z'), bot(5085058689, '<h2>Claude Review</h2>\nNewest review comment in fallback window.', '2026-07-26T10:12:00Z')],
    expected: { deleted_comment_ids: [5085058689] },
  }),
];

const ENV_KEYS = ['CLAUDE_REVIEW_PRIOR_IDS', 'CLAUDE_REVIEW_STARTED_AT', 'CLAUDE_REVIEW_STARTED_AT_FALLBACK', 'GRAPHIFY_VERDICT', 'REVIEW_HEAD_SHA', 'EXEC_FILE', 'GITHUB_SERVER_URL'];
const tsv = [];
const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');

async function runCase(tc) {
  const caseDir = path.join(workdir, `case-${tc.id}`);
  fs.mkdirSync(caseDir, { recursive: true });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => { delete process.env[k]; });

  if (Array.isArray(tc.prior_bot_comment_ids) || tc.prior_empty_file) {
    const p = path.join(caseDir, 'prior-ids.json');
    fs.writeFileSync(p, tc.prior_empty_file ? '' : JSON.stringify(tc.prior_bot_comment_ids), 'utf8');
    process.env.CLAUDE_REVIEW_PRIOR_IDS = p;
  }
  if (tc.claude_review_started_at !== undefined) process.env.CLAUDE_REVIEW_STARTED_AT = tc.claude_review_started_at;
  if (tc.claude_review_started_at_fallback !== undefined) process.env.CLAUDE_REVIEW_STARTED_AT_FALLBACK = tc.claude_review_started_at_fallback;
  if (tc.graphify_verdict !== undefined) process.env.GRAPHIFY_VERDICT = tc.graphify_verdict;
  if (tc.reviewed_head_sha !== undefined) process.env.REVIEW_HEAD_SHA = tc.reviewed_head_sha;
  if (typeof tc.exec_raw === 'string' || tc.exec_trace) {
    const ep = path.join(caseDir, 'execution.json');
    fs.writeFileSync(ep, typeof tc.exec_raw === 'string' ? tc.exec_raw : JSON.stringify(tc.exec_trace), 'utf8');
    process.env.EXEC_FILE = ep;
  } else process.env.EXEC_FILE = '';
  process.env.GITHUB_SERVER_URL = 'https://github.com';

  const commentObjects = tc.comments.map((c) => ({
    id: c.id, user: c.user_login === null ? null : { login: c.user_login },
    created_at: c.created_at, body: c.body, html_url: urlFor(tc.owner, tc.repo, tc.pr_number, c.id),
  }));
  const createdReviews = [], deletedIds = [], failedMessages = [];
  let uncaught = null;

  const github = {
    paginate: async (ep, params, mapFn) => { const res = await ep(params); return mapFn ? mapFn(res) : res.data; },
    rest: {
      issues: {
        listComments: async (p) => {
          if (p.owner !== tc.owner || p.repo !== tc.repo || p.issue_number !== tc.pr_number) throw new Error(`bad params: ${JSON.stringify(p)}`);
          return { data: JSON.parse(JSON.stringify(commentObjects)) };
        },
        deleteComment: async (p) => {
          if (tc.api_fault && tc.api_fault.operation === 'issues.deleteComment' &&
              (tc.api_fault.comment_id === undefined || tc.api_fault.comment_id === p.comment_id)) {
            throw Object.assign(new Error(tc.api_fault.message), { status: tc.api_fault.status });
          }
          deletedIds.push(p.comment_id);
          return { status: 204 };
        },
      },
      pulls: {
        get: async () => ({ data: { head: { sha: tc.live_pr_head_sha || tc.reviewed_head_sha || '' } } }),
        createReview: async (p) => {
          if (tc.api_fault && tc.api_fault.operation === 'pulls.createReview') throw Object.assign(new Error(tc.api_fault.message), { status: tc.api_fault.status });
          createdReviews.push({ pull_number: p.pull_number, event: p.event, commit_id: Object.prototype.hasOwnProperty.call(p, 'commit_id') ? p.commit_id : null, body: p.body });
          return { data: { id: 900000 + createdReviews.length } };
        },
      },
    },
  };
  const context = {
    eventName: tc.event_name, repo: { owner: tc.owner, repo: tc.repo },
    payload: { pull_request: { number: tc.pr_number, head: { sha: tc.live_pr_head_sha || tc.reviewed_head_sha || '' } } },
  };
  const core = { setFailed: (m) => failedMessages.push(String(m)), warning: () => {}, info: () => {}, notice: () => {}, error: () => {} };

  try { await runExtracted(github, context, core, require); }
  catch (err) { uncaught = err; }
  finally { ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }

  const del = new Set(deletedIds);
  const actual = {
    step_failed: failedMessages.length > 0 || uncaught !== null,
    core_set_failed_called: failedMessages.length > 0,
    created_reviews: createdReviews, deleted_comment_ids: deletedIds,
    untouched_comment_ids: tc.comments.map((c) => c.id).filter((cid) => !del.has(cid)),
  };
  const label = `${tc.id}: ${tc.desc}`;
  if (uncaught !== null) tsv.push(`FAIL\t${label}\t${clean(JSON.stringify(tc.expected))}\t${clean(`uncaught error: ${uncaught.message}`)}`);
  else if (JSON.stringify(tc.expected) === JSON.stringify(actual)) tsv.push(`PASS\t${label}`);
  else tsv.push(`FAIL\t${label}\t${clean(JSON.stringify(tc.expected))}\t${clean(JSON.stringify(actual))}`);
}

(async () => { for (const tc of CASES) await runCase(tc); fs.writeFileSync(tsvPath, `${tsv.join('\n')}\n`, 'utf8'); })();
NODE
NODE_RC=$?
if [ "$NODE_RC" -ne 0 ] || [ ! -s "$WORKDIR/convert.tsv" ]; then
  bad "Convert to PR review node harness executed" "exit 0 + non-empty TSV" "rc=$NODE_RC $(cat "$WORKDIR/convert-script.log")"
else
  while IFS=$'\t' read -r verdict name exp act; do
    if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
  done < "$WORKDIR/convert.tsv"
fi

printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
