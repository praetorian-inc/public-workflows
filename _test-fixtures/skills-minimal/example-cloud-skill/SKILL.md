---
name: example-cloud-skill
description: Use when validating the skill-quality reusable workflow against a well-formed skill — exercises every supported frontmatter field, grouped single/multi-tag syntax, metadata related links, and space-separated allowed-tools.
license: Proprietary
compatibility: Designed for Claude Code and guard-core
metadata:
  author: praetorian
  version: "1.0"
  related: "example-web-skill"
skill_tag_groups:
  - [cloud]
  - [web, cicd]
allowed-tools: Read Bash Grep Glob WebFetch
---

# Example Cloud Skill

This fixture confirms the validator accepts fully populated, grouped-tag
frontmatter. It has no real content.
