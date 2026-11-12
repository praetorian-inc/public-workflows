#!/usr/bin/env bash
# Classify a failed Claude review as a refusal or not, from typed fields of the
# session result file: the JSON array of SDK messages that claude-code-action
# writes as its execution_file. The blob it writes is three fixed-format lines.
# It is not the file: this script searches no text and never reads .result,
# errors[], the refusal explanation fields, message content or tool_result
# content, so none of that can reach the blob or the log.
#
# Env:
#   TRACE — session result file (may be unset, empty, or name a missing file)
#   DEST  — output path (required; overwritten)
#
# Output: exactly three lines in DEST, in this order. Nothing on stdout.
#   verdict=<refused|not_refused|cannot_tell>
#   signals=<typed signals seen, comma-separated in the order below, or none>
#   result_subtype=<.subtype of the result, or unrecognized, or none>
#
# Exit status:
#   0        — DEST was written, whatever the verdict (cannot_tell included).
#   non-zero — the classifier itself failed (DEST unset or not writable, jq
#              not installed, or jq rejecting this script's program). That
#              is not a verdict: the caller must fail and must not retry.
#
# How the file is read. Only top-level entries that are JSON objects count.
# The result is the last entry whose .type is "result"; "before the result"
# means earlier in the array (every entry, when there is no result). A
# main-session entry is one whose .parent_tool_use_id is absent or null. An
# assistant entry with a non-null .parent_tool_use_id is never a signal and
# never shows that the session went on. A system refusal entry is not tested
# for .parent_tool_use_id because the pinned SDK's type for that message
# declares none, so it is a signal whatever such member it carries and counts
# only under the ended-the-session rule below.
#
# Typed signals, by the name written to signals=:
#   system_model_refusal_no_fallback — an entry before the result with
#       .type "system" and .subtype "model_refusal_no_fallback"
#   assistant_stop_reason_refusal    — a main-session entry before the result
#       with .type "assistant" and .message.stop_reason "refusal"
#   result_stop_reason_refusal       — the result has .stop_reason "refusal"
# signals= lists each signal seen, whether or not it ended the session.
#
# A signal ended the session when no main-session assistant entry whose
# .message.stop_reason is anything other than "refusal" stands between it and
# the result. result_stop_reason_refusal always ended the session.
#
# Verdicts, first match wins:
#   cannot_tell — TRACE is unset or empty; the file is missing, unreadable,
#                 empty, not valid JSON or not one JSON array; or the array
#                 holds no result. result_subtype= is then "none".
#   refused     — at least one typed signal ended the session, whatever
#                 .subtype and .is_error the result carries.
#   not_refused — the result names what happened and it is not a refusal:
#                 .subtype "success" with .is_error false (the session itself
#                 did not fail), or a .subtype that begins with "error_".
#   cannot_tell — any other result: a failed one that names no cause and
#                 carries no signal that ended the session (for example
#                 .subtype "success" with .is_error true).
#
# result_subtype= prints the result's .subtype only when it is 1 to 64
# characters of a-z and underscore, and "unrecognized" otherwise.
set -euo pipefail

TRACE="${TRACE:-}"
DEST="${DEST:?DEST is required}"

if ! command -v jq > /dev/null 2>&1; then
  echo "classify-claude-failure: jq is required" >&2
  exit 1
fi

# --slurp makes a truncated or malformed file a jq error before any output,
# and makes "one JSON array" checkable. jq's own messages are discarded: they
# can quote the input.
blob=""
rc=0
if [[ -n "$TRACE" && -f "$TRACE" && -r "$TRACE" ]]; then
  blob="$(jq -r --slurp '
    def blob($verdict; $signals; $subtype):
      "verdict=\($verdict)\nsignals=\($signals)\nresult_subtype=\($subtype)";

    # Printable form of a typed field: a-z and underscore only (codepoints
    # 97-122 and 95), so a value from the file cannot add a line to the blob.
    def printable:
      if type == "string" and length >= 1 and length <= 64
         and (explode | all(. == 95 or (. >= 97 and . <= 122)))
      then . else "unrecognized" end;

    def message_stop_reason:
      .message | if type == "object" then .stop_reason else null end;

    def main_assistant:
      .type == "assistant" and .parent_tool_use_id == null;

    def system_refusal:
      .type == "system" and .subtype == "model_refusal_no_fallback";

    def assistant_refusal:
      main_assistant and message_stop_reason == "refusal";

    if length != 1 or (.[0] | type) != "array" then
      blob("cannot_tell"; "none"; "none")
    else
      (.[0] | map(select(type == "object"))) as $entries
      | ([range(0; $entries | length) | select($entries[.].type == "result")] | last) as $at
      | (if $at == null then null else $entries[$at] end) as $result
      | (if $at == null then $entries else $entries[:$at] end | to_entries) as $before
      # Position of the last main-session assistant entry that is not a
      # refusal: the session went on at least that far.
      | ($before | map(select(.value | main_assistant and message_stop_reason != "refusal") | .key)
         | if length == 0 then -1 else last end) as $went_on
      | ($before | map(select(.value | system_refusal) | .key)) as $system
      | ($before | map(select(.value | assistant_refusal) | .key)) as $assistant
      | ($result != null and $result.stop_reason == "refusal") as $at_result
      | ([ (if ($system | length) > 0 then "system_model_refusal_no_fallback" else empty end),
           (if ($assistant | length) > 0 then "assistant_stop_reason_refusal" else empty end),
           (if $at_result then "result_stop_reason_refusal" else empty end) ]
         | if length == 0 then "none" else join(",") end) as $signals
      | ($at_result or (($system + $assistant) | any(. > $went_on))) as $ended
      | if $result == null then
          blob("cannot_tell"; $signals; "none")
        elif $ended then
          blob("refused"; $signals; ($result.subtype | printable))
        elif ($result.subtype == "success" and $result.is_error == false)
             or (($result.subtype | type) == "string" and ($result.subtype | startswith("error_"))) then
          blob("not_refused"; $signals; ($result.subtype | printable))
        else
          blob("cannot_tell"; $signals; ($result.subtype | printable))
        end
    end
  ' "$TRACE" 2> /dev/null)" || rc=$?
  # jq exits 3 when it cannot compile the program above. That is this
  # script failing, not a property of the file.
  if [[ "$rc" -eq 3 ]]; then
    echo "classify-claude-failure: jq rejected the classifier program" >&2
    exit 1
  fi
  [[ "$rc" -eq 0 ]] || blob=""
fi

if [[ -z "$blob" ]]; then
  blob=$'verdict=cannot_tell\nsignals=none\nresult_subtype=none'
fi

printf '%s\n' "$blob" > "$DEST"
