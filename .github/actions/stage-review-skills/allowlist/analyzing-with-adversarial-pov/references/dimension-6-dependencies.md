# Dimension 6: Dependency & Sequencing

## Purpose

Verify that declared dependencies are complete, ordering is correct, and hidden dependencies are surfaced.

## Method

### 1. Dependency Graph

Draw the actual dependency graph from the artifact:

- For each task/step/component: what must exist before it can start?
- Are these dependencies declared? Or implied by context?
- Are there circular dependencies?

### 2. Hidden Dependencies

Common hidden dependencies:

- Environment variables that must be set
- Services that must be running
- Data that must be seeded
- Auth tokens that must be valid
- Schema migrations that must have run
- Previous pipeline runs that must have populated state

### 3. Clean Checkout Test

Mental simulation: "If I ran this on a brand new machine with nothing but the code, what fails first?"

- Missing directories that are assumed to exist
- Cached state from previous runs
- Local configuration not in version control
- Auth state from interactive login

### 4. Ordering Validation

- Can step N actually begin before step N-1 is fully verified?
- Are there steps that could run in parallel but are serialized?
- Are there steps that must be serial but aren't marked as blocking?
- If a middle step fails, what is the rollback/retry strategy?
