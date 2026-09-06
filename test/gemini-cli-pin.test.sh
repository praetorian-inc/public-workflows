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

if grep -F -q 'gemini_cli_version: "0.58.0"' "$WF"; then
  ok "CLI pin is 0.58.0"
else
  bad "CLI pin is 0.58.0" "$(grep -n gemini_cli_version "$WF" || true)"
fi

if grep -F -q 'gemini_cli_version: "0.45.2"' "$WF"; then
  bad "no leftover 0.45.2 pin" "0.45.2 still present"
else
  ok "no leftover 0.45.2 pin"
fi

if grep -F -q 'id: turns' "$WF"; then
  ok "size-aware turns step"
else
  bad "size-aware turns step" "no id: turns"
fi

if grep -F -q 't=$((50 + n * 3))' "$WF"; then
  ok "turn formula 50 + 3*n"
else
  bad "turn formula 50 + 3*n" "formula missing"
fi

if grep -F -q 'if [ "${t}" -gt 80 ]' "$WF"; then
  ok "turn cap 80"
else
  bad "turn cap 80" "cap missing"
fi

if grep -F -q 'maxSessionTurns": ${{ steps.turns.outputs.n }}' "$WF"; then
  ok "maxSessionTurns from turns output"
else
  bad "maxSessionTurns from turns output" "still a constant?"
fi

if grep -F -q 'ci-review-deny.toml' "$WF"; then
  ok "policy-engine deny file"
else
  bad "policy-engine deny file" "no ci-review-deny.toml"
fi

DENY="$(awk '/ci-review-deny.toml/,/^[[:space:]]*EOF$/' "$WF")"
if printf '%s\n' "$DENY" | grep -F -q 'decision = "deny"' \
  && printf '%s\n' "$DENY" | grep -F -q 'write_file' \
  && ! printf '%s\n' "$DENY" | grep -F -q 'run_shell_command'; then
  ok "deny policy lists write/web not shell"
else
  bad "deny policy lists write/web not shell" "deny=$DENY"
fi

if grep -F -q 'id: purged' "$WF"; then
  ok "purged-paths step"
else
  bad "purged-paths step" "no id: purged"
fi

if grep -F -q 'kind=turn_limit' "$WF"; then
  ok "turn-limit failure classification"
else
  bad "turn-limit failure classification" "no kind=turn_limit"
fi

if grep -F -q 'steps.sanitize.outcome == '"'"'failure'"'" "$WF" \
  && grep -F -q 'steps.gemini.outputs.summary' "$WF"; then
  ok "failclass runs on sanitizer fail and reads summary"
else
  bad "failclass runs on sanitizer fail and reads summary" "classifier still gemini-only/error-only"
fi

if grep -F -q 'FatalTurnLimitedError' "$WF"; then
  ok "fallback names FatalTurnLimitedError"
else
  bad "fallback names FatalTurnLimitedError" "notice still generic-only"
fi

if grep -F -q 'Retrying the same PR is likely unhelpful' "$WF"; then
  ok "turn-limit notice does not forbid retry as impossible"
else
  bad "turn-limit notice does not forbid retry as impossible" "still says will hit the same cap"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
