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

printf '%s\n' 'not json' '{"type":"tool_result","output":"FatalTurnLimitedError in a file"}' '{"type":"result","status":"error","error":{"type":"FatalTurnLimitedError","message":"cap"}}' > "$T/trace.jsonl"
printf '%s' 'stderr has the key SECRET' > "$T/err.txt"
if TRACE="$T/trace.jsonl" STDERR="$T/err.txt" DEST="$T/class.txt" STATUS=0 GEMINI_API_KEY=SECRET bash "$SCRIPT" \
  && grep -q 'result_error_type=FatalTurnLimitedError' "$T/class.txt" \
  && ! grep -q 'tool_result' "$T/class.txt" \
  && ! grep -q 'SECRET' "$T/class.txt" \
  && grep -q '\[REDACTED\]' "$T/class.txt"; then
  ok "terminal event only, key scrubbed"
else
  bad "terminal event only, key scrubbed"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
