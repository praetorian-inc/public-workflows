#!/usr/bin/env bash
#
# Contract checks for the Gemini reviewer graphify shell allowlist (ENG-7654).
# Greps gemini-code.yml — no network, no Gemini CLI.
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="$REPO_ROOT/.github/workflows/gemini-code.yml"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

if [ ! -f "$WF" ]; then
  echo "ERROR: missing $WF" >&2
  exit 1
fi

echo "gemini-graphify-tools.test.sh"

# Extract the tools.core JSON array (single line in settings).
CORE="$(grep -oE '"core": \[[^]]+\]' "$WF" | head -1 || true)"
if [ -z "$CORE" ]; then
  bad "tools.core present" "no \"core\": [...] in $WF"
else
  ok "tools.core present"
fi

for prefix in "graphify query" "graphify explain" "graphify path"; do
  needle="run_shell_command(${prefix})"
  if grep -F -q "$needle" <<<"$CORE"; then
    ok "core lists $needle"
  else
    bad "core lists $needle" "core=$CORE"
  fi
done

# Bare wildcard must not appear inside the core array.
if grep -E -q '"run_shell_command"' <<<"$CORE"; then
  bad "core has no bare run_shell_command" "core=$CORE"
else
  ok "core has no bare run_shell_command"
fi

if grep -q 'grep_search' <<<"$CORE"; then
  ok "core keeps grep_search"
else
  bad "core keeps grep_search" "core=$CORE"
fi

EXCLUDE="$(grep -oE '"exclude": \[[^]]+\]' "$WF" | head -1 || true)"
if grep -E -q '"run_shell_command"' <<<"$EXCLUDE"; then
  bad "exclude has no run_shell_command wildcard" "exclude=$EXCLUDE"
else
  ok "exclude has no run_shell_command wildcard"
fi

if grep -q 'job: fetch-graph' "$WF" || grep -q '^  fetch-graph:' "$WF"; then
  ok "fetch-graph job exists"
else
  bad "fetch-graph job exists" "no fetch-graph: job in $WF"
fi

if grep -q 'Neutralize PR-planted graphify-out' "$WF"; then
  ok "neutralize planted graphify-out"
else
  bad "neutralize planted graphify-out" "step missing"
fi

if grep -q 'graphifyy==' "$WF"; then
  ok "pinned graphifyy install"
else
  bad "pinned graphifyy install" "no graphifyy== pin"
fi

# Gemini redacts env vars from run_shell_command children unless allowed; the
# query log only reaches graphify when both GRAPHIFY_QUERY_LOG vars pass.
ALLOWED="$(grep -oE '"environmentVariableRedaction": \{ "allowed": \[[^]]*\]' "$WF" | head -1 || true)"
for var in GRAPHIFY_QUERY_LOG GRAPHIFY_QUERY_LOG_ENABLE; do
  if grep -F -q "\"$var\"" <<<"$ALLOWED"; then
    ok "redaction allowlist passes $var"
  else
    bad "redaction allowlist passes $var" "allowed=$ALLOWED"
  fi
done

run_step="$(awk '/- name: Run Gemini PR Review/ { on=1; print; next } on && /- name: / { exit } on { print }' "$WF")"
if grep -F -q 'FORMAT=querylog' <<<"$run_step" &&
   grep -F -q '[ -s graphify-out/graph.json ]' <<<"$run_step"; then
  ok "querylog gate runs when the graph is present"
else
  bad "querylog gate runs when the graph is present" "no FORMAT=querylog gate keyed on graphify-out/graph.json"
fi

# ENG-8892: the gate applies the warranted rule to the pre-agent list copies.
# shellcheck disable=SC2016  # literal workflow text, not an expansion
if grep -F 'REQUIRED=true FORMAT=querylog' <<<"$run_step" | grep -F -q 'CHANGED_FILES="$RUNNER_TEMP/graphify-changed-files.txt" ADDED_FILES="$RUNNER_TEMP/graphify-added-files.txt"'; then
  ok "querylog gate passes the changed and added lists"
else
  bad "querylog gate passes the changed and added lists" "gate does not pass CHANGED_FILES/ADDED_FILES"
fi

if printf '%s\n' "$run_step" | awk '
  /DECIDE_ONLY=true/ { decide = NR }
  /gemini --yolo/ { run = NR }
  END { exit(decide && run && decide < run ? 0 : 1) }'; then
  ok "graphify decision is made before the review"
else
  bad "graphify decision is made before the review" "no DECIDE_ONLY=true before the gemini invocation"
fi

# shellcheck disable=SC2016  # literal workflow text, not an expansion
if grep -F -q 'Your FIRST tool call must be a `graphify query`' <<<"$run_step" &&
   ! grep -F -q 'You must run at least one graphify query before findings.' <<<"$run_step"; then
  ok "prompt requires graphify as the first tool call when warranted"
else
  bad "prompt requires graphify as the first tool call when warranted" "GRAPHIFY FIRST block missing or old must-run sentence still present"
fi

# Run the workflow's own GRAPHIFY FIRST block (dedented out of the YAML run
# script) for both branches: graphed files listed, and none listed.
graphify_first_block() {
  printf '%s\n' "$run_step" | awk '
    /if \[ "\$graphify_required" = "true" \]; then/ { on=1 }
    on && /elif \[ -s graphify-out\/graph.json \]; then/ { print "          fi"; exit }
    on { print }' | sed 's/^          //'
}
GF_TMP="$(mktemp -d "${TMPDIR:-/tmp}/gemini-graphify.XXXXXX")" || { echo "ERROR: mktemp failed" >&2; exit 2; }
trap 'GF_TMP="${GF_TMP:-}"; case "${GF_TMP##*/}" in gemini-graphify.?*) rm -rf -- "$GF_TMP" ;; esac' EXIT
graphify_first_block > "$GF_TMP/block.sh"
printf 'pkg/a.go\n' > "$GF_TMP/listed.txt"
: > "$GF_TMP/none.txt"
listed_out="$(graphify_required=true GRAPHED="$GF_TMP/listed.txt" bash "$GF_TMP/block.sh" 2>&1 | tr -s ' \n' '  ')"
none_out="$(graphify_required=true GRAPHED="$GF_TMP/none.txt" bash "$GF_TMP/block.sh" 2>&1 | tr -s ' \n' '  ')"

# shellcheck disable=SC2016  # literal prompt text, not an expansion
if grep -F -q 'a `graphify query` about a symbol in one of the changed files listed below' <<<"$listed_out" &&
   grep -F -q -- '- pkg/a.go' <<<"$listed_out"; then
  ok "listed branch asks for a symbol in a listed graphed file"
else
  bad "listed branch asks for a symbol in a listed graphed file" "got: $listed_out"
fi

# With no graphed file listed, Gemini cannot name a symbol before reading the
# diff, so any graphify query about the existing code must satisfy the gate.
# shellcheck disable=SC2016  # literal prompt text, not an expansion
if grep -F -q 'any `graphify query` about the existing code satisfies this' <<<"$none_out" &&
   grep -F -q 'Your FIRST tool call must be a `graphify query`' <<<"$none_out" &&
   ! grep -F -q 'listed below' <<<"$none_out" &&
   ! grep -F -q 'a symbol the new code calls' <<<"$none_out" &&
   ! grep -E -i -q 'overrides?|ignore (any|all )?other' <<<"$none_out"; then
  ok "none-listed branch accepts any graphify query about the existing code"
else
  bad "none-listed branch accepts any graphify query about the existing code" "got: $none_out"
fi

# Added paths are PR-chosen text; the prompt block never prints them. Run
# both branches with a canary added path reachable every way the block could
# read one: the RUNNER_TEMP list (NUL-delimited, as the workflow writes it),
# the ADDED_FILES/ADDED_LIST variables, and a stub git on PATH that answers
# any `git diff` with it. The canary must not appear in the prompt text.
CANARY='canary-added-7f3e/evil.go'
mkdir -p "$GF_TMP/rt" "$GF_TMP/bin"
printf '%s\0' "$CANARY" > "$GF_TMP/rt/graphify-added-files.txt"
printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "$CANARY" > "$GF_TMP/bin/git"
chmod +x "$GF_TMP/bin/git"
for branch in listed none; do
  canary_out="$(PATH="$GF_TMP/bin:$PATH" RUNNER_TEMP="$GF_TMP/rt" \
    ADDED_FILES="$GF_TMP/rt/graphify-added-files.txt" ADDED_LIST="$CANARY" \
    graphify_required=true GRAPHED="$GF_TMP/$branch.txt" bash "$GF_TMP/block.sh" 2>&1)"
  if [ -n "$canary_out" ] && ! grep -F -q "$CANARY" <<<"$canary_out"; then
    ok "$branch branch prints no added path"
  else
    bad "$branch branch prints no added path" "got: $canary_out"
  fi
done

if ! grep -F -q 'added-files' "$GF_TMP/block.sh"; then
  ok "GRAPHIFY FIRST block prints no added path"
else
  bad "GRAPHIFY FIRST block prints no added path" "block reads the added-files list"
fi

# Override phrasing reads as prompt injection to other reviewers, so the
# default prompt orders graphify before the diff in place instead.
if ! grep -E -i -q 'overrides? any other instruction|ignore (any|all )?other instructions' "$WF" &&
   tr -s ' \n' '  ' < "$WF" | grep -F -q 'when the instructions above say GRAPHIFY FIRST, run that graphify query before reading the diff'; then
  ok "default prompt orders graphify first without override phrasing"
else
  bad "default prompt orders graphify first without override phrasing" "override phrasing present, or default prompt lacks the GRAPHIFY FIRST ordering"
fi

# shellcheck disable=SC2016  # literal workflow text, not an expansion
if grep -F -q 'echo "graphify=unused" >> "$GITHUB_OUTPUT"' <<<"$run_step" &&
   grep -F -q 'echo "graphify=unreadable" >> "$GITHUB_OUTPUT"' <<<"$run_step"; then
  ok "gate records why it failed"
else
  bad "gate records why it failed" "no graphify=unused / graphify=unreadable step output"
fi

failclass="$(awk '/- name: Classify Gemini failure/ { on=1; print; next } on && /- name: / { exit } on { print }' "$WF")"
if grep -F -q 'steps.gemini.outputs.graphify' <<<"$failclass" &&
   grep -F -q 'kind=graphify_unused' <<<"$failclass" &&
   grep -F -q 'kind=graphify_unreadable' <<<"$failclass"; then
  ok "failclass maps the gate reason to graphify kinds"
else
  bad "failclass maps the gate reason to graphify kinds" "no graphify_unused / graphify_unreadable kinds"
fi

# ENG-8892: the pre-review decision must surface a checker error. Run the
# workflow's own decision block against a stub checker that exits 2: the
# step must print the ::error:: line, record graphify=unreadable, and fail
# with the checker's status (AC4), not die silently under set -e.
decide_block="$(printf '%s\n' "$run_step" | awk '
  /graphify_required=false/ { on=1 }
  on { print }
  on && /^          fi$/ { exit }' | sed 's/^          //')"
DT="$(mktemp -d "${TMPDIR:-/tmp}/gemini-decide.XXXXXX")" || { echo "ERROR: mktemp failed" >&2; exit 2; }
# One EXIT trap for both temp dirs: a second `trap ... EXIT` replaces the first.
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup_tmp() {
  local d
  for d in "${GF_TMP:-}" "${DT:-}"; do
    case "${d##*/}" in gemini-graphify.?*|gemini-decide.?*) rm -rf -- "$d" ;; esac
  done
}
trap cleanup_tmp EXIT
mkdir -p "$DT/ws/graphify-out" "$DT/rt"
printf '{"nodes":[]}\n' > "$DT/ws/graphify-out/graph.json"
for stub_rc in 2 1; do
  printf '#!/usr/bin/env bash\necho "::error::stub cannot evaluate"\nexit %s\n' "$stub_rc" > "$DT/rt/check-graphify-use.sh"
  : > "$DT/out"
  dout="$(cd -- "$DT/ws" && RUNNER_TEMP="$DT/rt" GITHUB_OUTPUT="$DT/out" bash -euo pipefail -c "$decide_block" 2>&1)"
  drc=$?
  if [ -n "$decide_block" ] && [ "$drc" -eq "$stub_rc" ] &&
     [[ "$dout" == *"::error::stub cannot evaluate"* ]] &&
     grep -F -x -q 'graphify=unreadable' "$DT/out"; then
    ok "pre-review decision surfaces checker exit $stub_rc as graphify=unreadable"
  else
    bad "pre-review decision surfaces checker exit $stub_rc as graphify=unreadable" "rc=$drc out=[$dout] GITHUB_OUTPUT=[$(cat "$DT/out")]"
  fi
done
printf '#!/usr/bin/env bash\necho "graphify required: 1 changed file(s) in the graph, 0 new code file(s)"\necho "required=true"\n' > "$DT/rt/check-graphify-use.sh"
: > "$DT/out"
dout="$(cd -- "$DT/ws" && RUNNER_TEMP="$DT/rt" GITHUB_OUTPUT="$DT/out" bash -euo pipefail -c "$decide_block"$'\necho "graphify_required=$graphify_required"' 2>&1)"
drc=$?
if [ "$drc" -eq 0 ] && [[ "$dout" == *"graphify_required=true"* ]] && [ ! -s "$DT/out" ]; then
  ok "pre-review decision still sets graphify_required on success"
else
  bad "pre-review decision still sets graphify_required on success" "rc=$drc out=[$dout]"
fi

notice="$(awk '/- name: Post failure notice/ { on=1; print; next } on && /- name: / { exit } on { print }' "$WF")"
if grep -F 'graphify_unused:' <<<"$notice" | grep -F -q 'graphify not used' &&
   grep -F 'graphify_unreadable:' <<<"$notice" | grep -F -q 'graphify query log unreadable'; then
  ok "failure notice names the graphify reason"
else
  bad "failure notice names the graphify reason" "notice lacks the graphify not used / query log unreadable texts"
fi

# Install-failure path must drop the restored graph so the prompt cannot
# send the agent at a missing binary (ENG-7654 / CodeRabbit).
if awk '
  /Install graphify CLI \(pinned, fail-open\)/ { in_step=1 }
  in_step && /name: Build review context/ { exit }
  in_step && /graphify CLI install failed/ { saw_warn=1 }
  in_step && saw_warn && /rm -rf graphify-out/ { found=1 }
  END { exit(found ? 0 : 1) }
' "$WF"; then
  ok "install-failure removes graphify-out"
else
  bad "install-failure removes graphify-out" "else branch has warning but no rm -rf graphify-out"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
