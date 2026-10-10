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

ALLOWED_MCP="query_graph get_node get_neighbors get_community god_nodes graph_stats shortest_path"
DENIED_MCP="list_prs get_pr_impact triage_prs"

allows="$(grep -E '^[[:space:]]*--allow ' "$WF" | sed -E 's/^[[:space:]]+//; s/[[:space:]]*\\$//' | sort || true)"
want_allows="$(for t in $ALLOWED_MCP; do printf -- "--allow 'MCPTool(graphify__%s)'\n" "$t"; done | sort)"
if [ "$allows" = "$want_allows" ]; then
  ok "only the read-only graphify MCP tools are allowed"
else
  bad "only the read-only graphify MCP tools are allowed" "found: $allows"
fi

for t in $DENIED_MCP; do
  if grep -E -q -- "^[[:space:]]*--deny 'MCPTool\(graphify__${t}\)'" "$WF"; then
    ok "denies gh-backed graphify__${t}"
  else
    bad "denies gh-backed graphify__${t}" "missing --deny 'MCPTool(graphify__${t})'"
  fi
done

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

# shellcheck disable=SC2016  # literal workflow text, not an expansion
if grep -F -q 'graphifyy[mcp]==${GRAPHIFY_VERSION}' "$WF" && grep -E -q 'GRAPHIFY_VERSION: "0\.8\.35"' "$WF"; then
  ok "pinned graphifyy[mcp] install"
else
  bad "pinned graphifyy[mcp] install" "no graphifyy[mcp]==0.8.35 pin"
fi

if grep -E -q 'MCP_VERSION: "[0-9]+\.[0-9]+\.[0-9]+"' "$WF" && grep -F -q -- '--constraint=' "$WF"; then
  ok "mcp is pinned exactly via a pip constraint"
else
  bad "mcp is pinned exactly via a pip constraint" "no MCP_VERSION pin or --constraint"
fi

if awk '
  /Install graphify MCP server \(pinned, fail-open\)/ { in_step=1 }
  in_step && /name: Build review context/ { exit }
  in_step && /graphify MCP server install failed/ { saw_warn=1 }
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

# Run Grok step body, from its name to the next step.
run_step="$(awk '/- name: Run Grok PR Review/ { on=1 } on && /- name: Sanitize review output/ { exit } on { print }' "$WF")"

# shellcheck disable=SC2016  # literal workflow text, not an expansion
if printf '%s\n' "$run_step" | grep -F -q '${GROK_HOME}/config.toml' &&
   printf '%s\n' "$run_step" | grep -F -q 'mcp_servers.graphify' &&
   printf '%s\n' "$run_step" | grep -F -q 'graphify.serve'; then
  ok "graphify MCP server registered in GROK_HOME/config.toml"
else
  bad "graphify MCP server registered in GROK_HOME/config.toml" "config.toml write missing from Run Grok"
fi

if printf '%s\n' "$run_step" | grep -F -q 'command = "/usr/bin/env"' &&
   printf '%s\n' "$run_step" | grep -F -q 'args = ["-i", "PATH=' &&
   ! printf '%s\n' "$run_step" | grep -F -q 'mcp_servers.graphify.env'; then
  ok "graphify server starts with a minimal env (env -i)"
else
  bad "graphify server starts with a minimal env (env -i)" "Grok servers inherit the parent env, including XAI_API_KEY"
fi

if printf '%s\n' "$run_step" | awk '
  /rm -f -- "\$GRAPHIFY_QUERY_LOG"/ { reset=NR }
  /^[[:space:]]*grok \\$/ { run=NR }
  END { exit(reset && run && reset < run ? 0 : 1) }'; then
  ok "query log is reset just before grok runs"
else
  bad "query log is reset just before grok runs" "no rm -f of GRAPHIFY_QUERY_LOG before the grok invocation"
fi

if printf '%s\n' "$run_step" | grep -F -q 'FORMAT=querylog' &&
   printf '%s\n' "$run_step" | grep -F -q '[ -s graphify-out/graph.json ]'; then
  ok "querylog gate runs when the graph is present"
else
  bad "querylog gate runs when the graph is present" "no FORMAT=querylog gate keyed on graphify-out/graph.json"
fi

# ENG-8892: the gate applies the warranted rule to the pre-agent list copies.
# shellcheck disable=SC2016  # literal workflow text, not an expansion
if printf '%s\n' "$run_step" | grep -F 'REQUIRED=true FORMAT=querylog' | grep -F -q 'CHANGED_FILES="$RUNNER_TEMP/graphify-changed-files.txt" ADDED_FILES="$RUNNER_TEMP/graphify-added-files.txt"'; then
  ok "querylog gate passes the changed and added lists"
else
  bad "querylog gate passes the changed and added lists" "gate does not pass CHANGED_FILES/ADDED_FILES"
fi

move_step="$(awk '/- name: Move Grok trace checker out of the review tree/ { on=1; print; next } on && /- name: / { exit } on { print }' "$WF")"
if printf '%s\n' "$move_step" | grep -F -q 'DECIDE_ONLY=true'; then
  ok "graphify decision is logged before the review"
else
  bad "graphify decision is logged before the review" "no DECIDE_ONLY=true in the pre-agent checker step"
fi

# The decision log is advisory (the gate after the review decides), so a
# checker exit 2 there must not fail the job. Run the step's decision block
# under the step's own strict mode against a stub checker that exits 2.
decide_block="$(printf '%s\n' "$move_step" | awk '/# ENG-8892: log/ { on=1 } on { print } on && /^[[:space:]]*fi$/ { exit }' | sed 's/^[[:space:]]*//')"
dt="$(mktemp -d)"
mkdir -p "$dt/graphify-out"
printf '{"nodes":[]}\n' > "$dt/graphify-out/graph.json"
printf '#!/usr/bin/env bash\necho "::error::stub cannot evaluate"\nexit 2\n' > "$dt/check-graphify-use.sh"
decide_out="$(cd -- "$dt" && RUNNER_TEMP="$dt" bash -c "set -euo pipefail
$decide_block" 2>&1)"
decide_rc=$?
rm -rf -- "$dt"
if [ -n "$decide_block" ] && [ "$decide_rc" -eq 0 ] && grep -F -q '::warning::' <<<"$decide_out"; then
  ok "decision log failure is non-fatal"
else
  bad "decision log failure is non-fatal" "rc=$decide_rc out=$decide_out"
fi

if grep -E -q 'FORMAT=grok|pr-head-notes|review-graph-notes' "$WF"; then
  bad "Grok notes machinery removed" "FORMAT=grok / pr-head-notes / review-graph-notes still referenced"
else
  ok "Grok notes machinery removed"
fi

if grep -E -q 'GROK_CURSOR_MCPS_ENABLED: "false"' "$WF" && grep -E -q 'GROK_CLAUDE_MCPS_ENABLED: "false"' "$WF"; then
  ok "compat MCP sources disabled"
else
  bad "compat MCP sources disabled" "GROK_CURSOR_MCPS_ENABLED / GROK_CLAUDE_MCPS_ENABLED not false"
fi

if printf '%s\n' "$run_step" | grep -E 'GRAPH:' | grep -F -q 'query_graph'; then
  ok "prompt requires query_graph"
else
  bad "prompt requires query_graph" "GRAPH prompt does not name query_graph"
fi

if awk '/- name: Purge PR-supplied agent config/ { p=NR } /- name: Run Grok PR Review/ { r=NR } END { exit(p && r && p < r ? 0 : 1) }' "$WF"; then
  ok "purge runs before Grok"
else
  bad "purge runs before Grok" "Purge step missing or after Run Grok"
fi

# The workspace is the PR tree: without -I, python puts the cwd first on
# sys.path, so a PR-planted json.py / graphify/ would run (with XAI_API_KEY
# in the config writer's env, or as the MCP server itself).
# shellcheck disable=SC2016  # literal workflow text, not an expansion
if printf '%s\n' "$run_step" | grep -F -q 'python3 -I - "${GROK_HOME}/config.toml"' &&
   printf '%s\n' "$run_step" | grep -F -q 'py, "-I", "-m", "graphify.serve"' &&
   grep -F -q '"$py" -I -c '\''import importlib.metadata' "$WF"; then
  ok "workspace python runs isolated (-I): config writer, server, install check"
else
  bad "workspace python runs isolated (-I): config writer, server, install check" "a python invocation in the PR workspace lacks -I"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
