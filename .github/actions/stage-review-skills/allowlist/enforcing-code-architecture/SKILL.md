---
name: enforcing-code-architecture
description: Use BEFORE adding or changing code that introduces a responsibility, extends an entrypoint, creates a module, or reorganizes files and directories. Enforce cohesive ownership, clear dependency boundaries, and language-appropriate project structure for maintainable code. ALWAYS invoke when deciding where code belongs, splitting a large file, or adding an abstraction or wrapper.
---

# Enforcing Code Architecture

**Give each responsibility a clear owner. Preserve the language and framework's
structure, and introduce only the boundaries the current change needs.**

Apply this to implementation and refactoring in any language. It complements
language-specific guidance; it does not prescribe one directory tree, architectural
style, framework, or maximum file size for every project.

For multi-file work, keep a short ordered checklist: inspect → place → implement →
verify. For a small, cohesive fix, inspect its existing owner and make the fix
directly. Do not create an architecture document, abstraction, or test suite merely
to demonstrate use of this skill.

## 1. Establish the actual boundaries

Before editing, read the repository instructions, relevant manifests/build config,
and representative neighboring implementation and tests. Follow the affected
callers, imports, state mutations, and startup/teardown paths. Confirm graph/search
results against source; a directory tree alone does not establish ownership.

Identify the relevant boundaries, not an exhaustive map of the entire repository:

- Which package, process, runtime, or deployable owns this behavior?
- Which module currently owns its state and lifecycle? Who calls it?
- What are the established public interfaces and dependency directions?
- Which files are authored source, generated output, tests, fixtures, or assets?
- How does the build discover and package files, including resources and tests?

Verify unfamiliar language/framework conventions in current official documentation.
Do not call a preferred layout an industry requirement. Repeated local patterns are
evidence, not justification to copy an existing mixed-responsibility file.

Multiple `src/` directories can be correct when separate packages or runtimes own
them. The same basename does not imply duplicated code. Preserve framework entrypoints,
package boundaries, build roots, and generated/source separation unless the task
requires changing them. Edit a generator's source, never its output by hand.

## 2. Choose the smallest coherent placement

Before adding code, state briefly where it belongs and why. A sentence in the work
plan or PR is enough; use the repository's design process for larger changes.

| Situation                                                       | Placement decision                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Existing module owns the behavior and state                     | Extend it directly.                                                                        |
| A new responsibility would enlarge a mixed entrypoint or module | Extract that responsibility into a focused module and wire it at the entrypoint.           |
| Several files implement one feature with private internals      | Group by that feature when it improves ownership and follows the language's package rules. |
| Current callers genuinely share one concept                     | Give that concept a named owner with a small interface.                                    |
| Similar-looking code represents different concepts              | Keep it separate until shared semantics are established.                                   |

Flat directories are valid. A small file count is not a reason to put every
responsibility in one file. Name modules for their purpose, such as `session`,
`export_scheduler`, or `report_parser`; avoid numbered chunks and broad dumping
grounds named `utils`, `common`, or `helpers`. Use an existing such directory only
when the specific responsibility fits its documented scope.

Entrypoints should primarily assemble dependencies and start the application.
Keep new feature rules, persistence, authentication lifecycles, transport handling,
and rendering with their actual owners. Do not perform a wholesale rewrite to fix
one boundary: extract the part the current task needs and leave unrelated work out.

### File size prompts a decision

Around 300–400 lines of handwritten implementation is a useful **review heuristic**,
not a universal standard or automatic failure. A shorter file can mix unrelated
responsibilities; a longer cohesive parser can be appropriate. Count implementation,
inline tests, fixtures/data, and generated code separately when assessing the cause.

Follow explicit repository hard limits. Otherwise, split on responsibility, state
ownership, or independently changing behavior—not at an arbitrary line number.
Keep language-idiomatic private unit tests with their module when appropriate.
Do not create packages, crates, services, or build roots merely to reduce file size.
Record a brief rationale when retaining an unusually large affected module.

## 3. Keep ownership intact across the boundary

An extraction is useful only if the resulting contract is clearer:

- Give mutable state one authoritative owner. Expose operations or snapshots;
  avoid a second writable copy or a new global singleton to reconnect moved code.
- Pass only the data and operations the module needs. An entire application
  context, shared bag of mutable state, or callback that exposes all internals
  can hide the original coupling without removing it.
- Keep dependency direction explicit. Wire modules from a composition point;
  do not introduce import cycles, import the entrypoint from a feature, or make
  sibling features reach into each other's private files.
- Preserve lifecycle responsibilities: cancellation, subscriptions, timers,
  cleanup, retries, errors, and stale asynchronous results still need owners.
- Keep credentials and privileged operations within their existing trust boundary.
  Sharing a source directory or type does not authorize sharing secret state with
  a renderer, client bundle, or less privileged process.

Prefer private-by-default implementation and the smallest public surface current
callers need. Follow the language's visibility and packaging mechanisms. Do not
export internals or add re-export files solely to make a move compile.

## 4. Justify abstractions with a present need

Use an existing library, SDK, standard facility, or native command directly when it
already supplies the required contract. Do not add a process wrapper around an SDK,
a generic provider interface, factory, registry, plugin system, or service layer for
hypothetical future consumers. Work already spent on a draft does not establish need.

A narrow adapter is appropriate when it enforces a current application invariant,
isolates a real external boundary, or removes duplicated domain knowledge. State
the invariant and current caller before introducing it—for example, three upload
callers requiring the same tenant-prefix validation. Retain the SDK's authentication,
retries, and timeout handling rather than reimplementing them.

One caller can justify a module with a coherent responsibility; several callers do
not automatically justify a generic framework. A deadline calls for narrower scope,
not another unrelated responsibility in a crowded entrypoint. Respect explicit user
constraints; explain a real conflict rather than silently overriding them.

For deeper abstraction tradeoffs, resolve `preferring-simple-solutions`. For an
existing-code simplification task, resolve `code-simplification`. Apply relevant
language-specific structure guidance after confirming its scope; do not impose a
specialist framework's layout on other languages or runtimes.

## 5. Verify the change, including how it is shipped

Preserve behavior during structural moves unless the task explicitly changes it.
Separate moves from semantic changes where practical so reviewers can see both.
Update callers, import paths, module visibility, test discovery, build configuration,
and packaged resources as required by the actual move. Remove superseded code when
owned by this change; do not leave two implementations as an accidental fallback.

Run existing checks appropriate to the affected boundaries: formatting/lint,
type or compile checks, focused behavior tests, and build/package verification when
paths or runtime boundaries move. Exercise changed lifecycle/error behavior where
relevant. Use an existing dependency/cycle check if available; otherwise inspect
the changed import relationships. Do not add tooling just to run this checklist.

Tests should prove behavior or a meaningful boundary. Do not add tests that merely
assert file names, line counts, or implementation structure. A reversible label fix
normally needs direct verification and existing checks, not a new architecture suite.
Report checks actually run and their results; distinguish source/build verification
from a live runtime test. Name untested boundaries explicitly.

Before reporting completion, verify these properties of the changed artifact:

- Each new responsibility and mutable state has an identifiable owner.
- Callers use the intended interface; changed dependencies introduce no cycle or
  privileged-state exposure.
- New layers have a present purpose, and structural changes preserve required
  framework, package, and distribution contracts.
- Relevant checks completed, or their concrete limits and blockers are recorded.

Summarize the placement decision, its current justification, and verification in
the normal change description. No separate architecture report is required for a
routine change, and reviewer silence is not a completion criterion.

## Research basis

These sources support convention-aware, proportionate organization; none prescribes
a universal line limit. The review heuristic above is this skill's policy.

- [Go module layout](https://go.dev/doc/modules/layout): small single-package layouts
  are valid, and a package can span several files without becoming several packages.
- [Rust module files](https://doc.rust-lang.org/book/ch07-05-separating-modules-into-different-files.html):
  file extraction follows the module tree and can retain existing module paths.
- [Python source and flat layouts](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/):
  choose with installation/import behavior in mind, not appearance alone.
- [Google code review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html):
  assess design fit, understandable complexity, and current needs rather than
  speculative generality.
