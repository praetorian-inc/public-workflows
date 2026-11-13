#!/usr/bin/env bash
# LAB-7944: name the model(s) that served a gemini-cli review, for the footer.
#
# Reads the last result event of a stream-json trace (gemini-cli 0.68.0
# packages/core/src/output/stream-json-formatter.ts convertToStreamStats):
#   result  stats.models is an object keyed by model name; each value has
#           input_tokens, output_tokens, total_tokens, cached and input
#
# Prints exactly one line, the text inside the footer's parentheses:
#   the served names, by input_tokens descending, joined with ", "; or
#   "<REQUESTED> requested, serving model unknown" when there is no result
#   event, stats.models is missing or empty, or no served name is valid.
# A valid name matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$. An invalid served
# name is dropped; an invalid requested id prints as "invalid model id".
# Exits 0 in every case, including a missing or unparseable trace.
#
# Env:
#   TRACE     — stream-json file (may be missing)
#   REQUESTED — requested model id
set -euo pipefail

python3 -I - "${TRACE:-}" "${REQUESTED:-}" <<'PY'
import json, re, sys

trace, requested = sys.argv[1], sys.argv[2]
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def valid(name):
    return isinstance(name, str) and NAME.fullmatch(name) is not None


def input_tokens(value):
    tokens = value.get("input_tokens") if isinstance(value, dict) else None
    if isinstance(tokens, bool) or not isinstance(tokens, (int, float)):
        return -1
    return tokens


last_result = None
try:
    with open(trace, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw.startswith("{"):
                continue
            try:
                ev = json.loads(raw)
            except (ValueError, RecursionError):
                continue
            if isinstance(ev, dict) and ev.get("type") == "result":
                last_result = ev
except OSError:
    pass

stats = last_result.get("stats") if isinstance(last_result, dict) else None
models = stats.get("models") if isinstance(stats, dict) else None
served = []
if isinstance(models, dict):
    ranked = sorted(models.items(), key=lambda kv: input_tokens(kv[1]), reverse=True)
    served = [name for name, _ in ranked if valid(name)]
if served:
    print(", ".join(served))
else:
    shown = requested if valid(requested) else "invalid model id"
    print(shown + " requested, serving model unknown")
PY
