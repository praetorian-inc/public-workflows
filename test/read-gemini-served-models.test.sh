#!/usr/bin/env bash
#
# LAB-7944: read-gemini-served-models.sh names the model(s) that served a
# gemini-cli review from its stream-json trace, and the review footer prints
# that line. Fixtures follow the gemini-cli 0.68.0 event shape.
#
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/.github/actions/stage-review-skills/read-gemini-served-models.sh"
WF="$ROOT/.github/workflows/gemini-code.yml"
T="$(mktemp -d)"
trap 'rm -rf -- "$T"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; }

UNKNOWN='gemini-4-carbon requested, serving model unknown'

# The events before the result: init, the prompt, the streamed review.
opening() {
  printf '%s\n' \
    '{"type":"init","timestamp":"2026-11-12T10:00:00.000Z","session_id":"s-1","model":"gemini-4-carbon"}' \
    '{"type":"message","timestamp":"2026-11-12T10:00:00.010Z","role":"user","content":"Review this PR."}' \
    '{"type":"message","timestamp":"2026-11-12T10:00:30.000Z","role":"assistant","content":"No critical issues.","delta":true}'
}
# m <name> <input_tokens> -> one stats.models entry
m() {
  printf '"%s":{"total_tokens":%s,"input_tokens":%s,"output_tokens":40,"cached":0,"input":%s}' "$1" "$(($2 + 40))" "$2" "$2"
}
# result <stats-json> -> one result event
result() {
  printf '{"type":"result","timestamp":"2026-11-12T10:00:31.000Z","status":"success","stats":%s}\n' "$1"
}
# stats <models-json-members> -> a stats object
stats() {
  printf '{"total_tokens":0,"input_tokens":0,"output_tokens":0,"cached":0,"input":0,"duration_ms":31000,"tool_calls":4,"models":{%s}}' "$1"
}
# trace <file> [result lines...] -> opening events plus the given results
trace() {
  local file="$1"
  shift
  { opening; [ "$#" -eq 0 ] || printf '%s\n' "$@"; } > "$file"
}

# check <label> <trace path> <REQUESTED> <expected line>
# Exit 0, and stdout is exactly the expected line.
check() {
  local out rc
  out="$(TRACE="$2" REQUESTED="$3" bash "$SCRIPT" 2>"$T/stderr"; printf 'rc=%s' "$?")"
  rc="${out##*rc=}"
  out="${out%rc=*}"
  if [ "$rc" = 0 ] && [ "$out" = "$4"$'\n' ]; then
    ok "$1"
  else
    bad "$1" "rc=$rc stdout=$(printf '%q' "$out") stderr=$(head -c 300 "$T/stderr" 2>/dev/null)"
  fi
}

echo "read-gemini-served-models.test.sh"

trace "$T/two.jsonl" "$(result "$(stats "$(m gemini-3.8-flash 1200),$(m gemini-4-carbon-001 98000)")")"
check "two models, most input tokens first" "$T/two.jsonl" gemini-4-carbon 'gemini-4-carbon-001, gemini-3.8-flash'

trace "$T/one.jsonl" "$(result "$(stats "$(m gemini-4-carbon-001 51000)")")"
check "single versioned Carbon name" "$T/one.jsonl" gemini-4-carbon 'gemini-4-carbon-001'

trace "$T/no-stats.jsonl" '{"type":"result","timestamp":"2026-11-12T10:00:31.000Z","status":"success"}'
check "stats missing: requested, unknown" "$T/no-stats.jsonl" gemini-4-carbon "$UNKNOWN"

trace "$T/empty-models.jsonl" "$(result "$(stats '')")"
check "models {}: requested, unknown" "$T/empty-models.jsonl" gemini-4-carbon "$UNKNOWN"

trace "$T/no-result.jsonl"
check "no result event: requested, unknown" "$T/no-result.jsonl" gemini-4-carbon "$UNKNOWN"

check "trace file missing: requested, unknown" "$T/absent.jsonl" gemini-4-carbon "$UNKNOWN"

trace "$T/last.jsonl" \
  "$(result "$(stats "$(m gemini-3.8-flash 9000)")")" \
  "$(result "$(stats "$(m gemini-4-carbon-001 100)")")"
check "several results: the last one wins" "$T/last.jsonl" gemini-4-carbon 'gemini-4-carbon-001'

# A valid name is [A-Za-z0-9][A-Za-z0-9._-]{0,63}: 64 characters at most.
long64="gemini-4-carbon-$(printf '%048d' 0)"
trace "$T/long64.jsonl" "$(result "$(stats "$(m "$long64" 9000),$(m gemini-4-carbon-001 100)")")"
check "64-character served name is kept" "$T/long64.jsonl" gemini-4-carbon "$long64, gemini-4-carbon-001"

# Rows are <what>|<served name>. Each invalid name carries more tokens than
# the valid one, so a kept name would print first.
# shellcheck disable=SC2016  # literal $( and backticks are the fixture
rows=('a space|bad name' '$( )|x$(id)' 'backticks|x`id`' 'a JSON \n escape (a newline once parsed)|x\nid'
  "65 characters|${long64}0" 'a leading -|-lead' 'a leading .|.lead')
invalid=''
for row in "${rows[@]}"; do
  name="${row#*|}"
  trace "$T/invalid.jsonl" "$(result "$(stats "$(m "$name" 9000),$(m gemini-4-carbon-001 100)")")"
  check "served name with ${row%%|*} is dropped" "$T/invalid.jsonl" gemini-4-carbon 'gemini-4-carbon-001'
  invalid="${invalid:+$invalid,}$(m "$name" 9000)"
done

# A boolean is not a token count: true ranks below a real 0 (as a count it
# would be 1 and print first).
flag='"gemini-3.8-flash":{"total_tokens":40,"input_tokens":true,"output_tokens":40,"cached":0,"input":0}'
trace "$T/bool.jsonl" "$(result "$(stats "$flag,$(m gemini-4-carbon-001 0)")")"
check "input_tokens true sorts after a real count" "$T/bool.jsonl" gemini-4-carbon 'gemini-4-carbon-001, gemini-3.8-flash'

trace "$T/all-invalid.jsonl" "$(result "$(stats "$invalid")")"
check "all served names invalid: requested, unknown" "$T/all-invalid.jsonl" gemini-4-carbon "$UNKNOWN"

# shellcheck disable=SC2016  # literal $( is the fixture
for requested in 'bad model' '$(id)'; do
  check "invalid REQUESTED '$requested' is not echoed" "$T/no-result.jsonl" "$requested" 'invalid model id requested, serving model unknown'
done

# The footer: the reader's line goes through the job output into the
# github-script template of the "Post review comment" step.
step() { # step <name> -> that step's lines, up to the next step
  awk -v name="- name: $1" 'index($0, name) && substr($0, index($0, name) + length(name)) ~ /^[[:space:]]*$/ { on = 1; next } on && /- name: / { exit } on { print }' "$WF"
}
POST="$(step 'Post review comment')"
RUN="$(step 'Run Gemini PR Review')"
# shellcheck disable=SC2016  # literal JS / Actions text, not an expansion
placeholder='${process.env.GEMINI_SERVED}'
template="$(printf '%s\n' "$POST" | grep -F 'Reviewed by Gemini' | sed -e 's/^[[:space:]]*`//' -e 's/`,[[:space:]]*$//')"
render() { # render <reader stdout> -> the footer as posted
  printf '%s%s%s' "${template%%"$placeholder"*}" "$1" "${template#*"$placeholder"}"
}
if [ "${template%%"$placeholder"*}" = "$template" ]; then
  bad "footer template reads GEMINI_SERVED" "template=${template:-none}"
else
  served="$(TRACE="$T/one.jsonl" REQUESTED=gemini-4-carbon bash "$SCRIPT" 2>/dev/null)"
  footer="$(render "$served")"
  if [ "$footer" = '*Reviewed by Gemini (gemini-4-carbon-001)*' ]; then
    ok "footer names the served model"
  else
    bad "footer names the served model" "footer=$footer"
  fi
  served="$(TRACE="$T/no-result.jsonl" REQUESTED=gemini-4-carbon bash "$SCRIPT" 2>/dev/null)"
  footer="$(render "$served")"
  if [ "$footer" = '*Reviewed by Gemini (gemini-4-carbon requested, serving model unknown)*' ]; then
    ok "footer names the requested model when the served one is unknown"
  else
    bad "footer names the requested model when the served one is unknown" "footer=$footer"
  fi
fi

# shellcheck disable=SC2016  # literal Actions/shell text, not an expansion
if printf '%s\n' "$POST" | grep -q -x -E '[[:space:]]+GEMINI_SERVED: \$\{\{ needs\.gemini-review\.outputs\.served_models \}\}' \
  && grep -q -x -E '[[:space:]]+served_models: \$\{\{ steps\.gemini\.outputs\.served \}\}' "$WF"; then
  ok "post step env reads the served_models job output from steps.gemini"
else
  bad "post step env reads the served_models job output from steps.gemini" "$(grep -n -E 'GEMINI_SERVED:|served_models:' "$WF")"
fi

# shellcheck disable=SC2016  # literal workflow shell text, not an expansion
if printf '%s\n' "$RUN" | grep -q -F 'id: gemini' \
  && printf '%s\n' "$RUN" | grep -q -F 'served="$(TRACE="$TRACE" REQUESTED="$GEMINI_MODEL" bash "$served_script")"' \
  && printf '%s\n' "$RUN" | grep -q -F 'echo "served<<${delim}"'; then
  ok "gemini step writes the reader's line to its served output"
else
  bad "gemini step writes the reader's line to its served output" "no served<< write in the Run Gemini PR Review step"
fi

# shellcheck disable=SC2016  # literal workflow shell text, not an expansion
if grep -q -x -E '[[:space:]]+cp _trace/\.github/actions/stage-review-skills/read-gemini-served-models\.sh "\$RUNNER_TEMP/read-gemini-served-models\.sh"' "$WF" \
  && printf '%s\n' "$RUN" | grep -q -F 'served_script="${RUNNER_TEMP}/read-gemini-served-models.sh"' \
  && printf '%s\n' "$RUN" | grep -A 2 -F 'if [ ! -f "$served_script" ]; then' | grep -q -E '^[[:space:]]+exit 1$'; then
  ok "reader is staged out of the review tree and its absence fails the step"
else
  bad "reader is staged out of the review tree and its absence fails the step" "$(grep -n -F 'read-gemini-served-models' "$WF")"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
