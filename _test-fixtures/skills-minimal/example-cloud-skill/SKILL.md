---
name: example-cloud-skill
description: Use when validating the skill-quality reusable workflow against a well-formed skill — exercises every supported frontmatter field (name matching the directory, a non-empty description under 1024 chars, license, compatibility, metadata with string values, space-separated allowed-tools, in-vocabulary tags, and related links).
license: Proprietary
compatibility: Designed for Claude Code and guard-core
metadata:
  author: praetorian
  version: "1.0"
allowed-tools: Read Bash Grep Glob WebFetch
tags: [cloud]
related:
  - example-web-skill
---

# Example Cloud Skill

This is a fixture used only by `test-skill-quality.yml` to confirm the validator
accepts a fully-populated, spec-conformant `SKILL.md`. It has no real content.
