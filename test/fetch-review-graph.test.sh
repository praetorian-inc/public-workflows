#!/usr/bin/env bash
#
# Tests for .github/actions/fetch-review-graph/fetch-review-graph.sh (ENG-5658).
#
# The script is fail-open: every path exits 0. A fake `gh` on PATH, driven by
# files under a fixture dir, stands in for the Actions API.
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO_ROOT/.github/actions/fetch-review-graph/fetch-review-graph.sh"

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

# Fake gh: first matching rule wins. Fixture files under $GH_FIXTURE.
install_fake_gh() {
  local bin="$WORKDIR/bin"
  mkdir -p "$bin"
  cat > "$bin/gh" <<'GH'
#!/usr/bin/env bash
set -u
fix="${GH_FIXTURE:?}"
if [ "${1:-}" = "api" ]; then
  path="${2:-}"
  case "$path" in
    repos/*/actions/runs/*/artifacts)
      if [ -f "$fix/artifacts.fail" ]; then exit 1; fi
      if [ -f "$fix/artifacts" ]; then cat "$fix/artifacts"; exit 0; fi
      exit 0
      ;;
    repos/*)
      if [ -f "$fix/default_branch.fail" ]; then exit 1; fi
      if [ -f "$fix/default_branch" ]; then cat "$fix/default_branch"; exit 0; fi
      exit 1
      ;;
  esac
  echo "unexpected gh api: $*" >&2
  exit 99
fi
if [ "${1:-}" = "run" ] && [ "${2:-}" = "list" ]; then
  if [ -f "$fix/run_list.fail" ]; then exit 1; fi
  if [ -f "$fix/run_list" ]; then cat "$fix/run_list"; exit 0; fi
  exit 0
fi
if [ "${1:-}" = "run" ] && [ "${2:-}" = "download" ]; then
  if [ -f "$fix/download.fail" ]; then exit 1; fi
  dest=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "-D" ]; then dest=$a; fi
    prev=$a
  done
  [ -n "$dest" ] || exit 1
  if [ -d "$fix/download" ]; then
    cp -R "$fix/download/." "$dest/"
    exit 0
  fi
  exit 1
fi
echo "unexpected gh invocation: $*" >&2
exit 99
GH
  chmod +x "$bin/gh"
  export PATH="$bin:$PATH"
}

run_script() {
  local outdir=$1
  mkdir -p "$outdir"
  (
    export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-praetorian-inc/fixture}"
    export GH_TOKEN="${GH_TOKEN:-fake-token}"
    export DEST="$outdir/graphify-out"
    export GITHUB_OUTPUT="$outdir/github_output"
    : > "$GITHUB_OUTPUT"
    bash "$SCRIPT"
  )
}

read_out() {
  # grep KEY= from GITHUB_OUTPUT
  local file=$1 key=$2
  grep -E "^${key}=" "$file" | tail -n 1 | sed "s/^${key}=//"
}

valid_graph() {
  python3 -I -c 'import json,sys; json.dump({"nodes":[{"id":"n1"}],"edges":[]}, sys.stdout)'
}

section() { printf '\n%s\n' "$1"; }

install_fake_gh

# --- 1. no token ---
section "1. no token"
T="$WORKDIR/t1"
mkdir -p "$T"
(
  export GITHUB_REPOSITORY="praetorian-inc/fixture"
  unset GH_TOKEN GITHUB_TOKEN || true
  export DEST="$T/graphify-out"
  export GITHUB_OUTPUT="$T/github_output"
  : > "$GITHUB_OUTPUT"
  bash "$SCRIPT"
  echo "$?" > "$T/rc"
)
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" present)" = "false" ] \
  && [ "$(read_out "$T/github_output" skip_reason)" = "no-token" ] \
  && ok "no-token skips, exit 0" \
  || bad "no-token" "present=$(read_out "$T/github_output" present) skip=$(read_out "$T/github_output" skip_reason) rc=$(cat "$T/rc")"

# --- 2. no successful run ---
section "2. no successful run"
T="$WORKDIR/t2"
mkdir -p "$T/fix"
echo -n "main" > "$T/fix/default_branch"
: > "$T/fix/run_list"   # empty -> no-run
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" present)" = "false" ] \
  && [ "$(read_out "$T/github_output" skip_reason)" = "no-run" ] \
  && ok "no-run skips, exit 0" \
  || bad "no-run" "skip=$(read_out "$T/github_output" skip_reason) rc=$(cat "$T/rc") log=$(cat "$T/log")"

# --- 3. happy path: one artifact ---
section "3. happy path"
T="$WORKDIR/t3"
mkdir -p "$T/fix/download"
echo -n "main" > "$T/fix/default_branch"
printf '%s' '{"databaseId":42,"headSha":"abc123abc123abc123abc123abc123abc123abc1","headBranch":"main","url":"https://github.com/praetorian-inc/fixture/actions/runs/42","updatedAt":"2026-09-05T00:00:00Z"}' > "$T/fix/run_list"
printf '%s\n' "fixture-graph" > "$T/fix/artifacts"
valid_graph > "$T/fix/download/graph.json"
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] \
  && [ "$(read_out "$T/github_output" present)" = "true" ] \
  && [ "$(read_out "$T/github_output" skip_reason)" = "" ] \
  && [ "$(read_out "$T/github_output" run_id)" = "42" ] \
  && [ "$(read_out "$T/github_output" head_sha)" = "abc123abc123abc123abc123abc123abc123abc1" ] \
  && [ -s "$T/graphify-out/graph.json" ] \
  && [ -s "$T/graphify-out/.graphify-provenance.json" ] \
  && python3 -I -c 'import json,sys; p=json.load(open(sys.argv[1],encoding="utf-8")); assert p["headSha"]=="abc123abc123abc123abc123abc123abc123abc1" and p["workflowRunId"]==42 and p["repo"]=="praetorian-inc/fixture"' "$T/graphify-out/.graphify-provenance.json" \
  && ok "happy path installs graph + provenance" \
  || bad "happy path" "present=$(read_out "$T/github_output" present) skip=$(read_out "$T/github_output" skip_reason) rc=$(cat "$T/rc") err=$(cat "$T/err") log=$(cat "$T/log")"

# --- 4. two artifacts, one -graph ---
section "4. pick *-graph among several artifacts"
T="$WORKDIR/t4"
mkdir -p "$T/fix/download"
echo -n "main" > "$T/fix/default_branch"
printf '%s' '{"databaseId":7,"headSha":"ddd","headBranch":"main","url":"u","updatedAt":"t"}' > "$T/fix/run_list"
printf '%s\n' "other" "fixture-graph" > "$T/fix/artifacts"
valid_graph > "$T/fix/download/graph.json"
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" present)" = "true" ] \
  && ok "picks the -graph artifact" \
  || bad "pick -graph" "present=$(read_out "$T/github_output" present) skip=$(read_out "$T/github_output" skip_reason)"

# --- 5. two artifacts, neither -graph ---
section "5. ambiguous artifacts"
T="$WORKDIR/t5"
mkdir -p "$T/fix"
echo -n "main" > "$T/fix/default_branch"
printf '%s' '{"databaseId":7,"headSha":"ddd","headBranch":"main","url":"u","updatedAt":"t"}' > "$T/fix/run_list"
printf '%s\n' "one" "two" > "$T/fix/artifacts"
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" present)" = "false" ] \
  && [ "$(read_out "$T/github_output" skip_reason)" = "ambiguous-artifact" ] \
  && ok "ambiguous-artifact skips" \
  || bad "ambiguous" "skip=$(read_out "$T/github_output" skip_reason)"

# --- 6. download fails ---
section "6. download fails"
T="$WORKDIR/t6"
mkdir -p "$T/fix"
echo -n "main" > "$T/fix/default_branch"
printf '%s' '{"databaseId":7,"headSha":"ddd","headBranch":"main","url":"u","updatedAt":"t"}' > "$T/fix/run_list"
printf '%s\n' "fixture-graph" > "$T/fix/artifacts"
touch "$T/fix/download.fail"
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" skip_reason)" = "download-failed" ] \
  && [ ! -f "$T/graphify-out/graph.json" ] \
  && ok "download-failed skips, no graph" \
  || bad "download-failed" "skip=$(read_out "$T/github_output" skip_reason) rc=$(cat "$T/rc")"

# --- 7. invalid graph.json ---
section "7. invalid graph.json"
T="$WORKDIR/t7"
mkdir -p "$T/fix/download"
echo -n "main" > "$T/fix/default_branch"
printf '%s' '{"databaseId":7,"headSha":"ddd","headBranch":"main","url":"u","updatedAt":"t"}' > "$T/fix/run_list"
printf '%s\n' "fixture-graph" > "$T/fix/artifacts"
echo "not json" > "$T/fix/download/graph.json"
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" skip_reason)" = "invalid-graph" ] \
  && ok "invalid-graph skips" \
  || bad "invalid-graph" "skip=$(read_out "$T/github_output" skip_reason)"

# --- 8. empty nodes list ---
section "8. empty nodes list"
T="$WORKDIR/t8"
mkdir -p "$T/fix/download"
echo -n "main" > "$T/fix/default_branch"
printf '%s' '{"databaseId":7,"headSha":"ddd","headBranch":"main","url":"u","updatedAt":"t"}' > "$T/fix/run_list"
printf '%s\n' "fixture-graph" > "$T/fix/artifacts"
python3 -I -c 'import json,sys; json.dump({"nodes":[],"edges":[]}, sys.stdout)' > "$T/fix/download/graph.json"
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" skip_reason)" = "invalid-graph" ] \
  && ok "empty nodes is invalid-graph" \
  || bad "empty nodes" "skip=$(read_out "$T/github_output" skip_reason)"

# --- 9. nested graphify-out/graph.json in the download ---
section "9. nested download path"
T="$WORKDIR/t9"
mkdir -p "$T/fix/download/graphify-out"
echo -n "main" > "$T/fix/default_branch"
printf '%s' '{"databaseId":9,"headSha":"eee","headBranch":"main","url":"u","updatedAt":"t"}' > "$T/fix/run_list"
printf '%s\n' "fixture-graph" > "$T/fix/artifacts"
valid_graph > "$T/fix/download/graphify-out/graph.json"
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" present)" = "true" ] \
  && [ -s "$T/graphify-out/graph.json" ] \
  && ok "finds nested graph.json" \
  || bad "nested" "present=$(read_out "$T/github_output" present) skip=$(read_out "$T/github_output" skip_reason)"

# --- 10. default-branch API failure ---
section "10. default-branch API failure"
T="$WORKDIR/t10"
mkdir -p "$T/fix"
touch "$T/fix/default_branch.fail"
export GH_FIXTURE="$T/fix"
run_script "$T" >"$T/log" 2>"$T/err"
echo "$?" > "$T/rc"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" skip_reason)" = "no-default-branch" ] \
  && ok "no-default-branch skips" \
  || bad "no-default-branch" "skip=$(read_out "$T/github_output" skip_reason) rc=$(cat "$T/rc")"

# --- 11. symlink DEST refused ---
section "11. symlink DEST refused"
T="$WORKDIR/t11"
mkdir -p "$T/fix/download" "$T/elsewhere"
echo -n "main" > "$T/fix/default_branch"
printf '%s' '{"databaseId":1,"headSha":"fff","headBranch":"main","url":"u","updatedAt":"t"}' > "$T/fix/run_list"
printf '%s\n' "fixture-graph" > "$T/fix/artifacts"
valid_graph > "$T/fix/download/graph.json"
ln -s "$T/elsewhere" "$T/graphify-out"
export GH_FIXTURE="$T/fix"
(
  export GITHUB_REPOSITORY="praetorian-inc/fixture"
  export GH_TOKEN="fake-token"
  export DEST="$T/graphify-out"
  export GITHUB_OUTPUT="$T/github_output"
  : > "$GITHUB_OUTPUT"
  bash "$SCRIPT"
  echo "$?" > "$T/rc"
) >"$T/log" 2>"$T/err"
[ "$(cat "$T/rc")" = "0" ] && [ "$(read_out "$T/github_output" skip_reason)" = "dest-symlink" ] \
  && [ ! -f "$T/elsewhere/graph.json" ] \
  && ok "symlink DEST refused, no write-through" \
  || bad "dest-symlink" "skip=$(read_out "$T/github_output" skip_reason) rc=$(cat "$T/rc") log=$(cat "$T/log")"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
