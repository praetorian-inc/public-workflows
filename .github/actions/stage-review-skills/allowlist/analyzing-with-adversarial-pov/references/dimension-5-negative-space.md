# Dimension 5: Negative Space

## Purpose

Find the signals, scenarios, actors, and failure modes that exist in the ecosystem but aren't addressed by the artifact.

## Method

### 1. Enumerate the Ecosystem

List every actor, system, signal source, and scenario class that interacts with or is affected by the artifact:

- Direct participants (systems the artifact explicitly integrates)
- Adjacent systems (systems that share data or users)
- Human actors (users, operators, customers, admins)
- External inputs (webhooks, APIs, feeds, manual actions)
- Environmental factors (time zones, network, permissions, quotas)

### 2. Check Coverage

For each element in the ecosystem:

- Does the artifact address it? If not, should it?
- What signals does this element produce that the artifact should react to?
- What happens when this element behaves unexpectedly?

### 3. Scenario Generation

Generate scenarios the artifact doesn't cover:

- **The empty case**: What if there's no data? No match? No response?
- **The duplicate case**: What if the same event fires twice?
- **The concurrent case**: What if two processes modify the same resource?
- **The stale case**: What if the data was correct when cached but changed since?
- **The partial case**: What if only half the operation succeeds?
- **The reversed case**: What if the user undoes what the system just did?
- **The scale case**: What if there are 10x the expected volume?

### Examples

**Good finding:**
> The pipeline handles external scoping calls but doesn't address internal sales meetings where the team discusses a deal without the customer present. These meetings often contain critical deal intelligence (pricing strategy, competitive positioning, resource allocation) that would enrich the same Opportunity. The internal call pipeline routes to Linear but never touches Salesforce.

**Bad finding:**
> "There might be other scenarios to consider." (No specific scenario, no consequence)
