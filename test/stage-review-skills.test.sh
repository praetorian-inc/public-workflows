#!/usr/bin/env bash
#
# Tests for .github/actions/stage-review-skills/stage-review-skills.sh (ENG-8614).
#
# The script is fail-open: every path exits 0. A fake `git` and a fake `curl`
# on PATH, driven by files under a fixture dir, stand in for the skills repo
# and the token-revoke endpoint. Neither fake ever writes the token to disk:
# each records only whether the credential arrived by the expected channel.
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO_ROOT/.github/actions/stage-review-skills/stage-review-skills.sh"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

TOKEN="ghs_FAKEtoken0123456789abcdef"
REF="480aaf29f6656477f2fb6d34dae57f3e03889344"
OTHER_REF="1111111111111111111111111111111111111111"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }
check() { # name, detail, condition...
  local name=$1 detail=$2
  shift 2
  if "$@"; then ok "$name"; else bad "$name" "$detail"; fi
}

install_fakes() {
  local bin="$WORKDIR/bin"
  mkdir -p "$bin"
  cat > "$bin/git" <<'GIT'
#!/usr/bin/env bash
set -u
fix="${FAKE_FIXTURE:?}"
for a in "$@"; do
  case "$a" in *"$FAKE_TOKEN"*) : > "$fix/token-in-argv" ;; esac
done
dir=""
if [ "${1:-}" = "-C" ]; then dir=$2; shift 2; fi
while [ "${1:-}" = "-c" ]; do shift 2; done
case "${1:-}" in
  init)
    shift
    while [ "${1:-}" = "-q" ]; do shift; done
    mkdir -p "$1"
    exit 0
    ;;
  fetch)
    printf '%s\n' "$*" > "$fix/fetch-args"
    want=$(printf 'x-access-token:%s' "$FAKE_TOKEN" | base64 | tr -d '\n')
    if [ "${GIT_CONFIG_COUNT:-}" = "1" ] \
      && [ "${GIT_CONFIG_KEY_0:-}" = "http.extraheader" ] \
      && [ "${GIT_CONFIG_VALUE_0:-}" = "AUTHORIZATION: basic ${want}" ]; then
      : > "$fix/fetch-auth-ok"
    fi
    if [ -f "$fix/fetch.fail" ]; then exit 128; fi
    exit 0
    ;;
  rev-parse)
    cat "$fix/commit"
    exit 0
    ;;
  checkout)
    [ -n "$dir" ] || exit 1
    if [ -d "$fix/tree" ]; then cp -R "$fix/tree/." "$dir/"; fi
    exit 0
    ;;
esac
echo "unexpected git invocation: $*" >&2
exit 99
GIT
  cat > "$bin/curl" <<'CURL'
#!/usr/bin/env bash
set -u
fix="${FAKE_FIXTURE:?}"
for a in "$@"; do
  case "$a" in *"$FAKE_TOKEN"*) : > "$fix/token-in-argv" ;; esac
done
printf '%s\n' "$*" > "$fix/curl-args"
cfg=$(cat)
case "$cfg" in
  *"Authorization: Bearer ${FAKE_TOKEN}"*) : > "$fix/revoke-auth-ok" ;;
esac
: > "$fix/revoked"
n=$(( $(cat "$fix/revoke-count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$fix/revoke-count"
# Record what was already staged when the FIRST revoke ran (revoke-before-copy).
if [ "$n" = 1 ]; then
  if [ -n "${DEST:-}" ] && [ -e "$DEST" ]; then
    find "$DEST" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ' > "$fix/first-revoke-dest-skills"
  else
    echo 0 > "$fix/first-revoke-dest-skills"
  fi
fi
if [ -f "$fix/revoke.fail" ]; then exit 22; fi
if [ -f "$fix/revoke.fail-once" ] && [ "$n" = 1 ]; then exit 22; fi
exit 0
CURL
  chmod +x "$bin/git" "$bin/curl"
  export PATH="$bin:$PATH"
}

# run_case DIR HARNESS TOKEN — runs the script with fixture DIR/fix.
run_case() {
  local t=$1 harness=$2 token=$3
  mkdir -p "$t/fix" "$t/ws" "$t/runner-temp"
  : > "$t/github_output"
  (
    cd "$t/ws" || exit 1
    export FAKE_FIXTURE="$t/fix"
    export FAKE_TOKEN="$TOKEN"
    export SKILLS_TOKEN="$token"
    export SKILLS_REPO="praetorian-inc/review-bot-skills"
    export SKILLS_REF="$REF"
    export SKILLS_HARNESS="$harness"
    export DEST="$DEST_REL"
    export RUNNER_TEMP="$t/runner-temp"
    export GITHUB_OUTPUT="$t/github_output"
    export SKILLS_REVOKE_BACKOFF=0
    bash "$SCRIPT"
  ) >"$t/log" 2>&1
  echo "$?" > "$t/rc"
}

read_out() {
  local file=$1 key=$2
  grep -E "^${key}=" "$file" | tail -n 1 | sed "s/^${key}=//"
}

# Body of a heredoc-style output KEY<<DELIM ... DELIM.
read_multi() {
  local file=$1 key=$2
  awk -v k="$key" '
    index($0, k "<<") == 1 { d = substr($0, length(k) + 3); on = 1; next }
    on && $0 == d { exit }
    on { print }
  ' "$file"
}

skill() { # fixture-dir id
  mkdir -p "$1/fix/tree/$2"
  printf -- '---\nname: %s\n---\nbody\n' "$2" > "$1/fix/tree/$2/SKILL.md"
}

no_token_anywhere() {
  ! grep -rqF -- "$TOKEN" "$1" 2>/dev/null
}

runner_temp_empty() {
  [ -z "$(find "$1/runner-temp" -mindepth 1 -print 2>/dev/null)" ]
}

section() { printf '\n%s\n' "$1"; }

install_fakes
DEST_REL=".claude/skills"

# --- 1. empty token: clean no-op ---
section "1. empty token"
T="$WORKDIR/t1"
mkdir -p "$T/fix"
skill "$T" review-a
echo "$REF" > "$T/fix/commit"
run_case "$T" claude ""
check "empty token exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "empty token writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "empty token never fetches" "fetch-args present" [ ! -f "$T/fix/fetch-args" ]
check "empty token never calls revoke" "curl was called" [ ! -f "$T/fix/revoked" ]
check "empty token stages nothing" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]
check "empty token explains the skip" "log=$(cat "$T/log")" grep -q '::notice::' "$T/log"

# --- 2. fetch failure ---
section "2. fetch failure"
T="$WORKDIR/t2"
mkdir -p "$T/fix" "$T/ws/$DEST_REL/stale"
: > "$T/fix/fetch.fail"
echo "$REF" > "$T/fix/commit"
run_case "$T" claude "$TOKEN"
check "fetch failure exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "fetch failure writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "fetch failure removes DEST" "DEST still exists" [ ! -e "$T/ws/$DEST_REL" ]
check "fetch failure still revokes" "curl not called" [ -f "$T/fix/revoked" ]
check "fetch failure removes the temp clone" "$(find "$T/runner-temp" -mindepth 1)" runner_temp_empty "$T"
check "fetch failure warns" "log=$(cat "$T/log")" grep -q '::warning::' "$T/log"

# --- 3. fetched commit mismatch ---
section "3. commit mismatch"
T="$WORKDIR/t3"
mkdir -p "$T/fix"
skill "$T" review-a
echo "$OTHER_REF" > "$T/fix/commit"
run_case "$T" claude "$TOKEN"
check "mismatch exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "mismatch writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "mismatch stages nothing" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]
check "mismatch revokes" "curl not called" [ -f "$T/fix/revoked" ]
check "mismatch removes the temp clone" "$(find "$T/runner-temp" -mindepth 1)" runner_temp_empty "$T"

# --- 4. invalid skill id: all-or-nothing ---
section "4. invalid skill id"
T="$WORKDIR/t4"
mkdir -p "$T/fix"
skill "$T" review-a
skill "$T" Bad_Id
echo "$REF" > "$T/fix/commit"
run_case "$T" claude "$TOKEN"
check "invalid id exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "invalid id writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "invalid id stages nothing (not even the valid one)" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]
check "invalid id revokes" "curl not called" [ -f "$T/fix/revoked" ]

# --- 5. zero skills ---
section "5. zero skills"
T="$WORKDIR/t5"
mkdir -p "$T/fix/tree/not-a-skill"
: > "$T/fix/tree/README.md"
echo "$REF" > "$T/fix/commit"
run_case "$T" claude "$TOKEN"
check "zero skills exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "zero skills writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "zero skills stages nothing" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]
check "zero skills revokes" "curl not called" [ -f "$T/fix/revoked" ]

# --- 6. success (claude) ---
section "6. success (claude)"
T="$WORKDIR/t6"
mkdir -p "$T/fix" "$T/ws/$DEST_REL/pr-planted"
skill "$T" review-a
skill "$T" review-b
mkdir -p "$T/fix/tree/review-a/references"
: > "$T/fix/tree/review-a/references/extra.md"
: > "$T/fix/tree/README.md"
echo "$REF" > "$T/fix/commit"
run_case "$T" claude "$TOKEN"
check "success exits 0" "rc=$(cat "$T/rc") log=$(cat "$T/log")" [ "$(cat "$T/rc")" = "0" ]
check "success writes staged=true" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "true" ]
check "success writes staged exactly once" "out=$(cat "$T/github_output")" \
  [ "$(grep -c '^staged=' "$T/github_output")" = "1" ]
check "success populates DEST (skill a)" "$(ls -R "$T/ws/$DEST_REL" 2>&1)" \
  [ -f "$T/ws/$DEST_REL/review-a/SKILL.md" ]
check "success populates DEST (skill b)" "$(ls -R "$T/ws/$DEST_REL" 2>&1)" \
  [ -f "$T/ws/$DEST_REL/review-b/SKILL.md" ]
check "success keeps skill supporting files" "missing references/extra.md" \
  [ -f "$T/ws/$DEST_REL/review-a/references/extra.md" ]
check "success replaces pre-existing DEST content" "pr-planted survived" \
  [ ! -e "$T/ws/$DEST_REL/pr-planted" ]
check "success copies only skill dirs" "README.md copied" [ ! -e "$T/ws/$DEST_REL/README.md" ]
check "claude invocations are /id lines" "got=$(read_multi "$T/github_output" invocations)" \
  [ "$(read_multi "$T/github_output" invocations)" = "$(printf '/review-a\n/review-b')" ]
check "fetch pins depth 1 and the ref" "args=$(cat "$T/fix/fetch-args" 2>/dev/null)" \
  grep -q -- "--depth 1 .*$REF" "$T/fix/fetch-args"
check "git gets the token only through GIT_CONFIG_* env" "no fetch-auth-ok marker" \
  [ -f "$T/fix/fetch-auth-ok" ]
check "revoke called with the token on stdin config" "no revoke-auth-ok marker" \
  [ -f "$T/fix/revoke-auth-ok" ]
check "revoke targets DELETE /installation/token" "args=$(cat "$T/fix/curl-args" 2>/dev/null)" \
  grep -q -- '-X DELETE .*https://api.github.com/installation/token' "$T/fix/curl-args"
check "token never in any argv" "token-in-argv marker present" [ ! -f "$T/fix/token-in-argv" ]
check "token never in output, GITHUB_OUTPUT, or any file" "$(grep -rlF -- "$TOKEN" "$T")" \
  no_token_anywhere "$T"
check "success removes the temp clone" "$(find "$T/runner-temp" -mindepth 1)" runner_temp_empty "$T"
check "token revoked before any skill is copied into DEST" \
  "SKILL.md files present at first revoke: $(cat "$T/fix/first-revoke-dest-skills" 2>/dev/null)" \
  [ "$(cat "$T/fix/first-revoke-dest-skills" 2>/dev/null)" = "0" ]
check "success revokes exactly once" "count=$(cat "$T/fix/revoke-count" 2>/dev/null)" \
  [ "$(cat "$T/fix/revoke-count" 2>/dev/null)" = "1" ]

# --- 7. success (codex): openai.yaml extra + $id invocations ---
section "7. success (codex)"
DEST_REL=".agents/skills"
T="$WORKDIR/t7"
mkdir -p "$T/fix"
skill "$T" review-a
echo "$REF" > "$T/fix/commit"
run_case "$T" codex "$TOKEN"
check "codex writes staged=true" "out=$(cat "$T/github_output") log=$(cat "$T/log")" \
  [ "$(read_out "$T/github_output" staged)" = "true" ]
check "codex writes agents/openai.yaml disabling implicit invocation" \
  "got=$(cat "$T/ws/$DEST_REL/review-a/agents/openai.yaml" 2>&1)" \
  [ "$(cat "$T/ws/$DEST_REL/review-a/agents/openai.yaml" 2>/dev/null)" = "$(printf 'policy:\n  allow_implicit_invocation: false')" ]
check "codex invocations are \$id lines" "got=$(read_multi "$T/github_output" invocations)" \
  [ "$(read_multi "$T/github_output" invocations)" = "\$review-a" ]

# --- 8. success (gemini / grok): plain ids ---
section "8. success (gemini, grok)"
for h in gemini grok; do
  T="$WORKDIR/t8-$h"
  mkdir -p "$T/fix"
  skill "$T" review-a
  skill "$T" review-b
  echo "$REF" > "$T/fix/commit"
  run_case "$T" "$h" "$TOKEN"
  check "$h writes staged=true" "out=$(cat "$T/github_output")" \
    [ "$(read_out "$T/github_output" staged)" = "true" ]
  check "$h invocations are plain ids" "got=$(read_multi "$T/github_output" invocations)" \
    [ "$(read_multi "$T/github_output" invocations)" = "$(printf 'review-a\nreview-b')" ]
  check "$h stages no codex extra" "openai.yaml present" [ ! -e "$T/ws/$DEST_REL/review-a/agents" ]
done

# --- 9. revoke fails twice: warn, stage nothing, exit 0 ---
section "9. revoke failure"
T="$WORKDIR/t9"
mkdir -p "$T/fix" "$T/ws/$DEST_REL/stale"
skill "$T" review-a
echo "$REF" > "$T/fix/commit"
: > "$T/fix/revoke.fail"
run_case "$T" grok "$TOKEN"
check "revoke failure exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "revoke failure writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "revoke failure never writes staged=true" "out=$(cat "$T/github_output")" \
  [ "$(grep -c '^staged=true' "$T/github_output")" = "0" ]
check "revoke failure writes no invocations" "out=$(cat "$T/github_output")" \
  [ "$(grep -c '^invocations' "$T/github_output")" = "0" ]
check "revoke failure removes DEST" "DEST still exists" [ ! -e "$T/ws/$DEST_REL" ]
check "revoke failure retries exactly once" "count=$(cat "$T/fix/revoke-count" 2>/dev/null)" \
  [ "$(cat "$T/fix/revoke-count" 2>/dev/null)" = "2" ]
check "revoke failure warns" "log=$(cat "$T/log")" grep -q '::warning::.*revoke failed twice' "$T/log"
check "revoke failure never echoes the token" "$(grep -rlF -- "$TOKEN" "$T")" no_token_anywhere "$T"

# --- 9b. revoke fails once, retry succeeds: staged ---
section "9b. revoke retry succeeds"
T="$WORKDIR/t9b"
mkdir -p "$T/fix"
skill "$T" review-a
echo "$REF" > "$T/fix/commit"
: > "$T/fix/revoke.fail-once"
run_case "$T" grok "$TOKEN"
check "revoke retry writes staged=true" "out=$(cat "$T/github_output") log=$(cat "$T/log")" \
  [ "$(read_out "$T/github_output" staged)" = "true" ]
check "revoke retry calls revoke twice" "count=$(cat "$T/fix/revoke-count" 2>/dev/null)" \
  [ "$(cat "$T/fix/revoke-count" 2>/dev/null)" = "2" ]
check "revoke retry stages the skill" "DEST missing" [ -f "$T/ws/$DEST_REL/review-a/SKILL.md" ]

# --- 10. unknown harness ---
section "10. unknown harness"
T="$WORKDIR/t10"
mkdir -p "$T/fix"
skill "$T" review-a
echo "$REF" > "$T/fix/commit"
run_case "$T" cursor "$TOKEN"
check "unknown harness exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "unknown harness writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "unknown harness still revokes" "curl not called" [ -f "$T/fix/revoked" ]
check "unknown harness stages nothing" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]

# --- 11. unsafe DEST ---
section "11. unsafe DEST"
for d in "/abs/skills" "../escape" ".agents/../../x" ""; do
  DEST_REL="$d"
  T="$WORKDIR/t11-$(printf '%s' "$d" | tr -c '[:lower:]' '_')"
  mkdir -p "$T/fix"
  skill "$T" review-a
  echo "$REF" > "$T/fix/commit"
  run_case "$T" claude "$TOKEN"
  check "DEST '$d' exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
  check "DEST '$d' writes staged=false" "out=$(cat "$T/github_output")" \
    [ "$(read_out "$T/github_output" staged)" = "false" ]
  check "DEST '$d' still revokes" "curl not called" [ -f "$T/fix/revoked" ]
done

# --- 12. symlinks: DEST, DEST parent, inside a skill dir ---
section "12. symlinks"
T="$WORKDIR/t12-dest"
mkdir -p "$T/fix" "$T/outside" "$T/ws/.claude"
: > "$T/outside/keep"
ln -s "$T/outside" "$T/ws/.claude/skills"
skill "$T" review-a
echo "$REF" > "$T/fix/commit"
DEST_REL=".claude/skills"
run_case "$T" claude "$TOKEN"
check "symlinked DEST exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "symlinked DEST writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "symlinked DEST leaves the link target untouched" "$(ls -A "$T/outside")" \
  [ "$(ls -A "$T/outside")" = "keep" ]
check "symlinked DEST never fetches" "fetch-args present" [ ! -f "$T/fix/fetch-args" ]
check "symlinked DEST still revokes" "curl not called" [ -f "$T/fix/revoked" ]

T="$WORKDIR/t12-parent"
mkdir -p "$T/fix" "$T/outside" "$T/ws"
: > "$T/outside/keep"
ln -s "$T/outside" "$T/ws/.claude"
skill "$T" review-a
echo "$REF" > "$T/fix/commit"
run_case "$T" claude "$TOKEN"
check "symlinked DEST parent exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "symlinked DEST parent writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "symlinked DEST parent leaves the link target untouched" "$(ls -A "$T/outside")" \
  [ "$(ls -A "$T/outside")" = "keep" ]
check "symlinked DEST parent still revokes" "curl not called" [ -f "$T/fix/revoked" ]

T="$WORKDIR/t12-inner"
mkdir -p "$T/fix"
skill "$T" review-a
skill "$T" review-b
ln -s /etc/passwd "$T/fix/tree/review-b/leak"
echo "$REF" > "$T/fix/commit"
run_case "$T" claude "$TOKEN"
check "symlink inside a skill exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "symlink inside a skill writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "symlink inside a skill stages nothing (not even the clean skill)" "DEST exists" \
  [ ! -e "$T/ws/$DEST_REL" ]
check "symlink inside a skill revokes" "curl not called" [ -f "$T/fix/revoked" ]
check "symlink inside a skill warns" "log=$(cat "$T/log")" grep -q '::warning::.*symlink' "$T/log"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
