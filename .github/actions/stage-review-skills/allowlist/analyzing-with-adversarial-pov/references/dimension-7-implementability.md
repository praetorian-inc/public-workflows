# Dimension 7: Implementability

## Purpose

Determine whether someone can actually execute the artifact without ambiguity, and whether any requirements are impossible given reality.

## Method

### 1. Ambiguity Detection

For each instruction, acceptance criterion, or requirement:

- Is it specific enough to act on without interpretation?
- Would two engineers implement it the same way?
- Are there undefined terms or assumed knowledge?

### 2. Impossibility Check

For each requirement:

- Is it achievable given the actual API, framework, or system constraints?
- Does the codebase actually support the assumed extension point?
- Are there rate limits, quotas, or permissions that make this infeasible?

### 3. Missing Criteria

Requirements that should exist but don't:

- Error handling: what happens when this fails?
- Rollback: how do you undo this if it goes wrong?
- Monitoring: how do you know this is working?
- Documentation: what needs to be documented for the next person?
- Migration: what happens to existing data?

### 4. Environment Assumptions

- What runtime does this require? (Node version, Go version, Python version)
- What OS-specific features does this depend on?
- What network access is required? (internal services, external APIs, DNS)
- What file system state is assumed? (directories, permissions, disk space)
