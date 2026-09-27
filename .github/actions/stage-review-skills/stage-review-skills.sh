#!/usr/bin/env bash
# Fail-open staging of the review-bot-skills allowlist into a reviewer's
# skill dir (ENG-8614). Shared by claude-code.yml, codex-code.yml,
# gemini-code.yml and grok-code.yml.
#
# Always exits 0. Any failure (no token, fetch error, commit mismatch, an
# invalid skill id, a symlink in a skill dir, zero skills, a bad DEST, or a
# token revoke that fails twice) stages NOTHING: DEST is removed and
# staged=false is written. The review then runs without curated skills.
# (A cancel/timeout signal still runs the full cleanup, but the process then
# exits non-zero, e.g. 143 for SIGTERM; the job is ending anyway.)
#
# The App token is revoked right after the fetch, before anything is copied,
# and skills are staged ONLY after that revoke is confirmed (one retry after
# a short backoff). So staged=true implies the token is already dead. If the
# revoke fails twice nothing is staged and the action's post-job revoke is
# the backstop. The token is handed to git and curl only through the
# environment / stdin, never argv, and is never written to disk or echoed.
#
# Env:
#   SKILLS_TOKEN    — installation token with contents:read on SKILLS_REPO
#                     (empty = clean no-op, staged=false)
#   SKILLS_REPO     — owner/repo of the allowlist
#   SKILLS_REF      — 40-hex commit to stage; the fetched commit must equal it
#   SKILLS_HARNESS  — claude | codex | gemini | grok (invocation format + extras)
#   DEST            — workspace-relative skill dir (e.g. .claude/skills)
#   RUNNER_TEMP     — temp root for the clone (outside the workspace)
#   GITHUB_OUTPUT   — receives staged=true|false and, on success, invocations
#   SKILLS_REVOKE_BACKOFF — seconds before the one revoke retry (default 2)
#
# Outputs on staged=true:
#   invocations — one line per skill: /id (claude), $id (codex), id (gemini, grok)
set -uo pipefail

success=0
revoked=0
revoke_rc=1
tmp=""
backoff="${SKILLS_REVOKE_BACKOFF:-2}"
case "$backoff" in ''|*[!0-9]*) backoff=2 ;; esac

# shellcheck disable=SC2329  # called from the EXIT trap
emit_false() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'staged=false\n' >> "$GITHUB_OUTPUT" || true
  fi
}

revoke_once() {
  # Header via curl's stdin config, so the token never reaches argv.
  printf 'header = "Authorization: Bearer %s"\n' "$SKILLS_TOKEN" \
    | curl -fsS -K - -o /dev/null -X DELETE \
        -H "Accept: application/vnd.github+json" \
        --connect-timeout 5 --max-time 20 \
        https://api.github.com/installation/token >/dev/null 2>&1
}

# Runs at most once; returns 0 only on a confirmed revoke (or no token).
revoke() {
  [ "$revoked" -eq 0 ] || return "$revoke_rc"
  revoked=1
  if [ -z "${SKILLS_TOKEN:-}" ]; then
    revoke_rc=0
    return 0
  fi
  if revoke_once || { sleep "$backoff"; revoke_once; }; then
    echo "review-bot-skills token revoked"
    revoke_rc=0
  else
    echo "::warning::review-bot-skills token revoke failed twice; the action's post-job revoke is the backstop and it expires within an hour"
    revoke_rc=1
  fi
  return "$revoke_rc"
}

# shellcheck disable=SC2329  # the EXIT trap handler
cleanup() {
  revoke || true
  if [ "$success" -ne 1 ]; then
    if [ -n "${dest_ok:-}" ]; then
      rm -rf -- "$DEST" || true
    fi
    emit_false
  fi
  if [ -n "$tmp" ]; then
    rm -rf -- "$tmp" || true
  fi
  exit 0
}
trap cleanup EXIT

skip() {
  echo "::warning::review-bot-skills not staged ($1); reviewing without curated skills"
  exit 0
}

DEST="${DEST:-}"
# DEST must be workspace-relative with no parent traversal, and neither it
# nor its parent may be a symlink (a PR-planted link could escape the tree).
case "$DEST" in
  ''|/*|..|../*|*/..|*/../*) skip "unsafe DEST" ;;
esac
if [ -L "$DEST" ] || [ -L "$(dirname -- "$DEST")" ]; then
  skip "DEST is a symlink"
fi
dest_ok=1

if [ -z "${SKILLS_TOKEN:-}" ]; then
  echo "::notice::No review-bot-skills token (App secrets absent, repo not private/internal, or mint failed); reviewing without curated skills"
  exit 0
fi

case "${SKILLS_HARNESS:-}" in
  claude) prefix="/" ;;
  codex) prefix="\$" ;;
  gemini|grok) prefix="" ;;
  *) skip "unknown harness" ;;
esac
case "${SKILLS_REPO:-}" in
  */*) ;;
  *) skip "bad SKILLS_REPO" ;;
esac
case "${SKILLS_REPO}" in
  *[!A-Za-z0-9._/-]*) skip "bad SKILLS_REPO" ;;
esac
ref="${SKILLS_REF:-}"
if [ "${#ref}" -ne 40 ]; then skip "bad SKILLS_REF"; fi
case "$ref" in
  *[!0-9a-f]*) skip "bad SKILLS_REF" ;;
esac

tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/stage-review-skills.XXXXXX") || skip "mktemp failed"
clone="$tmp/repo"

export GIT_TERMINAL_PROMPT=0
git init -q "$clone" >/dev/null 2>&1 || skip "git init failed"
auth=$(printf 'x-access-token:%s' "$SKILLS_TOKEN" | base64 | tr -d '\n')
if ! GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.extraheader \
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic ${auth}" \
  git -C "$clone" fetch -q --no-tags --depth 1 \
    "https://github.com/${SKILLS_REPO}.git" "$ref" >/dev/null 2>&1; then
  unset auth
  skip "fetch failed"
fi
unset auth
# Nothing below needs the token; kill it before touching the tree. Stage
# only after a confirmed revoke, so staged=true implies a dead token.
revoke || skip "token revoke not confirmed"

got=$(git -C "$clone" rev-parse --verify -q 'FETCH_HEAD^{commit}' 2>/dev/null) || got=""
if [ "$got" != "$ref" ]; then
  skip "fetched commit does not match the pinned ref"
fi
git -C "$clone" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD >/dev/null 2>&1 \
  || skip "checkout failed"

ids=()
for skill_md in "$clone"/*/SKILL.md; do
  [ -f "$skill_md" ] || continue
  dir=$(dirname -- "$skill_md")
  id=$(basename -- "$dir")
  if [[ ! "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    skip "a skill id is not a safe token"
  fi
  if [ -L "$dir" ] || [ -L "$skill_md" ]; then
    skip "a skill dir is a symlink"
  fi
  # All-or-nothing: any symlink anywhere inside a skill rejects the whole set.
  if [ -n "$(find "$dir" -type l -print 2>/dev/null | head -n 1)" ]; then
    skip "a skill dir contains a symlink"
  fi
  ids+=("$id")
done
if [ "${#ids[@]}" -eq 0 ]; then
  skip "no <id>/SKILL.md directories at the pinned ref"
fi

rm -rf -- "$DEST" || skip "could not clear DEST"
mkdir -p -- "$DEST" || skip "could not create DEST"
invocations=""
for id in "${ids[@]}"; do
  cp -R -- "$clone/$id" "$DEST/$id" || skip "copy failed"
  if [ "$SKILLS_HARNESS" = "codex" ]; then
    mkdir -p -- "$DEST/$id/agents" || skip "copy failed"
    printf '%s\n' 'policy:' '  allow_implicit_invocation: false' > "$DEST/$id/agents/openai.yaml" \
      || skip "copy failed"
  fi
  invocations="${invocations}${prefix}${id}"$'\n'
done

echo "Staged review skills:"
printf '  %s\n' "${ids[@]}"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  delim="SKILLS_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  {
    printf 'invocations<<%s\n' "$delim"
    printf '%s' "$invocations"
    printf '%s\n' "$delim"
    printf 'staged=true\n'
  } >> "$GITHUB_OUTPUT" || skip "could not write GITHUB_OUTPUT"
fi
success=1
exit 0
