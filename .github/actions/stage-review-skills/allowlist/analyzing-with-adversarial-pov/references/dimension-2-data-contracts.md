# Dimension 2: Data Contracts

## Purpose

At every boundary between systems, components, or processing steps, verify that the producer's output matches the consumer's expected input.

## Method

### 1. Map Handoff Points

Identify every place where data crosses a boundary:

- System A writes to DB, System B reads from DB
- Service A calls API, Service B handles request
- Step 1 outputs JSON, Step 2 parses JSON
- Pipeline writes to field, Dashboard reads from field
- Agent creates artifact, Human reviews artifact

### 2. Check Each Handoff

For each handoff point:

```text
PRODUCER: {who creates the data}
CONSUMER: {who reads the data}
FORMAT EXPECTED: {what the consumer parses/expects}
FORMAT ACTUAL: {what the producer actually outputs}
SCHEMA ENFORCEMENT: {is there validation, or is it best-effort?}
MISMATCH: {if any, what specifically differs}
CONSEQUENCE: {silent corruption, crash, wrong behavior}
```

### 3. Consistency Check

When multiple producers create the same type of data:

- Do they use the same field names?
- Do they use the same value formats? (dates, enums, identifiers)
- Do they follow the same naming conventions?
- Would a consumer that works with Producer A also work with Producer B?

### Examples

**Good finding:**
> PRODUCER: Claude extraction prompt outputs `services_discussed` with v4.1 SKU codes (APPS, CLDS)
> CONSUMER: SF field `Services_Discussed__c` (Text 255) stores the raw string
> FORMAT EXPECTED: "APPS:web,api; CLDS:aws" (semicolon-delimited, colon-variant)
> FORMAT ACTUAL: Claude may output varied formats ("APPS (web, api)" or "Application Security: web, api")
> SCHEMA ENFORCEMENT: None -- Claude free-texts, parseDealSignals doesn't normalize format
> CONSEQUENCE: SF field contains inconsistent data across calls, making programmatic parsing unreliable

**Bad finding:**
> "The data might not be formatted correctly." (No specific handoff, no evidence)
