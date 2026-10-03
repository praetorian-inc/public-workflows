# Dimension 1: Reality Check

## Purpose

Verify every claim the artifact makes about the codebase, infrastructure, or system behavior by reading actual source files and tracing execution paths.

## Method

### 1. Extract Claims

Read the artifact and list every statement that asserts something about the codebase:

- "Function X does Y"
- "Field Z exists on object W"
- "The pipeline works by..."
- "This is configured in..."
- Implicit claims: "We'll extend X" (assumes X exists and is extensible)

### 2. Verify Each Claim

For each claim:

```text
CLAIM: {what the artifact says}
FILE: {actual file path}
EVIDENCE: {what the file actually shows, with line numbers}
VERDICT: CONFIRMED | STALE | INCORRECT | PARTIAL
CONSEQUENCE: {if incorrect, what breaks}
```

### 3. Trace Execution Paths

Don't just grep for symbol names. Follow the actual execution:

- Read the function definition
- Read what calls it
- Read what it calls
- Check error handling paths
- Check the data it operates on

### Examples

**Good finding:**
> CLAIM: "triggerAsyncTicketSync is called when risk status changes"
> FILE: guard-core/backend/pkg/services/risk/service.go:247
> EVIDENCE: triggerAsyncTicketSync is only called in UpdateRiskStatus, not in BulkUpdateRisks. Bulk operations skip the sync entirely.
> VERDICT: PARTIAL
> CONSEQUENCE: Bulk risk status changes won't trigger ticket creation, breaking the OODA feedback loop for batch triage.

**Bad finding:**
> "The risk service might not handle all cases correctly." (No file, no evidence, no consequence)
