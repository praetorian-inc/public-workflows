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
  FAILED,
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

test('classify: an unfinished run (null or in_progress) counts as never_fired', () => {
  const prs = [
    pr(11, '2026-07-01T00:00:00Z', 'sha-null'),
    pr(12, '2026-07-01T00:00:00Z', 'sha-inprog'),
    pr(13, '2026-07-01T00:00:00Z', 'sha-neutral'),
  ];
  const byHead = new Map([
    ['sha-null', run(1, 'sha-null', null, '2026-07-01T01:00:00Z')],
    ['sha-inprog', run(2, 'sha-inprog', 'in_progress', '2026-07-01T01:00:00Z')],
    ['sha-neutral', run(3, 'sha-neutral', 'neutral', '2026-07-01T01:00:00Z')],
  ]);

  const c = classify(prs, byHead, null);

  assert.deepEqual(c.never_fired.map((r) => r.number), [11, 12, 13]);
  assert.deepEqual(c.delivered, []);
  assert.deepEqual(c.failed, []);
  assert.deepEqual(c.pre_onboarding, []);
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

const gapReport = ({ hasCaller = true, replay = [9, 10, 100], preOnboarding = 0 } = {}) => ({
  since: '2026-07-05',
  totals: { merged_prs: 12, delivered: 9 },
  repos_with_gaps: [
    {
      repo: 'guard',
      failed: 1,
      never_fired: 1,
      skipped_anomaly: 1,
      pre_onboarding: preOnboarding,
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

test('renderMarkdown: a clean report says No gaps and offers no replay command', () => {
  const clean = {
    since: '2026-07-05',
    totals: { merged_prs: 12, delivered: 12 },
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

// ── buildReport ──────────────────────────────────────────────────────────────

test('buildReport: totals sum every class across repos', () => {
  const results = [
    repoResult('guard', {
      merged: 10,
      delivered: [rec(1), rec(2), rec(3)],
      failed: [rec(4)],
      never_fired: [rec(5), rec(6)],
      skipped_anomaly: [rec(7)],
      pre_onboarding: [rec(8), rec(9), rec(10)],
    }),
    repoResult('palatine', {
      merged: 4,
      delivered: [rec(20)],
      failed: [rec(21), rec(22)],
      never_fired: [],
      skipped_anomaly: [],
      pre_onboarding: [rec(23)],
    }),
  ];

  const report = buildReport(results, { since: '2026-07-05', selfAudit: false }, 137);

  // Hand-summed: 10+4, 3+1, 1+2, 2+0, 1+0, 3+1.
  assert.deepEqual(report.totals, {
    merged_prs: 14,
    delivered: 4,
    failed: 3,
    never_fired: 2,
    skipped_anomaly: 1,
    pre_onboarding: 4,
  });
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
        merged: 5,
        failed: [rec(100)],
        never_fired: [rec(9)],
        skipped_anomaly: [rec(10)],
        pre_onboarding: [rec(1)],
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
      replay: [9, 10, 100],
    },
  ]);
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
