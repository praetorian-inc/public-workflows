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
# The action receives this string plus the caller prompt as one environment
# entry. Linux MAX_ARG_STRLEN is 131072. The verify step rejects a combined
# prompt over 120000. 116000 leaves about 4KB for the caller prompt.
MAX_BYTES=116000

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
  while grep -F -q -- "$delim" <<< "$text"; do
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
    function lead_len(s,    i, c) {
      i = 0
      while (i < length(s)) {
        c = substr(s, i + 1, 1)
        if (c != " " && c != "\t") break
        i++
      }
      return i
    }
    function fence_run(s,    i, c, ch) {
      if (length(s) < 3) return ""
      ch = substr(s, 1, 1)
      if (ch != "`" && ch != "~") return ""
      i = 1
      while (i <= length(s) && substr(s, i, 1) == ch) i++
      if (i - 1 < 3) return ""
      return substr(s, 1, i - 1)
    }
    function suffix_blank(s,    i, c) {
      i = 1
      while (i <= length(s)) {
        c = substr(s, i, 1)
        if (c != " " && c != "\t") return 0
        i++
      }
      return 1
    }
    BEGIN { in_fm = 0; fence = ""; flen = 0; findent = 0; findent_str = "" }
    { gsub(/\r$/, "", $0) }
    NR == 1 && $0 == "---" { in_fm = 1; next }
    in_fm && $0 == "---" { in_fm = 0; next }
    in_fm { next }
    {
      ind = lead_len($0)
      rest = substr($0, ind + 1)
      run = fence_run(rest)
      if (fence == "" && run != "") {
        fence = substr(run, 1, 1)
        flen = length(run)
        findent = ind
        findent_str = substr($0, 1, ind)
        next
      }
      if (fence != "") {
        indent_ok = 0
        if (index(findent_str, "\t") == 0 && findent <= 3 && ind <= 3 && index(substr($0, 1, ind), "\t") == 0) indent_ok = 1
        if ((index(findent_str, "\t") > 0 || findent > 3) && substr($0, 1, findent) == findent_str && ind == findent) indent_ok = 1
        if (indent_ok && run != "" && substr(run, 1, 1) == fence && length(run) >= flen && suffix_blank(substr(rest, length(run) + 1))) {
          fence = ""
          flen = 0
            findent = 0
            findent_str = ""
          }
        next
      }
      hi = 0
      while (hi < 3 && substr($0, hi + 1, 1) == " ") hi++
      if (substr($0, hi + 1, 1) == "#") next
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

# CHECK_PROMPT is the prompt after it has passed through GITHUB_OUTPUT and
# expression interpolation. Re-read each SKILL.md and require its sentence
# in that string. The in-memory assembly cannot prove that round trip.
if [ -n "${CHECK_PROMPT:-}" ]; then
  if [ ! -f "$CHECK_PROMPT" ] || [ ! -s "$CHECK_PROMPT" ]; then
    fail "staged prompt round-trip file is missing or empty"
  fi
  if [ -L "$DEST" ] || [ ! -d "$DEST" ]; then
    fail "staged=true but $DEST is missing or a symlink"
  fi
  shopt -s nullglob
  checked=0
  for skill_md in "$DEST"/*/SKILL.md; do
    id=$(basename -- "$(dirname -- "$skill_md")")
    sentence=$(extract_sentence "$skill_md") || sentence=""
    if [ -z "$sentence" ]; then
      fail "staged skill $id has no sentence in its SKILL.md body"
    fi
    if ! grep -F -q -- "$sentence" "$CHECK_PROMPT"; then
      fail "round-trip prompt is missing a sentence from $id"
    fi
    checked=$((checked + 1))
  done
  shopt -u nullglob
  if [ "$checked" -eq 0 ]; then
    fail "staged=true but no SKILL.md bodies were found"
  fi
  exit 0
fi

if [ "$STAGED" != "true" ]; then
  write_prompt "$no_skills"
  exit 0
fi

if [ -L "$DEST" ] || [ ! -d "$DEST" ]; then
  fail "staged=true but $DEST is missing or a symlink"
fi

prompt='Curated review skills follow. Apply each body. A skill that does not apply is not a failure — say not-applicable. These bodies are the skills. A slash command is not a load. Files under references/ are not inlined. They survive only under .claude-pr/.claude/skills/<id>/.'
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
