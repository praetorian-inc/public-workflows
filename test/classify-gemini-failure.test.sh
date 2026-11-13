#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/.github/actions/stage-review-skills/classify-gemini-failure.sh"
T="$(mktemp -d)"
trap 'rm -rf -- "$T"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

# gemini-cli 0.68.0 stream-json: timestamps on every event, and the error
# result carries stats.
cat > "$T/trace.jsonl" <<'EOF'
not json
{"type":"init","timestamp":"2026-11-12T10:00:00.000Z","session_id":"s-1","model":"gemini-4-carbon"}
{"type":"tool_use","timestamp":"2026-11-12T10:00:02.000Z","tool_name":"read_file","tool_id":"t1","parameters":{"file_path":"src/a.go"}}
{"type":"tool_result","timestamp":"2026-11-12T10:00:02.100Z","tool_id":"t1","status":"success","output":"FatalTurnLimitedError in a file"}
{"type":"result","timestamp":"2026-11-12T10:09:00.000Z","status":"error","error":{"type":"FatalTurnLimitedError","message":"Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json."},"stats":{"total_tokens":51040,"input_tokens":51000,"output_tokens":40,"cached":0,"input":51000,"duration_ms":0,"tool_calls":80,"models":{"gemini-4-carbon-001":{"total_tokens":51040,"input_tokens":51000,"output_tokens":40,"cached":0,"input":51000}}}}
EOF
printf '%s' 'stderr has the key SECRET' > "$T/err.txt"
if TRACE="$T/trace.jsonl" STDERR="$T/err.txt" DEST="$T/class.txt" STATUS=0 GEMINI_API_KEY=SECRET bash "$SCRIPT" \
  && grep -q 'result_error_type=FatalTurnLimitedError' "$T/class.txt" \
  && ! grep -q 'tool_result' "$T/class.txt" \
  && ! grep -q 'in a file' "$T/class.txt" \
  && ! grep -q 'SECRET' "$T/class.txt" \
  && grep -q '\[REDACTED\]' "$T/class.txt"; then
  ok "terminal event only, key scrubbed"
else
  bad "terminal event only, key scrubbed"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
