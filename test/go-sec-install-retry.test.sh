#!/usr/bin/env bash
# Contract: the "Install gosec" and "Install govulncheck" steps of
# .github/workflows/go-sec.yml retry a transient `go install` failure up to
# three times with 10s/20s linear backoff, and NEVER mask a persistent failure
# or let a caller-controlled version string reach the shell or their own echoes.
# ENG-7830.
#
# The step bodies are EXTRACTED from the workflow at run time (never copied
# here) and executed under GitHub's exact `shell: bash` invocation,
# `bash --noprofile --norc -eo pipefail {0}`, with `go` and `sleep` stubbed on
# PATH. Hermetic: no network, no real `go`, no real sleeping.
#
# Override GO_SEC_WORKFLOW to point the suite at a different workflow file
# (used to prove the suite reddens against a mutated copy).

set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="${GO_SEC_WORKFLOW:-$REPO_ROOT/.github/workflows/go-sec.yml}"

if [ ! -f "$WF" ]; then
  echo "ERROR: missing $WF" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)" || { echo "ERROR: mktemp failed" >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

BINDIR="$WORKDIR/bin"
PWNDIR="$WORKDIR/pwn"
mkdir -p "$BINDIR" "$PWNDIR"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }
section() { printf '\n%s\n' "$1"; }

START_SECONDS=$SECONDS

# --- extraction ------------------------------------------------------------
# Pull one step block out of the workflow: from its `- name:` line up to the
# next line indented at or above the sequence-item level.
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
    {
      if ($0 ~ /^ *$/) { print; next }
      if (ind($0) <= si) { exit }
      print
    }
  ' "$WF"
}

# Pull the `run: |` literal block scalar out of a step block and dedent it the
# way YAML does (strip the block's own indentation).
run_body() {
  step_block "$1" | awk '
    function ind(s) { match(s, /^ */); return RLENGTH }
    !started { if ($0 ~ /^ *run: *\|/) { started = 1; ri = ind($0) } next }
    {
      if ($0 ~ /^ *$/) { buf[n++] = ""; next }
      if (ind($0) <= ri) { exit }
      buf[n++] = $0
      k = ind($0)
      if (!haveb || k < b) { b = k; haveb = 1 }
    }
    END { for (i = 0; i < n; i++) print substr(buf[i], b + 1) }
  '
}

# --- stubs -----------------------------------------------------------------
# `go`: records every invocation's argv verbatim (one file per argument, so a
# value containing spaces or newlines survives round-tripping) and fails for
# the first $GO_STUB_FAIL_UNTIL invocations. Diagnostics go to a log FILE, not
# to stdout/stderr, so the captured step output is the step's own emissions
# only -- that is what the annotation-injection case asserts on.
cat > "$BINDIR/go" <<'GOSTUB'
#!/usr/bin/env bash
set -u
d="${GO_STUB_DIR:?}"
n=0
[ -f "$d/count" ] && n="$(cat "$d/count")"
n=$((n + 1))
printf '%s' "$n" > "$d/count"
inv="$d/inv-$n"
mkdir -p "$inv"
printf '%s' "$#" > "$inv/argc"
i=1
for a in "$@"; do
  printf '%s' "$a" > "$inv/arg-$i"
  i=$((i + 1))
done
if [ "$n" -le "${GO_STUB_FAIL_UNTIL:-0}" ]; then
  printf 'stub go: simulated failure on invocation %s\n' "$n" >> "${GO_STUB_LOG:?}"
  exit 1
fi
printf 'stub go: simulated success on invocation %s\n' "$n" >> "${GO_STUB_LOG:?}"
exit 0
GOSTUB
chmod +x "$BINDIR/go"

# `sleep`: records the requested duration and returns immediately.
cat > "$BINDIR/sleep" <<'SLEEPSTUB'
#!/usr/bin/env bash
set -u
printf '%s\n' "${1-}" >> "${SLEEP_STUB_LOG:?}"
exit 0
SLEEPSTUB
chmod +x "$BINDIR/sleep"

# --- runner ----------------------------------------------------------------
# run_step <script> <version-var> <version-value> <fail-until> <case-dir>
# Sets LAST_RC; leaves <case-dir>/{out,sleeps,golog,go/inv-N/...} behind.
LAST_RC=0
run_step() {
  local script=$1 varname=$2 value=$3 fail_until=$4 dir=$5
  mkdir -p "$dir/go"
  : > "$dir/sleeps"
  : > "$dir/golog"
  (
    cd "$dir" || exit 99
    env -i \
      PATH="$BINDIR:$PATH" \
      HOME="$dir" \
      TMPDIR="$PWNDIR" \
      GO_STUB_DIR="$dir/go" \
      GO_STUB_LOG="$dir/golog" \
      GO_STUB_FAIL_UNTIL="$fail_until" \
      SLEEP_STUB_LOG="$dir/sleeps" \
      "$varname=$value" \
      bash --noprofile --norc -eo pipefail "$script"
  ) > "$dir/out" 2>&1
  LAST_RC=$?
}

go_calls() { if [ -f "$1/go/count" ]; then cat "$1/go/count"; else printf '0'; fi; }
slept()    { tr '\n' ',' < "$1/sleeps"; }
pwn_files() { find "$PWNDIR" -type f 2>/dev/null | wc -l | tr -d ' '; }

# --- per-step suite --------------------------------------------------------
# test_step <step name> <version env var> <module path>
test_step() {
  local step=$1 var=$2 module=$3
  local slug script d rc n argc arg1 arg2 hostile i

  slug="$(printf '%s' "$step" | tr -c 'A-Za-z0-9' '-')"
  script="$WORKDIR/$slug.sh"

  section "=== $step ==="

  # 0. extraction guard -- a renamed step or a restructured `run:` must fail
  #    loudly here, not silently turn every case below into a no-op.
  if ! step_block "$step" | grep -q .; then
    echo "ERROR: step '$step' not found in $WF" >&2
    exit 1
  fi
  run_body "$step" > "$script"
  if [ ! -s "$script" ]; then
    echo "ERROR: could not extract the 'run:' body of step '$step' from $WF" >&2
    exit 1
  fi
  if ! grep -q 'go install' "$script"; then
    echo "ERROR: extracted 'run:' body of step '$step' has no 'go install'" >&2
    exit 1
  fi
  ok "extraction: '$step' run: body recovered from the workflow ($(wc -l < "$script" | tr -d ' ') lines)"

  if step_block "$step" | grep -Eq '^ *shell: *bash *$'; then
    ok "step declares 'shell: bash' (so 'bash --noprofile --norc -eo pipefail' is the real invocation)"
  else
    bad "step declares 'shell: bash'" "not found; the tested invocation would not match GitHub's"
  fi

  # The harness injects $var itself, so nothing below can see a renamed or
  # typo'd env: key. Assert the mapping against the workflow, not the script:
  # GitHub's `shell: bash` is `-eo pipefail` with NO -u, so an unmapped key
  # expands EMPTY, `go install "<module>@"` fails, and the loop burns all three
  # attempts plus 30s of backoff before an error naming an empty version.
  if step_block "$step" | grep -Eq "^ *${var}: *\\\$\{\{ *inputs\.[a-z-]+ *\}\} *$"; then
    ok "env: workflow maps \$$var from a workflow_call input"
  else
    bad "env: workflow maps \$$var from a workflow_call input" \
        "no '$var: \${{ inputs.<name> }}' line in the step block -- \$$var would expand empty"
  fi

  if grep -q "$var" "$script"; then
    ok "run: body reads the \$$var env input"
  else
    bad "run: body reads the \$$var env input" "no reference to $var in the extracted body"
  fi

  # 1. success on the first attempt
  d="$WORKDIR/$slug-c1"; run_step "$script" "$var" "v1.2.3" 0 "$d"; rc=$LAST_RC
  [ "$rc" -eq 0 ] && ok "1. first-attempt success exits 0" \
    || bad "1. first-attempt success exits 0" "got rc=$rc"
  n="$(go_calls "$d")"
  [ "$n" -eq 1 ] && ok "1. go invoked exactly once" \
    || bad "1. go invoked exactly once" "got $n invocation(s)"
  [ -z "$(slept "$d")" ] && ok "1. no sleep on the happy path" \
    || bad "1. no sleep on the happy path" "slept: $(slept "$d")"
  argc="$(cat "$d/go/inv-1/argc")"
  arg1="$(cat "$d/go/inv-1/arg-1")"
  arg2="$(cat "$d/go/inv-1/arg-2" 2>/dev/null || printf 'MISSING')"
  [ "$argc" = "2" ] && ok "1. go received exactly 2 arguments" \
    || bad "1. go received exactly 2 arguments" "argc=$argc"
  [ "$arg1" = "install" ] && ok "1. argv[1] is 'install'" \
    || bad "1. argv[1] is 'install'" "argv[1]=$arg1"
  [ "$arg2" = "$module@v1.2.3" ] && ok "1. argv[2] is '$module@v1.2.3'" \
    || bad "1. argv[2] is '$module@v1.2.3'" "argv[2]=$arg2"

  # 2. two transient failures then success
  d="$WORKDIR/$slug-c2"; run_step "$script" "$var" "v1.2.3" 2 "$d"; rc=$LAST_RC
  [ "$rc" -eq 0 ] && ok "2. fail,fail,succeed exits 0" \
    || bad "2. fail,fail,succeed exits 0" "got rc=$rc"
  n="$(go_calls "$d")"
  [ "$n" -eq 3 ] && ok "2. go invoked exactly 3 times" \
    || bad "2. go invoked exactly 3 times" "got $n invocation(s)"
  [ "$(slept "$d")" = "10,20," ] && ok "2. backoff is 10s then 20s" \
    || bad "2. backoff is 10s then 20s" "slept: $(slept "$d")"
  grep -q '^::warning::' "$d/out" \
    && ok "2. retries are announced as ::warning:: (not ::error::)" \
    || bad "2. retries are announced as ::warning::" "output: $(tr '\n' '|' < "$d/out")"
  grep -q '^::error::' "$d/out" \
    && bad "2. no ::error:: on an eventually-successful install" "output: $(tr '\n' '|' < "$d/out")" \
    || ok "2. no ::error:: on an eventually-successful install"

  # 3. persistent failure: bounded at 3 attempts, no trailing sleep
  d="$WORKDIR/$slug-c3"; run_step "$script" "$var" "v1.2.3" 99 "$d"; rc=$LAST_RC
  n="$(go_calls "$d")"
  [ "$n" -eq 3 ] && ok "3. go invoked exactly 3 times, never a 4th" \
    || bad "3. go invoked exactly 3 times, never a 4th" "got $n invocation(s)"
  [ "$(slept "$d")" = "10,20," ] \
    && ok "3. slept 10 then 20 and NOT after the final attempt (2 sleeps, not 3)" \
    || bad "3. slept 10 then 20 with no sleep after the final attempt" "slept: $(slept "$d")"
  grep -q '^::error::' "$d/out" && ok "3. emits a final ::error:: annotation" \
    || bad "3. emits a final ::error:: annotation" "output: $(tr '\n' '|' < "$d/out")"

  # 4. ANTI-MASKING GUARANTEE. This is the reason the whole file exists: a
  #    retry loop that swallowed the final failure would turn a security tool
  #    that never installed into a green security gate across 49+ consumers.
  #    A persistent install failure MUST leave the step non-zero.
  [ "$rc" -ne 0 ] \
    && ok "4. ANTI-MASKING: persistent install failure exits non-zero (rc=$rc)" \
    || bad "4. ANTI-MASKING: persistent install failure exits non-zero" \
           "rc=0 -- the retry loop is masking a failed install as a green step"
  [ "$rc" -eq 1 ] && ok "4. persistent failure exits 1" \
    || bad "4. persistent failure exits 1" "got rc=$rc"

  # 5. the version input reaches `go install` as ONE literal argument: no word
  #    splitting, no globbing, no command substitution, no command separation.
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
    argc="$(cat "$d/go/inv-1/argc" 2>/dev/null || printf 'MISSING')"
    arg2="$(cat "$d/go/inv-1/arg-2" 2>/dev/null || printf 'MISSING')"
    [ "$argc" = "2" ] \
      && ok "5.$i hostile version stays one argument (argc=2): [$hostile]" \
      || bad "5.$i hostile version stays one argument: [$hostile]" "argc=$argc"
    [ "$arg2" = "$module@$hostile" ] \
      && ok "5.$i argv[2] is the literal '$module@<version>': [$hostile]" \
      || bad "5.$i argv[2] is the literal '$module@<version>': [$hostile]" "argv[2]=[$arg2]"
    [ "$(pwn_files)" = "0" ] \
      && ok "5.$i no marker file created -- version never reached the shell: [$hostile]" \
      || bad "5.$i no marker file created: [$hostile]" "created: $(find "$PWNDIR" -type f)"
  done

  # 6. the step's OWN echo statements emit no caller-controlled text: a version
  #    carrying a newline + a forged workflow command must not be interpolated
  #    into an annotation the step writes. Scope is the step's echoes only --
  #    a real `go` echoes the rejected version back in its own error output, and
  #    GitHub parses ::commands:: out of the combined stream whatever wrote
  #    them, so a newline-bearing version still forges an annotation there.
  #    Accepted LOW (the caller owns its own run log); the stub writes to
  #    $GO_STUB_LOG, not stdout, so this suite cannot exercise that path.
  d="$WORKDIR/$slug-c6"
  run_step "$script" "$var" "v1.0.0
::error::FORGED" 99 "$d"
  grep -q 'FORGED' "$d/out" \
    && bad "6. the step's own echoes emit no caller-controlled text" \
           "forged command appeared in output: $(tr '\n' '|' < "$d/out")" \
    || ok "6. the step's own echoes emit no caller-controlled text (::error::FORGED not echoed)"
  grep -q 'v1\.0\.0' "$d/out" \
    && bad "6. the step's own annotations do not interpolate the version string" \
           "output: $(tr '\n' '|' < "$d/out")" \
    || ok "6. the step's own annotations do not interpolate the version string"
  [ "$LAST_RC" -ne 0 ] \
    && ok "6. injection attempt still fails the step (rc=$LAST_RC)" \
    || bad "6. injection attempt still fails the step" "rc=0"
}

echo "go-sec-install-retry.test.sh"
echo "  workflow: $WF"

test_step "Install gosec"       GOSEC_VERSION       "github.com/securego/gosec/v2/cmd/gosec"
test_step "Install govulncheck" GOVULNCHECK_VERSION "golang.org/x/vuln/cmd/govulncheck"

# Hermeticity: the stubs must have absorbed every backoff. Real sleeps would
# put this suite in the minutes.
section "=== hermeticity ==="
ELAPSED=$((SECONDS - START_SECONDS))
[ "$ELAPSED" -lt 30 ] \
  && ok "whole suite ran in ${ELAPSED}s -- no real sleeping, no network" \
  || bad "whole suite ran in ${ELAPSED}s" "expected < 30s; a real sleep or network call leaked in"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
