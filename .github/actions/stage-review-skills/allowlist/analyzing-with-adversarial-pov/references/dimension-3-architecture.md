# Dimension 3: Architecture Justification

## Purpose

Challenge whether the design is the simplest that achieves the goal. Find unjustified complexity, existing mechanisms that could be extended, and ceremony masquerading as safety.

## Method

### 1. Component Inventory

List every component, layer, service, or step in the design. For each:

- What does it do?
- What would break if it were removed?
- Is there an existing mechanism in the codebase that already does this?

### 2. Simplification Test

For each component: "If I deleted this, what specifically fails?"

- If the answer is "nothing" or "we'd lose elegance": the component is unjustified
- If the answer is "X breaks": the component is justified, but check if X could be solved differently

### 3. Ceremony Detection

Human checkpoints, approval flows, and review steps. For each:

- What specific risk does this checkpoint mitigate?
- Has this risk actually materialized before? How often?
- What is the cost of the checkpoint (latency, human effort, context switching)?
- Would automated validation provide equal safety with less friction?

### 4. Build-vs-Extend

Search the codebase for existing patterns that do similar things:

```bash
grep -r "similar_pattern" --include="*.go" --include="*.ts" -l
```

- Is there an existing event system that could carry this signal?
- Is there an existing pipeline that could gain a new step?
- Is there an existing scheduler that could run this job?
