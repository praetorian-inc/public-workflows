# public-workflows

Reusable GitHub Actions workflows callable from any repository in the `praetorian-inc` organization.

> **IMPORTANT:** Do not put proprietary information in these workflows. They are intended to be consumable by public repos.

## Access

These workflows are invocable from any `praetorian-inc` org repository via the repo-level setting:

`Settings → Actions → General → Access → Accessible from repositories in the 'praetorian-inc' organization`

This setting bypasses the org-level "Selected actions" allowlist for same-org reusable workflow calls. Callers should still pin by commit SHA.

## Available workflows

### `go-ci.yml` — Go CI (lint + test + build)

One-stop reusable workflow for Go repositories. Provides:
- **Module integrity** (`go mod verify` + `go mod tidy -diff` drift check)
- **Lint** (golangci-lint)
- **Test** (`go test -race` with coverage)
- **Cross-platform build matrix** (GOOS × GOARCH)
- **StepSecurity Harden-Runner** runtime CI EDR (enabled by default, audit mode)

**Minimal caller** (drop this in `.github/workflows/ci.yml` of a consumer repo):

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  ci:
    uses: praetorian-inc/public-workflows/.github/workflows/go-ci.yml@<SHA>  # v1.0.0
    permissions:
      contents: read
    with:
      build-cmd-path: ./cmd/myapp
    secrets: inherit
```

**All inputs** (all optional with sensible defaults):

| Input | Default | Purpose |
|---|---|---|
| `working-directory` | `.` | Working dir for multi-module repos |
| `go-version-file` | `go.mod` | Path to go.mod (relative to `working-directory`) |
| `enable-lint` | `true` | Run golangci-lint |
| `golangci-lint-version` | `v2.11.4` | Pinned golangci-lint binary version (never `latest`) |
| `golangci-lint-timeout` | `5m` | Lint timeout |
| `enable-test` | `true` | Run `go test` |
| `test-flags` | `-race -coverprofile=coverage.out -covermode=atomic` | Flags for `go test` |
| `test-packages` | `./...` | Package selector for `go test` |
| `enable-build` | `true` | Run cross-platform build matrix (requires `build-cmd-path`) |
| `build-matrix-os` | `["linux","darwin","windows"]` | GOOS matrix (JSON) |
| `build-matrix-arch` | `["amd64","arm64"]` | GOARCH matrix (JSON) |
| `build-cmd-path` | `""` | Go package path to build (e.g. `./cmd/augustus`). Build job skipped if empty. |
| `build-binary-name` | repo name | Base name for the built binary |
| `build-cgo-enabled` | `"0"` | `CGO_ENABLED` env for Build job. Set `"1"` for C-binding packages; narrow matrix accordingly. |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner as first step of every job |
| `harden-runner-policy` | `audit` | `audit` (observe) or `block` (deny-by-default egress) |
| `harden-runner-allowed-endpoints` | `""` | Newline-separated allowlist for block mode |
| `upload-coverage` | `false` | Upload `coverage.out` to Codecov (requires `CODECOV_TOKEN` secret) |

**Secrets:**
- `CODECOV_TOKEN` — required only if `upload-coverage: true`

### `go-security.yml` — Go security scanning (gosec + govulncheck)

Reusable workflow for Go repositories that runs SAST (`gosec`) and Go vulnerability database scanning (`govulncheck`), optionally publishing SARIF findings to the GitHub Security tab. **Separate from `go-ci.yml`** so that:
- callers only grant `security-events: write` when they want SARIF upload,
- security scans can run on a different cadence (`schedule:`) than CI,
- a broken security tool doesn't block builds (independent blast radius).

This matches the pattern used by `ossf/scorecard`, `kubernetes/release`, `cli/cli`, and `prometheus/prometheus`.

**Minimal caller** (drop this in `.github/workflows/security.yml` of a consumer repo):

```yaml
name: Security
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  schedule:
    - cron: '0 6 * * 1'  # Mondays 06:00 UTC — weekly baseline
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  security:
    uses: praetorian-inc/public-workflows/.github/workflows/go-security.yml@<SHA>  # v1.0.0
    permissions:
      contents: read
      security-events: write  # required when upload-sarif: true (default)
    secrets: inherit
```

**All inputs** (all optional with sensible defaults):

| Input | Default | Purpose |
|---|---|---|
| `working-directory` | `.` | Working dir for multi-module repos |
| `go-version-file` | `go.mod` | Path to go.mod (relative to `working-directory`), drives govulncheck's Go version |
| `enable-gosec` | `true` | Run gosec SAST scanner |
| `gosec-args` | `-no-fail -fmt sarif -out gosec-results.sarif ./...` | Arguments passed to gosec. Defaults to observe-only. Override with e.g. `-severity=high -fmt sarif -out gosec-results.sarif ./...` to enforce. |
| `enable-govulncheck` | `true` | Run govulncheck against the module |
| `govulncheck-package` | `./...` | Package selector for govulncheck |
| `upload-sarif` | `true` | Upload SARIF findings to the GitHub Security tab. When `true`, **the caller MUST grant `security-events: write`**. Set `false` to run as CI-only checks without publishing to the Security tab. |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner as first step of every job |
| `harden-runner-policy` | `audit` | `audit` (observe) or `block` (deny-by-default egress) |
| `harden-runner-allowed-endpoints` | `""` | Newline-separated allowlist for block mode |

**Pinned tool versions** (SHA-locked in the workflow, bumped via PR):

| Tool | Version | Why pinned |
|---|---|---|
| `securego/gosec` | v2.22.11 | Docker-based action — sidesteps host Go version requirements (later gosec builds require Go 1.25+) |
| `golang/govulncheck-action` | v1.0.4 | Stable; uses its own `stable` Go internally |
| `github/codeql-action/upload-sarif` | v3.35.2 | Current SARIF upload action |

### `claude-code.yml` — Claude PR Assistant

Runs Claude Code review on PRs. See the workflow file for input documentation.

### `unit-tests.yml` — Unit tests for claude-tool-sdk consumers (npm/Node.js)

Callable workflow for repos that use the private `claude-tool-sdk` module. Generates a short-lived GitHub App token to fetch the private dependency, then runs `npm ci` + `npm test`.

### `version-{bump,check,set}.yml` — Claude plugin version management

Three workflows that manage `.claude-plugin/plugin.json` version lifecycle on PRs.

## Pinning requirements

Consumers **must** pin reusable workflow references by SHA (not tag or branch) per the org's supply-chain hardening policy:

```yaml
# ✓ Allowed
uses: praetorian-inc/public-workflows/.github/workflows/go-ci.yml@abc123...def456  # v1.0.0

# ✗ Forbidden (tag and branch refs drift silently)
uses: praetorian-inc/public-workflows/.github/workflows/go-ci.yml@main
uses: praetorian-inc/public-workflows/.github/workflows/go-ci.yml@v1
```

Use [ratchet](https://github.com/sethvargo/ratchet) to auto-pin.

## Contributing

1. Workflows in `.github/workflows/*.yml` must SHA-pin all `uses:` references. `ratchet lint` enforces this.
2. The `test-go-ci.yml` and `test-go-security.yml` self-test harnesses exercise `go-ci.yml` and `go-security.yml` against the `_test-fixtures/go-minimal/` module on every PR — keep them passing.
3. Tag new major versions (`vX.Y.Z`) after merge; consumers pin to the SHA of that tagged commit.

## Supply chain context

See https://linear.app/praetorianlabs/issue/ENG-3079 for the CI/CD supply chain hardening initiative that motivates this repo's design.
