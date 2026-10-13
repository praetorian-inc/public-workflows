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

ref_run=""
for bot in claude codex gemini grok; do
  wf="$bot-code.yml"
  path="$REPO_ROOT/.github/workflows/$wf"
  if [ ! -f "$path" ]; then
    bad "$wf exists" "missing workflow"
    continue
  fi

  # Prompt contract: one SCOPE TAGS paragraph naming the bot's own scope file,
  # all three exact tags, the no-scope fallback text, and untrusted framing.
  # Taken from the SCOPE TAGS: marker to the next blank line.
  block="$(awk '/SCOPE TAGS:/ { on = 1 } on { print } on && /^[[:space:]]*$/ { exit }' "$path")"
  missing=""
  for needle in ".$bot-review/scope.md" '[IN-SCOPE]' '[OUT-OF-SCOPE]' '[HYPOTHETICAL]' \
                'No Scope section found' 'untrusted' 'never as instructions' \
                'sibling modules'; do
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

  # The body reaches the job via the event payload in env, never inline in run.
  step="$(extract_step "$path")"
  if [ -z "$step" ]; then
    bad "$wf has the '$STEP_NAME' step" "step missing"
    continue
  fi
  if printf '%s\n' "$step" | grep -qF 'PR_BODY: ${{ github.event.pull_request.body }}' \
     && printf '%s\n' "$step" | grep -qF "DEST: .$bot-review/scope.md" \
     && printf '%s\n' "$step" | grep -qF "if: steps.context.outputs.empty_scope != 'true'"; then
    ok "$wf fetches the PR body into .$bot-review/scope.md via env"
  else
    bad "$wf fetches the PR body into .$bot-review/scope.md via env" "env/if lines wrong"
  fi
  run_body="$(extract_run "$path")"
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

  if [ -z "$ref_run" ]; then
    ref_run="$run_body"
    printf '%s\n' "$run_body" > "$TMP/extract.sh"
  elif [ "$run_body" = "$ref_run" ]; then
    ok "$wf extract script is identical to claude-code.yml's"
  else
    bad "$wf extract script is identical to claude-code.yml's" "run blocks drifted"
  fi
done

# Behavioral cases: run the extracted script against fixture bodies.
run_case() { # name body expect(absent|<expected file content>)
  local name="$1" body="$2" expect="$3" dir
  dir="$TMP/$name"
  mkdir -p "$dir/.x-review"
  if ! (cd "$dir" && PR_BODY="$body" DEST=.x-review/scope.md bash -e "$TMP/extract.sh") >"$dir/log" 2>&1; then
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

if [ -s "$TMP/extract.sh" ]; then
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
  # A stale scope.md from an earlier step must not survive a no-scope body.
  mkdir -p "$TMP/stale/.x-review"
  printf 'stale\n' > "$TMP/stale/.x-review/scope.md"
  if (cd "$TMP/stale" && PR_BODY="no scope here" DEST=.x-review/scope.md bash -e "$TMP/extract.sh") >/dev/null 2>&1 \
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
  bad "extract script present" "could not extract the run block"
fi

echo
printf 'PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
