# Skill Quality

Validate Agent Skill `SKILL.md` frontmatter against the
[agentskills.io specification](https://agentskills.io/specification) plus the
Praetorian extensions (`tags`, `related`).

## Why

A malformed frontmatter block does **not** error in guard-core's skill loader —
`LoadSkillMetadata` returns `nil` on a parse failure, so the skill is silently
dropped from the platform with no log. Prettier-only markdown CI does not parse
frontmatter (`embeddedLanguageFormatting` is off), so this class of bug is
otherwise invisible until someone notices a missing skill. The `skill-quality`
reusable workflow makes invalid frontmatter a hard CI failure.

## What it checks

agentskills.io core:

- `name` (required): ≤64 chars, `[a-z0-9-]`, no leading/trailing/double hyphen,
  and **must equal the parent directory name**.
- `description` (required): 1–1024 chars, non-empty.
- `license`, `compatibility` (≤500), `metadata` (string values only),
  `allowed-tools` (space-separated, not comma) — optional.

Praetorian extensions:

- `tags`: list from a controlled vocabulary (default `web,cloud,cicd,llm,cred`).
- `related`: list of skill links.

Unknown top-level keys are rejected (catches typos like `descriptoin:` / `tag:`).
Directories starting with `_` or `.` (templates, dev-time `.local`/`.history`)
are skipped.

## CI usage

Add `.github/workflows/skill-quality.yml` to a skill repo:

```yaml
name: Skill Quality
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
permissions:
  contents: read
jobs:
  validate:
    uses: praetorian-inc/public-workflows/.github/workflows/skill-quality.yml@<SHA> # <tag>
    permissions:
      contents: read
```

## Local usage (pre-commit)

```bash
pip install jsonschema PyYAML
python3 validate-skills.py            # validate */SKILL.md in cwd
python3 validate-skills.py --dir path/to/skills
python3 validate-skills.py --tags web,cloud,cicd,llm,cred
```

`validate-skills.py` is the canonical implementation; the CI workflow inlines an
identical copy so the check is atomically versioned with its pinned `@SHA`. Keep
the two in sync when changing validation rules.
