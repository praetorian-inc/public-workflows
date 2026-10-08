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

# Codex runs cmd under args.shell, so a PR-committed shell binary could exit 0
# without graphify; only system shells and argument keys that cannot change
# what runs count.
codex_case pass "codex exec_command with shell bash counts" "gate rejected the default system shell" "" \
  "$(call c1 exec_command '{"shell":"bash","cmd":"graphify query callers","yield_time_ms":250}')" "$(out c1 "$EXITED0")"
codex_case unused "codex exec_command with a workspace shell is rejected" "gate accepted a PR-controlled shell binary" "graphify not used" \
  "$(call c1 exec_command '{"shell":"./bash","cmd":"graphify query callers"}')" "$(out c1 "$EXITED0")"
codex_case unused "codex exec_command with an absolute non-system shell is rejected" "gate accepted a shell outside the system set" "graphify not used" \
  "$(call c1 exec_command '{"shell":"/tmp/sh","cmd":"graphify query callers"}')" "$(out c1 "$EXITED0")"
codex_case pass "codex non-string shell is skipped, not fatal" "gate crashed or credited a malformed shell argument" "" \
  "$(call c1 exec_command '{"shell":["bash"],"cmd":"graphify query callers"}')" "$(out c1 "$EXITED0")" \
  "$(call c2 exec_command '{"cmd":"graphify query callers"}')" "$(out c2 "$EXITED0")"
codex_case unused "codex non-string shell alone is rejected" "gate credited a malformed shell argument" "graphify not used" \
  "$(call c1 exec_command '{"shell":{"path":"bash"},"cmd":"graphify query callers"}')" "$(out c1 "$EXITED0")"
codex_case unused "codex exec_command with environment_id is rejected" "gate accepted a call aimed at another environment" "graphify not used" \
  "$(call c1 exec_command '{"cmd":"graphify query callers","environment_id":"remote"}')" "$(out c1 "$EXITED0")"
codex_case unused "codex shell_command with sandbox_permissions is rejected" "gate accepted an escalated call" "graphify not used" \
  "$(call c1 shell_command '{"command":"graphify query callers","sandbox_permissions":"require_escalated"}')" "$(out c1 $'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nok')"
codex_case pass "codex shell_command with login and timeout_ms counts" "gate rejected harmless shell_command arguments" "" \
  "$(call c1 shell_command '{"command":"graphify query callers","login":false,"timeout_ms":60000}')" "$(out c1 $'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nok')"

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

# ---- warranted rule (ENG-8892) ----
# CHANGED_FILES / ADDED_FILES name newline-separated path lists. A change
# warrants graphify when a changed path is a graph node's source_file, or an
# ADDED file has a code extension. Otherwise the gate passes with
# "graphify not required", even with no query log.
mkdir -p "$T/gw"
printf '%s\n' '{"nodes":[{"id":"a","source_file":"pkg/a.go"},{"id":"b","source_file":""},{"id":"c"}]}' > "$T/gw/graph.json"
GW="$T/gw/graph.json"
CF="$T/changed.txt"
AF="$T/added.txt"
rm -f "$LOG"

printf 'AGENTS.md\ndocs/x.md\n' > "$CF"; : > "$AF"
expect pass "non-graphed change with no log is not required" "gate failed a docs-only PR" "graphify not required" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"

expect pass "ADDED_FILES unset is treated as empty" "gate required an added-files list" "graphify not required" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF"

printf 'pkg/a.go\nREADME.md\n' > "$CF"; : > "$AF"
expect unused "graphed .go change with no log is unused" "gate skipped a graphed code change" "query log is missing" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'pkg/new.go\n' > "$CF"; printf 'pkg/new.go\n' > "$AF"
expect unused "new .go file with no log is unused" "gate skipped a new code file" "query log is missing" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"

for ext in ts tsx js mjs sh py; do
  printf 'x/new.%s\n' "$ext" > "$CF"; printf 'x/new.%s\n' "$ext" > "$AF"
  expect unused "new .$ext file is warranted" "gate skipped a new .$ext file" "" -- \
    REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"
done

printf 'notes/new.md\n' > "$CF"; printf 'notes/new.md\n' > "$AF"
expect pass "new non-code file is not warranted" "gate required graphify for a new doc" "graphify not required" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'tools/old.go\nscripts/old.sh\n' > "$CF"; : > "$AF"
expect pass "edited code-extension file absent from the graph is not warranted" "gate keyed edits on extension" "graphify not required" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"

: > "$CF"; : > "$AF"
expect pass "empty changed list is not required" "gate required graphify for no changes" "graphify not required" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'pkg/a.go\n' > "$CF"; : > "$AF"
record "$GW" > "$LOG"
expect pass "graphed change with a real query counts" "gate rejected a used query when warranted" "graphify use confirmed (querylog)" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"
rm -f "$LOG"

printf '{"nodes":' > "$T/gw/bad.json"
printf 'AGENTS.md\n' > "$CF"
expect error "malformed graph with a changed list exits 2" "gate skipped on a graph it could not parse" "cannot evaluate" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$T/gw/bad.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf '{"nodes":{"a":1}}\n' > "$T/gw/notlist.json"
expect error "graph whose nodes is not a list exits 2" "gate skipped on a non-list nodes field" "cannot evaluate" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$T/gw/notlist.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

expect error "unreadable changed list exits 2" "gate skipped on a missing changed list" "cannot evaluate" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$T/nope.txt" ADDED_FILES="$AF"

expect error "unreadable added list exits 2" "gate skipped on a missing added list" "cannot evaluate" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$T/logdir"

expect unused "CHANGED_FILES unset keeps today's behavior" "gate skipped without a changed list" "query log is missing" -- \
  REQUIRED=true FORMAT=querylog QUERY_LOG="$LOG" GRAPH="$GW"

# Codex: the workspace graph ($T/ws/graphify-out/graph.json) is the default.
cp "$GW" "$T/ws/graphify-out/graph.json"
mkdir -p "$T/codex-empty"
printf 'AGENTS.md\n' > "$CF"; : > "$AF"
expect pass "codex format, not warranted, passes without a trace hit" "codex gate failed a docs-only PR" "graphify not required" -- \
  REQUIRED=true FORMAT=codex TRACE="$T/codex-empty" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'pkg/a.go\n' > "$CF"
rm -rf "$CX"; mkdir -p "$CX/2026/10/05"
printf '%s\n' "$(call c1 exec_command '{"cmd":"ls"}')" "$(out c1 "$EXITED0")" > "$CX/2026/10/05/rollout.jsonl"
find "$CX" -type f -print > "$CX/session-files.txt"
expect unused "codex format, warranted, with no graphify call is unused" "codex gate skipped a graphed change" "graphify not used" -- \
  REQUIRED=true FORMAT=codex TRACE="$CX" CHANGED_FILES="$CF" ADDED_FILES="$AF"
printf '{"nodes":[]}\n' > "$T/ws/graphify-out/graph.json"

# Decide mode: prints the decision and required=..., needs no log or trace.
printf 'AGENTS.md\n' > "$CF"; : > "$AF"
expect pass "decide mode, not warranted" "decide mode failed" "required=false" -- \
  DECIDE_ONLY=true GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"
expect pass "decide mode logs the not-required line" "decide mode lacks the log line" "graphify not required" -- \
  DECIDE_ONLY=true GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'pkg/a.go\n' > "$CF"
expect pass "decide mode, warranted" "decide mode failed on a warranted change" "required=true" -- \
  DECIDE_ONLY=true GRAPH="$GW" CHANGED_FILES="$CF" ADDED_FILES="$AF" GRAPHED_OUT="$T/graphed.txt"

if [ "$(cat "$T/graphed.txt" 2>/dev/null)" = "pkg/a.go" ]; then
  ok "decide mode writes graphed changed paths to GRAPHED_OUT"
else
  bad "decide mode writes graphed changed paths to GRAPHED_OUT" "got: $(cat "$T/graphed.txt" 2>&1)"
fi

expect pass "decide mode with no graph is not required" "decide mode failed without a graph" "required=false" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/absent.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

expect error "decide mode without CHANGED_FILES exits 2" "decide mode guessed without a list" "CHANGED_FILES is required" -- \
  DECIDE_ONLY=true GRAPH="$GW"

expect error "decide mode with a malformed graph exits 2" "decide mode skipped on a bad graph" "cannot evaluate" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/bad.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

# NUL-delimited lists (git diff -z). A list holding a NUL is split on NUL, so
# paths with a newline, tab, quote or backslash arrive unquoted and whole.
printf '%s\n' '{"nodes":[{"id":"q","source_file":"pkg/q\"x.go"},{"id":"n","source_file":"pkg/n\nl.go"},{"id":"a","source_file":"pkg/a.go"}]}' > "$T/gw/odd.json"
printf 'docs/x.md\0pkg/a.go\0' > "$CF"; : > "$AF"
expect pass "NUL-delimited changed list is split on NUL" "decide mode read a NUL list as one path" "required=true" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/odd.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'docs/x.md\0' > "$CF"; printf 'docs/x.md\0x/new.go\0' > "$AF"
expect pass "NUL-delimited added list is split on NUL" "decide mode read a NUL added list as one path" "required=true" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/odd.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'pkg/q"x.go\0' > "$CF"; : > "$AF"
expect pass "graphed path with a double quote matches unquoted" "decide mode missed a quoted-char path" "required=true" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/odd.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'pkg/n\nl.go\0' > "$CF"; : > "$AF"
expect pass "graphed path with a newline matches in a NUL list" "decide mode split a path on its newline" "required=true" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/odd.json" CHANGED_FILES="$CF" ADDED_FILES="$AF" GRAPHED_OUT="$T/graphed.txt"
if [ "$(wc -l < "$T/graphed.txt" | tr -d ' ')" = "1" ] && [ "$(cat "$T/graphed.txt")" = 'pkg/n\nl.go' ]; then
  ok "GRAPHED_OUT keeps one display line per path"
else
  bad "GRAPHED_OUT keeps one display line per path" "got: $(cat "$T/graphed.txt" 2>&1)"
fi

# Subdirectory graphs: graphify extract <path> writes source_file relative to
# <path> (measured with 0.8.35: hello.go, cmd/minimal/main.go), while the
# changed list is repo-relative. A changed path that ends in "/" + a
# source_file counts as graphed; over-requiring is the safe direction.
printf '%s\n' '{"nodes":[{"id":"h","source_file":"hello.go"},{"id":"m","source_file":"cmd/minimal/main.go"}]}' > "$T/gw/sub.json"
printf '_test-fixtures/go-minimal/hello.go\0docs/x.md\0_test-fixtures/go-minimal/cmd/minimal/main.go\0' > "$CF"; : > "$AF"
expect pass "changed path ending in /source_file is graphed" "decide mode missed a subdirectory graph" "required=true" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/sub.json" CHANGED_FILES="$CF" ADDED_FILES="$AF" GRAPHED_OUT="$T/graphed.txt"
if [ "$(cat "$T/graphed.txt" 2>/dev/null)" = "$(printf '_test-fixtures/go-minimal/hello.go\n_test-fixtures/go-minimal/cmd/minimal/main.go')" ]; then
  ok "GRAPHED_OUT lists suffix-matched changed paths"
else
  bad "GRAPHED_OUT lists suffix-matched changed paths" "got: $(cat "$T/graphed.txt" 2>&1)"
fi

printf 'pkg/xhello.go\0minimal/main.go\0' > "$CF"; : > "$AF"
expect pass "suffix match needs a path-component boundary" "decide mode matched a partial name or a shorter path" "required=false" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/sub.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

printf 'hello.go\0' > "$CF"; : > "$AF"
expect pass "exact source_file match still counts" "decide mode lost the exact match" "required=true" -- \
  DECIDE_ONLY=true GRAPH="$T/gw/sub.json" CHANGED_FILES="$CF" ADDED_FILES="$AF"

# Renames (end to end): each bot's own graphify list commands, run against a
# real rename of a graphed file, must list the old path as changed. Without
# --no-renames git lists only the new path. The new path is not a code file,
# so only the graphed old path can make graphify required.
make_rename_repo() {
  local repo="$1"
  rm -rf "$repo"; mkdir -p "$repo/pkg"
  git -C "$repo" init -q
  printf 'package pkg\n\nfunc A() {}\n' > "$repo/pkg/a.go"
  printf 'package pkg\n' > "$repo/pkg/q\"x.go"
  git -C "$repo" add -A
  git -C "$repo" -c user.name=t -c user.email=t@t commit -q -m base
  git -C "$repo" mv pkg/a.go pkg/a.go.orig
  printf 'package pkg\n\nfunc Q() {}\n' > "$repo/pkg/q\"x.go"
  git -C "$repo" add -A
  git -C "$repo" -c user.name=t -c user.email=t@t commit -q -m rename
}
printf '%s\n' '{"nodes":[{"id":"a","source_file":"pkg/a.go"}]}' > "$T/gw/rename.json"
printf '%s\n' '{"nodes":[{"id":"q","source_file":"pkg/q\"x.go"}]}' > "$T/gw/quote.json"
for bot in claude codex gemini grok; do
  wf="$REPO_ROOT/.github/workflows/$bot-code.yml"
  # shellcheck disable=SC2016  # literal workflow text, not an expansion
  lists="$(grep -E '^ *git .*> "\$RUNNER_TEMP/graphify-(changed|added)-files\.txt"$' "$wf" | sed 's/^ *//')"
  repo="$T/rename-$bot"
  make_rename_repo "$repo"
  rt="$T/rt-$bot"; rm -rf "$rt"; mkdir -p "$rt"
  if [ "$(printf '%s\n' "$lists" | grep -c 'graphify-')" != "2" ]; then
    bad "$bot graphify lists catch a rename of a graphed file" "context step does not write both graphify lists with git diff: $lists"
    bad "$bot graphify lists carry a quoted-char path unquoted" "context step does not write both graphify lists with git diff"
    continue
  fi
  # The lines are this repo's own workflow text, run with no excludes; eval
  # reads EXCLUDES and RUNNER_TEMP.
  # shellcheck disable=SC2034
  (cd -- "$repo" && set +u && EXCLUDES=() && RUNNER_TEMP="$rt" && eval "$lists") >/dev/null 2>&1
  out="$(cd -- "$repo" && DECIDE_ONLY=true GRAPH="$T/gw/rename.json" CHANGED_FILES="$rt/graphify-changed-files.txt" ADDED_FILES="$rt/graphify-added-files.txt" bash "$SCRIPT" 2>&1)"
  if [[ "$out" == *"1 changed file(s) in the graph"* && "$out" == *"required=true"* ]]; then
    ok "$bot graphify lists catch a rename of a graphed file"
  else
    bad "$bot graphify lists catch a rename of a graphed file" "$out"
  fi
  out="$(cd -- "$repo" && DECIDE_ONLY=true GRAPH="$T/gw/quote.json" CHANGED_FILES="$rt/graphify-changed-files.txt" ADDED_FILES="$rt/graphify-added-files.txt" bash "$SCRIPT" 2>&1)"
  if [[ "$out" == *"1 changed file(s) in the graph"* && "$out" == *"required=true"* ]]; then
    ok "$bot graphify lists carry a quoted-char path unquoted"
  else
    bad "$bot graphify lists carry a quoted-char path unquoted" "$out"
  fi
done

# ---- workflow wiring (ENG-8892) ----
# Every bot writes NUL-delimited, rename-free graphify lists outside the
# review tree before the agent runs, leaves the agent-facing changed-files.txt
# as it was, and passes the lists to its gate.
for bot in claude codex gemini grok; do
  wf="$REPO_ROOT/.github/workflows/$bot-code.yml"
  if grep -F -q -- "git diff -z --no-renames --name-only HEAD^1 HEAD -- . \"\${EXCLUDES[@]}\" > \"\$RUNNER_TEMP/graphify-changed-files.txt\"" "$wf" &&
     grep -F -q -- "git diff -z --no-renames --name-only --diff-filter=A HEAD^1 HEAD -- . \"\${EXCLUDES[@]}\" > \"\$RUNNER_TEMP/graphify-added-files.txt\"" "$wf" &&
     grep -F -q -- "git -c core.quotePath=false diff --name-only HEAD^1 HEAD -- . \"\${EXCLUDES[@]}\" > .$bot-review/changed-files.txt" "$wf" &&
     ! grep -F -q "$bot-review/added-files.txt" "$wf"; then
    ok "$bot context writes the graphify lists with -z --no-renames"
  else
    bad "$bot context writes the graphify lists with -z --no-renames" "graphify lists not written with git diff -z --no-renames, or agent-facing lists changed"
  fi
  # shellcheck disable=SC2016  # literal workflow text, not an expansion
  if grep -F 'REQUIRED=true FORMAT=' "$wf" | grep -F -q 'CHANGED_FILES="$RUNNER_TEMP/graphify-changed-files.txt" ADDED_FILES="$RUNNER_TEMP/graphify-added-files.txt"'; then
    ok "$bot gate passes the graphify lists"
  else
    bad "$bot gate passes the graphify lists" "gate does not pass CHANGED_FILES/ADDED_FILES"
  fi
done

# Claude and Codex log the decision from the pre-agent _pw checkout, before
# "Remove stage-script checkout"; the post-agent _trace gate is unchanged.
for bot in claude codex; do
  wf="$REPO_ROOT/.github/workflows/$bot-code.yml"
  if awk '
    /- name: Log graphify decision/ { step = NR }
    step && !decide && /DECIDE_ONLY=true .*bash _pw\/\.github\/actions\/stage-review-skills\/check-graphify-use\.sh/ { decide = NR }
    /- name: Remove stage-script checkout/ { remove = NR }
    END { exit(step && decide && remove && decide < remove ? 0 : 1) }' "$wf"; then
    ok "$bot logs the graphify decision before the review"
  else
    bad "$bot logs the graphify decision before the review" "no DECIDE_ONLY step from _pw before Remove stage-script checkout"
  fi
done

# The gate passes PRs that touch no graphed code, so no prompt may claim the
# job always fails without graphify. The run instruction stays unconditional:
# the bots are not told which files are graphed, so a conditional instruction
# invites a skipped query and a red job (ENG-8892).
COND='When this PR changes a file that is in the graph, or adds a code file (go, ts, tsx, js, mjs, sh, py),'
check_graphify_prompt() {
  local bot="$1" run="$2" fail="$3" oldfail="$4"
  local wf="$REPO_ROOT/.github/workflows/$bot-code.yml"
  if grep -F -q -- "$run" "$wf" &&
     grep -F -q -- "$COND $fail" "$wf" &&
     ! grep -F -q -- "$oldfail" "$wf" &&
     ! grep -F -q 'graphify is optional' "$wf" &&
     ! grep -F -q 'When graphify is required' "$wf"; then
    ok "$bot prompt keeps the run instruction unconditional and the failure claim conditional"
  else
    bad "$bot prompt keeps the run instruction unconditional and the failure claim conditional" "run instruction or conditional failure clause missing, or unconditional failure / optional wording present"
  fi
}
check_graphify_prompt claude \
  'Run at least one graphify query before findings.' \
  "the job reads graphify's own query log and fails if no graphify query against graphify-out/graph.json was logged." \
  "The job reads graphify's own query log"
# shellcheck disable=SC2016  # literal workflow text, not an expansion
check_graphify_prompt codex \
  'Run `graphify query`, `graphify explain`, or `graphify path` at least once before findings.' \
  'the job fails if the session trace has none.' \
  'The job fails if the session trace has none.'
check_graphify_prompt grok \
  'Call the graphify MCP tool query_graph at least once before findings, for the code this PR touches.' \
  'the job fails if no query_graph call reached the graph.' \
  'The job fails if no query_graph call reached the graph.'

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
