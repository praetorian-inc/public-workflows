#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO_ROOT/.github/actions/stage-review-skills/check-graphify-use.sh"
PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

T="$(mktemp -d "${TMPDIR:-/tmp}/graphify-use.XXXXXX")" || { echo "ERROR: mktemp failed" >&2; exit 2; }
# Remove only the directory mktemp made: never an empty or unrelated path.
trap 'T="${T:-}"; case "${T##*/}" in graphify-use.?*) rm -rf -- "$T" ;; esac' EXIT
T_REAL="$(cd -- "$T" && pwd -P)" || { echo "ERROR: cannot resolve $T" >&2; exit 2; }
T="$T_REAL"

# expect <pass|unused|error> <name> <reason> [output-substring] -- <env...>
# Runs the checker with the given env assignments and checks the exit status:
# pass = 0 (used or skipped), unused = 1 (graphify not used), error = 2 (the
# check could not evaluate). An output substring, when given, must appear.
expect() {
  local want="$1" name="$2" reason="$3" needle="$4"
  shift 5
  local out rc code
  case "$want" in
    pass) code=0 ;;
    unused) code=1 ;;
    error) code=2 ;;
    *) bad "$name" "unknown expectation $want"; return ;;
  esac
  out="$(cd -- "$T/ws" && env "$@" bash "$SCRIPT" 2>&1)"
  rc=$?
  if [ "$rc" -ne "$code" ]; then
    bad "$name" "$reason (want exit $code, got $rc: $out)"
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
expect unused "querylog record for another graph is rejected" "gate accepted a different corpus" "no graphify query" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

: > "$LOG"
expect unused "empty querylog is rejected" "gate accepted an empty log" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

rm -f "$LOG"
expect unused "missing querylog is rejected" "gate accepted a missing log" "query log is missing" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

{ printf '{"kind":"query","corpus":"%s"\n' "$GRAPH"; printf 'not json\n'; printf '["%s"]\n' "$GRAPH"; } > "$LOG"
expect unused "malformed querylog lines are rejected" "gate accepted a truncated or non-object record" "" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

printf '{"ts":"2026-10-05T00:00:00+00:00","kind":"mcp_get_node","label":"dispatch","corpus":"%s"}\n' "$GRAPH" > "$LOG"
expect unused "querylog record of another kind is rejected" "gate accepted a non-query record kind" "no graphify query" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

printf '{"ts":"2026-10-05T00:00:00+00:00","question":"callers","corpus":"%s"}\n' "$GRAPH" > "$LOG"
expect unused "querylog record without a kind is rejected" "gate accepted a record with no kind" "no graphify query" -- \
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

codex_case unused "codex nonzero exit is rejected" "gate accepted a failed graphify call" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" "$(out c1 "$EXITED1")"

codex_case unused "codex call with no output is rejected" "gate accepted a call that never returned" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')"

codex_case unused "codex exit code inside Output is not trusted" "gate read the exit code from command output" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" \
  "$(out c1 $'Wall time: 0.4 seconds\nProcess exited with code 1\nOutput:\nProcess exited with code 0')"

codex_case pass "codex graphify with 2>&1 counts" "gate read a redirection as a control operator" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers 2>&1"}')" "$(out c1 "$EXITED0")"

# Bash ends a word at an unquoted < > ( or ), so --graph</dev/null runs as
# --graph followed by the next word; only a whole-word N>&M redirection counts.
codex_case unused "codex --graph</dev/null is rejected" "gate read --graph</dev/null as one word" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x --graph</dev/null sub/g.json"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex --graph>&2 is rejected" "gate read --graph>&2 as one word" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x --graph>&2 sub/g.json"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex --graph>/dev/null is rejected" "gate read --graph>/dev/null as one word" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x --graph>/dev/null sub/g.json"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex <(true) process substitution is rejected" "gate accepted a process substitution word" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x <(true)"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex plain output redirection is rejected" "gate accepted >out" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x >out"}')" "$(out c1 "$EXITED0")"

codex_case pass "codex bare >&2 word counts" "gate rejected a whole-word >&2" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers >&2"}')" "$(out c1 "$EXITED0")"

codex_case pass "codex < and > inside single quotes count" "gate rejected literal quoted angle brackets" "" \
  "$(call c1 exec_command "{\"cmd\":\"graphify query 'a<b>(c)'\"}")" "$(out c1 "$EXITED0")"

codex_case pass "codex graphify with a trailing newline counts" "gate rejected trailing whitespace" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers\n"}')" "$(out c1 "$EXITED0")"

codex_case pass "codex quoted operators inside the question count" "gate split on a quoted operator" "" \
  "$(call c1 exec_command '{"cmd":"graphify query \"a; b && c | d\""}')" "$(out c1 "$EXITED0")"

codex_case unused "codex path-qualified ./graphify is rejected" "gate accepted a PR-committed graphify executable" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"./graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex PATH= prefix is rejected" "gate accepted a PATH override to a planted graphify" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"PATH=.:/usr/bin graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex GRAPHIFY_OUT= prefix is rejected" "gate accepted a redirected graph" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"GRAPHIFY_OUT=sub/graphify-out graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex path-qualified ./bash -lc wrapper is rejected" "gate accepted a PR-committed shell" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"./bash -lc \"graphify query callers\""}')" "$(out c1 "$EXITED0")"

codex_case unused "codex --graph override is rejected" "gate accepted a query against a planted graph" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers --graph sub/planted.json"}')" "$(out c1 "$EXITED0")"

# graphify reads graphify-out/graph.json from its cwd; only the workspace root's
# graph is neutralized and checked, so a workdir elsewhere does not count.
mkdir -p "$T/ws/sub/graphify-out"
codex_case unused "codex workdir in a PR subdirectory is rejected" "gate accepted a query against a subdirectory's planted graph" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers","workdir":"sub"}')" "$(out c1 "$EXITED0")"

ABS_ARGS="$(printf '{"cmd":"graphify query callers","workdir":"%s"}' "$T/ws")"
codex_case pass "codex workdir equal to the absolute workspace counts" "gate rejected the workspace root spelled absolutely" "" \
  "$(call c1 exec_command "$ABS_ARGS")" "$(out c1 "$EXITED0")"

codex_case pass "codex workdir . counts" "gate rejected the workspace root spelled ." "" \
  "$(call c1 shell_command '{"command":"graphify query callers","workdir":"."}')" "$(out c1 $'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nok')"

codex_case unused "codex non-string workdir is rejected" "gate accepted a workdir it cannot resolve" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers","workdir":["sub"]}')" "$(out c1 "$EXITED0")"

codex_case unused "codex write_stdin finishing a subdirectory session is rejected" "gate credited a session started outside the workspace root" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers","workdir":"sub"}')" \
  "$(out c1 $'Chunk ID: a1\nWall time: 10.0 seconds\nProcess running with session ID 7\nOutput:\n')" \
  "$(call c2 write_stdin '{"session_id":7,"chars":""}')" "$(out c2 "$EXITED0")"

# Shell expansion makes the argv graphify runs with differ from the one the
# checker reads, so $, backticks and unquoted glob/brace/tilde words do not count.
# shellcheck disable=SC2016  # literal shell text the checker must reject
codex_case unused "codex \$(...) expansion is rejected" "gate accepted a substitution that can expand to --graph" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x $(echo --graph) sub/graphify-out/graph.json"}')" "$(out c1 "$EXITED0")"

# shellcheck disable=SC2016  # literal shell text the checker must reject
codex_case unused "codex backtick substitution is rejected" "gate accepted a backtick substitution" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x `echo --graph` sub/g.json"}')" "$(out c1 "$EXITED0")"

# shellcheck disable=SC2016  # literal shell text the checker must reject
codex_case unused "codex \$VAR expansion is rejected" "gate accepted a variable expansion" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x $G sub/g.json"}')" "$(out c1 "$EXITED0")"

# shellcheck disable=SC2016  # literal shell text the checker must reject
codex_case unused "codex \${X} expansion is rejected" "gate accepted a braced variable expansion" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x ${G} sub/g.json"}')" "$(out c1 "$EXITED0")"

# shellcheck disable=SC2016  # literal shell text the checker must reject
codex_case unused "codex \$(...) inside double quotes is rejected" "gate treated double quotes as literal" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query \"$(echo x)\""}')" "$(out c1 "$EXITED0")"

codex_case unused "codex unquoted glob is rejected" "gate accepted a glob that can match a PR file named --graph" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x --gr* sub/g.json"}')" "$(out c1 "$EXITED0")"

# Built outside $(...): bash 3.2 brace-expands words inside a quoted $(...).
BRACE_ARGS='{"cmd":"graphify query x {--graph,sub/g.json}"}'
codex_case unused "codex brace expansion is rejected" "gate accepted a brace expansion" "graphify not used" \
  "$(call c1 exec_command "$BRACE_ARGS")" "$(out c1 "$EXITED0")"

codex_case unused "codex unquoted tilde is rejected" "gate accepted a tilde expansion" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x ~"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex backslash-escaped --graph is rejected" "gate read --gr\\aph as a different word than the shell does" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query x --gr\\aph sub/g.json"}')" "$(out c1 "$EXITED0")"

codex_case pass "codex \$(...) inside single quotes counts" "gate rejected literal single-quoted text" "" \
  "$(call c1 exec_command "{\"cmd\":\"graphify query '\$(literal) \`x\` \$G *'\"}")" "$(out c1 "$EXITED0")"

codex_case pass "codex glob characters inside double quotes count" "gate rejected a quoted question mark" "" \
  "$(call c1 exec_command '{"cmd":"graphify query \"who calls dispatch?\""}')" "$(out c1 "$EXITED0")"

codex_case pass "codex /bin/bash -lc wrapper counts" "gate rejected the system shell" "" \
  "$(call c1 exec_command '{"cmd":"/bin/bash -lc \"graphify query callers\""}')" "$(out c1 "$EXITED0")"

codex_case unused "codex write_stdin finish with nonzero exit is rejected" "gate accepted a session that exited 1" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" \
  "$(out c1 $'Chunk ID: a1\nWall time: 10.0 seconds\nProcess running with session ID 7\nOutput:\n')" \
  "$(call c2 write_stdin '{"session_id":7,"chars":""}')" "$(out c2 "$EXITED1")"

codex_case unused "codex write_stdin to another session is rejected" "gate credited an unrelated session's exit" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers"}')" \
  "$(out c1 $'Chunk ID: a1\nWall time: 10.0 seconds\nProcess running with session ID 7\nOutput:\n')" \
  "$(call c2 write_stdin '{"session_id":8,"chars":""}')" "$(out c2 "$EXITED0")"

codex_case unused "codex shell_command exit code inside Output is not trusted" "gate read Exit code: from command output" "" \
  "$(call c1 shell_command '{"command":"graphify query callers"}')" \
  "$(out c1 $'Exit code: 1\nWall time: 0.2 seconds\nOutput:\nExit code: 0')"

codex_case unused "codex true || graphify is rejected" "gate accepted a graphify call that never runs" "" \
  "$(call c1 exec_command '{"cmd":"true || graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex test && graphify is rejected" "gate accepted a chained graphify call" "" \
  "$(call c1 exec_command '{"cmd":"test -f graphify-out/graph.json && graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex graphify; true is rejected" "gate tied a later command's exit to graphify" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers; true"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex graphify | head is rejected" "gate tied a pipe's exit to graphify" "" \
  "$(call c1 exec_command '{"cmd":"graphify query callers | head"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex echo graphify is rejected" "gate accepted echo" "" \
  "$(call c1 exec_command '{"cmd":"echo graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case unused "codex non-function_call with arguments is rejected" "gate accepted a custom_tool_call / event field" "" \
  '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec_command","call_id":"c1","input":"x","arguments":"{\"cmd\":\"graphify query callers\"}"}}' \
  '{"type":"event_msg","payload":{"type":"exec_command_end","command":["graphify","query","callers"],"exit_code":0}}' \
  "$(out c1 "$EXITED0")"

codex_case unused "codex other tool name is rejected" "gate accepted a non-shell function_call" "" \
  "$(call c1 apply_patch '{"cmd":"graphify query callers"}')" "$(out c1 "$EXITED0")"

codex_case error "codex trace with no rollout records is reported as missing" "gate accepted an empty trace" "Codex session trace missing or unstaged" \
  '{"type":"session_meta","payload":{"id":"x"}}'

rm -rf "$CX"
mkdir -p "$CX"
: > "$CX/session-files.txt"
expect error "codex trace with only the file list is reported as missing" "gate accepted an unstaged trace" "Codex session trace missing or unstaged" -- \
  REQUIRED=true FORMAT=codex TRACE="$CX"

rm -rf "$CX"
expect error "codex missing trace directory is reported as missing" "gate accepted a missing trace" "Codex session trace missing or unstaged" -- \
  REQUIRED=true FORMAT=codex TRACE="$CX"

expect pass "not required skips a missing codex trace" "gate failed with REQUIRED=false" "" -- \
  REQUIRED=false FORMAT=codex TRACE="$CX"

# ---- removed formats ----
printf '%s\n' '{"type":"tool_use","tool_name":"run_shell_command","parameters":{"command":"graphify query x"}}' > "$T/gemini.jsonl"
expect error "the removed gemini argv format is rejected" "gate still parses gemini traces" "unknown graphify trace format" -- \
  REQUIRED=true FORMAT=gemini TRACE="$T/gemini.jsonl"

expect error "the removed grok notes format is rejected" "gate still parses grok notes reads" "unknown graphify trace format" -- \
  REQUIRED=true FORMAT=grok TRACE="$T/gemini.jsonl"

# ---- evaluation errors exit 2, not 1 ----
expect error "unknown format exits 2" "gate treated an unknown format as unused" "unknown graphify trace format" -- \
  REQUIRED=true FORMAT=bogus TRACE="$T/gemini.jsonl"

expect error "missing FORMAT exits 2" "gate treated a missing FORMAT as unused" "FORMAT is required" -- \
  REQUIRED=true

expect error "querylog without QUERY_LOG exits 2" "gate treated a missing QUERY_LOG setting as unused" "QUERY_LOG is required" -- \
  REQUIRED=true FORMAT=querylog

mkdir -p "$T/logdir"
expect error "unreadable querylog exits 2" "gate treated an unreadable log as unused" "cannot evaluate" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$T/logdir"

expect error "codex without TRACE exits 2" "gate treated a missing TRACE setting as unused" "TRACE is required" -- \
  REQUIRED=true FORMAT=codex

# ---- grok (graphify MCP server query log) ----
# query_graph logs kind "mcp_query" with corpus = the graph path the server was
# started with; grok-code.yml starts it with the absolute workspace graph.
mcp_record() { printf '{"ts":"2026-10-05T00:00:00+00:00","kind":"mcp_query","question":"dispatch handler","corpus":"%s","nodes_returned":77,"depth":3,"mode":"bfs"}\n' "$1"; }

mcp_record "$GRAPH" > "$LOG"
expect pass "grok MCP query_graph record counts" "gate rejected an MCP query_graph record" "graphify use confirmed (querylog)" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

mcp_record "$T/other/graph.json" > "$LOG"
expect unused "grok MCP record for another graph is rejected" "gate accepted an MCP server started on another graph" "graphify not used" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

rm -f "$LOG"
expect unused "grok run with no MCP query exits 1" "gate did not report a missing log as unused" "query log is missing" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG"

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
