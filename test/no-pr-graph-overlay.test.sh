#!/usr/bin/env bash
# The review job must not splice a second graphify extract into the fetched graph.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

if [ -e "$REPO_ROOT/.github/actions/overlay-pr-graph" ]; then
  bad "overlay action is absent" "directory still present"
else
  ok "overlay action is absent"
fi

for wf in claude-code.yml codex-code.yml gemini-code.yml grok-code.yml; do
  path="$REPO_ROOT/.github/workflows/$wf"
  if [ ! -f "$path" ]; then
    bad "$wf does not splice a PR graph" "missing workflow"
    continue
  fi
  if grep -E -q 'overlay-pr-graph|overlay=applied|pr-head-notes' "$path"; then
    bad "$wf does not splice a PR graph" "overlay reference remains"
  elif ! awk '/GRAPH:/ && /default-branch graph only/ { hit=1 } END { exit(hit ? 0 : 1) }' "$path"; then
    bad "$wf does not splice a PR graph" "GRAPH prompt missing default-branch graph only"
  else
    ok "$wf does not splice a PR graph"
  fi
done

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
