#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/.github/actions/stage-review-skills/check-grok-skill-trace.sh"
T="$(mktemp -d)"
trap 'rm -rf -- "$T"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

cat > "$T/ok.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"c1","toolName":"read_file","kind":"read","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md"},"status":"in_progress"}
{"type":"tool_call_update","toolCallId":"c1","status":"completed"}
{"type":"text","data":"No critical issues."}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/ok.jsonl" JSON_OUT="$T/out.json" bash "$SCRIPT" >/dev/null \
  && grep -q 'No critical issues' "$T/out.json"; then ok "read confirms"; else bad "read confirms"; fi

cat > "$T/miss.jsonl" <<'EOF'
{"type":"tool_call","toolName":"read_file","rawInput":{"path":"README.md"}}
{"type":"text","data":"skills loaded"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/miss.jsonl" JSON_OUT="$T/miss.json" bash "$SCRIPT" >/dev/null; then
  bad "missing read fails"
else
  ok "missing read fails"
fi

cat > "$T/grep.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"c2","toolName":"grep","kind":"search","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md"}}
{"type":"tool_call_update","toolCallId":"c2","status":"completed"}
{"type":"text","data":"x"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/grep.jsonl" JSON_OUT="$T/grep.json" bash "$SCRIPT" >/dev/null; then
  bad "grep is not a read"
else
  ok "grep is not a read"
fi

cat > "$T/fail.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"c3","toolName":"read_file","kind":"read","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md"},"status":"in_progress"}
{"type":"tool_call_update","toolCallId":"c3","status":"failed"}
{"type":"text","data":"x"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/fail.jsonl" JSON_OUT="$T/fail.json" bash "$SCRIPT" >/dev/null; then
  bad "failed read is not a load"
else
  ok "failed read is not a load"
fi

cat > "$T/evil.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"c4","toolName":"read_file","kind":"read","rawInput":{"path":"evil/.agents/skills/adhering-to-dry/SKILL.md"}}
{"type":"tool_call_update","toolCallId":"c4","status":"completed"}
{"type":"text","data":"x"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/evil.jsonl" JSON_OUT="$T/evil.json" bash "$SCRIPT" >/dev/null; then
  bad "nested path is not the skill"
else
  ok "nested path is not the skill"
fi

cat > "$T/read-name.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"c5","toolName":"Read","rawInput":{"path":"./.agents/skills/adhering-to-dry/SKILL.md"},"status":"completed"}
{"type":"text","data":"Read name ok."}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/read-name.jsonl" JSON_OUT="$T/read-name.json" bash "$SCRIPT" >/dev/null \
  && grep -q 'Read name ok' "$T/read-name.json"; then ok "Read name and dot path"; else bad "Read name and dot path"; fi

cat > "$T/bad-raw.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"c6","toolName":"Read","rawInput":"not-an-object"}
{"type":"text","data":"still an envelope"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=false IDS= TRACE="$T/bad-raw.jsonl" JSON_OUT="$T/bad-raw.json" bash "$SCRIPT" >/dev/null \
  && grep -q 'still an envelope' "$T/bad-raw.json"; then ok "non-object rawInput does not crash"; else bad "non-object rawInput does not crash"; fi

cat > "$T/backslash.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"c7","toolName":"Read","rawInput":{"path":".\\.agents\\skills\\adhering-to-dry\\SKILL.md"},"status":"completed"}
{"type":"text","data":"x"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/backslash.jsonl" JSON_OUT="$T/backslash.json" bash "$SCRIPT" >/dev/null; then
  bad "backslash path is not the skill"
else
  ok "backslash path is not the skill"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
