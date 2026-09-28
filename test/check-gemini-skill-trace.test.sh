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

cat > "$T/ok.jsonl" <<'EOF'
{"type":"tool_use","tool_name":"activate_skill","tool_id":"t1","parameters":{"name":"adhering-to-dry"}}
{"type":"tool_result","tool_id":"t1","status":"success","output":"<activated_skill name=\"adhering-to-dry\">\n  <instructions>\n    Wait.\n  </instructions>\n</activated_skill>"}
{"type":"message","role":"assistant","content":"No critical issues.","delta":false}
{"type":"result","status":"success"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/ok.jsonl" REVIEW_OUT="$T/review.txt" bash "$SCRIPT" >/dev/null \
  && grep -q 'No critical issues' "$T/review.txt"; then ok "activate confirms"; else bad "activate confirms"; fi

cat > "$T/miss.jsonl" <<'EOF'
{"type":"message","role":"assistant","content":"skills loaded","delta":false}
{"type":"result","status":"success"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/miss.jsonl" REVIEW_OUT="$T/miss.txt" bash "$SCRIPT" >/dev/null; then
  bad "missing activate fails"
else
  ok "missing activate fails"
fi

cat > "$T/result-error.jsonl" <<'EOF'
{"type":"tool_use","tool_name":"activate_skill","tool_id":"t1","parameters":{"name":"adhering-to-dry"}}
{"type":"tool_result","tool_id":"t1","status":"success","output":"<activated_skill name=\"adhering-to-dry\">ok</activated_skill>"}
{"type":"message","role":"assistant","content":"partial review","delta":false}
{"type":"result","status":"error","error":{"type":"FatalTurnLimitedError","message":"turn cap"}}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/result-error.jsonl" REVIEW_OUT="$T/re.txt" bash "$SCRIPT" >/dev/null; then
  bad "result error fails"
else
  ok "result error fails"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
