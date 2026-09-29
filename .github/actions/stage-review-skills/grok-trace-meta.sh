#!/usr/bin/env bash
# ENG-8651: turn the raw Grok streaming-json trace into a metadata-only trace
# for upload. Read results can carry SKILL.md bodies and other tool output, so
# keep only tool_call / tool_call_update {type, toolCallId, toolName, status,
# path (string rawInput.path)} and the end stopReason. XAI_API_KEY bytes are
# replaced. The raw TRACE is always deleted; on failure OUT is deleted too.
#
# Env:
#   TRACE       — raw streaming-json file (deleted)
#   OUT         — metadata-only jsonl to write
#   XAI_API_KEY — optional; replaced with [REDACTED] in OUT
set -euo pipefail

TRACE="${TRACE:?TRACE is required}"
OUT="${OUT:?OUT is required}"

if [ ! -f "$TRACE" ]; then
  exit 0
fi

if ! python3 - "$TRACE" "$OUT" <<'PY'
import json, os, sys

trace, out = sys.argv[1], sys.argv[2]
key = os.environ.get("XAI_API_KEY", "").encode()
rows = []
with open(trace, encoding="utf-8", errors="replace") as fh:
    for line in fh:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict):
            continue
        kind = ev.get("type")
        if kind in ("tool_call", "tool_call_update"):
            row = {"type": kind}
            for field in ("toolCallId", "toolName", "status"):
                if isinstance(ev.get(field), str):
                    row[field] = ev[field]
            raw = ev.get("rawInput")
            if isinstance(raw, dict) and isinstance(raw.get("path"), str):
                row["path"] = raw["path"]
        elif kind == "end" and isinstance(ev.get("stopReason"), str):
            row = {"type": "end", "stopReason": ev["stopReason"]}
        else:
            continue
        rows.append(json.dumps(row, ensure_ascii=False))
data = "".join(r + "\n" for r in rows).encode()
if key:
    data = data.replace(key, b"[REDACTED]")
with open(out, "wb") as fh:
    fh.write(data)
PY
then
  rm -f -- "$TRACE" "$OUT"
  echo "::error::grok trace metadata conversion failed; deleted the trace"
  exit 1
fi
rm -f -- "$TRACE"
