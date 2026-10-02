# Textual vs. Causal Claims

**An accurate quote proves what the code says. It can never prove what dominates latency, what causes a failure, or what a fix will change.**

Reading and quoting source defeats *hallucination* — claiming the code says something it does not. It does nothing about the second failure mode: claiming, on perfectly accurate quotes, that the thing you read is the thing responsible. Every citation can check out and the conclusion still be wrong.

---

## The two classes

| Class | Asserts | Provable by | Example |
| --- | --- | --- | --- |
| **Textual** | What the source contains | READ → QUOTE with `file:line` | "`mergeStatus` returns `'pending'` if any input is pending" |
| **Causal** | What happens when it runs, why, or what a change will do — **when the answer turns on facts the quoted text does not fix** | A **measurement artifact** | "the merged status is why the page is slow" |

Quoting is necessary for both and sufficient only for the first.

### The discriminator

Ask: **could a competent engineer accept my quote as accurate and still disagree with my conclusion?**

- **No** — the quote and the claim are the same statement. Textual.
- **Yes** — the claim adds something the quote does not contain. Now ask a second question: **what would settle it?** If only the system running would — it is **causal**, and needs a measurement or a `HYPOTHESIS` label. If *more text* would (an unread middleware chain, a specification), the claim is still textual and merely **under-evidenced**: go read it, or scope the claim down. See **A third gap** below — answering *yes* here is not by itself a verdict of causal.

A faster surface test: does the claim survive unchanged if the code is identical but the runtime facts differ (different data volume, different index set, different tenant, different hour)? If the claim could flip while every quoted line stays byte-identical, it is causal.

### Static certainty is textual — do not over-apply this rule

"Happens at runtime" is **not** the boundary. Plenty of defects are settled by the quoted text alone, and those are textual claims that a citation fully proves:

| Claim | Why it is textual |
| --- | --- |
| "this dereferences `resp.Body` on every transport error — the `err` return is never checked" | No runtime fact can make the absent check present |
| "this branch is unreachable: the guard above returns on the same condition" | Determined by the control flow you quoted |
| "this handler performs no authorization check on any path" | An exhaustive property of the text |
| "this retry loop has no backoff — it calls `Do` again immediately on each iteration" | Both facts are in the quoted body |

Each survives the discriminator: an engineer who accepts the quote **cannot** disagree, because the quote and the conclusion are the same statement. Each survives the surface test too — nothing about data volume, tenant, or hour flips it.

**Requiring a measurement for these is a misapplication, not a strict reading.** It downgrades sound, statically provable findings to hypotheses and buries them. The causal class begins exactly where the quoted text stops deciding — **attribution of cost**, **precedence between two real defects**, and **prediction of what a change will produce**, all of which depend on facts no citation contains.

The two failure modes are symmetric, and both are errors:

- Calling a causal claim textual because the quotes are accurate → the ENG-5367 failure below.
- Calling a textual claim causal because it concerns runtime → a real defect labelled `HYPOTHESIS` and discounted.

When in doubt, run the discriminator rather than reaching for either default.

### A third gap: facts that are neither in the quote nor in a measurement

Some claims fail the discriminator without being causal, because what is missing is **other text you have not read** or **intent nobody wrote down**. Measuring is the wrong remedy for both, and neither belongs under Rule 9.

| Claim | What is actually missing | Remedy |
| --- | --- | --- |
| "this loop is off by one — it stops at `len-1`" | The **specification**. The bound is textual; whether it is *wrong* depends on the intended range, which no quote of the loop contains | Cite the intended range, or scope the claim to what you can prove: "this stops at `len-1`; if the final element is meant to be processed, that is off by one" |
| "this endpoint is unauthenticated" — on a quote of a handler with no auth check | **Unread text**: the middleware chain, the route registration, the gateway config | Read them. The handler-scoped claim ("this handler performs no authorization check on any path") was already provable; the endpoint-scoped one needs the rest of the request path |

Route by what would settle the question:

- The quoted text settles it → **textual**. Cite it (Rules 1–8).
- **More text** would settle it → still textual, and **under-evidenced**. Go read it, or scope the claim down to what you did read. Do not label it `HYPOTHESIS`, and do not ask for a profile — a measurement cannot supply a spec or a middleware chain.
- Only **the system running** would settle it → **causal** (Rule 9). Measure it, or label it.

The middle row is the one that gets misfiled in both directions: shipped as a finished finding when it is an assumption, or discounted as a hypothesis when thirty seconds of reading would have closed it. "Defect" claims that turn on intent — off-by-one, wrong default, wrong ordering — land here far more often than they land in either of the other two.

### Causal language to catch in your own draft

`is why` · `causes` · `the bottleneck` · `the primary defect` · `dominates` · `root cause` · `is slow because` · `will fix` · `will reduce` · `hot path` · `expensive` · `doubles cost` · `blocks` · any ranking of two defects against each other.

Ranking is the one that hides best. "A is the *primary* defect" is a causal claim about A **and** B even when both are textually verified to exist — existence is textual, precedence is not.

---

## What counts as a measurement artifact

The artifact must come from the system running, and must be reported with enough context to be re-taken:

- **A profile or query plan** — `PROFILE`/`EXPLAIN ANALYZE` output, DbHits, a flame graph, a sampling profiler run.
- **A timing measurement**, with the unit, the environment/tenant, and the conditions a reader needs to rule out confounders. Taken from a **live system**, that includes a **UTC timestamp** — not because a timestamp is itself evidence for your cause, but because without one nobody can check the number against the deploys, incidents, and neighbouring load that were running at the same moment. Taken from a **controlled benchmark**, the isolation *is* the control: state what you held fixed and the timestamp is optional. A number reported with neither is not re-takeable, and an unre-takeable number is not a measurement artifact.
- **Logs or metrics**, with the control the evidence's shape demands. **Correlational** evidence — this line appears in the slow requests, this metric is elevated during the incident — needs a **negative control**: the same measurement on a comparable surface that does *not* exhibit the symptom. If your marker is present there too, you have measured the environment rather than your cause. (The term is load-bearing — a control is *negative* because the symptom is absent from it. Asking for a "positive control" sends a reviewer to another symptomatic surface, which cannot show the correlation is spurious.) A **deterministic record of the event itself** — a stack trace at the failing line, a rejection logged with the offending input, a panic — needs no control: it identifies the failure directly rather than inferring it from co-occurrence. Requiring a control there is the same over-application as requiring a profile for a static defect. **But note what such a record proves**: it establishes the **proximate** failure — what failed, and where — not why the value was bad. "The worker panicked dereferencing a nil `amount` at `charge.go:88`" is settled by the trace; "the root cause is the upstream producer omitting `amount`" is a *fresh* causal claim about a different component, and the trace is not evidence for it. A race, an upstream mutation, or an invalid producer can each be the actual origin. Scope the claim to what the record covers, or carry the label further up the chain.
- **A before/after differential** from actually applying the change — valid only if the two sides are comparable. Hold workload, data set, and cache state equivalent, and say so. On a **deterministic instrument** (query plan, DbHits, allocation count, query count) a single pair is enough. On a **noisy one** (wall-clock, p99, throughput) a single pair is not evidence: repeat it, report the spread, and confirm the difference exceeds the run-to-run variation you measured. An uncontrolled before/after is how unrelated runtime variation gets promoted to a proven cause — the exact failure this skill exists to prevent.

A code comment asserting a performance property is **textual evidence about a comment**, not a measurement. So is a ticket's summary, a PR description's claim, and a prior reviewer's conclusion.

## The HYPOTHESIS escape hatch

You are not required to measure before you may speak. You are required to **label**. When a causal claim is load-bearing and you have no artifact:

```markdown
HYPOTHESIS: <the causal claim>
  Textual evidence: <file:line quotes — what you actually verified>
  Not yet established: <the causal step the quotes do not cover>
  Measurement that would confirm or kill it: <the specific artifact>
```

A labelled hypothesis is honest work and can ship in a plan or a review. An unlabelled one is the failure this skill exists to prevent. **Never** let a `HYPOTHESIS` become an unlabelled conclusion further down the same document — restating it in the summary without the label is the most common way the label gets lost.

---

## Worked negative example — ENG-5367

An accurate brief that endorsed a wrong root cause. Both reviewers complied fully with the textual rules; the amended rubric fails them anyway.

### What happened

**Report:** "Technologies list page is slow to load." No repro data supplied.

Two independent reviewers analysed the surface, and their textual work was **good** — good enough to refute the ticket's original hypothesis on three separate counts (that `allQuery` was unbounded, that it was used only for `isAllEmpty`, and that it doubled load on every filter change). Each refutation was quoted at `file:line` and each was correct; guard PR #7207's own description later confirmed the refutation independently: *"The ticket's hypothesis about the unbounded `allQuery` is incorrect — that query is 901 DbHits and fast."*

Having cleared away the wrong answer, the corrected brief then named a new one:

> **1. The full-page spinner is gated on the SLOWER of two independent Neo4j round-trips.** This is the primary defect and it was missed in the original analysis.

backed by four accurate citations — the status merge, `mergeStatus`'s pending semantics, the `isInitialLoading` derivation, and the blocking spinner render.

**The actual cause was a missing Neo4j composite index.** guard PR #7207: **one added line** in `backend/template.yml`, `151,501 → 602 DbHits` — a 251× reduction — closing the ticket.

### Why the rubric fails it

Apply the discriminator to *"This is the primary defect"*: could an engineer accept every one of those four quotes as accurate and still disagree? Yes — and the engineer who ran `PROFILE` did. The quotes establish that the spinner waits on both queries. **Precedence over an unprofiled query plan is not in any of them.** Causal claim, zero measurement artifacts, no label. It fails.

Note where the evidence actually sat: the brief was not ignorant of `template.yml` — it named the file, as backend scope for a *different, lower-ranked* fix. The index was one line away from something the reviewers had already read. What went wrong was not coverage. **It was ranking two candidates without measuring either**, which no amount of additional reading can fix.

### The same brief got it right once

The brief's own refutation #4 shows the correct discipline, applied in one place and not the other:

> whether that doubles *cost* is *unproven* — the two queries have different plan shapes […] and nobody has run a `PROFILE`.

That is a properly withheld causal claim, in the same document as the unlabelled one. Its acceptance criteria go further still, demanding a control measurement before any code change: *"If both are equally slow, the cause is ENG-4049 and this ticket should be closed as a duplicate."* The discipline was available and was simply not applied to the claim that mattered.

### The lesson that generalizes

Two reviewers, full compliance, accurate quotes, wrong conclusion. **Review multiplied within one evidence class multiplies confidence, not correctness.** A second reader who checks your quotes re-verifies the class you already satisfied and cannot reach the class you skipped. If the conclusion is causal, the only thing that moves it from confident to correct is an instrument.

---

## Dogfood: how the amended rubric grades ENG-5367

| Brief claim | Class | Evidence held | Verdict |
| --- | --- | --- | --- |
| `allQuery` and `query` produce different cache keys ⇒ two POSTs | Textual | 4 accurate `file:line` cites | **PASS** |
| `allQuery` is bounded at 100 rows (refutes "unbounded") | Textual | backend cap quoted | **PASS** |
| `allQuery` has five uses, not one | Textual | five `file:line` cites | **PASS** |
| Spinner waits on both round-trips | Textual | 4 accurate cites | **PASS** |
| **"This is the primary defect"** | **Causal** | the same 4 textual cites | **FAIL** → `HYPOTHESIS` |
| "whether that doubles cost is unproven … nobody has run a `PROFILE`" | Causal, withheld | none, and says so | **PASS** |

One row flips. Both reviewers would have been forced to write:

```markdown
HYPOTHESIS: the merged-status spinner gate is the primary cause of slow load.
  Textual evidence: the status merge, mergeStatus pending semantics,
    isInitialLoading, and the blocking spinner render — all verified.
  Not yet established: that this gate dominates the two queries' server time.
  Measurement that would confirm or kill it: PROFILE on both queries for a
    named tenant, plus per-request timing from the Network panel.
```

That measurement is exactly the one that, when finally run, produced 151,501 DbHits on the main query and sent the fix to `template.yml` instead. **The label would not have found the index — it would have stopped the wrong fix from being called the right one, and named the instrument that finds it.** That is the whole return on this rule.

---

## See also

- **Forthcoming, not yet available:** the performance-domain instantiation of this rule — an instrument ladder for latency reports — is scoped as `triaging-performance-reports` in sibling ticket LAB-5283. That skill does **not** exist in the catalog yet, so do not attempt to resolve it; apply the general rule above to latency reports until it lands.
- [Anti-Hallucination Rules](anti-hallucination-rules.md) — the textual-class rules this extends.
- [Rationalizations](rationalizations.md) — excuses for skipping verification.
