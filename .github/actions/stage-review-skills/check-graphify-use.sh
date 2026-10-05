#!/usr/bin/env bash
# Fail closed when a published graph is on disk and the reviewer never used it.
# REQUIRED=true is the only failing mode. Prompt text does not count.
#
# FORMAT:
#   querylog — graphify's own query log (Claude, Gemini). QUERY_LOG is the
#              JSONL file graphify appends to when GRAPHIFY_QUERY_LOG points at
#              it. Passes on one JSON object whose corpus resolves to
#              GRAPH (default graphify-out/graph.json). Skips when GRAPH is
#              missing or empty.
#   codex    — Codex rollout JSONL directory (TRACE). Passes on one
#              response_item function_call (exec_command or shell_command)
#              whose command is a lone graphify query|explain|path and whose
#              paired function_call_output reports exit code 0.
#   grok     — completed Read of graphify-out/pr-head-notes.md (TRACE)
set -euo pipefail

FORMAT="${FORMAT:?FORMAT is required}"
REQUIRED="${REQUIRED:-false}"

fail() {
  echo "::error::$1"
  exit 1
}

if [ "$REQUIRED" != "true" ]; then
  exit 0
fi

case "$FORMAT" in
  querylog)
    QUERY_LOG="${QUERY_LOG:?QUERY_LOG is required for FORMAT=querylog}"
    GRAPH="${GRAPH:-graphify-out/graph.json}"
    if [ ! -s "$GRAPH" ]; then
      echo "graphify use check skipped: no graph at $GRAPH"
      exit 0
    fi
    if [ ! -e "$QUERY_LOG" ]; then
      fail "graphify use check: query log is missing ($QUERY_LOG); no graphify query ran, or GRAPHIFY_QUERY_LOG did not reach the agent's shell"
    fi
    TRACE="$QUERY_LOG"
    ;;
  codex)
    TRACE="${TRACE:?TRACE is required}"
    if [ ! -d "$TRACE" ]; then
      fail "Codex session trace missing or unstaged ($TRACE): cannot verify graphify use; see the Stage Codex session trace step"
    fi
    GRAPH=""
    ;;
  grok)
    TRACE="${TRACE:?TRACE is required}"
    if [ ! -e "$TRACE" ]; then
      fail "graphify use check: trace is missing ($FORMAT)"
    fi
    GRAPH=""
    ;;
  *)
    fail "unknown graphify trace format: $FORMAT"
    ;;
esac

python3 - "$TRACE" "$FORMAT" "$GRAPH" <<'PY'
import json, os, re, sys

trace_path, fmt, graph = sys.argv[1], sys.argv[2], sys.argv[3]

def die(msg):
    print("::error::" + msg, file=sys.stderr)
    sys.exit(1)

def jsonl(path):
    out = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                out.append(parsed)
    return out

def trace_files(path):
    if not os.path.isdir(path):
        return [path]
    files = []
    for root, _, names in os.walk(path):
        for name in sorted(names):
            if name != "session-files.txt":
                files.append(os.path.join(root, name))
    return sorted(files)

# ---- querylog -------------------------------------------------------------
def querylog_used(path):
    want = os.path.realpath(graph)
    for rec in jsonl(path):
        corpus = rec.get("corpus")
        if isinstance(corpus, str) and corpus and os.path.realpath(corpus) == want:
            return True
    return False

# ---- codex ----------------------------------------------------------------
def argv(value):
    words, buf, quote = [], [], ""
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

def has_operator(value):
    # Any unquoted ; & | or newline makes the reported exit code something
    # other than graphify's own, so the call does not count.
    quote = ""
    i = 0
    while i < len(value):
        ch = value[i]
        if quote:
            if ch == "\\" and quote == '"':
                i += 2
                continue
            if ch == quote:
                quote = ""
        elif ch == "\\":
            i += 2
            continue
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "&" and (
            (i > 0 and value[i - 1] in "<>") or value[i + 1:i + 2] == ">"
        ):
            # A redirection such as 2>&1, >&2 or &>file, not a control operator.
            pass
        elif ch in (";", "&", "|", "\n"):
            return True
        i += 1
    return bool(quote)

SHELLS = ("bash", "sh", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh")

def lone_graphify(value):
    if not isinstance(value, str):
        return False
    value = value.strip()
    if has_operator(value):
        return False
    words = argv(value)
    # A leading assignment (PATH=., GRAPHIFY_OUT=...) or a path-qualified
    # program (./graphify, sub/bash) would let a PR-committed executable or
    # graph stand in for the real graphify, so only the bare names count.
    if not words or "=" in words[0]:
        return False
    if words[0] in SHELLS and len(words) == 3 and words[1] in ("-lc", "-c"):
        return lone_graphify(words[2])
    # --graph points graphify at another file; only the workspace graph counts,
    # matching the corpus check the querylog format applies.
    if any(w == "--graph" or w.startswith("--graph=") for w in words):
        return False
    return words[0] == "graphify" and len(words) >= 2 and words[1] in ("query", "explain", "path")

def output_text(output):
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        return "\n".join(i.get("text", "") for i in output if isinstance(i, dict) and isinstance(i.get("text"), str))
    return ""

def header(text):
    # Only the metadata above the first "Output:" line is Codex's own; the
    # command's stdout follows it and must not be able to forge an exit code.
    return re.split(r"(?m)^Output:", text, maxsplit=1)[0]

def exit_code(text):
    m = re.search(r"(?m)^(?:Process exited with code|Exit code:) (-?\d+)$", header(text))
    return int(m.group(1)) if m else None

def session_id(text):
    m = re.search(r"(?m)^Process running with session ID (-?\d+)$", header(text))
    return int(m.group(1)) if m else None

def codex_used(path):
    calls, outputs, records = {}, {}, 0
    order = []
    for file_path in trace_files(path):
        for ev in jsonl(file_path):
            if ev.get("type") != "response_item" or not isinstance(ev.get("payload"), dict):
                continue
            records += 1
            item = ev["payload"]
            call_id = item.get("call_id")
            if not isinstance(call_id, str):
                continue
            if item.get("type") == "function_call":
                try:
                    args = json.loads(item.get("arguments") or "")
                except (json.JSONDecodeError, TypeError):
                    continue
                if isinstance(args, dict):
                    calls[call_id] = (item.get("name"), args)
                    order.append(call_id)
            elif item.get("type") == "function_call_output":
                outputs[call_id] = output_text(item.get("output"))
    if records == 0:
        die("Codex session trace missing or unstaged (" + path + "): no rollout response_item records; cannot verify graphify use; see the Stage Codex session trace step")
    pending = set()
    for call_id in order:
        name, args = calls[call_id]
        text = outputs.get(call_id)
        if text is None:
            continue
        if name == "write_stdin":
            if args.get("session_id") in pending and exit_code(text) == 0:
                return True
            continue
        cmd = args.get("cmd") if name == "exec_command" else args.get("command") if name == "shell_command" else None
        if not lone_graphify(cmd):
            continue
        code = exit_code(text)
        if code == 0:
            return True
        sid = session_id(text) if code is None and name == "exec_command" else None
        if sid is not None:
            pending.add(sid)
    return False

# ---- grok -----------------------------------------------------------------
def load_events(path):
    events = []
    if os.path.isdir(path):
        for file_path in trace_files(path):
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
                if not parts:
                    return None
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

if fmt == "querylog":
    if not querylog_used(trace_path):
        die("graphify not used: query log " + trace_path + " has no graphify query record for " + os.path.realpath(graph))
elif fmt == "codex":
    if not codex_used(trace_path):
        die("graphify not used: Codex trace has no lone graphify query, explain, or path call that exited 0")
elif fmt == "grok":
    if not grok_read(load_events(trace_path)):
        die("grok trace has no completed Read of graphify-out/pr-head-notes.md")
print("graphify use confirmed (" + fmt + ")")
PY
