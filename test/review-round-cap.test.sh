#!/usr/bin/env bash
#
# Tests for the @mention re-review round cap in .github/workflows/preflight.yml,
# step "Check for code changes in the PR" (id: check).
#
# On a pull_request_review_comment event the step first looks up the
# commenter's (COMMENTER) repository permission: unless it is admin or write the
# review is skipped (has_code=false, no reply), with or without the
# extra-review-round label; a lookup that fails also skips the review, with a
# warning. It then lists the PR's review comments and counts the earlier ones
# that would have started this reviewer: the body contains the mention keyword
# (any case), the author is not a bot (login containing coderabbit, devin or
# [bot]), its id is lower than the comment that started this run (it came
# before it), and its author has admin or write permission. Authors are looked
# up only once that unfiltered count reaches MAX_REREVIEWS, each at most once;
# an author whose lookup fails is not counted, with a warning. At
# MAX_REREVIEWS or more, and without the extra-review-round label, it writes
# has_code=false and replies on the thread; otherwise has_code=true. A listing
# that fails or cannot be read fails open; a failed reply does not fail the
# step. A pull_request event looks up no permission.
#
# The step's real `run:` block is EXTRACTED from the workflow YAML at run time,
# never mirrored, and run the way GitHub runs a step with no shell: key
# (`bash -e`, no pipefail) with exactly the variables its env: block declares,
# against a stub `gh` first on PATH that serves a canned comment listing and a
# per-case permission fixture, and records every call. The mention path is
# exercised, plus one pull_request run that must look up no permission.
#
# Requires: bash (3.2+), python3 with PyYAML, jq.
#
# Usage: bash test/review-round-cap.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# PREFLIGHT_WORKFLOW points the suite at another copy (used to mutation-test it).
WORKFLOW="${PREFLIGHT_WORKFLOW:-$REPO_ROOT/.github/workflows/preflight.yml}"

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

# ── Static contract: extract the real step ───────────────────────────────────
section "Static contract — the step the cases run"

# Each check prints "PASS<TAB>name" or "FAIL<TAB>name<TAB>expected<TAB>actual";
# the step's run: body and its env: names are written out for the cases below.
python3 - "$WORKFLOW" "$EXTRACT" > "$WORKDIR/static.tsv" <<'PY' || { echo "ERROR: static extraction failed" >&2; exit 1; }
import pathlib
import sys

import yaml

wf = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
out = pathlib.Path(sys.argv[2])


def check(name, cond, expected="", actual=""):
    if cond:
        print("PASS\t%s" % name)
    else:
        print("FAIL\t%s\t%s\t%s" % (name, expected, str(actual).replace("\n", " ")))


job = (wf.get("jobs") or {}).get("check") or {}
step = next((s for s in job.get("steps") or [] if s.get("id") == "check"), None)
check("job check has the step id: check", step is not None, "a step with id: check", "none")
if step is None:
    sys.exit(0)

body = step.get("run") or ""
check("step is a plain run: step (no uses:)", bool(body) and "uses" not in step, "run only", step.get("uses"))
check("run: body has no ${{ }} expressions (inputs arrive via env:)", "${{" not in body, "none", "contains ${{")
# With no shell: key GitHub runs the block as `bash -e {0}` (no pipefail), which
# is how the cases run it; an override must be mirrored there.
shells = [s for s in (
    step.get("shell"),
    ((job.get("defaults") or {}).get("run") or {}).get("shell"),
    ((wf.get("defaults") or {}).get("run") or {}).get("shell"),
) if s]
check("step runs in the default shell (bash -e, no pipefail)", not shells, "no shell: override", shells)

(out / "check.sh").write_text(body)
(out / "env.txt").write_text("".join("%s\n" % k for k in (step.get("env") or {})))
PY

while IFS=$'\t' read -r verdict name exp act; do
  if [ "$verdict" = "PASS" ]; then ok "$name"; else bad "$name" "$exp" "$act"; fi
done < "$WORKDIR/static.tsv"

if [ ! -s "$EXTRACT/check.sh" ]; then
  printf '\n  passed: %d   failed: %d  (step missing — behavioural cases not run)\n' "$PASS" "$((FAIL + 1))"
  exit 1
fi

section "Syntax checks"
if bash -n "$EXTRACT/check.sh" 2>"$WORKDIR/check.syn"; then
  ok "bash -n check.sh"
else
  bad "bash -n check.sh" "clean parse" "$(cat "$WORKDIR/check.syn")"
fi

# ── The step's env: ──────────────────────────────────────────────────────────
# Only the names the step's env: block declares are set (plus the runner's
# GITHUB_OUTPUT), so a variable the block stops providing fails under set -u
# here as it would on the runner. A new name with no value here fails below.
CUR=9001 # id of the review comment that started the run
step_env() { # step_env <name> — this suite's value for one env: variable
  case "$1" in
    GH_TOKEN)           echo dummy ;;
    EVENT_NAME)         echo pull_request_review_comment ;;
    REPO)               echo o/r ;;
    PR_NUMBER)          echo 7 ;;
    REVIEWER_NAME)      echo Gemini ;;
    MENTION_KEYWORD)    echo @gemini ;;
    FORCE_REVIEW_REGEX) echo "" ;;
    COMMENT_ID)         echo "$CUR" ;;
    THREAD_ID)          echo "$CUR" ;; # a new thread: the comment is its own root
    EXTRA_ROUND)        echo false ;;  # no extra-review-round label
    COMMENTER)          echo octocat ;; # author of the comment that started the run (cur)
    *)                  return 1 ;;
  esac
}
STEP_ENV=()
unset_names=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if value=$(step_env "$name"); then STEP_ENV+=("$name=$value"); else unset_names="$unset_names $name"; fi
done < "$EXTRACT/env.txt"
assert_eq "suite gives every env: variable of the step a value" "" "${unset_names# }"

# ── Stub gh ──────────────────────────────────────────────────────────────────
# Serves the calls the step makes. Records one line per call in $GH_LOG
# ("GET <path> paginate=<y|n>" or "<METHOD> <path>") and saves each write's
# body field as $GH_LOG.<n>.body.
# - GET repos/<o>/<r>/collaborators/<login>/permission answers from the
#   per-case fixture GH_PERMS ("login=perm ...", perm admin|write|read|none or
#   fail). A login it does not name has write, so by default the commenter and
#   every earlier author can write. "fail", or an empty login, exits 1 with the
#   error body on stdout, as gh does on an HTTP error even with --jq.
# - Any other GET serves $GH_PAGES/page-<k>.json back to back, as
#   `gh api --paginate` does; without --paginate only page 1.
# --jq is applied per page, as gh does. GH_FAIL_LIST=1 fails that listing GET
# (not a permission lookup), GH_FAIL_POST=1 fails the write.
cat > "$WORKDIR/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -u
[ "${1:-}" = "api" ] || { echo "stub gh: unsupported: $*" >&2; exit 64; }
shift
method=""; path=""; paginate=n; fields=0; body=""; jqf=""
while [ $# -gt 0 ]; do
  case "$1" in
    --method|-X) method="$2"; shift 2 ;;
    --paginate)  paginate=y; shift ;;
    --jq|-q)     jqf="$2"; shift 2 ;;
    -f|-F|--field|--raw-field)
      fields=$((fields + 1))
      case "$2" in body=*) body="${2#body=}" ;; esac
      shift 2 ;;
    -*)          echo "stub gh: unknown flag $1" >&2; exit 64 ;;
    *)           path="$1"; shift ;;
  esac
done
# Like gh: POST once a field is given, GET otherwise.
if [ -z "$method" ]; then
  if [ "$fields" -gt 0 ]; then method=POST; else method=GET; fi
fi
emit() { if [ -n "$jqf" ]; then jq -r "$jqf" || exit 1; else cat; fi; }
if [ "$method" = GET ]; then
  echo "GET $path paginate=$paginate" >> "$GH_LOG"
  case "$path" in
    repos/*/collaborators/*/permission)
      login="${path#repos/*/collaborators/}"; login="${login%/permission}"
      perm=write
      set -f
      for kv in ${GH_PERMS:-}; do
        if [ "${kv%%=*}" = "$login" ]; then perm="${kv#*=}"; fi
      done
      set +f
      if [ -z "$login" ] || [ "$perm" = fail ]; then
        echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1
      fi
      jq -cn --arg p "$perm" --arg l "$login" '{permission: $p, role_name: $p, user: {login: $l}}' | emit || exit 1
      exit 0 ;;
  esac
  if [ "${GH_FAIL_LIST:-0}" = 1 ]; then
    echo '{"message":"Server Error"}'; echo "gh: Server Error (HTTP 500)" >&2; exit 1
  fi
  for p in "$GH_PAGES"/page-*.json; do
    [ -f "$p" ] || continue
    emit < "$p"
    [ "$paginate" = y ] || break
  done
  exit 0
fi
n=$(wc -l < "$GH_LOG" | tr -d ' ')
echo "$method $path" >> "$GH_LOG"
printf '%s' "$body" > "$GH_LOG.$n.body"
if [ "${GH_FAIL_POST:-0}" = 1 ]; then
  echo '{"message":"Server Error"}'; echo "gh: Server Error (HTTP 500)" >&2; exit 1
fi
echo '{"id": 999}'
STUB
chmod +x "$WORKDIR/bin/gh"

# ── Runner helpers ───────────────────────────────────────────────────────────
RUN=0; GHLOG=""; LOG=""; OUT=""; PAGES=""; RC=0

pages() { # pages <json-page-1> [<json-page-2> ...] — the listing the stub serves
  RUN=$((RUN + 1))
  PAGES="$WORKDIR/pages.$RUN"
  mkdir -p "$PAGES"
  local k=1 p
  for p in "$@"; do printf '%s' "$p" > "$PAGES/page-$k.json"; k=$((k + 1)); done
}

run_check() { # run_check [NAME=value ...] — the step's env:, then these overrides
  RUN=$((RUN + 1))
  GHLOG="$WORKDIR/gh.$RUN.log"
  LOG="$WORKDIR/step.$RUN.log"
  OUT="$WORKDIR/output.$RUN"
  : > "$GHLOG"
  : > "$OUT"
  (
    cd "$WORKDIR" || exit 1
    env -i PATH="$WORKDIR/bin:$PATH" HOME="$WORKDIR" GITHUB_OUTPUT="$OUT" \
      GH_LOG="$GHLOG" GH_PAGES="$PAGES" ${STEP_ENV[@]+"${STEP_ENV[@]}"} "$@" \
      bash -e "$EXTRACT/check.sh"
  ) > "$LOG" 2>&1
  RC=$?
}

lists()  { awk '/^GET / && !/\/collaborators\/[^ ]*\/permission /' "$GHLOG"; } # GETs but permission lookups
perms()  { # one line per permission lookup: the login looked up
  awk '/^GET [^ ]*\/collaborators\/[^ ]*\/permission / {
    sub(/^GET [^ ]*\/collaborators\//, ""); sub(/\/permission .*$/, ""); print }' "$GHLOG"
}
posts()  { grep -vE '^GET ' "$GHLOG" || true; }
warned() { grep -q '^::warning::' "$LOG"; }
reply_body() { # body field of the first write
  local n
  n=$(grep -nvE '^GET ' "$GHLOG" | head -1 | cut -d: -f1)
  [ -n "$n" ] && cat "$GHLOG.$((n - 1)).body"
}

expect() { # expect <label> <has_code> [<reply path>] — no path: no reply may be posted
  assert_eq "$1: step exits 0" "0" "$RC"
  assert_eq "$1: has_code" "has_code=$2" "$(cat "$OUT")"
  if [ -n "${3:-}" ]; then
    assert_eq "$1: one reply, POSTed to the thread root" "POST $3" "$(posts)"
  else
    assert_eq "$1: no reply posted" "" "$(posts)"
  fi
}

c() { # c <id> <login> <body> — one review comment, with the fields the count reads
  jq -cn --argjson id "$1" --arg l "$2" --arg b "$3" '{id: $id, user: {login: $l}, body: $b}'
}
cur() { c "$CUR" octocat '@gemini please take another look'; } # the comment that started this run

TWO="$(c 101 alice '@gemini review this'),$(c 102 bob '@gemini again please')"
THREE="$TWO,$(c 103 carol 'ping @gemini')"
PLAIN="$(c 104 dave 'nit: rename this variable'),$(c 105 erin 'LGTM once CI is green')"
REPLY_ROOT="repos/o/r/pulls/7/comments/$CUR/replies"

mentions() { # mentions <login>... — one earlier @gemini request per login, ids 101, 102, ...
  local id=101 l out=""
  for l in "$@"; do out="$out${out:+,}$(c "$id" "$l" "@gemini round $id")"; id=$((id + 1)); done
  printf '%s' "$out"
}

# perm_case <label> <EXTRA_ROUND> <GH_PERMS> <has_code> <reply y|n> <warning y|n|-> <earlier mention author>...
# One row of a permission table: the earlier mentions are by the given logins,
# the commenter is octocat. reply y: one reply on the thread root, n: none.
# warning y: a ::warning is emitted, n: none is, -: not checked.
perm_case() {
  local label="$1" extra="$2" fixture="$3" hc="$4" reply="$5" warn="$6"
  shift 6
  pages "[$(mentions "$@"),$(cur)]"
  run_check EXTRA_ROUND="$extra" GH_PERMS="$fixture"
  if [ "$reply" = y ]; then expect "$label" "$hc" "$REPLY_ROOT"; else expect "$label" "$hc"; fi
  case "$warn" in
    y) if warned; then ok "$label: emits a ::warning"; else bad "$label: emits a ::warning" "::warning::..." "$(cat "$LOG")"; fi ;;
    n) if warned; then bad "$label: emits no ::warning" "none" "$(grep '^::warning::' "$LOG")"; else ok "$label: emits no ::warning"; fi ;;
  esac
}

# ═════════════════════════════════════════════════════════════════════════════
section "Case 1 — 2 earlier mentions (and comments without one): runs"
pages "[$TWO,$PLAIN]"
run_check
expect "case1" true

# ═════════════════════════════════════════════════════════════════════════════
section "Case 2 — 3 earlier mentions: skipped, one reply on the thread"
pages "[$THREE,$(cur)]"
run_check
expect "case2" false "$REPLY_ROOT"
case "$(reply_body)" in
  *extra-review-round*) ok "case2 reply names the extra-review-round label" ;;
  *) bad "case2 reply names the extra-review-round label" "...extra-review-round..." "$(reply_body)" ;;
esac

# ═════════════════════════════════════════════════════════════════════════════
section "Case 3 — the mention is a reply: the notice goes to the thread root"
# The current comment replies to comment 101, so in_reply_to_id is 101.
pages "[$THREE,$(cur)]"
run_check THREAD_ID=101
expect "case3" false "repos/o/r/pulls/7/comments/101/replies"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 4 — 3 earlier mentions + extra-review-round label: runs, no listing"
pages "[$THREE,$(cur)]"
run_check EXTRA_ROUND=true
expect "case4" true
assert_eq "case4 comments are not listed" "" "$(lists)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 5 — mentions by bot logins do not count (3 by one bot + 2 human)"
for login in 'coderabbitai[bot]' 'devin-ai-integration[bot]' 'github-actions[bot]' 'CodeRabbitAI' 'Devin-Reviewer'; do
  pages "[$(c 201 "$login" '@gemini summary'),$(c 202 "$login" 'walkthrough cc @gemini'),$(c 203 "$login" '@gemini'),$TWO,$(cur)]"
  run_check
  expect "case5 [$login]" true
done

# ═════════════════════════════════════════════════════════════════════════════
section "Case 6 — the keyword in another case still counts"
pages "[$(c 101 alice '@Gemini review this'),$(c 102 bob '@GEMINI again'),$(c 103 carol 'ping @GeMiNi'),$(cur)]"
run_check
expect "case6" false "$REPLY_ROOT"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 7 — the comment that started the run is not counted"
pages "[$TWO,$(cur)]"
run_check
expect "case7" true

# ═════════════════════════════════════════════════════════════════════════════
section "Case 8 — the listing spans two pages: both are counted"
pages "[$TWO]" "[$(c 103 carol 'ping @gemini'),$(cur)]"
run_check
expect "case8" false "$REPLY_ROOT"
assert_eq "case8 lists the PR's review comments, paginated" "GET repos/o/r/pulls/7/comments paginate=y" "$(lists)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 9 — the listing fails: runs (fails open) with a warning"
pages "[$THREE,$(cur)]"
run_check GH_FAIL_LIST=1
expect "case9" true
if warned; then ok "case9 emits a ::warning"; else bad "case9 emits a ::warning" "::warning::..." "$(cat "$LOG")"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 10 — the reply fails at the cap: still skipped, step succeeds"
pages "[$THREE,$(cur)]"
run_check GH_FAIL_POST=1
expect "case10" false "$REPLY_ROOT"
if warned; then ok "case10 emits a ::warning"; else bad "case10 emits a ::warning" "::warning::..." "$(cat "$LOG")"; fi

# ═════════════════════════════════════════════════════════════════════════════
section "Case 11 — null body / null user do not break the count"
# A count that errors fails open (runs), so the fixture reaches the cap: only a
# count that got through the nulls skips. 3 human mentions reach it whether or
# not the null-user mention counts.
NULLS='{"id":301,"user":null,"body":"@gemini review"},{"id":302,"user":{"login":"alice"},"body":null},{"id":303,"user":null,"body":null}'
pages "[$NULLS,$THREE,$(cur)]"
run_check
expect "case11" false "$REPLY_ROOT"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 12 — mentions posted after the current comment do not count"
NEWER="$(c 9002 frank '@gemini one more time'),$(c 9003 grace 'again @gemini')"
pages "[$TWO,$(cur),$NEWER]"
run_check
expect "case12 2 earlier + 2 newer" true
pages "[$THREE,$(cur),$NEWER]"
run_check
expect "case12 3 earlier + 2 newer" false "$REPLY_ROOT"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 13 — the listing succeeds but is not JSON: runs (fails open) with a warning"
pages '<html><body>Bad gateway</body></html>'
run_check
expect "case13" true
if warned; then ok "case13 emits a ::warning"; else bad "case13 emits a ::warning" "::warning::..." "$(cat "$LOG")"; fi
# The fallback must set a usable count, not reach has_code=true through a failed [ test.
assert_eq "case13 step log has no shell error" "" "$(grep -E 'check\.sh: line [0-9]+: ' "$LOG" || true)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 14 — the commenter needs admin or write; the label lifts only the cap"
# Under the cap (2 earlier mentions) only the gate can skip, so a skip here is
# the gate's; at the cap (3) the gate must win before the cap posts its notice.
#         label                                          EXTRA  GH_PERMS        has_code reply warning earlier mentions by
perm_case "case14 admin commenter"                       false  "octocat=admin" true     n     n       alice bob
perm_case "case14 read commenter"                        false  "octocat=read"  false    n     -       alice bob
perm_case "case14 none commenter"                        false  "octocat=none"  false    n     -       alice bob
perm_case "case14 read commenter + label"                true   "octocat=read"  false    n     -       alice bob
perm_case "case14 read commenter, 3 earlier: no notice"  false  "octocat=read"  false    n     -       alice bob carol
perm_case "case14 commenter lookup fails, 2 earlier"     false  "octocat=fail"  false    n     y       alice bob
perm_case "case14 commenter lookup fails, 3 earlier"     false  "octocat=fail"  false    n     y       alice bob carol

# ═════════════════════════════════════════════════════════════════════════════
section "Case 15 — only earlier mentions by admin/write authors count"
#         label                                          EXTRA  GH_PERMS                             has_code reply warning earlier mentions by
perm_case "case15 3 by writers (admin, write, write)"    false  "alice=admin bob=write carol=write"  false    y     n       alice bob carol
perm_case "case15 3 by a read account"                   false  "rita=read"                          true     n     n       rita rita rita
perm_case "case15 2 writers + 1 read"                    false  "carol=read"                         true     n     n       alice bob carol
perm_case "case15 2 writers + 1 none"                    false  "carol=none"                         true     n     n       alice bob carol
perm_case "case15 2 writers + 1 lookup fails"            false  "carol=fail"                         true     n     y       alice bob carol
perm_case "case15 3 writers + 1 lookup fails"            false  "dan=fail"                           false    y     y       alice bob carol dan

# ═════════════════════════════════════════════════════════════════════════════
section "Case 16 — lookups: only the commenter's under the cap; at it, each author once, the commenter's result reused"
pages "[$TWO,$PLAIN,$(cur)]"
run_check
expect "case16 under the cap" true
assert_eq "case16 under the cap: one lookup, the commenter's" "octocat" "$(perms | paste -sd ' ' -)"
# 4 counted mentions by 2 authors, plus authors the unfiltered count never
# reaches: no keyword (dave, erin), a bot, and a mention after this one.
pages "[$(c 111 alice '@gemini'),$(c 112 bob '@gemini again'),$(c 113 alice 'ping @gemini'),$(c 114 bob '@gemini once more'),$PLAIN,$(c 116 'github-actions[bot]' '@gemini summary'),$(cur),$(c 9002 frank '@gemini later')]"
run_check
expect "case16 at the cap" false "$REPLY_ROOT"
assert_eq "case16 at the cap: the commenter and each earlier author, once each" "alice bob octocat" "$(perms | sort | paste -sd ' ' -)"
# The commenter (octocat) made earlier requests too: their one lookup decides
# both the gate and whether those requests count.
#         label                                          EXTRA  GH_PERMS        has_code reply warning earlier mentions by
perm_case "case16 commenter can write: 2 earlier count"   false  ""              false    y     n       octocat octocat alice
assert_eq "case16 commenter can write: looked up once" "alice octocat" "$(perms | sort | paste -sd ' ' -)"
perm_case "case16 commenter lookup fails: skipped first"  false  "octocat=fail"  false    n     y       octocat octocat alice bob
assert_eq "case16 commenter lookup fails: no author lookups" "octocat" "$(perms | sort | paste -sd ' ' -)"

# ═════════════════════════════════════════════════════════════════════════════
section "Case 17 — a pull_request event looks up no permission"
pages '[{"filename":"src/main.go"}]'
run_check EVENT_NAME=pull_request COMMENTER= COMMENT_ID= THREAD_ID=
expect "case17" true
assert_eq "case17 no permission lookup" "0" "$(perms | wc -l | tr -d ' ')"

# ═════════════════════════════════════════════════════════════════════════════
printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
