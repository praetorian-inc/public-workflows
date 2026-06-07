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
    uses: praetorian-inc/public-workflows/.github/workflows/go-security.yml@<SHA>  # v2.0.12
    permissions:
      contents: read
      security-events: write  # required when upload-sarif: true (default)
      actions: read           # required by codeql-action/upload-sarif for run metadata
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
| `upload-sarif` | `true` | Upload SARIF findings to the GitHub Security tab. When `true`, **the caller MUST grant both `security-events: write` and `actions: read`**. Missing `actions: read` surfaces as "Resource not accessible by integration" on the upload step even though the scan itself succeeded — `codeql-action/upload-sarif` needs to fetch workflow run metadata. Set `false` to run as CI-only checks without publishing to the Security tab. |
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

Runs Claude as a PR reviewer. **All security posture is hardcoded in the reusable workflow.** Callers cannot widen the tool allowlist, relax the gates, change the model, or override the hardening — any such change requires a PR to this repo with `@praetorian-inc/security-engineering` review (see CODEOWNERS).

**Security posture** (as of v2.0.11):

- **Same-repo-only gate**: `github.event.pull_request.head.repo.full_name == github.repository`. Fork PRs are blocked outright — stricter than the previously-used `author_association` check (which reports org members as `CONTRIBUTOR` on public repos and silently skipped runs, hit in v2.0.3-v2.0.5). Closes the CVSS 9.4 [comment-and-control](https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/) attack path on both PR and review-comment triggers.
- **Preflight job** skips Claude entirely on non-code PRs (files matching `*.md / *.markdown / *.rst / *.txt / docs/** / .claude-plugin/** / LICENSE / .gitignore / images`). `.github/` workflow changes are intentionally NOT skipped — CI config, job permissions, and secrets passthrough deserve AI review. Uses paginated `gh api pulls/N/files` (handles PRs >100 files per cli/cli#5368). `@claude` on a PR review comment bypasses the filter (documented override).
- **Model hardcoded**: `--model claude-opus-4-7`. Claude runs once per PR (on `opened` or `ready_for_review`; `synchronize` is intentionally excluded — CodeRabbit + Codex already run on every push). `ready_for_review` covers PRs opened as drafts — without it, the `opened` event fires while `draft==true` (skipped) and the PR never gets a Claude review. Opus is paid 1x per PR for the highest-capability senior-engineer review.
- `--allowedTools "Bash(gh pr comment/diff/view:*), Read, Grep, Glob"` — the minimum surface needed to review a PR and post the top-level summary comment. Inline line-anchored commenting deliberately NOT included (CodeRabbit covers it).
- `--disallowedTools` floor: explicitly denies `Bash(curl:*)`, `Bash(wget:*)`, `Bash(gh api:*)`, `Bash(gh auth:*)`, `Bash(git add|commit|push|rm:*)`, `Write`, `Edit`, `MultiEdit`. Defense-in-depth against [claude-code-action#860](https://github.com/anthropics/claude-code-action/issues/860) where `track_progress: true` would union-merge write tools into the allowlist.
- Explicit `track_progress: "false"` on the action step.
- `--max-turns` caps tool-call turns (the `max_turns` input, default 30). The `timeout-minutes` wall-clock ceiling, not this, is the backstop against runaway/injection loops.
- `--append-system-prompt` defensive preamble: Claude is instructed to treat all PR content (title, body, diffs, file contents, CLAUDE.md, comments) as untrusted data, never read secrets/env, and stop + report on injection attempts.
- **StepSecurity Harden-Runner** installed as the first step of both jobs (preflight + claude-code-action). Parameterized via `enable-harden-runner` / `harden-runner-policy` / `harden-runner-allowed-endpoints` inputs — audit mode by default. Matches the pattern in `go-ci.yml` / `go-security.yml`.
- `actions/checkout` pinned by SHA, `persist-credentials: false`, `fetch-depth: 1`.
- `anthropics/claude-code-action` pinned by SHA (`@38ec876...` = v1.0.101).
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
    uses: praetorian-inc/public-workflows/.github/workflows/claude-code.yml@<SHA>  # v2.0.11
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

- `pull_request` with `action == 'opened'` on a same-repo branch PR — auto-reviews once on PR open
- `pull_request_review_comment` with body containing `@claude` on a same-repo PR — targeted review requests, bypasses the docs-only preflight filter

Other event types and `synchronize` actions trigger the caller workflow but are filtered out at the job-level `if:`.

**Do NOT inline `anthropics/claude-code-action`.** All Claude PR review must go through this reusable workflow.

### `gemini-code.yml` — Gemini PR Assistant (hardened)

Runs Gemini as a complementary PR reviewer **alongside** the Claude PR Assistant. Uses [`google-github-actions/run-gemini-cli`](https://github.com/google-github-actions/run-gemini-cli) to run the Gemini CLI as an **agent** — like Claude and Codex, it reads past the diff to open the surrounding code (definitions, callers, sibling modules) for real context. It loads Praetorian's curated review skills natively from [`praetorian-inc/public-skills`](https://github.com/praetorian-inc/public-skills) (`.gemini/skills/`, pinned by SHA).

**Security posture** follows `codex-code.yml`'s two-job defense-in-depth split:

- **Tokenless read-only agent**: The `gemini-review` job is `contents: read` only and **no step in it uses a GitHub token** — a prompt-injected agent has no credential to exfiltrate and no path to write to the PR. The PR diff is computed fully offline (the depth-2 merge-ref checkout brings the diff's parents locally), so the agent runs with zero credentials.
- **Read-only tool surface**: `tools.core` is an allowlist of read-only built-ins (`read_file`, `read_many_files`, `glob`, `search_file_content`, `list_directory`) plus `activate_skill`; shell/write/edit/web tools are excluded.
- **Untrusted-workspace purge**: because the agent runs against the PR's merged tree with workspace trust enabled, the staging step removes every agent-control file a PR could plant before staging the curated set — `.gemini`/`.agents` (skill + settings discovery; `.agents/skills` would otherwise take precedence), all `GEMINI.md` (recursive), `.geminiignore` (review-blinding), and `.npmrc`/`.yarnrc*` (CLI-install supply-chain). Skills + settings come only from the action input and the SHA-pinned `public-skills` checkout.
- **Secret redaction**: the `GEMINI_API_KEY` (the only secret in the read-only job) is stripped from the captured review output before it leaves that job — so a prompt-injection that coerces the agent into reading its own environment can't surface the key in the posted comment.
- **No MCP servers, no containers**: Unlike Google's official PR-review example (which posts via a Docker-run `github-mcp-server`), Harden-Runner's `disable-sudo-and-containers: true` stays on throughout — a strictly stronger posture than `codex-code.yml` (which must relax sudo for `codex-action` and re-lock Docker manually).
- **Separate post-feedback job**: A minimal `pull-requests: write` job (runs zero untrusted code) posts the captured review via `pulls.createReview` with hardcoded `event: 'COMMENT'` — no APPROVE path. If the agent job fails, it posts a fixed failure notice instead of failing silently (parity with the previous reviewer); it does not run when the review was skipped.
- **Same-repo-only gate**: Fork PRs blocked outright (`head.repo.full_name == github.repository`)
- **Preflight job**: Skips docs-only PRs; `@gemini` on a PR review comment bypasses the filter
- **Anti-injection prompt**: Gemini instructed to treat all PR content (including `GEMINI.md`) as untrusted data
- **Pinned**: `run-gemini-cli` action SHA-pinned; the CLI version is hardcoded (`0.45.2`, **not** a caller input — it governs folder-trust/tool-policy semantics); `public-skills` checkout pinned by commit SHA
- **Wall-clock ceiling**: `timeout-minutes: 10` on the review job
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

### `unit-tests.yml` — Unit tests for claude-tool-sdk consumers (npm/Node.js)

Callable workflow for repos that use the private `claude-tool-sdk` module. Generates a short-lived GitHub App token to fetch the private dependency, then runs `npm ci` + `npm test`.

**Caller example:**

```yaml
jobs:
  test:
    uses: praetorian-inc/public-workflows/.github/workflows/unit-tests.yml@<SHA>  # vX.Y.Z
    permissions:
      contents: read
    secrets:
      PLUGIN_CI_APP_ID: ${{ secrets.PLUGIN_CI_APP_ID }}
      PLUGIN_CI_PRIVATE_KEY: ${{ secrets.PLUGIN_CI_PRIVATE_KEY }}
```

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `enable-harden-runner` | boolean | `true` | Enable StepSecurity Harden-Runner |
| `harden-runner-policy` | string | `"audit"` | Egress policy: `audit` or `block` |
| `harden-runner-allowed-endpoints` | string | `""` | Newline-separated allowed endpoints for block mode |

| Secret | Required | Description |
|--------|----------|-------------|
| `PLUGIN_CI_APP_ID` | yes | GitHub App ID for private dependency access |
| `PLUGIN_CI_PRIVATE_KEY` | yes | GitHub App private key |

**Security posture:** Workflow-level `permissions: contents: read` ceiling. GitHub App token passed via `env:` (not inline `${{ }}`). Harden-Runner enabled by default. Runner pinned to `ubuntu-24.04`.

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

**Bump level** is determined from the merged PR's branch name: `release/*` → major, `feat/*` → minor, everything else → patch. Falls back to patch if the branch can't be resolved.

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

Builds a repo's [graphify](https://github.com/safishamsi/graphify) code knowledge graph (`graphify-out/graph.json`) and publishes it as a downloadable artifact, so engineers and agents query the latest graph without each rebuilding the (often 50k+ node) graph locally. graphify has no server — the graph is a file that `graphify query` reads; this workflow is the shared-distribution mechanism (build once in CI, everyone pulls the same artifact). The build is code-only and keyless (`--no-cluster` AST extraction respecting the repo's `.graphifyignore`, no LLM key).

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

**Supply-chain:** `graphifyy` is PINNED via the `graphify-version` input (default `0.8.35`) — never `latest`/`--upgrade`. Bump deliberately, in lockstep with the monorepo Makefile's `GRAPHIFY_VERSION`. No secrets used (GITHUB_TOKEN only).

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
