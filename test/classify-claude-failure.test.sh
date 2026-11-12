#!/usr/bin/env bash
# Tests for classify-claude-failure.sh. The contract is that script's header
# comment: each row is a session result file one of its rules is about, and the
# three lines the script must then leave in DEST. The last section covers the
# workflow wiring: where claude-code.yml takes the script from, and in what
# step order.
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/.github/actions/stage-review-skills/classify-claude-failure.sh"
T="$(mktemp -d)"
trap 'rm -rf -- "$T"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

OUT="$T/class.txt"
RC=0
# Text planted in fields the script must never read. It is not a-z and
# underscore only, so no rule of the header lets it into DEST.
PLANTED='Planted-Canary-Text'

# classify ENV...: run the script under `env ENV...`, its stdout and stderr
# kept. It runs under the bash that runs this suite, named by full path, so a
# row can replace PATH. DEST starts stale: the script must overwrite it.
classify() {
  printf 'stale\n' > "$OUT"
  env "$@" "$BASH" "$SCRIPT" > "$T/stdout" 2> "$T/stderr"
  RC=$?
}

# expect NAME VERDICT SIGNALS SUBTYPE: the last run exited 0, wrote nothing on
# stdout, left exactly these three lines in DEST, and let the planted text into
# none of DEST, stdout and stderr.
expect() {
  printf 'verdict=%s\nsignals=%s\nresult_subtype=%s\n' "$2" "$3" "$4" > "$T/want.txt"
  if [ "$RC" -eq 0 ] && [ ! -s "$T/stdout" ] && cmp -s "$T/want.txt" "$OUT" \
    && ! grep -F -q -- "$PLANTED" "$OUT" "$T/stdout" "$T/stderr"; then
    ok "$1"
  else
    bad "$1"
    printf '        exit=%s stdout_bytes=%s DEST=[%s]\n' "$RC" \
      "$(wc -c < "$T/stdout" | tr -d ' ')" "$(tr '\n' '|' < "$OUT")"
  fi
}

# row NAME VERDICT SIGNALS SUBTYPE [CONTENT]: classify a session result file
# holding CONTENT, or stdin when CONTENT is not given.
row() {
  if [ "$#" -ge 5 ]; then printf '%s' "$5" > "$T/trace.json"; else cat > "$T/trace.json"; fi
  classify TRACE="$T/trace.json" DEST="$OUT"
  expect "$1" "$2" "$3" "$4"
}

# fails NAME: the last run exited non-zero.
fails() { if [ "$RC" -ne 0 ]; then ok "$1"; else bad "$1"; fi; }

# quiet NAME: the last run wrote nothing on stderr.
quiet() {
  if [ ! -s "$T/stderr" ]; then
    ok "$1"
  else
    bad "$1"
    printf '        stderr_bytes=%s\n' "$(wc -c < "$T/stderr" | tr -d ' ')"
  fi
}

# Entries of a session result file, cut down to the typed fields the header names.
INIT='{"type":"system","subtype":"init"}'
SYSTEM_REFUSAL='{"type":"system","subtype":"model_refusal_no_fallback"}'
REFUSAL_FRAME='{"type":"assistant","parent_tool_use_id":null,"message":{"stop_reason":"refusal"}}'
REFUSAL_FRAME_NO_PARENT_MEMBER='{"type":"assistant","message":{"stop_reason":"refusal"}}'
WENT_ON='{"type":"assistant","parent_tool_use_id":null,"message":{"stop_reason":"tool_use"}}'
WENT_ON_NULL_STOP_REASON='{"type":"assistant","parent_tool_use_id":null,"message":{"stop_reason":null}}'
WENT_ON_NO_MESSAGE='{"type":"assistant","parent_tool_use_id":null}'
SUB_REFUSAL_FRAME='{"type":"assistant","parent_tool_use_id":"toolu_sub","message":{"stop_reason":"refusal"}}'
SUB_WENT_ON='{"type":"assistant","parent_tool_use_id":"toolu_sub","message":{"stop_reason":"end_turn"}}'
SUB_SYSTEM_REFUSAL='{"type":"system","subtype":"model_refusal_no_fallback","parent_tool_use_id":"toolu_sub"}'
# Results. FAILED_UNNAMED is a failed session that names no cause: with no
# signal it is cannot_tell, so where a row expects "refused" the signal decided.
FAILED_UNNAMED='{"type":"result","subtype":"success","is_error":true}'
SUCCEEDED='{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'
MAX_TURNS='{"type":"result","subtype":"error_max_turns","is_error":true}'
EXECUTION_ERROR='{"type":"result","subtype":"error_during_execution","is_error":true}'
# ERRORED carries a subtype that begins with "error" but not with "error_".
ERRORED='{"type":"result","subtype":"errored","is_error":true}'
NO_SUBTYPE='{"type":"result","is_error":true}'
FAILED_REFUSED_AT_RESULT='{"type":"result","subtype":"success","is_error":true,"stop_reason":"refusal"}'
SUCCEEDED_REFUSED_AT_RESULT='{"type":"result","subtype":"success","is_error":false,"stop_reason":"refusal"}'
ERROR_REFUSED_AT_RESULT='{"type":"result","subtype":"error_during_execution","is_error":true,"stop_reason":"refusal"}'
ALL_SIGNALS=system_model_refusal_no_fallback,assistant_stop_reason_refusal,result_stop_reason_refusal
# Three result texts that say in words alone that a request was refused.
SAFEGUARDS_PROSE="Fable 5.2's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.2. Try rephrasing the request in a new session or change your model."
CANNOT_HELP_PROSE="Fable 5.2 can't help with this. Start a new session to continue.  Learn more: https://www.anthropic.com/legal/aup"
USAGE_POLICY_PROSE="API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different approach."
prose_only() {
  printf '[%s,{"type":"result","subtype":"success","is_error":true,"result":"%s","modelUsage":{"claude-fable-5-2":{}}}]' "$INIT" "$1"
}

# 1. Each typed signal alone is a refusal.
row "1. system refusal entry alone: refused" \
  refused system_model_refusal_no_fallback success "[$INIT,$SYSTEM_REFUSAL,$FAILED_UNNAMED]"
row "1. assistant refusal entry alone: refused" \
  refused assistant_stop_reason_refusal success "[$INIT,$REFUSAL_FRAME,$FAILED_UNNAMED]"
row "1. assistant refusal entry with no parent_tool_use_id member: refused" \
  refused assistant_stop_reason_refusal success "[$INIT,$REFUSAL_FRAME_NO_PARENT_MEMBER,$FAILED_UNNAMED]"
row "1. result stop_reason refusal alone: refused" \
  refused result_stop_reason_refusal success "[$INIT,$FAILED_REFUSED_AT_RESULT]"
row "1. all three signals: listed in the header's order, not the file's" \
  refused "$ALL_SIGNALS" success "[$INIT,$REFUSAL_FRAME,$SYSTEM_REFUSAL,$FAILED_REFUSED_AT_RESULT]"

# 2. A result that names another cause: not refused.
row "2. success and end_turn, the session itself did not fail: not refused" \
  not_refused none success "[$INIT,$WENT_ON,$SUCCEEDED]"
row "2. error_max_turns: not refused" \
  not_refused none error_max_turns "[$INIT,$WENT_ON,$MAX_TURNS]"
row "2. error_during_execution: not refused" \
  not_refused none error_during_execution "[$INIT,$WENT_ON,$EXECUTION_ERROR]"
# The other side: a subtype that is neither "success" nor begins with "error_"
# names no cause, and is printed as it is.
row "2. a subtype that begins with error but not error_, no signal: cannot tell, subtype printed" \
  cannot_tell none errored "[$INIT,$WENT_ON,$ERRORED]"

# 3. Refusal prose with no typed signal: cannot tell.
row "3. prose only, safeguards flagged this message: cannot tell" \
  cannot_tell none success "$(prose_only "$SAFEGUARDS_PROSE")"
row "3. prose only, cannot help with this: cannot tell" \
  cannot_tell none success "$(prose_only "$CANNOT_HELP_PROSE")"
row "3. prose only, unable to respond to this request: cannot tell" \
  cannot_tell none success "$(prose_only "$USAGE_POLICY_PROSE")"

# 4. Signal names and refusal prose inside message text or tool_result content
# are not signals, and neither is an object shaped like one below the top level.
row "4. signal names and prose as text in a message and a tool_result: not refused" \
  not_refused none error_max_turns << EOF
[$INIT,
 {"type":"assistant","parent_tool_use_id":null,"message":{"stop_reason":"tool_use","content":[
   {"type":"text","text":"model_refusal_no_fallback stop_reason refusal $USAGE_POLICY_PROSE"}]}},
 {"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_1","content":"{\"type\":\"system\",\"subtype\":\"model_refusal_no_fallback\"} {\"stop_reason\":\"refusal\"} $CANNOT_HELP_PROSE"}]}},
 $MAX_TURNS]
EOF
row "4. signal-shaped objects below the top level: not refused" \
  not_refused none error_during_execution << EOF
[$INIT,
 {"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_1","content":[$SYSTEM_REFUSAL,$REFUSAL_FRAME]}]}},
 [$SYSTEM_REFUSAL,$REFUSAL_FRAME],
 "model_refusal_no_fallback",
 $EXECUTION_ERROR]
EOF

# 5. A refusal the session recovered from, then another failure: not refused.
# signals= still lists it.
row "5. assistant refusal, session went on, error_max_turns: not refused" \
  not_refused assistant_stop_reason_refusal error_max_turns "[$INIT,$REFUSAL_FRAME,$WENT_ON,$MAX_TURNS]"
row "5. system refusal, session went on, error_during_execution: not refused" \
  not_refused system_model_refusal_no_fallback error_during_execution "[$INIT,$SYSTEM_REFUSAL,$WENT_ON,$EXECUTION_ERROR]"
row "5. a later main-session entry with a null stop_reason also shows the session went on" \
  not_refused assistant_stop_reason_refusal error_max_turns "[$INIT,$REFUSAL_FRAME,$WENT_ON_NULL_STOP_REASON,$MAX_TURNS]"
row "5. recovered refusal, then a failure that names no cause: cannot tell" \
  cannot_tell assistant_stop_reason_refusal success "[$INIT,$REFUSAL_FRAME,$WENT_ON,$FAILED_UNNAMED]"
row "5. a later main-session entry with no message also shows the session went on: cannot tell" \
  cannot_tell assistant_stop_reason_refusal success "[$INIT,$REFUSAL_FRAME,$WENT_ON_NO_MESSAGE,$FAILED_UNNAMED]"

# 6. No usable file: cannot tell, exit 0. A lenient reader would call the
# truncated, one-object and two-array files refusals.
REFUSED="[$INIT,$SYSTEM_REFUSAL,$FAILED_UNNAMED]"
classify -u TRACE DEST="$OUT"
expect "6. TRACE unset: cannot tell" cannot_tell none none
classify TRACE= DEST="$OUT"
expect "6. TRACE empty: cannot tell" cannot_tell none none
classify TRACE="$T/absent.json" DEST="$OUT"
expect "6. file missing: cannot tell" cannot_tell none none
row "6. file empty: cannot tell" cannot_tell none none ''
row "6. file truncated: cannot tell" cannot_tell none none "${REFUSED%,*}"
# jq has a message of its own about that file. The script discards it.
quiet "6. file truncated: nothing on stderr, jq's own message is discarded"
row "6. file holds one object, not an array: cannot tell" cannot_tell none none "$FAILED_REFUSED_AT_RESULT"
row "6. file holds two arrays: cannot tell" cannot_tell none none "$REFUSED $REFUSED"
row "6. array holds no entries: cannot tell" cannot_tell none none '[]'
row "6. array holds a refusal but no result: cannot tell" \
  cannot_tell assistant_stop_reason_refusal none "[$INIT,$REFUSAL_FRAME]"

# 7. Text planted in .result, errors[], the refusal explanation fields, message
# content and tool_result content reaches neither DEST nor the log, whatever
# the verdict. A .subtype is printed only as a-z and underscore, so it cannot
# carry the text or add a line either.
row "7. planted text beside signals that ended the session: refused, text absent" \
  refused "$ALL_SIGNALS" success << EOF
[$INIT,
 {"type":"assistant","parent_tool_use_id":null,"message":{"stop_reason":"tool_use","content":[
   {"type":"text","text":"$PLANTED"}]}},
 {"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_1","content":"$PLANTED"}]}},
 {"type":"system","subtype":"model_refusal_no_fallback","api_refusal_category":"$PLANTED","api_refusal_explanation":"$PLANTED","content":"$PLANTED"},
 {"type":"assistant","parent_tool_use_id":null,"message":{"stop_reason":"refusal",
   "stop_details":{"type":"refusal","explanation":"$PLANTED"},"content":[{"type":"text","text":"$PLANTED"}]}},
 {"type":"result","subtype":"success","is_error":true,"stop_reason":"refusal","result":"$PLANTED","errors":["$PLANTED"]}]
EOF
row "7. planted text in a failed result that names no cause: cannot tell, text absent" \
  cannot_tell none success << EOF
[$INIT,{"type":"result","subtype":"success","is_error":true,"result":"$PLANTED","errors":["$PLANTED"]}]
EOF
row "7. planted text in an error result: not refused, text absent" \
  not_refused none error_during_execution << EOF
[$INIT,$WENT_ON,{"type":"result","subtype":"error_during_execution","is_error":true,"result":"$PLANTED","errors":["$PLANTED"]}]
EOF
row "7. a subtype carrying a forged verdict line and the planted text: printed as unrecognized" \
  not_refused none unrecognized << EOF
[$INIT,$WENT_ON,{"type":"result","subtype":"error_x\nverdict=refused\n$PLANTED","is_error":true}]
EOF
row "7. a result with no subtype: printed as unrecognized, not none" \
  cannot_tell none unrecognized "[$INIT,$NO_SUBTYPE]"

# 8. A typed signal that ended the session, beside any result: refused.
row "8. system refusal after the last other turn, error_max_turns: refused" \
  refused system_model_refusal_no_fallback error_max_turns "[$INIT,$WENT_ON,$SYSTEM_REFUSAL,$MAX_TURNS]"
row "8. assistant refusal after the last other turn, error_during_execution: refused" \
  refused assistant_stop_reason_refusal error_during_execution "[$INIT,$WENT_ON,$REFUSAL_FRAME,$EXECUTION_ERROR]"
row "8. result stop_reason refusal on an error result: refused" \
  refused result_stop_reason_refusal error_during_execution "[$INIT,$WENT_ON,$ERROR_REFUSED_AT_RESULT]"
row "8. result stop_reason refusal on success with is_error false: refused" \
  refused result_stop_reason_refusal success "[$INIT,$WENT_ON,$SUCCEEDED_REFUSED_AT_RESULT]"
row "8. a refusal, recovery, then a second refusal that ended the session: refused" \
  refused assistant_stop_reason_refusal error_max_turns "[$INIT,$REFUSAL_FRAME,$WENT_ON,$REFUSAL_FRAME,$MAX_TURNS]"

# 9. An assistant entry that carries a parent tool-use id is a subagent's: never
# a signal, and never a sign that the session went on.
row "9. subagent refusal frame, main session went on, error_max_turns: not refused" \
  not_refused none error_max_turns "[$INIT,$SUB_REFUSAL_FRAME,$WENT_ON,$MAX_TURNS]"
row "9. the same frame with no result: cannot tell" \
  cannot_tell none none "[$INIT,$SUB_REFUSAL_FRAME]"
row "9. a subagent entry after a main-session refusal does not show the session went on: refused" \
  refused assistant_stop_reason_refusal success "[$INIT,$REFUSAL_FRAME,$SUB_WENT_ON,$FAILED_UNNAMED]"
# The parent tool-use id is read on assistant entries only.
row "9. a system refusal entry that carries a parent tool-use id is still a signal: refused" \
  refused system_model_refusal_no_fallback success "[$INIT,$SUB_SYSTEM_REFUSAL,$FAILED_UNNAMED]"

# How the file is read: the result is the last result entry, and only entries
# before it are signals.
row "the last result entry is the result" \
  not_refused none error_max_turns "[$INIT,$FAILED_UNNAMED,$WENT_ON,$MAX_TURNS]"
row "a refusal entry after the result is not a signal" \
  cannot_tell none success "[$INIT,$FAILED_UNNAMED,$SYSTEM_REFUSAL]"

# The classifier's own failure is a non-zero exit, not a verdict. The first row
# is the pair's passing side: the same run with jq as the only command on PATH.
printf '%s' "[$INIT,$WENT_ON,$MAX_TURNS]" > "$T/trace.json"
mkdir "$T/only-jq" "$T/no-jq" "$T/rejecting-jq"
ln -s "$(command -v jq)" "$T/only-jq/jq"
# jq exits 3 when it cannot compile the program it is given.
printf '%s\n' '#!/bin/sh' 'exit 3' > "$T/rejecting-jq/jq"
chmod +x "$T/rejecting-jq/jq"
classify PATH="$T/only-jq" TRACE="$T/trace.json" DEST="$OUT"
expect "jq alone on PATH: a verdict, exit 0" not_refused none error_max_turns
classify PATH="$T/no-jq" TRACE="$T/trace.json" DEST="$OUT"
fails "jq not installed: non-zero exit"
classify PATH="$T/rejecting-jq" TRACE="$T/trace.json" DEST="$OUT"
fails "jq rejects the program: non-zero exit"
classify -u DEST TRACE="$T/trace.json"
fails "DEST unset: non-zero exit"
classify TRACE="$T/trace.json" DEST="$T/absent-dir/class.txt"
fails "DEST not writable: non-zero exit"

# ---- workflow wiring ----
# claude-code.yml runs this script from a checkout of its own repository at its
# own commit. That checkout is a step of its own, after the review step and
# before the refusal check, and nothing ahead of the review step names the
# script. Steps are found as text, by their whole name.
WF="$ROOT/.github/workflows/claude-code.yml"
REVIEW_STEP='Run Claude PR Action'
CHECKOUT_STEP='Checkout Claude failure classifier'
REFUSAL_STEP='Detect safety-classifier refusal'
RETRY_STEP='Run Claude PR Action (refusal retry)'
# The script as the workflow names it inside that checkout.
CHECKED_OUT_SCRIPT="_trace/${SCRIPT#"$ROOT"/}"

# step_line NAME: the line of the one step of that name, or 0 when the workflow
# has no such step or more than one.
step_line() {
  awk -v want="$1" '
    /^ *- name: / { step = $0; sub(/^ *- name: /, "", step); if (step == want) { n++; at = NR } }
    END { print (n == 1 ? at : 0) }' "$WF"
}

# step_has NAME TEXT: a line of the step of that name holds TEXT. A step runs
# from its name to the next step's name, and comment lines do not count.
step_has() {
  awk -v want="$1" -v text="$2" '
    /^ *- name: / { step = $0; sub(/^ *- name: /, "", step); on = (step == want); next }
    on && !/^ *#/ && index($0, text) { hit = 1 }
    END { exit(hit ? 0 : 1) }' "$WF"
}

review_at="$(step_line "$REVIEW_STEP")"
checkout_at="$(step_line "$CHECKOUT_STEP")"
refusal_at="$(step_line "$REFUSAL_STEP")"
retry_at="$(step_line "$RETRY_STEP")"
name="wiring: the review, the classifier checkout, the refusal check and the retry are steps in that order"
if [ "$review_at" -gt 0 ] && [ "$review_at" -lt "$checkout_at" ] \
  && [ "$checkout_at" -lt "$refusal_at" ] && [ "$refusal_at" -lt "$retry_at" ]; then
  ok "$name"
else
  bad "$name"
  printf '        lines: review=%s checkout=%s refusal_check=%s retry=%s (0: not one step of that name)\n' \
    "$review_at" "$checkout_at" "$refusal_at" "$retry_at"
fi

named_at="$(awk -v stop="$review_at" -v text="${SCRIPT##*/}" '
  NR >= stop + 0 { exit }
  !/^ *#/ && index($0, text) { at = at " " NR }
  END { print at }' "$WF")"
name="wiring: no line ahead of the review step, comment lines aside, names the classifier"
if [ "$review_at" -gt 0 ] && [ -z "$named_at" ]; then
  ok "$name"
else
  bad "$name"
  printf '        review step at line %s, classifier named at line(s):%s\n' "$review_at" "$named_at"
fi

missing=''
# shellcheck disable=SC2016  # literal workflow text, not an expansion
step_has "$CHECKOUT_STEP" 'repository: ${{ job.workflow_repository }}' || missing="$missing repository"
# shellcheck disable=SC2016  # literal workflow text, not an expansion
step_has "$CHECKOUT_STEP" 'ref: ${{ job.workflow_sha }}' || missing="$missing ref"
step_has "$REFUSAL_STEP" "$CHECKED_OUT_SCRIPT" || missing="$missing classifier-path"
name="wiring: the classifier checkout is of the workflow's own repository at its own commit, and the refusal check runs the classifier from it"
if [ -z "$missing" ]; then
  ok "$name"
else
  bad "$name"
  printf '        not found:%s\n' "$missing"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
