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
| `golangci-lint-version` | `v2.12.2` | Pinned golangci-lint binary version (never `latest`) |
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

### `go-sec.yml` — Go security scanning (gosec + govulncheck)

Reusable workflow for Go repositories that runs SAST (`gosec`) and Go vulnerability database scanning (`govulncheck`), optionally publishing SARIF findings to the GitHub Security tab. **Separate from `go-ci.yml`** so that:
- callers only grant `security-events: write` when they want SARIF upload,
- security scans can run on a different cadence (`schedule:`) than CI,
- a broken security tool doesn't block builds (independent blast radius).

This matches the pattern used by `ossf/scorecard`, `kubernetes/release`, `cli/cli`, and `prometheus/prometheus`.

**Safe by default for any repo visibility:** SARIF is uploaded to the Security tab **only on public repos** (GitHub code scanning is free there). On private/internal repos the upload is auto-skipped — no GitHub Advanced Security license required, no false-red CI from a 403 — and the scan still runs with findings printed to the job log. A private/internal repo that *has* a GHAS license can opt back in with `force-upload-private: true`. Scanning is observe-only by default; set `fail-on-findings: true` to make findings fail the build (recommended on private/no-GHAS repos where the Security tab is unavailable). Grant `security-events: write` + `actions: read` regardless of visibility — the jobs statically declare them, so omitting them re-triggers a `startup_failure` even when the upload is skipped at runtime.

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
    uses: praetorian-inc/public-workflows/.github/workflows/go-sec.yml@<SHA>  # vX.Y.Z
    permissions:
      contents: read
      security-events: write  # grant regardless of repo visibility — jobs statically declare it (else startup_failure)
      actions: read           # required by codeql-action/upload-sarif for run metadata
```

No `secrets: inherit` needed — this reusable only uses the auto-granted `GITHUB_TOKEN`.

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
| `upload-sarif` | `true` | Upload SARIF findings to the GitHub Security tab. **Auto-skipped on non-public repos** (code scanning needs a GHAS license there and would 403) unless `force-upload-private: true`. When uploaded, **the caller MUST grant both `security-events: write` and `actions: read`** — missing `actions: read` surfaces as "Resource not accessible by integration" on the upload step even though the scan itself succeeded (`codeql-action/upload-sarif` fetches workflow run metadata). Set `false` to run as CI-only checks without publishing to the Security tab. |
| `force-upload-private` | `false` | Upload SARIF even on private/internal repos. Requires a GitHub Advanced Security license on the repo (the upload step 403s without it). |
| `fail-on-findings` | `false` | Fail the job on gosec findings or govulncheck vulnerabilities (exit-code gate). Default is observe-only; set `true` to enforce a red build — recommended on private/internal repos without GHAS, where the Security tab is unavailable and the red build is the only finding surface. |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner as first step of every job |
| `harden-runner-policy` | `audit` | `audit` (observe) or `block` (deny-by-default egress) |
| `harden-runner-allowed-endpoints` | `""` | Newline-separated allowlist for block mode |

**Pinned tool versions** (overridable via inputs above):

| Tool | Default pin | Notes |
|---|---|---|
| `gosec` | v2.22.11 | Requires Go >= 1.24. Installed via `go install github.com/securego/gosec/v2/cmd/gosec@<version>` — the `securego/gosec` GitHub Action is not on the org allowlist, so we use a pinned `go install` instead. |
| `govulncheck` | v1.1.4 | Requires Go >= 1.22. Installed via `go install golang.org/x/vuln/cmd/govulncheck@<version>`. |
| `github/codeql-action/upload-sarif` | v4.35.2 | Used for SARIF upload to the Security tab (github-owned, always allowlisted). v4 runs on Node 24; v3 was on deprecated Node 20. |
| `actions/setup-go` | v6.4.0 | Uses `go-version: stable` — the tool binaries analyze source; they don't need to match the consumer's go.mod Go version. |

### `go-auto-tag.yml` — Go semver auto-tagging on merge

Auto-tags Go module repos on merge to main: reads the latest semver tag, determines the bump level from the merged PR's branch name or commit-message convention, then creates and pushes the new tag. Single source of truth for version calculation (replaces ad-hoc Makefile logic previously copy-pasted into caligula/trajan). Tags created with `GITHUB_TOKEN` do **not** trigger other workflows by design — pass the optional GitHub App secrets to push the tag as the App so it *does* trigger tag-based release workflows (and can bypass a Protected-Version-Tags ruleset).

**Minimal caller** (drop this in `.github/workflows/auto-tag.yml` of a consumer repo):

```yaml
name: Auto Tag
on:
  push: { branches: [main] }
jobs:
  auto-tag:
    uses: praetorian-inc/public-workflows/.github/workflows/go-auto-tag.yml@<SHA>
    permissions:
      contents: write
```

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `default-bump` | `patch` | Bump level when no convention is detected (`patch`/`minor`/`major`) |
| `major-pattern` | `[major-release]` | Commit-message/branch pattern that triggers a major bump |
| `minor-pattern` | `[minor-release]` | Commit-message/branch pattern that triggers a minor bump |
| `tag-prefix` | `v` | Prefix for version tags (alphanumeric + hyphens) |
| `seed-version` | `0.1.0` | Initial version when no tags exist yet (without prefix) |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Egress allowlist for block mode |

**Outputs:** `version` (the new tag, e.g. `v1.2.3`), `previous-version` (prior tag, empty on first tag), `tag-created` (`true`/`false`).

**Secrets** (both optional — needed only to push as a GitHub App):

| Secret | Required | Description |
|--------|----------|-------------|
| `VERSION_BUMPER_APP_ID` | no | GitHub App ID (e.g. `praetorian-ci-version-bumper`). When set, the tag is pushed as the App so it can bypass a Protected-Version-Tags ruleset and trigger tag-based release workflows. Falls back to `GITHUB_TOKEN` when unset. |
| `VERSION_BUMPER_PRIVATE_KEY` | only when `VERSION_BUMPER_APP_ID` is set | Private key for the App above |

### `go-release.yml` — Go binary release (GoReleaser + SBOM + signing + provenance)

Reusable release workflow for Go binary repos with supply-chain hardening baked in: SHA-pinned GoReleaser, Syft SBOMs, keyless cosign signing (Sigstore OIDC), and build-provenance attestation. **Two modes:**

- `tag-push` (default) — caller triggers on `push: tags: ['v*']`; the tag already exists.
- `auto-tag-from-main` — caller triggers on `push: branches: [main]`; this workflow calculates the next semver, creates the tag, then releases (caligula/trajan pattern).

**Minimal caller — `tag-push`** (drop this in `.github/workflows/release.yml`):

```yaml
on:
  push:
    tags: ['v*']
jobs:
  release:
    uses: praetorian-inc/public-workflows/.github/workflows/go-release.yml@<SHA>
    permissions:
      contents: write
      id-token: write
      attestations: write
```

For `auto-tag-from-main`, trigger on `push: branches: [main]` and add `with: { release-mode: auto-tag-from-main }`.

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `release-mode` | `tag-push` | `tag-push` or `auto-tag-from-main` |
| `default-bump` | `patch` | Bump level when no convention is detected (auto-tag mode) |
| `major-pattern` | `[major-release]` | Commit-message substring for a major bump (auto-tag mode) |
| `minor-pattern` | `[minor-release]` | Commit-message substring for a minor bump (auto-tag mode) |
| `tag-prefix` | `v` | Version tag prefix |
| `seed-version` | `0.1.0` | Initial version when no tags exist |
| `goreleaser-version` | `v2.13.3` | Pinned GoReleaser version (never `latest`) |
| `goreleaser-config-path` | `.goreleaser.yaml` | Path to the GoReleaser config |
| `goreleaser-args` | `release --clean` | Extra args for `goreleaser release` |
| `enable-sbom` | `true` | Generate Syft SBOMs per archive (needs `sboms:` in config) |
| `enable-sign` | `true` | Sign checksums with cosign (keyless OIDC) |
| `enable-provenance` | `true` | Build-provenance attestation via `actions/attest-build-provenance` |
| `publish-container` | `false` | Build + push a container image to ghcr.io (needs `dockers:` in config) |
| `runner` | `ubuntu-24.04` | Runner label (override for larger runners) |
| `working-directory` | `.` | Working dir for multi-module repos |
| `go-version-file` | `go.mod` | Path to go.mod (relative to working-directory) |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Egress allowlist for block mode |

**Outputs:** `version` (the released version), `tag-created` (`true` only in auto-tag mode).

**Secrets** (both optional — only for `auto-tag-from-main` pushing as a GitHub App):

| Secret | Required | Description |
|--------|----------|-------------|
| `VERSION_BUMPER_APP_ID` | no | GitHub App ID to push the auto-tag as the App (bypass a Protected-Version-Tags ruleset). Falls back to `GITHUB_TOKEN`. |
| `VERSION_BUMPER_PRIVATE_KEY` | only when `VERSION_BUMPER_APP_ID` is set | Private key for the App |

### `titus-scan.yml` — Titus secrets scan (language-agnostic)

Runs [Titus](https://github.com/praetorian-inc/titus) against the caller's repo to detect leaked secrets, credentials, and API keys. Language-agnostic — works on Go, TypeScript, Python, YAML, or any repo. Lives in its own reusable (separate from `go-sec.yml`) because secrets scanning applies to every repo and deserves independent blast radius. **Fail-closed by default** (`fail-on-findings: true`): a secret finding fails the build. Like `go-sec.yml`, SARIF is uploaded to the Security tab only on public repos (auto-skipped on private/internal unless `force-upload-private: true`); grant `security-events: write` + `actions: read` regardless of visibility — the job statically declares them (else `startup_failure`).

**Minimal caller** (drop this in `.github/workflows/secrets-scan.yml`):

```yaml
name: Secrets Scan
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  schedule:
    - cron: '0 7 * * 1'  # weekly baseline
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  scan:
    uses: praetorian-inc/public-workflows/.github/workflows/titus-scan.yml@<SHA>
    permissions:
      contents: read
      security-events: write  # grant regardless of visibility — the job declares it (else startup_failure)
      actions: read
```

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `titus-version` | `v1.1.27` | Pinned Titus version (never `latest`) |
| `scan-target` | `.` | Target to scan |
| `scan-args` | `--format sarif --output :memory:` | Extra args for `titus scan` |
| `scan-git-history` | `false` | Scan git history (`--git`) — slower, catches secrets in past commits |
| `upload-sarif` | `true` | Upload SARIF to the Security tab. Auto-skipped on non-public repos unless `force-upload-private`. |
| `force-upload-private` | `false` | Upload SARIF even on private/internal repos (requires a GHAS license) |
| `fail-on-findings` | `true` | Fail the build on secret findings (fail-closed). Set `false` only for a deliberate observe-only rollout. |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Egress allowlist for block mode |

No secrets required — uses the auto-granted `GITHUB_TOKEN`.

### `claude-code.yml` — Claude PR Assistant (hardened)

Runs Claude as a PR reviewer. **All security posture is hardcoded in the reusable workflow.** Callers cannot widen the tool allowlist, relax the gates, change the model, or override the hardening — any such change requires a PR to this repo with `@praetorian-inc/security-engineering` review (see CODEOWNERS).

**Security posture** (as of v2.9.3):

- **Same-repo-only gate**: `github.event.pull_request.head.repo.full_name == github.repository`. Fork PRs are blocked outright — stricter than the previously-used `author_association` check (which reports org members as `CONTRIBUTOR` on public repos and silently skipped runs, hit in v2.0.3-v2.0.5). Closes the CVSS 9.4 [comment-and-control](https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/) attack path on both PR and review-comment triggers.
- **Preflight job** skips Claude entirely on non-code PRs (files matching `*.md / *.markdown / *.rst / *.txt / docs/** / .claude-plugin/** / LICENSE / .gitignore / images`). `.github/` workflow changes are intentionally NOT skipped — CI config, job permissions, and secrets passthrough deserve AI review. Uses paginated `gh api pulls/N/files` (handles PRs >100 files per cli/cli#5368). `@claude` on a PR review comment bypasses the filter (documented override).
- **Model hardcoded**: `--model claude-opus-4-8`. Claude runs once per PR (on `opened` or `ready_for_review`; `synchronize` is intentionally excluded — CodeRabbit + Codex already run on every push). `ready_for_review` covers PRs opened as drafts — without it, the `opened` event fires while `draft==true` (skipped) and the PR never gets a Claude review. Opus is paid 1x per PR for the highest-capability senior-engineer review.
- `--allowedTools "Bash(gh pr comment/diff/view:*), Read, Grep, Glob"` — the minimum surface needed to review a PR and post the top-level summary comment. Inline line-anchored commenting deliberately NOT included (CodeRabbit covers it).
- `--disallowedTools` floor: explicitly denies `Bash(curl:*)`, `Bash(wget:*)`, `Bash(gh api:*)`, `Bash(gh auth:*)`, `Bash(git add|commit|push|rm:*)`, `Write`, `Edit`, `MultiEdit`. Defense-in-depth against [claude-code-action#860](https://github.com/anthropics/claude-code-action/issues/860) where `track_progress: true` would union-merge write tools into the allowlist.
- Explicit `track_progress: "false"` on the action step.
- `--max-turns` caps tool-call turns (the `max_turns` input, default 30). The `timeout-minutes` wall-clock ceiling, not this, is the backstop against runaway/injection loops.
- `--append-system-prompt` defensive preamble: Claude is instructed to treat all PR content (title, body, diffs, file contents, CLAUDE.md, comments) as untrusted data, never read secrets/env, and stop + report on injection attempts.
- **StepSecurity Harden-Runner** installed as the first step of both jobs (preflight + claude-code-action). Parameterized via `enable-harden-runner` / `harden-runner-policy` / `harden-runner-allowed-endpoints` inputs — audit mode by default. Matches the pattern in `go-ci.yml` / `go-sec.yml`.
- `actions/checkout` pinned by SHA, `persist-credentials: false`, `fetch-depth: 1`.
- `anthropics/claude-code-action` pinned by SHA (`@e34df878...` = v1.0.135).
- **Wall-clock ceiling**: `timeout-minutes: 5` on preflight, `15` on the claude-code-action job. `--max-turns` (the `max_turns` input, default 30) caps tool-call turns but not wall time; these ceilings bound a wedged network call, a stuck Opus response, or a prompt-injection-induced loop before it can sit on a runner for GitHub's 6-hour default.
- **CODEOWNERS** (`.github/CODEOWNERS`) enforces `@praetorian-inc/security-engineering` review on this file.

> ⚠️ **Do NOT enable `ACTIONS_STEP_DEBUG=true` on repos that call this reusable.** The upstream `claude-code-action` auto-enables `show_full_output` under debug logging, which can expose PR content, tool outputs, and the contents of the internal `execution_file` into Actions logs. On public repos those logs are world-readable; on private repos they're readable by anyone with repo read access. If you need to debug a Claude run, do it locally against a test repo, not by flipping debug on a production caller.

**Default review prompt** produces a 3-section summary: `### Critical issues` / `### Security` / `### Test coverage`. Explicitly defers style nits to CodeRabbit + Codex. Callers can override via the `prompt` input.

**Minimal caller** (drop this in `.github/workflows/claude-code.yml` of a consumer repo):

```yaml
name: Claude PR Assistant

on:
  pull_request:
    types: [opened, ready_for_review]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  claude-code-action:
    uses: praetorian-inc/public-workflows/.github/workflows/claude-code.yml@<SHA>  # v2.9.3
    permissions:
      contents: read
      pull-requests: write
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Note: `pull_request: types: [opened, ready_for_review]` — Claude reviews once per PR (on first open, or when a draft PR is marked ready). Developers re-request a review via `@claude` on a PR review comment. `synchronize` (commits pushed to a PR) does NOT re-trigger Claude by design.

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `prompt` | Built-in 3-section review template | Custom review prompt. Callers can pass their own (see aurelian/orator for repo-specific prompts that read `.claude/skills/*.md`). |
| `require_tests` | `true` | When `true`, fails the workflow if Claude's output indicates "significant changes without automated tests". (Dead code under the default prompt — only matters for custom prompts that emit the `**Has ... :** Yes/No` markers.) |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner as the first step of both jobs. |
| `harden-runner-policy` | `audit` | `audit` (observe + report) or `block` (deny-by-default egress). |
| `harden-runner-allowed-endpoints` | `""` | Newline-separated egress allowlist when policy is `block`. Recommended: `api.anthropic.com:443, statsig.anthropic.com:443, api.github.com:443, github.com:443, release-assets.githubusercontent.com:443, registry.npmjs.org:443`. |

**Secrets:**

- `ANTHROPIC_API_KEY` — required. Repository-level secret.

**Triggers the reusable workflow responds to:**

- `pull_request` with `action == 'opened'` or `'ready_for_review'` on a same-repo branch PR — auto-reviews once on PR open (or when a draft PR is marked ready)
- `pull_request_review_comment` with body containing `@claude` on a same-repo PR — targeted review requests, bypasses the docs-only preflight filter

Other event types and `synchronize` actions trigger the caller workflow but are filtered out at the job-level `if:`.

**Do NOT inline `anthropics/claude-code-action`.** All Claude PR review must go through this reusable workflow.

### `gemini-code.yml` — Gemini PR Assistant (hardened)

Runs Gemini as a complementary PR reviewer **alongside** the Claude PR Assistant. Uses [`google-github-actions/run-gemini-cli`](https://github.com/google-github-actions/run-gemini-cli) to run the Gemini CLI as an **agent** — like Claude and Codex, it reads past the diff to open the surrounding code (definitions, callers, sibling modules) for real context. It loads Praetorian's curated review skills natively from [`praetorian-inc/palatine`](https://github.com/praetorian-inc/palatine) (`.gemini/skills/`, pinned by SHA).

**Security posture** follows `codex-code.yml`'s two-job defense-in-depth split:

- **Tokenless read-only agent**: The `gemini-review` job is `contents: read` only and **no step in it uses a GitHub token** — a prompt-injected agent has no credential to exfiltrate and no path to write to the PR. The PR diff is computed fully offline (the depth-2 merge-ref checkout brings the diff's parents locally), so the agent runs with zero credentials.
- **Read-only tool surface**: `tools.core` is an allowlist of read-only built-ins (`read_file`, `read_many_files`, `glob`, `grep_search`, `list_directory`) plus `activate_skill`; shell/write/edit/web tools are excluded. The names must match the pinned `gemini_cli_version` (gemini-cli renamed the grep tool `search_file_content` → `grep_search` at ~v0.44).
- **Untrusted-workspace purge**: because the agent runs against the PR's merged tree with workspace trust enabled, the staging step removes every agent-control file a PR could plant before staging the curated set — `.gemini`/`.agents` (skill + settings discovery; `.agents/skills` would otherwise take precedence), all `GEMINI.md` (recursive), `.geminiignore` (review-blinding), and `.npmrc`/`.yarnrc*` (CLI-install supply-chain). Skills + settings come only from the action input and the SHA-pinned `palatine` checkout.
- **Secret redaction**: the `GEMINI_API_KEY` (the only secret in the read-only job) is stripped from the captured review output before it leaves that job — so a prompt-injection that coerces the agent into reading its own environment can't surface the key in the posted comment.
- **No MCP servers, no containers**: Unlike Google's official PR-review example (which posts via a Docker-run `github-mcp-server`), Harden-Runner's `disable-sudo-and-containers: true` stays on throughout — a strictly stronger posture than `codex-code.yml` (which must relax sudo for `codex-action` and re-lock Docker manually).
- **Separate post-feedback job**: A minimal `pull-requests: write` job (runs zero untrusted code) posts the captured review via `pulls.createReview` with hardcoded `event: 'COMMENT'` — no APPROVE path. If the agent job fails, it posts a fixed failure notice instead of failing silently (parity with the previous reviewer); it does not run when the review was skipped.
- **Same-repo-only gate**: Fork PRs blocked outright (`head.repo.full_name == github.repository`)
- **Preflight job**: Skips docs-only PRs; `@gemini` on a PR review comment bypasses the filter
- **Anti-injection prompt**: Gemini instructed to treat all PR content (including `GEMINI.md`) as untrusted data
- **Pinned**: `run-gemini-cli` action SHA-pinned; the CLI version is hardcoded (`0.45.2`, **not** a caller input — it governs folder-trust/tool-policy semantics); `palatine` checkout pinned by commit SHA
- **Wall-clock ceiling**: `timeout-minutes: 15` on the review job (`5` on the post-feedback job)
- **CODEOWNERS**: `@praetorian-inc/security-engineering` review required on any change

**Minimal caller** (drop this in `.github/workflows/gemini-code.yml` of a consumer repo):

```yaml
name: Gemini PR Assistant

on:
  pull_request:
    types: [opened, ready_for_review]
  pull_request_review_comment:
    types: [created]

concurrency:
  group: gemini-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  gemini-review:
    uses: praetorian-inc/public-workflows/.github/workflows/gemini-code.yml@<SHA>
    permissions:
      contents: read
      pull-requests: write
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `prompt` | Built-in 3-section review template | Custom review prompt (the PR diff is materialized to `.gemini-review/pr.diff` for the agent to read) |
| `model` | `gemini-3.1-pro-preview` | Gemini model ID |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Egress allowlist for block mode. Recommended: `generativelanguage.googleapis.com:443, api.github.com:443, github.com:443, registry.npmjs.org:443, storage.googleapis.com:443` |

**Secrets:**

- `GEMINI_API_KEY` — required. Google AI Studio API key (org-level secret recommended).

**Triggers:**

- `pull_request` with `action == 'opened'` or `'ready_for_review'` — auto-reviews once on PR open
- `pull_request_review_comment` with body containing `@gemini` — re-review on demand

### `codex-code.yml` — Codex PR Review (hardened)

Runs OpenAI Codex as a complementary **second-vendor** PR reviewer alongside the Claude PR Assistant, via [`openai/codex-action`](https://github.com/openai/codex-action) running the Codex CLI in a read-only sandbox. **All security posture is hardcoded** — callers cannot widen the attack surface; any change requires `@praetorian-inc/security-engineering` review (CODEOWNERS).

**Security posture:**

- **Three-job defense-in-depth split** (mirrors `gemini-code.yml`): a `preflight` job (shared `preflight.yml`) skips docs-only PRs; a `codex-review` job runs the agent read-only in a sandbox; a minimal `post-feedback` job (`pull-requests: write`, runs zero untrusted code) posts the captured review via `pulls.createReview` with hardcoded `event: 'COMMENT'` (no APPROVE path).
- **Depth-2 merge-ref checkout**: `HEAD^1` is the immutable base, `HEAD^2` is the PR head; review scope (`git diff HEAD^1 HEAD`) and skill application are enforced by a hardcoded wrapper prepended to every review — the caller-supplied `prompt` is appended after it (output format/emphasis only).
- **Same-repo-only gate**: fork PRs blocked outright; `@codex` on a PR review comment bypasses the docs-only preflight filter.
- **Pinned**: `openai/codex-action` SHA-pinned (`@c25d10f...` = v1.6).
- **Wall-clock ceiling**: `timeout-minutes: 10` on the review job (`5` on post-feedback).

**Minimal caller** (drop this in `.github/workflows/codex-code.yml` of a consumer repo):

```yaml
name: Codex PR Review
on:
  pull_request:
    types: [opened, ready_for_review]
  pull_request_review_comment:
    types: [created]
concurrency:
  group: codex-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  codex-review:
    uses: praetorian-inc/public-workflows/.github/workflows/codex-code.yml@<SHA>
    permissions:
      contents: read
      pull-requests: write
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `prompt` | Built-in 3-section review template | Output-format/emphasis text appended after the hardcoded review wrapper |
| `model` | `gpt-5.5` | Codex model ID. Override per-caller for special cases (e.g. `gpt-5.4-mini` for cost-sensitive repos, `gpt-5.3-codex` for complex multi-file reviews). |
| `effort` | `medium` | Reasoning effort level (`minimal`, `low`, `medium`, `high`) |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Egress allowlist for block mode. Recommended: `api.openai.com:443, api.github.com:443, github.com:443, registry.npmjs.org:443` |

**Secrets:**

- `OPENAI_API_KEY` — required (pay-per-token billing).

**Triggers:**

- `pull_request` with `action == 'opened'` or `'ready_for_review'` on a same-repo PR — reviews once per PR
- `pull_request_review_comment` with body containing `@codex` — re-review on demand

### `claude-md-drift.yml` — CLAUDE.md drift detection

Detects when a PR's code changes may have made `CLAUDE.md` documentation stale. **Two-phase design:** a zero-cost shell pre-filter determines which `CLAUDE.md` files are relevant to the PR's code changes, then Claude (Haiku) runs a read-only semantic check only when needed. The pre-filter skips the LLM job entirely when no `CLAUDE.md` exists, the PR is docs/config-only, changed files have no `CLAUDE.md` ancestor in the directory tree, the PR already edits every relevant `CLAUDE.md`, or the author is a bot. Same-repo-only (fork PRs blocked); draft PRs skipped.

**Minimal caller** (drop this in `.github/workflows/claude-md-drift.yml` of a consumer repo):

```yaml
name: CLAUDE.md Drift Detection
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]  # synchronize: re-check drift on every push
concurrency:
  group: claude-drift-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  drift-check:
    uses: praetorian-inc/public-workflows/.github/workflows/claude-md-drift.yml@<SHA>
    permissions:
      contents: read
      pull-requests: write
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `skip_extensions` | `.md,.markdown,.rst,.txt,.yml,.yaml,.json,.toml,.png,.jpg,.jpeg,.svg,.gif,.webp,.ico,.lock` | File extensions ignored when deciding whether code (vs docs/config) changed |
| `model` | `claude-haiku-4-5-20251001` | Claude model for the semantic drift check |
| `max_turns` | `45` | Max Claude conversation turns for drift analysis |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Egress allowlist for block mode |

**Secrets:**

- `ANTHROPIC_API_KEY` — required.

### `ts-ci.yml` — TypeScript/Node.js CI (install + typecheck + lint + test)

Reusable workflow for TypeScript/Node.js repositories (Claude plugin repos and other TS projects). Provides consistent `npm ci` + `tsc --noEmit` + `npm run lint` + `npm test` + Harden-Runner. Typecheck, lint, and test each auto-skip when the corresponding `tsconfig.json` / `lint` script / test script is absent. Private dependencies (e.g. `@praetorian/claude-tool-sdk`) are **optional** — opt in with `enable-private-deps: true` to mint a short-lived GitHub App token before `npm ci`. A preflight job skips CI on PRs with no TypeScript/JS changes.

**Minimal caller** (drop this in `.github/workflows/ci.yml` of a consumer repo):

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
permissions:
  contents: read
jobs:
  ci:
    uses: praetorian-inc/public-workflows/.github/workflows/ts-ci.yml@<SHA>  # vX.Y.Z
    permissions:
      contents: read
```

**With private dependencies** (repos that consume `@praetorian/claude-tool-sdk`):

```yaml
jobs:
  ci:
    uses: praetorian-inc/public-workflows/.github/workflows/ts-ci.yml@<SHA>  # vX.Y.Z
    permissions:
      contents: read
    with:
      enable-private-deps: true
      private-deps-repos: claude-tool-sdk
    secrets:
      PLUGIN_CI_APP_ID: ${{ secrets.PLUGIN_CI_APP_ID }}
      PLUGIN_CI_PRIVATE_KEY: ${{ secrets.PLUGIN_CI_PRIVATE_KEY }}
```

**All inputs** (all optional with sensible defaults):

| Input | Default | Purpose |
|---|---|---|
| `working-directory` | `.` | Working dir for the Node.js project |
| `node-version` | `22` | Node.js version |
| `enable-typecheck` | `true` | Run `tsc --noEmit` if `tsconfig.json` exists |
| `enable-lint` | `true` | Run `npm run lint` (skipped if the script is not defined in package.json) |
| `enable-test` | `true` | Run `npm test` |
| `test-script` | `test` | npm script to run for tests (must be a key in package.json scripts) |
| `enable-private-deps` | `false` | Mint a GitHub App token for private-dependency access before `npm ci` |
| `private-deps-owner` | `praetorian-inc` | GitHub org for private dependency access |
| `private-deps-repos` | `claude-tool-sdk` | Comma-separated repo names the App token is scoped to |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Newline-separated egress allowlist for block mode |

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `PLUGIN_CI_APP_ID` | only when `enable-private-deps: true` | GitHub App ID for private dependency access |
| `PLUGIN_CI_PRIVATE_KEY` | only when `enable-private-deps: true` | GitHub App private key |

**Security posture:** Workflow-level `permissions: contents: read` ceiling. Harden-Runner enabled by default. Preflight job skips CI on non-TypeScript PRs. Runner pinned to `ubuntu-24.04`.

### `ts-release.yml` — npm package publish (GitHub Packages + provenance)

Reusable workflow for publishing a TypeScript/Node.js package to an npm registry — **GitHub Packages (`npm.pkg.github.com`) by default**. The npm sibling of `go-release.yml`. It publishes the version in the package's `package.json` (npm always publishes that version; the triggering tag is only an optional consistency guard). Release gates run explicitly and visibly — `build` → `test` → optional `verify` → `pack` → `publish` — because publishing a pre-packed tarball does **not** re-run `prepublishOnly`/`prepare`, so the published bytes are exactly the ones that were tested and attested.

**Provenance:** npm's built-in `--provenance` only works against `registry.npmjs.org`, **not** GitHub Packages, so build provenance is produced registry-agnostically via `actions/attest-build-provenance` over the packed tarball (`pack` → attest → `publish <tarball>`).

**Packaging constraint:** `pack` runs `npm pack --ignore-scripts`, so the package's `prepack`/`prepare`/`postpack` lifecycle scripts do **not** run — this is what guarantees the attested/published tarball is byte-identical to what the `build`/`test`/`verify` gates produced. Your package must therefore generate all publishable output via `build-script` (default `build`), **not** via a `prepack`/`prepare` hook; a package that relies on those hooks to emit files would otherwise publish a stale or incomplete tarball.

**Minimal caller** — publish an npm-workspace member to GitHub Packages on tag push:

```yaml
name: Publish
on:
  push:
    tags: ['gateway-v*']
permissions:
  contents: read
jobs:
  release:
    uses: praetorian-inc/public-workflows/.github/workflows/ts-release.yml@<SHA>  # vX.Y.Z
    permissions:
      contents: read
      packages: write       # publish to GitHub Packages via GITHUB_TOKEN
      id-token: write        # provenance attestation
      attestations: write    # provenance attestation
    with:
      install-directory: .          # npm ci at the workspace root
      package-dir: gateway          # build/pack/publish this package
      tag-prefix: gateway-v
      verify-script: check-bundle-drift
```

**Publish to public npmjs.com instead:**

```yaml
jobs:
  release:
    uses: praetorian-inc/public-workflows/.github/workflows/ts-release.yml@<SHA>  # vX.Y.Z
    permissions:
      contents: read
      packages: write        # required even for npmjs (see note below)
      id-token: write
      attestations: write
    with:
      registry-url: https://registry.npmjs.org
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

> **Why `packages: write` even when publishing to npmjs:** the reusable `publish` job unconditionally declares `packages`/`id-token`/`attestations: write`. A caller can only *downgrade* a reusable workflow's permissions, never elevate them — granting less than the called job declares makes GitHub reject the call at startup (`startup_failure`, which posts no check run and is easy to miss). Grant the full set; unused scopes are never spent.

**All inputs** (all optional with sensible defaults):

| Input | Default | Purpose |
|---|---|---|
| `install-directory` | `.` | Directory where `npm ci` runs (repo root for workspaces) |
| `package-dir` | `.` | Directory of the package to build, pack and publish |
| `node-version` | `22` | Node.js version |
| `registry-url` | `https://npm.pkg.github.com` | npm registry to publish to |
| `scope` | `@praetorian-inc` | npm scope to configure auth for (must equal the org login for GitHub Packages) |
| `enable-install-auth` | `false` | Expose `NODE_AUTH_TOKEN` during `npm ci` so deps on the authenticated registry resolve. Off by default so a publish-capable token never enters the install env (where dependency scripts run); enable only for registry-hosted private deps |
| `tag-prefix` | `v` | Prefix stripped before comparing tag to `package.json` version |
| `verify-version-matches-tag` | `true` | Assert tag (minus prefix) equals `package.json` version; auto-skipped on dry-run or non-tag refs |
| `run-build` | `true` | Run the build script before packing |
| `build-script` | `build` | npm script that produces the publishable output |
| `run-test` | `true` | Run the test script before packing |
| `test-script` | `test` | npm script to run for tests |
| `verify-script` | `""` | Optional extra npm script after build+test (e.g. `check-bundle-drift`) |
| `enable-provenance` | `true` | Attest build provenance over the packed tarball (skipped on dry-run) |
| `dry-run` | `false` | `npm publish --dry-run` (no upload); skips tag check and provenance |
| `enable-private-deps` | `false` | Mint a GitHub App token for private-dependency access before `npm ci` |
| `private-deps-owner` | `praetorian-inc` | GitHub org for private dependency access |
| `private-deps-repos` | `claude-tool-sdk` | Comma-separated repo names the App token is scoped to |
| `runner` | `ubuntu-24.04` | Runner label |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Newline-separated egress allowlist for block mode |

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `NPM_TOKEN` | any registry except GitHub Packages | Registry auth token, used as `NODE_AUTH_TOKEN` at publish (and at install when `enable-install-auth: true`). Required for `registry.npmjs.org`, JFrog, GitLab, and any other non-GitHub-Packages registry. Unset → falls back to `GITHUB_TOKEN`, which authenticates GitHub Packages only (and needs `packages: write`) |
| `PLUGIN_CI_APP_ID` | only when `enable-private-deps: true` | GitHub App ID for private dependency access |
| `PLUGIN_CI_PRIVATE_KEY` | only when `enable-private-deps: true` | GitHub App private key |

> **Install-time registry auth (`enable-install-auth`, default `false`):** by default `NODE_AUTH_TOKEN` is exported only for the publish step, so `npm ci` runs unauthenticated and the publish-capable token never enters the install environment — where dependency lifecycle scripts run by default and a compromised dependency could otherwise read it. That is the right default when the released package's dependencies all resolve from public registries. If the package *consumes* a dependency from an authenticated registry — e.g. an `@praetorian-inc`-scoped package hosted on GitHub Packages — set `enable-install-auth: true` to expose the token at `npm ci` too. The fallback `GITHUB_TOKEN` stays host-anchored to GitHub Packages; for any other registry without an `NPM_TOKEN` the token is dropped before install so the repo token is never sent to a third party. Git-hosted private deps are covered separately by `enable-private-deps`.
>
> **Remaining limitation:** install and publish share one registry configuration (`registry-url` + `scope`), so "install private GitHub Packages deps while publishing to `registry.npmjs.org`" is not supported in a single run; mirror or pre-install such deps instead.
>
> **Private-dep token vs. install scripts (`enable-private-deps`):** minting the GitHub App token writes `https://x-access-token:<token>@github.com/` URL-rewrite rules into the **global git config before `npm ci`**, so the token is readable from `~/.gitconfig` by any dependency lifecycle script that `npm ci` runs — the same install-script exposure that `enable-install-auth` deliberately avoids for the registry token. The blast radius is bounded (`create-github-app-token` scopes the token to `private-deps-owner` + `private-deps-repos`, and an `always()` step revokes the git config so it can't outlive the job), but a compromised transitive dependency could still read it *during* install. Git-hosted private deps inherently need the credential in git config during resolution, and lifecycle scripts share that environment, so this can't be fully eliminated short of `--ignore-scripts` (which would break deps that need build scripts). Enable `enable-private-deps` only when you actually consume a git-hosted private dependency, and keep `private-deps-repos` as narrow as possible.

**Outputs:** `version` — the `package.json` version that was published.

**Security posture:** Workflow-level `permissions: contents: read` ceiling; the publish job adds `packages`/`id-token`/`attestations: write` (unused grants are never spent). Harden-Runner enabled by default. `persist-credentials: false` on checkout. Runner pinned to `ubuntu-24.04`.

### `markdown-quality.yml` — Markdown lint + format check

Reusable workflow for markdown-heavy repositories (skills, docs, plugin libraries). Runs markdownlint (structural quality) + prettier (table/format alignment) in check mode. Designed for repos with no `package.json` — uses `npx` to download tools on demand.

**Minimal caller** (drop this in `.github/workflows/markdown-quality.yml` of a consumer repo):

```yaml
name: Markdown Quality
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
permissions:
  contents: read
jobs:
  quality:
    uses: praetorian-inc/public-workflows/.github/workflows/markdown-quality.yml@<SHA>
    permissions:
      contents: read
```

**All inputs** (all optional with sensible defaults):

| Input | Default | Purpose |
|---|---|---|
| `working-directory` | `.` | Working dir for the markdown project |
| `glob` | `**/*.md` | Glob pattern for markdown files |
| `node-version` | `22` | Node.js version for npx |
| `enable-markdownlint` | `true` | Run markdownlint-cli2 |
| `markdownlint-version` | `0.22.1` | Pinned markdownlint-cli2 version |
| `enable-prettier` | `true` | Run prettier table/format check |
| `prettier-version` | `3.8.3` | Pinned prettier version |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Egress allowlist for block mode |

**Pre-commit hooks (local auto-fix):** See [`templates/markdown/`](templates/markdown/) for canonical `.pre-commit-config.yaml` and `.markdownlint-cli2.jsonc` that run the same checks with `--fix`/`--write` on commit. CI is the enforcement gate; pre-commit hooks are developer convenience.

### `version-bump.yml` — Claude plugin version management

Bumps `.claude-plugin/plugin.json` (and `package.json` if present) after every merge to main. Each merge gets a unique version — no collision between concurrent PRs.

**Caller workflow** (drop this in `.github/workflows/version-bump.yml`):

```yaml
name: Version Bump
on:
  push:
    branches: [main]
jobs:
  version-bump:
    uses: praetorian-inc/public-workflows/.github/workflows/version-bump.yml@SHA  # v3.0.0
    permissions:
      contents: write
    secrets:
      VERSION_BUMPER_APP_ID: ${{ secrets.VERSION_BUMPER_APP_ID }}
      VERSION_BUMPER_PRIVATE_KEY: ${{ secrets.VERSION_BUMPER_PRIVATE_KEY }}
```

**Bump level** is determined from the merged PR's branch name: `release/*` → major, `feat/*` or `feature/*` → minor, everything else → patch. Falls back to patch if the branch can't be resolved.

**Prerequisites for each repo:**

1. The `praetorian-ci-version-bumper` GitHub App must be installed on the repo (Org Settings → Installed GitHub Apps → Configure → add repo)
2. If the repo has old-style branch protection on `main`, add the App to "Allow specified actors to bypass required pull requests"
3. If the repo has repository rulesets with `pull_request` rules, add the App (Integration ID `3393916`) to the bypass actors list
4. Remove `version-check.yml` from the repo — it's obsolete with post-merge bumping

**Migration from PR-based bumping (v2.x):**

The old model bumped versions when PRs opened (`pull_request: [opened, labeled]`). This caused version collision when concurrent PRs got the same version number. The new model bumps after merge, eliminating collisions.

To migrate: change the trigger from `pull_request` to `push`, pin to the v3.0.0 SHA, remove `version-check.yml`, and configure the App bypass (steps above).

**Rollout status** (18 plugin repos):

| Status | Repos |
|--------|-------|
| ✅ Migrated | `praetorian-core` |
| ⬜ Pending | `praetorian-engineering`, `praetorian-capabilities`, `praetorian-sales`, `praetorian-marketing`, `praetorian-finance`, `praetorian-it`, `praetorian-pmo`, `praetorian-pm`, `praetorian-threat-modeling`, `praetorian-redteam`, `praetorian-cloud`, `praetorian-iot`, `praetorian-security`, `praetorian-mobile`, `praetorian-msp`, `praetorian-reporting`, `praetorian-offsec` |

### `version-check.yml` — (deprecated, remove from migrated repos)

Validated PR version bumps in the old PR-based model. Obsolete with post-merge bumping — the bump workflow handles both files atomically. Remove from repos that have migrated to `version-bump.yml` v3.0.0+.

### `version-set.yml` — Manual version override

Sets the version to an explicit value. Used for major version resets or manual corrections. Not affected by the bump model change.

### `graphify-graph.yml` — Code knowledge graph builder + artifact publisher

Builds a repo's [graphify](https://github.com/safishamsi/graphify) code knowledge graph (`graphify-out/graph.json`) and publishes it as a downloadable artifact, so engineers and agents query the latest graph without each rebuilding the (often 50k+ node) graph locally. graphify has no server — the graph is a file that `graphify query` reads; this workflow is the shared-distribution mechanism (build once in CI, everyone pulls the same artifact). The build is code-only and keyless: `--no-cluster` skips clustering, but graphify still routes any doc/paper/image files to LLM-backed semantic extraction and aborts without an API key — so keyless requires a `.graphifyignore` that excludes those files (which the caller repos ship) and/or a code-only `extract-path`. No LLM key is passed.

```yaml
name: graphify-graph
on:
  push:
    branches: [main]
    paths: ['**/*.go', '.graphifyignore', '.github/workflows/graphify-graph.yml']
  schedule:
    - cron: '0 7 * * 1'
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  graph:
    uses: praetorian-inc/public-workflows/.github/workflows/graphify-graph.yml@<SHA>  # vX.Y.Z
    permissions:
      contents: read
```

Pull the published graph from a consumer machine: `gh run download -R <owner>/<repo> -n <repo>-graph -D graphify-out`.

**Inputs:** `extract-path` (default `.`; must not begin with `-`), `extract-args` (extra `graphify extract` args, **one token per line** — newline-delimited so a token may contain spaces without quoting; default `--no-cluster`; the workflow always appends `--out .`), `artifact-name` (default `<repo>-graph`; chars `A-Z a-z 0-9 . _ -`), `graphify-version`, `retention-days`, and Harden-Runner controls. (`extract-args` tokens are passed through verbatim; graphify silently ignores unrecognized flags, so a typo is skipped rather than erroring.) **Outputs:** `graph-nodes` — the node count, always a non-negative integer on success (the build fails before it is set if `graph.json` is missing, empty, or unparseable); `artifact-name` — the resolved artifact name (default `<repo>-graph`; chars `A-Z a-z 0-9 . _ -`).

**Supply-chain:** `graphifyy` is PINNED via the `graphify-version` input (default `0.8.35`) — never `latest`/`--upgrade`. Bump deliberately, in lockstep with the `GRAPHIFY_VERSION` pin in the separate `praetorian-claude` monorepo Makefile (this repo has no Makefile). No secrets used (GITHUB_TOKEN only).

### `external-contrib-notify.yml` — External contribution notifier

For praetorian-inc open-source repos. Detects **external contributions** (PRs/issues from non-org-members), creates a Linear issue, posts a Slack notification, and auto-replies on the GitHub thread. Runs on `pull_request_target` + `issues`, so the caller job's `permissions:` block is **required** — the reusable can only restrict, not elevate, the caller's `GITHUB_TOKEN` (org default is read-only), and omitting it causes "Resource not accessible by integration". Prefer the explicit `secrets:` block over `secrets: inherit` to limit forwarding to the declared secrets (it runs on the sensitive `pull_request_target` trigger). Harden-Runner defaults to **`block`** here (not `audit`), allowlisting `api.github.com`, `api.linear.app`, and `slack.com`.

**Minimal caller** (drop this in `.github/workflows/external-contribution.yml`):

```yaml
name: External Contribution Notify
on:
  issues:
    types: [opened, assigned, closed]
  pull_request_target:
    types: [opened, assigned, closed]
jobs:
  notify:
    uses: praetorian-inc/public-workflows/.github/workflows/external-contrib-notify.yml@<SHA>
    permissions:
      contents: read
      issues: write
      pull-requests: write
    secrets:
      EXTERNAL_CONTRIB_APP_ID: ${{ secrets.EXTERNAL_CONTRIB_APP_ID }}
      EXTERNAL_CONTRIB_APP_PRIVATE_KEY: ${{ secrets.EXTERNAL_CONTRIB_APP_PRIVATE_KEY }}
      LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
      LINEAR_TEAM_ID: ${{ secrets.LINEAR_TEAM_ID }}
      SLACK_CHANNEL_ID: ${{ secrets.SLACK_CHANNEL_ID }}
      # optional: LINEAR_ASSIGNEE_ID, LINEAR_PARENT_ISSUE_ID, LINEAR_PROJECT_ID
```

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `linear-state-name` | `Backlog` | Linear state for created issues |
| `github-org` | `praetorian-inc` | Org to check membership against (members are not "external") |
| `dry-run` | `false` | Log payloads instead of sending (testing) |
| `auto-reply-enabled` | `true` | Post an auto-reply GitHub comment on external contributions |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `block` | `audit` or `block` (this workflow defaults to `block`) |
| `harden-runner-allowed-endpoints` | `api.github.com:443 api.linear.app:443 slack.com:443` | Egress allowlist for block mode |

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `EXTERNAL_CONTRIB_APP_ID` | yes | GitHub App ID/Client ID for `praetorian-external-contrib-bot` |
| `EXTERNAL_CONTRIB_APP_PRIVATE_KEY` | yes | App private key (PEM) |
| `LINEAR_API_KEY` | yes | Linear API key for issue creation |
| `SLACK_BOT_TOKEN` | yes | Slack bot token for channel notifications |
| `LINEAR_TEAM_ID` | yes | Linear team ID issues are filed against |
| `SLACK_CHANNEL_ID` | yes | Slack channel ID for the notification |
| `LINEAR_ASSIGNEE_ID` | no | Linear user to assign created issues to |
| `LINEAR_PARENT_ISSUE_ID` | no | Linear parent issue (created issues become sub-issues) |
| `LINEAR_PROJECT_ID` | no | Linear project ID |

### `verify-pins.yml` — Verify public-workflows pins are honest

Verifies that the first-party `praetorian-inc/public-workflows` `uses:` pins in the **caller's** workflows are honest: every pinned 40-char SHA carries a `# vX.Y.Z` version comment, that tag actually exists, and the tag points at exactly that SHA. Prevents the "lying pin comment" failure mode — a hand-edited `@<sha>  # vX.Y.Z` where the tag is missing or resolves to a different commit — which would defeat audits and Dependabot and mask pin divergence across the fleet. Scope is first-party public-workflows pins only; third-party pins (`actions/checkout`, etc.) are out of scope (handled by Dependabot/zizmor).

**Minimal caller** (drop this in `.github/workflows/verify-pins.yml`):

```yaml
name: Verify Pins
on:
  pull_request: { paths: ['.github/workflows/**'] }
  push: { branches: [main], paths: ['.github/workflows/**'] }
permissions:
  contents: read
jobs:
  verify:
    uses: praetorian-inc/public-workflows/.github/workflows/verify-pins.yml@<SHA>  # <tag>
    permissions:
      contents: read
```

**Inputs** (all optional):

| Input | Default | Purpose |
|---|---|---|
| `owner-repo` | `praetorian-inc/public-workflows` | First-party repo whose tags the pins are verified against |
| `enable-harden-runner` | `true` | Install StepSecurity Harden-Runner |
| `harden-runner-policy` | `audit` | `audit` or `block` |
| `harden-runner-allowed-endpoints` | `""` | Egress allowlist for block mode (needs `github.com:443`, `api.github.com:443`) |

No secrets required — uses the auto-granted `GITHUB_TOKEN`.

### Internal building blocks (not called directly by consumer repos)

These reusables exist to be composed by the workflows above; consumer repos don't call them directly:

- **`preflight.yml`** — shared preflight for the AI reviewers (`claude-code` / `codex-code` / `gemini-code`). Determines whether a PR has code changes worth reviewing (skips docs/config-only PRs, saving ~$1–2 of LLM cost per PR at ~30s of runner time), enforces the same-repo-only gate, and honors the `@claude`/`@codex`/`@gemini` mention bypass. Takes `mention_keyword` + `reviewer_name` inputs; outputs `has_code`. `synchronize` is intentionally excluded (reviewers run on `opened`/`ready_for_review` only), and `.github/` changes are NOT treated as docs-only — CI config deserves review.

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
2. The `test-*.yml` self-test harnesses exercise the reusables against `_test-fixtures/` on every PR — keep them passing. `test-go-ci.yml`, `test-go-sec.yml`, and `test-graphify-graph.yml` run against `go-minimal/`; `test-ts-ci.yml` runs against `ts-minimal/`; `test-go-release.yml` runs against `go-release/`; `test-ts-release.yml` runs its static checks (yaml-lint, SHA-pin, registry-guard unit) on every PR but gates the **write-scoped** end-to-end dry-run publish against `ts-release/` to `push`/`workflow_dispatch` only — so unreviewed PR code never runs with `packages`/`id-token`/`attestations: write` (use `workflow_dispatch` to validate a branch end-to-end pre-merge). (The `review-{claude,codex,gemini}.yml` workflows dogfood the AI reviewers on this repo's own PRs.)
3. Tag new major versions (`vX.Y.Z`) after merge; consumers pin to the SHA of that tagged commit.

## Supply chain context

See https://linear.app/praetorianlabs/issue/ENG-3079 for the CI/CD supply chain hardening initiative that motivates this repo's design.
