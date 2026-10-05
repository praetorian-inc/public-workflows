#!/usr/bin/env bash
#
# Tests for .github/actions/stage-review-skills/stage-review-skills.sh
# (ENG-8614, vendored-only since ENG-8852).
#
# The script is fail-open: every path exits 0. It stages only the allowlist
# vendored beside it (or SKILLS_ALLOWLIST, the test override). Fake `git` and
# `curl` on PATH record any invocation, so every case also proves the script
# never touches the network.
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO_ROOT/.github/actions/stage-review-skills/stage-review-skills.sh"
VENDORED="$REPO_ROOT/.github/actions/stage-review-skills/allowlist"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

# The pin is whatever the vendored SOURCE records; never a second copy here.
REF=$(tr -d '[:space:]' < "$VENDORED/SOURCE" 2>/dev/null || true)
EXPECTED_IDS="adhering-to-dry
adhering-to-yagni
analyzing-cyclomatic-complexity
analyzing-with-adversarial-pov
calibrating-time-estimates
discovering-reusable-code
enforcing-code-architecture
enforcing-evidence-based-analysis
preferring-simple-solutions
querying-code-graphs
verifying-before-completion"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }
check() { # name, detail, condition...
  local name=$1 detail=$2
  shift 2
  if "$@"; then ok "$name"; else bad "$name" "$detail"; fi
}

# Fake git/curl: any call leaves a marker in the case's fixture dir.
install_fakes() {
  local bin="$WORKDIR/bin" tool
  mkdir -p "$bin"
  for tool in git curl; do
    cat > "$bin/$tool" <<FAKE
#!/usr/bin/env bash
: > "\${FAKE_FIXTURE:?}/called-$tool"
exit 99
FAKE
    chmod +x "$bin/$tool"
  done
  export PATH="$bin:$PATH"
}

# run_case DIR HARNESS [ALLOWLIST] — empty ALLOWLIST means the real vendored
# dir (SKILLS_ALLOWLIST unset); otherwise SKILLS_ALLOWLIST=ALLOWLIST.
run_case() {
  local t=$1 harness=$2 allow=${3-}
  mkdir -p "$t/fix" "$t/ws"
  : > "$t/github_output"
  (
    cd "$t/ws" || exit 1
    export FAKE_FIXTURE="$t/fix"
    export SKILLS_HARNESS="$harness"
    export DEST="$DEST_REL"
    export GITHUB_OUTPUT="$t/github_output"
    unset SKILLS_TOKEN SKILLS_REPO SKILLS_REF SKILLS_ALLOWLIST
    if [ -n "$allow" ]; then export SKILLS_ALLOWLIST="$allow"; fi
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

# allowlist DIR [SOURCE] — fixture allowlist at DIR/allow with a SOURCE file.
allowlist() {
  mkdir -p "$1/allow"
  printf '%s\n' "${2-$REF}" > "$1/allow/SOURCE"
}

skill() { # case-dir id
  mkdir -p "$1/allow/$2"
  printf -- '---\nname: %s\n---\nbody\n' "$2" > "$1/allow/$2/SKILL.md"
}

no_network() {
  [ ! -e "$1/fix/called-git" ] && [ ! -e "$1/fix/called-curl" ]
}

staged_ids() {
  find "$1" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null \
    | sed 's#/SKILL.md$##; s#.*/##' | LC_ALL=C sort
}

section() { printf '\n%s\n' "$1"; }

install_fakes
DEST_REL=".claude/skills"

# --- 0. the vendored pin itself ---
section "0. vendored SOURCE"
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
check "vendored SOURCE is a 40-hex commit" "SOURCE=$REF" is_sha "$REF"

# --- 1. real vendored allowlist, no network ---
section "1. vendored allowlist (claude)"
T="$WORKDIR/t1"
run_case "$T" claude
check "vendored exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "vendored writes staged=true" "out=$(cat "$T/github_output") log=$(cat "$T/log")" \
  [ "$(read_out "$T/github_output" staged)" = "true" ]
check "vendored stages exactly the 11 allowlisted ids" "got=$(staged_ids "$T/ws/$DEST_REL")" \
  [ "$(staged_ids "$T/ws/$DEST_REL")" = "$EXPECTED_IDS" ]
check "vendored does not copy SOURCE" "SOURCE copied" [ ! -e "$T/ws/$DEST_REL/SOURCE" ]
check "vendored never calls git or curl" "$(ls "$T/fix")" no_network "$T"
check "vendored logs the source commit" "log=$(cat "$T/log")" \
  grep -qF "staging allowlist from review-bot-skills@$REF" "$T/log"
check "vendored claude invocations are /id lines" "got=$(read_multi "$T/github_output" invocations)" \
  [ "$(read_multi "$T/github_output" invocations)" = "$(printf '%s\n' "$EXPECTED_IDS" | sed 's#^#/#')" ]

# --- 1b. stray legacy env is ignored ---
section "1b. legacy SKILLS_* env ignored"
T="$WORKDIR/t1b"
mkdir -p "$T/fix" "$T/ws"
: > "$T/github_output"
(
  cd "$T/ws" || exit 1
  export FAKE_FIXTURE="$T/fix" SKILLS_HARNESS=claude DEST="$DEST_REL" GITHUB_OUTPUT="$T/github_output"
  # A caller pinned to an old reusable could still leak these; they must not matter.
  export SKILLS_TOKEN="ghs_stale" SKILLS_REPO="evil/repo" SKILLS_REF="1111111111111111111111111111111111111111"
  bash "$SCRIPT"
) >"$T/log" 2>&1
check "legacy env still stages the vendored set" "out=$(cat "$T/github_output") log=$(cat "$T/log")" \
  [ "$(read_out "$T/github_output" staged)" = "true" ]
check "legacy env never calls git or curl" "$(ls "$T/fix")" no_network "$T"

# --- 2. missing allowlist ---
section "2. missing allowlist"
T="$WORKDIR/t2"
mkdir -p "$T/ws/$DEST_REL/stale"
run_case "$T" claude "$T/missing-allowlist"
check "missing allowlist exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "missing allowlist writes staged=false" "out=$(cat "$T/github_output") log=$(cat "$T/log")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "missing allowlist removes DEST" "DEST still exists" [ ! -e "$T/ws/$DEST_REL" ]
check "missing allowlist warns" "log=$(cat "$T/log")" grep -q '::warning::' "$T/log"

# --- 3. symlinked allowlist ---
section "3. symlinked allowlist"
T="$WORKDIR/t3"
mkdir -p "$T"
allowlist "$T"
skill "$T" review-a
ln -s "$T/allow" "$T/allow-link"
run_case "$T" claude "$T/allow-link"
check "symlinked allowlist exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "symlinked allowlist writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "symlinked allowlist stages nothing" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]

# --- 4. SOURCE provenance: missing / garbage / symlink ---
section "4. SOURCE provenance"
for kind in missing empty garbage short upper symlink; do
  T="$WORKDIR/t4-$kind"
  mkdir -p "$T"
  allowlist "$T"
  skill "$T" review-a
  case "$kind" in
    missing) rm -f "$T/allow/SOURCE" ;;
    empty) : > "$T/allow/SOURCE" ;;
    garbage) printf 'not a sha; rm -rf /\n' > "$T/allow/SOURCE" ;;
    short) printf '480aaf29\n' > "$T/allow/SOURCE" ;;
    upper) printf '%s\n' "$REF" | tr '[:lower:]' '[:upper:]' > "$T/allow/SOURCE" ;;
    symlink)
      printf '%s\n' "$REF" > "$T/real-source"
      rm -f "$T/allow/SOURCE"
      ln -s "$T/real-source" "$T/allow/SOURCE"
      ;;
  esac
  run_case "$T" claude "$T/allow"
  check "SOURCE $kind exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
  check "SOURCE $kind writes staged=false" "out=$(cat "$T/github_output") log=$(cat "$T/log")" \
    [ "$(read_out "$T/github_output" staged)" = "false" ]
  check "SOURCE $kind stages nothing" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]
  check "SOURCE $kind warns about provenance" "log=$(cat "$T/log")" \
    grep -q '::warning::.*SOURCE' "$T/log"
done

# --- 5. invalid skill id: all-or-nothing ---
section "5. invalid skill id"
T="$WORKDIR/t5"
mkdir -p "$T"
allowlist "$T"
skill "$T" review-a
skill "$T" Bad_Id
run_case "$T" claude "$T/allow"
check "invalid id exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "invalid id writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "invalid id stages nothing (not even the valid one)" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]

# --- 6. zero skills ---
section "6. zero skills"
T="$WORKDIR/t6"
mkdir -p "$T"
allowlist "$T"
mkdir -p "$T/allow/not-a-skill"
: > "$T/allow/README.md"
run_case "$T" claude "$T/allow"
check "zero skills exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "zero skills writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "zero skills stages nothing" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]

# --- 7. success (claude) on a fixture ---
section "7. success (claude)"
T="$WORKDIR/t7"
mkdir -p "$T/ws/$DEST_REL/pr-planted"
allowlist "$T"
skill "$T" review-a
skill "$T" review-b
mkdir -p "$T/allow/review-a/references"
: > "$T/allow/review-a/references/extra.md"
: > "$T/allow/README.md"
run_case "$T" claude "$T/allow"
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

# --- 8. success (codex): openai.yaml extra + $id invocations ---
section "8. success (codex)"
DEST_REL=".agents/skills"
T="$WORKDIR/t8"
mkdir -p "$T"
allowlist "$T"
skill "$T" review-a
run_case "$T" codex "$T/allow"
check "codex writes staged=true" "out=$(cat "$T/github_output") log=$(cat "$T/log")" \
  [ "$(read_out "$T/github_output" staged)" = "true" ]
check "codex writes agents/openai.yaml disabling implicit invocation" \
  "got=$(cat "$T/ws/$DEST_REL/review-a/agents/openai.yaml" 2>&1)" \
  [ "$(cat "$T/ws/$DEST_REL/review-a/agents/openai.yaml" 2>/dev/null)" = "$(printf 'policy:\n  allow_implicit_invocation: false')" ]
check "codex invocations are \$id lines" "got=$(read_multi "$T/github_output" invocations)" \
  [ "$(read_multi "$T/github_output" invocations)" = "\$review-a" ]

# --- 9. success (gemini / grok): plain ids ---
section "9. success (gemini, grok)"
for h in gemini grok; do
  T="$WORKDIR/t9-$h"
  mkdir -p "$T"
  allowlist "$T"
  skill "$T" review-a
  skill "$T" review-b
  run_case "$T" "$h" "$T/allow"
  check "$h writes staged=true" "out=$(cat "$T/github_output")" \
    [ "$(read_out "$T/github_output" staged)" = "true" ]
  check "$h invocations are plain ids" "got=$(read_multi "$T/github_output" invocations)" \
    [ "$(read_multi "$T/github_output" invocations)" = "$(printf 'review-a\nreview-b')" ]
  check "$h stages no codex extra" "openai.yaml present" [ ! -e "$T/ws/$DEST_REL/review-a/agents" ]
done

# --- 10. unknown harness ---
section "10. unknown harness"
T="$WORKDIR/t10"
mkdir -p "$T"
allowlist "$T"
skill "$T" review-a
run_case "$T" cursor "$T/allow"
check "unknown harness exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "unknown harness writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "unknown harness stages nothing" "DEST exists" [ ! -e "$T/ws/$DEST_REL" ]

# --- 11. unsafe DEST ---
section "11. unsafe DEST"
for d in "/abs/skills" "../escape" ".agents/../../x" ""; do
  DEST_REL="$d"
  T="$WORKDIR/t11-$(printf '%s' "$d" | tr -c '[:lower:]' '_')"
  mkdir -p "$T"
  allowlist "$T"
  skill "$T" review-a
  run_case "$T" claude "$T/allow"
  check "DEST '$d' exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
  check "DEST '$d' writes staged=false" "out=$(cat "$T/github_output")" \
    [ "$(read_out "$T/github_output" staged)" = "false" ]
done

# --- 12. symlinks: DEST, DEST parent, inside a skill dir ---
section "12. symlinks"
DEST_REL=".claude/skills"
T="$WORKDIR/t12-dest"
mkdir -p "$T/outside" "$T/ws/.claude"
: > "$T/outside/keep"
ln -s "$T/outside" "$T/ws/.claude/skills"
allowlist "$T"
skill "$T" review-a
run_case "$T" claude "$T/allow"
check "symlinked DEST exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "symlinked DEST writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "symlinked DEST leaves the link target untouched" "$(ls -A "$T/outside")" \
  [ "$(ls -A "$T/outside")" = "keep" ]

T="$WORKDIR/t12-parent"
mkdir -p "$T/outside" "$T/ws"
: > "$T/outside/keep"
ln -s "$T/outside" "$T/ws/.claude"
allowlist "$T"
skill "$T" review-a
run_case "$T" claude "$T/allow"
check "symlinked DEST parent exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "symlinked DEST parent writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "symlinked DEST parent leaves the link target untouched" "$(ls -A "$T/outside")" \
  [ "$(ls -A "$T/outside")" = "keep" ]

T="$WORKDIR/t12-inner"
mkdir -p "$T"
allowlist "$T"
skill "$T" review-a
skill "$T" review-b
ln -s /etc/passwd "$T/allow/review-b/leak"
run_case "$T" claude "$T/allow"
check "symlink inside a skill exits 0" "rc=$(cat "$T/rc")" [ "$(cat "$T/rc")" = "0" ]
check "symlink inside a skill writes staged=false" "out=$(cat "$T/github_output")" \
  [ "$(read_out "$T/github_output" staged)" = "false" ]
check "symlink inside a skill stages nothing (not even the clean skill)" "DEST exists" \
  [ ! -e "$T/ws/$DEST_REL" ]
check "symlink inside a skill warns" "log=$(cat "$T/log")" grep -q '::warning::.*symlink' "$T/log"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
