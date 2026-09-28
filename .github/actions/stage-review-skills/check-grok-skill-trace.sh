#!/usr/bin/env bash
# ENG-8651: require a read of each staged SKILL.md in a Grok streaming-json trace.
#
# Current grok-build docs: streaming-json tool_call has toolName and rawInput.path.
# --output-format json does not. The pinned CLI is 1.0.34; if it does not emit
# tool_call events this script fails closed.
#
# Env:
#   TRACE      — streaming-json file
#   IDS        — staged skill ids, one per line
#   STAGED     — true | anything else
#   JSON_OUT   — path for {text, stopReason} consumed by the existing sanitizer
set -euo pipefail

TRACE="${TRACE:?TRACE is required}"
STAGED="${STAGED:-false}"
JSON_OUT="${JSON_OUT:?JSON_OUT is required}"
export IDS="${IDS:-}"

fail() {
  echo "::error::$1"
  exit 1
}

if [ ! -f "$TRACE" ]; then
  fail "grok trace is missing"
fi

python3 - "$TRACE" "$STAGED" "$JSON_OUT" <<'PY'
import json, os, sys

trace, staged, json_out = sys.argv[1], sys.argv[2], sys.argv[3]
ids = [line.strip() for line in os.environ.get("IDS", "").splitlines() if line.strip()]
text = []
stop = ""
paths = []
saw_tool = False
with open(trace, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        ev = json.loads(line)
        kind = ev.get("type")
        if kind == "text" and isinstance(ev.get("data"), str):
            text.append(ev["data"])
        elif kind == "end" and isinstance(ev.get("stopReason"), str):
            stop = ev["stopReason"]
        elif kind == "tool_call":
            saw_tool = True
            raw = ev.get("rawInput") or {}
            path = raw.get("path") or raw.get("file_path") or ""
            if isinstance(path, str) and path:
                paths.append(path)
        elif kind == "assistant":
            # streaming-messages-json fallback, if a newer pin emits it on this flag
            for block in (ev.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use":
                    saw_tool = True
                    path = (block.get("input") or {}).get("path") or ""
                    if path:
                        paths.append(path)

body = "".join(text)
with open(json_out, "w", encoding="utf-8") as fh:
    json.dump({"text": body, "stopReason": stop}, fh)

if staged != "true":
    sys.exit(0)
if not ids:
    print("::error::staged=true but no skill ids were passed", file=sys.stderr)
    sys.exit(1)
if not saw_tool:
    print("::error::grok trace has no tool_call events; pinned CLI did not emit a tool stream", file=sys.stderr)
    sys.exit(1)
missing = []
for skill_id in ids:
    suffix = f".agents/skills/{skill_id}/SKILL.md"
    if not any(path == suffix or path.endswith("/" + suffix) for path in paths):
        missing.append(skill_id)
if missing:
    print("::error::grok trace is missing a SKILL.md read for: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
print("SKILL.md read confirmed for " + ", ".join(ids))
PY
