#!/usr/bin/env bash
#
# Contract checks for cli-surface-drift.yml (ENG-8402).
#
# Verifies the reusable workflow's structure against the behavior of the
# per-repo copies it replaces (brutus / nerva / titus cli-surface.yml):
#   1. parameterized on the gate test command, expected test names, doc paths
#   2. fail-closed: every expected test name must appear as --- PASS:
#   3. golden-rewrite check: docs snapshot before/after must be identical
#   4. the parameterized expansion is behaviorally identical to brutus's copy
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="$REPO_ROOT/.github/workflows/cli-surface-drift.yml"
# The brutus reference copy: BRUTUS_FIXTURE (a fetched copy of its
# cli-surface.yml) or BRUTUS_REPO (a clone). No default path — a checkout
# of this repo does not sit beside a brutus clone, and CI fetches the file.
BRUTUS="${BRUTUS_REPO:-}"

# Accept either a full clone (has .git) or a fixture dir carrying only the
# workflow file at .github/workflows/cli-surface.yml (BRUTUS_FIXTURE).
if [ -n "${BRUTUS_FIXTURE:-}" ] && [ -f "$BRUTUS_FIXTURE" ]; then
  BRUTUS_WF="$BRUTUS_FIXTURE"
  HAS_BRUTUS=1
elif [ -n "$BRUTUS" ] \
  && { [ -d "$BRUTUS/.git" ] || [ -f "$BRUTUS/.git" ]; } \
  && [ -f "$BRUTUS/.github/workflows/cli-surface.yml" ]; then
  BRUTUS_WF="$BRUTUS/.github/workflows/cli-surface.yml"
  HAS_BRUTUS=1
else
  HAS_BRUTUS=0
fi

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

echo "cli-surface-drift.test.sh"

# --- workflow_call inputs ---
for input in gate-test-cmd expected-tests doc-paths go-test-cmd-prefix timeout-minutes; do
  if grep -qE "^ +${input}:" "$WF"; then
    ok "workflow_call input: ${input}"
  else
    bad "workflow_call input: ${input}" "no ${input}: under on.workflow_call.inputs"
  fi
done

if grep -F -q 'on:' "$WF" && grep -F -q 'workflow_call:' "$WF"; then
  ok "workflow_call trigger present"
else
  bad "workflow_call trigger present" "reusable workflows need on.workflow_call"
fi

# --- fail-closed test-name assertions (the brutus model) ---
if grep -F -q '"^--- PASS: ${name} "' "$WF"; then
  ok "fail-closed grep anchors on ^--- PASS:"
else
  bad "fail-closed grep anchors on ^--- PASS:" "missing the exact PASS-marker grep"
fi

if grep -F -q 'exit 1' "$WF" && grep -F -q '::error::' "$WF"; then
  ok "missing test name fails the job with ::error::"
else
  bad "missing test name fails the job with ::error::" "no-op gate would pass CI"
fi

# --- golden-rewrite check ---
if grep -qF 'docs.before' "$WF" && grep -qF 'docs.after' "$WF" \
  && grep -qF 'diff -u "$RUNNER_TEMP/docs.before" "$RUNNER_TEMP/docs.after"' "$WF"; then
  ok "snapshot before/after + diff (gate must not rewrite goldens)"
else
  bad "snapshot before/after + diff (gate must not rewrite goldens)" "missing snapshot/diff pair"
fi

# --- expansion equivalence vs the brutus copy (AC: byte-equivalent gate behavior) ---
if [ "$HAS_BRUTUS" -ne 1 ]; then
  # Expected on any checkout without a brutus clone carrying cli-surface.yml;
  # export BRUTUS_FIXTURE=/path/to/cli-surface.yml (or BRUTUS_REPO=clone) to
  # run these checks.
  echo "  SKIP  brutus cli-surface.yml not available (BRUTUS_REPO/BRUTUS_FIXTURE) — expansion-equivalence checks skipped"
else
  # The steps the caller used to own, which the reusable workflow must reproduce.
  # Compare command SUBSTANCE, not byte layout: parameterization splits the
  # test command across inputs.
  for frag in 'sha256sum' 'LC_ALL=C sort' 'tee "$RUNNER_TEMP/gate.log"' \
    'TestCLISurfaceDocLint' 'TestCLISurfaceGateDetectsRename'; do
    if grep -qF "$frag" "$BRUTUS_WF" && grep -qF "$frag" "$WF"; then
      ok "expansion parity: ${frag}"
    else
      bad "expansion parity: ${frag}" "present in one file, absent in the other"
    fi
  done
fi

# --- caller template sanity (README documents the migration) ---
if grep -qF 'cli-surface-drift.yml' "$REPO_ROOT/README.md"; then
  ok "README documents the reusable workflow"
else
  bad "README documents the reusable workflow" "no cli-surface-drift section in README.md"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
