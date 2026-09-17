#!/usr/bin/env bash
#
# Contract checks for the Grok reviewer tool surface (ENG-8335).
# Greps grok-code.yml — no network, no grok CLI.
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="$REPO_ROOT/.github/workflows/grok-code.yml"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

if [ ! -f "$WF" ]; then
  echo "ERROR: missing $WF" >&2
  exit 1
fi

echo "grok-graphify-tools.test.sh"

allows="$(grep -E '^[[:space:]]*--allow ' "$WF" || true)"
if [ -n "$allows" ]; then
  bad "no --allow rules" "found: $allows"
else
  ok "no --allow rules"
fi

if grep -E -q '^[[:space:]]*--deny Bash([[:space:]]|\\|$)' "$WF"; then
  ok "global --deny Bash"
else
  bad "global --deny Bash" "missing command-line --deny Bash"
fi

if grep -q '^  fetch-graph:' "$WF"; then
  ok "fetch-graph job exists"
else
  bad "fetch-graph job exists" "no fetch-graph: job in $WF"
fi

if grep -q 'Neutralize PR-planted graphify-out' "$WF"; then
  ok "neutralize planted graphify-out"
else
  bad "neutralize planted graphify-out" "step missing"
fi

if grep -q 'graphifyy==' "$WF"; then
  ok "pinned graphifyy install"
else
  bad "pinned graphifyy install" "no graphifyy== pin"
fi

if awk '
  /Install graphify CLI \(pinned, fail-open\)/ { in_step=1 }
  in_step && /name: Build review context/ { exit }
  in_step && /graphify CLI install failed/ { saw_warn=1 }
  in_step && saw_warn && /rm -rf graphify-out/ { found=1 }
  END { exit(found ? 0 : 1) }
' "$WF"; then
  ok "install-failure removes graphify-out"
else
  bad "install-failure removes graphify-out" "else branch has warning but no rm -rf graphify-out"
fi

if grep -F -q -- '--deny Write' "$WF" && grep -F -q -- '--deny Edit' "$WF"; then
  ok "denies Write and Edit"
else
  bad "denies Write and Edit" "missing write-side deny"
fi

if grep -F -q -- '-iname '\''.claude'\''' "$WF" && grep -F -q 'CLAUDE.md' "$WF" && grep -F -q '.mcp.json' "$WF"; then
  ok "purge covers Claude compat + mcp.json"
else
  bad "purge covers Claude compat + mcp.json" "CLAUDE.md / .claude / .mcp.json missing from purge"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
