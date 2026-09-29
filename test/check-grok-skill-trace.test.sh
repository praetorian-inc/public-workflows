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
if STAGED=false IDS='' TRACE="$T/bad-raw.jsonl" JSON_OUT="$T/bad-raw.json" bash "$SCRIPT" >/dev/null \
  && grep -q 'still an envelope' "$T/bad-raw.json"; then ok "non-object rawInput does not crash"; else bad "non-object rawInput does not crash"; fi

cat > "$T/pin134.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"pin1","toolName":"read_file","kind":"read","status":"pending","rawInput":{"target_file":".agents/skills/adhering-to-dry/SKILL.md"}}
{"type":"tool_call_update","toolCallId":"pin1","status":null}
{"type":"tool_call_update","toolCallId":"pin1","status":"completed"}
{"type":"text","data":"pin 1.0.34 ok"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/pin134.jsonl" JSON_OUT="$T/pin134.json" bash "$SCRIPT" >/dev/null \
  && grep -q 'pin 1.0.34 ok' "$T/pin134.json"; then ok "1.0.34 target_file read"; else bad "1.0.34 target_file read"; fi

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

cat > "$T/early.jsonl" <<'EOF'
{"type":"text","data":"EARLY-GUESS "}
{"type":"tool_call","toolCallId":"e1","toolName":"Read","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md"},"status":"in_progress"}
{"type":"text","data":"MID-READ "}
{"type":"tool_call_update","toolCallId":"e1","status":"completed"}
{"type":"text","data":"LATE-REVIEW"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/early.jsonl" JSON_OUT="$T/early.json" bash "$SCRIPT" >/dev/null \
  && grep -q 'LATE-REVIEW' "$T/early.json" && ! grep -q 'EARLY-GUESS' "$T/early.json" \
  && ! grep -q 'MID-READ' "$T/early.json"; then
  ok "staged body is only text after the read completes"
else
  bad "staged body is only text after the read completes"
fi

cat > "$T/two.jsonl" <<'EOF'
{"type":"tool_call","toolCallId":"a1","toolName":"Read","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md"},"status":"completed"}
{"type":"text","data":"BETWEEN "}
{"type":"tool_call","toolCallId":"b1","toolName":"Read","rawInput":{"path":".agents/skills/adhering-to-yagni/SKILL.md"},"status":"completed"}
{"type":"text","data":"AFTER-BOTH "}
{"type":"tool_call","toolCallId":"a2","toolName":"Read","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md"},"status":"completed"}
{"type":"text","data":"AFTER-REREAD"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\nadhering-to-yagni\n' TRACE="$T/two.jsonl" JSON_OUT="$T/two.json" bash "$SCRIPT" >/dev/null \
  && grep -q 'AFTER-BOTH AFTER-REREAD' "$T/two.json" && ! grep -q 'BETWEEN' "$T/two.json"; then
  ok "gate is the latest id's earliest completed read"
else
  bad "gate is the latest id's earliest completed read"
fi

cat > "$T/noreview.jsonl" <<'EOF'
{"type":"text","data":"Review written before reading."}
{"type":"tool_call","toolCallId":"n1","toolName":"Read","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md"},"status":"completed"}
{"type":"text","data":"  \n"}
{"type":"end","stopReason":"end_turn"}
EOF
if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/noreview.jsonl" JSON_OUT="$T/noreview.json" bash "$SCRIPT" >"$T/noreview.log" 2>&1; then
  bad "no review after the read fails"
elif grep -q '::error::grok wrote no review after reading the staged skills' "$T/noreview.log" \
  && ! grep -q 'before reading' "$T/noreview.json"; then
  ok "no review after the read fails"
else
  bad "no review after the read fails"
fi

if STAGED=false IDS='' TRACE="$T/early.jsonl" JSON_OUT="$T/early-unstaged.json" bash "$SCRIPT" >/dev/null \
  && grep -q 'EARLY-GUESS MID-READ LATE-REVIEW' "$T/early-unstaged.json"; then
  ok "unstaged keeps all text"
else
  bad "unstaged keeps all text"
fi

if STAGED=true IDS=$'adhering-to-dry\n' TRACE="$T/miss.jsonl" JSON_OUT="$T/miss2.json" bash "$SCRIPT" >/dev/null 2>&1; then
  bad "missing read posts no ungated text"
elif ! grep -q 'skills loaded' "$T/miss2.json" && grep -q 'end_turn' "$T/miss2.json"; then
  ok "missing read posts no ungated text"
else
  bad "missing read posts no ungated text"
fi

# The uploaded trace is metadata only: no text, rawOutput or content bodies.
META="$ROOT/.github/actions/stage-review-skills/grok-trace-meta.sh"
cat > "$T/raw.jsonl" <<'EOF'
{"type":"text","data":"REVIEW-BODY sk-TESTKEY"}
{"type":"tool_call","toolCallId":"m1","toolName":"Read","kind":"read","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md","extra":"RAW-INPUT-EXTRA"},"status":"in_progress","content":"CONTENT-BODY"}
{"type":"tool_call_update","toolCallId":"m1","status":"completed","rawOutput":"SKILL-BODY sk-TESTKEY","content":[{"text":"CONTENT-BODY"}]}
{"type":"tool_call","toolCallId":"m2","toolName":"Grep","rawInput":{"path":{"nested":"NESTED-PATH"}},"status":"completed"}
{"type":"tool_call","toolCallId":"m3","toolName":"Read","rawInput":{"path":"docs/sk-TESTKEY.md"},"status":"completed"}
{"type":"thought","data":"THOUGHT-BODY"}
not json
{"type":"end","stopReason":"end_turn","usage":{"x":"USAGE-BODY"}}
EOF
cat > "$T/meta-want.jsonl" <<'EOF'
{"type": "tool_call", "toolCallId": "m1", "toolName": "Read", "status": "in_progress", "path": ".agents/skills/adhering-to-dry/SKILL.md"}
{"type": "tool_call_update", "toolCallId": "m1", "status": "completed"}
{"type": "tool_call", "toolCallId": "m2", "toolName": "Grep", "status": "completed"}
{"type": "tool_call", "toolCallId": "m3", "toolName": "Read", "status": "completed", "path": "docs/[REDACTED].md"}
{"type": "end", "stopReason": "end_turn"}
EOF
cp "$T/raw.jsonl" "$T/raw1.jsonl"
if XAI_API_KEY=sk-TESTKEY TRACE="$T/raw1.jsonl" OUT="$T/meta1.jsonl" bash "$META" >/dev/null 2>&1 \
  && [ ! -e "$T/raw1.jsonl" ] && cmp -s "$T/meta-want.jsonl" "$T/meta1.jsonl"; then
  ok "meta trace keeps call metadata only and removes raw"
else
  bad "meta trace keeps call metadata only and removes raw"
fi

cp "$T/raw.jsonl" "$T/raw2.jsonl"
if XAI_API_KEY='' TRACE="$T/raw2.jsonl" OUT="$T/meta2.jsonl" bash "$META" >/dev/null 2>&1 \
  && [ ! -e "$T/raw2.jsonl" ] && grep -q '"m1"' "$T/meta2.jsonl" \
  && ! grep -qE 'SKILL-BODY|CONTENT-BODY|REVIEW-BODY' "$T/meta2.jsonl"; then
  ok "empty key still projects and removes raw"
else
  bad "empty key still projects and removes raw"
fi

cp "$T/raw.jsonl" "$T/raw3.jsonl"
if XAI_API_KEY=k TRACE="$T/raw3.jsonl" OUT="$T/no-such-dir/meta3.jsonl" bash "$META" >"$T/meta3.log" 2>&1; then
  bad "conversion failure deletes both"
elif [ ! -e "$T/raw3.jsonl" ] && [ ! -e "$T/no-such-dir/meta3.jsonl" ] && grep -q '::error::' "$T/meta3.log"; then
  ok "conversion failure deletes both"
else
  bad "conversion failure deletes both"
fi

if XAI_API_KEY=k TRACE="$T/absent.jsonl" OUT="$T/meta4.jsonl" bash "$META" >/dev/null 2>&1 \
  && [ ! -e "$T/meta4.jsonl" ]; then
  ok "missing raw trace is a no-op"
else
  bad "missing raw trace is a no-op"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
