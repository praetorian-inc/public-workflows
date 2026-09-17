#!/usr/bin/env bash
#
# Contract checks for the Grok reviewer graphify allowlist (ENG-8335).
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

for prefix in "graphify query" "graphify explain" "graphify path"; do
  needle="--allow 'Bash(${prefix}:*)'"
  if grep -F -q -- "$needle" "$WF"; then
    ok "allows $needle"
  else
    bad "allows $needle" "missing from $WF"
  fi
done

if grep -E -q '^[[:space:]]*--deny Bash([[:space:]]|\\|$)' "$WF"; then
  bad "no global --deny Bash" "global Bash deny would win over graphify --allow"
else
  ok "no global --deny Bash"
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

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
