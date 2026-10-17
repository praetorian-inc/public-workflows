#!/usr/bin/env bash
# LAB-7197: copy the PR body's `## Scope` section to $DEST so a reviewer bot
# can tag each finding [IN-SCOPE] / [OUT-OF-SCOPE] / [HYPOTHETICAL].
#
# Inputs (env):
#   EVENT_PATH  event payload JSON to read the PR body from; defaults to
#               $GITHUB_EVENT_PATH. That is .pull_request.body, or for an
#               issue_comment on a PR (no .pull_request; .issue.pull_request
#               is set) .issue.body; a comment's own text is never read.
#               The body is untrusted and read only as data, never
#               evaluated. It is never passed through env: a
#               65,536-char multibyte body exceeds Linux's 131072-byte limit
#               on one env entry, and the step's exec would fail with E2BIG.
#               A missing or unreadable file, or a null body, means no Scope.
#   DEST        output file (e.g. .claude-review/scope.md). Removed first;
#               written only when the Scope section has non-blank content.
#
# Shared by claude-code.yml, codex-code.yml, gemini-code.yml and grok-code.yml,
# which run it from the _pw checkout of this reusable's own SHA.
# test/review-scope-tags.test.sh exercises this file directly.
set -euo pipefail
rm -f -- "$DEST" "$DEST.tmp"
event="${EVENT_PATH:-${GITHUB_EVENT_PATH:-}}"
if ! body="$(jq -r '.pull_request.body // (if .issue.pull_request then .issue.body else null end) // ""' "$event" 2>/dev/null)"; then
  echo "extract-pr-scope: cannot read the PR body from the event payload; no Scope section" >&2
  body=""
fi
# perl on raw bytes (perl-base is Essential on ubuntu-24.04): mawk
# cannot match the zero-width/bidi code points, and byte matching
# never fails on invalid UTF-8. Hidden content is stripped BEFORE the
# heading match, so a commented-out heading is not a Scope section.
printf '%s\n' "$body" | perl -0777 -ne '
  # Drop HTML comments ("<!--" to "-->", or to the end when unclosed), except
  # where GitHub surely shows "<!--" literally. Pairing that depends on where
  # a paragraph ends is not modeled; any doubt strips the comment, so text
  # GitHub hides never reaches scope.md. Kept are only:
  #  - fenced code at column 0 or 1 (never in a list item, blockquote or HTML
  #    block), with the fence rules of the heading pass below;
  #  - a code span opened and closed on one line, when the paragraph so far
  #    (since a blank or fence line) has no unclosed backtick run, no "<", no
  #    comment, and no line with "|", "[", "]", "www.", "://", "mailto:" or
  #    "xmpp:" (table cells, links, images and autolinks).
  # Link reference definitions are dropped too (see below).
  # A comment that spans lines ends where GitHub ends it only when it opens an
  # HTML block at column 0. Any other multi-line comment may hide a fence line
  # from the scan, so after one, no fence or code span is kept at all.
  # HTML blocks (a line starting with "<") get neither: they end at a blank
  # line, or after the line with the end marker for <pre>/<script>/<style>/
  # <textarea>, <!--, <?, <!X (uppercase X only) and <![CDATA[. Any other "<" line opens a block
  # in GitHub only when it is a block tag (div, table, ...) or, after a blank
  # line, a lone complete tag. Otherwise it may be paragraph text that a fence
  # can follow, so no fence or code span is kept from then on.
  my $blk6 = qr/\A {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|\/>|\n|\z)/i;
  my $blk7 = qr/\A {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\n"\x27=<>`]+|"[^"\n]*"|\x27[^\x27\n]*\x27))?)*+[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*\n?\z/;
  sub strip_comments {
    my ($s, $out, $fc, $fn, $html, $end, $taint, $distrust, $cpos) = ($_[0], "", "", 0, 0, "", 0, 0, -1);
    pos($s) = 0;
    # $cpos is the start of the current line when it opens a top-level "<!--"
    # HTML block. "<!-->" and "<!--->" end that block on their own line, so a
    # comment from them that spans lines is not trusted.
    my $comment = sub {
      my $blk = pos($s) == $cpos && substr($s, pos($s), 6) !~ /\A<!---?>/;
      return 0 unless $s =~ /\G<!--.*?(-->|\z)/gcs;
      $distrust = 1 if !$blk && $& =~ /\n/;
      $taint = 1; $html = 3 if $html == 2 && $end eq "-->" && $1 eq "-->";
      return 1;
    };
    my $drop = sub {
      $cpos = (!$html && substr($s, pos($s), 4) eq "<!--") ? pos($s) : -1;
      1 while $s =~ /\G[^\n<]+/gc || $comment->() || $s =~ /\G</gc;
      $s =~ /\G\n/gc;
    };
    while (pos($s) < length $s) {
      my $p = pos($s);
      if (!$p || substr($s, $p - 1, 1) eq "\n") {
        my ($line) = substr($s, $p) =~ /\A([^\n]*\n?)/;
        $html = 0 if $html == 3;
        $cpos = (!$html && $line =~ /\A<!--/) ? $p : -1;
        if ($fn) {
          $fn = 0 if $line =~ /\A {0,3}\Q$fc\E{$fn,}[ \t]*\n?\z/;
          $out .= $line; pos($s) = $p + length $line; next;
        }
        # A link reference definition renders as nothing (e.g. the
        # "[//]: # (note)" idiom), so drop it with every line after it up to a
        # blank line or a line that surely starts a new block. The label may
        # span lines; container prefixes (">", list markers) are allowed. A
        # comment opened in a dropped line is dropped to its end, so a "<!--"
        # block never resumes as visible text after a blank line. Inside an
        # HTML block such a line is raw HTML, and an HTML block opener (types
        # 1-6, which may interrupt a paragraph) ends the definition, so the
        # main scan sees both.
        if (!$html && substr($s, $p) =~ /\A((?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t\n]|\z)))*)[ \t]*\[(?:[^\]\[\\]|\\.)*\]:/
            && $& !~ /\n[ \t]*(?:\n|\z)/) {
          my $bq = $1 =~ />/;
          pos($s) = $p + length $&;
          $drop->();
          while (pos($s) < length $s) {
            my ($t) = substr($s, pos($s)) =~ /\A([^\n]*\n?)/;
            $t =~ s/\A(?: {0,3}>[ \t]?)*// if $bq;
            last if $t =~ /\A(?:[ \t]*\n?\z| {0,3}(?:#{1,6}(?:[ \t]|\n|\z)|`{3,}(?![^\n]*`)|~{3,}|[-*+][ \t]+\S|1[.)][ \t]+\S|(?:\*[ \t]*){3,}\n?\z|(?:-[ \t]*){3,}\n?\z|(?:_[ \t]*){3,}\n?\z))/
              || (!$bq && $t =~ /\A {0,3}>/) || $t =~ $blk6
              || $t =~ /\A {0,3}<(?:(?:pre|script|style|textarea)(?=[ \t>\n]|\z)|!--|\?|!\[CDATA\[|(?-i:![A-Z]))/i;
            # In a container GitHub may end on this line, even a lone tag
            # opens an HTML block.
            $distrust = 1 if $t =~ /\A {0,3}</;
            $drop->();
          }
          next;
        }
        if (!$html && !$distrust && $line =~ /\A ?(`{3,}(?![^\n]*`)|~{3,})/) {
          ($fc, $fn, $taint) = (substr($1, 0, 1), length $1, 0);
          $out .= $line; pos($s) = $p + length $line; next;
        }
        # GitHub opens a fence at up to 3 spaces; this scan does not.
        $distrust = 1 if $line =~ /\A {2,3}(?:`{3,}|~{3,})/;
        if ($line =~ /\A[ \t]*\n?\z/) {
          $taint = 0; $html = 0 if $html == 1;
        } elsif (!$html && $line =~ /\A {0,3}<(?:(pre|script|style|textarea)(?=[ \t>\n]|\z)|(!--)|(\?)|(!\[CDATA\[)|(?-i:(![A-Z])))?/i) {
          $end = defined $1 ? "</" . lc($1) . ">" : defined $2 ? "-->" : defined $3 ? "?>" : defined $4 ? "]]>" : defined $5 ? ">" : "";
          $html = $end eq "" ? 1 : 2;
          # As in GitHub, the opener line itself may end the block ("<?>").
          $html = 3 if $html == 2 && index(lc $line, $end) >= 0;
          my $q = rindex($s, "\n", $p - 2);
          $distrust = 1 if $html == 1 && $line !~ $blk6
            && !(($p == 0 || substr($s, $q + 1, $p - $q - 1) =~ /\A[ \t]*\n\z/) && $line =~ $blk7);
        } elsif ($html == 2 && index(lc $line, $end) >= 0) {
          $html = 3;
        }
        # A link, image or GFM autolink can swallow a backtick, and GFM splits
        # table cells at "|": no code span after any of them.
        $taint = 1 if $line =~ /[|\[\]]|www\.|:\/\/|mailto:|xmpp:/i;
      }
      if ($comment->()) {
      } elsif ($s =~ /\G(\\.)/gcs) {
        $out .= $1;
      } elsif ($s =~ /\G</gc) {
        $out .= "<"; $taint = 1;
      } elsif ($s =~ /\G(`+)/gc) {
        my $run = $1;
        $out .= $run;
        # A failed match keeps the old $1, so test the match itself.
        if (!$taint && !$html && !$distrust && $s =~ /\G([^\n]*?(?<!`)\Q$run\E(?!`))/gc) {
          $out .= $1;
        } else {
          $taint = 1;
        }
      } else {
        $s =~ /\G([^\n`<\\]+|.)/gcs; $out .= $1;
      }
    }
    return $out;
  }
  s/\r\n?/\n/g;
  # Comments are stripped twice. The first pass ends a comment only at a literal
  # "-->", as GitHub does; the second catches a "<!--" rebuilt by removing an
  # invisible character from inside it.
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
