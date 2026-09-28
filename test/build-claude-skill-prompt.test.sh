#!/usr/bin/env bash
# Tests for build-claude-skill-prompt.sh (ENG-8648).
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO_ROOT/.github/actions/stage-review-skills/build-claude-skill-prompt.sh"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }
check() {
  local name=$1 detail=$2
  shift 2
  if "$@"; then ok "$name"; else bad "$name" "$detail"; fi
}
absent() { ! grep -F -q -- "$1" "$2"; }
no_slash_line() { ! grep -q '^/' "$1"; }

read_multi() {
  local file=$1 key=$2
  awk -v k="$key" '
    index($0, k "<<") == 1 { d = substr($0, length(k) + 3); on = 1; next }
    on && $0 == d { exit }
    on { print }
  ' "$file"
}

run_case() {
  local dir=$1 staged=$2
  : > "$dir/github_output"
  STAGED="$staged" DEST="$dir/skills" GITHUB_OUTPUT="$dir/github_output" \
    PROMPT_OUT="$dir/prompt.txt" \
    bash "$SCRIPT" >"$dir/log" 2>&1
  echo "$?" > "$dir/rc"
}

skill() {
  local dir=$1 id=$2 body=$3
  mkdir -p "$dir/skills/$id"
  printf '%s\n' "$body" > "$dir/skills/$id/SKILL.md"
}

section() { printf '\n%s\n' "$1"; }

section "1. not staged"
T="$WORKDIR/t1"
mkdir -p "$T"
run_case "$T" false
check "not staged exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
read_multi "$T/github_output" prompt > "$T/parsed.txt"
check "not staged writes the no-skills prefix" "prompt=$(cat "$T/parsed.txt")" \
  [ "$(cat "$T/parsed.txt")" = "No curated skills were staged. Review without them." ]
check "not staged does not emit a slash id" "prompt=$(cat "$T/parsed.txt")" \
  no_slash_line "$T/parsed.txt"

section "2. staged bodies"
T="$WORKDIR/t2"
mkdir -p "$T"
skill "$T" adhering-to-dry "$(cat <<'EOF'
---
name: adhering-to-dry
description: short
---

# DRY

Wait for three copies before extracting a helper.
EOF
)"
skill "$T" verifying-before-completion "$(cat <<'EOF'
---
name: verifying-before-completion
---

Claiming work is complete without verification is dishonesty, not efficiency.
EOF
)"
run_case "$T" true
check "staged exits 0" "rc=$(cat "$T/rc") log=$(cat "$T/log")" [ "$(cat "$T/rc")" = "0" ]
read_multi "$T/github_output" prompt > "$T/parsed.txt"
check "prompt file matches output" "file=$(cat "$T/prompt.txt")" \
  cmp -s "$T/parsed.txt" "$T/prompt.txt"
check "contains dry sentence" "prompt=$(cat "$T/parsed.txt")" \
  grep -F -q 'Wait for three copies before extracting a helper.' "$T/parsed.txt"
check "contains verify sentence" "prompt=$(cat "$T/parsed.txt")" \
  grep -F -q 'Claiming work is complete without verification is dishonesty, not efficiency.' "$T/parsed.txt"
check "contains dry heading" "prompt=$(cat "$T/parsed.txt")" \
  grep -F -q '## skill: adhering-to-dry' "$T/parsed.txt"
check "contains verify heading" "prompt=$(cat "$T/parsed.txt")" \
  grep -F -q '## skill: verifying-before-completion' "$T/parsed.txt"
check "does not say a slash command is the invocation" "prompt=$(cat "$T/parsed.txt")" \
  absent 'slash command is the invocation' "$T/parsed.txt"
check "does not say a slash command is how the skill is loaded" "prompt=$(cat "$T/parsed.txt")" \
  absent 'slash command is how' "$T/parsed.txt"
check "does not tell the model to call the Skill tool" "prompt=$(cat "$T/parsed.txt")" \
  absent 'Skill tool' "$T/parsed.txt"

section "3. no sentence fails closed"
T="$WORKDIR/t3"
mkdir -p "$T"
skill "$T" headings-only "$(cat <<'EOF'
---
name: headings-only
description: no period here
---

# Only a heading
EOF
)"
run_case "$T" true
check "no sentence exits non-zero" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" != "0" ]
check "no sentence names the skill" "log=$(cat "$T/log")" \
  grep -F -q 'headings-only' "$T/log"

section "4. missing dest fails closed"
T="$WORKDIR/t4"
mkdir -p "$T"
run_case "$T" true
check "missing dest exits non-zero" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" != "0" ]

section "5. symlink skill is not read"
T="$WORKDIR/t5"
mkdir -p "$T/skills" "$T/outside"
printf '%s\n' 'Secret sentence that must not enter the prompt.' > "$T/outside/SKILL.md"
ln -s "$T/outside" "$T/skills/leaked-skill"
run_case "$T" true
check "symlink exits non-zero" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" != "0" ]
check "symlink body is not in the prompt file" "file exists" \
  [ ! -f "$T/prompt.txt" ] || ! grep -F -q 'Secret sentence' "$T/prompt.txt"

section "6. workflow no longer treats a slash command as the load"
WF="$REPO_ROOT/.github/workflows/claude-code.yml"
check "workflow does not tell the model to call the Skill tool" "claude-code.yml" \
  absent 'load each skill with the Skill tool' "$WF"
check "workflow does not say the Skill tool is the invocation" "claude-code.yml" \
  absent 'the Skill tool is the invocation' "$WF"
check "primary prompt uses the inlined bodies" "claude-code.yml" \
  grep -F -q 'steps.skill-prompt.outputs.prompt' "$WF"
check "Skill is denied" "claude-code.yml" \
  grep -F -q 'MultiEdit,Skill' "$WF"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
