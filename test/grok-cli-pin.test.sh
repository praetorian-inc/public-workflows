#!/usr/bin/env bash
#
# Contract checks for the Grok reviewer CLI pin + turn cap (ENG-8335).
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="$REPO_ROOT/.github/workflows/grok-code.yml"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

echo "grok-cli-pin.test.sh"

if grep -F -q 'GROK_VERSION: "1.0.34"' "$WF"; then
  ok "CLI pin is 1.0.34"
else
  bad "CLI pin is 1.0.34" "$(grep -n GROK_VERSION "$WF" || true)"
fi

if grep -F -q 'GROK_SHA256: "be5905e107d2b8b5f3c142d21ecfe4c8fd32a913d2fd551b788707930c4dc80d"' "$WF"; then
  ok "uncompressed sha256 pin present"
else
  bad "uncompressed sha256 pin present" "GROK_SHA256 missing or drifted"
fi

if grep -F -q 'GROK_ZST_SHA256: "6a7946271eb4887f6c07bd4e637628194cf7f13dd5c4dcaadfc47ecdeae06ff1"' "$WF"; then
  ok "zst sha256 pin present"
else
  bad "zst sha256 pin present" "GROK_ZST_SHA256 missing or drifted"
fi

if grep -F -q 'curl -fsSL https://x.ai/cli/install.sh' "$WF" || grep -F -q 'install.sh | bash' "$WF"; then
  bad "no curl|bash installer" "unpinned installer present"
else
  ok "no curl|bash installer"
fi

if grep -F -q 'default: "grok-4.6"' "$WF"; then
  ok "default model is grok-4.6"
else
  bad "default model is grok-4.6" "$(grep -n 'default:' "$WF" | head -5 || true)"
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

if grep -F -q -- '--no-auto-update' "$WF"; then
  ok "no-auto-update flag"
else
  bad "no-auto-update flag" "missing --no-auto-update"
fi

if grep -F -q -- '--permission-mode dontAsk' "$WF"; then
  ok "permission-mode dontAsk"
else
  bad "permission-mode dontAsk" "missing"
fi

if grep -F -q -- '--sandbox strict' "$WF"; then
  ok "sandbox strict"
else
  bad "sandbox strict" "missing"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
