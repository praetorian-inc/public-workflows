---
name: legacy-toplevel-tags-skill
description: Negative fixture using the removed top-level `tags` key instead of `skill_tag_groups`. The validator MUST reject this with no compatibility fallback. Do not "fix" this fixture.
allowed-tools: Read Bash Grep
tags: [web]
---

# Bad Skill (legacy top-level tags)

Deliberately invalid because top-level `tags` is no longer accepted. Tagged
skills must use `skill_tag_groups`. Do not "fix" this fixture.
