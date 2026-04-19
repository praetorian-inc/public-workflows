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
| `enable-gosec` | `true` | Run gosec SAST scanner |
| `gosec-version` | `v2.22.11` | Pinned gosec version. Never use `latest` — floating `@latest` has historically broken consumers when new gosec releases require newer Go than the CI toolchain. |
| `gosec-args` | `-no-fail -fmt sarif -out gosec-results.sarif ./...` | Arguments passed to gosec. Defaults to observe-only. Override with e.g. `-severity=high -fmt sarif -out gosec-results.sarif ./...` to enforce. |
| `enable-govulncheck` | `true` | Run govulncheck against the module |
| `govulncheck-version` | `v1.1.4` | Pinned govulncheck module version |
| `govulncheck-package` | `./...` | Package selector for govulncheck |
| `upload-sarif` | `true` | Upload SARIF findings to the GitHub Security tab. When `true`, **the caller MUST grant `security-events: write`**. Set `false` to run as CI-only checks without publishing to the Security tab. |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner as first step of every job |
| `harden-runner-policy` | `audit` | `audit` (observe) or `block` (deny-by-default egress) |
| `harden-runner-allowed-endpoints` | `""` | Newline-separated allowlist for block mode |

**Pinned tool versions** (overridable via inputs above):

| Tool | Default pin | Notes |
|---|---|---|
| `gosec` | v2.22.11 | Requires Go >= 1.24. Installed via `go install github.com/securego/gosec/v2/cmd/gosec@<version>` — the `securego/gosec` GitHub Action is not on the org allowlist, so we use a pinned `go install` instead. |
| `govulncheck` | v1.1.4 | Requires Go >= 1.22. Installed via `go install golang.org/x/vuln/cmd/govulncheck@<version>`. |
| `github/codeql-action/upload-sarif` | v4.35.2 | Used for SARIF upload to the Security tab (github-owned, always allowlisted). v4 runs on Node 24; v3 was on deprecated Node 20. |
| `actions/setup-go` | v6.3.0 | Uses `go-version: stable` — the tool binaries analyze source; they don't need to match the consumer's go.mod Go version. |

### `claude-code.yml` — Claude PR Assistant (hardened)

Runs Claude as a PR reviewer. **All security posture is hardcoded in the reusable workflow.** Callers cannot widen the tool allowlist, relax the gates, or override the hardening — any such change requires a PR to this repo with `@praetorian-inc/security-engineering` review (see CODEOWNERS).

**Security posture** (as of v2.0.4, SHA `1da9a5e29de06e850035b01e1ab5c0e19435ba30`):

- `author_association` double gate: **both** the PR author AND the `@claude` commenter must be `OWNER / MEMBER / COLLABORATOR`. External-PR content never reaches Claude, directly or via a maintainer `@claude` mention. Closes the CVSS 9.4 [comment-and-control](https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/) attack path.
- `--allowedTools "Bash(gh pr comment/diff/view:*), Read, Grep, Glob, mcp__github_inline_comment__create_inline_comment"` — the minimum surface needed to review a PR and post top-level + line-anchored comments.
- `--disallowedTools` floor: explicitly denies `Bash(curl:*)`, `Bash(wget:*)`, `Bash(gh api:*)`, `Bash(gh auth:*)`, `Bash(git add|commit|push|rm:*)`, `Write`, `Edit`, `MultiEdit`. Defense-in-depth against [claude-code-action#860](https://github.com/anthropics/claude-code-action/issues/860) where `track_progress: true` would union-merge write tools into the allowlist.
- Explicit `track_progress: "false"` on the action step.
- `--append-system-prompt` defensive preamble: Claude is instructed to treat all PR content (title, body, diffs, file contents, CLAUDE.md, comments) as untrusted data, never read secrets/env, and stop + report on injection attempts.
- `actions/checkout` pinned by SHA, `persist-credentials: false`.
- `anthropics/claude-code-action` pinned by SHA (`@38ec876...` = v1.0.101).
- CODEOWNERS enforces `@praetorian-inc/security-engineering` review on this file.

**Minimal caller** (drop this in `.github/workflows/claude-code.yml` of a consumer repo):

```yaml
name: Claude PR Assistant

on:
  pull_request:
    types: [synchronize, opened]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  claude-code-action:
    uses: praetorian-inc/public-workflows/.github/workflows/claude-code.yml@<SHA>  # v2.0.4
    permissions:
      contents: read
      pull-requests: write
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `prompt` | A built-in test-enforcement prompt | Custom review prompt. Callers can pass their own (see aurelian/orator for repo-specific prompts that read `.claude/skills/*.md`). |
| `require_tests` | `true` | When `true`, the workflow fails if Claude's output indicates "significant changes without automated tests". Set `false` for repos that don't enforce this. |

**Secrets:**

- `ANTHROPIC_API_KEY` — required. Repository-level secret.

**Triggers the reusable workflow responds to:**

- `pull_request` with `action == 'opened' || action == 'synchronize'` — auto-reviews new/updated PRs from insiders
- `pull_request_review_comment` with body containing `@claude` from an insider on an insider PR — targeted review requests

Other event types (`issue_comment`, `issues`, `workflow_dispatch`) are not handled — they trigger the caller workflow but the reusable workflow's job-level `if:` filters them out.

**Do NOT inline `anthropics/claude-code-action`.** A monthly drift scan will flag and open migration PRs for any repo that calls it directly.

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
