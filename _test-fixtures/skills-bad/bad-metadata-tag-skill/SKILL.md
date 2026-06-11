---
name: bad-metadata-tag-skill
description: Negative fixture — valid except that metadata.tags contains a value outside the controlled vocabulary (web,cloud,cicd,llm,cred). The validator MUST reject this (exit 1). Do not "fix" this fixture.
allowed-tools: Read Bash Grep
metadata:
  tags: "web,notavalidtag"
---

# Bad Skill (out-of-vocabulary metadata.tag)

Deliberately invalid: `notavalidtag` is not in the controlled vocabulary. Do not
"fix" this fixture.
