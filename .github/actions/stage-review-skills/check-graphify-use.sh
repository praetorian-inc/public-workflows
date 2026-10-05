#!/usr/bin/env bash
# Fail closed when a published graph is on disk and the reviewer never used it.
# REQUIRED=true is the only failing mode. Prompt text does not count.
#
# FORMAT:
#   gemini — stream-json tool_use run_shell_command
#   claude — SDK message array, Bash tool_use input.command
#   codex  — session JSONL; command / cmd fields only
#   grok   — completed Read of graphify-out/pr-head-notes.md
set -euo pipefail

TRACE="${TRACE:?TRACE is required}"
FORMAT="${FORMAT:?FORMAT is required}"
REQUIRED="${REQUIRED:-false}"

fail() {
  echo "::error::$1"
  exit 1
}

if [ "$REQUIRED" != "true" ]; then
  exit 0
fi
if [ ! -e "$TRACE" ]; then
  fail "graphify use check: trace is missing ($FORMAT)"
fi

python3 - "$TRACE" "$FORMAT" <<'PY'
import json, os, re, sys

trace_path, fmt = sys.argv[1], sys.argv[2]
def argv(value):
    if not isinstance(value, str):
        return []
    words = []
    buf = []
    quote = ""
    for ch in value.strip():
        if quote:
            if ch == quote:
                quote = ""
            else:
                buf.append(ch)
            continue
        if ch in ("'", '"'):
            quote = ch
            continue
        if ch.isspace():
            if buf:
                words.append("".join(buf))
                buf = []
            continue
        buf.append(ch)
    if buf:
        words.append("".join(buf))
    return words

def is_cmd(value):
    words = argv(value)
    if len(words) < 2:
        return False
    program = words[0].replace("\\", "/").rsplit("/", 1)[-1]
    return program == "graphify" and words[1] in ("query", "explain", "path")

def load_events(path):
    events = []
    if os.path.isdir(path):
        files = []
        for root, _, names in os.walk(path):
            for name in names:
                if name == "session-files.txt":
                    continue
                files.append(os.path.join(root, name))
        for file_path in files:
            events.extend(load_events(file_path))
        return events
    raw = open(path, encoding="utf-8").read().strip()
    if not raw:
        return events
    if raw[0] in "[{":
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list):
            return [item for item in parsed if isinstance(item, dict)]
        if isinstance(parsed, dict):
            return [parsed]
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events

def walk_commands(node, found):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("command", "cmd") and is_cmd(value):
                found.append(value)
            else:
                walk_commands(value, found)
    elif isinstance(node, list):
        for item in node:
            walk_commands(item, found)

def gemini_used(events):
    for ev in events:
        if ev.get("type") != "tool_use" or ev.get("tool_name") != "run_shell_command":
            continue
        params = ev.get("parameters") if isinstance(ev.get("parameters"), dict) else {}
        if is_cmd(params.get("command")) or is_cmd(params.get("cmd")):
            return True
    return False

def claude_used(events):
    for ev in events:
        message = ev.get("message") if isinstance(ev.get("message"), dict) else ev
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            if block.get("name") != "Bash":
                continue
            tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
            if is_cmd(tool_input.get("command")):
                return True
    return False

def grok_read(events):
    reads = {}
    completed = set()
    for ev in events:
        kind = ev.get("type")
        if kind == "tool_call":
            call_id = ev.get("toolCallId")
            raw = ev.get("rawInput") if isinstance(ev.get("rawInput"), dict) else {}
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
    def fold(path):
        parts = []
        for part in path.replace("\\", "/").split("/"):
            if part in ("", "."):
                continue
            if part == "..":
                if parts:
                    parts.pop()
                continue
            parts.append(part)
        return "/".join(parts)

    workspace = os.environ.get("GITHUB_WORKSPACE", "").rstrip("/")
    want = "graphify-out/pr-head-notes.md"
    for call_id, path in reads.items():
        if call_id not in completed:
            continue
        folded = fold(path)
        if folded == want or (workspace and folded == fold(workspace + "/" + want)):
            return True
    return False

events = load_events(trace_path)
if fmt == "gemini":
    ok = gemini_used(events)
    missing = "gemini trace has no graphify query, explain, or path command"
elif fmt == "claude":
    ok = claude_used(events)
    missing = "claude trace has no graphify query, explain, or path command"
elif fmt == "codex":
    found = []
    walk_commands(events, found)
    ok = bool(found)
    missing = "codex trace has no graphify query, explain, or path command"
elif fmt == "grok":
    ok = grok_read(events)
    missing = "grok trace has no completed Read of graphify-out/pr-head-notes.md"
else:
    print("::error::unknown graphify trace format: " + fmt, file=sys.stderr)
    sys.exit(1)
if not ok:
    print("::error::" + missing, file=sys.stderr)
    sys.exit(1)
print("graphify use confirmed (" + fmt + ")")
PY
