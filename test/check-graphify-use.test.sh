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

printf '%s\n' '{"type":"tool_use","tool_name":"run_shell_command","parameters":{"command":"graphify explain useRowReplacement"}}' > "$T/gemini.jsonl"
if REQUIRED=true FORMAT=gemini TRACE="$T/gemini.jsonl" bash "$SCRIPT" >/dev/null; then
  ok "gemini command counts"
else
  bad "gemini command counts" "gate rejected a real command"
fi

printf '%s\n' '{"type":"message","role":"assistant","content":"Prefer graphify query for callers"}' > "$T/prompt.jsonl"
if REQUIRED=true FORMAT=gemini TRACE="$T/prompt.jsonl" bash "$SCRIPT" >/dev/null; then
  bad "prompt text does not count" "gate accepted the prompt"
else
  ok "prompt text does not count"
fi

if REQUIRED=false FORMAT=gemini TRACE="$T/missing" bash "$SCRIPT" >/dev/null; then
  ok "not required skips a missing trace"
else
  bad "not required skips a missing trace" "exit $?"
fi

printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"gh pr comment 17 --body \"Findings: graphify query showed no callers.\""}}]}}' > "$T/quoted.json"
if REQUIRED=true FORMAT=claude TRACE="$T/quoted.json" bash "$SCRIPT" >/dev/null; then
  bad "quoted mention is not a graphify command" "gate accepted a comment body"
else
  ok "quoted mention is not a graphify command"
fi

printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"graphify query callers of dispatch"}}]}}' > "$T/claude.json"
if REQUIRED=true FORMAT=claude TRACE="$T/claude.json" bash "$SCRIPT" >/dev/null; then
  ok "claude bash command counts"
else
  bad "claude bash command counts" "gate rejected a Bash tool_use"
fi

mkdir -p "$T/codex"
printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"echo graphify query callers"}}' > "$T/codex/echo.jsonl"
if REQUIRED=true FORMAT=codex TRACE="$T/codex" bash "$SCRIPT" >/dev/null; then
  bad "echo graphify is not a graphify command" "gate accepted echo"
else
  ok "echo graphify is not a graphify command"
fi
rm -f "$T/codex/echo.jsonl"
printf '%s\n' '{"type":"response_item","payload":{"type":"function_call","arguments":"{\"command\":[\"bash\",\"-lc\",\"graphify query callers of dispatch\"]}"}}' > "$T/codex/rollout.jsonl"
if REQUIRED=true FORMAT=codex TRACE="$T/codex" bash "$SCRIPT" >/dev/null; then
  ok "codex rollout arguments count"
else
  bad "codex rollout arguments count" "gate rejected a function_call arguments string"
fi
rm -f "$T/codex/rollout.jsonl"
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo foo\\\\\ngraphify query callers"}}]}}' > "$T/escaped.json"
if REQUIRED=true FORMAT=claude TRACE="$T/escaped.json" bash "$SCRIPT" >/dev/null; then
  ok "escaped backslash does not swallow the next command"
else
  bad "escaped backslash does not swallow the next command" "gate joined a real newline"
fi
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"cat <<EOF\ngraphify query callers\nEOF"}}]}}' > "$T/heredoc.json"
if REQUIRED=true FORMAT=claude TRACE="$T/heredoc.json" bash "$SCRIPT" >/dev/null; then
  bad "heredoc body is not a graphify command" "gate accepted heredoc data"
else
  ok "heredoc body is not a graphify command"
fi
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"cd guard-platform/guard-core\ngraphify query \"callers of dispatch\""}}]}}' > "$T/newline.json"
if REQUIRED=true FORMAT=claude TRACE="$T/newline.json" bash "$SCRIPT" >/dev/null; then
  ok "newline-separated graphify command counts"
else
  bad "newline-separated graphify command counts" "gate rejected a following line"
fi
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"test -f graphify-out/graph.json && graphify query callers"}}]}}' > "$T/wrapped.json"
if REQUIRED=true FORMAT=claude TRACE="$T/wrapped.json" bash "$SCRIPT" >/dev/null; then
  ok "wrapped graphify command counts"
else
  bad "wrapped graphify command counts" "gate rejected cd/test && graphify"
fi
printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"graphify path A B"}}' > "$T/codex/session.jsonl"
if REQUIRED=true FORMAT=codex TRACE="$T/codex" bash "$SCRIPT" >/dev/null; then
  ok "codex command field counts"
else
  bad "codex command field counts" "gate rejected a command field"
fi

printf '%s\n' '{"type":"tool_call","toolCallId":"1","toolName":"Read","status":"completed","rawInput":{"path":"not-graphify-out/pr-head-notes.md"}}' > "$T/grok-bad.jsonl"
if REQUIRED=true FORMAT=grok TRACE="$T/grok-bad.jsonl" bash "$SCRIPT" >/dev/null; then
  bad "lookalike notes path is rejected" "gate accepted a different directory"
else
  ok "lookalike notes path is rejected"
fi

printf '%s\n' '{"type":"tool_call","toolCallId":"1","toolName":"Read","status":"completed","rawInput":{"path":"graphify-out/pr-head-notes.md"}}' > "$T/grok.jsonl"
if REQUIRED=true FORMAT=grok TRACE="$T/grok.jsonl" bash "$SCRIPT" >/dev/null; then
  ok "grok notes read counts"
else
  bad "grok notes read counts" "gate rejected a completed Read"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
