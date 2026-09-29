#!/usr/bin/env bash
# ENG-8651: require a read of each staged SKILL.md in a Grok streaming-json trace.
#
# Pinned grok 1.0.34 streaming-json (captured 2026-09-29, palatine run
# 36512841273): toolName is read_file, kind is read, and the path is
# rawInput.target_file, not rawInput.path. The call starts status=pending.
# A later tool_call_update on the same toolCallId has status=completed.
# Docs also name rawInput.path. Accept path, then target_file. Accept tool
# names read_file and Read. Do not require kind.
# --output-format json does not include tool calls. If 1.0.34 emits neither
# name, a staged run fails closed.
# Staged runs post only text emitted after every staged SKILL.md read completed
# (the gate is the latest per-id earliest completion); no such text fails.
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
done_at = {}
pos = 0
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
        pos += 1
        kind = ev.get("type")
        if kind == "text" and isinstance(ev.get("data"), str):
            text.append((pos, ev["data"]))
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
                    done_at.setdefault(call_id, pos)
        elif kind == "tool_call_update" and ev.get("status") == "completed":
            call_id = ev.get("toolCallId")
            if call_id:
                done_at.setdefault(call_id, pos)

def write(body):
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
    write("".join(data for _, data in text))
    sys.exit(0)
write("")
if not ids:
    print("::error::staged=true but no skill ids were passed", file=sys.stderr)
    sys.exit(1)
missing = []
gate = 0
for skill_id in ids:
    done = [
        done_at[call_id]
        for call_id, path in reads.items()
        if call_id in done_at and accepted(path, skill_id)
    ]
    if done:
        gate = max(gate, min(done))
    else:
        missing.append(skill_id)
if missing:
    print("::error::grok trace is missing a completed Read of SKILL.md for: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
body = "".join(data for at, data in text if at > gate)
write(body)
if not body.strip():
    print("::error::grok wrote no review after reading the staged skills", file=sys.stderr)
    sys.exit(1)
print("SKILL.md read confirmed for " + ", ".join(ids))
PY
