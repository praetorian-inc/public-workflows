#!/usr/bin/env bash
#
# Contract checks for Gemini CLI pin + ENG-6428 turn cap (ENG-7656 / ENG-6428).
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="$REPO_ROOT/.github/workflows/gemini-code.yml"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

echo "gemini-cli-pin.test.sh"

if grep -q 'gemini_cli_version: "0.58.0"' "$WF"; then
  ok "CLI pin is 0.58.0"
else
  bad "CLI pin is 0.58.0" "$(grep -n gemini_cli_version "$WF" || true)"
fi

if grep -q 'gemini_cli_version: "0.45.2"' "$WF"; then
  bad "no leftover 0.45.2 pin" "0.45.2 still present"
else
  ok "no leftover 0.45.2 pin"
fi

if grep -q 'id: turns' "$WF"; then
  ok "size-aware turns step"
else
  bad "size-aware turns step" "no id: turns"
fi

if grep -q 'maxSessionTurns": ${{ steps.turns.outputs.n }}' "$WF"; then
  ok "maxSessionTurns from turns output"
else
  bad "maxSessionTurns from turns output" "still a constant?"
fi

if grep -q 'ci-review-deny.toml' "$WF"; then
  ok "policy-engine deny file"
else
  bad "policy-engine deny file" "no ci-review-deny.toml"
fi

if grep -q 'id: purged' "$WF"; then
  ok "purged-paths step"
else
  bad "purged-paths step" "no id: purged"
fi

if grep -q 'kind=turn_limit' "$WF"; then
  ok "turn-limit failure classification"
else
  bad "turn-limit failure classification" "no kind=turn_limit"
fi

if grep -q 'FatalTurnLimitedError' "$WF"; then
  ok "fallback names FatalTurnLimitedError"
else
  bad "fallback names FatalTurnLimitedError" "notice still generic-only"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
