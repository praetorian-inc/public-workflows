#!/usr/bin/env bash
#
# Tests for the instruction-file discovery in
# .github/workflows/agents-md-drift.yml.
#
# The scripts under test are EXTRACTED from the workflow YAML at run time and
# executed against throwaway git fixture repositories. Nothing in this file
# re-implements or mirrors the workflow's logic: a mirror cannot discriminate
# between a working implementation and a broken one.
#
# Two `run:` blocks are exercised:
#   * jobs['pre-filter'].steps[id=check]  — the whole pre-filter
#   * jobs['drift-check'].steps[id=scope] — its fail-open inventory branch
#
# Runtime notes:
#   * The fixtures have full local history, so `git merge-base` succeeds
#     immediately and the deepen ladder never fires.
#   * `git fetch origin ...` fails fast (the fixtures have no remote) and is
#     `|| true`-tolerated. On a host without coreutils `timeout` the fetch
#     helper exits 127 instead, which lands in the same tolerated path.
#
# Usage: bash test/agents-md-drift-prefilter.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORKFLOW="$REPO_ROOT/.github/workflows/agents-md-drift.yml"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

EXTRACT="$WORKDIR/extracted"
mkdir -p "$EXTRACT"

PASS=0
FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  printf '          expected: [%s]\n' "$2"
  printf '          actual:   [%s]\n' "$3"
  FAIL=$((FAIL + 1))
}
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── Extract the real run: blocks out of the workflow YAML ────────────────────
section "Extracting run: blocks from $(basename "$WORKFLOW")"

python3 - "$WORKFLOW" "$EXTRACT" <<'PY' || { echo "ERROR: extraction failed" >&2; exit 1; }
import pathlib
import sys

import yaml

wf = yaml.safe_load(open(sys.argv[1]))
out = pathlib.Path(sys.argv[2])


def step_run(job, step_id):
    for st in wf["jobs"][job]["steps"]:
        if st.get("id") == step_id:
            return st["run"]
    raise SystemExit("step not found: %s / id=%s" % (job, step_id))


for job, step_id, name in (
    ("pre-filter", "check", "prefilter.sh"),
    ("drift-check", "scope", "scope.sh"),
):
    body = step_run(job, step_id)
    if "${{" in body:
        raise SystemExit(
            "%s/%s contains a ${{ }} expression; it cannot be executed "
            "standalone and this harness would be testing a lie" % (job, step_id)
        )
    (out / name).write_text(body)

# YAML 1.1 resolves the bare key `on` to the boolean True.
wc = wf[True] if True in wf else wf["on"]
(out / "skip_extensions.txt").write_text(
    wc["workflow_call"]["inputs"]["skip_extensions"]["default"]
)
print("  extracted: prefilter.sh (%d lines), scope.sh (%d lines)" % (
    len(step_run("pre-filter", "check").splitlines()),
    len(step_run("drift-check", "scope").splitlines()),
))
PY

SKIP_EXT="$(cat "$EXTRACT/skip_extensions.txt")"
printf '  skip_extensions default: %s\n' "$SKIP_EXT"

# ── Syntax gates ─────────────────────────────────────────────────────────────
section "Syntax checks"
for s in prefilter.sh scope.sh; do
  if bash -n "$EXTRACT/$s" 2>"$WORKDIR/$s.syn"; then
    ok "bash -n $s"
  else
    bad "bash -n $s" "clean parse" "$(cat "$WORKDIR/$s.syn")"
  fi
done

# actionlint is not clean on the pre-existing workflow: three SC2001 *style*
# notices fire on `echo "$var" | sed 's/^/  /'` log-indentation lines that this
# change does not touch. Pin that count as a baseline instead of demanding a
# clean run, and require zero findings of any other class — so any lint this
# change introduces still fails the suite.
SC2001_BASELINE=3
if command -v actionlint >/dev/null 2>&1; then
  al_out="$(actionlint "$WORKFLOW" 2>&1)"
  n_sc2001="$(printf '%s\n' "$al_out" | grep -c 'SC2001')"
  n_other="$(printf '%s\n' "$al_out" | grep 'shellcheck reported\|^\.github/' | grep -vc 'SC2001')"
  assert_eq "actionlint: no non-SC2001 findings" "0" "$n_other"
  if [ "$n_sc2001" -le "$SC2001_BASELINE" ]; then
    ok "actionlint: SC2001 count $n_sc2001 <= pre-existing baseline $SC2001_BASELINE"
  else
    bad "actionlint: SC2001 count" "<= $SC2001_BASELINE" "$n_sc2001"
  fi
  [ "$n_other" -eq 0 ] || printf '%s\n' "$al_out"
else
  printf '  \033[33mSKIP\033[0m  actionlint not installed\n'
fi

# ── Fixture helpers ──────────────────────────────────────────────────────────
STUB=$'@AGENTS.md\n'   # the 11-byte pointer stub converted repos leave behind

newrepo() {
  local d="$WORKDIR/repo-$1"
  rm -rf -- "$d"
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" config user.email tester@example.invalid
  git -C "$d" config user.name  Tester
  git -C "$d" config commit.gpgsign false
  printf '%s' "$d"
}

put() { # put <repo> <relpath> <content>
  mkdir -p "$(dirname -- "$1/$2")"
  printf '%s' "$3" > "$1/$2"
}

snap() { # snap <repo> <msg> -> prints the commit sha
  git -C "$1" add -A
  git -C "$1" commit -q -m "$2"
  git -C "$1" rev-parse HEAD
}

OUT=""
LOG=""
RC=0

run_prefilter() { # run_prefilter <repo> <base_sha> <head_sha>
  OUT="$WORKDIR/out.$$.$RANDOM"
  LOG="$OUT.log"
  : > "$OUT"
  (
    cd "$1" || exit 1
    SKIP_EXTENSIONS="$SKIP_EXT" \
    GH_TOKEN=dummy \
    REPO=dummy/dummy \
    BASE_SHA="$2" \
    HEAD_SHA="$3" \
    GITHUB_OUTPUT="$OUT" \
      bash "$EXTRACT/prefilter.sh"
  ) > "$LOG" 2>&1
  RC=$?
}

run_scope() { # run_scope <repo> <base_sha> <head_sha> <pre_filter_result> <relevant_mds>
  OUT="$WORKDIR/out.$$.$RANDOM"
  LOG="$OUT.log"
  : > "$OUT"
  (
    cd "$1" || exit 1
    GH_TOKEN=dummy \
    BASE_SHA="$2" \
    HEAD_SHA="$3" \
    BASE_REF=main \
    PRE_FILTER_RESULT="$4" \
    RELEVANT_MDS="$5" \
    GITHUB_OUTPUT="$OUT" \
      bash "$EXTRACT/scope.sh"
  ) > "$LOG" 2>&1
  RC=$?
}

outv() { # outv <key> — last value written for that GITHUB_OUTPUT key
  grep -E "^$1=" "$OUT" 2>/dev/null | tail -1 | sed "s/^$1=//"
}

# ═════════════════════════════════════════════════════════════════════════════
section "Case 1 — converted repo, nested: stub resolves to its sibling AGENTS.md"
r="$(newrepo converted-nested)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" ui/src/components/CLAUDE.md "$STUB"
put "$r" ui/src/components/AGENTS.md $'# components\ncomponent instructions\n'
put "$r" ui/src/components/foo.go $'package components\n'
base="$(snap "$r" base)"
put "$r" ui/src/components/foo.go $'package components\n\nfunc New() {}\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case1 should_run"   "true" "$(outv should_run)"
assert_eq "case1 relevant_mds" "ui/src/components/AGENTS.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 2 — unconverted repo (regression): nearest CLAUDE.md, as before"
r="$(newrepo unconverted)"
put "$r" CLAUDE.md $'# root\nroot instructions\n'
put "$r" backend/CLAUDE.md $'# backend\nbackend instructions\n'
put "$r" backend/main.go $'package main\n'
base="$(snap "$r" base)"
put "$r" backend/main.go $'package main\n\nfunc main() {}\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case2 should_run"   "true" "$(outv should_run)"
assert_eq "case2 relevant_mds" "backend/CLAUDE.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 3 — AGENTS.md-only repo (no CLAUDE.md anywhere)"
r="$(newrepo agents-only)"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" pkg/AGENTS.md $'# pkg\npkg instructions\n'
put "$r" pkg/x.go $'package pkg\n'
base="$(snap "$r" base)"
put "$r" pkg/x.go $'package pkg\n\nvar X = 1\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case3 should_run"   "true" "$(outv should_run)"
assert_eq "case3 relevant_mds" "pkg/AGENTS.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 4 — both carry real content: BOTH files are in scope"
r="$(newrepo both-content)"
put "$r" svc/CLAUDE.md $'# svc claude\nreal content, NOT a pointer stub\n'
put "$r" svc/AGENTS.md $'# svc agents\nalso real content\n'
put "$r" svc/s.go $'package svc\n'
base="$(snap "$r" base)"
put "$r" svc/s.go $'package svc\n\nfunc Serve() {}\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case4 should_run"   "true" "$(outv should_run)"
assert_eq "case4 relevant_mds" "svc/AGENTS.md,svc/CLAUDE.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 5 — broken pointer (stub, no sibling): conservatively kept"
r="$(newrepo broken-pointer)"
put "$r" lib/CLAUDE.md "$STUB"
put "$r" lib/l.go $'package lib\n'
base="$(snap "$r" base)"
put "$r" lib/l.go $'package lib\n\nfunc L() {}\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case5 should_run"   "true" "$(outv should_run)"
assert_eq "case5 relevant_mds" "lib/CLAUDE.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 6 — AC3: a .md-only PR still skips (skip_extensions unchanged)"
r="$(newrepo skip-extensions)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" ui/src/components/CLAUDE.md "$STUB"
put "$r" ui/src/components/AGENTS.md $'# components\ncomponent instructions\n'
put "$r" ui/src/components/foo.go $'package components\n'
base="$(snap "$r" base)"
put "$r" README.md $'# readme\nnew docs\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case6 should_run"   "false" "$(outv should_run)"
assert_eq "case6 relevant_mds" ""      "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 7a — Step 5 contrast: code-only change reaches analysis"
r="$(newrepo step5-code-only)"
put "$r" pkg/CLAUDE.md "$STUB"
put "$r" pkg/AGENTS.md $'# pkg\npkg instructions\n'
put "$r" pkg/x.go $'package pkg\n'
base="$(snap "$r" base)"
put "$r" pkg/x.go $'package pkg\n\nvar X = 1\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case7a should_run"   "true"          "$(outv should_run)"
assert_eq "case7a relevant_mds" "pkg/AGENTS.md" "$(outv relevant_mds)"
if grep -qF "Relevant instruction files for drift check: pkg/AGENTS.md" "$LOG"; then
  ok "case7a emitted the code-only analysis log"
else
  bad "case7a emitted the code-only analysis log" "the ordinary analysis log for pkg/AGENTS.md" "$(cat "$LOG")"
fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 7b — Step 5 regression: code plus its nearest instruction file still reaches semantic analysis"
r="$(newrepo step5-code-and-instruction)"
put "$r" pkg/CLAUDE.md "$STUB"
put "$r" pkg/AGENTS.md $'# pkg\npkg instructions\n'
put "$r" pkg/x.go $'package pkg\n'
base="$(snap "$r" base)"
put "$r" pkg/x.go $'package pkg\n\nvar X = 1\n'
put "$r" pkg/AGENTS.md $'# pkg\npkg instructions\n\nX is now exported.\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case7b should_run"   "true"          "$(outv should_run)"
assert_eq "case7b relevant_mds" "pkg/AGENTS.md" "$(outv relevant_mds)"
if grep -qF "semantic adequacy analysis" "$LOG"; then
  ok "case7b emitted the edited-instruction semantic-analysis log"
else
  bad "case7b emitted the edited-instruction semantic-analysis log" "a log containing 'semantic adequacy analysis'" "$(cat "$LOG")"
fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 8 — pre-filter fail-open: unresolvable base SHA => full inventory"
r="$(newrepo fail-open)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" ui/src/components/CLAUDE.md "$STUB"
put "$r" ui/src/components/AGENTS.md $'# components\ncomponent instructions\n'
put "$r" ui/src/components/foo.go $'package components\n'
base="$(snap "$r" base)"
put "$r" ui/src/components/foo.go $'package components\n\nfunc New() {}\n'
head="$(snap "$r" head)"
run_prefilter "$r" "0000000000000000000000000000000000000000" "$head"
assert_eq "case8 should_run"   "true" "$(outv should_run)"
assert_eq "case8 relevant_mds" "AGENTS.md,ui/src/components/AGENTS.md" "$(outv relevant_mds)"
if grep -q "fail-open" "$LOG"; then
  ok "case8 emitted the fail-open warning"
else
  bad "case8 emitted the fail-open warning" "a ::warning ...fail-open..." "$(cat "$LOG")"
fi
# Unused, but proves the base SHA above really is absent from this fixture.
: "$base"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 9 — drift-check scope step fail-open => full inventory"
r="$(newrepo scope-fail-open)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" ui/src/components/CLAUDE.md "$STUB"
put "$r" ui/src/components/AGENTS.md $'# components\ncomponent instructions\n'
put "$r" ui/src/components/foo.go $'package components\n'
base="$(snap "$r" base)"
put "$r" ui/src/components/foo.go $'package components\n\nfunc New() {}\n'
head="$(snap "$r" head)"
run_scope "$r" "$base" "$head" failure ""
assert_eq "case9 scope relevant_mds" "AGENTS.md,ui/src/components/AGENTS.md" "$(outv relevant_mds)"
assert_eq "case9 scope skip"         ""                                      "$(outv skip)"
assert_eq "case9 scope exit code"    "0"                                     "$RC"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 10 — drift-check scope step passes a supplied list straight through"
run_scope "$r" "$base" "$head" success "ui/src/components/AGENTS.md"
assert_eq "case10 scope relevant_mds" "ui/src/components/AGENTS.md" "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 11 — root-level code change hits the \".\" special case"
r="$(newrepo root-level)"
put "$r" CLAUDE.md "$STUB"
put "$r" AGENTS.md $'# root\nroot instructions\n'
put "$r" main.go $'package main\n'
base="$(snap "$r" base)"
put "$r" main.go $'package main\n\nfunc main() {}\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case11 should_run"   "true"        "$(outv should_run)"
assert_eq "case11 relevant_mds" "AGENTS.md"   "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 12 — walk exhausts to the root without a hit => skip"
r="$(newrepo no-ancestor)"
put "$r" pkg/AGENTS.md $'# pkg\npkg instructions\n'
put "$r" pkg/CLAUDE.md "$STUB"
put "$r" main.go $'package main\n'
base="$(snap "$r" base)"
put "$r" main.go $'package main\n\nfunc main() {}\n'
head="$(snap "$r" head)"
run_prefilter "$r" "$base" "$head"
assert_eq "case12 should_run"   "false" "$(outv should_run)"
assert_eq "case12 relevant_mds" ""      "$(outv relevant_mds)"

# ═════════════════════════════════════════════════════════════════════════════
printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
