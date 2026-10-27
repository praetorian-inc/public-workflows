#!/usr/bin/env bash
#
# Tests for the drift-comment path in .github/workflows/agents-md-drift.yml
# (ENG-5663).
#
# The model step is a read-only analyst that returns its verdict as
# `--json-schema` structured output; a deterministic `run:` step after it
# creates or updates the single drift comment. Two things are proven here:
#
#   1. The post step's real `run:` block — EXTRACTED from the workflow YAML at
#      run time, never mirrored — creates, updates, or skips correctly when
#      executed against a stub `gh` on PATH that records every call and serves
#      canned, paginated comment lists.
#   2. The model step's real `claude_args`, TOKENIZED (not grepped), grants the
#      model no tool that can post or edit a comment, disallows `gh api` and
#      `gh pr comment`, and carries a valid `--json-schema` whose required
#      fields are the ones the post step reads; and the post step is a plain
#      `run:` step after the model step, gated on it.
#
# Requires: bash, python3 with PyYAML, jq.
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

for dep in python3 jq; do
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
    check("schema requires drift_found + comment_body",
          req == {"drift_found", "comment_body"}, "drift_found,comment_body", sorted(req))
    check("drift_found is boolean", props.get("drift_found", {}).get("type") == "boolean",
          "boolean", props.get("drift_found"))
    check("comment_body is string", props.get("comment_body", {}).get("type") == "string",
          "string", props.get("comment_body"))

# ── Post step shape ──
body = post.get("run", "")
check("post step is a plain run: step (no uses:)", "uses" not in post and bool(body), "run only", post.get("uses"))
check("post run: body has no ${{ }} expressions", "${{" not in body, "none", "contains ${{")
check("post step runs after the model step", pi > mi, "> %s" % mi, pi)
cond = str(post.get("if", ""))


# ── Evaluate the post step's if: the way Actions does ──
# A minimal evaluator for the expression subset a step condition uses:
# ! && || ( ) == != , string/bool/null literals, steps.<id>.outcome|conclusion,
# and the status functions. Strings compare case-insensitively, and a condition
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


# Expected run/skip table: publish whatever the model step concluded (success
# OR failure, so a crashed analysis still surfaces its no-result warning), but
# never when it was skipped (scope said nothing to check) or the run was
# cancelled. The model step has no continue-on-error, so its failure fails the
# job: success() false, failure() true.
for outcome in ("success", "failure", "skipped"):
    for cancelled in (False, True):
        want_run = (not cancelled) and outcome in ("success", "failure")
        ctx = {
            "steps": {model_id: {"outcome": outcome, "conclusion": outcome}},
            "cancelled()": cancelled,
            "success()": not cancelled and outcome != "failure",
            "failure()": outcome == "failure",
            "always()": True,
        }
        label = "post step if: %s when %s%s" % (
            "runs" if want_run else "skips", outcome, ", run cancelled" if cancelled else "")
        try:
            got = evaluate(cond, ctx)
        except ExprError as e:
            check(label, False, "evaluable condition", "%s (%s)" % (cond, e))
            continue
        check(label, got == want_run, "run" if want_run else "skip", "%s for if: %s" % (
            "run" if got else "skip", cond))
env = post.get("env", {}) or {}
want = "${{ steps.%s.outputs.structured_output }}" % model_id
check("post step receives structured_output via env", env.get("STRUCTURED_OUTPUT") == want,
      want, env.get("STRUCTURED_OUTPUT"))
check("post step has GH_TOKEN", "GH_TOKEN" in env, "GH_TOKEN", sorted(env))
for k in ("REPO", "PR_NUMBER"):
    check("post step env has %s" % k, k in env, k, sorted(env))
if schema is not None:
    read = set(re.findall(r"\.([A-Za-z_][A-Za-z0-9_]*)", body)) & set(schema.get("properties", {}))
    check("post step reads exactly the schema's required fields",
          read == set(schema.get("required", [])), sorted(schema.get("required", [])), sorted(read))

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
LOG=""; GHLOG=""; PAGES=""; RC=0

pages() { # pages <json-page-1> [<json-page-2> ...] — fresh canned listing
  PAGES="$WORKDIR/pages.$RANDOM$RANDOM"
  mkdir -p "$PAGES"
  local k=1 p
  for p in "$@"; do printf '%s' "$p" > "$PAGES/page-$k.json"; k=$((k + 1)); done
}

run_post() { # run_post <structured_output> [extra env assignments...]
  local so="$1"; shift
  GHLOG="$WORKDIR/gh.$RANDOM$RANDOM.log"
  LOG="$GHLOG.out"
  : > "$GHLOG"
  [ -n "$PAGES" ] || pages '[]'
  (
    cd "$WORKDIR" || exit 1
    env PATH="$WORKDIR/bin:$PATH" \
      GH_LOG="$GHLOG" GH_PAGES="$PAGES" \
      GH_TOKEN=dummy REPO=o/r PR_NUMBER=7 \
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
logged_warning() { grep -q '^::warning' "$LOG"; }

comment() { # comment <id> <login> <body> -> one JSON comment object
  jq -cn --argjson id "$1" --arg l "$2" --arg b "$3" '{id: $id, user: {login: $l}, body: $b}'
}

so() { # so <drift_found> <comment_body>
  jq -cn --argjson d "$1" --arg b "$2" '{drift_found: $d, comment_body: $b}'
}

BOT='github-actions[bot]'
BODY="$MARKER"$'\n\nCode changes in this PR may have made documentation stale:\n\n### `AGENTS.md`\n| Section | Issue | Evidence |\n|---|---|---|\n| "Build" | make target renamed | Makefile |\n'

# ═════════════════════════════════════════════════════════════════════════════
section "Case 1 — no drift: nothing is written"
pages "[$(comment 111 "$BOT" "$MARKER old")]"
run_post "$(so false "")"
assert_eq "case1 exit code" "0" "$RC"
assert_eq "case1 API writes" "0" "$(writes)"
if logged_warning; then bad "case1 emits no ::warning" "no ::warning" "$(cat "$LOG")"; else ok "case1 emits no ::warning"; fi

# A non-empty body must not be posted when drift_found is false — the
# drift_found exit, not the empty-body warning, is what stops it here.
section "Case 1b — no drift but a non-empty body: still nothing is written"
pages "[$(comment 111 "$BOT" "$MARKER old")]"
run_post "$(so false "$BODY")"
assert_eq "case1b exit code" "0" "$RC"
assert_eq "case1b API writes" "0" "$(writes)"
if logged_warning; then bad "case1b emits no ::warning" "no ::warning" "$(cat "$LOG")"; else ok "case1b emits no ::warning"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 2 — drift, no existing comment: exactly one create"
pages "[$(comment 5 octocat 'LGTM')]"
run_post "$(so true "$BODY")"
assert_eq "case2 exit code" "0" "$RC"
assert_eq "case2 API writes" "1" "$(writes)"
assert_eq "case2 create call" "POST repos/o/r/issues/7/comments" "$(write1)"
assert_eq "case2 body posted verbatim" "$BODY" "$(payload)"$'\n'
if grep -q 'paginate=y' "$GHLOG"; then ok "case2 comment listing paginates"; else bad "case2 comment listing paginates" "paginate=y" "$(cat "$GHLOG")"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 3 — drift + existing new-marker comment: PATCH that id"
pages "[$(comment 5 octocat 'LGTM'),$(comment 111 "$BOT" "$MARKER"$'\n\nold')]"
run_post "$(so true "$BODY")"
assert_eq "case3 exit code" "0" "$RC"
assert_eq "case3 API writes" "1" "$(writes)"
assert_eq "case3 update call" "PATCH repos/o/r/issues/comments/111" "$(write1)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 4 — drift + legacy-marker comment: PATCH it (migrates the heading)"
pages "[$(comment 222 "$BOT" "$LEGACY_MARKER"$'\n\nold')]"
run_post "$(so true "$BODY")"
assert_eq "case4 API writes" "1" "$(writes)"
assert_eq "case4 update call" "PATCH repos/o/r/issues/comments/222" "$(write1)"
case "$(payload)" in "$MARKER"*) ok "case4 new body carries the new marker" ;; *) bad "case4 new body carries the new marker" "$MARKER..." "$(payload | head -1)" ;; esac

# ═════════════════════════════════════════════════════════════════════════════
section "Case 5 — existing comment only on page 2: found via pagination"
pages "[$(comment 1 octocat a)]" "[$(comment 333 "$BOT" "$MARKER"$'\n\nold')]"
run_post "$(so true "$BODY")"
assert_eq "case5 update call" "PATCH repos/o/r/issues/comments/333" "$(write1)"
assert_eq "case5 API writes" "1" "$(writes)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 6 — two prior drift comments: only the oldest is updated"
pages "[$(comment 444 "$BOT" "$MARKER a"),$(comment 555 "$BOT" "$MARKER b")]"
run_post "$(so true "$BODY")"
assert_eq "case6 API writes" "1" "$(writes)"
assert_eq "case6 update call" "PATCH repos/o/r/issues/comments/444" "$(write1)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 7 — a human's comment carrying the marker is never overwritten"
pages "[$(comment 666 octocat "$MARKER"$'\n\nhuman notes')]"
run_post "$(so true "$BODY")"
assert_eq "case7 API writes" "1" "$(writes)"
assert_eq "case7 create (not PATCH of 666)" "POST repos/o/r/issues/7/comments" "$(write1)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 8 — missing structured output (model errored / hit max-turns)"
pages '[]'
run_post ""
assert_eq "case8 exit code" "0" "$RC"
assert_eq "case8 API calls" "0" "$(wc -l < "$GHLOG" | tr -d ' ')"
if logged_warning && grep -q 'no structured output' "$LOG"; then
  ok "case8 emits the no-result ::warning"
else
  bad "case8 emits the no-result ::warning" "::warning ... no structured output ..." "$(cat "$LOG")"
fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 9 — garbage / off-schema structured output"
for g in 'not json at all' '{"drift_found":"yes","comment_body":"x"}' '{"drift_found":true}' '[1,2]'; do
  run_post "$g"
  assert_eq "case9 [$g] exit code" "0" "$RC"
  assert_eq "case9 [$g] API calls" "0" "$(wc -l < "$GHLOG" | tr -d ' ')"
  if logged_warning; then ok "case9 [$g] emits a ::warning"; else bad "case9 [$g] emits a ::warning" "::warning ..." "$(cat "$LOG")"; fi
done

# ═════════════════════════════════════════════════════════════════════════════
section "Case 10 — drift with an empty body: warn, post nothing"
run_post "$(so true $'  \n ')"
assert_eq "case10 API writes" "0" "$(writes)"
if logged_warning; then ok "case10 emits a ::warning"; else bad "case10 emits a ::warning" "::warning ..." "$(cat "$LOG")"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 11 — body missing the heading: marker is forced, next run finds it"
pages '[]'
run_post "$(so true $'\n  Code changes in this PR may have made documentation stale.\n')"
assert_eq "case11 create call" "POST repos/o/r/issues/7/comments" "$(write1)"
posted="$(payload)"
case "$posted" in "$MARKER"*) ok "case11 posted body starts with the marker" ;; *) bad "case11 posted body starts with the marker" "$MARKER..." "$(printf '%s' "$posted" | head -1)" ;; esac
# Re-run against what was just posted: it must be found and PATCHed.
pages "[$(comment 777 "$BOT" "$posted")]"
run_post "$(so true 'still stale')"
assert_eq "case11 re-run updates, no duplicate" "PATCH repos/o/r/issues/comments/777" "$(write1)"
assert_eq "case11 re-run API writes" "1" "$(writes)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 12 — leading whitespace before the heading is not doubled"
pages '[]'
run_post "$(so true $'\n\n'"$BODY")"
assert_eq "case12 body normalized to start at the heading" "$BODY" "$(payload)"$'\n'

# ═════════════════════════════════════════════════════════════════════════════
section "Case 13 — oversize body is capped under GitHub's 65536-char limit"
big="$MARKER"$'\n\n'"$(head -c 70000 /dev/zero | tr '\0' 'x')"
run_post "$(so true "$big")"
assert_eq "case13 API writes" "1" "$(writes)"
len=$(jq -r '.body | length' "$GHLOG.$(( $(grep -nvE '^GET ' "$GHLOG" | head -1 | cut -d: -f1) - 1 )).json")
if [ "$len" -le 65536 ]; then ok "case13 body length $len <= 65536"; else bad "case13 body length" "<= 65536" "$len"; fi
case "$(payload)" in "$MARKER"*) ok "case13 capped body keeps the marker" ;; *) bad "case13 capped body keeps the marker" "$MARKER..." "?" ;; esac

# ═════════════════════════════════════════════════════════════════════════════
section "Case 14 — a failed API write fails the step (no silent success)"
pages '[]'
run_post "$(so true "$BODY")" GH_FAIL_WRITE=1
if [ "$RC" -ne 0 ]; then ok "case14 exit code non-zero ($RC)"; else bad "case14 exit code" "non-zero" "$RC"; fi

# ═════════════════════════════════════════════════════════════════════════════
printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
