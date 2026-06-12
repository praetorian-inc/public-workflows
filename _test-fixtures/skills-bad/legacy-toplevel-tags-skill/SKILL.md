---
name: legacy-toplevel-tags-skill
description: Negative fixture — valid except it uses the legacy top-level `tags` key instead of `metadata.tags`. Strict agentskills.io rejects unknown top-level keys, so the validator MUST reject this (exit 1). Do not "fix" this fixture.
allowed-tools: Read Bash Grep
tags: [web]
---

# Bad Skill (legacy top-level tags)

Deliberately invalid under the strict agentskills.io schema. Tags belong under
`metadata` as a comma-separated string. Do not "fix" this fixture.
