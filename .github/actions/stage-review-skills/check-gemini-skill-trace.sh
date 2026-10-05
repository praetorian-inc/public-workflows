#!/usr/bin/env bash
# ENG-8650: require activate_skill in a gemini-cli stream-json trace.
#
# stream-json events (gemini-cli 0.58.0 packages/core/src/output/types.ts):
#   tool_use    tool_name, parameters.name
#   tool_result output (llmContent or returnDisplay)
#   message     role=assistant content is the review text
# The result event has stats only, not the reply.
#
# STAGED=true is fail-closed. Anything else exits 0 and still writes the reply.
#
# Env:
#   TRACE    — stream-json file
#   IDS      — staged skill ids, one per line (empty if not staged)
#   STAGED   — true | anything else
#   REVIEW_OUT — path for the extracted review text
set -euo pipefail

TRACE="${TRACE:?TRACE is required}"
STAGED="${STAGED:-false}"
export IDS="${IDS:-}"

fail() {
  echo "::error::$1"
  exit 1
}

if [ ! -f "$TRACE" ]; then
  fail "gemini trace is missing"
fi

python3 -I - "$TRACE" "$STAGED" "${REVIEW_OUT:-}" <<'PY'
import json, os, sys

trace, staged, review_out = sys.argv[1], sys.argv[2], sys.argv[3]
ids = [line.strip() for line in os.environ.get("IDS", "").splitlines() if line.strip()]
events = []
with open(trace, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            if staged == "true":
                print("::error::gemini trace has a non-JSON line", file=sys.stderr)
                sys.exit(1)
            continue
        if isinstance(parsed, dict):
            events.append(parsed)

chunks = []
deltas = []
result_error = False
for ev in events:
    if ev.get("type") == "result" and ev.get("status") not in (None, "success"):
        result_error = True
    if ev.get("type") == "message" and ev.get("role") == "assistant":
        text = ev.get("content") or ""
        if not isinstance(text, str):
            continue
        if ev.get("delta"):
            deltas.append(text)
        elif text:
            chunks.append(text)
review = "\n".join(chunks) if chunks else "".join(deltas)
if review_out:
    with open(review_out, "w", encoding="utf-8") as fh:
        fh.write(review)
        if review and not review.endswith("\n"):
            fh.write("\n")
if not review.strip():
    print("::error::gemini trace has no assistant review", file=sys.stderr)
    sys.exit(1)
if result_error:
    print("::error::gemini trace completed with a non-success status", file=sys.stderr)
    sys.exit(1)

if staged != "true":
    sys.exit(0)
if not ids:
    print("::error::staged=true but no skill ids were passed", file=sys.stderr)
    sys.exit(1)

uses = {}
for ev in events:
    if ev.get("type") != "tool_use" or ev.get("tool_name") != "activate_skill":
        continue
    params = ev.get("parameters") or {}
    name = params.get("name") if isinstance(params, dict) else None
    if isinstance(name, str):
        uses[name] = ev.get("tool_id")

results = {}
for ev in events:
    if ev.get("type") != "tool_result":
        continue
    output = ev.get("output") or ""
    if not isinstance(output, str):
        output = json.dumps(output)
    results[ev.get("tool_id")] = results.get(ev.get("tool_id"), "") + output

missing = []
for skill_id in ids:
    tool_id = uses.get(skill_id)
    output = results.get(tool_id, "") if tool_id else ""
    tag = f'<activated_skill name="{skill_id}">'
    display = f"Skill **{skill_id}** activated"
    if tool_id is None or (tag not in output and display not in output):
        missing.append(skill_id)
if missing:
    print("::error::gemini trace is missing activate_skill for: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
print("activate_skill confirmed for " + ", ".join(ids))
PY
