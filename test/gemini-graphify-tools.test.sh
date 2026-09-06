#!/usr/bin/env bash
#
# Contract checks for the Gemini reviewer graphify shell allowlist (ENG-7654).
# Greps gemini-code.yml — no network, no Gemini CLI.
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="$REPO_ROOT/.github/workflows/gemini-code.yml"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

if [ ! -f "$WF" ]; then
  echo "ERROR: missing $WF" >&2
  exit 1
fi

echo "gemini-graphify-tools.test.sh"

# Extract the tools.core JSON array (single line in settings).
CORE="$(grep -oE '"core": \[[^]]+\]' "$WF" | head -1 || true)"
if [ -z "$CORE" ]; then
  bad "tools.core present" "no \"core\": [...] in $WF"
else
  ok "tools.core present"
fi

for prefix in "graphify query" "graphify explain" "graphify path"; do
  needle="run_shell_command(${prefix})"
  if printf '%s\n' "$CORE" | grep -F -q "$needle"; then
    ok "core lists $needle"
  else
    bad "core lists $needle" "core=$CORE"
  fi
done

# Bare wildcard must not appear inside the core array.
if printf '%s\n' "$CORE" | grep -E -q '"run_shell_command"'; then
  bad "core has no bare run_shell_command" "core=$CORE"
else
  ok "core has no bare run_shell_command"
fi

if grep -q 'grep_search' <<<"$CORE"; then
  ok "core keeps grep_search"
else
  bad "core keeps grep_search" "core=$CORE"
fi

EXCLUDE="$(grep -oE '"exclude": \[[^]]+\]' "$WF" | head -1 || true)"
if printf '%s\n' "$EXCLUDE" | grep -E -q '"run_shell_command"'; then
  bad "exclude has no run_shell_command wildcard" "exclude=$EXCLUDE"
else
  ok "exclude has no run_shell_command wildcard"
fi

if grep -q 'job: fetch-graph' "$WF" || grep -q '^  fetch-graph:' "$WF"; then
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

# Install-failure path must drop the restored graph so the prompt cannot
# send the agent at a missing binary (ENG-7654 / CodeRabbit).
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

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
