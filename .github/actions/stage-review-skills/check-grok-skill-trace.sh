#!/usr/bin/env bash
# ENG-8651: require a read of each staged SKILL.md in a Grok streaming-json trace.
#
# Pinned grok 1.0.34 streaming-json (captured 2026-09-29, palatine run
# 36512841273): toolName is read_file, and the path is rawInput.target_file,
# not rawInput.path. The call starts status=pending. A later tool_call_update
# on the same toolCallId has status=completed. Docs also name rawInput.path.
# Accept path, then target_file. Accept tool names read_file and Read.
# --output-format json does not include tool calls. If 1.0.34 emits neither
# name, a staged run fails closed.
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
reads = {}
completed = set()
workspace = os.environ.get("GITHUB_WORKSPACE", "").rstrip("/")
with open(trace, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict):
            continue
        kind = ev.get("type")
        if kind == "text" and isinstance(ev.get("data"), str):
            text.append(ev["data"])
        elif kind == "end" and isinstance(ev.get("stopReason"), str):
            stop = ev["stopReason"]
        elif kind == "tool_call":
            call_id = ev.get("toolCallId")
            raw = ev.get("rawInput")
            raw = raw if isinstance(raw, dict) else {}
            path = ""
            for key in ("path", "target_file"):
                val = raw.get(key)
                if isinstance(val, str) and val:
                    path = val
                    break
            if ev.get("toolName") in ("read_file", "Read") and call_id and path:
                reads[call_id] = path
                if ev.get("status") == "completed":
                    completed.add(call_id)
        elif kind == "tool_call_update" and ev.get("status") == "completed":
            call_id = ev.get("toolCallId")
            if call_id:
                completed.add(call_id)

body = "".join(text)
with open(json_out, "w", encoding="utf-8") as fh:
    json.dump({"text": body, "stopReason": stop}, fh)

def fold(path):
    parts = []
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)

def accepted(path, skill_id):
    want = f".agents/skills/{skill_id}/SKILL.md"
    if path.startswith("/"):
        return bool(workspace) and fold(path) == fold(f"{workspace}/{want}")
    return fold(path) == want

if staged != "true":
    sys.exit(0)
if not ids:
    print("::error::staged=true but no skill ids were passed", file=sys.stderr)
    sys.exit(1)
missing = []
for skill_id in ids:
    if not any(
        call_id in completed and accepted(path, skill_id)
        for call_id, path in reads.items()
    ):
        missing.append(skill_id)
if missing:
    print("::error::grok trace is missing a completed Read of SKILL.md for: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
print("SKILL.md read confirmed for " + ", ".join(ids))
PY
