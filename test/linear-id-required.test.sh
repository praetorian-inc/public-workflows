#!/usr/bin/env bash
#
# Tests for .github/workflows/linear-id-required.yml, job check, step id: check.
#
# The step passes a pull request whose head branch name or title holds a Linear
# issue id (a team key, a dash and a number, any case, nothing alphanumeric
# touching it), or whose body holds one after a Linear magic word. A bare id in
# the body does not pass. An author listed in EXEMPT_AUTHORS passes with no id.
# A non-pull_request event, an empty team-keys or a key with other characters
# fails.
#
# The step's real `run:` block is EXTRACTED from the workflow YAML at run time,
# never mirrored, and run the way GitHub runs a step with no shell: key
# (`bash -e`, no pipefail) with exactly the variables its env: block declares.
# The team keys are the workflow's own default for that input.
#
# Requires: bash (3.2+), python3 with PyYAML.
#
# Usage: bash test/linear-id-required.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# LINEAR_ID_WORKFLOW points the suite at another copy (used to mutation-test it).
WORKFLOW="${LINEAR_ID_WORKFLOW:-$REPO_ROOT/.github/workflows/linear-id-required.yml}"

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

# ── Static contract: extract the real step ───────────────────────────────────
section "Static contract — the step the cases run"

python3 - "$WORKFLOW" "$WORKDIR" > "$WORKDIR/static.tsv" <<'PY' || { echo "ERROR: static extraction failed" >&2; exit 1; }
import pathlib
import sys

import yaml

wf = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
out = pathlib.Path(sys.argv[2])


def check(name, cond, expected="", actual=""):
    if cond:
        print("PASS\t%s" % name)
    else:
        print("FAIL\t%s\t%s\t%s" % (name, expected, str(actual).replace("\n", " ")))


# PyYAML reads the bare `on:` key as the boolean True.
trigger = wf.get("on", wf.get(True)) or {}
inputs = (trigger.get("workflow_call") or {}).get("inputs") or {}
job = (wf.get("jobs") or {}).get("check") or {}
step = next((s for s in job.get("steps") or [] if s.get("id") == "check"), None)
check("job check has the step id: check", step is not None, "a step with id: check", "none")
if step is None:
    sys.exit(0)

body = step.get("run") or ""
check("step is a plain run: step (no uses:)", bool(body) and "uses" not in step, "run only", step.get("uses"))
check("run: body has no ${{ }} expressions (values arrive via env:)", "${{" not in body, "none", "contains ${{")
shells = [s for s in (
    step.get("shell"),
    ((job.get("defaults") or {}).get("run") or {}).get("shell"),
    ((wf.get("defaults") or {}).get("run") or {}).get("shell"),
) if s]
check("step runs in the default shell (bash -e, no pipefail)", not shells, "no shell: override", shells)
perms = job.get("permissions")
check("job asks for contents: read and nothing else", perms == {"contents": "read"}, "{'contents': 'read'}", perms)

env = step.get("env") or {}
want = {
    "EVENT_NAME": "${{ github.event_name }}",
    "BRANCH": "${{ github.event.pull_request.head.ref }}",
    "TITLE": "${{ github.event.pull_request.title }}",
    "BODY": "${{ github.event.pull_request.body }}",
    "AUTHOR": "${{ github.event.pull_request.user.login }}",
    "TEAM_KEYS": "${{ inputs.team-keys }}",
    "EXEMPT_AUTHORS": "${{ inputs.exempt-authors }}",
}
check("env: maps exactly the pull request fields and inputs the cases set", env == want, want, env)

keys = (inputs.get("team-keys") or {}).get("default") or ""
check("team-keys has a default", bool(keys.strip()), "non-empty", keys)
exempt = (inputs.get("exempt-authors") or {}).get("default") or ""
check("exempt-authors defaults to dependabot[bot]", exempt == "dependabot[bot]", "dependabot[bot]", exempt)

(out / "check.sh").write_text(body)
(out / "team-keys.txt").write_text(keys)
PY

while IFS=$'\t' read -r verdict name exp act; do
  if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
done < "$WORKDIR/static.tsv"

if [ ! -s "$WORKDIR/check.sh" ]; then
  printf '\n  passed: %d   failed: %d  (step missing — behavioural cases not run)\n' "$PASS" "$((FAIL + 1))"
  exit 1
fi

section "Syntax checks"
if bash -n "$WORKDIR/check.sh" 2>"$WORKDIR/check.syn"; then
  ok "bash -n check.sh"
else
  bad "bash -n check.sh" "clean parse" "$(cat "$WORKDIR/check.syn")"
fi

DEFAULT_KEYS="$(cat "$WORKDIR/team-keys.txt")"

# run_step <branch> <title> <body> [author] [event] [team-keys]
# Runs the extracted step with only its env: names set; leaves the exit status
# in RC and stdout+stderr in OUT.
run_step() {
  OUT="$(
    cd "$WORKDIR" && env -i PATH="$PATH" \
      EVENT_NAME="${5:-pull_request}" \
      BRANCH="$1" TITLE="$2" BODY="$3" \
      AUTHOR="${4:-octocat}" \
      TEAM_KEYS="${6-$DEFAULT_KEYS}" \
      EXEMPT_AUTHORS="dependabot[bot]" \
      bash -e "$WORKDIR/check.sh" 2>&1
  )"
  RC=$?
}

expect_pass() { # expect_pass <name> <where> <id> <run_step args...>
  local name="$1" where="$2" id="$3"
  shift 3
  run_step "$@"
  local want="Linear issue named in the ${where}: ${id}"
  if [ "$RC" -eq 0 ] && [ "$OUT" = "$want" ]; then
    ok "$name"
  else
    bad "$name" "rc=0, $want" "rc=$RC, $OUT"
  fi
}

expect_fail() { # expect_fail <name> <run_step args...>
  local name="$1"
  shift
  run_step "$@"
  if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q '^::error title=No Linear issue named::'; then
    ok "$name"
  else
    bad "$name" "rc!=0 and the no-issue error" "rc=$RC, $(printf '%s' "$OUT" | head -n1)"
  fi
}

# ── Passing pull requests ────────────────────────────────────────────────────
section "An id in the branch name or title passes"
expect_pass "Linear's branch format"            "branch name" "lab-4594" "nathansportsman/lab-4594-require-a-linear" "Require an id" ""
expect_pass "lowercase id in a branch"          "branch name" "eng-1234" "fix/eng-1234-thing" "x" ""
expect_pass "uppercase id at the branch start"  "branch name" "ENG-1234" "ENG-1234" "x" ""
expect_pass "digit-leading key 13T"             "branch name" "13t-202"  "feat/13t-202-crawl" "x" ""
expect_pass "id after an underscore"            "branch name" "eng-5"    "feat_eng-5_thing" "x" ""
expect_pass "id in the title"                   "title"       "ENG-1234" "luigi/fix-waf-flags" "ENG-1234: fix the WAF flags" ""
expect_pass "lowercase id in the title"         "title"       "eng-77"   "x" "fix(ui): row height (eng-77)" ""
expect_pass "branch wins over title and body"   "branch name" "lab-1"    "lab-1-x" "ENG-2: y" "Fixes SAL-3"

section "An id after a magic word in the body passes"
expect_pass "Fixes ENG-1234"                    "body" "Fixes ENG-1234"  "x" "y" "## Summary"$'\n'"Fixes ENG-1234"
expect_pass "lowercase magic word and id"       "body" "closes eng-9"    "x" "y" "closes eng-9"
expect_pass "Part of 13T-5"                     "body" "Part of 13T-5"   "x" "y" "- Part of 13T-5"
expect_pass "Related to across two spaces"      "body" "Related  to ENG-8" "x" "y" "Related  to ENG-8."
expect_pass "magic word and a colon"            "body" "Resolves: ENG-4" "x" "y" "Resolves: ENG-4"
expect_pass "Markdown link after the word"      "body" "Closes [ENG-11"  "x" "y" "Closes [ENG-11](https://linear.app/praetorianlabs/issue/ENG-11)"
expect_pass "issue URL after the word"          "body" "Fixes https://linear.app/praetorianlabs/issue/ENG-123" \
  "x" "y" "Fixes https://linear.app/praetorianlabs/issue/ENG-123/some-title"
expect_pass "CRLF line endings"                 "body" "Refs LAB-7"      "x" "y" "Summary"$'\r\n'"Refs LAB-7"$'\r\n'
expect_pass "first of two ids"                  "body" "Fixes ENG-1"     "x" "y" "Fixes ENG-1"$'\n'"Closes ENG-2"

# Every magic word in https://linear.app/docs/github, typed here rather than
# read from the workflow, so dropping one from the step fails its case.
for word in close closes closed closing fix fixes fixed fixing \
            resolve resolves resolved resolving complete completes completed completing \
            implement implements implemented implementing "linear issue" \
            ref refs references "part of" "contributes to" toward towards \
            "relates to" "related to"; do
  expect_pass "magic word: $word"               "body" "$word ENG-1"     "x" "y" "$word ENG-1"
done

section "An exempt author passes with no id"
# Unquoted, dependabot[bot] would glob to this file without the step's set -f.
: > "$WORKDIR/dependabotb"
run_step "dependabot/npm_and_yarn/ui/vite-6.4.1" "Bump vite" "" "dependabot[bot]"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q 'needs no Linear issue'; then
  ok "dependabot[bot]"
else
  bad "dependabot[bot]" "rc=0 and the exempt line" "rc=$RC, $OUT"
fi
expect_fail "a human login that only looks like dependabot" "dependabot/x" "Bump vite" "" "dependabot"

# ── Failing pull requests ────────────────────────────────────────────────────
section "No id, or a string that only looks like one, fails"
expect_fail "nothing anywhere"                  "perf/remove-unused-asset-sort-indexes" "Remove unused indexes" "Speeds up writes."
expect_fail "cve-119618 is not a team key"      "fix/cve-119618" "Patch cve-119618" ""
expect_fail "east-2 is not a team key"          "deploy/us-east-2" "Move to us-east-2" ""
expect_fail "loop-18 is not a team key"         "ralph/loop-18" "loop-18" ""
expect_fail "a key glued to letters before it"  "feat/xeng-12" "x" ""
expect_fail "a number glued to letters after it" "feat/eng-12a" "x" ""
expect_fail "a key with no number"              "feat/eng-thing" "ENG-" ""
expect_fail "bare id in the body"               "x" "y" "Related: [ENG-4049](https://linear.app/praetorianlabs/issue/ENG-4049)"
expect_fail "bare id in a body list item"       "x" "y" "- Follow-up to #10316 (ENG-11215 and ENG-11213)."
expect_fail "magic word glued to letters"       "x" "y" "prefixes ENG-1"
expect_fail "magic word and an id glued to letters" "x" "y" "Fixes ENG-12a"
expect_fail "magic word on the line before"     "x" "y" "Fixes"$'\n'"ENG-1"
expect_fail "magic word and a non-key id"       "x" "y" "Fixes CVE-2024-1234"

section "The failure message says how to name the issue"
run_step "x" "y" ""
for want in "Branch name" "yourname/eng-1234-short-description" "Copy git branch name" \
            "Title" "ENG-1234: Fix the export button" \
            "Body" "Fixes ENG-1234" "A bare id in the body is not enough" \
            "Editing the title or the body runs this check again." "13T"; do
  if printf '%s' "$OUT" | grep -qF -- "$want"; then
    ok "message names: $want"
  else
    bad "message names: $want" "$want" "$(printf '%s' "$OUT" | tr '\n' ' ')"
  fi
done

# ── Inputs and events ────────────────────────────────────────────────────────
section "team-keys and the event are checked"
expect_pass "a caller's own team-keys"          "branch name" "abc-1" "abc-1-x" "y" "" "octocat" "pull_request" "ABC"
expect_fail "a default key outside a caller's team-keys" "eng-1-x" "y" "" "octocat" "pull_request" "ABC"
expect_pass "newline-separated team-keys"       "branch name" "def-2" "def-2" "y" "" "octocat" "pull_request" "ABC"$'\n'"DEF"
expect_pass "pull_request_target is read too"   "branch name" "eng-3" "eng-3" "y" "" "octocat" "pull_request_target"

run_step "eng-1" "y" "" "octocat" "push"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q 'Call linear-id-required.yml from a pull_request trigger'; then
  ok "a push event fails with the trigger error"
else
  bad "a push event fails with the trigger error" "rc!=0 and the trigger error" "rc=$RC, $OUT"
fi

run_step "eng-1" "y" "" "octocat" "pull_request" "EN.G"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q "team-keys holds 'EN.G'"; then
  ok "a team key with a dot fails"
else
  bad "a team key with a dot fails" "rc!=0 and the team-keys error" "rc=$RC, $OUT"
fi

run_step "eng-1" "y" "" "octocat" "pull_request" ""
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q 'team-keys is empty'; then
  ok "empty team-keys fails"
else
  bad "empty team-keys fails" "rc!=0 and the empty error" "rc=$RC, $OUT"
fi

printf '\n  passed: %d   failed: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
