---
name: <gerund-kebab-name>
description: Scaffold template — intentionally has a placeholder name that does NOT match its directory. The validator MUST skip `_`-prefixed dirs, so this file must not produce an error.
allowed-tools: Read, Bash
tags: [web]
---

# Template

If the validator did not exclude `_*` directories, this fixture's placeholder
`name` and comma `allowed-tools` would fail the positive self-test. Its presence
proves the exclusion works.
