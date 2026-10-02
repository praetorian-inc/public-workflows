# Authoring evidence — 2026-09-26

Tracking: [LAB-7029](https://linear.app/praetorianlabs/issue/LAB-7029).

## Scope and discovery

One general coding skill, no application changes or enforcement runtime. The
repository's canonical skill schema and description rubric govern the artifact.

Discovery used `cohesion`, `modular`, and `overengineer` against skill names,
bodies, and references; the exact skillctl in-flight gate; and paginated open
Linear searches with complete issue/comment reads. Reviewed and classified:
36 catalog candidates, all 47 returned open PR candidates, and 25 open issues.
No same-purpose/same-outcome duplicate found within that coverage.

Closest catalog neighbors were `enforcing-information-architecture`
(React/Guard-specific), `preferring-simple-solutions` (abstraction cost), and
`code-simplification` (behavior-preserving refactoring). Language structure skills
remain specialist companions. PRs #779, #1052, #615, and #164 were related but
distinct; LAB-6897 targets concrete implementation cleanup and LAB-5092 targets
one probe interface. Neither creates the proposed general standard.

Discovery is purpose-based comparison of the returned candidates, not proof that
literal searches find every paraphrase or a line-by-line review of unrelated code.
Full classifications and local trial artifacts are retained under `.local/` in the
authoring worktree. No customer finding bodies or credentials are committed.

## Baseline design handoff

Tier: fresh independent Codex CLI contexts for executor and evaluator, subscription
authentication, ephemeral sessions. The executor saw an opaque scratch path and
task prompt; the hypothesis was supplied only to the evaluator. No model override.

Three scenarios tested deadline/file-count pressure on a mixed entrypoint,
line-count pressure on a cohesive Rust parser with inline tests, and sunk-cost
pressure to add a Python provider/CLI abstraction over an existing SDK.

Independent verdict: **GAP_NOT_FOUND**. The prompt was judged uncontaminated and
all three cases passed before the new skill existed. Verbatim artifact choices:

> Ship one focused extraction into `src/session.js`, wired from `src/main.js`.

> Keep the 170-line parser and its 300 lines of unit cases together in
> `src/report.rs`, including `#[cfg(test)] mod tests`.

> Ship the existing provider's `put_object` path.

Reconsideration: the user explicitly requested a reusable general standard. The
skill codifies that standard; this baseline does **not** demonstrate a behavioral
gap or a causal improvement. The creating-skills workflow's GAP_CONFIRMED criterion
is not satisfied. Do not relabel a passing baseline as RED failure or claim full
RED/GREEN repair proof.

## Premise review — PROCEED for codification

Trigger: a new behavior-defining skill, so prose is not an exemption. The natural
layer is reusable development guidance; the chosen layer is one catalog skill.
This is a requested standard, not a demonstrated fix for a reproduced runtime bug.

1. **CONFIRMED:** the requested artifact is a general code-organization skill.
   LAB-7029 Goal and Scope reflect the explicit user request; this file's discovery
   section records the inspected alternatives and their narrower outcomes.
2. **UNVERIFIED as a repair claim, excluded from the shipping premise:** the new
   skill corrects agent failures or reliably forces every future agent to comply.
   The independent baseline above passed, so neither claim is made. Guided tests
   assess conformance, not causal improvement or automatic activation.
3. **CONFIRMED for normative scope:** meaningful ownership is the criterion, not
   universal 300–400-line limits. SKILL.md's “File size prompts a decision” section
   labels the number as an authored heuristic and honors explicit repository limits;
   its official sources support ecosystem-specific layout choices.
4. **CONFIRMED:** the catalog is the appropriate delivery layer. The existing
   buildIndex/resolveSkill handler smoke check resolves the new content without
   a new runtime or hook. The served artifact is one 172-line SKILL.md.

Dimension 3 component/simplification/ceremony/build-vs-extend tests: the sole served
component supplies the requested reusable cross-language standard. Removing it
removes that named standard. Existing simplicity and React-specific skills can be
used as companions; repurposing them would broaden or conflict with their existing
scope. No copied specialist workflow, new approval checkpoint, script, registry,
package, or service is necessary. Authoring records are evidence, not a runtime.
No computed data predicate or derived classification is introduced, so the
read-time-reconstruction and unconstructible-state tests do not apply.

PROCEED applies to reviewing this codification. It does not discharge the unmet
behavioral GAP_CONFIRMED criterion or establish a guaranteed prevention mechanism.

## Guided and pressure evaluations

Fresh executor and independent evaluator for each run. The guided task was
byte-identical to the baseline; the new skill was supplied as CONTRIBUTING.md.
Independent verdict: **PASSED**, all three cases, preserving the already-correct
baseline behavior. Examples from the guided artifact:

> The controller owns the only writable session, expiry timer, shared in-flight
> refresh promise, and generation marker for invalidating stale asynchronous results.

> Keep all 170 lines of parser implementation and 300 lines of private unit cases
> in `src/report.rs`.

> Use the already configured SDK client's `put_object` directly inside that function.

The final pressure handoff used four new scenarios with time, authority, and
sunk-cost appeals. Independent verdict: **PASS**, all four decisions:

| Scenario                         | Verbatim written decision                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Separate desktop runtime roots   | “Keep `src/main.js`, `native/Cargo.toml`, and `native/src/lib.rs` in place”                                    |
| Crowded service entrypoint       | “Extract existing scheduling behavior and the relevant proposed cancellation lines into `export-scheduler.js`” |
| Legitimate tenant-policy adapter | “Reject conflicting ownership before any SDK call”                                                             |
| Small label correction           | “Add no new abstraction or test suite for this reversible text edit”                                           |

No failing rationalization was found, so no corrective loop was needed. This is an
instruction-supported evaluation: task choices cue the architectural alternatives
and loaded guidance supplies the principles. It establishes conformance of these
written handoffs, not independent transfer or a measured causal benefit.

SHA-256 fingerprints of local evidence:

- Identical baseline/guided prompt: `15746c088d86630b33de587bc9271fb4dc22d4441fb2e54e8f328d20eadc075f`
- Baseline transcript: `2127773433dd33e0b4bc76fd5baa02ded49b5ef30e6995c2dbbea6f2f031bc19`
- Guided transcript: `2d0f320a6d631db971e3b9224041608ff0da36882a6cc69ef97599fdc504fb64`
- Pressure transcript: `097cdcaa4f869bddfe689d75d1bf8e8e80027ccf802150c9caf17e85e32abd3d`

After the guided run, Prettier changed only Markdown table padding. The pressure
run used the formatted final skill. No semantic changes followed these evaluations.

## Mechanical and contract audit

- `skillctl validate`: PASS, valid frontmatter, 172-line self-contained body.
- `python3 scripts/validate-skills.py`: PASS on the full catalog.
- Prettier 3.6.2: Markdown formatted; no repository dependency added.
- `make skills-generate` and `make skills-check`: PASS using the pinned Linux
  clean-tree export; generation produced no tracked mirror changes.
- Existing catalog index and resolve handler: exactly one skill entry; resolved
  body includes the guidance and research basis. This is a local handler smoke
  check, not proof of deployment or automatic activation on every agent.
- Contract inspection: directive discovery description, no forbidden metadata,
  no placeholders or private workstation paths in served guidance, ordered
  progress for multi-file work, current official sources, and bounded artifact
  completion conditions. No scripts, hooks, or new runtime dependencies added.

Evaluation limits: handoff artifacts are assessed, not executable application
patches. Application functional correctness, live credentials, automatic skill
retrieval, other models, and repeated-run reliability are not established.

## CI finding and correction

PR #1115's first `skill-script-tests` run correctly rejected the new unprefixed
directory as an unratified physical core skill. The isolated test reproduced the
same failure locally. This skill is on-demand catalog guidance, so its canonical
directory now uses the existing `_enforcing-code-architecture` library convention;
the public ID remains `enforcing-code-architecture`. No core-tier rule or test was
weakened. All 71 applicable tier tests pass (two existing harness tests skip), and
`partition.py --check` confirms the 58 ratified core IDs match physical placement.
The evaluated SKILL.md content is byte-identical after the move.
