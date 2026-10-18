#!/usr/bin/env bash
# LAB-7197: every reviewer bot reads the PR body's `## Scope` section as
# untrusted data and tags each finding [IN-SCOPE] / [OUT-OF-SCOPE] /
# [HYPOTHETICAL]. With no Scope section it says "No Scope section found" and
# reviews untagged. The tag strings are a contract shared with the
# adjudicator's parser (LAB-7196) — change them in both places or neither.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

STEP_NAME='Extract PR Scope section'
PW_SCRIPT='_pw/.github/actions/extract-pr-scope/extract-pr-scope.sh'
EXTRACT="$REPO_ROOT/.github/actions/extract-pr-scope/extract-pr-scope.sh"

# Print the dedented `run: |` body of the named step.
extract_run() {
  awk -v name="$STEP_NAME" '
    index($0, "- name: " name) { instep = 1; next }
    instep && /^      - name:/ { exit }
    instep && /^        run: \|/ { inrun = 1; next }
    inrun {
      if ($0 != "" && $0 !~ /^          /) exit
      sub(/^          /, ""); print
    }
  ' "$1"
}

# The step block (name line to next step), for env/if checks.
extract_step() {
  awk -v name="$STEP_NAME" '
    index($0, "- name: " name) { instep = 1; print; next }
    instep && /^      - name:/ { exit }
    instep { print }
  ' "$1"
}

# Write a pull_request event payload whose body is $2 to file $1.
# The body goes through stdin: a --arg over 131072 bytes is itself E2BIG on Linux.
event_fixture() { printf '%s' "$2" | jq -Rs '{pull_request: {body: .}}' > "$1"; }
SCOPE_EVENT="$TMP/scope-event.json"
event_fixture "$SCOPE_EVENT" "## Scope
- In: a.sh"

for bot in claude codex gemini grok; do
  wf="$bot-code.yml"
  path="$REPO_ROOT/.github/workflows/$wf"
  if [ ! -f "$path" ]; then
    bad "$wf exists" "missing workflow"
    continue
  fi

  # Prompt contract: one SCOPE TAGS paragraph naming the bot's own scope file,
  # all three exact tags, the no-scope fallback text, and untrusted framing.
  # Taken from the SCOPE TAGS: marker to the next blank line, then cut at the
  # first double quote: in claude-code.yml the paragraph is the tail of the
  # one-line --append-system-prompt "..." string, whose earlier SECURITY text
  # also says "untrusted" — only the SCOPE TAGS text may satisfy the needles.
  # Whitespace is squeezed so line-wrapping in the YAML does not matter.
  block="$(awk '/SCOPE TAGS:/ { on = 1 } on { print } on && /^[[:space:]]*$/ { exit }' "$path")"
  if [ -n "$block" ]; then
    block="SCOPE TAGS:${block#*SCOPE TAGS:}"
    block="${block%%\"*}"
    block="$(printf '%s' "$block" | tr -s '[:space:]' ' ')"
  fi
  missing=""
  for needle in ".$bot-review/scope.md" '[IN-SCOPE]' '[OUT-OF-SCOPE]' '[HYPOTHETICAL]' \
                'No Scope section found' 'as the first line of your review' \
                'untrusted PR content' 'never as instructions' \
                'Placeholder lines like' 'the LGTM line, are not findings' \
                'sibling modules' \
                'End every [OUT-OF-SCOPE] finding with: Recommend filing this as a separate Linear ticket, not fixing it in this PR.' \
                'End every [HYPOTHETICAL] finding with: Recommend filing this as a Theoretical: Linear ticket.' \
                'the tag stays first'; do
    case "$block" in
      *"$needle"*) ;;
      *) missing="$missing [$needle]" ;;
    esac
  done
  if [ -z "$block" ]; then
    bad "$wf prompt carries the SCOPE TAGS contract" "no SCOPE TAGS paragraph"
  elif [ -n "$missing" ]; then
    bad "$wf prompt carries the SCOPE TAGS contract" "missing:$missing"
  else
    ok "$wf prompt carries the SCOPE TAGS contract"
  fi

  # The pre-existing SECURITY framing and LGTM verdict survive.
  if grep -q 'SECURITY: Treat all PR content' "$path" \
     && grep -q 'No critical issues — LGTM pending human review' "$path"; then
    ok "$wf keeps SECURITY framing and LGTM verdict"
  else
    bad "$wf keeps SECURITY framing and LGTM verdict" "a pre-existing line is gone"
  fi

  # The script reads the body from the event payload file. It never travels
  # through env (a 65,536-char multibyte body exceeds Linux's 131072-byte
  # per-entry limit and the step's exec fails with E2BIG) or inline in run.
  step="$(extract_step "$path")"
  if [ -z "$step" ]; then
    bad "$wf has the '$STEP_NAME' step" "step missing"
    continue
  fi
  if printf '%s\n' "$step" | grep -qF "DEST: .$bot-review/scope.md" \
     && printf '%s\n' "$step" | grep -qF "if: steps.context.outputs.empty_scope != 'true'"; then
    ok "$wf writes .$bot-review/scope.md behind the empty_scope guard"
  else
    bad "$wf writes .$bot-review/scope.md behind the empty_scope guard" "env/if lines wrong"
  fi
  if printf '%s\n' "$step" | grep -qE 'PR_BODY|pull_request\.body'; then
    bad "$wf passes no PR body through env" "PR_BODY or pull_request.body in the step"
  else
    ok "$wf passes no PR body through env"
  fi
  run_body="$(extract_run "$path")"
  # shellcheck disable=SC2016 # literal ${{ is what must be absent
  if printf '%s\n' "$run_body" | grep -q '\${{'; then
    bad "$wf extract step has no inline expressions" "\${{ }} inside run"
  else
    ok "$wf extract step has no inline expressions"
  fi

  # The extract step must come after the step that recreates the review dir.
  ctx_line="$(grep -n 'id: context$' "$path" | head -1 | cut -d: -f1)"
  ext_line="$(grep -nF -- "- name: $STEP_NAME" "$path" | head -1 | cut -d: -f1)"
  if [ -n "$ctx_line" ] && [ -n "$ext_line" ] && [ "$ext_line" -gt "$ctx_line" ]; then
    ok "$wf extracts after Build review context"
  else
    bad "$wf extracts after Build review context" "context=$ctx_line extract=$ext_line"
  fi

  # The extractor lives in ONE shared script, run from the _pw checkout of this
  # reusable's own SHA — never inlined in the workflow, never a `uses:` (which
  # would resolve against the caller's repo).
  # shellcheck disable=SC2016 # literal ${{ }} is the expected YAML text
  if printf '%s\n' "$run_body" | grep -qF "script=$PW_SCRIPT" \
     && printf '%s\n' "$run_body" | grep -qF 'bash "$script"' \
     && printf '%s\n' "$step" | grep -qF 'CHECKOUT_OK: ${{ steps.checkout-pw.outcome }}'; then
    ok "$wf calls the shared extract-pr-scope script from _pw"
  else
    bad "$wf calls the shared extract-pr-scope script from _pw" "run/env does not invoke $PW_SCRIPT"
  fi
  if grep -q 'perl -0777' "$path"; then
    bad "$wf carries no inline copy of the extractor" "perl -0777 found in workflow"
  else
    ok "$wf carries no inline copy of the extractor"
  fi
  # The step must run while the trusted _pw checkout exists: after
  # checkout-pw, before the step that removes it.
  # The graph-fetch job has its own checkout-pw; take the review job's, the
  # first one after Build review context.
  pw_line="$(awk -v c="${ctx_line:-0}" 'NR > c && /id: checkout-pw$/ { print NR; exit }' "$path")"
  rm_line="$(awk -v c="${ctx_line:-0}" 'NR > c && index($0, "- name: Remove stage-script checkout") { print NR; exit }' "$path")"
  if [ -n "$pw_line" ] && [ -n "$rm_line" ] && [ -n "$ext_line" ] \
     && [ "$ext_line" -gt "$pw_line" ] && [ "$ext_line" -lt "$rm_line" ]; then
    ok "$wf extracts while the _pw checkout exists"
  else
    bad "$wf extracts while the _pw checkout exists" "checkout-pw=$pw_line extract=$ext_line remove=$rm_line"
  fi

  # Wrapper behaviour: only a successful trusted checkout may supply the
  # script; otherwise a stale scope.md is removed and a PR-planted _pw script
  # never runs.
  wdir="$TMP/wrap-$bot"
  mkdir -p "$wdir/.x-review" "$wdir/$(dirname "$PW_SCRIPT")"
  printf 'stale\n' > "$wdir/.x-review/scope.md"
  printf 'touch planted-ran\n' > "$wdir/$PW_SCRIPT"
  printf '%s\n' "$run_body" > "$TMP/wrap-$bot.sh"
  if (cd "$wdir" && CHECKOUT_OK=failure EVENT_PATH="$SCOPE_EVENT" DEST=.x-review/scope.md bash -e "$TMP/wrap-$bot.sh") >/dev/null 2>&1 \
     && [ ! -e "$wdir/.x-review/scope.md" ] && [ ! -e "$wdir/planted-ran" ]; then
    ok "$wf skips a planted script and clears scope.md when checkout-pw failed"
  else
    bad "$wf skips a planted script and clears scope.md when checkout-pw failed" "planted ran, scope.md survived, or the step failed"
  fi
  wdir="$TMP/wrap-ok-$bot"
  mkdir -p "$wdir/.x-review" "$wdir/$(dirname "$PW_SCRIPT")"
  # A stub stands in for the trusted script, so this proves the step
  # delegates to it rather than extracting on its own.
  # shellcheck disable=SC2016 # $DEST expands when the stub runs
  printf 'printf "stub-ran\\n" > "$DEST"\n' > "$wdir/$PW_SCRIPT"
  if (cd "$wdir" && CHECKOUT_OK=success EVENT_PATH="$SCOPE_EVENT" DEST=.x-review/scope.md bash -e "$TMP/wrap-$bot.sh") >/dev/null 2>&1 \
     && [ "$(cat "$wdir/.x-review/scope.md" 2>/dev/null)" = "stub-ran" ]; then
    ok "$wf runs the shared script when checkout-pw succeeded"
  else
    bad "$wf runs the shared script when checkout-pw succeeded" "scope.md not written by the shared script"
  fi
  # Fail open: an extractor failure leaves no scope.md (not even a partial
  # one) and does not fail the step, so the review runs as if no Scope.
  wdir="$TMP/wrap-fail-$bot"
  mkdir -p "$wdir/.x-review" "$wdir/$(dirname "$PW_SCRIPT")"
  # shellcheck disable=SC2016 # $DEST expands when the stub runs
  printf 'printf "partial\\n" > "$DEST"; printf "x\\n" > "$DEST.tmp"; exit 7\n' > "$wdir/$PW_SCRIPT"
  if (cd "$wdir" && CHECKOUT_OK=success EVENT_PATH="$SCOPE_EVENT" DEST=.x-review/scope.md bash -e "$TMP/wrap-$bot.sh") >"$wdir/log" 2>&1 \
     && [ ! -e "$wdir/.x-review/scope.md" ] && [ ! -e "$wdir/.x-review/scope.md.tmp" ] \
     && grep -q '::warning::' "$wdir/log"; then
    ok "$wf fails open when the shared script fails"
  else
    bad "$wf fails open when the shared script fails" "step failed, scope.md survived, or no warning"
  fi
done

# CI runs this suite, and changes to the shared script trigger it.
sa="$REPO_ROOT/.github/workflows/self-audit.yml"
n_paths="$(grep -cF -- "- 'test/review-scope-tags.test.sh'" "$sa")"
n_actions="$(grep -cF -- "- '.github/actions/**'" "$sa")"
if [ "$n_paths" -eq 2 ] && [ "$n_actions" -eq 2 ] \
   && grep -qE '^        run: bash test/review-scope-tags\.test\.sh$' "$sa"; then
  ok "self-audit.yml lists and runs review-scope-tags.test.sh"
else
  bad "self-audit.yml lists and runs review-scope-tags.test.sh" "paths=$n_paths actions-glob=$n_actions or run step missing"
fi

# Behavioral cases: run the shared script against fixture bodies.
run_case() { # name body expect(absent|<expected file content>)
  local name="$1" body="$2" expect="$3" dir
  dir="$TMP/$name"
  mkdir -p "$dir/.x-review"
  event_fixture "$dir/event.json" "$body"
  run_case_event "$name" "$dir/event.json" "$expect"
}
run_case_event() { # name event-file expect(absent|<expected file content>)
  local name="$1" event="$2" expect="$3" dir
  dir="$TMP/$name"
  mkdir -p "$dir/.x-review"
  if ! (cd "$dir" && EVENT_PATH="$event" DEST=.x-review/scope.md bash -e "$EXTRACT") >"$dir/log" 2>&1; then
    bad "extract: $name" "script failed: $(cat "$dir/log")"
    return
  fi
  if [ "$expect" = absent ]; then
    if [ -e "$dir/.x-review/scope.md" ]; then
      bad "extract: $name" "scope.md written: $(cat "$dir/.x-review/scope.md")"
    else
      ok "extract: $name"
    fi
    return
  fi
  if [ ! -f "$dir/.x-review/scope.md" ]; then
    bad "extract: $name" "scope.md not written"
  elif [ "$(cat "$dir/.x-review/scope.md")" = "$expect" ]; then
    ok "extract: $name"
  else
    bad "extract: $name" "got: $(cat "$dir/.x-review/scope.md")"
  fi
}

if [ -f "$EXTRACT" ]; then
  CR=$'\r'
  with_scope="## Summary${CR}
Fixes the thing.${CR}
${CR}
## Scope${CR}
### Scope In${CR}
- .github/workflows/codex-code.yml${CR}
### Scope Out${CR}
- guard${CR}
${CR}
## Test plan${CR}
- run tests${CR}"
  expect_scope="### Scope In
- .github/workflows/codex-code.yml
### Scope Out
- guard"
  run_case with-scope-crlf "$with_scope" "$expect_scope"
  run_case no-scope "## Summary
Just a body.
## Test plan
- none" absent
  run_case empty-body "" absent
  run_case scope-heading-empty "## Scope

## Test plan
- x" absent
  run_case scope-last-section "Intro
## Scope
- In: a.sh
- Out: b.sh" "- In: a.sh
- Out: b.sh"
  run_case scope-prefix-not-heading "## Scoped notes
- not scope" absent
  run_case top-level-heading-ends-scope "## Scope
- In: a.sh
# Appendix
- not scope" "- In: a.sh"
  # Heading forms (guard#9214 uses "## Scope (from the ticket)").
  for h in '## Scope' '## scope' '## Scope:' '## Scope (from the ticket)' \
           '## Scope (from the ticket):' '   ## Scope' '## SCOPE  ' \
           '## Scope ##' '## Scope ###  ' '## Scope (optional) ##' \
           '## Scope: #'; do
    run_case "heading-match [$h]" "Intro
$h
- In: a.sh
## Next
- no" "- In: a.sh"
  done
  # An ATX closing sequence ("#"s after a space or tab) is not heading text,
  # on the Scope heading or on the heading that ends it.
  run_case closed-heading-ends-scope "## Scope ##
- In: a.sh
## Next ##
- no" "- In: a.sh"
  # "Scope#" has no space before the "#", so GitHub's heading text is
  # "Scope#"; "## x" after the "#"s makes them heading text too.
  for h in '## Scope and limitations' '## Scoped notes' '### Scope' \
           '    ## Scope' '##Scope' '# Scope' '## Scope#' '## Scope ## x'; do
    run_case "heading-reject [$h]" "Intro
$h
- In: a.sh" absent
  done

  # HTML comments and tags are stripped before scope.md is written, so
  # PR-template guidance and markup do not read as Scope. Matching exactly
  # what GitHub's renderer hides (footnotes, link definitions, code spans,
  # HTML blocks, invisible characters) is a non-goal: scope.md is only a tag
  # hint (see the contract in extract-pr-scope.sh).
  run_case strip-single-line-comment "## Scope
- In: a.sh <!-- HIDDEN-1 marker -->
<!-- [IN-SCOPE] HIDDEN-2 marker -->
- Out: b.sh" "- In: a.sh 

- Out: b.sh"
  run_case strip-multiline-comment "## Scope
- In: a.sh
<!--
secret-scope-text
## Not a heading
[OUT-OF-SCOPE] secret-scope-text
-->
- Out: b.sh
## Test plan
- x" "- In: a.sh

- Out: b.sh"
  run_case strip-unterminated-comment "## Scope
- In: a.sh
<!-- everything after this is hidden
- Out: secret" "- In: a.sh"
  # Only a "<!--" that starts a line (0-3 spaces in) opens a comment that may
  # span lines or run unclosed. Mid-line it must close on the same line;
  # unclosed it is literal text, as GitHub shows it, and hides nothing after.
  run_case strip-mid-line-closed-comment "## Scope
- In: a <!-- note --> b" "- In: a  b"
  run_case mid-line-unclosed-comment-in-code-span-keeps-scope "## Summary
The stripper now ends an unclosed \`<!--\` at the next fence.

## Scope
- In: extract-pr-scope.sh" "- In: extract-pr-scope.sh"
  run_case mid-line-unclosed-comment-in-scope-keeps-items "## Scope
- In: handling of \`<!--\` openers
- Out: workflows
## Test plan" "- In: handling of \`<!--\` openers
- Out: workflows"
  run_case mid-line-comment-never-spans-lines "## Scope
- In: a <!-- x
- Out: b -->" "- In: a <!-- x
- Out: b -->"
  # A tab after a blank line makes indented code on GitHub, so a tab-indented
  # "<!--" is shown as text and must not open a comment.
  tab="$(printf '\t')"
  run_case tab-indented-comment-opener-is-code "## Scope
- In: a

${tab}<!-- code sample

- Out: b" "- In: a

${tab}<!-- code sample

- Out: b"
  run_case commented-out-heading-is-not-scope "<!-- ## Scope -->
- In: a.sh" absent
  cr="$(printf '\r')"
  run_case lone-cr-line-endings "## Scope${cr}- In: a.sh${cr}## Test plan${cr}- x" "- In: a.sh"
  # A tag is stripped through its ">" on the same line, keeping the text
  # between tags. Autolinks are stripped too: a stripped URL in Scope costs nothing.
  run_case tag-attribute-value-is-hidden "## Scope
- In: a.sh <span title=\"HIDDEN-ATTR marker\">x</span>
- In: b.sh" "- In: a.sh x
- In: b.sh"
  run_case autolinks-and-tags-stripped "## Scope
- See <https://example.com/x> and <user@example.com> <b title=\"HIDDEN-AL\">bold</b>" "- See  and  bold"
  # A tag never spans a line, so a stray "<" and a later ">" cannot delete the
  # blank lines, headings or list items between them.
  run_case lt-before-scope-keeps-scope "## Summary
fixes the a<b check

## Scope
- only the parser

## Notes
flow: x -> y" "- only the parser"
  run_case lt-in-scope-keeps-next-heading "## Scope
- In: a<b check

## Next
- no
flow: x -> y" "- In: a<b check"
  run_case lt-before-unspaced-scope-keeps-scope "## Summary
fixes a<b
## Scope
- only
## Notes
x -> y" "- only"
  run_case lt-in-scope-keeps-unspaced-next-heading "## Scope
- In: a<b
## Test plan
- run x -> y" "- In: a<b"
  run_case lt-in-list-keeps-later-items "## Scope
- In: fix a<b compare
- Out: UI
- Out: x -> y" "- In: fix a<b compare
- Out: UI
- Out: x -> y"

  # Fenced code blocks: a heading inside a fence neither starts nor ends Scope.
  bt='```'
  td='~~~'
  run_case fenced-backtick-example-is-not-scope "How to write one:
${bt}markdown
## Scope
- In: example.sh
${bt}
## Test plan
- x" absent
  run_case fenced-tilde-example-is-not-scope "How to write one:
${td}
## Scope
- In: example.sh
${td}" absent
  run_case fence-inside-scope-keeps-heading "## Scope
- In: a.sh
${bt}sh
# not a heading
## Also not a heading
${bt}
- Out: b.sh
## Test plan
- x" "- In: a.sh
${bt}sh
# not a heading
## Also not a heading
${bt}
- Out: b.sh"
  # A backtick in a backtick fence's info string makes it plain text, not a
  # fence, so the next ``` opens the real code block.
  run_case backtick-info-string-is-not-a-fence "${bt}a\`b
${bt}
## Scope
- In: fenced-example
${bt}" absent
  run_case real-scope-after-fenced-example "${bt}
## Scope
- In: example.sh
${bt}
## Scope
- In: real.sh
## Test plan
- x" "- In: real.sh"

  # Inside a fence "<!--" is code, so an unclosed one there hides nothing and
  # must not delete the real Scope after it.
  run_case unclosed-comment-in-fence-keeps-scope "Example:
${bt}html
<!-- an unclosed comment
${bt}
## Scope
- In: real.sh" "- In: real.sh"
  run_case unclosed-comment-in-tilde-fence-keeps-scope "${td}
<!--
${td}
## Scope
- In: real.sh" "- In: real.sh"
  run_case comment-in-fence-inside-scope-is-content "## Scope
- In: a.html
${bt}html
<!-- keep: this is visible code -->
${bt}" "- In: a.html
${bt}html
<!-- keep: this is visible code -->
${bt}"
  run_case fence-with-one-leading-space-keeps-comment "## Scope
 ${bt}
<!-- shown -->
 ${bt}" " ${bt}
<!-- shown -->
 ${bt}"
  run_case comment-with-fake-scope-after-code-is-hidden "Uses \`code\` and:
${bt}
x
${bt}
<!--
## Scope
- In: secret-scope-text
-->
visible tail" absent

  # The body comes from the event payload file, never from env. GitHub allows
  # 65,536 characters; in multibyte text that passes Linux's 131072-byte
  # per-env-entry limit, where an env-passed body fails the step with E2BIG.
  big="$(perl -e 'print "\xe4\xb8\xad" x 45000')"
  run_case large-multibyte-body "## Scope
- In: a.sh
## Notes
${big}" "- In: a.sh"
  big_bytes="$(jq -r '.pull_request.body' "$TMP/large-multibyte-body/event.json" | wc -c | tr -d ' ')"
  if [ "$big_bytes" -gt 131072 ]; then
    ok "extract: large body fixture exceeds 131072 bytes ($big_bytes)"
  else
    bad "extract: large body fixture exceeds 131072 bytes" "only $big_bytes bytes"
  fi
  mkdir -p "$TMP/events"
  printf '{"pull_request": {"body": null}}\n' > "$TMP/events/null-body.json"
  run_case_event null-body "$TMP/events/null-body.json" absent
  printf '{"pull_request": {"body": "## Scope\\n- In: a.sh"' > "$TMP/events/invalid.json"
  run_case_event invalid-event-json "$TMP/events/invalid.json" absent
  run_case_event missing-event-file "$TMP/events/does-not-exist.json" absent
  # A payload jq cannot read still exits 0 with no scope.md, but says so in
  # the job log.
  mkdir -p "$TMP/nojq-bin"
  for tool in rm perl mv; do ln -s "$(command -v "$tool")" "$TMP/nojq-bin/$tool"; done
  mkdir -p "$TMP/no-jq/.x-review"
  event_fixture "$TMP/no-jq/event.json" "## Scope
- In: a.sh"
  if (cd "$TMP/no-jq" && PATH="$TMP/nojq-bin" EVENT_PATH="$TMP/no-jq/event.json" DEST=.x-review/scope.md "$BASH" -e "$EXTRACT") >"$TMP/no-jq/log" 2>&1; then
    ok "extract: no-jq exits 0"
  else
    bad "extract: no-jq exits 0" "script failed: $(cat "$TMP/no-jq/log")"
  fi
  for name in invalid-event-json missing-event-file no-jq; do
    if [ ! -e "$TMP/$name/.x-review/scope.md" ] && grep -q '^::warning::' "$TMP/$name/log"; then
      ok "extract: $name warns and writes nothing"
    else
      bad "extract: $name warns and writes nothing" "log: $(cat "$TMP/$name/log")"
    fi
  done
  # With no event path at all, the script falls back to $GITHUB_EVENT_PATH
  # and, when that is unset too, writes nothing and still exits 0.
  mkdir -p "$TMP/no-event/.x-review"
  printf 'stale\n' > "$TMP/no-event/.x-review/scope.md"
  if (cd "$TMP/no-event" && env -u EVENT_PATH -u GITHUB_EVENT_PATH DEST=.x-review/scope.md bash -e "$EXTRACT") >/dev/null 2>&1 \
     && [ ! -e "$TMP/no-event/.x-review/scope.md" ]; then
    ok "extract: no event path writes nothing"
  else
    bad "extract: no event path writes nothing" "script failed or stale scope.md survived"
  fi
  mkdir -p "$TMP/gh-event/.x-review"
  event_fixture "$TMP/gh-event/event.json" "## Scope
- In: gh.sh"
  if (cd "$TMP/gh-event" && env -u EVENT_PATH GITHUB_EVENT_PATH="$TMP/gh-event/event.json" DEST=.x-review/scope.md bash -e "$EXTRACT") >/dev/null 2>&1 \
     && [ "$(cat "$TMP/gh-event/.x-review/scope.md" 2>/dev/null)" = "- In: gh.sh" ]; then
    ok "extract: reads \$GITHUB_EVENT_PATH by default"
  else
    bad "extract: reads \$GITHUB_EVENT_PATH by default" "scope.md not written from GITHUB_EVENT_PATH"
  fi

  # A stale scope.md from an earlier step must not survive a no-scope body.
  mkdir -p "$TMP/stale/.x-review"
  printf 'stale\n' > "$TMP/stale/.x-review/scope.md"
  event_fixture "$TMP/stale/event.json" "no scope here"
  if (cd "$TMP/stale" && EVENT_PATH="$TMP/stale/event.json" DEST=.x-review/scope.md bash -e "$EXTRACT") >/dev/null 2>&1 \
     && [ ! -e "$TMP/stale/.x-review/scope.md" ]; then
    ok "extract: stale scope.md removed"
  else
    bad "extract: stale scope.md removed" "stale file survived or script failed"
  fi
  # Untrusted content is copied as data: shell metacharacters are not run.
  run_case metachar-is-data "## Scope
- \$(touch pwned) \`touch pwned2\`" "- \$(touch pwned) \`touch pwned2\`"
  if [ -e "$TMP/metachar-is-data/pwned" ] || [ -e "$TMP/metachar-is-data/pwned2" ]; then
    bad "extract: body is never executed" "command substitution ran"
  else
    ok "extract: body is never executed"
  fi
else
  bad "extract script present" "missing $EXTRACT"
fi

echo
printf 'PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
