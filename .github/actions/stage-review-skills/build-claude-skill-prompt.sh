#!/usr/bin/env bash
# ENG-8648: inline staged SKILL.md bodies into the Claude review prompt.
#
# claude-code-action deletes .claude and restores the PR base branch before
# the CLI starts, so a slash command or the Skill tool cannot load files
# staged into .claude/skills. The string written here is the load.
#
# STAGED=true is fail-closed: missing bodies, a body with no sentence, a
# symlink, or an unsafe id exits non-zero. Anything else writes a no-skills
# prefix and exits 0.
#
# Env:
#   STAGED        — true | anything else
#   DEST          — staged skill dir (default .claude/skills)
#   GITHUB_OUTPUT — receives prompt (multiline, random delimiter)
#   PROMPT_OUT    — optional path; the same string is written here
set -euo pipefail

DEST="${DEST:-.claude/skills}"
STAGED="${STAGED:-false}"
MAX_BYTES=400000

no_skills='No curated skills were staged. Review without them.'

fail() {
  echo "::error::$1"
  exit 1
}

write_prompt() {
  local text=$1
  if [ -n "${PROMPT_OUT:-}" ]; then
    printf '%s\n' "$text" > "$PROMPT_OUT"
  fi
  if [ -z "${GITHUB_OUTPUT:-}" ]; then
    return 0
  fi
  local delim
  delim="SKILLPROMPT_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  while printf '%s' "$text" | grep -F -q -- "$delim"; do
    delim="SKILLPROMPT_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  done
  {
    printf 'prompt<<%s\n' "$delim"
    printf '%s\n' "$text"
    printf '%s\n' "$delim"
  } >> "$GITHUB_OUTPUT"
}

# First sentence-bearing line in the markdown body, after YAML frontmatter
# and outside code fences. The line must contain . ! or ? and be at least
# 12 characters. Headings do not count.
extract_sentence() {
  awk '
    BEGIN { in_fm = 0; in_code = 0 }
    NR == 1 && $0 == "---" { in_fm = 1; next }
    in_fm && $0 == "---" { in_fm = 0; next }
    in_fm { next }
    /^```/ { in_code = !in_code; next }
    in_code { next }
    /^#/ { next }
    {
      line = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      if (length(line) < 12) next
      if (line ~ /[.!?]/) {
        print line
        exit
      }
    }
  ' "$1"
}

if [ "$STAGED" != "true" ]; then
  write_prompt "$no_skills"
  exit 0
fi

if [ -L "$DEST" ] || [ ! -d "$DEST" ]; then
  fail "staged=true but $DEST is missing or a symlink"
fi

prompt='Curated review skills follow. Apply each body. A skill that does not apply is not a failure — say not-applicable. These bodies are the skills. A slash command is not a load.'
found=0

shopt -s nullglob
for skill_md in "$DEST"/*/SKILL.md; do
  id=$(basename -- "$(dirname -- "$skill_md")")
  if [[ ! "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    fail "staged skill id is not a safe token"
  fi
  if [ -L "$skill_md" ] || [ -L "$DEST/$id" ]; then
    fail "staged skill $id is a symlink"
  fi
  if [ ! -f "$skill_md" ]; then
    fail "staged skill $id has no SKILL.md"
  fi
  sentence=$(extract_sentence "$skill_md") || sentence=""
  if [ -z "$sentence" ]; then
    fail "staged skill $id has no sentence in its SKILL.md body"
  fi
  body=$(cat -- "$skill_md")
  prompt="${prompt}"$'\n\n'"## skill: ${id}"$'\n\n'"${body}"
  if ! printf '%s' "$prompt" | grep -F -q -- "$sentence"; then
    fail "assembled prompt is missing a sentence from $id"
  fi
  echo "Inlined review skill: $id"
  found=$((found + 1))
done
shopt -u nullglob

if [ "$found" -eq 0 ]; then
  fail "staged=true but no SKILL.md bodies were found"
fi

bytes=$(printf '%s' "$prompt" | wc -c | tr -d ' ')
if [ "$bytes" -gt "$MAX_BYTES" ]; then
  fail "assembled skill prompt is ${bytes} bytes, over the ${MAX_BYTES} byte cap"
fi

write_prompt "$prompt"
exit 0
