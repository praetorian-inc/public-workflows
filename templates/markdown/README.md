# Markdown Quality Templates

Canonical configs for markdown-heavy repos. Provides two complementary quality layers:

| Layer | Tool | Mode | Purpose |
| --- | --- | --- | --- |
| **CI workflow** | `markdown-quality.yml` | `--check` (fail) | Enforcement gate on PRs |
| **Pre-commit hook** | `.pre-commit-config.yaml` | `--fix` (auto-fix) | Developer convenience on commit |

Both layers run the same tools with the same rules. CI catches AI agent commits that bypass local hooks.

## Setup

### 1. CI workflow (required)

Add `.github/workflows/markdown-quality.yml` to your repo:

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

### 2. Pre-commit hooks (recommended)

Copy these files to your repo root:

```bash
cp templates/markdown/.pre-commit-config.yaml <your-repo>/
cp templates/markdown/.markdownlint-cli2.jsonc <your-repo>/
```

Then install:

```bash
pip install pre-commit
pre-commit install
```

Commits are auto-formatted from this point forward.

## What each tool checks

**markdownlint-cli2** (structural quality):

- Heading levels, blank lines, list formatting
- Table structure (MD058)
- Code block fencing
- Trailing whitespace
- *Auto-fixable* with `--fix`

**prettier** (format alignment):

- Table column alignment and padding
- Consistent separator widths
- *Auto-fixable* with `--write`

## Customization

The CI workflow generates a default `.markdownlint-cli2.jsonc` if your repo doesn't have one. To customize rules, copy the template config and modify it — the CI workflow detects and uses your repo-local config automatically.

## Disabled rules (and why)

| Rule | Reason |
| --- | --- |
| MD013 (line length) | Tables, URLs, SQL payloads, and code blocks regularly exceed 80 chars |
| MD033 (inline HTML) | `<details>`, `<summary>`, HTML tables used for progressive disclosure |
| MD041 (first-line heading) | Skills start with YAML frontmatter (`---`), not headings |
| MD024 (duplicate headings) | Allowed in sibling sections (e.g., repeated "Usage" under different parents) |
