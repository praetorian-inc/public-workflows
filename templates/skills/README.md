# Skill Quality

Validate Agent Skill `SKILL.md` frontmatter against the
[agentskills.io specification](https://agentskills.io/specification) plus the
Praetorian grouped-skill-tag extension (`skill_tag_groups`) and related-link metadata.

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

- `skill_tag_groups`: non-empty YAML groups containing nonblank values from a
  controlled vocabulary (default `web,cloud,cicd,llm,cred`). Omit the field for
  untagged skills. Example:

  ```yaml
  skill_tag_groups:
    - [web, cloud]
  ```

- `metadata.related`: comma-separated string of skill links.

The removed top-level `tags` and `metadata.tags` formats are rejected; there is
no compatibility fallback.

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

Run from your skill repo root, pointing at the canonical script in a checkout
of `public-workflows` (or copy it locally):

```bash
pip install jsonschema PyYAML
VALIDATOR=path/to/public-workflows/templates/skills/validate-skills.py
python3 "$VALIDATOR"                       # validate */SKILL.md in cwd
python3 "$VALIDATOR" --dir path/to/skills
python3 "$VALIDATOR" --tags web,cloud,cicd,llm,cred # allowed group values
```

`validate-skills.py` is the canonical implementation; the CI workflow inlines an
identical copy so the check is atomically versioned with its pinned `@SHA`. Keep
the two in sync when changing validation rules.
