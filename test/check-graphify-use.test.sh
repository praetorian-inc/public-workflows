#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO_ROOT/.github/actions/stage-review-skills/check-graphify-use.sh"
PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

T="$(mktemp -d "${TMPDIR:-/tmp}/graphify-use.XXXXXX")"
trap 'rm -rf "$T"' EXIT
T="$(cd -- "$T" && pwd -P)"

# expect <pass|fail> <name> <reason> [stderr-substring] -- <env...>
# Runs the checker with the given env assignments and checks the exit status.
# A stderr substring, when given, must appear in the checker's output.
expect() {
  local want="$1" name="$2" reason="$3" needle="$4"
  shift 5
  local out rc
  out="$(cd -- "$T/ws" && env "$@" bash "$SCRIPT" 2>&1)"
  rc=$?
  if [ "$want" = pass ] && [ "$rc" -ne 0 ]; then
    bad "$name" "$reason (exit $rc: $out)"
  elif [ "$want" = fail ] && [ "$rc" -eq 0 ]; then
    bad "$name" "$reason"
  elif [ -n "$needle" ] && [[ "$out" != *"$needle"* ]]; then
    bad "$name" "output lacks '$needle': $out"
  else
    ok "$name"
  fi
}

mkdir -p "$T/ws/graphify-out" "$T/other"
printf '{"nodes":[]}\n' > "$T/ws/graphify-out/graph.json"
printf '{"nodes":[]}\n' > "$T/other/graph.json"
GRAPH="$T/ws/graphify-out/graph.json"
LOG="$T/queries.jsonl"

# ---- querylog (Claude, Gemini) ----
record() { printf '{"ts":"2026-10-05T00:00:00+00:00","kind":"query","question":"callers","corpus":"%s","nodes_returned":3}\n' "$1"; }

record "$GRAPH" > "$LOG"
expect pass "querylog record for the workspace graph counts" "gate rejected a real query" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

ln -s "$T/ws/graphify-out" "$T/link"
record "$T/link/graph.json" > "$LOG"
expect pass "querylog corpus is compared by realpath" "gate rejected a symlinked path to the same graph" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

record "$T/other/graph.json" > "$LOG"
expect fail "querylog record for another graph is rejected" "gate accepted a different corpus" "no graphify query" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

: > "$LOG"
expect fail "empty querylog is rejected" "gate accepted an empty log" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

rm -f "$LOG"
expect fail "missing querylog is rejected" "gate accepted a missing log" "query log is missing" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

{ printf '{"kind":"query","corpus":"%s"\n' "$GRAPH"; printf 'not json\n'; printf '["%s"]\n' "$GRAPH"; } > "$LOG"
expect fail "malformed querylog lines are rejected" "gate accepted a truncated or non-object record" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

{ printf 'not json\n'; record "$GRAPH"; } > "$LOG"
expect pass "a malformed line does not hide a valid record" "gate rejected a valid record after a bad line" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

rm -f "$LOG"
expect pass "not required skips a missing querylog" "gate failed with REQUIRED=false" "" -- \
  REQUIRED=false FORMAT=querylog QUERY_LOG="$LOG"

mv "$GRAPH" "$GRAPH.bak"
expect pass "querylog skips when no graph is on disk" "gate failed with no graph" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"
: > "$GRAPH"
expect pass "querylog skips when the graph is empty" "gate failed with an empty graph" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"
mv "$GRAPH.bak" "$GRAPH"

# ---- codex (rollout JSONL, response_item function_call + output) ----
CX="$T/codex"
call() { # call <call_id> <tool> <arguments-json>
  python3 -c 'import json,sys; print(json.dumps({"timestamp":"t","type":"response_item","payload":{"type":"function_call","name":sys.argv[2],"arguments":sys.argv[3],"call_id":sys.argv[1]}}))' "$@"
}
out() { # out <call_id> <output-text>
  python3 -c 'import json,sys; print(json.dumps({"timestamp":"t","type":"response_item","payload":{"type":"function_call_output","call_id":sys.argv[1],"output":sys.argv[2]}}))' "$@"
}
codex_case() { # codex_case <pass|fail> <name> <reason> <needle> <jsonl...>
  local want="$1" name="$2" reason="$3" needle="$4"
  shift 4
  rm -rf "$CX"
  mkdir -p "$CX/2026/10/05"
  printf '%s\n' "$@" > "$CX/2026/10/05/rollout.jsonl"
  find "$CX" -type f -print > "$CX/session-files.txt"
  expect "$want" "$name" "$reason" "$needle" -- REQUIRED=true FORMAT=codex TRACE="$CX"
}
EXITED0=$'Chunk ID: a1\nWall time: 0.4 seconds\nProcess exited with code 0\nOutput:\n3 nodes found'
EXITED1=$'Chunk ID: a1\nWall time: 0.4 seconds\nProcess exited with code 1\nOutput:\nerror'

codex_case pass "codex exec_command with exit 0 counts" "gate rejected a successful graphify call" "" \
  "$(call c1 exec_command '{"cmd":"graphify query \"callers of dispatch\""}')" "$(out c1 "$EXITED0")"

codex_case pass "codex shell_command with Exit code: 0 counts" "gate rejected the shell_command output shape" "" \
  "$(call c1 shell_command '{"command":"graphify explain dispatch"}')" "$(out c1 $'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nok')"

codex_case pass "codex bash -lc wrapper counts" "gate rejected bash -lc graphify" "" \
  "$(call c1 exec_command '{"cmd":"bash -lc \"graphify path A B\""}')" "$(out c1 "$EXITED0")"

codex_case pass "codex long-running call finished by write_stdin counts" "gate rejected a session that exited 0" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" \
  "$(out c1 $'Chunk ID: a1\nWall time: 10.0 seconds\nProcess running with session ID 7\nOutput:\n')" \
  "$(call c2 write_stdin '{"session_id":7,"chars":""}')" "$(out c2 "$EXITED0")"

codex_case fail "codex nonzero exit is rejected" "gate accepted a failed graphify call" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" "$(out c1 "$EXITED1")"

codex_case fail "codex call with no output is rejected" "gate accepted a call that never returned" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')"

codex_case fail "codex exit code inside Output is not trusted" "gate read the exit code from command output" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" \
  "$(out c1 $'Wall time: 0.4 seconds\nProcess exited with code 1\nOutput:\nProcess exited with code 0')"

codex_case pass "codex graphify with 2>&1 counts" "gate read a redirection as a control operator" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers 2>&1"}')" "$(out c1 "$EXITED0")"

codex_case pass "codex graphify with a trailing newline counts" "gate rejected trailing whitespace" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers\n"}')" "$(out c1 "$EXITED0")"

codex_case pass "codex quoted operators inside the question count" "gate split on a quoted operator" "" \
  "$(call c1 exec_command '{"cmd":"graphify query \"a; b && c | d\""}')" "$(out c1 "$EXITED0")"

codex_case fail "codex path-qualified ./graphify is rejected" "gate accepted a PR-committed graphify executable" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"./graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex PATH= prefix is rejected" "gate accepted a PATH override to a planted graphify" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"PATH=.:/usr/bin graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex GRAPHIFY_OUT= prefix is rejected" "gate accepted a redirected graph" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"GRAPHIFY_OUT=sub/graphify-out graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex path-qualified ./bash -lc wrapper is rejected" "gate accepted a PR-committed shell" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"./bash -lc \"graphify query callers\""}')" "$(out c1 "$EXITED0")"

codex_case fail "codex --graph override is rejected" "gate accepted a query against a planted graph" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers --graph sub/planted.json"}')" "$(out c1 "$EXITED0")"

codex_case pass "codex /bin/bash -lc wrapper counts" "gate rejected the system shell" "" \
  "$(call c1 exec_command '{"cmd":"/bin/bash -lc \"graphify query callers\""}')" "$(out c1 "$EXITED0")"

codex_case fail "codex write_stdin finish with nonzero exit is rejected" "gate accepted a session that exited 1" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" \
  "$(out c1 $'Chunk ID: a1\nWall time: 10.0 seconds\nProcess running with session ID 7\nOutput:\n')" \
  "$(call c2 write_stdin '{"session_id":7,"chars":""}')" "$(out c2 "$EXITED1")"

codex_case fail "codex write_stdin to another session is rejected" "gate credited an unrelated session's exit" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" \
  "$(out c1 $'Chunk ID: a1\nWall time: 10.0 seconds\nProcess running with session ID 7\nOutput:\n')" \
  "$(call c2 write_stdin '{"session_id":8,"chars":""}')" "$(out c2 "$EXITED0")"

codex_case fail "codex shell_command exit code inside Output is not trusted" "gate read Exit code: from command output" "" \
  "$(call c1 shell_command '{"command":"graphify query callers"}')" \
  "$(out c1 $'Exit code: 1\nWall time: 0.2 seconds\nOutput:\nExit code: 0')"

codex_case fail "codex true || graphify is rejected" "gate accepted a graphify call that never runs" "" \
  "$(call c1 exec_command '{"cmd":"true || graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex test && graphify is rejected" "gate accepted a chained graphify call" "" \
  "$(call c1 exec_command '{"cmd":"test -f graphify-out/graph.json && graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex graphify; true is rejected" "gate tied a later command's exit to graphify" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers; true"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex graphify | head is rejected" "gate tied a pipe's exit to graphify" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers | head"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex echo graphify is rejected" "gate accepted echo" "" \
  "$(call c1 exec_command '{"cmd":"echo graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex non-function_call with arguments is rejected" "gate accepted a custom_tool_call / event field" "" \
  '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec_command","call_id":"c1","input":"x","arguments":"{\"cmd\":\"graphify query callers\"}"}}' \
  '{"type":"event_msg","payload":{"type":"exec_command_end","command":["graphify","query","callers"],"exit_code":0}}' \
  "$(out c1 "$EXITED0")"

codex_case fail "codex other tool name is rejected" "gate accepted a non-shell function_call" "" \
  "$(call c1 apply_patch '{"cmd":"graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case fail "codex trace with no rollout records is reported as missing" "gate accepted an empty trace" "Codex session trace missing or unstaged" \
  '{"type":"session_meta","payload":{"id":"x"}}'

rm -rf "$CX"
mkdir -p "$CX"
: > "$CX/session-files.txt"
expect fail "codex trace with only the file list is reported as missing" "gate accepted an unstaged trace" "Codex session trace missing or unstaged" -- \
  REQUIRED=true FORMAT=codex TRACE="$CX"

rm -rf "$CX"
expect fail "codex missing trace directory is reported as missing" "gate accepted a missing trace" "Codex session trace missing or unstaged" -- \
  REQUIRED=true FORMAT=codex TRACE="$CX"

expect pass "not required skips a missing codex trace" "gate failed with REQUIRED=false" "" -- \
  REQUIRED=false FORMAT=codex TRACE="$CX"

# ---- removed formats ----
printf '%s\n' '{"type":"tool_use","tool_name":"run_shell_command","parameters":{"command":"graphify query x"}}' > "$T/gemini.jsonl"
expect fail "the removed gemini argv format is rejected" "gate still parses gemini traces" "unknown graphify trace format" -- \
  REQUIRED=true FORMAT=gemini TRACE="$T/gemini.jsonl"

# ---- grok (unchanged) ----
printf '%s\n' '{"type":"tool_call","toolCallId":"1","toolName":"Read","status":"completed","rawInput":{"path":"not-graphify-out/pr-head-notes.md"}}' > "$T/grok-bad.jsonl"
expect fail "lookalike notes path is rejected" "gate accepted a different directory" "" -- \
  REQUIRED=true FORMAT=grok TRACE="$T/grok-bad.jsonl"

printf '%s\n' '{"type":"tool_call","toolCallId":"1","toolName":"Read","status":"completed","rawInput":{"path":"../graphify-out/pr-head-notes.md"}}' > "$T/grok-up.jsonl"
expect fail "notes path above the workspace is rejected" "gate folded .. above the root" "" -- \
  REQUIRED=true FORMAT=grok TRACE="$T/grok-up.jsonl"

printf '%s\n' '{"type":"tool_call","toolCallId":"1","toolName":"Read","status":"completed","rawInput":{"path":"graphify-out/pr-head-notes.md"}}' > "$T/grok.jsonl"
expect pass "grok notes read counts" "gate rejected a completed Read" "" -- \
  REQUIRED=true FORMAT=grok TRACE="$T/grok.jsonl"

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
