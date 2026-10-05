#!/usr/bin/env bash
# Write a small classification blob from a gemini-cli stream-json trace.
# The blob is the last result/error event plus a stderr tail. It is not the
# trace: tool_result text can contain FatalTurnLimitedError and secrets.
#
# Env:
#   TRACE   — stream-json file (may be missing)
#   STDERR  — CLI stderr file (may be missing)
#   DEST    — output path
#   STATUS  — CLI exit status
#   GEMINI_API_KEY — scrubbed from the blob when set
set -euo pipefail

TRACE="${TRACE:?TRACE is required}"
STDERR="${STDERR:?STDERR is required}"
DEST="${DEST:?DEST is required}"
STATUS="${STATUS:?STATUS is required}"

python3 -I - "$TRACE" "$STDERR" "$DEST" "$STATUS" <<'PY'
import json, os, sys

trace, stderr, dest, status = sys.argv[1:]
lines = ["cli_status=" + status]
last_result = None
last_error = None
if os.path.isfile(trace):
    with open(trace, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw.startswith("{"):
                continue
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(ev, dict):
                continue
            if ev.get("type") == "result":
                last_result = ev
            elif ev.get("type") == "error":
                last_error = ev
if isinstance(last_result, dict):
    lines.append("result_status=" + str(last_result.get("status") or ""))
    err = last_result.get("error") or {}
    if isinstance(err, dict):
        lines.append("result_error_type=" + str(err.get("type") or ""))
        lines.append("result_error_message=" + str(err.get("message") or ""))
if isinstance(last_error, dict):
    lines.append("error_event=" + str(last_error.get("message") or ""))
if os.path.isfile(stderr):
    with open(stderr, encoding="utf-8", errors="replace") as fh:
        tail = fh.read()[-4096:]
    if tail:
        lines.append("stderr_tail=")
        lines.append(tail)
blob = "\n".join(lines)
key = os.environ.get("GEMINI_API_KEY", "")
if key:
    blob = blob.replace(key, "[REDACTED]")
if not blob.endswith("\n"):
    blob += "\n"
with open(dest, "w", encoding="utf-8") as fh:
    fh.write(blob)
PY
