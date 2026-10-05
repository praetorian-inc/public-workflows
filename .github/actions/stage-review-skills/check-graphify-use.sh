#!/usr/bin/env bash
# Fail closed when a published graph is on disk and the reviewer never used it.
# REQUIRED=true is the only failing mode. Prompt text does not count.
#
# Exit codes:
#   0 — graphify was used, or the check was skipped (not required, no graph).
#   1 — graphify was not used: the query log is missing or empty, or no record
#       in the log or trace matches.
#   2 — the check cannot evaluate: a required setting is missing, the format is
#       unknown, the input is unreadable, the Codex trace is missing or
#       unstaged (including one with no rollout records), or the check errored.
#
# FORMAT:
#   querylog — graphify's own query log (Claude, Gemini, Grok). QUERY_LOG is
#              the JSONL file graphify appends to when GRAPHIFY_QUERY_LOG
#              points at it: the CLI for Claude and Gemini, the graphify MCP
#              server's query_graph tool for Grok. Passes on one JSON object
#              whose kind is a graph query (query, explain, path, mcp_query)
#              and whose corpus resolves to GRAPH (default
#              graphify-out/graph.json). Skips when GRAPH is missing or empty.
#   codex    — Codex rollout JSONL directory (TRACE). Passes on one
#              response_item function_call (exec_command or shell_command)
#              that runs in the workspace root (no workdir, or one resolving
#              to the cwd) with only argument keys that cannot change what
#              runs (any shell a system bash or sh), whose command is a lone
#              graphify query|explain|path
#              with no shell expansion or redirection other than a whole-word
#              N>&M, and whose paired function_call_output reports exit
#              code 0.
set -euo pipefail

unused() {
  echo "::error::$1"
  exit 1
}

cannot_evaluate() {
  echo "::error::$1"
  exit 2
}

# An unexpected failure in this script is an evaluation error, not a verdict.
on_exit() {
  local rc=$?
  case "$rc" in
    0 | 1 | 2) ;;
    *) exit 2 ;;
  esac
}
trap on_exit EXIT

FORMAT="${FORMAT:-}"
REQUIRED="${REQUIRED:-false}"

if [ "$REQUIRED" != "true" ]; then
  exit 0
fi

if [ -z "$FORMAT" ]; then
  cannot_evaluate "graphify use check: FORMAT is required"
fi

case "$FORMAT" in
  querylog)
    QUERY_LOG="${QUERY_LOG:-}"
    if [ -z "$QUERY_LOG" ]; then
      cannot_evaluate "graphify use check: QUERY_LOG is required for FORMAT=querylog"
    fi
    GRAPH="${GRAPH:-graphify-out/graph.json}"
    if [ ! -s "$GRAPH" ]; then
      echo "graphify use check skipped: no graph at $GRAPH"
      exit 0
    fi
    if [ ! -e "$QUERY_LOG" ]; then
      unused "graphify use check: query log is missing ($QUERY_LOG); no graphify query ran, or GRAPHIFY_QUERY_LOG did not reach the graphify process"
    fi
    TRACE="$QUERY_LOG"
    ;;
  codex)
    TRACE="${TRACE:-}"
    if [ -z "$TRACE" ]; then
      cannot_evaluate "graphify use check: TRACE is required for FORMAT=codex"
    fi
    if [ ! -d "$TRACE" ]; then
      cannot_evaluate "Codex session trace missing or unstaged ($TRACE): cannot verify graphify use; see the Stage Codex session trace step"
    fi
    GRAPH=""
    ;;
  *)
    cannot_evaluate "unknown graphify trace format: $FORMAT"
    ;;
esac

python3 -I - "$TRACE" "$FORMAT" "$GRAPH" <<'PY'
import json, os, re, sys

trace_path, fmt, graph = sys.argv[1], sys.argv[2], sys.argv[3]

def die(msg, code=1):
    print("::error::" + msg, file=sys.stderr)
    sys.exit(code)

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
# The kinds graphify's querylog.log_query writes for a graph query: the CLI's
# query, explain and path, and the MCP server's query_graph (mcp_query).
QUERY_KINDS = ("query", "explain", "path", "mcp_query")

def querylog_used(path):
    want = os.path.realpath(graph)
    for rec in jsonl(path):
        if rec.get("kind") not in QUERY_KINDS:
            continue
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
        elif ch == "&" and i > 0 and value[i - 1] == ">":
            # The >& of a 2>&1 or >&2 redirection, not a control operator;
            # has_redirection admits only that whole-word form.
            pass
        elif ch in (";", "&", "|", "\n"):
            return True
        i += 1
    return bool(quote)

def has_expansion(value):
    # The checker reads words literally, so anything the shell would rewrite
    # first ($, backticks, backslash escapes, and unquoted glob, brace or tilde
    # characters) could hand graphify an argv the checker never saw, such as
    # $(echo --graph) or a --gr* glob. Single-quoted text is literal.
    quote = ""
    for ch in value:
        if quote == "'":
            if ch == "'":
                quote = ""
            continue
        if ch in ("$", "`", "\\"):
            return True
        if quote == '"':
            if ch == '"':
                quote = ""
        elif ch in ("'", '"'):
            quote = ch
        elif ch in "*?[{~":
            return True
    return False

DUP_REDIRECT = re.compile(r"[0-9]*>&[0-9]+")

def has_redirection(value):
    # Bash ends a word at an unquoted < > ( or ), so --graph</dev/null runs as
    # --graph plus the next word while argv() sees one word. Only a whole-word
    # descriptor duplication (2>&1, >&2) is allowed; quoted text is literal.
    quote, word, special = "", [], False
    for ch in value + " ":
        if quote:
            if ch == quote:
                quote = ""
            word.append(ch)
            continue
        if ch.isspace():
            if special and not DUP_REDIRECT.fullmatch("".join(word)):
                return True
            word, special = [], False
            continue
        if ch in ("'", '"'):
            quote = ch
        elif ch in "<>()":
            special = True
        word.append(ch)
    return False

SHELLS = ("bash", "sh", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh")

def lone_graphify(value):
    if not isinstance(value, str):
        return False
    value = value.strip()
    if has_operator(value) or has_expansion(value) or has_redirection(value):
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

def in_workspace(args):
    # graphify reads graphify-out/graph.json relative to its cwd, and only the
    # workspace root's graphify-out is neutralized, so a call run from any
    # other workdir could read a PR-committed graph.
    workdir = args.get("workdir")
    if workdir is None or workdir == "":
        return True
    if not isinstance(workdir, str):
        return False
    root = os.path.realpath(os.getcwd())
    return os.path.realpath(os.path.join(root, workdir)) == root

# The arguments of Codex's exec_command and shell_command tools that cannot
# change what runs or where. Anything else does not count: an unknown key, the
# approval keys (sandbox_permissions, prefix_rule, additional_permissions), an
# environment_id that targets another environment, or a shell binary other
# than a system shell (a PR-committed "shell" could exit 0 without graphify).
SAFE_ARGS = {
    "exec_command": {"cmd", "workdir", "shell", "tty", "yield_time_ms", "max_output_tokens", "login"},
    "shell_command": {"command", "workdir", "timeout_ms", "timeout", "login"},
}
SYSTEM_SHELLS = {"bash", "sh", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"}

def safe_args(name, args):
    if not set(args) <= SAFE_ARGS.get(name, set()):
        return False
    return "shell" not in args or (isinstance(args["shell"], str) and args["shell"] in SYSTEM_SHELLS)

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
        die("Codex session trace missing or unstaged (" + path + "): no rollout response_item records; cannot verify graphify use; see the Stage Codex session trace step", 2)
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
        if not lone_graphify(cmd) or not in_workspace(args) or not safe_args(name, args):
            continue
        code = exit_code(text)
        if code == 0:
            return True
        sid = session_id(text) if code is None and name == "exec_command" else None
        if sid is not None:
            pending.add(sid)
    return False

def main():
    if fmt == "querylog":
        if not querylog_used(trace_path):
            die("graphify not used: query log " + trace_path + " has no graphify query record for " + os.path.realpath(graph))
    elif fmt == "codex":
        if not codex_used(trace_path):
            die("graphify not used: Codex trace has no lone graphify query, explain, or path call that exited 0")
    else:
        die("unknown graphify trace format: " + fmt, 2)
    print("graphify use confirmed (" + fmt + ")")

try:
    main()
except SystemExit:
    raise
except Exception as exc:  # unreadable input or a checker bug: not a verdict
    die("graphify use check cannot evaluate " + trace_path + ": " + type(exc).__name__ + ": " + str(exc), 2)
PY
