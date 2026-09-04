#!/usr/bin/env bash
#
# Tests for the instruction-file audit pre-filter / scope / prompt contract in
# .github/workflows/agents-md-audit.yml (ENG-7538).
#
# The scripts under test are EXTRACTED from the workflow YAML at run time and
# executed against throwaway git fixture repositories. Nothing in this file
# re-implements or mirrors the workflow's logic: a mirror cannot discriminate
# between a working implementation and a broken one.
#
# Three `run:` blocks are exercised:
#   * jobs['pre-filter'].steps[id=check]  — which instruction files the PR edited
#   * jobs['audit-check'].steps[id=scope] — its fail-open inventory branch
#   * jobs['audit-check'].steps[id=rubric] — its fail-open rubric-load gate
#
# The Claude prompt is asserted as a contract (classes, no drift.yml class,
# skill path not an inlined rubric, inventory vs command-correction guidance).
#
# Runtime notes:
#   * The fixtures have full local history, so `git merge-base` succeeds
#     immediately and the deepen ladder never fires.
#   * `git fetch origin ...` fails fast (the fixtures have no remote) and is
#     `|| true`-tolerated. On a host without coreutils `timeout` the fetch
#     helper exits 127 instead, which lands in the same tolerated path.
#
# Usage: bash test/agents-md-audit-prefilter.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORKFLOW="$REPO_ROOT/.github/workflows/agents-md-audit.yml"
TEST_WORKFLOW="$REPO_ROOT/.github/workflows/test-agents-md-audit.yml"
DRIFT_WORKFLOW="$REPO_ROOT/.github/workflows/claude-md-drift.yml"
README="$REPO_ROOT/README.md"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

EXTRACT="$WORKDIR/extracted"
mkdir -p "$EXTRACT"

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
assert_contains() {
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "contains $3" "missing"; fi
}
assert_absent() {
  if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1" "absent $3" "present"; else ok "$1"; fi
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── Extract the real run: blocks and the prompt out of the workflow YAML ──────
section "Extracting run: blocks from $(basename "$WORKFLOW")"

python3 - "$WORKFLOW" "$EXTRACT" "$README" "$TEST_WORKFLOW" <<'PY' || { echo "ERROR: extraction failed" >&2; exit 1; }
import json
import pathlib
import sys

import yaml

workflow_path = pathlib.Path(sys.argv[1])
wf = yaml.safe_load(workflow_path.read_text())
out = pathlib.Path(sys.argv[2])
readme = pathlib.Path(sys.argv[3]).read_text()
test_wf = yaml.safe_load(pathlib.Path(sys.argv[4]).read_text())


def step(job, step_id, required=True):
    for st in wf["jobs"][job]["steps"]:
        if st.get("id") == step_id:
            return st
    if required:
        raise SystemExit("step not found: %s / id=%s" % (job, step_id))
    return {}


def step_run(job, step_id):
    return step(job, step_id)["run"]


def step_prompt(job):
    for st in wf["jobs"][job]["steps"]:
        w = st.get("with") or {}
        if "prompt" in w:
            return w["prompt"]
    raise SystemExit("prompt not found in job %s" % job)


def step_claude_args(job):
    for st in wf["jobs"][job]["steps"]:
        w = st.get("with") or {}
        if "claude_args" in w:
            return w["claude_args"]
    raise SystemExit("claude_args not found in job %s" % job)


for job, step_id, name in (
    ("pre-filter", "check", "prefilter.sh"),
    ("audit-check", "scope", "scope.sh"),
    ("audit-check", "rubric", "rubric.sh"),
):
    body = step_run(job, step_id)
    if "${{" in body:
        raise SystemExit(
            "%s/%s contains a ${{ }} expression; it cannot be executed "
            "standalone and this harness would be testing a lie" % (job, step_id)
        )
    (out / name).write_text(body)

(out / "prompt.txt").write_text(step_prompt("audit-check"))
(out / "claude_args.txt").write_text(step_claude_args("audit-check"))

# PyYAML 6 follows YAML 1.1 and parses an unquoted `on` key as boolean True.
on = wf.get("on", wf.get(True)) or {}
test_on = test_wf.get("on", test_wf.get(True)) or {}
workflow_call = on.get("workflow_call") or {}
secrets = workflow_call.get("secrets") or {}
audit_job = wf["jobs"]["audit-check"]
audit_steps = audit_job["steps"]
mint = step("audit-check", "rubric-token", required=False)
checkout = step("audit-check", "rubric-checkout")


def required(secret_name):
    return (secrets.get(secret_name) or {}).get("required")


def index_by_id(step_id):
    return next((i for i, st in enumerate(audit_steps) if st.get("id") == step_id), -1)


def index_by_name(step_name):
    return next((i for i, st in enumerate(audit_steps) if st.get("name") == step_name), -1)


mint_index = index_by_id("rubric-token")
drop_index = index_by_name("Drop any PR-supplied rubric path")
checkout_index = index_by_id("rubric-checkout")
contract = {
    "app_id_required": required("PALATINE_SKILLS_APP_ID"),
    "private_key_required": required("PALATINE_SKILLS_PRIVATE_KEY"),
    "legacy_token_required": required("RUBRIC_TOKEN"),
    "legacy_token_description": (secrets.get("RUBRIC_TOKEN") or {}).get("description"),
    "audit_env": audit_job.get("env") or {},
    "mint_ordered": (
        min(drop_index, mint_index, checkout_index) >= 0
        and drop_index < mint_index < checkout_index
    ),
    "mint_uses": mint.get("uses"),
    "mint_continue_on_error": mint.get("continue-on-error"),
    "mint_if": mint.get("if"),
    "mint_with": mint.get("with") or {},
    "checkout_continue_on_error": checkout.get("continue-on-error"),
    "checkout_token": (checkout.get("with") or {}).get("token"),
    "test_pull_request_covers_readme": "README.md" in (
        (test_on.get("pull_request") or {}).get("paths") or []
    ),
    "test_push_covers_readme": "README.md" in (
        (test_on.get("push") or {}).get("paths") or []
    ),
}
(out / "contract.json").write_text(json.dumps(contract, sort_keys=True))

workflow_text = workflow_path.read_text()
header_start = workflow_text.index("# Caller template (add to each repo):")
header_end = workflow_text.index("\non:\n", header_start)
(out / "header-caller.txt").write_text(workflow_text[header_start:header_end])

section_start = readme.index("### `agents-md-audit.yml`")
section_end = readme.index("\n### `", section_start + 4)
readme_section = readme[section_start:section_end]
caller_start = readme_section.index("```yaml") + len("```yaml")
caller_end = readme_section.index("```", caller_start)
(out / "readme-section.txt").write_text(readme_section)
(out / "readme-caller.txt").write_text(readme_section[caller_start:caller_end])

print("  extracted: prefilter.sh (%d lines), scope.sh (%d lines), rubric.sh (%d lines), prompt (%d chars)" % (
    len(step_run("pre-filter", "check").splitlines()),
    len(step_run("audit-check", "scope").splitlines()),
    len(step_run("audit-check", "rubric").splitlines()),
    len(step_prompt("audit-check")),
))
PY

# ── Syntax gates ─────────────────────────────────────────────────────────────
section "Syntax checks"
for s in prefilter.sh scope.sh rubric.sh; do
  if bash -n "$EXTRACT/$s" 2>"$WORKDIR/$s.syn"; then
    ok "bash -n $s"
  else
    bad "bash -n $s" "clean parse" "$(cat "$WORKDIR/$s.syn")"
  fi
done

if command -v actionlint >/dev/null 2>&1; then
  if al_out="$(actionlint "$WORKFLOW" 2>&1)"; then
    ok "actionlint: clean"
  else
    bad "actionlint: clean" "exit 0" "$al_out"
  fi
else
  printf '  \033[33mSKIP\033[0m  actionlint not installed\n'
fi

# ── Rubric authentication contract (ENG-7621) ────────────────────────────────
section "Rubric authentication contract"

contractv() {
  python3 - "$EXTRACT/contract.json" "$1" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split('.'):
    if not isinstance(value, dict) or key not in value:
        value = None
        break
    value = value[key]
if isinstance(value, bool):
    print(str(value).lower())
elif value is None:
    print("")
elif isinstance(value, (dict, list)):
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
else:
    print(value)
PY
}

assert_eq "App ID secret is optional in workflow_call schema" "false" "$(contractv app_id_required)"
assert_eq "private key secret is optional in workflow_call schema" "false" "$(contractv private_key_required)"
assert_eq "legacy rubric token remains optional" "false" "$(contractv legacy_token_required)"
assert_contains "legacy rubric token schema is deprecated" "$(contractv legacy_token_description)" "Deprecated"
EXPECTED_AUDIT_ENV="$(cat <<'EOF'
{"PALATINE_APP_ID":"${{ secrets.PALATINE_SKILLS_APP_ID }}","PALATINE_KEY_SET":"${{ secrets.PALATINE_SKILLS_PRIVATE_KEY != '' }}"}
EOF
)"
assert_eq "audit job env contains only safe auth bridge values" \
  "$EXPECTED_AUDIT_ENV" \
  "$(contractv audit_env)"
assert_eq "rubric token mint is between path drop and checkout" "true" "$(contractv mint_ordered)"
assert_eq "rubric token action uses exact v3.2.0 pin" \
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1" \
  "$(contractv mint_uses)"
assert_eq "rubric token mint is fail-open" "true" "$(contractv mint_continue_on_error)"
EXPECTED_MINT_IF="$(cat <<'EOF'
${{ inputs.rubric_repository == 'praetorian-inc/palatine' && env.PALATINE_APP_ID != '' && env.PALATINE_KEY_SET == 'true' }}
EOF
)"
assert_eq "rubric token mint has default-repo and complete-credential gate" \
  "$EXPECTED_MINT_IF" \
  "$(contractv mint_if)"
assert_eq "rubric token app ID input" '${{ secrets.PALATINE_SKILLS_APP_ID }}' "$(contractv mint_with.app-id)"
assert_eq "rubric token private key input" '${{ secrets.PALATINE_SKILLS_PRIVATE_KEY }}' "$(contractv mint_with.private-key)"
assert_eq "rubric token owner scope" "praetorian-inc" "$(contractv mint_with.owner)"
assert_eq "rubric token repository scope" "palatine" "$(contractv mint_with.repositories)"
assert_eq "rubric token contents permission" "read" "$(contractv mint_with.permission-contents)"
EXPECTED_MINT_WITH="$(cat <<'EOF'
{"app-id":"${{ secrets.PALATINE_SKILLS_APP_ID }}","owner":"praetorian-inc","permission-contents":"read","private-key":"${{ secrets.PALATINE_SKILLS_PRIVATE_KEY }}","repositories":"palatine"}
EOF
)"
assert_eq "rubric token mint has no additional inputs or permissions" "$EXPECTED_MINT_WITH" "$(contractv mint_with)"
assert_eq "rubric checkout remains fail-open" "true" "$(contractv checkout_continue_on_error)"
assert_eq "rubric checkout prefers App token then legacy fallback" \
  '${{ steps.rubric-token.outputs.token || secrets.RUBRIC_TOKEN }}' \
  "$(contractv checkout_token)"
assert_eq "test workflow covers README caller changes on pull requests" \
  "true" \
  "$(contractv test_pull_request_covers_readme)"
assert_eq "test workflow covers README caller changes on pushes" \
  "true" \
  "$(contractv test_push_covers_readme)"

RUBRIC_RUN="$(cat "$EXTRACT/rubric.sh")"
assert_contains "rubric notice requests App ID" "$RUBRIC_RUN" "secrets.PALATINE_SKILLS_APP_ID"
assert_contains "rubric notice requests private key" "$RUBRIC_RUN" "secrets.PALATINE_SKILLS_PRIVATE_KEY"
assert_contains "rubric notice marks RUBRIC_TOKEN as temporary legacy fallback" "$RUBRIC_RUN" "temporary legacy fallback"
assert_contains "rubric notice preserves green comment-only skip" "$RUBRIC_RUN" "job stays green"

HEADER_CALLER="$(cat "$EXTRACT/header-caller.txt")"
assert_contains "header caller forwards Anthropic key" "$HEADER_CALLER" 'ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'
assert_contains "header caller forwards App ID" "$HEADER_CALLER" 'PALATINE_SKILLS_APP_ID: ${{ secrets.PALATINE_SKILLS_APP_ID }}'
assert_contains "header caller forwards private key" "$HEADER_CALLER" 'PALATINE_SKILLS_PRIVATE_KEY: ${{ secrets.PALATINE_SKILLS_PRIVATE_KEY }}'
assert_absent "header caller does not forward legacy token" "$HEADER_CALLER" 'RUBRIC_TOKEN:'

README_CALLER="$(cat "$EXTRACT/readme-caller.txt")"
README_SECTION="$(cat "$EXTRACT/readme-section.txt")"
assert_contains "README caller forwards Anthropic key" "$README_CALLER" 'ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'
assert_contains "README caller forwards App ID" "$README_CALLER" 'PALATINE_SKILLS_APP_ID: ${{ secrets.PALATINE_SKILLS_APP_ID }}'
assert_contains "README caller forwards private key" "$README_CALLER" 'PALATINE_SKILLS_PRIVATE_KEY: ${{ secrets.PALATINE_SKILLS_PRIVATE_KEY }}'
assert_absent "README caller does not forward legacy token" "$README_CALLER" 'RUBRIC_TOKEN:'
assert_contains "README documents one-hour token lifetime" "$README_SECTION" "expires after one hour"
assert_contains "README documents token revocation at job end" "$README_SECTION" "revoked by the action at job end"
assert_contains "README documents single-repository token scope" "$README_SECTION" '`praetorian-inc/palatine` only'
assert_contains "README documents contents-read token permission" "$README_SECTION" '`contents: read`'
assert_contains "README documents App-first precedence" "$README_SECTION" "App-first"
assert_contains "README marks legacy token deprecated" "$README_SECTION" "deprecated compatibility only"
assert_contains "README prohibits provisioning a new PAT" "$README_SECTION" "Do not create or distribute a new PAT"
assert_contains "README documents custom-rubric fallback" "$README_SECTION" 'custom `rubric_repository`'
assert_contains "README documents token-mint egress" "$README_SECTION" '`api.github.com:443`'

# ── Prompt contract (ENG-7538 ACs) ───────────────────────────────────────────
section "Prompt contract"
PROMPT="$(cat "$EXTRACT/prompt.txt")"
CLAUDE_ARGS="$(cat "$EXTRACT/claude_args.txt")"
assert_contains "disallowedTools includes Bash(gh api:*)" "$CLAUDE_ARGS" 'Bash(gh api:*)'
# The allowed list must not grant gh api. Match the --allowedTools "..." blob only.
allowed="$(printf '%s' "$CLAUDE_ARGS" | sed -n 's/.*--allowedTools "\([^"]*\)".*/\1/p')"
assert_absent "allowedTools does not include Bash(gh api:*)" "$allowed" 'Bash(gh api:*)'
assert_absent "allowedTools does not include Bash(find:*)" "$allowed" 'Bash(find:*)'
assert_contains "claude_args appends the untrusted-input system prompt" "$CLAUDE_ARGS" '--append-system-prompt'
assert_absent "prompt does not instruct gh api" "$PROMPT" 'gh api'
assert_contains "prompt names MISLEADS" "$PROMPT" "MISLEADS"
assert_contains "prompt names OMITS" "$PROMPT" "OMITS"
assert_contains "prompt names UNENFORCED" "$PROMPT" "UNENFORCED"
assert_contains "prompt names COSTS" "$PROMPT" "COSTS"
assert_contains "prompt names ADVISORY" "$PROMPT" "ADVISORY"
assert_absent "prompt is not drift.yml's 'new features not mentioned' class" "$PROMPT" "new features not mentioned"
assert_contains "prompt loads auditing-agent-instruction-files" "$PROMPT" "_auditing-agent-instruction-files/SKILL.md"
assert_contains "prompt loads creating-agent-instruction-files" "$PROMPT" "_creating-agent-instruction-files/SKILL.md"
assert_absent "prompt does not inline the skill body (predicate heading)" "$PROMPT" "Predicate 1"
assert_absent "prompt does not inline flag-5 lookup" "$PROMPT" "enforcement-existence lookup"
assert_contains "prompt reports COSTS for added inventory (flag 3)" "$PROMPT" "flag 3"
assert_contains "prompt names tech-stack / directory-map" "$PROMPT" "tech-stack"
assert_contains "command-only correction is not that class" "$PROMPT" "still-true command"
assert_contains "grades the file at HEAD" "$PROMPT" "as it stands at HEAD"
assert_contains "does not replace drift.yml" "$PROMPT" "does not replace"
assert_contains "merging stays a human decision" "$PROMPT" "merging stays a human decision"
assert_contains "comment header is Instruction-File Audit" "$PROMPT" "## Instruction-File Audit"

if [ -f "$DRIFT_WORKFLOW" ]; then
  ok "claude-md-drift.yml still present (this job does not replace it)"
else
  bad "claude-md-drift.yml still present" "exists" "missing"
fi

# ── Fixture helpers ──────────────────────────────────────────────────────────
STUB=$'@AGENTS.md\n'

newrepo() {
  local d="$WORKDIR/repo-$1"
  rm -rf -- "$d"
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" config user.email tester@example.invalid
  git -C "$d" config user.name  Tester
  git -C "$d" config commit.gpgsign false
  printf '%s' "$d"
}

put() { # put <repo> <relpath> <content>
  mkdir -p "$(dirname -- "$1/$2")"
  printf '%s' "$3" > "$1/$2"
}

snap() { # snap <repo> <msg> -> prints the commit sha
  git -C "$1" add -A
  git -C "$1" commit -q -m "$2"
  git -C "$1" rev-parse HEAD
}

OUT=""
LOG=""
RC=0

run_prefilter() { # run_prefilter <repo> <base_sha> <head_sha>
  OUT="$WORKDIR/out.$$.$RANDOM"
  LOG="$OUT.log"
  : > "$OUT"
  (
    cd "$1" || exit 1
    GH_TOKEN=dummy \
    BASE_SHA="$2" \
    HEAD_SHA="$3" \
    GITHUB_OUTPUT="$OUT" \
      bash "$EXTRACT/prefilter.sh"
  ) > "$LOG" 2>&1
  RC=$?
}

run_scope() { # run_scope <repo> <base_sha> <head_sha> <pre_filter_result> <relevant_mds>
  OUT="$WORKDIR/out.$$.$RANDOM"
  LOG="$OUT.log"
  : > "$OUT"
  (
    cd "$1" || exit 1
    GH_TOKEN=dummy \
    BASE_SHA="$2" \
    HEAD_SHA="$3" \
    BASE_REF=main \
    PRE_FILTER_RESULT="$4" \
    RELEVANT_MDS="$5" \
    GITHUB_OUTPUT="$OUT" \
      bash "$EXTRACT/scope.sh"
  ) > "$LOG" 2>&1
  RC=$?
}

run_rubric() { # run_rubric <repo> <checkout_outcome>
  OUT="$WORKDIR/out.$$.$RANDOM"
  LOG="$OUT.log"
  : > "$OUT"
  (
    cd "$1" || exit 1
    RUBRIC_CHECKOUT_OUTCOME="$2" \
    GITHUB_OUTPUT="$OUT" \
      bash "$EXTRACT/rubric.sh"
  ) > "$LOG" 2>&1
  RC=$?
}

outv() { # outv <key> — last value written for that GITHUB_OUTPUT key
  grep -E "^$1=" "$OUT" 2>/dev/null | tail -1 | sed "s/^$1=//"
}

# ── Extracted rubric-load gate ───────────────────────────────────────────────
section "Rubric-load gate fixtures"
r="$(newrepo rubric-load)"
run_rubric "$r" failure
assert_eq "rubric checkout failure exits zero" "0" "$RC"
assert_eq "rubric checkout failure emits ok=false" "false" "$(outv ok)"
assert_contains "rubric checkout failure emits skip notice" "$(cat "$LOG")" "Instruction-file audit skipped"
assert_contains "rubric checkout failure explains green outcome" "$(cat "$LOG")" "job stays green"

put "$r" ".instruction-audit-rubric/.agentsmesh/skills/_auditing-agent-instruction-files/SKILL.md" $'# Fixture rubric\n'
run_rubric "$r" success
assert_eq "loaded rubric exits zero" "0" "$RC"
assert_eq "loaded rubric emits ok=true" "true" "$(outv ok)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 1 — PR adds a derivable inventory section to AGENTS.md (should run)"
r="$(newrepo inventory-added)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# Repository Guidelines\n\n## Build\n\nmake test\n'
put "$r" main.go $'package main\n'
base="$(snap "$r" base)"
put "$r" AGENTS.md $'# Repository Guidelines\n\n## Build\n\nmake test\n\n## Tech stack\n\n- Go\n- Postgres\n- Redis\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case1 should_run"   "true"      "$(outv should_run)"
assert_eq "case1 relevant_mds" "AGENTS.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 2 — PR only corrects a still-true command (should still run; class is a prompt contract)"
r="$(newrepo command-fix)"
put "$r" AGENTS.md $'# Repository Guidelines\n\n## Build\n\nmake tes\n'
put "$r" main.go $'package main\n'
base="$(snap "$r" base)"
put "$r" AGENTS.md $'# Repository Guidelines\n\n## Build\n\nmake test\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case2 should_run"   "true"      "$(outv should_run)"
assert_eq "case2 relevant_mds" "AGENTS.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 3 — pointer stub only: not content-carrying, skip"
r="$(newrepo pointer-stub)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" main.go $'package main\n'
base="$(snap "$r" base)"
put "$r" CLAUDE.md $'@AGENTS.md\n\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case3 should_run"   "false" "$(outv should_run)"
assert_eq "case3 relevant_mds" ""      "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 4 — code-only PR: skip (drift.yml's job, not this one)"
r="$(newrepo code-only)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" main.go $'package main\n'
base="$(snap "$r" base)"
put "$r" main.go $'package main\n\nfunc main() {}\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case4 should_run"   "false" "$(outv should_run)"
assert_eq "case4 relevant_mds" ""      "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 5 — unconverted content-carrying CLAUDE.md edit: run"
r="$(newrepo unconverted)"
put "$r" CLAUDE.md $'# root\nroot instructions\n'
put "$r" main.go $'package main\n'
base="$(snap "$r" base)"
put "$r" CLAUDE.md $'# root\nroot instructions\n\n## Tech stack\n\n- Go\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case5 should_run"   "true"       "$(outv should_run)"
assert_eq "case5 relevant_mds" "CLAUDE.md"  "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 6 — nested AGENTS.md edit, sibling stub untouched"
r="$(newrepo nested)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\n'
put "$r" ui/src/components/CLAUDE.md "$STUB"
put "$r" ui/src/components/AGENTS.md $'# components\ncomponent instructions\n'
put "$r" ui/src/components/foo.go $'package components\n'
base="$(snap "$r" base)"
put "$r" ui/src/components/AGENTS.md $'# components\ncomponent instructions\n\n## Structure\n\n- Button\n- Table\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case6 should_run"   "true"                          "$(outv should_run)"
assert_eq "case6 relevant_mds" "ui/src/components/AGENTS.md"   "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 7 — broken pointer (stub, no sibling) edited: conservatively kept"
r="$(newrepo broken-pointer)"
put "$r" lib/CLAUDE.md "$STUB"
put "$r" lib/l.go $'package lib\n'
base="$(snap "$r" base)"
put "$r" lib/CLAUDE.md $'@AGENTS.md\n\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case7 should_run"   "true"            "$(outv should_run)"
assert_eq "case7 relevant_mds" "lib/CLAUDE.md"   "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 8 — pre-filter fail-open: unresolvable base SHA => full inventory"
r="$(newrepo fail-open)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" ui/src/components/CLAUDE.md "$STUB"
put "$r" ui/src/components/AGENTS.md $'# components\ncomponent instructions\n'
put "$r" ui/src/components/foo.go $'package components\n'
base="$(snap "$r" base)"
put "$r" ui/src/components/AGENTS.md $'# components\nedited\n'
head="$(snap "$r" head)"
run_prefilter "$r" "0000000000000000000000000000000000000000" "$head"
assert_eq "case8 should_run"   "true" "$(outv should_run)"
assert_eq "case8 relevant_mds" "AGENTS.md,ui/src/components/AGENTS.md" "$(outv relevant_mds)"
if grep -q "fail-open" "$LOG"; then
  ok "case8 emitted the fail-open warning"
else
  bad "case8 emitted the fail-open warning" "a ::warning ...fail-open..." "$(cat "$LOG")"
fi
: "$base"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 9 — audit-check scope step fail-open => full inventory"
r="$(newrepo scope-fail-open)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" ui/src/components/CLAUDE.md "$STUB"
put "$r" ui/src/components/AGENTS.md $'# components\ncomponent instructions\n'
base="$(snap "$r" base)"
put "$r" AGENTS.md $'# root\nedited\n'
head="$(snap "$r" head)"
run_scope "$r" "$base" "$head" failure ""
assert_eq "case9 scope relevant_mds" "AGENTS.md,ui/src/components/AGENTS.md" "$(outv relevant_mds)"
assert_eq "case9 scope skip"         ""                                      "$(outv skip)"
assert_eq "case9 scope exit code"    "0"                                     "$RC"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 10 — audit-check scope step passes a supplied list straight through"
run_scope "$r" "$base" "$head" success "ui/src/components/AGENTS.md"
assert_eq "case10 scope relevant_mds" "ui/src/components/AGENTS.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 11 — README-only PR: skip"
r="$(newrepo readme-only)"
put "$r" AGENTS.md $'# root\n'
put "$r" README.md $'# readme\n'
base="$(snap "$r" base)"
put "$r" README.md $'# readme\nnew docs\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case11 should_run"   "false" "$(outv should_run)"
assert_eq "case11 relevant_mds" ""      "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 12 — a git branch named CLAUDE.md is not an instruction file"
r="$(newrepo git-branch-named-claude)"
put "$r" AGENTS.md $'# root\n'
put "$r" main.go $'package main\n'
base="$(snap "$r" base)"
git -C "$r" branch CLAUDE.md
put "$r" AGENTS.md $'# root\nedited\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case12 should_run"   "true"      "$(outv should_run)"
assert_eq "case12 relevant_mds" "AGENTS.md" "$(outv relevant_mds)"
run_prefilter "$r" "0000000000000000000000000000000000000000" "$head"
assert_eq "case12 fail-open relevant_mds" "AGENTS.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 13 — AGENTS.md under a directory whose name has spaces"
r="$(newrepo path-with-spaces)"
put "$r" "dir with spaces/AGENTS.md" $'# nested\n'
base="$(snap "$r" base)"
put "$r" "dir with spaces/AGENTS.md" $'# nested\nedited\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case13 should_run"   "true"                      "$(outv should_run)"
assert_eq "case13 relevant_mds" "dir with spaces/AGENTS.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
