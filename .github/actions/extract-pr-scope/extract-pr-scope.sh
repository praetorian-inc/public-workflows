#!/usr/bin/env bash
# LAB-7197: copy the PR body's `## Scope` section to $DEST so a reviewer bot
# can tag each finding [IN-SCOPE] / [OUT-OF-SCOPE] / [HYPOTHETICAL].
#
# Inputs (env):
#   PR_BODY  untrusted PR body; read only as data, never evaluated.
#   DEST     output file (e.g. .claude-review/scope.md). Removed first; written
#            only when the Scope section has non-blank content.
#
# Shared by claude-code.yml, codex-code.yml, gemini-code.yml and grok-code.yml,
# which run it from the _pw checkout of this reusable's own SHA.
# test/review-scope-tags.test.sh exercises this file directly.
set -euo pipefail
rm -f -- "$DEST" "$DEST.tmp"
# perl on raw bytes (perl-base is Essential on ubuntu-24.04): mawk
# cannot match the zero-width/bidi code points, and byte matching
# never fails on invalid UTF-8. Hidden content is stripped BEFORE the
# heading match, so a commented-out heading is not a Scope section.
printf '%s\n' "${PR_BODY:-}" | perl -0777 -ne '
  s/\r\n?/\n/g;
  # Comments are stripped twice. The first pass ends a comment only at a literal
  # "-->", as GitHub does; the second catches a "<!--" rebuilt by removing an
  # invisible character from inside it.
  s/<!--.*?(?:-->|\z)//gs;
  s/[\x00-\x08\x0B-\x1F\x7F]|\xC2[\x80-\x9F]//g;
  s/\xE2\x80[\x8B-\x8F\xAA-\xAE]|\xE2\x81[\xA0-\xA4\xA6-\xA9]|\xEF\xBB\xBF|\xEF\xB8[\x80-\x8F]//g;
  s/\xD8\x9C|\xC2\xAD|\xF3\xA0[\x80-\x81\x84-\x87][\x80-\xBF]//g;
  s/<!--.*?(?:-->|\z)//gs;
  # A heading inside a fenced code block (``` or ~~~, 3+) neither starts nor
  # ends Scope. A backtick opener whose info string has a backtick is plain
  # text, not a fence. A fence closes on 3+ of the same char ($fc) at least as
  # long as the opener ($fn). Fenced lines inside Scope are kept as content.
  my ($grab, $fc, $fn, @out) = (0, "", 0);
  for (split /\n/, $_, -1) {
    if ($fn) { $fn = 0 if /^ {0,3}\Q$fc\E{$fn,}[ \t]*\z/ }
    elsif (/^ {0,3}(`{3,}(?!.*`)|~{3,})/) { ($fc, $fn) = (substr($1, 0, 1), length $1) }
    elsif ($grab) { last if /^ {0,3}#{1,2}(?:[ \t]|\z)/ }
    elsif (/^ {0,3}##[ \t]+scope[ \t]*(?:\([^)]*\))?[ \t]*:?[ \t]*\z/i) { $grab = 1; next }
    push @out, $_ if $grab;
  }
  print join("\n", @out), "\n" if grep { /\S/ } @out;
' > "$DEST.tmp"
if [ -s "$DEST.tmp" ]; then
  mv -- "$DEST.tmp" "$DEST"
else
  rm -f -- "$DEST.tmp"
fi
