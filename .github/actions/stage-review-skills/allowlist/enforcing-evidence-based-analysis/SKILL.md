---
name: enforcing-evidence-based-analysis
description: Use when creating implementation plans, analyzing existing code, or naming a root cause - prevents hallucination by requiring source file verification before making claims about APIs, interfaces, or code structure, and separates textual claims (provable by an accurate quote) from causal claims about what dominates latency, causes a failure, or what a fix will change (which require a measurement artifact or an explicit HYPOTHESIS label)
metadata:
  department: core
  category: process
  source: praetorian-core:skills/enforcing-evidence-based-analysis/SKILL.md
  source_sha: ac34ab6225a5
---

# Evidence-Based Planning

**Prevents hallucination during research and planning by requiring source verification before claims.**

> **You MUST track your progress** (use a task list or checklist) before starting analysis or planning tasks, recording which files you've verified and which claims need evidence. This prevents skipping verification steps.

## Core Principle

**If you didn't READ the file, you cannot claim to KNOW its contents.**

**If you didn't MEASURE it, you cannot claim to know what it CAUSES.**

This skill is complementary to `verifying-before-completion`:

- **verifying-before-completion**: Verifies OUTPUTS (tests pass, build succeeds) at END of work
- **enforcing-evidence-based-analysis**: Verifies INPUTS (source code, APIs) at BEGINNING of work

Together: Evidence-based inputs → Work → Verified outputs

---

## When This Skill Applies

Use this skill when:

- Creating implementation plans that modify existing code
- Analyzing codebases or architectures
- Documenting how systems work
- Writing code that uses existing APIs/interfaces
- Making claims about file contents or API shapes

**DO NOT skip this skill.** See [Why This Matters](references/why-this-matters.md).

---

## The Problem This Solves

Agents claim to know file contents, API shapes, and interface definitions WITHOUT actually reading the source files. They hallucinate plausible-looking code based on "common patterns."

**Real failure:** A frontend-lead created a 48KB implementation plan claiming to have "analyzed 10 files" and provided detailed TypeScript types. Every single API call was wrong - the agent ASSUMED what `useWizard` returns based on patterns instead of READING `useWizard.ts`. Three reviewers confirmed the plan wouldn't compile.

**Cost:** Hours of wasted implementation time, destroyed trust, broken plans.

---

## Classify the Claim BEFORE You Grade Its Evidence

Reading and quoting defeats hallucination. It does not defeat the second failure mode: **accurate quotes supporting a wrong conclusion.** Before citing anything, classify every load-bearing claim.

| Class | Asserts | Proved by |
| ----- | ------- | --------- |
| **Textual** | What the source contains | READ → QUOTE with `file:line` |
| **Causal** | What happens when it runs, why, or what a change will do — **when the answer turns on facts the quoted text does not fix** (data volume, index set, environment, load, the relative size of competing effects) | A **measurement artifact** |

**An accurate quote proves what the code says. Where the outcome turns on facts the text does not fix — data volume, index set, environment, load, the relative size of competing effects — it can never prove what dominates latency, what causes the failure, or what a change will do.** Those claims require a measurement artifact — a profile/query plan, a timing reported with the conditions that let a reader rule out confounders, **correlational** log or metric evidence with a **negative control** (a deterministic record of the event — a stack trace at the failing line — needs no control, and settles the proximate failure only), or a controlled before/after differential — or they MUST carry the label **`HYPOTHESIS`**.

**The discriminator:** could a competent engineer accept your quote as accurate and still disagree with your conclusion? If *no*, the claim is **textual**. If *yes*, ask the second question — **what would settle it?** Only the system running ⇒ **causal**. *More text* ⇒ still textual, merely **under-evidenced**. Answering *yes* is not by itself a verdict of causal; the two paragraphs below are the two ways it is not.

**The complement matters as much as the rule.** Where the quoted text alone settles the outcome — an unconditional dereference, an unreachable branch, a validation absent from every path — the discriminator returns *no* and the claim is **textual**, however much of it happens at runtime. Downgrading a statically provable defect to `HYPOTHESIS` misapplies this rule. The causal class begins where the text stops deciding.

**And a gap in the text is not a causal gap.** When what is missing is *other text you have not read* (a middleware chain, a route registration) or *intent nobody wrote down* (the range a loop was meant to cover), the claim is still textual and merely under-evidenced: go read it, or scope the claim to what you did read. Only the system running settles a causal claim — a measurement cannot supply a spec. See [Textual vs. Causal Claims](references/causal-claims.md).

Watch for causal verbs in your own draft — *is why, causes, the bottleneck, the primary defect, dominates, root cause, will fix, expensive* — and for **ranking**, which hides best: that two defects both exist is textual; that one is *primary* is not.

**Review does not substitute for measurement.** Multiplying readers within one evidence class multiplies confidence, not correctness — a second reader re-verifies the class you already satisfied and cannot reach the class you skipped.

**See:** [Textual vs. Causal Claims](references/causal-claims.md) for the `HYPOTHESIS` format, what counts as a measurement artifact, and a worked negative example — two fully compliant reviewers, 100% accurate quotes, wrong root cause.

---

## The Evidence-Based Protocol

**Two-phase workflow:** Discovery (read and document) → Planning (reference verified APIs).

**See:** [Complete Protocol](references/protocol.md) for detailed steps, examples, and documentation format.

**Key steps:**

1. **READ** source files
2. **QUOTE** actual code with line numbers
3. **DOCUMENT** findings before planning
4. **REFERENCE** verified APIs in your plan

---

## Anti-Hallucination Rules

| Rule                         | Why It Matters                               |
| ---------------------------- | -------------------------------------------- |
| **No quotes = No claims**    | If you can't quote source, you don't know it |
| **Memory is suspect**        | "I think it returns X" requires verification |
| **Patterns are assumptions** | "Most hooks return..." is NOT evidence       |
| **Read before write**        | Read the file before proposing changes       |
| **No measurement = No cause** | A quote proves what code says, never what it costs |

**See:** [Complete Anti-Hallucination Rules](references/anti-hallucination-rules.md)

---

## Red Flags - STOP Immediately

- About to describe an API without reading its source file
- Using "typically", "usually", "most X do Y"
- Providing interface definitions from memory
- Claiming file analysis without having actually read the file
- Confident about code you haven't seen this session
- Writing "the bottleneck", "the primary defect", or "root cause" with only `file:line` citations under it
- Ranking two defects by importance without having measured either
- Naming a cause for a slowness or failure report when no profile, timing, or log artifact exists yet

**See:** [Why This Matters](references/why-this-matters.md) for the real cost of skipping verification and the verification checklist.

---

## Common Rationalizations (DO NOT ACCEPT)

**DO NOT accept excuses like:**

- "I already know this API" → Knowledge cutoff is 18 months ago
- "Common React pattern" → Patterns are assumptions, not facts
- "No time to read files" → 30 sec now prevents 30 hours later
- "Every line I quoted is accurate" → Accuracy is the textual class; a causal claim was never in it
- "Another reviewer agreed" → Agreement within one evidence class is confidence, not correctness
- "It's obviously the slow part" → Obvious is a hypothesis; label it or profile it
- "I can't profile from here" → Then you can't name a cause from here — write `HYPOTHESIS` and name the instrument

**See:** [Complete Rationalization Table](references/rationalizations.md) for the full list and why each fails.

---

## Related Techniques

- A foundational workflow that can be invoked directly; apply it whenever creating implementation plans or analyzing existing code.
- When writing a plan, structure it around verified APIs; after implementing, verify outputs.
- During test-first development and debugging, check tests, code, and hypotheses against the actual source rather than assumptions.

---

## The Bottom Line

**Read the source. Quote the code. Then make the claim.**

**And if the claim is causal — measure it, or label it `HYPOTHESIS`.**

This is non-negotiable.
