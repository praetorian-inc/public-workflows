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
# boundary. Outside fenced code blocks, HTML comments and tags are stripped as
# a best-effort cleanup so PR-template guidance and markup do not read as
# Scope; nothing else is stripped, and it does not try to match what GitHub's
# renderer hides. That is safe because the bot prompt tags any problem the
# PR's diff introduced [IN-SCOPE] whatever Scope says (the SCOPE TAGS rule in
# claude-code.yml), and the human adjudicator re-classifies every finding.
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
# perl on raw bytes (perl-base is Essential on ubuntu-24.04): byte matching
# never fails on invalid UTF-8. Markup is stripped BEFORE the heading match,
# so a commented-out heading is not a Scope section.
printf '%s\n' "$body" | perl -0777 -ne '
  # Outside fenced code blocks, drop HTML comments and tags. A "<!--" that
  # starts a line (0-3 spaces in) runs to the first "-->", or to the end when
  # unclosed; a fence line inside it is comment text and opens or closes no
  # fence. "<!-->" and "<!--->" are empty comments that close at once. A
  # "<!--" later in a line must close on that line, else
  # it is kept as text, as GitHub shows it (a code span often holds one). Each
  # chunk between fences starts at a line start, so "^" holds there too. A tag
  # is "<" or "</" and a letter, to the next ">" on the same line with no "<"
  # before it. A tag never spans a
  # line: a stray "<" in prose must never delete text, and a line break is the
  # only boundary that keeps it from running across list items, quotes, breaks
  # and headings to a later ">". Hiding a tag that spans lines is a non-goal
  # under the contract above. Inside a fence they are code and are kept.
  my ($txt, $seg, $fc, $fn, $cm) = ("", "", "", 0, 0);
  my $strip = sub {
    $seg =~ s/(?:(?m:^) {0,3}<!--(?:-?>|.*?(?:-->|(?=\n\z)|\z))|<!--[^\n]*?-->)|<\/?[A-Za-z][^<>\n]*>//gs;
    ($txt, $seg) = ($txt . $seg, "");
  };
  s/\r\n?/\n/g;
  # A fence is ``` or ~~~ (3+); a backtick opener whose info string has a
  # backtick is plain text, not a fence. A fence closes on 3+ of the same char
  # ($fc) at least as long as the opener ($fn). $cm is set while a line-start
  # "<!--" with no "-->" after it is open; it closes on the first "-->". Inside
  # a fence a "<!--" is code and opens no comment.
  for (split /^/) {
    if ($fn) { $fn = 0 if /\A {0,3}\Q$fc\E{$fn,}[ \t]*\n?\z/ }
    elsif ($cm) { $cm = 0 if /-->/; $seg .= $_; next }
    elsif (/\A {0,3}(`{3,}(?!.*`)|~{3,})/) { $strip->(); ($fc, $fn) = (substr($1, 0, 1), length $1) }
    else { $cm = 1 if /\A {0,3}<!--(?!-?>)(?!.*-->)/; $seg .= $_; next }
    $txt .= $_;
  }
  $strip->();
  # A heading inside a fence neither starts nor ends Scope. Fenced lines
  # inside Scope are kept as content.
  my ($grab, @out) = (0);
  ($fc, $fn) = ("", 0);
  for (split /\n/, $txt, -1) {
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
