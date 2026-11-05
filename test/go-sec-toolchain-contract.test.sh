#!/usr/bin/env bash
#
# Contract tests for caller-selected Go toolchains in go-sec.yml.
#
# The validation and reporting scripts under test are extracted from the real
# workflow YAML and executed against temporary fixtures. This test does not
# mirror their production logic.
#
# Usage: bash test/go-sec-toolchain-contract.test.sh
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORKFLOW="$REPO_ROOT/.github/workflows/go-sec.yml"
TEST_WORKFLOW="$REPO_ROOT/.github/workflows/test-go-sec.yml"
WORKDIR="$(mktemp -d)" || { printf 'ERROR: mktemp failed\n' >&2; exit 1; }
trap 'rm -rf -- "$WORKDIR"' EXIT

EXTRACT="$WORKDIR/extracted"
mkdir -p "$EXTRACT"

PASS=0
FAIL=0

ok() {
  printf '  \033[32mPASS\033[0m  %s\n' "$1"
  PASS=$((PASS + 1))
}

bad() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  printf '          expected: [%s]\n' "$2"
  printf '          actual:   [%s]\n' "$3"
  FAIL=$((FAIL + 1))
}

assert_eq() {
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    bad "$1" "$2" "$3"
  fi
}

assert_contains() {
  if grep -Fq -- "$2" "$3"; then
    ok "$1"
  else
    bad "$1" "log containing: $2" "$(cat "$3")"
  fi
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

section "Workflow contract and run-block extraction"
if python3 - "$WORKFLOW" "$TEST_WORKFLOW" "$EXTRACT" <<'PY'
import pathlib
import re
import sys

import yaml

workflow_path = pathlib.Path(sys.argv[1])
test_workflow_path = pathlib.Path(sys.argv[2])
out = pathlib.Path(sys.argv[3])
workflow_text = workflow_path.read_text()
workflow = yaml.safe_load(workflow_text)
test_workflow = yaml.safe_load(test_workflow_path.read_text())


def require(condition, message):
    if not condition:
        raise SystemExit("CONTRACT FAIL: " + message)


def triggers(document):
    # YAML 1.1 resolves the bare key `on` to the boolean True.
    return document[True] if True in document else document["on"]


on = triggers(workflow)
inputs = on["workflow_call"]["inputs"]
require("go-version-file" in inputs, "workflow_call input go-version-file is missing")
go_version_file = inputs["go-version-file"]
require(go_version_file.get("type") == "string", "go-version-file type must be string")
require(go_version_file.get("default") == "go.mod", "go-version-file default must be go.mod")
require(
    "relative to working-directory" in go_version_file.get("description", "").lower(),
    "go-version-file description must say it is relative to working-directory",
)

composed_path = "${{ format('{0}/{1}', inputs.working-directory, inputs.go-version-file) }}"
validation_jobs = []
for job_name, job in workflow["jobs"].items():
    if any(step.get("id") == "validate-go-version-file" for step in job.get("steps", [])):
        validation_jobs.append(job_name)
require(validation_jobs == ["preflight"], "validation must exist once, in preflight")

preflight_steps = workflow["jobs"]["preflight"]["steps"]
preflight_by_id = {step.get("id"): step for step in preflight_steps if step.get("id")}
validation = preflight_by_id["validate-go-version-file"]
preflight_ids = [step.get("id") for step in preflight_steps]
gosrc_index = preflight_ids.index("gosrc")
validation_index = preflight_ids.index("validate-go-version-file")
checkout_indexes = [
    index
    for index, step in enumerate(preflight_steps)
    if str(step.get("uses", "")).startswith("actions/checkout@")
]
require(
    len(checkout_indexes) == 1
    and gosrc_index < checkout_indexes[0] < validation_index
    and re.fullmatch(r"actions/checkout@[0-9a-f]{40}", preflight_steps[checkout_indexes[0]]["uses"]),
    "one pinned preflight checkout must run between Go source detection and validation",
)
require(
    gosrc_index < validation_index,
    "preflight validation must run after Go source detection",
)
require(
    validation.get("if")
    == "${{ steps.gosrc.outputs.has_go_sources == 'true' && (inputs.enable-gosec || inputs.enable-govulncheck) }}",
    "preflight validation conditional is not exact",
)
require(validation.get("shell") == "bash", "preflight validation step must use Bash")
require(
    validation.get("env", {}).get("GO_VERSION_FILE") == composed_path,
    "preflight validation GO_VERSION_FILE wiring is not exact",
)
require("${{" not in validation["run"], "preflight validation run body interpolates an expression")

report_steps = []
report_runs = []
for job_name in ("gosec", "govulncheck"):
    steps = workflow["jobs"][job_name]["steps"]
    by_id = {step.get("id"): step for step in steps if step.get("id")}
    for step_id in ("setup-go", "report-go-version"):
        require(step_id in by_id, f"{job_name} is missing step id={step_id}")

    setup = by_id["setup-go"]
    report = by_id["report-go-version"]
    ids = [step.get("id") for step in steps]
    require(
        ids.index("setup-go") + 1 == ids.index("report-go-version"),
        f"{job_name} setup and report steps must be adjacent and ordered",
    )
    require(report.get("shell") == "bash", f"{job_name} report step must use Bash")
    require(
        setup.get("with", {}).get("go-version-file") == composed_path,
        f"{job_name} setup-go go-version-file wiring is not exact",
    )
    require(
        setup.get("with", {}).get("cache") is False,
        f"{job_name} setup-go cache must remain false",
    )
    require(
        "go-version" not in setup.get("with", {}),
        f"{job_name} setup-go must not configure go-version",
    )
    require(
        report.get("env", {}).get("SETUP_GO_VERSION")
        == "${{ steps.setup-go.outputs.go-version }}",
        f"{job_name} report step must consume setup-go's go-version output through env",
    )
    require("${{" not in report["run"], f"{job_name} report run body interpolates an expression")
    report_steps.append(report)
    report_runs.append(report["run"])

require(report_steps[0] == report_steps[1], "gosec and govulncheck report blocks differ")
require(
    re.search(r"go-version\s*:\s*[\"']?stable(?:[\"']|\s|$)", workflow_text) is None,
    "go-version: stable remains in the workflow",
)

test_on = triggers(test_workflow)
relevant_paths = [
    ".github/workflows/go-sec.yml",
    ".github/workflows/test-go-sec.yml",
    "test/go-sec-toolchain-contract.test.sh",
    "_test-fixtures/go-minimal/**",
]
require("push" in test_on, "test workflow is missing a branch push trigger")
require(
    test_on["push"].get("branches-ignore") == ["main"],
    "test workflow push trigger must exclude main",
)
require(
    test_on["push"].get("paths") == relevant_paths
    and test_on["pull_request"].get("paths") == relevant_paths,
    "push and pull_request triggers must use the same relevant paths",
)
require(
    "if" not in test_workflow["jobs"]["toolchain-contract"],
    "toolchain contract job must keep running on pull requests",
)
non_pr_condition = "${{ github.event_name != 'pull_request' }}"
for job_name in (
    "call-go-sec-defaults",
    "call-go-sec-gosec-only",
    "call-go-sec-govulncheck-only",
):
    require(
        test_workflow["jobs"][job_name].get("if") == non_pr_condition,
        f"{job_name} must be explicitly gated to non-pull_request events",
    )

(out / "validate.sh").write_text(validation["run"])
(out / "report.sh").write_text(report_runs[0])
print("  preflight validation, scanner reports, and harness triggers satisfy the static contract")
PY
then
  ok "static workflow contract"
else
  bad "static workflow contract" "caller toolchain contract" "workflow contract check failed"
  printf '\n──────────────────────────────────────────────\n'
  printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
  printf '──────────────────────────────────────────────\n'
  exit 1
fi

section "Extracted Bash syntax"
for script in validate.sh report.sh; do
  if bash -n "$EXTRACT/$script" 2>"$WORKDIR/$script.syntax"; then
    ok "bash -n $script"
  else
    bad "bash -n $script" "clean parse" "$(cat "$WORKDIR/$script.syntax")"
  fi
done

FIXTURE="$WORKDIR/fixture"
mkdir -p "$FIXTURE"
printf 'module example.invalid/root\n\ngo 1.23.0\n' > "$FIXTURE/go.mod"
mkdir -p "$FIXTURE/services/api"
printf 'module example.invalid/nested\n\ngo 1.22.0\n' > "$FIXTURE/services/api/go.mod"

LOG=""
RC=0
run_validation() {
  LOG="$WORKDIR/validation-$1.log"
  (
    cd "$FIXTURE" || exit 1
    GO_VERSION_FILE="$2" bash "$EXTRACT/validate.sh"
  ) >"$LOG" 2>&1
  RC=$?
}

section "Extracted validation behavior"
run_validation root "go.mod"
assert_eq "root module exits successfully" "0" "$RC"
assert_contains "root module logs configured source" "Configured Go version source: go.mod" "$LOG"

run_validation nested "services/api/go.mod"
assert_eq "nested module exits successfully" "0" "$RC"
assert_contains "nested module logs composed source" "Configured Go version source: services/api/go.mod" "$LOG"

run_validation missing "services/api/missing.mod"
if [ "$RC" -ne 0 ]; then
  ok "missing file fails before setup"
else
  bad "missing file fails before setup" "non-zero" "$RC"
fi
assert_contains "missing file emits a clear error" "Configured Go version file not found: services/api/missing.mod" "$LOG"

newline_path=$'services/api/version\nsource.mod'
printf 'module example.invalid/newline\n\ngo 1.21.0\n' > "$FIXTURE/$newline_path"
run_validation single-line "$newline_path"
assert_eq "configured-source log handles an untrusted newline path" "0" "$RC"
assert_eq "configured-source log remains one line" "1" "$(wc -l < "$LOG" | tr -d ' ')"
assert_contains "configured-source log shell-escapes the newline" "\\n" "$LOG"

section "Extracted resolved-version report behavior"
mkdir -p "$WORKDIR/bin"
cat > "$WORKDIR/bin/go" <<'GO_STUB'
#!/usr/bin/env bash
printf 'go version go1.23.4 linux/amd64\n'
GO_STUB
chmod +x "$WORKDIR/bin/go"
REPORT_LOG="$WORKDIR/report.log"
PATH="$WORKDIR/bin:$PATH" SETUP_GO_VERSION="1.23.4" \
  bash "$EXTRACT/report.sh" >"$REPORT_LOG" 2>&1
RC=$?
assert_eq "version report exits successfully" "0" "$RC"
assert_contains "version report logs setup-go output" "setup-go resolved version: 1.23.4" "$REPORT_LOG"
assert_contains "version report logs go version" "go version go1.23.4 linux/amd64" "$REPORT_LOG"
assert_eq "version report emits only the two intended lines" "2" "$(wc -l < "$REPORT_LOG" | tr -d ' ')"

printf '\n──────────────────────────────────────────────\n'
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '──────────────────────────────────────────────\n'
[ "$FAIL" -eq 0 ]
