#!/usr/bin/env node
// Leaderboard delivery audit (ENG-5689) — detect when a repo's
// leaderboard-metrics delivery has gone dark.
//
// Nothing watches the leaderboard producer pipeline. A caller repo can fail
// EVERY delivery indefinitely and the only signal is a red run in that repo's
// Actions tab, which nobody reads: augustus failed 22 consecutive runs over 20
// days before a human noticed (ENG-5687), and guard's first 17 days on the
// leaderboard delivered nothing at all (ENG-5775).
//
// WHY THIS IS PRODUCER-SIDE AND NEEDS NO AWS ACCESS
//
// ENG-5689 offered three candidate signals and asserted that only signal 3
// (reconcile merged-PR counts against CodeCommit rows in DynamoDB) can catch a
// delivery that NEVER FIRED. That is wrong, and this script is the
// counter-example: joining each merged PR to its workflow run and treating
// "no run at all" as its own class catches never-fired deliveries from the
// GitHub API alone — no AWS credentials, no coupling to the consumer's DynamoDB
// schema.
//
// THE JOIN KEY IS head_sha, VERIFIED EMPIRICALLY
//
// `run.pull_requests[]` is EMPTY on these runs (a pull_request_target quirk), so
// it cannot be the join key. `run.head_sha` is populated and equals the PR's
// `head.sha` — checked on augustus#281: run head_sha 03e4a3e2 == pr.head.sha
// 03e4a3e2, while base.sha was 4df396dc and merge_commit_sha was 945cc01d. Do
// not "simplify" this to the merge commit; it will match nothing.
//
// SELF-AUDIT IS THE PRIMARY MODE, AND A MISSING CALLER IS THE LOUDEST SIGNAL
//
// The default mode audits ONE repo — the one the workflow is running in — using
// that repo's own GITHUB_TOKEN. This is deliberate over a central fleet sweep:
// a sweep needs a hardcoded (or org-enumerated) repo list, and a list that has
// to be remembered is the precise defect being fixed — caeruleus went dark for
// 30 PRs because nobody added it to anything.
//
// Critically, self-audit does NOT require the repo to have a metrics caller.
// If the caller is absent, every merged PR classifies as never_fired and the
// audit screams. Gating on "does a caller exist" would silently exempt exactly
// the repo that never had a delivery path — the caeruleus case.
//
// LANGUAGE CHOICE: dependency-free .mjs, deliberately.
// The repo-wide rule is "no new Python, target TypeScript, .mjs only where
// no-install forces it". public-workflows has no package.json, no lockfile and
// no node tooling at all, so TypeScript would mean adding an install step and a
// Dependabot surface to run one detector. This uses only Node built-ins
// (global fetch), so a workflow step needs `node` and nothing else.

const API = 'https://api.github.com';

const DEFAULTS = {
  repo: null, // "owner/name" — self-audit mode
  owner: 'praetorian-inc', // fleet mode
  repos: null, // comma list; fleet mode, null = enumerate the org
  since: null, // YYYY-MM-DD, overrides --days
  days: '30',
  callerPath: '.github/workflows/leaderboard-metrics.yml',
  reusable: 'public-workflows/.github/workflows/leaderboard-metrics.yml@',
  backfillCaller: 'leaderboard-backfill-caller.yml',
  json: null,
  markdown: null,
};

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

export function parseArgs(argv, now = Date.now()) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const [rawKey, ...rest] = argv[i].replace(/^--/, '').split('=');
    // accept --caller-path as well as --callerPath
    const k = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = rest.length ? rest.join('=') : argv[++i];
    // Object.hasOwn, NOT `k in out`: `in` walks the prototype chain, so
    // --toString / --constructor / --valueOf would all be silently ACCEPTED as
    // known flags and then quietly overwrite an inherited member.
    if (!Object.hasOwn(out, k)) throw new Error(`unknown flag --${rawKey}`);
    if (v === undefined) throw new Error(`--${rawKey} requires a value`);
    out[k] = v;
  }

  if (out.repo) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
      throw new Error(`--repo must be owner/name, got ${out.repo}`);
    }
    if (out.repos) throw new Error('--repo and --repos are mutually exclusive');
    const [owner, name] = out.repo.split('/');
    out.owner = owner;
    out.repos = [name];
    out.selfAudit = true;
  } else {
    out.selfAudit = false;
    if (out.repos) out.repos = out.repos.split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (out.since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.since)) {
      throw new Error(`--since must be YYYY-MM-DD, got ${out.since}`);
    }
  } else {
    // Match plain decimal digits only. `Number()` alone would accept `1e2`,
    // `0x1E`, `030` and " 30" — a cron passing `1e2` would silently audit a
    // 100-day window instead of failing.
    if (!/^\d+$/.test(String(out.days).trim()) || Number(out.days) < 1) {
      throw new Error(`--days must be a positive integer, got ${out.days}`);
    }
    const days = Number(out.days);
    out.since = ymd(now - days * DAY);
  }

  // The runs endpoint is keyed by the workflow FILE NAME, which must track
  // --caller-path rather than being hardcoded alongside it.
  out.callerFile = out.callerPath.split('/').pop();
  if (!out.callerFile) throw new Error(`--caller-path has no filename: ${out.callerPath}`);
  return out;
}

export const FAILED = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
]);

// Classification is pure so it can be unit-tested without touching the network.
// `runs` is the already-deduplicated head_sha -> run map.
export function classify(prs, byHead, onboardedTs) {
  const classes = {
    delivered: [],
    failed: [],
    skipped_anomaly: [],
    never_fired: [],
    pre_onboarding: [],
    // A run exists but has not concluded yet (`conclusion === null`). NOT a gap
    // and NOT a delivery — the honest answer is "not known yet", so it is
    // neither replayed nor counted as delivered. It resolves itself on the next
    // audit, which is what makes withholding a verdict safe here; a *concluded*
    // run we do not recognize does NOT belong in this bucket, because nothing
    // would ever resolve it.
    in_flight: [],
  };
  for (const pr of prs) {
    const run = byHead.get(pr.head.sha);
    const rec = {
      number: pr.number,
      merged_at: pr.merged_at,
      head_sha: pr.head.sha.slice(0, 8),
    };
    if (!run) {
      // A PR merged before this repo had a caller never had a delivery path at
      // all — a policy question (backfill or accept), NOT a broken pipeline.
      // Conflating the two is what makes a naive count unactionable.
      if (onboardedTs && Date.parse(pr.merged_at) < onboardedTs) {
        classes.pre_onboarding.push(rec);
      } else {
        classes.never_fired.push(rec);
      }
      continue;
    }
    rec.run_id = run.id;
    rec.conclusion = run.conclusion;
    if (run.conclusion === null) {
      // queued / in_progress / waiting — `conclusion` stays null until a run
      // completes. This used to fall through to never_fired, which put an
      // ACTIVELY RUNNING delivery on the replay list: audit a PR merged seconds
      // ago and the report demands a replay of a delivery that is about to
      // succeed on its own. The window counts back from *now*, so a freshly
      // merged PR is always in range — ordinary operation, not a corner case.
      // Replaying it would double-deliver, and consumer-side idempotency is
      // not established (ENG-5789).
      classes.in_flight.push(rec);
    } else if (run.conclusion === 'success') classes.delivered.push(rec);
    else if (FAILED.has(run.conclusion)) classes.failed.push(rec);
    else if (run.conclusion === 'skipped') {
      // The reusable gates on `merged == true`. A run that SKIPPED for a PR
      // that did merge means that gate misfired — an anomaly worth surfacing,
      // not a benign skip. Benign skips pair with unmerged closes, which are
      // filtered out by the caller and so never reach here.
      classes.skipped_anomaly.push(rec);
    } else {
      // A CONCLUDED run whose conclusion is not one we enumerate: `neutral`,
      // `stale`, or anything GitHub adds later. It is not `success`, so no
      // delivery happened — and unlike an in-flight run it will NEVER change on
      // a later audit, so parking it in in_flight would hide it permanently
      // (neither delivered, nor a gap, forever). Fail safe: an unknown terminal
      // conclusion is treated as a failed delivery, so it is surfaced and
      // replayable. The `conclusion` field is carried on the record, so the
      // report still says which value it actually was.
      classes.failed.push(rec);
    }
  }
  return classes;
}

export function dedupeByHead(runs) {
  // A SUCCESS outranks everything, and only then does the latest run win.
  //
  // Recency alone was wrong in one direction. The question this audit asks is
  // "did a successful delivery ever happen for this head", and a delivery that
  // succeeded stays delivered — the consumer already holds the row. So if a
  // succeeded run is later re-run and fails (or is still running), recency would
  // pick the newer non-success, classify the PR as a gap, and put an
  // ALREADY-DELIVERED PR on the replay list. That is the one error direction
  // that causes a double delivery rather than a missed one.
  //
  // The case recency exists for still works, because success-first subsumes it:
  // a first attempt that failed and a re-run that succeeded resolves to the
  // success either way.
  const byHead = new Map();
  const won = (r, prev) => {
    if (!prev) return true;
    const a = r.conclusion === 'success';
    const b = prev.conclusion === 'success';
    if (a !== b) return a;
    return Date.parse(r.created_at) > Date.parse(prev.created_at);
  };
  for (const r of runs) {
    if (won(r, byHead.get(r.head_sha))) byHead.set(r.head_sha, r);
  }
  return byHead;
}

// One under the backfill's own 256-job matrix cap, so a batch is never exactly
// at the limit it is trying to stay below.
export const REPLAY_BATCH = 250;

export function chunk(xs, n) {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export function replayList(classes) {
  return [...classes.failed, ...classes.never_fired, ...classes.skipped_anomaly]
    .map((p) => p.number)
    .sort((a, b) => a - b);
}

// ── Networking ───────────────────────────────────────────────────────────────

// How long to wait before retrying a 403/429, in ms. Pure and exported so the
// header handling can be tested without a network or a real clock.
//
// `retry-after` is checked FIRST because it is the header GitHub sends for
// SECONDARY (abuse) rate limits, and those are the ones a paginating audit
// actually trips. Keying only off `x-ratelimit-reset` — which secondary-limit
// responses need not carry — made every secondary-limit retry wait the 1s floor
// and burn all four attempts in about three seconds.
export function retryDelayMs(headers, now = Date.now()) {
  const MIN = 1000;
  const MAX = 60000;
  const clamp = (ms) => Math.max(MIN, Math.min(MAX, ms));

  // Documented as either delta-seconds or an HTTP date; GitHub sends seconds.
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs > 0) return clamp(secs * 1000);
    const when = Date.parse(ra);
    if (Number.isFinite(when)) return clamp(when - now);
  }

  // Primary limit: an epoch-seconds instant. Only usable if it is actually in
  // the future — a missing or past value must not silently become the floor.
  // The `delta > 0` test is intent, not arithmetic: MIN clamps a negative up to
  // the floor anyway, so removing it changes no output TODAY. It is here so that
  // lowering MIN can never resurrect the original bug, where a missing header
  // made `reset - now` hugely negative and every retry waited the floor.
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const delta = reset * 1000 - now;
    if (delta > 0) return clamp(delta);
  }

  // Nothing usable: a 403 can also mean "no permission", which no wait fixes.
  // Retry cheaply and let the attempt cap turn it into an exit-2 UNKNOWN.
  return MIN;
}

function makeClient(token) {
  const state = { calls: 0 };
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'leaderboard-delivery-audit',
  };

  // THE single point at which this script talks to the network. Both gh() and
  // ghPaged() go through here, because they used to not: the rate-limit retry
  // lived in gh() while ghPaged() called fetch() directly, and ghPaged() is the
  // one that makes most of the calls (every page of PRs and of workflow runs —
  // 40 of guard's 42). A 403/429 mid-pagination therefore aborted the whole
  // audit with no retry at all, on precisely the busiest repos.
  async function request(rawUrl) {
    const url = rawUrl.startsWith('http') ? rawUrl : `${API}${rawUrl}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers });
      state.calls++;
      if (res.status === 403 || res.status === 429) {
        if (attempt === 3) throw new Error(`rate limited on ${url} after 4 attempts`);
        await new Promise((r) => setTimeout(r, retryDelayMs(res.headers)));
        continue;
      }
      return res;
    }
    throw new Error(`unreachable: retries exhausted on ${url}`);
  }

  async function gh(path) {
    const res = await request(path);
    if (res.status === 404) return { __missing: true };
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
    return res.json();
  }

  // Paginate by Link header rather than by "did I get a full page", which
  // silently stops one page early whenever the last page is exactly per_page.
  async function ghPaged(path, pluck, stopWhen) {
    let url = path;
    const items = [];
    let stop = false;
    while (url) {
      const res = await request(url);
      if (res.status === 404) break;
      if (!res.ok) throw new Error(`${res.status} on ${url}`);
      const body = await res.json();
      const batch = pluck ? pluck(body) : body;
      items.push(...batch);
      if (stopWhen && batch.length && stopWhen(batch[batch.length - 1])) stop = true;
      const link = res.headers.get('link') || '';
      const next = link.split(',').find((p) => p.includes('rel="next"'));
      url = stop ? null : next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null;
    }
    return items;
  }

  return { gh, ghPaged, state };
}

// ── The 1000-result cap, and why this is not a simple paginated fetch ────────
//
// `/actions/workflows/{file}/runs` HARD-CAPS pagination at 1000 items and says
// nothing about it: for guard the endpoint reported `total_count: 1537` while
// paginating to exhaustion yielded exactly 1000, and the oldest run reachable
// was 2026-06-26 even though guard's caller landed 2026-05-20. Every run before
// that boundary was invisible, which made 420 delivered PRs look NEVER_FIRED.
// An earlier revision of this script shipped that bug and would have alerted on
// 420 phantom gaps in guard alone.
//
// So the range is SLICED until every slice fits under the cap, and each slice
// asserts that what it fetched equals what the API said existed. Truncation can
// no longer be silent — it either subdivides or it throws.
// Exported for tests: `client` is already the only way this reaches the network,
// so a stub client exercises the slicing and the truncation guard directly —
// no fetch mocking, and nothing about the real transport is faked.
export async function runsInRange(client, cfg, repo) {
  const base = `/repos/${cfg.owner}/${repo}/actions/workflows/${cfg.callerFile}/runs`;
  const out = [];
  const stack = [[Date.parse(`${cfg.since}T00:00:00Z`), Date.now()]];

  while (stack.length) {
    const [a, b] = stack.pop();
    const range = `${ymd(a)}..${ymd(b)}`;
    const probe = await client.gh(`${base}?per_page=1&created=${encodeURIComponent(range)}`);
    const total = probe?.total_count ?? 0;
    if (total === 0) continue;

    if (total > 1000) {
      // Subdivide by date. Day granularity is the floor the `created` filter
      // supports, so a single day over the cap is unrepresentable — throw
      // rather than report a gap we cannot actually see.
      if (ymd(a) === ymd(b)) {
        throw new Error(
          `${repo}: ${total} runs on the single day ${ymd(a)} exceeds the API's 1000-result cap and cannot be subdivided further`,
        );
      }
      const mid = a + Math.floor((b - a) / 2 / DAY) * DAY;
      const split = mid <= a || mid >= b ? a + DAY : mid;
      stack.push([a, split - DAY], [split, b]);
      continue;
    }

    const got = await client.ghPaged(
      `${base}?per_page=100&created=${encodeURIComponent(range)}`,
      (x) => x.workflow_runs || [],
    );
    // Only a SHORTFALL is the danger. `total` comes from a per_page=1 probe
    // taken moments before this fetch, and the last slice's range ends at
    // today — so any run created in between lands in `got` and makes
    // `got.length > total`. On a repo merging ~15 PRs a day that is ordinary
    // churn, and a strict `!==` here turned it into a spurious exit-2 "audit
    // could not complete", i.e. a false page on exactly the high-velocity repos
    // the slicing exists to serve. Growth is harmless: an extra run is more
    // data, not less. A shortfall is what silent truncation looks like, and
    // that still throws.
    if (got.length < total) {
      throw new Error(
        `${repo}: slice ${range} reported total_count=${total} but only ${got.length} runs were retrievable — refusing to classify against a truncated run list`,
      );
    }
    out.push(...got);
  }
  return out;
}

const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');

async function hasCaller(client, cfg, repo) {
  const f = await client.gh(`/repos/${cfg.owner}/${repo}/contents/${cfg.callerPath}`);
  if (!f || f.__missing || !f.content) return false;
  // CONTENT probe: the caller must actually call the reusable. A repo can carry
  // a same-named file that calls something else entirely. Content, not
  // filename, and not the check name: a workflow has three independent
  // identities and they routinely disagree, so a filename probe under-counts.
  return b64(f.content).includes(cfg.reusable);
}

async function resolveFleet(client, cfg) {
  let names = cfg.repos;
  if (!names) {
    const repos = await client.ghPaged(`/orgs/${cfg.owner}/repos?per_page=100&type=all`);
    names = repos.filter((r) => !r.archived && !r.disabled).map((r) => r.name);
  }
  const fleet = [];
  for (const name of names) if (await hasCaller(client, cfg, name)) fleet.push(name);
  return fleet;
}

// When did this repo get its caller? Used only to separate pre_onboarding from
// never_fired.
async function onboardedAt(client, cfg, repo) {
  const commits = await client.ghPaged(
    `/repos/${cfg.owner}/${repo}/commits?path=${encodeURIComponent(cfg.callerPath)}&per_page=100`,
  );
  if (!commits.length) return null;
  const dates = commits
    .map((c) => c.commit?.committer?.date || c.commit?.author?.date)
    .filter(Boolean)
    .sort();
  return dates[0] || null;
}

async function auditRepo(client, cfg, repo) {
  const sinceTs = Date.parse(`${cfg.since}T00:00:00Z`);

  // `pulls` is a plain list endpoint and is NOT subject to the 1000-result cap
  // that bites the runs endpoint (guard returned all 1419). Sorted by
  // updated_at desc, we can stop as soon as updated_at falls below the window:
  // updated_at >= merged_at always, so nothing in the window is skipped.
  const prs = (
    await client.ghPaged(
      `/repos/${cfg.owner}/${repo}/pulls?state=closed&per_page=100&sort=updated&direction=desc`,
      null,
      (last) => Date.parse(last.updated_at) < sinceTs,
    )
  ).filter((p) => p.merged_at && Date.parse(p.merged_at) >= sinceTs);

  const runs = await runsInRange(client, cfg, repo);
  const onboarded = await onboardedAt(client, cfg, repo);
  const classes = classify(prs, dedupeByHead(runs), onboarded ? Date.parse(onboarded) : null);
  const caller = await hasCaller(client, cfg, repo);

  return { repo, onboarded, has_caller: caller, merged_prs: prs.length, classes };
}

export function renderMarkdown(report, cfg) {
  const L = [];
  L.push('## Leaderboard delivery audit');
  L.push('');
  L.push(
    `Window \`${report.since}\` → now. ` +
      `Merged PRs examined: **${report.totals.merged_prs}**. ` +
      `Delivered: **${report.totals.delivered}**.`,
  );
  L.push('');
  if (!report.repos_with_gaps.length) {
    // Do not claim every PR delivered while some are still undetermined — that
    // sentence would be false, and falsely reassuring, exactly when a delivery
    // is mid-flight.
    if (report.totals.in_flight) {
      L.push(
        `No gaps. **${report.totals.in_flight}** merged PR(s) have a delivery still ` +
          'running and are not yet decided either way — re-run the audit once they ' +
          'conclude. Every other merged PR in the window delivered successfully.',
      );
    } else {
      L.push('No gaps. Every merged PR in the window has a successful metrics delivery.');
    }
    return L.join('\n');
  }
  L.push(
    '**A leaderboard metrics delivery gap was detected.** Each affected PR below ' +
      'produced no `CodeCommit` row, so its author is missing score for it.',
  );
  L.push('');
  for (const g of report.repos_with_gaps) {
    const r = report.repos.find((x) => x.repo === g.repo);
    L.push(`### \`${g.repo}\``);
    L.push('');
    if (r && !r.has_caller) {
      L.push(
        '> **This repo has no `leaderboard-metrics.yml` caller that references the ' +
          'reusable.** Nothing was ever going to deliver, so every merged PR below ' +
          'is a never-fired delivery, not a failure.',
      );
      L.push('');
    }
    L.push('| class | count |');
    L.push('| --- | --- |');
    L.push(`| failed | ${g.failed} |`);
    L.push(`| never fired | ${g.never_fired} |`);
    L.push(`| skipped anomaly | ${g.skipped_anomaly} |`);
    if (g.pre_onboarding) {
      L.push(`| pre-onboarding (not a gap) | ${g.pre_onboarding} |`);
    }
    if (g.in_flight) {
      L.push(`| still running (not a gap, not replayed) | ${g.in_flight} |`);
    }
    L.push('');
    L.push(`Affected PRs (${g.replay.length}): ${g.replay.map((n) => `#${n}`).join(', ')}`);
    L.push('');
    // The backfill workflow fans out one matrix job per PR, and GitHub caps a
    // matrix at 256 jobs — it validates that itself and refuses the whole run
    // with "split into batches". So a single command for a list this long is one
    // the report KNOWS will bounce; batch it here instead of handing over a
    // paste that fails. (The shell is not the constraint: 188 PR numbers is
    // ~940 bytes against a 1MB ARG_MAX.)
    const batches = chunk(g.replay, REPLAY_BATCH);
    L.push(
      batches.length > 1
        ? `Replay them with the repo's own backfill caller. ${g.replay.length} PRs exceeds ` +
            `the backfill's 256-job matrix cap, so this is split into ${batches.length} ` +
            'batches — dispatch them one at a time:'
        : "Replay them with the repo's own backfill caller:",
    );
    L.push('');
    L.push('```sh');
    for (const b of batches) {
      L.push(
        `gh workflow run ${cfg.backfillCaller} --repo ${cfg.owner}/${g.repo} \\\n` +
          `  -f pr_numbers='${b.join(',')}'`,
      );
    }
    L.push('```');
    L.push('');
    L.push(
      '> Replaying writes to the production metrics queue. It is idempotent only ' +
        'while author resolution is unchanged (ENG-5693) — confirm before dispatching.',
    );
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(
    'Detected by the `audit-delivery` action (ENG-5689). ' +
      "If this is a false positive, the classifier's inputs are in the run's " +
      '`audit.json` artifact.',
  );
  return L.join('\n');
}

export function buildReport(results, cfg, apiCalls) {
  const sum = (f) => results.reduce((n, r) => n + f(r), 0);
  // in_flight is deliberately NOT a gap condition: an unconcluded run is an
  // unknown, and raising on it would make the audit's verdict depend on how
  // close it ran to a merge.
  const gaps = results.filter(
    (r) =>
      r.classes.failed.length || r.classes.never_fired.length || r.classes.skipped_anomaly.length,
  );
  return {
    since: cfg.since,
    mode: cfg.selfAudit ? 'self' : 'fleet',
    fleet_size: results.length,
    api_calls: apiCalls,
    totals: {
      merged_prs: sum((r) => r.merged_prs),
      delivered: sum((r) => r.classes.delivered.length),
      failed: sum((r) => r.classes.failed.length),
      never_fired: sum((r) => r.classes.never_fired.length),
      skipped_anomaly: sum((r) => r.classes.skipped_anomaly.length),
      pre_onboarding: sum((r) => r.classes.pre_onboarding.length),
      in_flight: sum((r) => r.classes.in_flight.length),
    },
    repos_with_gaps: gaps.map((r) => ({
      repo: r.repo,
      failed: r.classes.failed.length,
      never_fired: r.classes.never_fired.length,
      skipped_anomaly: r.classes.skipped_anomaly.length,
      pre_onboarding: r.classes.pre_onboarding.length,
      in_flight: r.classes.in_flight.length,
      replay: replayList(r.classes),
    })),
    repos: results,
  };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    // Fail LOUDLY. A detector that silently reports "0 gaps" because it had no
    // credentials is the exact failure class this script exists to catch.
    console.error(
      '::error::GITHUB_TOKEN (or GH_TOKEN) is unset — refusing to run. An unauthenticated audit would report a clean fleet it never actually read.',
    );
    process.exit(2);
  }
  const client = makeClient(token);

  // Self-audit deliberately skips the caller probe: a repo with no caller must
  // be audited (and scream), not skipped. Fleet mode probes, because there it
  // is a discovery question rather than a subject question.
  const fleet = cfg.selfAudit ? cfg.repos : await resolveFleet(client, cfg);
  if (!fleet.length) {
    console.error(
      '::error::resolved ZERO caller repos — the fleet probe is broken or the token cannot read the org. Refusing to report a clean fleet.',
    );
    process.exit(2);
  }

  const results = [];
  for (const repo of fleet) results.push(await auditRepo(client, cfg, repo));
  const report = buildReport(results, cfg, client.state.calls);

  const { writeFileSync } = await import('node:fs');
  if (cfg.json) writeFileSync(cfg.json, JSON.stringify(report, null, 2));
  if (cfg.markdown) writeFileSync(cfg.markdown, `${renderMarkdown(report, cfg)}\n`);

  const t = report.totals;
  console.log(
    `mode=${report.mode} repos=${fleet.length} merged=${t.merged_prs} delivered=${t.delivered} ` +
      `FAILED=${t.failed} NEVER_FIRED=${t.never_fired} skipped_anomaly=${t.skipped_anomaly} ` +
      `pre_onboarding=${t.pre_onboarding} in_flight=${t.in_flight} api_calls=${report.api_calls}`,
  );
  for (const g of report.repos_with_gaps) {
    console.log(
      `  GAP ${g.repo}: failed=${g.failed} never_fired=${g.never_fired} ` +
        `skipped_anomaly=${g.skipped_anomaly} replay=${g.replay.length} PRs`,
    );
  }

  // 0 = clean, 1 = gaps found, 2 = the detector itself could not run. Keeping
  // "found something" distinct from "broke" is the whole point: a caller that
  // treats any non-zero exit as a gap would raise an issue on a rate-limit.
  process.exit(report.repos_with_gaps.length ? 1 : 0);
}

// Only run when executed directly, so the unit tests can import the pure parts.
if (process.argv[1] && process.argv[1].endsWith('audit-delivery.mjs')) {
  main().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(2);
  });
}
