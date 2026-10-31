#!/usr/bin/env bash
#
# Tests for the drift-comment path in .github/workflows/agents-md-drift.yml
# (ENG-5663, LAB-7596).
#
# JEV decides which instruction-file sections are stale; the model step is a
# read-only drafter that returns proposed edits as `--json-schema` structured
# output; a deterministic `run:` step after it creates or updates the single
# drift comment through `cli.mjs render`. Two things are proven here:
#
#   1. The post step's real `run:` block — EXTRACTED from the workflow YAML at
#      run time, never mirrored — creates, updates, resolves, or skips
#      correctly when executed against a stub `gh` on PATH that records every
#      call and serves canned, paginated comment lists, with the real drift
#      modules (this checkout, linked as `_pw`) and a canned JEV score file.
#   2. The model step's real `claude_args`, TOKENIZED (not grepped), grants the
#      model no tool that can post or edit a comment, disallows `gh api` and
#      `gh pr comment`, and carries a valid drafts `--json-schema`; the post
#      step is a plain `run:` step after the model step, gated on the pairs
#      verdict; and the JEV key reaches only the score step.
#
# Requires: bash, python3 with PyYAML, jq, node.
#
# Usage: bash test/agents-md-drift-comment.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# DRIFT_WORKFLOW points the suite at another copy (used to mutation-test it).
WORKFLOW="${DRIFT_WORKFLOW:-$REPO_ROOT/.github/workflows/agents-md-drift.yml}"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

EXTRACT="$WORKDIR/extracted"
mkdir -p "$EXTRACT" "$WORKDIR/bin"

PASS=0
FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  printf '          expected: [%s]\n' "$2"
  printf '          actual:   [%s]\n' "$3"
  FAIL=$((FAIL + 1))
}
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for dep in python3 jq node; do
  command -v "$dep" >/dev/null 2>&1 || { echo "ERROR: $dep is required" >&2; exit 1; }
done

MARKER='## Instruction-File Drift Detection'
LEGACY_MARKER='## CLAUDE.md Drift Detection'

# ── Static contract: extract and tokenize the real workflow ──────────────────
section "Static contract — model tool surface, schema, and post-step wiring"

# Each check prints "PASS<TAB>name" or "FAIL<TAB>name<TAB>expected<TAB>actual";
# the post step's run: body is written out for the behavioural cases below.
python3 - "$WORKFLOW" "$EXTRACT" > "$WORKDIR/static.tsv" <<'PY' || { echo "ERROR: static extraction failed" >&2; exit 1; }
import json
import pathlib
import re
import shlex
import sys

import yaml

wf = yaml.safe_load(open(sys.argv[1]))
out = pathlib.Path(sys.argv[2])
steps = wf["jobs"]["drift-check"]["steps"]


def check(name, cond, expected="", actual=""):
    if cond:
        print("PASS\t%s" % name)
    else:
        print("FAIL\t%s\t%s\t%s" % (name, expected, str(actual).replace("\n", " ")))


def find(pred):
    for i, st in enumerate(steps):
        if pred(st):
            return i, st
    return None, None


mi, model = find(lambda s: str(s.get("uses", "")).startswith("anthropics/claude-code-action@"))
pi, post = find(lambda s: s.get("id") == "post")
check("model step exists (claude-code-action)", model is not None)
check("post step exists (id=post)", post is not None)
if model is None or post is None:
    sys.exit(0)

model_id = model.get("id")
check("model step has an id", bool(model_id), "an id", model_id)

# ── Tokenize claude_args the way the action does (shell-quote semantics) ──
# `${{ ... }}` is resolved by Actions before the action sees the string; swap
# each for an inert placeholder so the tokenizer sees what the action sees.
raw = model["with"]["claude_args"]
raw = "\n".join(l for l in raw.split("\n") if not l.strip().startswith("#"))
raw = re.sub(r"\$\{\{.*?\}\}", "EXPR", raw)
tokens = shlex.split(raw)

flags = {}
cur = None
for t in tokens:
    if t.startswith("--"):
        cur = t[2:]
        flags.setdefault(cur, [])
    elif cur is not None:
        flags[cur].append(t)


def tool_list(*names):
    vals = []
    for n in names:
        for v in flags.get(n, []):
            vals += [x.strip() for x in v.split(",") if x.strip()]
    return vals


allowed = tool_list("allowedTools", "allowed-tools")
disallowed = tool_list("disallowedTools", "disallowed-tools")

# Closed read-only allowlist: any tool added to the model must be reviewed
# here, so a comment-capable tool cannot slip in unnoticed.
READ_ONLY = {
    "Read", "Grep", "Glob",
    "Bash(gh pr diff:*)", "Bash(gh pr view:*)",
    "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(find:*)", "Bash(ls:*)",
}
check("model allowedTools is non-empty", bool(allowed), "a tool list", allowed)
extra = sorted(set(allowed) - READ_ONLY)
check("model allowedTools is within the read-only set", not extra, "subset of read-only set", extra)

POSTING = re.compile(
    r"^(Bash|Bash\(\*\)|Bash\(gh(:\*| \*)?\)|Bash\(gh (api|pr comment|pr review|pr edit|issue comment|issue edit)\b.*"
    r"|Bash\((curl|wget)\b.*|mcp__github.*|Write|Edit|MultiEdit)$"
)
posting = [t for t in allowed if POSTING.match(t)]
check("model holds no comment-posting/editing tool", not posting, "none", posting)
check("gh api is disallowed", "Bash(gh api:*)" in disallowed, "Bash(gh api:*)", disallowed)
check("gh pr comment is disallowed", "Bash(gh pr comment:*)" in disallowed, "Bash(gh pr comment:*)", disallowed)
both = sorted(set(allowed) & set(disallowed))
check("no tool is both allowed and disallowed", not both, "none", both)

# ── --json-schema ──
schemas = flags.get("json-schema", [])
check("--json-schema passed exactly once with one value", len(schemas) == 1, "1", len(schemas))
schema = None
if len(schemas) == 1:
    try:
        schema = json.loads(schemas[0])
    except ValueError as e:
        check("--json-schema is valid JSON", False, "valid JSON", e)
if schema is not None:
    check("--json-schema is valid JSON", True)
    props = schema.get("properties", {})
    req = set(schema.get("required", []))
    check("schema is an object schema", schema.get("type") == "object", "object", schema.get("type"))
    check("schema requires drafts", req == {"drafts"}, "drafts", sorted(req))
    items = props.get("drafts", {}).get("items", {})
    check("drafts is an array", props.get("drafts", {}).get("type") == "array", "array", props.get("drafts"))
    check("each draft requires id + draft", set(items.get("required", [])) == {"id", "draft"},
          "draft,id", sorted(items.get("required", [])))
    check("draft entries are closed objects", items.get("additionalProperties") is False,
          "False", items.get("additionalProperties"))

# ── Post step shape ──
body = post.get("run", "")
check("post step is a plain run: step (no uses:)", "uses" not in post and bool(body), "run only", post.get("uses"))
check("post run: body has no ${{ }} expressions", "${{" not in body, "none", "contains ${{")
check("post step runs after the model step", pi > mi, "> %s" % mi, pi)
cond = str(post.get("if", ""))


# ── Evaluate the post step's if: the way Actions does ──
# A minimal evaluator for the expression subset a step condition uses:
# ! && || ( ) == != , string/bool/null literals, steps.<id>.outcome|conclusion,
# steps.<id>.outputs.<name> (missing = ''), needs.<job>.result,
# needs.<job>.outputs.<name> (missing = ''), and the status functions. Strings compare case-insensitively, and a condition
# naming no status function is implicitly `success() && (...)`, as in Actions.
# Anything outside the subset raises, so an unrecognised condition fails loudly.
class ExprError(Exception):
    pass


TOKEN = re.compile(r"\s*(?:(&&|\|\||==|!=|!|\(|\)|,)|'((?:[^']|'')*)'|([A-Za-z_][A-Za-z0-9_.\-]*))")
STATUS_FUNCS = {"success", "failure", "cancelled", "always"}


def tokenize(src):
    toks, i = [], 0
    src = src.strip()
    while i < len(src):
        m = TOKEN.match(src, i)
        if not m or m.end() == i:
            raise ExprError("cannot tokenize at %r" % src[i:])
        op, s, ident = m.groups()
        toks.append(("op", op) if op else ("str", s.replace("''", "'")) if s is not None else ("id", ident))
        i = m.end()
        while i < len(src) and src[i].isspace():
            i += 1
    return toks


def evaluate(src, ctx):
    src = src.strip()
    if src.startswith("${{") and src.endswith("}}"):
        src = src[3:-2]
    toks = tokenize(src)
    if not any(t == ("id", f) for f in STATUS_FUNCS for t in toks):
        toks = [("id", "success"), ("op", "("), ("op", ")"), ("op", "&&"), ("op", "(")] + toks + [("op", ")")]
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else (None, None)

    def take(kind=None, val=None):
        t = peek()
        if (kind and t[0] != kind) or (val and t[1] != val):
            raise ExprError("expected %s %s, got %r" % (kind, val, t))
        pos[0] += 1
        return t

    def norm(v):
        return v.lower() if isinstance(v, str) else v

    def primary():
        k, v = peek()
        if (k, v) == ("op", "("):
            take()
            r = disj()
            take("op", ")")
            return r
        if k == "str":
            take()
            return v
        if k == "id":
            take()
            if v in ("true", "false"):
                return v == "true"
            if v == "null":
                return None
            if peek() == ("op", "("):
                take()
                take("op", ")")
                if v not in STATUS_FUNCS:
                    raise ExprError("unsupported function %s()" % v)
                return ctx[v + "()"]
            parts = v.split(".")
            if len(parts) == 3 and parts[0] == "steps" and parts[2] in ("outcome", "conclusion"):
                return ctx["steps"].get(parts[1], {}).get(parts[2], "success")
            if len(parts) == 4 and parts[0] == "steps" and parts[2] == "outputs":
                return ctx["steps"].get(parts[1], {}).get("outputs", {}).get(parts[3], "")
            if len(parts) == 3 and parts[0] == "needs" and parts[2] == "result":
                return ctx["needs"][parts[1]]["result"]
            if len(parts) == 4 and parts[0] == "needs" and parts[2] == "outputs":
                return ctx["needs"][parts[1]].get("outputs", {}).get(parts[3], "")
            raise ExprError("unsupported context %s" % v)
        raise ExprError("unexpected token %r" % ((k, v),))

    def cmp_():
        left = primary()
        while peek() in (("op", "=="), ("op", "!=")):
            op = take()[1]
            right = primary()
            left = (norm(left) == norm(right)) == (op == "==")
        return left

    def unary():
        if peek() == ("op", "!"):
            take()
            return not unary()
        return cmp_()

    def conj():
        left = unary()
        while peek() == ("op", "&&"):
            take()
            right = unary()
            left = left and right
        return left

    def disj():
        left = conj()
        while peek() == ("op", "||"):
            take()
            right = conj()
            left = left or right
        return left

    r = disj()
    if pos[0] != len(toks):
        raise ExprError("trailing tokens %r" % toks[pos[0]:])
    return bool(r)


def ctx_for(outputs, cancelled, failed=False):
    return {
        "steps": {k: {"outcome": "success", "conclusion": "success", "outputs": v} for k, v in outputs.items()},
        "cancelled()": cancelled,
        "success()": not cancelled and not failed,
        "failure()": failed,
        "always()": True,
    }


def table(label, cond, cases):
    for outputs, cancelled, want_run, why, *failed in cases:
        failed = bool(failed and failed[0])
        name = "%s if: %s when %s%s%s" % (label, "runs" if want_run else "skips", why,
                                         ", run cancelled" if cancelled else "", ", an earlier step failed" if failed else "")
        try:
            got = evaluate(cond, ctx_for(outputs, cancelled, failed))
        except ExprError as e:
            check(name, False, "evaluable condition", "%s (%s)" % (cond, e))
            continue
        check(name, got == want_run, "run" if want_run else "skip", "%s for if: %s" % ("run" if got else "skip", cond))


# Post whenever the pairs step reached a verdict: 'ok' (JEV scored, or JEV was
# unavailable and an existing comment gets the notice) or 'none' (no pairs, so
# open findings resolve). Never when the pairs step was unavailable or skipped,
# nor when the run was cancelled.
cases = []
for status in ("ok", "none", "unavailable", ""):
    for cancelled in (False, True):
        cases.append(({"pairs": {"status": status}}, cancelled, (not cancelled) and status in ("ok", "none"),
                      "pairs status '%s'" % status))
# A failed earlier step (not cancelled) must not suppress the post: the comment
# still has to carry the verdict, so the condition cannot rely on success().
cases.append(({"pairs": {"status": "ok"}}, False, True, "pairs status 'ok'", True))
table("post step", cond, cases)

# The drafter runs only for JEV-scored runs with at least one high finding.
table("model step", str(model.get("if", "")), [
    ({"score": {"jev": "ok", "high": "2"}}, False, True, "JEV ok, 2 high"),
    ({"score": {"jev": "ok", "high": "0"}}, False, False, "JEV ok, 0 high"),
    ({"score": {"jev": "unavailable", "high": ""}}, False, False, "JEV unavailable"),
    ({}, False, False, "score skipped"),
])

# JEV (and its key) runs only when the pairs step built pairs. The drift job now
# also runs on no-candidate PRs, so this condition alone keeps JEV out of them.
_, score_step = find(lambda s: s.get("id") == "score")
table("score step", str((score_step or {}).get("if", "")), [
    ({"pairs": {"status": "ok"}}, False, True, "pairs status 'ok'"),
    ({"pairs": {"status": "none"}}, False, False, "pairs status 'none'"),
    ({"pairs": {"status": "unavailable"}}, False, False, "pairs status 'unavailable'"),
    ({}, False, False, "pairs skipped"),
])

# The drift-check job runs whenever its pairs step can reach a verdict: the
# pre-filter found candidates, found NONE (so a later push that leaves no
# candidates still resolves an existing comment's findings), or failed or timed
# out. It skips when the diff could not be computed (should_run false, no
# no_candidates), when the pre-filter was skipped (draft/bot PR), and when the
# run was cancelled.
job_cond = str(wf["jobs"]["drift-check"].get("if", ""))
for outputs, result, cancelled, want_run, why in (
    ({"should_run": "true"}, "success", False, True, "candidates found"),
    ({"should_run": "false", "no_candidates": "true"}, "success", False, True, "no candidates (later push)"),
    ({"should_run": "false"}, "success", False, False, "PR diff not computable"),
    ({}, "failure", False, True, "pre-filter failed"),
    ({}, "cancelled", False, True, "pre-filter timed out"),
    ({}, "skipped", False, False, "pre-filter skipped"),
    ({"should_run": "false", "no_candidates": "true"}, "success", True, False, "no candidates"),
    ({"should_run": "true"}, "success", True, False, "candidates found"),
):
    name = "drift-check job if: %s when %s%s" % ("runs" if want_run else "skips", why,
                                                ", run cancelled" if cancelled else "")
    ctx = {"steps": {}, "needs": {"pre-filter": {"result": result, "outputs": outputs}},
           "cancelled()": cancelled, "success()": not cancelled and result == "success",
           "failure()": result == "failure", "always()": True}
    try:
        got = evaluate(job_cond, ctx)
    except ExprError as e:
        check(name, False, "evaluable condition", "%s (%s)" % (job_cond, e))
        continue
    check(name, got == want_run, "run" if want_run else "skip", "%s for if: %s" % ("run" if got else "skip", job_cond))
pre_out = str((wf["jobs"]["pre-filter"].get("outputs") or {}).get("no_candidates", ""))
check("pre-filter exports no_candidates from the check step",
      pre_out == "${{ steps.check.outputs.no_candidates }}", "${{ steps.check.outputs.no_candidates }}", pre_out)

env = post.get("env", {}) or {}
want = "${{ steps.%s.outputs.structured_output }}" % model_id
check("post step receives structured_output via env", env.get("STRUCTURED_OUTPUT") == want,
      want, env.get("STRUCTURED_OUTPUT"))
for k, v in (("PAIRS_STATUS", "${{ steps.pairs.outputs.status }}"), ("JEV_STATUS", "${{ steps.score.outputs.jev }}")):
    check("post step env %s" % k, env.get(k) == v, v, env.get(k))
for k in ("GH_TOKEN", "REPO", "PR_NUMBER", "HEAD_SHA"):
    check("post step env has %s" % k, k in env, k, sorted(env))

# The JEV key reaches exactly one step, the score step, from the optional secret.
# Every key of every step in every job counts (run:, if:, with:, env:).
holders = [st.get("id") or st.get("name") for job in wf["jobs"].values() for st in job.get("steps", [])
           if "TYPESAFE_JEV_API_KEY" in json.dumps(st)]
check("only the score step sees the JEV key", holders == ["score"], ["score"], holders)
_, score = find(lambda s: s.get("id") == "score")
check("score step reads secrets.TYPESAFE_JEV_API_KEY",
      score is not None and (score.get("env") or {}).get("TYPESAFE_JEV_API_KEY") == "${{ secrets.TYPESAFE_JEV_API_KEY }}",
      "${{ secrets.TYPESAFE_JEV_API_KEY }}", score and score.get("env"))
# PyYAML (YAML 1.1) loads the bare `on:` key as boolean True.
secrets = (wf.get(True) or wf.get("on"))["workflow_call"]["secrets"]
check("TYPESAFE_JEV_API_KEY secret is optional", secrets.get("TYPESAFE_JEV_API_KEY", {}).get("required") is False,
      "required: false", secrets.get("TYPESAFE_JEV_API_KEY"))

(out / "post.sh").write_text(body)
PY

while IFS=$'\t' read -r verdict name exp act; do
  if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
done < "$WORKDIR/static.tsv"

if [ ! -s "$EXTRACT/post.sh" ]; then
  printf '\n  passed: %d   failed: %d  (post step missing — behavioural cases not run)\n' "$PASS" "$((FAIL + 1))"
  exit 1
fi

section "Syntax checks"
if bash -n "$EXTRACT/post.sh" 2>"$WORKDIR/post.syn"; then
  ok "bash -n post.sh"
else
  bad "bash -n post.sh" "clean parse" "$(cat "$WORKDIR/post.syn")"
fi

# ── Stub gh ──────────────────────────────────────────────────────────────────
# Records one line per call in $GH_LOG ("GET <path> paginate=<y|n>" or
# "<METHOD> <path>") and saves each write's --input payload as
# $GH_LOG.<n>.json. Comment listings are served from $GH_PAGES/page-<k>.json,
# applying the caller's --jq filter per page exactly as `gh --paginate` does;
# without --paginate only page 1 is served. GH_FAIL_WRITE=1 fails any write.
cat > "$WORKDIR/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -u
[ "${1:-}" = "api" ] || { echo "stub gh: unsupported: $*" >&2; exit 64; }
shift
method=GET; path=""; jqf=""; input=""; paginate=n
while [ $# -gt 0 ]; do
  case "$1" in
    --method|-X) method="$2"; shift 2 ;;
    --jq|-q)     jqf="$2"; shift 2 ;;
    --input)     input="$2"; shift 2 ;;
    --paginate)  paginate=y; shift ;;
    -f|-F|--field|--raw-field) echo "stub gh: field flags not served: $1" >&2; exit 64 ;;
    -*)          echo "stub gh: unknown flag $1" >&2; exit 64 ;;
    *)           path="$1"; shift ;;
  esac
done
if [ "$method" = GET ]; then
  echo "GET $path paginate=$paginate" >> "$GH_LOG"
  for p in "$GH_PAGES"/page-*.json; do
    [ -f "$p" ] || continue
    if [ -n "$jqf" ]; then jq -r "$jqf" "$p" || exit 1; else cat "$p"; fi
    [ "$paginate" = y ] || break
  done
  exit 0
fi
n=$(wc -l < "$GH_LOG" | tr -d ' ')
echo "$method $path" >> "$GH_LOG"
if [ "$input" = "-" ]; then cat > "$GH_LOG.$n.json"; elif [ -n "$input" ]; then cp "$input" "$GH_LOG.$n.json"; fi
[ "${GH_FAIL_WRITE:-0}" = 1 ] && { echo "stub gh: HTTP 500" >&2; exit 1; }
echo '{"id": 999}'
STUB
chmod +x "$WORKDIR/bin/gh"

# ── Runner helpers ───────────────────────────────────────────────────────────
# The post step runs `node _pw/.github/actions/agents-md-drift/cli.mjs render`
# from the job's working directory, where the score step left
# .agents-md-drift/scored.json. Link this checkout as _pw and write a canned
# score file: one high pair (a finding, id f1) and one middle pair.
ln -s "$REPO_ROOT" "$WORKDIR/_pw"
mkdir -p "$WORKDIR/.agents-md-drift"
cat > "$WORKDIR/.agents-md-drift/scored.json" <<'JSON'
{"scored": [
  {"id": "p1", "file": "Makefile", "agents_md": "AGENTS.md", "heading": "Build", "section": "## Build\nRun `make build`.", "distance": 0, "score": 0.91, "band": "high"},
  {"id": "p2", "file": "Makefile", "agents_md": "AGENTS.md", "heading": "Layout", "section": "## Layout\nsrc/ holds code.", "distance": 0, "score": 0.40, "band": "middle"}
], "overflow": []}
JSON

LOG=""; GHLOG=""; PAGES=""; RC=0

pages() { # pages <json-page-1> [<json-page-2> ...] — fresh canned listing
  PAGES="$WORKDIR/pages.$RANDOM$RANDOM"
  mkdir -p "$PAGES"
  local k=1 p
  for p in "$@"; do printf '%s' "$p" > "$PAGES/page-$k.json"; k=$((k + 1)); done
}

run_post() { # run_post <structured_output> [extra env assignments, which override the defaults...]
  local so="$1"; shift
  GHLOG="$WORKDIR/gh.$RANDOM$RANDOM.log"
  LOG="$GHLOG.out"
  : > "$GHLOG"
  [ -n "$PAGES" ] || pages '[]'
  (
    cd "$WORKDIR" || exit 1
    env PATH="$WORKDIR/bin:$PATH" \
      GH_LOG="$GHLOG" GH_PAGES="$PAGES" \
      GH_TOKEN=dummy REPO=o/r PR_NUMBER=7 HEAD_SHA=abc1234 \
      PAIRS_STATUS=ok JEV_STATUS=ok \
      STRUCTURED_OUTPUT="$so" "$@" \
      bash --noprofile --norc -eo pipefail "$EXTRACT/post.sh"
  ) > "$LOG" 2>&1
  RC=$?
}

writes()  { grep -cvE '^GET ' "$GHLOG" 2>/dev/null || true; }
write1()  { grep -vE '^GET ' "$GHLOG" | head -1; }
payload() { # payload body of the first write
  local n
  n=$(grep -nvE '^GET ' "$GHLOG" | head -1 | cut -d: -f1)
  jq -r '.body' "$GHLOG.$((n - 1)).json"
}
logged() { grep -q "^::$1" "$LOG"; }
has() { # has <label> <needle> — the first write's body contains needle
  if payload | grep -qF -- "$2"; then ok "$1"; else bad "$1" "body contains: $2" "$(payload | head -c 400)"; fi
}
lacks() {
  if payload | grep -qF -- "$2"; then bad "$1" "body without: $2" "$(payload | head -c 400)"; else ok "$1"; fi
}

comment() { # comment <id-json> <login> <body> -> one JSON comment object
  jq -cn --argjson id "$1" --arg l "$2" --arg b "$3" '{id: $id, user: {login: $l}, body: $b}'
}

DRAFTS='{"drafts":[{"id":"f1","draft":"## Build\nRun `make build-all`."}]}'
BOT='github-actions[bot]'

# ═════════════════════════════════════════════════════════════════════════════
section "Case 1 — no candidate pairs, no comment: nothing is written"
pages "[$(comment 5 octocat 'LGTM')]"
run_post "" PAIRS_STATUS=none JEV_STATUS=
assert_eq "case1 exit code" "0" "$RC"
assert_eq "case1 API writes" "0" "$(writes)"
if logged warning; then bad "case1 emits no ::warning" "no ::warning" "$(cat "$LOG")"; else ok "case1 emits no ::warning"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 2 — a JEV finding, no existing comment: exactly one create"
pages "[$(comment 5 octocat 'LGTM')]"
run_post "$DRAFTS"
assert_eq "case2 exit code" "0" "$RC"
assert_eq "case2 API writes" "1" "$(writes)"
assert_eq "case2 create call" "POST repos/o/r/issues/7/comments" "$(write1)"
case "$(payload)" in "$MARKER"*) ok "case2 body starts with the marker" ;; *) bad "case2 body starts with the marker" "$MARKER..." "$(payload | head -1)" ;; esac
has "case2 lists the finding's section" '`AGENTS.md` § `Build`'
has "case2 carries the drafted edit" 'make build-all'
has "case2 lists the middle pair for a human ruling" '### Needs a human ruling'
has "case2 carries the hidden state block" '<!-- agents-md-drift-state:'
if grep -q 'paginate=y' "$GHLOG"; then ok "case2 comment listing paginates"; else bad "case2 comment listing paginates" "paginate=y" "$(cat "$GHLOG")"; fi
POSTED="$(payload)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 3 — finding + existing new-marker comment: PATCH that id"
pages "[$(comment 5 octocat 'LGTM'),$(comment 111 "$BOT" "$MARKER"$'\n\nold')]"
run_post "$DRAFTS"
assert_eq "case3 exit code" "0" "$RC"
assert_eq "case3 API writes" "1" "$(writes)"
assert_eq "case3 update call" "PATCH repos/o/r/issues/comments/111" "$(write1)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 4 — finding + legacy-marker comment: PATCH it (migrates the heading)"
pages "[$(comment 222 "$BOT" "$LEGACY_MARKER"$'\n\nold')]"
run_post "$DRAFTS"
assert_eq "case4 API writes" "1" "$(writes)"
assert_eq "case4 update call" "PATCH repos/o/r/issues/comments/222" "$(write1)"
case "$(payload)" in "$MARKER"*) ok "case4 new body carries the new marker" ;; *) bad "case4 new body carries the new marker" "$MARKER..." "$(payload | head -1)" ;; esac

# ═════════════════════════════════════════════════════════════════════════════
section "Case 5 — existing comment only on page 2: found via pagination"
pages "[$(comment 1 octocat a)]" "[$(comment 333 "$BOT" "$MARKER"$'\n\nold')]"
run_post "$DRAFTS"
assert_eq "case5 update call" "PATCH repos/o/r/issues/comments/333" "$(write1)"
assert_eq "case5 API writes" "1" "$(writes)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 6 — two prior drift comments: only the oldest is updated"
pages "[$(comment 444 "$BOT" "$MARKER a"),$(comment 555 "$BOT" "$MARKER b")]"
run_post "$DRAFTS"
assert_eq "case6 API writes" "1" "$(writes)"
assert_eq "case6 update call" "PATCH repos/o/r/issues/comments/444" "$(write1)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 7 — a human's comment carrying the marker is never overwritten"
pages "[$(comment 666 octocat "$MARKER"$'\n\nhuman notes')]"
run_post "$DRAFTS"
assert_eq "case7 API writes" "1" "$(writes)"
assert_eq "case7 create (not PATCH of 666)" "POST repos/o/r/issues/7/comments" "$(write1)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 8 — a later push with no candidate pairs resolves the open finding"
pages "[$(comment 777 "$BOT" "$POSTED")]"
run_post "" PAIRS_STATUS=none JEV_STATUS= HEAD_SHA=def5678
assert_eq "case8 exit code" "0" "$RC"
assert_eq "case8 update call" "PATCH repos/o/r/issues/comments/777" "$(write1)"
has "case8 marks it resolved at the new sha" 'Resolved at def5678'
has "case8 says nothing is outstanding" 'No findings outstanding.'
has "case8 keeps the original finding text" 'make build-all'

# ═════════════════════════════════════════════════════════════════════════════
section "Case 9 — JEV unavailable, existing comment: notice added, finding kept open"
pages "[$(comment 777 "$BOT" "$POSTED")]"
run_post "" JEV_STATUS=unavailable HEAD_SHA=def5678
assert_eq "case9 exit code" "0" "$RC"
assert_eq "case9 update call" "PATCH repos/o/r/issues/comments/777" "$(write1)"
has "case9 body carries the notice" 'JEV was unavailable at def5678'
lacks "case9 does not resolve the finding" 'Resolved at'
has "case9 keeps the finding" '`AGENTS.md` § `Build`'
if logged notice; then ok "case9 emits a ::notice"; else bad "case9 emits a ::notice" "::notice ..." "$(cat "$LOG")"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 10 — JEV unavailable, no comment: a notice alone never creates one"
pages "[$(comment 5 octocat 'LGTM')]"
run_post "" JEV_STATUS=unavailable
assert_eq "case10 exit code" "0" "$RC"
assert_eq "case10 API writes" "0" "$(writes)"
if logged notice; then ok "case10 emits a ::notice"; else bad "case10 emits a ::notice" "::notice ..." "$(cat "$LOG")"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 11 — missing or garbage drafts: finding posted without an edit"
for g in '' 'not json at all' '{"drafts":"x"}' '[1,2]'; do
  pages '[]'
  run_post "$g"
  assert_eq "case11 [$g] exit code" "0" "$RC"
  assert_eq "case11 [$g] create call" "POST repos/o/r/issues/7/comments" "$(write1)"
  has "case11 [$g] says no edit was drafted" 'No proposed edit was drafted'
  if logged warning; then ok "case11 [$g] emits a ::warning"; else bad "case11 [$g] emits a ::warning" "::warning ..." "$(cat "$LOG")"; fi
done

# ═════════════════════════════════════════════════════════════════════════════
section "Case 12 — oversize previous body is capped under GitHub's 65536-char limit"
big="$MARKER"$'\n\n'"$(head -c 70000 /dev/zero | tr '\0' 'x')"
pages "[$(comment 888 "$BOT" "$big")]"
run_post "" JEV_STATUS=unavailable
assert_eq "case12 API writes" "1" "$(writes)"
len=$(jq -r '.body | length' "$GHLOG.$(( $(grep -nvE '^GET ' "$GHLOG" | head -1 | cut -d: -f1) - 1 )).json")
if [ "$len" -le 65536 ]; then ok "case12 body length $len <= 65536"; else bad "case12 body length" "<= 65536" "$len"; fi
case "$(payload)" in "$MARKER"*) ok "case12 capped body keeps the marker" ;; *) bad "case12 capped body keeps the marker" "$MARKER..." "?" ;; esac

# ═════════════════════════════════════════════════════════════════════════════
section "Case 13 — a failed API write fails the step (no silent success)"
pages '[]'
run_post "$DRAFTS" GH_FAIL_WRITE=1
if [ "$RC" -ne 0 ]; then ok "case13 exit code non-zero ($RC)"; else bad "case13 exit code" "non-zero" "$RC"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 14 — a non-numeric comment id from the listing fails the step, writes nothing"
pages "[$(comment '"1;x"' "$BOT" "$MARKER old")]"
run_post "$DRAFTS"
if [ "$RC" -ne 0 ]; then ok "case14 exit code non-zero ($RC)"; else bad "case14 exit code" "non-zero" "$RC"; fi
assert_eq "case14 API writes" "0" "$(writes)"

# ═════════════════════════════════════════════════════════════════════════════
printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
