---
name: bad-metadata-tag-skill
description: Negative fixture using the removed metadata.tags format. The validator MUST reject this with no compatibility fallback. Do not "fix" this fixture.
allowed-tools: Read Bash Grep
metadata:
  tags: "web,notavalidtag"
---

# Bad Skill (removed metadata.tags)

Deliberately invalid because `metadata.tags` is no longer accepted. Do not
"fix" this fixture.
