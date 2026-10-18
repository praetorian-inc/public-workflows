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
# Contract: scope.md is a hint for the reviewer's tags, not a security
# boundary. Stripping HTML comments, tags and other markup is a best-effort
# cleanup so PR-template guidance and markup do not read as Scope; it does not
# promise to match exactly what GitHub's renderer hides. That is safe because
# the bot prompt tags any problem the PR's diff introduced [IN-SCOPE] whatever
# Scope says (the SCOPE TAGS rule in claude-code.yml), and the human
# adjudicator re-classifies every finding.
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
# never fails on invalid UTF-8. Markup is stripped BEFORE the heading
# match, so a commented-out heading is not a Scope section.
printf '%s\n' "$body" | perl -0777 -ne '
  # Best-effort cleanup, not an exact model of the GitHub renderer (see the
  # contract above). Drop the raw HTML GitHub does not render: comments ("<!--" to
  # "-->"), processing instructions ("<?" to "?>"), CDATA ("<![CDATA[" to
  # "]]>"), and any other "<!" or "</" (a declaration, closing tag or bogus
  # comment) to the next ">", each to the end of the segment when unclosed or
  # when a "<" comes first, so it never ends inside the quoted value of a later
  # tag. Drop every tag and autolink too ("<" + letter to the next ">" outside
  # quotes, across lines, or to the end of the segment when none follows, as an
  # unclosed quote hides the rest): attribute values are never shown, and an
  # autolink inside an HTML block is hidden. A quoted value never spans a "<",
  # so a stray quote cannot pair with the quote of a later tag and expose its
  # value, nor a blank line, which ends an HTML block and leaves the quote
  # open in the page, where it hides what follows. Then drop the info string of every line shaped like a fence opener
  # (it is never shown). Drop the lines of every link reference definition
  # and footnote definition too: both render as nothing. They are matched on
  # the raw text, as HTML may hold the "]:", and never span a blank line or a
  # heading. A definition starts on a line that begins (after indent and
  # container markers) with a label whose first "]" is followed by ":", where
  # the line may start a block: not where it would continue a paragraph. It
  # ends where its destination and optional title end, and another may follow.
  # A footnote "[^x]:" may interrupt a paragraph and holds its lazy lines and
  # the indented lines after a blank line. Drop
  # it all everywhere except inside a top-level fenced code block: one opened
  # at column 0 or 1, before
  # any line that starts with "<" (after any indent and blockquote or list
  # markers) or with a fence indented 2 or 3 spaces. Such a line may open an
  # HTML block or a fence this scan does not track, so after one no fence is
  # trusted. Code spans are not exempt. Where the pairing is uncertain this
  # leans toward stripping; it may still keep or drop text GitHub would not.
  sub strip_comments {
    my ($out, $seg, $fc, $fn, $distrust) = ("", "", "", 0, 0);
    my $end = qr/(?=\n\z)|\z/;
    # A newline inside a quoted value: an HTML block ends at a blank line.
    my $in = qr/\n(?![ \t>]*\n)/;
    my $hide = qr/<!--.*?(?:-->|$end)|<\?.*?(?:\?>|$end)|<!\[CDATA\[.*?(?:\]\]>|$end)|<\/?[A-Za-z](?:(?:"(?:[^"<\n]|$in)*"|\x27(?:[^\x27<\n]|$in)*\x27|[^>"\x27])*>|.*?$end)|<[\/!](?:[^<>]*>|.*?$end)/s;
    my $head = qr/\A {0,3}#{1,6}(?:[ \t]|$)/;
    # Indent and container markers: ">" and a list marker before a space.
    my $box = qr/(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=\s|\z)))*[ \t]*/;
    # A newline inside a definition: never one before a blank line or heading.
    my $nl = qr/\n(?!(?: {0,3}> ?)*[ \t]*(?:\n|\z)|(?: {0,3}> ?)* {0,3}#{1,6}(?:[ \t\n]|\z))/;
    my $ws = qr/(?:[ \t]+(?:$nl[ \t>]*)?|$nl[ \t>]*)/;
    # The ":" checks sit in lookaheads so that perl does not scan the whole
    # text for them at every line.
    my $def = qr/\[(?>(?:[^\[\]\\\n]|\\[^\n]|\\(?=\n)|$nl)+)(?=\]:)..$ws?(?><(?:[^<>\\\n]|\\[^\n])*>|[^<\s]\S*)(?:$ws(?:"(?:[^"\\\n]|\\[^\n]|\\(?=\n)|$nl)*"|\x27(?:[^\x27\\\n]|\\[^\n]|\\(?=\n)|$nl)*\x27|\((?:[^()\\\n]|\\[^\n]|\\(?=\n)|$nl)*\)))?[ \t]*(?=\n|\z)/;
    my $flush = sub {
      $seg =~ tr/\x01//d;
      # Hidden HTML leaves each of its newlines as "\x01\n", so line i of $h
      # is what remains of raw line i; the markers are removed at the end.
      (my $h = $seg) =~ s/$hide/"\x01\n" x (() = $& =~ m{\n}g)/ge;
      $h =~ s/^((?:[ \t]*(?:>|[-+*]|\d{1,9}[.)]))*[ \t]*(?:`{3,}(?![^\n]*`)|~{3,}))[^\x01\n]*/$1/gm;
      my @r = split /^/, $seg;
      my @h = split /^/, $h;
      my ($o, $i, $at, $lt, $open) = ("", 0, 0, 0, 1);
      while ($i <= $#r) {
        my ($n, $p) = (0, $i ? $r[$i - 1] : "\n");
        if ($r[$i] =~ /\A($box)\[/) {
          my $c = $1;
          pos($seg) = $at + length $c;
          if ($seg =~ /\G(?=\[\^[^\]\s]+\]:)/) {
            # It ends where a line, inside the quotes the footnote sits in,
            # starts a list item, a quote, a fence or a break.
            my ($gap, $d) = (0, $c =~ tr/>//);
            for ($n = 1; $i + $n <= $#r && $r[$i + $n] !~ $head; $n++) {
              (my $l = $r[$i + $n]) =~ s/\A(?: {0,3}> ?){0,$d}//;
              if ($r[$i + $n] =~ /\A[ \t>]*\n?\z/) { $gap = 1 }
              elsif ($gap && $r[$i + $n] !~ /\A(?: {4}|[ \t]*\t)/) { last }
              elsif (!$gap && $l =~ /\A {0,3}(?:>|[-+*](?=[ \t\n]|\z)|\d{1,9}[.)](?=[ \t\n]|\z)|`{3,}(?![^\n]*`)|~{3,}|(?:[-*_][ \t]*){3,}\n?\z)/) { last }
              else { $gap = 0 }
            }
          } else {
            # The line may start a block after a blank line, a definition,
            # a heading, a break or setext underline, a fence, indented code,
            # or the end of an HTML block, or when it opens a list item or
            # one more blockquote.
            my ($q) = $p =~ /\A($box)/;
            $open ||= $p =~ /\A$box(?:[-*_=][-*_= \t]*|#{1,6}(?:[ \t][^\n]*)?|(?:`{3,}|~{3,})[^\n]*)?\n?\z/
              || $p =~ /\A(?:[ \t]*>)*(?: {4}|[ \t]*\t)/ || ($lt && $p =~ />/)
              || $c =~ /[-+*\d]/ || ($c =~ tr/>//) > ($q =~ tr/>//);
            pos($seg) = $at + length $c;
            $n = 1 + (substr($seg, $at, pos($seg) - $at) =~ tr/\n//) if $open && $seg =~ /\G$def/g;
          }
        }
        my $k = $n || 1;
        for (1 .. $k) {
          $lt ||= index($r[$i], "<") >= 0;
          $o .= $h[$i] unless $n;
          $at += length $r[$i++];
        }
        $open = $n ? 1 : 0;
      }
      $o =~ s/\x01\n//g;
      $out .= $o;
      $seg = "";
    };
    for my $line (split /^/, $_[0]) {
      if ($fn) {
        $fn = 0 if $line =~ /\A {0,3}\Q$fc\E{$fn,}[ \t]*\n?\z/;
        $out .= $line;
        next;
      }
      if (!$distrust && $line =~ /\A ?(`{3,}(?![^\n]*`)|~{3,})/) {
        $flush->();
        ($fc, $fn) = (substr($1, 0, 1), length $1);
        # The info string is not shown, so it is dropped.
        $out .= substr($line, 0, $+[1]) . ($line =~ /\n\z/ ? "\n" : "");
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
    # An ATX closing sequence ("#"s after a space or tab) is not heading text.
    elsif (/^ {0,3}##[ \t]+scope[ \t]*(?:\([^)]*\))?[ \t]*:?(?:[ \t]+#+)?[ \t]*\z/i) { $grab = 1; next }
    push @out, $_ if $grab;
  }
  print join("\n", @out), "\n" if grep { /\S/ } @out;
' > "$DEST.tmp"
if [ -s "$DEST.tmp" ]; then
  mv -- "$DEST.tmp" "$DEST"
else
  rm -f -- "$DEST.tmp"
fi
