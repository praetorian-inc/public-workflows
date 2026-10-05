#!/usr/bin/env bash
# Fail-open staging of the vendored review-bot-skills allowlist into a
# reviewer's skill dir (ENG-8614; vendored-only since ENG-8852). Shared by
# claude-code.yml, codex-code.yml, gemini-code.yml and grok-code.yml.
#
# There is one path and no network: the allowlist directory beside this
# script (the trusted checkout of this repo at job.workflow_sha, never the PR
# tree) is copied into DEST. No token, no fetch, no private repo access.
#
# The pin: allowlist/SOURCE is the ONLY record of which
# praetorian-inc/review-bot-skills commit the vendored copy came from. It is
# logged, not compared against anything. To refresh, re-copy the allowlisted
# <id>/ dirs from praetorian-inc/review-bot-skills at the chosen commit into
# allowlist/ (byte-identical, no symlinks) and write that 40-hex SHA to
# allowlist/SOURCE in the same commit.
#
# Always exits 0. Any failure (missing or symlinked allowlist, a missing or
# non-40-hex SOURCE, an invalid skill id, a symlink in a skill dir, zero
# skills, or a bad DEST) stages NOTHING: DEST is removed and staged=false is
# written. The review then runs without curated skills. (A cancel/timeout
# signal still runs the cleanup, but the process then exits non-zero, e.g.
# 143 for SIGTERM; the job is ending anyway.)
#
# Env:
#   SKILLS_HARNESS   — claude | codex | gemini | grok (invocation format + extras)
#   DEST             — workspace-relative skill dir (e.g. .claude/skills)
#   GITHUB_OUTPUT    — receives staged=true|false and, on success, invocations
#   SKILLS_ALLOWLIST — test override for the allowlist dir (default:
#                      allowlist/ beside this script)
#
# Outputs on staged=true:
#   invocations — one line per skill: /id (claude), $id (codex), id (gemini, grok)
set -uo pipefail

success=0

# shellcheck disable=SC2329  # called from the EXIT trap
emit_false() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'staged=false\n' >> "$GITHUB_OUTPUT" || true
  fi
}

# shellcheck disable=SC2329  # the EXIT trap handler
cleanup() {
  if [ "$success" -ne 1 ]; then
    if [ -n "${dest_ok:-}" ]; then
      rm -rf -- "$DEST" || true
    fi
    emit_false
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

case "${SKILLS_HARNESS:-}" in
  claude) prefix="/" ;;
  codex) prefix="\$" ;;
  gemini|grok) prefix="" ;;
  *) skip "unknown harness" ;;
esac

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || skip "script dir"
clone="${SKILLS_ALLOWLIST:-$script_dir/allowlist}"
if [ ! -d "$clone" ] || [ -L "$clone" ]; then
  skip "no vendored allowlist"
fi
# A vendored copy without provenance is a broken vendoring: refuse it.
if [ ! -f "$clone/SOURCE" ] || [ -L "$clone/SOURCE" ]; then
  skip "allowlist SOURCE missing"
fi
source_sha=$(tr -d '[:space:]' < "$clone/SOURCE" 2>/dev/null || true)
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  skip "allowlist SOURCE is not a 40-hex commit"
fi
echo "staging allowlist from review-bot-skills@${source_sha}"

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
  skip "no <id>/SKILL.md directories in the allowlist"
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
