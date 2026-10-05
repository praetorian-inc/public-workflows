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
secret_not_staged() {
  [ ! -f "$1" ] || ! grep -F -q 'Secret sentence' "$1"
}

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
check "names the references snapshot path" "prompt=$(cat "$T/parsed.txt")" \
  grep -F -q '.claude-pr/.claude/skills/<id>/' "$T/parsed.txt"

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
check "symlink body is not in the prompt file" "file=$(ls -l "$T/prompt.txt" 2>&1 || true)" \
  secret_not_staged "$T/prompt.txt"

section "6. round-trip check sees the interpolated prompt"
T="$WORKDIR/t6"
mkdir -p "$T"
skill "$T" adhering-to-dry "$(cat <<'EOF'
---
name: adhering-to-dry
---

Wait for three copies before extracting a helper.
EOF
)"
run_case "$T" true
check "build exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
: > "$T/empty-prompt.txt"
CHECK_PROMPT="$T/empty-prompt.txt" DEST="$T/skills" \
  bash "$SCRIPT" >"$T/check.log" 2>&1
echo "$?" > "$T/check.rc"
check "empty round-trip exits non-zero" "rc=$(cat "$T/check.rc")" [ "$(cat "$T/check.rc")" != "0" ]
printf '%s\n' 'This prompt has a sentence but not the skill sentence.' > "$T/wrong.txt"
CHECK_PROMPT="$T/wrong.txt" DEST="$T/skills" \
  bash "$SCRIPT" >"$T/wrong.log" 2>&1
echo "$?" > "$T/wrong.rc"
check "missing sentence round-trip exits non-zero" "rc=$(cat "$T/wrong.rc") log=$(cat "$T/wrong.log")" \
  [ "$(cat "$T/wrong.rc")" != "0" ]
CHECK_PROMPT="$T/prompt.txt" DEST="$T/skills" \
  bash "$SCRIPT" >"$T/check-ok.log" 2>&1
echo "$?" > "$T/check-ok.rc"
check "full round-trip exits 0" "rc=$(cat "$T/check-ok.rc") log=$(cat "$T/check-ok.log")" \
  [ "$(cat "$T/check-ok.rc")" = "0" ]

section "7. a tilde fence is not a sentence"
T="$WORKDIR/t7"
mkdir -p "$T"
skill "$T" fence-only "$(cat <<'EOF'
---
name: fence-only
---

~~~
print("this is only code.")
~~~
EOF
)"
run_case "$T" true
check "tilde fence exits non-zero" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" != "0" ]

section "8. 80KiB body does not false-fail"
T="$WORKDIR/t8"
mkdir -p "$T"
skill "$T" big-body "$(printf '%s\n' '---' 'name: big-body' '---' '' 'Wait for three copies before extracting a helper.' "$(python3 -c 'print("x" * 80000)')")"
run_case "$T" true
check "80KiB body exits 0" "rc=$(cat "$T/rc") log=$(cat "$T/log")" [ "$(cat "$T/rc")" = "0" ]

section "9. a backtick fence nested in a tilde fence is not a sentence"
T="$WORKDIR/t9"
mkdir -p "$T"
mkdir -p "$T/skills/nested-fence"
cat > "$T/skills/nested-fence/SKILL.md" <<'EOF'
---
name: nested-fence
---

~~~
```bash
echo "this is only code."
```
~~~
EOF
run_case "$T" true
check "nested fence exits non-zero" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" != "0" ]

section "10. an info string does not close a backtick fence"
T="$WORKDIR/t10"
mkdir -p "$T"
mkdir -p "$T/skills/info-string"
cat > "$T/skills/info-string/SKILL.md" <<'EOF'
---
name: info-string
---

```
```bash
echo "this is only code."
```
EOF
run_case "$T" true
check "info-string fence exits non-zero" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" != "0" ]

section "11. a four-space closer does not end a fence"
T="$WORKDIR/t11"
mkdir -p "$T"
mkdir -p "$T/skills/four-space"
cat > "$T/skills/four-space/SKILL.md" <<'EOF'
---
name: four-space
---

```
    ```
echo "this is only code."
```
EOF
run_case "$T" true
check "four-space closer exits non-zero" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" != "0" ]

section "12. a list-indented fence does not steal the prose sentence"
T="$WORKDIR/t12"
mkdir -p "$T/skills/list-fence"
cat > "$T/skills/list-fence/SKILL.md" <<'EOF'
---
name: list-fence
---

1. Run:

    ```bash
    echo "this is only code."
    ```

This is the real sentence.
EOF
run_case "$T" true
check "list fence exits 0" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" = "0" ]
check "list fence witness is the prose" "prompt=$(cat "$T/prompt.txt")" \
  grep -F -q 'This is the real sentence.' "$T/prompt.txt"

section "13. a tab-indented fence closes and the prose is the witness"
T="$WORKDIR/t13"
mkdir -p "$T/skills/tab-fence"
printf '%s\n' '---' 'name: tab-fence' '---' '' '1. Run:' '' $'\t```bash' $'\techo "this is only code."' $'\t```' '' 'This is the real sentence.' > "$T/skills/tab-fence/SKILL.md"
run_case "$T" true
check "tab fence exits 0" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" = "0" ]
check "tab fence witness is the prose" "prompt=$(cat "$T/prompt.txt")" \
  grep -F -q 'This is the real sentence.' "$T/prompt.txt"

section "14. a CRLF closer still ends the fence"
T="$WORKDIR/t14"
mkdir -p "$T/skills/crlf-fence"
printf '%s\r\n' '---' 'name: crlf-fence' '---' '' '```' 'echo "this is only code."' '```' '' 'This is the real sentence.' > "$T/skills/crlf-fence/SKILL.md"
run_case "$T" true
check "CRLF fence exits 0" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" = "0" ]
check "CRLF fence witness is the prose" "prompt=$(cat "$T/prompt.txt")" \
  grep -F -q 'This is the real sentence.' "$T/prompt.txt"

section "15. a CRLF front matter marker is still front matter"
T="$WORKDIR/t15"
mkdir -p "$T/skills/crlf-fm"
printf '%s\r\n' '---' 'name: crlf-fm' 'description: Use when reviewing shell changes.' '---' '' '# Only a heading' > "$T/skills/crlf-fm/SKILL.md"
run_case "$T" true
check "CRLF front matter exits non-zero" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" != "0" ]

section "16. an indented heading is not a sentence"
T="$WORKDIR/t16"
mkdir -p "$T/skills/indented-heading"
cat > "$T/skills/indented-heading/SKILL.md" <<'EOF'
---
name: indented-heading
---

  # Heading with punctuation.
EOF
run_case "$T" true
check "indented heading exits non-zero" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" != "0" ]

section "17. workflow no longer treats a slash command as the load"
WF="$REPO_ROOT/.github/workflows/claude-code.yml"
check "workflow does not tell the model to call the Skill tool" "claude-code.yml" \
  absent 'load each skill with the Skill tool' "$WF"
check "workflow does not say the Skill tool is the invocation" "claude-code.yml" \
  absent 'the Skill tool is the invocation' "$WF"
check "workflow does not interpolate skill bodies into the action prompt" "claude-code.yml" \
  absent 'steps.skill-prompt.outputs.prompt' "$WF"
check "workflow points Claude at the skill prompt file" "claude-code.yml" \
  grep -F -q '.claude-review/skill-prompt.txt' "$WF"
check "Skill is denied" "claude-code.yml" \
  grep -F -q 'MultiEdit,Skill' "$WF"

section "18. vendored allowlist fits the inline cap"
T="$WORKDIR/t18"
mkdir -p "$T"
: > "$T/github_output"
STAGED=true DEST="$REPO_ROOT/.github/actions/stage-review-skills/allowlist" \
  GITHUB_OUTPUT="$T/github_output" PROMPT_OUT="$T/prompt.txt" \
  bash "$SCRIPT" >"$T/log" 2>&1
echo "$?" > "$T/rc"
check "vendored allowlist assembles under the cap" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" = "0" ]
check "vendored prompt inlines calibrating-time-estimates" "prompt=$(cat "$T/prompt.txt")" \
  grep -F -q '## skill: calibrating-time-estimates' "$T/prompt.txt"

section "19. file load skips the inline cap and does not emit the body"
T="$WORKDIR/t19"
mkdir -p "$T"
: > "$T/github_output"
STAGED=true EMIT_PROMPT=false DEST="$REPO_ROOT/.github/actions/stage-review-skills/allowlist" \
  GITHUB_OUTPUT="$T/github_output" PROMPT_OUT="$T/prompt.txt" \
  bash "$SCRIPT" >"$T/log" 2>&1
echo "$?" > "$T/rc"
check "file load exits 0" "rc=$(cat "$T/rc") log=$(cat "$T/log")" \
  [ "$(cat "$T/rc")" = "0" ]
check "file load writes the body" "prompt=$(cat "$T/prompt.txt")" \
  grep -F -q '## skill: calibrating-time-estimates' "$T/prompt.txt"
check "file load does not emit the body" "out=$(cat "$T/github_output")" \
  absent '## skill: calibrating-time-estimates' "$T/github_output"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
