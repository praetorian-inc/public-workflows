#!/usr/bin/env bash
# Extracted-shell contract for go-sec.yml install retries (ENG-7830).
# 3 attempts, 10s/20s backoff; persistent failure must not be masked.
# Bodies are parsed out of the workflow and run under GitHub's
# `bash --noprofile --norc -eo pipefail`. Hermetic: stubbed go/sleep, no network.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="${GO_SEC_WORKFLOW:-$REPO_ROOT/.github/workflows/go-sec.yml}"
[ -f "$WF" ] || { echo "ERROR: missing $WF" >&2; exit 1; }

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT
BINDIR="$WORKDIR/bin"
PWNDIR="$WORKDIR/pwn"
mkdir -p "$BINDIR" "$PWNDIR"

PASS=0 FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }
eq()  { [ "$1" = "$2" ] && ok "$3" || bad "$3" "got [$1] want [$2]"; }

# Pull a named step (from `- name:` to the next sibling) out of the workflow.
step_block() {
  awk -v want="$1" '
    function ind(s) { match(s, /^ */); return RLENGTH }
    !inside {
      if ($0 ~ /^ *- name: /) {
        nm = $0; sub(/^ *- name: /, "", nm)
        if (nm == want) { inside = 1; si = ind($0); print }
      }
      next
    }
    { if ($0 ~ /^ *$/) { print; next } if (ind($0) <= si) exit; print }
  ' "$WF"
}

# Dedent the `run: |` block scalar the way YAML does.
run_body() {
  step_block "$1" | awk '
    function ind(s) { match(s, /^ */); return RLENGTH }
    !started { if ($0 ~ /^ *run: *\|/) { started = 1; ri = ind($0) } next }
    {
      if ($0 ~ /^ *$/) { buf[n++] = ""; next }
      if (ind($0) <= ri) exit
      buf[n++] = $0
      k = ind($0); if (!haveb || k < b) { b = k; haveb = 1 }
    }
    END { for (i = 0; i < n; i++) print substr(buf[i], b + 1) }
  '
}

cat > "$BINDIR/go" <<'GOSTUB'
#!/usr/bin/env bash
set -u
d="${GO_STUB_DIR:?}"
n=0; [ -f "$d/count" ] && n=$(cat "$d/count")
n=$((n + 1)); printf '%s' "$n" > "$d/count"
inv="$d/inv-$n"; mkdir -p "$inv"
printf '%s' "$#" > "$inv/argc"
i=1; for a in "$@"; do printf '%s' "$a" > "$inv/arg-$i"; i=$((i + 1)); done
if [ "$n" -le "${GO_STUB_FAIL_UNTIL:-0}" ]; then
  echo "stub go: fail $n" >> "${GO_STUB_LOG:?}"; exit 1
fi
echo "stub go: ok $n" >> "${GO_STUB_LOG:?}"; exit 0
GOSTUB
cat > "$BINDIR/sleep" <<'SLEEPSTUB'
#!/usr/bin/env bash
set -u
printf '%s\n' "${1-}" >> "${SLEEP_STUB_LOG:?}"
SLEEPSTUB
chmod +x "$BINDIR/go" "$BINDIR/sleep"

LAST_RC=0
run_step() {
  local script=$1 varname=$2 value=$3 fail_until=$4 dir=$5
  mkdir -p "$dir/go"; : > "$dir/sleeps"; : > "$dir/golog"
  (
    cd "$dir" || exit 99
    env -i PATH="$BINDIR:$PATH" HOME="$dir" TMPDIR="$PWNDIR" \
      GO_STUB_DIR="$dir/go" GO_STUB_LOG="$dir/golog" \
      GO_STUB_FAIL_UNTIL="$fail_until" SLEEP_STUB_LOG="$dir/sleeps" \
      "$varname=$value" \
      bash --noprofile --norc -eo pipefail "$script"
  ) > "$dir/out" 2>&1
  LAST_RC=$?
}

go_n() { [ -f "$1/go/count" ] && cat "$1/go/count" || printf 0; }
slept() { tr '\n' ',' < "$1/sleeps"; }

test_step() {
  local step=$1 var=$2 module=$3 slug script d i hostile argc arg2
  slug=${step// /-}
  script="$WORKDIR/$slug.sh"

  printf '\n=== %s ===\n' "$step"

  step_block "$step" | grep -q . || { echo "ERROR: step '$step' not found in $WF" >&2; exit 1; }
  run_body "$step" > "$script"
  [ -s "$script" ] || { echo "ERROR: empty run: body for '$step'" >&2; exit 1; }
  grep -q 'go install' "$script" || { echo "ERROR: no go install in '$step'" >&2; exit 1; }
  ok "extracted '$step' ($(wc -l < "$script" | tr -d ' ') lines)"

  step_block "$step" | grep -Eq '^ *shell: *bash *$' \
    && ok "shell: bash" || bad "shell: bash" "missing; tested invocation would not match GitHub's"

  # Harness injects $var itself, so a typo'd env: key is invisible below.
  # GitHub's shell: bash has no -u: an unmapped key expands empty.
  if step_block "$step" | grep -Eq "^ *${var}: *\\\$\{\{ *inputs\.[a-z-]+ *\}\} *$"; then
    ok "env: maps \$$var from a workflow_call input"
  else
    bad "env: maps \$$var from a workflow_call input" "no '$var: \${{ inputs.<name> }}' in the step"
  fi
  grep -q "$var" "$script" && ok "run: reads \$$var" || bad "run: reads \$$var" "missing"

  d="$WORKDIR/$slug-c1"; run_step "$script" "$var" "v1.2.3" 0 "$d"
  eq "$LAST_RC" "0" "1. first-attempt success exits 0"
  eq "$(go_n "$d")" "1" "1. go invoked once"
  eq "$(slept "$d")" "" "1. no sleep"
  eq "$(cat "$d/go/inv-1/argc")" "2" "1. argc=2"
  eq "$(cat "$d/go/inv-1/arg-1")" "install" "1. argv[1]=install"
  eq "$(cat "$d/go/inv-1/arg-2")" "$module@v1.2.3" "1. argv[2]=$module@v1.2.3"

  d="$WORKDIR/$slug-c2"; run_step "$script" "$var" "v1.2.3" 2 "$d"
  eq "$LAST_RC" "0" "2. fail,fail,succeed exits 0"
  eq "$(go_n "$d")" "3" "2. go invoked 3 times"
  eq "$(slept "$d")" "10,20," "2. backoff 10s then 20s"
  grep -q '^::warning::' "$d/out" && ok "2. retries as ::warning::" \
    || bad "2. retries as ::warning::" "$(tr '\n' '|' < "$d/out")"
  grep -q '^::error::' "$d/out" && bad "2. no ::error:: on success" "$(tr '\n' '|' < "$d/out")" \
    || ok "2. no ::error:: on success"

  d="$WORKDIR/$slug-c3"; run_step "$script" "$var" "v1.2.3" 99 "$d"
  eq "$(go_n "$d")" "3" "3. go invoked 3 times, never a 4th"
  eq "$(slept "$d")" "10,20," "3. no sleep after final attempt"
  grep -q '^::error::' "$d/out" && ok "3. final ::error::" \
    || bad "3. final ::error::" "$(tr '\n' '|' < "$d/out")"
  [ "$LAST_RC" -ne 0 ] && ok "4. ANTI-MASKING: persistent failure exits non-zero (rc=$LAST_RC)" \
    || bad "4. ANTI-MASKING: persistent failure exits non-zero" "rc=0 — retry is masking a failed install"
  eq "$LAST_RC" "1" "4. persistent failure exits 1"

  i=0
  for hostile in \
    "v1; touch $PWNDIR/PWNED_SEMI" \
    "v1 \$(touch $PWNDIR/PWNED_CMDSUB)" \
    "v1 \`touch $PWNDIR/PWNED_BACKTICK\`" \
    'v1; touch $TMPDIR/PWNED_TMPDIR' \
    '*' \
    'v1 with space'
  do
    i=$((i + 1))
    d="$WORKDIR/$slug-c5-$i"; run_step "$script" "$var" "$hostile" 0 "$d"
    argc=$(cat "$d/go/inv-1/argc" 2>/dev/null || echo MISSING)
    arg2=$(cat "$d/go/inv-1/arg-2" 2>/dev/null || echo MISSING)
    eq "$argc" "2" "5.$i argc=2: [$hostile]"
    eq "$arg2" "$module@$hostile" "5.$i argv[2] literal: [$hostile]"
    eq "$(find "$PWNDIR" -type f 2>/dev/null | wc -l | tr -d ' ')" "0" "5.$i no marker file: [$hostile]"
  done

  # Step echoes must not interpolate a newline-bearing version into annotations.
  # Scope is the step's own echo — a real `go` may echo the version back.
  d="$WORKDIR/$slug-c6"
  run_step "$script" "$var" $'v1.0.0\n::error::FORGED' 99 "$d"
  grep -q 'FORGED' "$d/out" && bad "6. no caller text in step echoes" "$(tr '\n' '|' < "$d/out")" \
    || ok "6. no caller text in step echoes"
  grep -q 'v1\.0\.0' "$d/out" && bad "6. version not interpolated into annotations" "$(tr '\n' '|' < "$d/out")" \
    || ok "6. version not interpolated into annotations"
  [ "$LAST_RC" -ne 0 ] && ok "6. injection attempt still fails the step" \
    || bad "6. injection attempt still fails the step" "rc=0"
}

echo "go-sec-install-retry.test.sh"
echo "  workflow: $WF"
START=$SECONDS
test_step "Install gosec"       GOSEC_VERSION       "github.com/securego/gosec/v2/cmd/gosec"
test_step "Install govulncheck" GOVULNCHECK_VERSION "golang.org/x/vuln/cmd/govulncheck"
ELAPSED=$((SECONDS - START))
printf '\n=== hermeticity ===\n'
[ "$ELAPSED" -lt 30 ] && ok "suite ran in ${ELAPSED}s (no real sleep/network)" \
  || bad "suite ran in ${ELAPSED}s" "expected < 30s"
echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
