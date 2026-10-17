#!/usr/bin/env bash
# LAB-7197: copy the PR body's `## Scope` section to $DEST so a reviewer bot
# can tag each finding [IN-SCOPE] / [OUT-OF-SCOPE] / [HYPOTHETICAL].
#
# Inputs (env):
#   EVENT_PATH  event payload JSON to read the PR body from; defaults to
#               $GITHUB_EVENT_PATH. Only .pull_request.body is read: every
#               caller runs on pull_request events from the same repository.
#               The body is untrusted and read only as data, never
#               evaluated. It is never passed through env: a
#               65,536-char multibyte body exceeds Linux's 131072-byte limit
#               on one env entry, and the step's exec would fail with E2BIG.
#               A missing or unreadable file, a malformed payload or a
#               missing jq means no Scope and a ::warning:: in the job log; a
#               null body means no Scope. Either way the script exits 0.
#   DEST        output file (e.g. .claude-review/scope.md). Removed first;
#               written only when the Scope section has non-blank content.
#
# Shared by claude-code.yml, codex-code.yml, gemini-code.yml and grok-code.yml,
# which run it from the _pw checkout of this reusable's own SHA.
# test/review-scope-tags.test.sh exercises this file directly.
set -euo pipefail
rm -f -- "$DEST" "$DEST.tmp"
event="${EVENT_PATH:-${GITHUB_EVENT_PATH:-}}"
if ! body="$(jq -r '.pull_request.body // ""' "$event" 2>/dev/null)"; then
  echo "::warning::extract-pr-scope: cannot read the PR body from the event payload; no Scope section"
  body=""
fi
# perl on raw bytes (perl-base is Essential on ubuntu-24.04): mawk
# cannot match the zero-width/bidi code points, and byte matching
# never fails on invalid UTF-8. Hidden content is stripped BEFORE the
# heading match, so a commented-out heading is not a Scope section.
printf '%s\n' "$body" | perl -0777 -ne '
  # Drop the raw HTML whose text GitHub never renders: comments ("<!--" to
  # "-->"), processing instructions ("<?" to "?>"), CDATA ("<![CDATA[" to
  # "]]>") and declarations ("<!" + letter to ">"), each to the end of the
  # segment when unclosed. Drop it everywhere except inside a top-level fenced
  # code block: one opened at column 0 or 1, before any line that starts with
  # "<" (after any indent and blockquote or list markers) or with a fence
  # indented 2 or 3 spaces. Such a line may open an HTML block or a fence this
  # scan does not track, so after one no fence is trusted. Code spans are not exempt. Over-stripping is the cost; text
  # GitHub hides never reaches scope.md.
  sub strip_comments {
    my ($out, $seg, $fc, $fn, $distrust) = ("", "", "", 0, 0);
    my $end = qr/(?=\n\z)|\z/;
    my $hide = qr/<!--.*?(?:-->|$end)|<\?.*?(?:\?>|$end)|<!\[CDATA\[.*?(?:\]\]>|$end)|<![A-Za-z].*?(?:>|$end)/s;
    my $flush = sub { $seg =~ s/$hide//g; $out .= $seg; $seg = "" };
    for my $line (split /^/, $_[0]) {
      if ($fn) {
        $fn = 0 if $line =~ /\A {0,3}\Q$fc\E{$fn,}[ \t]*\n?\z/;
        $out .= $line;
        next;
      }
      if (!$distrust && $line =~ /\A ?(`{3,}(?![^\n]*`)|~{3,})/) {
        $flush->();
        ($fc, $fn) = (substr($1, 0, 1), length $1);
        # The info string is not shown, so hidden HTML there is dropped too.
        (my $open = $line) =~ s/$hide//g;
        $out .= $open;
        next;
      }
      $distrust = 1 if $line =~ /\A(?:[ \t]*(?:>|[-+*]|\d{1,9}[.)]))*[ \t]*<|\A {2,3}(?:`{3,}|~{3,})/;
      $seg .= $line;
    }
    $flush->();
    return $out;
  }
  s/\r\n?/\n/g;
  # Hidden HTML is stripped twice. The first pass ends it only at a literal
  # closer ("-->", "?>", "]]>", ">"), as GitHub does; the second catches an
  # opener such as "<!--" rebuilt by removing an invisible character from it.
  $_ = strip_comments($_);
  s/[\x00-\x08\x0B-\x1F\x7F]|\xC2[\x80-\x9F]//g;
  s/\xE2\x80[\x8B-\x8F\xAA-\xAE]|\xE2\x81[\xA0-\xA4\xA6-\xA9]|\xEF\xBB\xBF|\xEF\xB8[\x80-\x8F]//g;
  s/\xD8\x9C|\xC2\xAD|\xF3\xA0[\x80-\x81\x84-\x87][\x80-\xBF]//g;
  $_ = strip_comments($_);
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
