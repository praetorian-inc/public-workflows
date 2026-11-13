#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/.github/actions/stage-review-skills/check-gemini-skill-trace.sh"
T="$(mktemp -d)"
trap 'rm -rf -- "$T"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

# Fixtures are gemini-cli 0.68.0 stream-json: every event has a timestamp,
# the run opens with init and the user prompt, the assistant reply streams as
# delta:true chunks, and every result (error ones too) carries stats.
cat > "$T/ok.jsonl" <<'EOF'
{"type":"init","timestamp":"2026-11-12T10:00:00.000Z","session_id":"s-1","model":"gemini-4-carbon"}
{"type":"message","timestamp":"2026-11-12T10:00:00.010Z","role":"user","content":"Review this PR."}
{"type":"tool_use","timestamp":"2026-11-12T10:00:02.000Z","tool_name":"activate_skill","tool_id":"t1","parameters":{"name":"adhering-to-dry"}}
{"type":"tool_result","timestamp":"2026-11-12T10:00:02.100Z","tool_id":"t1","status":"success","output":"<activated_skill name=\"adhering-to-dry\">\n  <instructions>\n    Wait.\n  </instructions>\n</activated_skill>"}
{"type":"message","timestamp":"2026-11-12T10:00:30.000Z","role":"assistant","content":"No critical ","delta":true}
{"type":"message","timestamp":"2026-11-12T10:00:30.200Z","role":"assistant","content":"issues.","delta":true}
{"type":"result","timestamp":"2026-11-12T10:00:31.000Z","status":"success","stats":{"total_tokens":51040,"input_tokens":51000,"output_tokens":40,"cached":0,"input":51000,"duration_ms":31000,"tool_calls":1,"models":{"gemini-4-carbon-001":{"total_tokens":51040,"input_tokens":51000,"output_tokens":40,"cached":0,"input":51000}}}}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/ok.jsonl" REVIEW_OUT="$T/review.txt" bash "$SCRIPT" >/dev/null \
  && [ "$(cat "$T/review.txt")" = 'No critical issues.' ]; then ok "activate confirms"; else bad "activate confirms"; fi

cat > "$T/miss.jsonl" <<'EOF'
{"type":"init","timestamp":"2026-11-12T10:00:00.000Z","session_id":"s-1","model":"gemini-4-carbon"}
{"type":"message","timestamp":"2026-11-12T10:00:00.010Z","role":"user","content":"Review this PR."}
{"type":"message","timestamp":"2026-11-12T10:00:30.000Z","role":"assistant","content":"skills loaded","delta":true}
{"type":"result","timestamp":"2026-11-12T10:00:31.000Z","status":"success","stats":{"total_tokens":51040,"input_tokens":51000,"output_tokens":40,"cached":0,"input":51000,"duration_ms":31000,"tool_calls":0,"models":{"gemini-4-carbon-001":{"total_tokens":51040,"input_tokens":51000,"output_tokens":40,"cached":0,"input":51000}}}}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/miss.jsonl" REVIEW_OUT="$T/miss.txt" bash "$SCRIPT" >/dev/null; then
  bad "missing activate fails"
else
  ok "missing activate fails"
fi

# An error result carries stats in 0.68.0; it must still fail.
cat > "$T/result-error.jsonl" <<'EOF'
{"type":"init","timestamp":"2026-11-12T10:00:00.000Z","session_id":"s-1","model":"gemini-4-carbon"}
{"type":"message","timestamp":"2026-11-12T10:00:00.010Z","role":"user","content":"Review this PR."}
{"type":"tool_use","timestamp":"2026-11-12T10:00:02.000Z","tool_name":"activate_skill","tool_id":"t1","parameters":{"name":"adhering-to-dry"}}
{"type":"tool_result","timestamp":"2026-11-12T10:00:02.100Z","tool_id":"t1","status":"success","output":"<activated_skill name=\"adhering-to-dry\">ok</activated_skill>"}
{"type":"message","timestamp":"2026-11-12T10:00:30.000Z","role":"assistant","content":"partial review","delta":true}
{"type":"result","timestamp":"2026-11-12T10:09:00.000Z","status":"error","error":{"type":"FatalTurnLimitedError","message":"Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json."},"stats":{"total_tokens":51040,"input_tokens":51000,"output_tokens":40,"cached":0,"input":51000,"duration_ms":0,"tool_calls":80,"models":{"gemini-4-carbon-001":{"total_tokens":51040,"input_tokens":51000,"output_tokens":40,"cached":0,"input":51000}}}}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/result-error.jsonl" REVIEW_OUT="$T/re.txt" bash "$SCRIPT" >/dev/null; then
  bad "result error fails"
else
  ok "result error fails"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
