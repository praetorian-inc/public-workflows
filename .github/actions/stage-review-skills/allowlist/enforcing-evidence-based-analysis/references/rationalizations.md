# Common Rationalizations

**How agents bypass evidence-based planning and why each excuse fails.**

## The Rationalization Pattern

Agents frequently skip source verification with seemingly reasonable excuses. Each rationalization has a counter-argument that exposes why it fails.

## Rationalization Table

| Excuse                             | Why It Sounds Reasonable            | Reality                                                                           | Counter                                       |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| "I already know this API"          | You've seen it before in training   | Knowledge cutoff is 18 months ago. APIs change.                                   | Read the file. Takes 30 seconds.              |
| "Common React pattern"             | Most hooks follow conventions       | Conventions are assumptions, not facts. This hook might differ.                   | Verify against actual source.                 |
| "Simple to verify later"           | Can check after writing plan        | Later is too late - plan is already written and will mislead implementation.      | Verify NOW before making claims.              |
| "Just a quick analysis"            | Not worth full rigor for quick work | "Quick" often means "hallucinated". Quick work still needs accuracy.              | Quick READ prevents hours of fixes.           |
| "No time to read files"            | Reading files is slow               | Reading takes 30 seconds. Debugging broken plan takes 30 hours.                   | Time saved by reading far exceeds time spent. |
| "User didn't ask for verification" | User wants speed, not rigor         | User wants CORRECT answers. Speed with wrong info is worse than careful accuracy. | Evidence-based is the default, not optional.  |
| "File is too long to read"         | 1000-line file is overwhelming      | Read the relevant FUNCTION/INTERFACE, not entire file. Use line numbers.          | Target the specific API you need.             |
| "Already read similar file"        | Sibling file probably same pattern  | "Probably" is an assumption. Each file is unique.                                 | Read THIS file, not similar one.              |
| "TypeScript will catch errors"     | Compiler will validate later        | Yes, AFTER you write broken code. Prevention > detection.                         | Catch errors in PLAN, not implementation.     |
| "It's a small detail"              | Minor property name difference      | "Small" errors compound. Minor wrong assumption = broken plan.                    | All claims must be verified, no exceptions.   |
| "Every line I quoted is accurate"  | Full compliance with the read rules | Accuracy is the TEXTUAL class. A causal claim was never inside it.                | Classify the claim, then grade its evidence.  |
| "Another reviewer agreed"          | Independent confirmation            | Agreement within one evidence class multiplies confidence, not correctness.        | A second reader can't reach the class you skipped. |
| "It's obviously the slow part"     | The code visibly does extra work    | Visible work ≠ dominant cost. The 251x win is routinely somewhere else.           | Obvious is a hypothesis. Label it or profile it. |
| "I can't profile from here"        | No access to the running system     | True — and it means you can't name a cause from here either.                       | Write `HYPOTHESIS` and name the instrument.   |
| "The ticket already says why"      | Someone established the cause       | A ticket summary is textual evidence about a ticket, not a measurement.            | Ask for the artifact, or re-label it.         |
| "It happens at runtime, so it's causal" | Rule 9 sounds like it covers execution | Over-application. An unconditional deref or a missing check is settled by the quote alone. | Run the discriminator. Static certainty is textual. |
| "It's obviously off by one"          | The bound is right there in the quote | The bound is textual; whether it's WRONG needs the intended range, which the quote lacks. | Cite the spec, or scope the claim to the bound you proved. |
| "I'd have to read three more files"  | The quote you have is accurate       | Then your claim is under-evidenced, not causal. Unread text is not a measurement gap.      | Read them, or scope the claim to what you read. |
| "The stack trace points right at it" | A trace is a real artifact           | It settles the PROXIMATE failure. Why the value was bad is a fresh claim about another component. | Scope to the trace, or carry the label upstream. |
| "It's 3x faster after my fix"        | You measured before and after        | Not if workload, data, or cache state moved too. One noisy pair is variation, not a result. | Hold the sides comparable; repeat and report spread. |

## Deep Dive: Top 5 Rationalizations

### 1. "I Already Know This API"

**Full argument:**

> "I've worked with React hooks extensively. I know useWizard will return `currentStep`, `goNext`, and `goPrev` methods. Reading the file is unnecessary."

**Why it fails:**

- Knowledge cutoff: 18 months old
- This specific codebase might use different patterns
- Even if 90% similar, the 10% difference breaks your plan
- You're confusing "common pattern" with "actual implementation"

**Evidence from wizard failure:**

- Agent "knew" hooks return flat objects
- Actual useWizard returned nested `{navigation, progress, validation}`
- Every API call in 48KB plan was wrong
- Three reviewers confirmed: won't compile

**Counter:**

> "Your training data is from 2024. This code is from 2025. Read the file."

### 2. "Common React Pattern"

**Full argument:**

> "99% of wizard implementations use `label` for step titles. I can safely assume this one does too."

**Why it fails:**

- "99%" is made up - you don't have statistics
- The 1% case is this specific codebase
- Assumptions compound - multiple "safe" assumptions = broken plan
- "Probably correct" ≠ "verified correct"

**Evidence from wizard failure:**

- Agent assumed `WizardStep` has `label` property (common pattern)
- Actual interface uses `title` and requires `order` property
- All step definitions in plan were invalid
- TypeScript would reject every single one

**Counter:**

> "Patterns are assumptions. This skill requires facts. Read the file."

### 3. "No Time to Read Files"

**Full argument:**

> "User wants fast results. Reading 10 files will take too long. I'll work from patterns and user can fix details later."

**Why it fails:**

- Reading 10 files = 5 minutes
- Debugging broken plan = 5 hours
- User wants CORRECT results, not FAST wrong results
- "Fix details later" means "entire plan is broken"

**Evidence from wizard failure:**

- Agent skipped reading to produce "comprehensive" 48KB plan quickly
- Plan looked impressive but was 100% broken
- Would have wasted HOURS of implementation time
- Three reviewers had to verify independently = wasted MORE time

**Counter:**

> "5 minutes of reading prevents 5 hours of debugging. Read the files."

### 4. "Just a Quick Analysis"

**Full argument:**

> "User asked for a quick overview, not a detailed implementation plan. I don't need full rigor for quick work."

**Why it fails:**

- "Quick" is scope, not accuracy level
- Quick wrong answer is worse than slightly slower correct answer
- User will ACT on your "quick analysis"
- If you can't verify it, don't claim it

**Counter:**

> "Quick analysis still requires verified facts. Read the files you reference."

### 5. "TypeScript Will Catch Errors"

**Full argument:**

> "Even if I get some details wrong, TypeScript compiler will catch them during implementation. Prevention at planning stage is overkill."

**Why it fails:**

- Yes, TypeScript catches errors... AFTER you waste time writing broken code
- Plan with wrong APIs misleads developer down wrong path
- Developer might not realize plan is fundamentally broken
- Fixing errors one-by-one is slower than preventing them all

**Evidence from wizard failure:**

- Plan would have failed TypeScript compilation
- Developer would need to rewrite entire plan from scratch
- All 15 tasks would need to change
- Estimate would go from "2-4 hours" to "8-12 hours"

**Counter:**

> "TypeScript catches errors in code. Evidence-based planning catches errors in PLANS. Read the files."

## How to Resist Rationalizations

### Trigger: You're About to Make a Claim

**Ask yourself:**

1. Did I read the source file?
2. Did I quote the actual code?
3. Am I using words like "typically", "probably", "usually"?
4. Am I confident WITHOUT evidence?

**If any answer is YES to #3-4 or NO to #1-2:** You're rationalizing. Stop. Read the file.

### Trigger: You Feel Time Pressure

**Ask yourself:**

1. Will reading this file take more than 60 seconds?
2. Will debugging a broken plan take more than 60 minutes?
3. Which is the better investment?

**Answer:** Always read. Always.

### Trigger: User Wants "Quick" Results

**Remember:**

- Quick wrong answer: User acts on false info, wastes hours
- Slightly slower correct answer: User succeeds on first try
- User wants CORRECT, not necessarily FAST

## The Bottom Line

**Every rationalization is an excuse to hallucinate.**

When you catch yourself making ANY excuse for not reading source files:

1. Stop
2. Read the file
3. Quote the code
4. Then make the claim

No exceptions. No shortcuts. No rationalizations.
