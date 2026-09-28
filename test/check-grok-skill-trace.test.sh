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
{"type":"tool_call","toolName":"read_file","rawInput":{"path":".agents/skills/adhering-to-dry/SKILL.md"}}
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

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
