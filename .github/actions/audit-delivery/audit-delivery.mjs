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
  until: null, // YYYY-MM-DD upper bound, exclusive; null = up to now
  days: '30',
  callerPath: '.github/workflows/leaderboard-metrics.yml',
  reusable: 'public-workflows/.github/workflows/leaderboard-metrics.yml@',
  backfillCaller: 'leaderboard-backfill-caller.yml',
  json: null,
  markdown: null,
};

// Per-REQUEST ceiling, not a budget for the audit: a wide guard window makes
// ~880 calls, so anything short enough to bound total runtime would abort
// healthy requests. 30s is well past GitHub's own p99 for these endpoints while
// still turning a hung socket into a retry rather than a 6-hour job timeout.
const REQUEST_TIMEOUT_MS = 30000;

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

  // An EXPLICITLY passed empty --repo is a caller bug, not a request for fleet
  // mode. `if (out.repo)` below is false for '', so an empty value used to skip
  // the owner/name check, skip the --repo/--repos exclusion, leave selfAudit
  // false, and fall through to DEFAULTS.owner with repos=null — i.e. silently
  // promote "audit this one repo" into an org-wide enumeration. The distinction
  // from `null` is the point: null means the flag was never passed (fleet mode
  // is then intentional), '' means a caller interpolated an unset value.
  if (out.repo === '') {
    throw new Error(
      '--repo was passed with an empty value — refusing to fall back to an org-wide fleet audit',
    );
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
    // Shape is not a date, and three families get past that regex. They fail in
    // different ways, so each is named rather than left to `Date` — measured
    // against V8, not read off the spec.
    const ts = Date.parse(`${out.since}T00:00:00Z`);
    // NOT A DATE: `2026-13-01` and `2026-00-10` yield NaN. This family already
    // failed SAFE — every `merged_at >= NaN` is false, and the window formatter
    // throws `Invalid time value`, which main() maps to exit 2 — so the fix here
    // is diagnostic only: the bare message named neither the flag nor the value.
    if (Number.isNaN(ts)) {
      throw new Error(`--since is not a real date: ${out.since}`);
    }
    // ROLL-OVER: `2026-02-31` does NOT yield NaN — it silently becomes
    // 2026-03-03 (and `2026-04-31` becomes 2026-05-01). The audit then covers a
    // window the operator never asked for, and every PR merged in the skipped
    // days is invisible to it while the report still prints the requested date.
    // Round-tripping through the same formatter the --days path uses is the
    // whole test: a real calendar date survives it unchanged.
    if (ymd(ts) !== out.since) {
      throw new Error(
        `--since ${out.since} is not a calendar date — it silently normalizes to ${ymd(ts)}, ` +
          'so the audit would cover a different window than the one requested',
      );
    }
    // FUTURE: `2027-01-01` is a perfectly good date and the worst of the three.
    // No merged PR can satisfy it, so the audit reports 0 merged / 0 gaps and
    // exits 0 — a CLEAN verdict reached by examining nothing, which is the exact
    // failure class this detector exists to catch, produced by the detector
    // itself. Refuse (exit 2, "could not run") rather than emit it.
    if (ts > now) {
      throw new Error(
        `--since ${out.since} is in the future — the window can contain no merged PRs, so the ` +
          'audit would report a clean result having examined nothing',
      );
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

  // --until exists because the rename remediation below was unfollowable without
  // it. That error tells the operator to re-run with the PREVIOUS caller path to
  // cover the pre-rename period — but with only a lower bound, the re-run also
  // covers everything AFTER the rename, where the old filename has no runs at
  // all, so every recent PR comes back never_fired. Following the instruction
  // produced a report that was wrong in the replay-list direction, which is the
  // direction that writes to the prod queue.
  //
  // Validated by the same three-family checks as --since rather than a fresh
  // `Date.parse` — a second date flag with weaker validation is how the
  // roll-over bug would have come back on a different flag.
  if (out.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.until)) {
      throw new Error(`--until must be YYYY-MM-DD, got ${out.until}`);
    }
    const uts = Date.parse(`${out.until}T00:00:00Z`);
    if (Number.isNaN(uts)) throw new Error(`--until is not a real date: ${out.until}`);
    if (ymd(uts) !== out.until) {
      throw new Error(
        `--until ${out.until} is not a calendar date — it silently normalizes to ${ymd(uts)}, ` +
          'so the audit would cover a different window than the one requested',
      );
    }
    // A future --until is NOT rejected: it just means "up to now", which is the
    // default anyway. The hazard this flag introduces is the EMPTY window — the
    // same vacuous-clean shape the future --since check refuses, reachable here
    // through an upper bound at or below the lower one.
    if (uts <= Date.parse(`${out.since}T00:00:00Z`)) {
      throw new Error(
        `--until ${out.until} is not after --since ${out.since} — the window can contain no ` +
          'merged PRs, so the audit would report a clean result having examined nothing',
      );
    }
  }

  // The runs endpoint is keyed by the workflow FILE NAME, which must track
  // --caller-path rather than being hardcoded alongside it.
  out.callerFile = out.callerPath.split('/').pop();
  if (!out.callerFile) throw new Error(`--caller-path has no filename: ${out.callerPath}`);

  // Both of these are workflow filenames, and both leave this process as text
  // that something else interprets — so both are validated, not just the one a
  // reviewer happened to cite:
  //   - `callerFile` is interpolated into an API URL PATH. Unvalidated, a value
  //     containing `/` or `..` re-targets the request at a different endpoint.
  //   - `backfillCaller` is interpolated into the `gh workflow run` command the
  //     report tells a HUMAN to paste into a shell. Shell metacharacters there
  //     turn the remediation instructions into command injection — the report is
  //     read by someone responding to an alert, which is the worst moment to be
  //     handed a hostile command.
  // Neither is attacker-controlled today (both come from repo-committed caller
  // workflows), so this is hardening rather than a live hole. It is also the
  // cheapest possible hardening: a workflow file is a flat filename ending in
  // .yml/.yaml, so anything else is a misconfiguration worth failing loudly on.
  const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;
  if (!WORKFLOW_FILE.test(out.callerFile)) {
    throw new Error(
      `--caller-path must name a workflow file (letters, digits, . _ - and a .yml/.yaml suffix), got ${out.callerFile}`,
    );
  }
  if (!WORKFLOW_FILE.test(out.backfillCaller)) {
    throw new Error(
      `--backfill-caller must be a workflow filename (letters, digits, . _ - and a .yml/.yaml suffix), got ${out.backfillCaller}`,
    );
  }
  return out;
}

export const FAILED = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
]);

// How recently a PR must have merged for "no run exists" to mean "not yet"
// rather than "never". Generous on purpose: a run normally appears within
// seconds, and the cost of being generous is that a genuine never_fired merged
// inside the window waits one audit cycle to be reported, whereas the cost of
// being stingy is a replay of a delivery that was about to happen. Those are not
// symmetric — one delays a report, the other double-writes to prod.
export const GRACE_MS = 15 * 60 * 1000;

// How far back a workflow run RECORD is still queryable. Past this, "no run
// exists" stops meaning "no run ever ran" and starts meaning "the record was
// reaped" — indistinguishable from the outside, and the two have opposite
// remediations, so the audit must not guess.
//
// The obvious candidate for this number is wrong, which is why the measurement
// is recorded here rather than the reasoning. `GET
// /repos/{o}/{r}/actions/permissions/artifact-and-log-retention` returns
// `{"days":90,"maximum_allowed_days":90}` for guard — but that setting governs
// ARTIFACTS AND LOGS, not run records: guard has **3570** run records in
// `created=2026-04-25..2026-04-30`, 96–101 days old, well past 90.
//
// The real cliff, measured on guard's own history (runs per created-window):
//   2025-05-01..05-31      0
//   2025-06-01..06-15      0    <- cliff
//   2025-06-16..06-25   1736    <- cliff
//   2025-07 (month)     4156
//   2026-03 (month)    16622
// and 400 days before the day of measurement was 2025-06-30. Deletion is
// batched, so the observed edge wobbles a couple of weeks either side of the
// nominal 400 — which is exactly why this is used as a conservative floor for
// WITHHOLDING a verdict and never as a floor for asserting one.
//
// Not a repo-age artifact: guard was created 2024-06-11 and has 0 runs in
// 2024-06/07, 2024-12 and 2025-03. Control in the other direction: palatine
// shows 0 runs before 2026-06 because the REPO was created 2026-06-06.
export const RUN_HISTORY_DAYS = 400;

// Classification is pure so it can be unit-tested without touching the network.
// `byHead` is the already-deduplicated head_sha -> run map. `now` is a parameter
// so the grace window is testable against a fixed clock rather than by sleeping;
// every production caller keeps the real clock.
export function classify(prs, byHead, onboardedTs, now = Date.now()) {
  // The whole join is head_sha -> run, and `dedupeByHead` collapses every run on
  // a SHA to one winner with success taking precedence. That is right for a
  // re-run of the same PR and wrong the moment two merged PRs share a commit,
  // which happens for real: one branch opened against two bases. guard has two
  // such pairs in 5291 merged PRs — #2938/#2939 (`mario-prod` into main and
  // prod) and #2735/#2766 (`jwh/capdev-workflow-tweak` into main and capdev).
  // Two runs SHOULD then exist, because the caller triggers on
  // `pull_request_target: closed` with no `branches:` filter, so each PR's own
  // close event fires its own delivery — and collapsing them lets ONE success
  // speak for BOTH PRs, making a real failure read as delivered. That is the
  // silent direction.
  //
  // Be precise about what is measured, because the distinction decides how much
  // this matters. The COLLISION is observed: 2 pairs in guard's 5291 merged PRs,
  // 0 in palatine, caeruleus and vespasian. The two-runs half is INFERRED from
  // the trigger config, not observed — both real pairs merged in Aug 2025, before
  // guard was onboarded, and each shared SHA has `total_count: 0` runs today, so
  // both currently classify pre_onboarding and the mis-join cannot fire on them.
  // The defect is therefore LATENT rather than live: it needs a collision that
  // happens AFTER onboarding. It is still worth the eight lines, because the cost
  // of being wrong is a false clean and the frequency is "twice in a year of one
  // repo's history" rather than never.
  //
  // Nothing on the run distinguishes them — both real pairs share `head_branch`
  // as well as `head_sha`, and `run.pull_requests` is unreliable — so the join is
  // not repairable here, only detectable. Throwing (exit 2, "could not run")
  // follows the same rule as the truncation guard above: when the audit cannot
  // answer correctly it must refuse loudly rather than emit a verdict it cannot
  // support. A clean-looking report is the one outcome that must never come out
  // of an unjoinable input.
  //
  // But refusing must be CONFINED to the collisions that can actually corrupt a
  // verdict, because refusal is not free: the first version of this guard sat
  // unconditionally at the top of classify(), and `--repo praetorian-inc/guard
  // --since 2025-07-01` — the wide historical window the ENG-5775 backfill needs —
  // stopped dead on the Aug-2025 pair — an input whose verdict was never in doubt,
  // for the reason given below. A detector that cries wrong-input on sound input
  // gets narrowed or switched off, which costs the real detections too.
  //
  // The predicate is whether a RUN EXISTS on the shared SHA — not, as a first
  // attempt had it, whether the colliding PRs are past onboarding. That version
  // was wrong and a test caught it: `pre_onboarding` is only reachable inside the
  // `!run` branch below, so a pre-onboarding PR sharing a SHA with a
  // post-onboarding run does not classify pre_onboarding at all — it is credited
  // `delivered`, which quietly removes a PR that genuinely needs backfilling from
  // the replay list. Onboarding does not make a collision safe.
  //
  // What actually makes it safe is the absence of a run:
  //   - no run on the SHA → every colliding PR takes the `!run` path and is
  //     classified from its own merged_at alone, so no verdict can cross between
  //     them. Sound, and this is guard's real Aug-2025 case (both SHAs report
  //     total_count 0), which is why the wide historical window audits cleanly.
  //   - a run exists → dedupeByHead's single winner is credited to EVERY colliding
  //     PR while at most one of them owns it. Unsound, whatever the dates say.
  const byShaCount = new Map();
  for (const pr of prs) byShaCount.set(pr.head.sha, (byShaCount.get(pr.head.sha) || 0) + 1);
  for (const [sha, n] of byShaCount) {
    if (n > 1 && byHead.get(sha)) {
      const nums = prs
        .filter((p) => p.head.sha === sha)
        .map((p) => `#${p.number}`)
        .join(', ');
      throw new Error(
        `${nums} share head_sha ${sha.slice(0, 8)} — delivery is joined by head SHA, so one ` +
          "PR's successful run would be credited to the other and a real gap would read as " +
          'delivered. Audit these PRs individually (narrow --since so only one is in range) ' +
          'before trusting this repo.',
      );
    }
  }

  const classes = {
    delivered: [],
    failed: [],
    skipped_anomaly: [],
    never_fired: [],
    pre_onboarding: [],
    // A run that CONCLUDED SUCCESS having enqueued nothing. See verifyPayloads:
    // `delivered` starts as "a successful run exists" and the payload probe
    // demotes the ones that sent no message. Initialised here, not in the
    // probe, so every consumer of `classes` sees the same shape whether or not
    // verification ran — an absent key would read as zero.
    payload_missing: [],
    // The verdict is not knowable YET. Two ways that happens, and both must be
    // here or the other one becomes a false gap:
    //   1. a run exists but has not concluded (`conclusion === null`);
    //   2. the PR merged moments ago and its run row does not exist yet.
    // Neither is a gap nor a delivery — the honest answer is "not known yet", so
    // it is neither replayed nor counted as delivered, and it resolves itself on
    // the next audit. That self-resolution is what makes withholding a verdict
    // safe. A *concluded* run we do not recognize does NOT belong here, because
    // nothing would ever resolve it and it would be invisible forever.
    in_flight: [],
    // "No run row" for a PR merged before the run-history horizon
    // (RUN_HISTORY_DAYS). Undecidable rather than a gap: the record may have
    // been reaped, and there is no API that distinguishes a reaped run from one
    // that never existed. The direction matters — calling it never_fired puts it
    // on the REPLAY list, so a PR that was delivered a year ago gets
    // re-delivered to the prod queue, and consumer-side idempotency is not
    // established (ENG-5789).
    //
    // This is the opposite of in_flight: in_flight resolves itself on the next
    // audit, whereas this NEVER resolves and only gets worse with time. So it is
    // surfaced as its own named class rather than parked — someone has to decide
    // it from outside the Actions API (git history, the consumer table), and
    // burying it in never_fired or delivered would hide that decision.
    unverifiable: [],
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
      } else if (now - Date.parse(pr.merged_at) < GRACE_MS) {
        // The OTHER half of the in_flight problem, and the half the original
        // in_flight fix missed: that one covered "a run exists but has not
        // concluded", while this covers "the run row does not exist YET".
        // GitHub creates and indexes a workflow run a moment after the merge, so
        // a PR merged seconds ago legitimately has no run visible — identical
        // symptom to never_fired, opposite meaning. Calling it never_fired puts
        // a delivery that is about to happen on the replay list, which
        // double-delivers, and consumer-side idempotency is not established
        // (ENG-5789). Withholding is safe for the same reason as in_flight: the
        // window counts back from now, so the next audit sees the settled truth.
        classes.in_flight.push(rec);
      } else if (now - Date.parse(pr.merged_at) > RUN_HISTORY_DAYS * DAY) {
        // Beyond the run-history horizon, "no run row" is not evidence. Ordered
        // AFTER pre_onboarding deliberately: a PR that merged before the repo
        // had a caller is decided by GIT history, which does not expire, so that
        // verdict is still sound out here and is the more useful of the two.
        // Only a PR that WAS expected to deliver and has no queryable record
        // reaches this branch.
        classes.unverifiable.push(rec);
      } else {
        classes.never_fired.push(rec);
      }
      continue;
    }
    rec.run_id = run.id;
    rec.conclusion = run.conclusion;
    // Carried because the runs LIST endpoint returns one row per run at its
    // CURRENT attempt — a re-run mutates the row in place rather than adding one.
    // Measured on guard's leaderboard-metrics: 1537 rows, of which 1532 are at
    // attempt 1, three at 2, one at 3, one at 6, summing to exactly the endpoint's
    // own `total_count`. So an earlier attempt that SUCCEEDED is invisible to
    // dedupeByHead no matter how it ranks rows, and only `/attempts/{n}` can see
    // it. Anything > 1 here means there is hidden history behind this row.
    rec.run_attempt = typeof run.run_attempt === 'number' ? run.run_attempt : 1;
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
  // success either way — PROVIDED both are distinct rows. They are not always.
  // A re-run of the SAME run mutates that row's `conclusion` and `run_attempt`
  // in place, so a success at attempt 1 followed by a failure at attempt 2
  // presents here as a single failed row with no trace of the success. No
  // ranking rule over these rows can recover it; `recoverHiddenDeliveries` reads
  // `/attempts/{n}` for that, and this function does not pretend to.
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
  // payload_missing is a REAL gap and is deliberately absent here. Replay runs
  // the same collect-metrics against the same unresolvable author and produces
  // the same empty payload — the backfill says so itself ("add them to the
  // ENGINEER_EMAIL_MAP repo variable and re-run this PR"). Listing it would hand
  // over a paste that writes to the prod queue and still delivers nothing. The
  // repair is a map edit first, replay second, and the report says that instead.
  return [...classes.failed, ...classes.never_fired, ...classes.skipped_anomaly]
    .map((p) => p.number)
    .sort((a, b) => a - b);
}

// The step, inside the reusable, that actually enqueues the message. Exported so
// the test names it once rather than restating the literal.
export const SQS_STEP = 'Send metrics to SQS';

// `conclusion === 'success'` does NOT prove a delivery, and this is the gap that
// mattered most: collect-metrics exits 0 with `has_payload=false` when no commit
// author or PR opener resolves through ENGINEER_EMAIL_MAP, and the reusable gates
// BOTH AWS steps on `has-payload == 'true'`. The run then concludes success
// having enqueued nothing, no CodeCommit row is written, and an audit that reads
// only the run conclusion files that PR as delivered — a false negative in
// exactly the missing-score class the detector exists to catch.
//
// This is not hypothetical. guard run 28112331529 (2026-06-24, "chore(deps):
// bump aurelian to v1.0.4", author `xoverride`) concluded SUCCESS with steps
// "Configure AWS credentials" and "Send metrics to SQS" both `skipped` and the
// annotation "No payload produced (author email not mapped)". Before this probe
// the audit called it delivered.
//
// Cost: one call per successful run, which makes this the audit's dominant API
// cost on a wide window (guard has ~1054 in 90 days). It is unconditional
// anyway — an opt-in flag would leave the default answer wrong, and the default
// is what CI runs. `api_calls` in the report shows the real number.
// The step probe for ONE run-or-attempt's job list, split out of verifyPayloads
// so a prior attempt (`/attempts/{n}/jobs`) is checked by the same code that
// checks a current run. Duplicating it would let the two drift, and the
// truncation and rename guards below are exactly the parts that must not.
//
// Returns 'sent' | 'not_sent'; throws when the answer is UNKNOWN, because a run
// whose steps cannot be read is never evidence of a delivery.
//
// `requireStep` is what makes this reusable for a run that did NOT succeed. For a
// SUCCESSFUL run, a missing step means the reusable was renamed and the whole
// audit must stop (see below). For a FAILED one it means the run died before
// reaching the send — which is the ordinary case, not an anomaly: 8 of 25 sampled
// guard failures died at `Set up job`, and every one of them would abort the
// audit at exit 2 if absence were fatal here. Passing requireStep:false makes
// absence answer 'not_sent', which leaves the record `failed` and replayable —
// its existing verdict, so this cannot manufacture a delivery.
//
// A rename is still caught: it makes EVERY successful run throw, and there are
// ~1054 of those in a 90-day guard window against 181 failures, so the audit
// exits 2 long before any replay list is published. The success path is the
// rename detector; this flag does not weaken it.
export async function probeSqsStep(client, cfg, repo, jobsPath, label, { requireStep = true } = {}) {
  // per_page is explicit: this endpoint defaults to 30 jobs, and a truncated
  // list would hide a PRESENT delivery step, which then reads as a rename and
  // stops the whole audit at exit 2 for a cause that is not the real one.
  const jobs = await client.gh(`${jobsPath}?per_page=100`);

  // "Could not read the jobs" and "read them, the step is gone" are different
  // facts with different repairs, and they used to collapse into the rename
  // message below: __missing produced steps=[], so a 404 told the operator to
  // update SQS_STEP. Both still FAIL — a run whose steps cannot be read is
  // never evidence of a delivery — but the message has to name its own cause.
  if (!jobs || jobs.__missing) {
    throw new Error(
      `${repo}: ${label} — its jobs could not be read ` +
        '(404 or empty body), so delivery cannot be verified either way and this is ' +
        'UNKNOWN rather than decided. A run past its retention window is the usual ' +
        'cause; narrow the window with --since.',
    );
  }

  const list = jobs.jobs || [];
  // per_page=100 raises the ceiling; it does not remove it. Assert against the
  // server's own count rather than assuming one page is always enough, because
  // the failure is silent in the direction that matters (a present step read
  // as absent).
  if (typeof jobs.total_count === 'number' && jobs.total_count > list.length) {
    throw new Error(
      `${repo}: ${label} reports ${jobs.total_count} jobs but only ${list.length} ` +
        'were returned — the job list is truncated, so a present delivery step could read ' +
        'as absent. This endpoint needs pagination.',
    );
  }

  const steps = list.flatMap((j) => j.steps || []);
  const step = steps.find((s) => s.name === SQS_STEP);
  if (!step && !requireStep) {
    // The run did not reach the send. It never delivered, so its existing
    // replayable verdict stands — see the requireStep note above for why this is
    // not a hole in the rename detector.
    return 'not_sent';
  }
  if (!step) {
    // Absence is NOT treated as delivered. A name probe that silently answers
    // "fine" when it finds nothing is the same fail-open shape as the bug it
    // is fixing, so this stops the audit at exit 2 UNKNOWN instead. The name
    // held for all 1000 successful runs in guard's auditable window, so this
    // fires on a future rename of the reusable's step — a real change that a
    // human must reflect here, not a per-run oddity to shrug off.
    throw new Error(
      `${repo}: ${label} concluded success but has no step named "${SQS_STEP}" — ` +
        "the reusable's step names have changed and delivery can no longer be verified. " +
        'Update SQS_STEP rather than trusting the run conclusion.',
    );
  }
  return step.conclusion === 'success' ? 'sent' : 'not_sent';
}

// Successful run ids grouped by head SHA. Pure, and separate from dedupeByHead
// because dedupeByHead answers "which single row represents this head" while
// this answers "which runs for this head could have sent the payload" — and when
// a head has more than one SUCCESSFUL run those are different questions. Picking
// one success and probing only that one reports payload_missing for a head where
// a sibling success did send: over-reporting rather than double-delivery, but
// still a wrong verdict on a PR whose author DOES have their score.
export function successRunIdsByHead(runs) {
  const m = new Map();
  for (const r of runs) {
    if (r.conclusion !== 'success') continue;
    const ids = m.get(r.head_sha) || [];
    ids.push(r.id);
    m.set(r.head_sha, ids);
  }
  return m;
}

export async function verifyPayloads(client, cfg, repo, recs, altSuccessRunIds = null) {
  const verdicts = new Map();
  for (const rec of recs) {
    const base = `/repos/${cfg.owner}/${repo}/actions/runs/${rec.run_id}`;
    let verdict = await probeSqsStep(client, cfg, repo, `${base}/jobs`, `run ${rec.run_id}`);
    // Only when the winner says nothing was sent is a sibling success worth an
    // API call — so the extra cost is bounded by the payload_missing count (2 in
    // guard's 90-day window), not by the delivered count (~1054).
    if (verdict === 'not_sent') {
      for (const id of altSuccessRunIds?.get(rec.number) || []) {
        if (id === rec.run_id) continue;
        if (
          (await probeSqsStep(
            client,
            cfg,
            repo,
            `/repos/${cfg.owner}/${repo}/actions/runs/${id}/jobs`,
            `run ${id}`,
          )) === 'sent'
        ) {
          rec.sent_by_run_id = id;
          verdict = 'sent';
          break;
        }
      }
    }
    verdicts.set(rec.run_id, verdict);
  }
  return verdicts;
}

// Three different ways an ALREADY-DELIVERED payload can hide behind a row whose
// conclusion is not `success`, all of which end with that PR on the REPLAY list
// and a second copy of its metrics in the prod queue; consumer-side idempotency
// is not established (ENG-5789), and replaying is the one error direction that
// writes. This function closes all three, because they are one class:
//
//   1. The run's OWN `Send metrics to SQS` step succeeded and the job failed
//      afterwards. The send is the last authored step, but harden-runner,
//      configure-aws-credentials and checkout all register post-job cleanup that
//      runs after it and can fail the job — and a cancellation lands the same
//      way. So a `failure`/`cancelled` conclusion does not imply nothing was
//      sent, and this branch never read the steps to find out.
//   2. A PRIOR ATTEMPT of the same run succeeded. A re-run REPLACES the
//      runs-list row rather than adding one, so that success is invisible to
//      every ranking rule dedupeByHead could apply.
//   3. A SIBLING run on the same head succeeded — handled in verifyPayloads,
//      which is the same class approached from the delivered side.
//
// Measured before writing (1): across all 101 non-success leaderboard-metrics
// runs guard has, ZERO carry a successful SQS step — every one dies at `Set up
// job`, `Checkout reusable workflow scripts`, or `Configure AWS credentials`,
// i.e. strictly before the send. So this is latent, not live. It is fixed anyway
// because the two other members of the same class are, and because the failure
// is silent and writes to prod.
//
// Cost is bounded by what would be REPLAYED, not by population: one jobs call
// per failed record, plus attempt probes only for records past attempt 1 (guard:
// 5 of 1537 runs, 2 of them non-success).
export async function recoverHiddenDeliveries(client, cfg, repo, classes) {
  for (const key of ['failed', 'skipped_anomaly']) {
    const kept = [];
    for (const rec of classes[key]) {
      let moved = false;

      // (1) The current run's own send, before spending anything on attempts.
      // Two absences that look alike and must NOT be treated alike:
      //   - jobs UNREADABLE -> probeSqsStep throws, which is right: an unreadable
      //     current run must not silently become "nothing was sent, go replay it".
      //   - jobs readable, SQS step absent -> requireStep:false answers
      //     'not_sent'. This is the ordinary shape of a failed run (it died
      //     before the send), not the rename signal, and making it fatal here
      //     would exit 2 on every wide audit — 8 of 25 sampled guard failures die
      //     at `Set up job`.
      if (
        (await probeSqsStep(
          client,
          cfg,
          repo,
          `/repos/${cfg.owner}/${repo}/actions/runs/${rec.run_id}/jobs`,
          `run ${rec.run_id} (conclusion ${rec.conclusion})`,
          { requireStep: false },
        )) === 'sent'
      ) {
        rec.sent_despite_conclusion = rec.conclusion;
        classes.delivered.push(rec);
        continue; // NOT kept, and no attempt walk: this head already delivered.
      }

      // (2) Descending: the LATEST successful attempt is the one whose payload
      // verdict describes the final state of this head.
      for (let n = (rec.run_attempt || 1) - 1; n >= 1 && !moved; n--) {
        const path = `/repos/${cfg.owner}/${repo}/actions/runs/${rec.run_id}/attempts/${n}`;
        const att = await client.gh(path);
        // A reaped or unreadable ATTEMPT is not fatal here, unlike an unreadable
        // current run: the current row was already read and classified, so the
        // audit still has a verdict. Skipping leaves the existing `failed` —
        // over-reporting, never a silent double-delivery.
        if (!att || att.__missing || att.conclusion !== 'success') continue;
        rec.recovered_attempt = n;
        const verdict = await probeSqsStep(
          client,
          cfg,
          repo,
          `${path}/jobs`,
          `run ${rec.run_id} attempt ${n}`,
        );
        if (verdict === 'sent') classes.delivered.push(rec);
        else {
          rec.payload = 'missing';
          classes.payload_missing.push(rec);
        }
        moved = true;
      }
      if (!moved) kept.push(rec);
    }
    classes[key] = kept;
  }
  return classes;
}

// Which `delivered` records still need the payload probe. Extracted and exported
// because the exclusion list is now TWO fields and the pair is easy to get wrong:
// `recoverHiddenDeliveries` rescues a record by either route, and each stamps a
// different field.
//
//   recovered_attempt      — rescued from a PRIOR attempt. Re-probing would read
//                            the CURRENT (failed) run's jobs and demote it right
//                            back, which is the bug the recover/verify ordering
//                            exists to prevent.
//   sent_despite_conclusion — rescued from the CURRENT run's own send. Re-probing
//                            reads the same jobs list and returns the same
//                            'sent', so it cannot demote — but it is a wasted
//                            call, and leaving it in kept the comment above
//                            false, which is how the next reader learns the wrong
//                            rule.
//
// A record can never carry both: the current-run probe `continue`s before the
// attempt walk.
export function needsPayloadProbe(rec) {
  return rec.recovered_attempt === undefined && rec.sent_despite_conclusion === undefined;
}

// Pure, so the demotion is testable without a network.
export function applyPayloadVerdicts(classes, verdicts) {
  const kept = [];
  for (const rec of classes.delivered) {
    if (verdicts.get(rec.run_id) === 'not_sent') {
      rec.payload = 'missing';
      classes.payload_missing.push(rec);
    } else kept.push(rec);
  }
  classes.delivered = kept;
  return classes;
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

// Rate limits (403/429) plus the server-error family. 501 is deliberately
// absent: "not implemented" is a deterministic answer about the request, so
// retrying it only delays the same failure. Everything else in the 5xx range is
// worth another attempt because the alternative is discarding a whole audit.
// Exported so a test asserts the set rather than restating the literals, which
// would pass no matter what ships.
export const RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504]);

// Exported for the retry tests only. The attempt CAP and the decision to retry
// a rejected fetch are this script's control flow, not the API's semantics, so
// they are worth pinning even though the file otherwise refuses to mock fetch.
export function makeClient(token) {
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
      let res;
      try {
        // A hung socket has no timeout of its own: Node's fetch waits
        // indefinitely, so one stalled connection out of ~880 calls parks the
        // whole audit until the job's 6-hour ceiling kills it — reported as a
        // timeout of the audit rather than of a request, with no partial result
        // and nothing naming the cause. AbortSignal.timeout turns that into an
        // AbortError, which the catch below already treats as a retryable
        // transport failure, so a stall costs one retry instead of the run.
        res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        state.calls++;
      } catch (e) {
        // A REJECTED fetch is a transport failure (dropped socket, DNS, TLS
        // reset), not an answer, and it used to bypass this loop entirely and
        // abort the audit as exit-2 UNKNOWN. That is the same consequence the
        // status retries below exist to avoid, and it is likelier than a 502
        // over the ~880 calls a wide guard window now makes. Counted as a call
        // either way, so api_calls stays honest about what was attempted.
        state.calls++;
        if (attempt === 3) {
          throw new Error(`fetch failed on ${url} after 4 attempts: ${e.message}`);
        }
        // No response means no rate-limit headers to read, so use the floor.
        await new Promise((r) => setTimeout(r, retryDelayMs(new Headers())));
        continue;
      }
      // 403/429 are the rate limits; the 5xx entries are the ephemeral server
      // errors the API emits under load. Both are worth retrying, and both are
      // FATAL to an audit if they are not, because an aborted audit is an exit-2
      // UNKNOWN over the whole repo — one bad gateway on page 30 of 40 discards
      // the other 39 pages of work. The failure mode of retrying a genuinely
      // broken endpoint is bounded by the same 4-attempt cap.
      if (RETRY_STATUS.has(res.status)) {
        if (attempt === 3) {
          throw new Error(`${res.status} on ${url} after 4 attempts`);
        }
        // A 5xx carries no rate-limit headers, so retryDelayMs falls through to
        // its floor. That is the right answer for a transient server error
        // anyway: wait a beat, do not wait a rate-limit window.
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
//
// ── Why the slice threshold is BELOW the hard cap ────────────────────────────
//
// The shortfall check (`got.length < total`) cannot see truncation for a slice
// sitting at or near the cap, because `got.length` is itself CLAMPED to the cap
// and can never exceed it. Concretely, with a threshold at the cap: `total`
// probes as 1000, one more run arrives before the fetch, the fetch returns a
// clamped 1000, and `1000 < 1000` is false — the extra run is silently dropped,
// which is the exact failure class this whole mechanism exists to prevent.
//
// And the blind spot is wider than the boundary itself: at `total = 999`, two
// arrivals make the true count 1001, the fetch still returns 1000, and
// `1000 < 999` is false too. ANY slice close enough to the cap that in-flight
// growth can cross it is unverifiable.
//
// So slices are kept a margin below the cap. Subdividing is cheap (a couple more
// probe calls), the margin is ~30x guard's observed ~30 runs/day, and the
// property recovered is the one that matters: for any slice we actually fetch,
// growth between probe and fetch is OBSERVABLE rather than clamped away.
export const API_CAP = 1000;
export const SLICE_MAX = 900;

// A DIFFERENT cap on a different endpoint, and unlike API_CAP this one is only a
// PAGE SIZE: `GET /repos/:o/:r/commits/:sha` returns at most 300 entries in
// `files` per response, but it does emit `Link: rel="next"`, so the rest is
// reachable. Measured, not taken from the docs: three real palatine commits
// touching 818, 472 and 400 files each came back with exactly 300, and page 2
// held a different set. What makes it worth a name is that nothing in the BODY
// says it was cut — no `truncated` flag, and `files.length === 300` is also what
// a genuine 300-file commit looks like — so code that reads `files` from a single
// `gh` call cannot tell a complete list from a clamped one. The rename probe in
// onboardedAt pages instead. Exported so its tests can size a fixture page at the
// real boundary rather than at a hand-picked number that would still pass if the
// boundary moved.
export const COMMIT_FILES_CAP = 300;

// Exported for tests: `client` is already the only way this reaches the network,
// so a stub client exercises the slicing and the truncation guard directly —
// no fetch mocking, and nothing about the real transport is faked.
//
// API_CAP and SLICE_MAX are exported too, so a test can assert the RELATIONSHIP
// between them (margin wider than a plausible day of churn, SLICE_MAX strictly
// below API_CAP) instead of restating the literals, which would pass no matter
// what ships.
export async function runsInRange(client, cfg, repo) {
  const base = `/repos/${cfg.owner}/${repo}/actions/workflows/${cfg.callerFile}/runs`;
  const out = [];
  // The upper bound stays at NOW even under --until, deliberately asymmetric with
  // the PR filter. A run is created moments AFTER its PR merges, so a PR merged
  // at 23:59:59 on the day before `--until` has its run created on the excluded
  // side of that boundary. Clamping runs to --until would drop it, and a PR whose
  // run was dropped classifies as never_fired — onto the replay list, which
  // writes. Over-fetching runs cannot produce the mirror error: the join is by
  // head SHA against an already-bounded PR list, so a run with no PR in the
  // window is simply never looked up.
  const stack = [[Date.parse(`${cfg.since}T00:00:00Z`), Date.now()]];

  while (stack.length) {
    const [a, b] = stack.pop();
    const range = `${ymd(a)}..${ymd(b)}`;
    const probe = await client.gh(`${base}?per_page=1&created=${encodeURIComponent(range)}`);
    const total = probe?.total_count ?? 0;
    if (total === 0) continue;

    if (total > SLICE_MAX) {
      // Subdivide by date. Day granularity is the floor the `created` filter
      // supports, so a single day over the cap is unrepresentable — throw
      // rather than report a gap we cannot actually see.
      if (ymd(a) === ymd(b)) {
        throw new Error(
          `${repo}: ${total} runs on the single day ${ymd(a)} exceeds the safe slice size of ${SLICE_MAX} (the API's hard cap is ${API_CAP}) and cannot be subdivided further`,
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
    // The other end of the same property. A slice is only fetched when it probed
    // at or below SLICE_MAX, so reaching the hard cap means it grew by at least
    // API_CAP - SLICE_MAX since the probe — and a result set sitting exactly on
    // the cap is indistinguishable from one clamped BY the cap. Growth is
    // normally harmless, but not once it reaches the point where it stops being
    // observable, so this is the one kind of growth that must not pass.
    if (got.length >= API_CAP) {
      throw new Error(
        `${repo}: slice ${range} probed at total_count=${total} but fetched ${got.length} runs, reaching the API's ${API_CAP}-result cap — the result set may be clamped and cannot be trusted`,
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

// A 404 on a SPECIFIC ENDPOINT is meaningful data — no caller file, no commits
// touching that path — which is why `gh` and `ghPaged` deliberately treat one as
// "absent" and carry on. A 404 on the REPOSITORY is not data: it means the audit
// read nothing at all, and every downstream "absent" is then an artifact of that
// rather than a finding. Unchecked, the two are indistinguishable — and the
// indistinguishable outcome is the dangerous one: zero merged PRs, zero gaps,
// exit 0 CLEAN. A typo'd --repo, a renamed repo, or a token that cannot see a
// private one would all report the fleet as healthy, which is precisely the
// silent-success failure class this detector exists to catch.
//
// This function is necessary but was NOT sufficient where it was first placed.
// The original note here claimed fleet mode was "covered incidentally, since
// `hasCaller` cannot return true for a repo the token cannot read" — true, and
// beside the point. `hasCaller` cannot invent a caller, but it can LOSE a
// subject: it answers a repo-level 404 with `false`, so an explicitly requested
// repo is silently struck from the fleet and never reaches the loop in main()
// that calls this. Guarding against a false caller is a different property from
// guarding against a missing subject, and only the first one followed from that
// reasoning. resolveFleet now asserts explicitly named repos up front; see the
// comment there for the measurement.
export async function assertReadable(client, cfg, repo) {
  const meta = await client.gh(`/repos/${cfg.owner}/${repo}`);
  if (!meta || meta.__missing) {
    throw new Error(
      `${cfg.owner}/${repo}: repository not found, or not readable by this token — refusing to audit it. Every "absent" result would be an artifact of that, not a finding.`,
    );
  }
  return meta;
}

// `assertReadable` proves the REPOSITORY is readable. It does not prove the
// ACTIONS API is, and those are separate grants: `contents: read` plus
// `pull-requests: read` without `actions: read` reads repo metadata and the
// merged-PR list perfectly well.
//
// That combination is not hypothetical — in a caller workflow a `permissions:`
// block is a CEILING, so a caller that grants two of the three scopes this
// action documents produces exactly it.
//
// Why it has to fail closed HERE rather than be caught downstream: `ghPaged`
// answers a 404 by breaking out of pagination and returning an EMPTY list, which
// is byte-identical to "this repo has no runs". Every eligible PR then classifies
// `never_fired` and lands on the replay list — the one direction that writes to
// the prod queue. A 403 is already fail-closed (it is in RETRY_STATUS, so it
// throws after 4 attempts), so this closes the 404 half.
//
// The probe is deliberately the REPO-LEVEL runs endpoint, not the
// workflow-specific one `runsInRange` uses. A 404 from
// `/actions/workflows/{file}/runs` is the legitimate "this repo has no caller"
// answer and MUST stay non-fatal; a 404 from `/actions/runs` is "no Actions
// access". Probing the wrong one of those two would abort every repo that simply
// is not onboarded. Costs one call per repo.
export async function assertActionsReadable(client, cfg, repo) {
  const probe = await client.gh(`/repos/${cfg.owner}/${repo}/actions/runs?per_page=1`);
  if (!probe || probe.__missing) {
    throw new Error(
      `${cfg.owner}/${repo}: the Actions API is not readable by this token (404 on /actions/runs) — refusing to audit it. Every run would read as absent and every merged PR as never_fired, which is a replay list built out of a missing permission. The token needs actions:read in addition to contents:read and pull-requests:read.`,
    );
  }
  return probe;
}

// Exported for its tests: the ORDER of the two probes in here is the whole
// correctness property, and it is not observable from any caller's return value —
// a dropped subject and a repo that legitimately has no caller produce the same
// fleet list.
export async function resolveFleet(client, cfg) {
  let names = cfg.repos;
  if (!names) {
    const repos = await client.ghPaged(`/orgs/${cfg.owner}/repos?per_page=100&type=all`);
    names = repos.filter((r) => !r.archived && !r.disabled).map((r) => r.name);
  } else {
    // An explicitly named repo is a SUBJECT, and has to be proven readable
    // BEFORE the caller probe can drop it. `hasCaller` answers a repo-level 404
    // with `false`, which is byte-identical to "readable, but not onboarded" — so
    // one typo'd or token-invisible entry in `--repos good,typo` is quietly
    // removed and the surviving repos still report clean.
    //
    // The zero-fleet guard in main() does not cover this: it fires only when
    // EVERY entry drops, which is the case an operator will never hit, because
    // you mistype one name in a list, not the only name. Measured — `--repos
    // caeruleus,nonexistent-repo-xyz` printed `repos=1` and exited 0, while
    // `--repos nonexistent-repo-xyz` alone exited 2.
    //
    // This is the half of the round-4 fix that was left open: `assertReadable`
    // was added to main(), which runs AFTER this filtering, so it only ever saw
    // the survivors. Auditing the same repo twice costs one `GET /repos/:o/:r`
    // per named repo; both call sites stay because they answer different
    // questions — this one guards discovery, main()'s guards self-audit mode and
    // the org-enumerated fleet, and dropping either would leave a mode uncovered.
    //
    // Org-wide discovery deliberately does NOT get this treatment. There an
    // unreadable repo was never requested, so skipping it is the correct answer
    // rather than a lost subject.
    for (const name of names) await assertReadable(client, cfg, name);
  }
  const fleet = [];
  for (const name of names) if (await hasCaller(client, cfg, name)) fleet.push(name);
  return fleet;
}

// When did this repo get its caller? Used only to separate pre_onboarding from
// never_fired.
//
// This is the earliest commit touching the caller PATH, deliberately NOT the
// earliest revision whose content references `cfg.reusable`. The content-based
// definition looks stricter and is actively wrong here: guard's caller pointed at
// `praetorian-inc/.github/.github/workflows/leaderboard-metrics.yml` from
// 2026-05-20 until it migrated to public-workflows on 2026-07-07. Keying the
// boundary on the CURRENT reusable would therefore date guard's onboarding to
// July and file every merged PR from 05-20 to 07-07 as pre_onboarding — "not a
// gap" — which is exactly the window holding the three-week outage this audit's
// first run found (~178 PRs, ENG-5775). The stricter-looking definition blinds
// the detector to its own headline finding.
//
// The boundary being asked for is "when did delivery become EXPECTED", and that
// is when the repo opted into the metrics program at all, not when it last
// changed which copy of the reusable it calls. `hasCaller` still does a content
// probe, because there the question is a different one: is this repo a subject
// today.
//
// MEASURED, rather than asserted, across all eight repos carrying the caller
// (guard, caeruleus, vespasian, public-workflows, nerva, brutus, titus, julius):
// for every one of them the OLDEST commit touching this path already contained a
// `uses:` line pointing at a leaderboard reusable. So the residual risk of the
// path definition — a repo that carried an unrelated workflow at this exact path
// before onboarding, dating it too early — has zero instances in the fleet.
//
// The same measurement quantifies the cost of the content-based alternative, and
// it is worse than the guard-only case above: FIVE of the eight first-callers
// reference `praetorian-inc/.github/.github/workflows/leaderboard-metrics.yml`,
// the pre-migration location, not `cfg.reusable`. Keying the boundary on the
// current reusable's path would therefore mis-date five of eight repos, not one.
//
// Second residual, measured and deliberately NOT repaired: on a true merge commit
// the file-introducing commit keeps the date it had on the feature branch, which
// can precede the day it reached the default branch, so the boundary lands early
// by up to a branch lifetime and PRs merged in that sliver read `never_fired`
// instead of `pre_onboarding`. Reachability by repo setting, not by assumption —
// guard, palatine and public-workflows are squash-only (`allow_merge_commit:
// false`, `allow_rebase_merge: false`) so it cannot occur there at all, while
// caeruleus and vespasian permit merge and rebase commits, so it can. It has not:
// all four live onboarding commits are single-parent squashes with
// `committer.date == author.date` and a `(#N)` subject. It stays unrepaired
// because the error direction is a NOISY FALSE POSITIVE — an extra reported gap,
// investigated and dismissed — not a missed one, and the fix (resolving when a
// commit landed on the default branch) costs a search-API round trip per repo to
// buy accuracy in a case with zero occurrences. Rebase merges are unaffected:
// rebasing rewrites `committer.date` to the rebase, which is what this reads
// first. If a fleet repo ever switches to merge commits, revisit this before the
// never_fired count is trusted.
export async function onboardedAt(client, cfg, repo) {
  const commits = await client.ghPaged(
    `/repos/${cfg.owner}/${repo}/commits?path=${encodeURIComponent(cfg.callerPath)}&per_page=100`,
  );
  if (!commits.length) return null;
  const dates = commits
    .map((c) => c.commit?.committer?.date || c.commit?.author?.date)
    .filter(Boolean)
    .sort();

  // A RENAME is the one thing that makes both halves of this audit read short at
  // once, and it does it silently. `/commits?path=` does not follow renames (no
  // `--follow`), so if the caller was renamed inside the window the earliest
  // commit here is the RENAME, dating onboarding late and excusing every earlier
  // PR as pre_onboarding — "not a gap". The runs side reads short in the same
  // direction, because runsInRange queries by `cfg.callerFile` and GitHub keys
  // runs to the workflow file, so runs under the old name are simply absent.
  // Late boundary plus missing runs is a FALSE CLEAN — the one verdict this
  // detector must never produce, and the same trap the comment above avoids for
  // the reusable-migration case.
  //
  // Detectable by asking the earliest commit which files it touched and whether
  // this path arrived by rename. Name the previous path so the operator can
  // re-run against it rather than reverse-engineer it.
  //
  // Read the file list with ghPaged, not gh. The single-commit endpoint returns
  // at most COMMIT_FILES_CAP entries per response — verified against three real
  // palatine commits of 818, 472 and 400 files, all of which came back with
  // exactly 300 — and a single `gh` call would therefore see only the first page.
  // That truncation is silent in the ONE direction that matters: our path merely
  // absent from a cut-off list reads as "not a rename", so the probe would agree
  // with whatever it was built to rule out, and only on the biggest commits. The
  // list IS paginated (`Link: rel="next"`, and page 2 returns a different set) —
  // it just is not paginated by the shape of the body, since `files` is a key on
  // an object rather than the top-level array, which is exactly what ghPaged's
  // `pluck` is for. So there is nothing here to refuse: page it and get a
  // complete answer. Onboarding commits are normally one file; this costs one
  // request in the normal case and stays correct in the fleet-wide-migration case
  // that first introduced most of these callers.
  const earliest = commits.reduce((a, c) =>
    (c.commit?.committer?.date || c.commit?.author?.date || '') <
    (a.commit?.committer?.date || a.commit?.author?.date || '')
      ? c
      : a,
  );
  if (earliest?.sha) {
    const files = await client.ghPaged(
      `/repos/${cfg.owner}/${repo}/commits/${earliest.sha}`,
      (body) => body?.files || [],
    );
    const entry = files.find((f) => f.filename === cfg.callerPath);
    if (entry?.status === 'renamed' && entry.previous_filename) {
      // The remediation is TWO runs partitioned at the rename date, and it says
      // so with both bounds. Naming only `--caller-path` was worse than naming
      // nothing: the old filename has no runs after the rename, so a single
      // re-run over the whole window reports every post-rename PR as never_fired
      // and puts already-delivered PRs on the replay list. Guidance that is
      // wrong in the writing direction is followed exactly once.
      const cut = ymd(
        Date.parse(earliest.commit?.committer?.date || earliest.commit?.author?.date),
      );
      throw new Error(
        `${repo}: the caller at ${cfg.callerPath} arrived by RENAME in ${earliest.sha.slice(0, 8)} ` +
          `from ${entry.previous_filename}. Onboarding would date to the rename and runs under ` +
          'the old workflow file would be invisible, so earlier PRs would be excused as ' +
          'pre_onboarding — a false clean. Audit the two periods separately: ' +
          `(1) --caller-path ${entry.previous_filename} --since ${cfg.since} --until ${cut}, then ` +
          `(2) --since ${cut} with the current caller path. Do NOT re-run (1) without --until: ` +
          'the old filename has no runs after the rename, so every later PR would come back ' +
          'never_fired and land on the replay list.',
      );
    }
  }

  return dates[0] || null;
}

async function auditRepo(client, cfg, repo) {
  const sinceTs = Date.parse(`${cfg.since}T00:00:00Z`);
  const untilTs = cfg.until ? Date.parse(`${cfg.until}T00:00:00Z`) : null;

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
  ).filter((p) => {
    if (!p.merged_at) return false;
    const ts = Date.parse(p.merged_at);
    // Upper bound is EXCLUSIVE at midnight UTC, so `--until 2026-06-10` means
    // "everything merged before 2026-06-10", and `--since A --until B` followed
    // by `--since B` partitions the population with no PR in both halves and
    // none in neither. An inclusive bound would double-count the boundary day,
    // which for the rename remediation means auditing the same PRs under two
    // different caller paths and getting two different verdicts for them.
    if (untilTs !== null && ts >= untilTs) return false;
    return ts >= sinceTs;
  });

  const runs = await runsInRange(client, cfg, repo);
  const onboarded = await onboardedAt(client, cfg, repo);
  const classes = classify(prs, dedupeByHead(runs), onboarded ? Date.parse(onboarded) : null);
  // Recover BEFORE the payload probe, not after: a record rescued from a prior
  // attempt joins `delivered` or `payload_missing` with its verdict already
  // determined by the attempt it was rescued from, so running it through
  // verifyPayloads again would re-probe the CURRENT (failed) run and demote it
  // straight back. Ordering is the whole correctness of this pair.
  await recoverHiddenDeliveries(client, cfg, repo, classes);
  const alt = new Map();
  {
    // pr.number -> every successful run id for that head, so verifyPayloads can
    // fall back to a sibling success. Built here because `prs` and `runs` are
    // both in scope; classify's contract stays head-SHA-only.
    const succ = successRunIdsByHead(runs);
    for (const pr of prs) {
      const ids = succ.get(pr.head.sha);
      if (ids && ids.length > 1) alt.set(pr.number, ids);
    }
  }
  // Only the successful runs need the payload probe: every other class already
  // knows it did not deliver, so there is nothing to demote.
  applyPayloadVerdicts(
    classes,
    await verifyPayloads(client, cfg, repo, classes.delivered.filter(needsPayloadProbe), alt),
  );
  const caller = await hasCaller(client, cfg, repo);

  return { repo, onboarded, has_caller: caller, merged_prs: prs.length, classes };
}

// The classes this audit deliberately does NOT decide, phrased for a reader.
// Shared by BOTH report branches on purpose: round 6 fixed the omission of
// `pre_onboarding` in the clean sentence only, which left the identical hole on
// the gaps branch — a fleet where repo A has gaps and repo B is clean-but-29-
// pre_onboarding prints A's table and never mentions B's 29 at all. One
// undecided class fell out of one branch; the same class fell out of the other.
// Building both from the same totals-driven list is what stops a class added
// later from falling out of either.
export function undecidedCaveats(totals) {
  const out = [];
  if (totals.in_flight) {
    out.push(
      `**${totals.in_flight}** are not yet decided either way — the delivery is still ` +
        'running, or the PR merged too recently for its run to exist yet, so re-run the ' +
        'audit once they settle',
    );
  }
  if (totals.pre_onboarding) {
    out.push(
      `**${totals.pre_onboarding}** merged before this repo had a caller, so no ` +
        'delivery was ever expected and they are not gaps — but they did NOT deliver, and ' +
        'only a backfill will score them',
    );
  }
  if (totals.unverifiable) {
    out.push(
      `**${totals.unverifiable}** merged more than ${RUN_HISTORY_DAYS} days ago and ` +
        'have no workflow-run record — GitHub reaps run history, so "no run" out there is ' +
        'not evidence either way. These are NOT replayable on this report: a replay would ' +
        're-deliver anything that did succeed. Decide them from the consumer table, not from ' +
        'the Actions API, or narrow the window',
    );
  }
  return out;
}

export function renderMarkdown(report, cfg) {
  const L = [];
  L.push('## Leaderboard delivery audit');
  L.push('');
  L.push(
    // The header must state the bound it actually used. Printing "→ now" under
    // --until would describe a window wider than the one audited, and a reader
    // comparing two partitioned runs of the rename remediation has no other way
    // to tell which half they are holding.
    `Window \`${report.since}\` → ${report.until ? `\`${report.until}\` (exclusive)` : 'now'}. ` +
      `Merged PRs examined: **${report.totals.merged_prs}**. ` +
      `Delivered: **${report.totals.delivered}** — each one verified to have actually ` +
      'enqueued a payload, not merely to have a successful run.',
  );
  L.push('');
  if (!report.repos_with_gaps.length) {
    // "No gaps" is a claim about the PRs this audit could DECIDE, and two
    // classes are deliberately left undecided. Naming them is not hedging — it
    // is what keeps the sentence true.
    //
    // `in_flight` was covered from round 1. `pre_onboarding` was NOT, and that
    // omission was live rather than theoretical: caeruleus audits 31 merged PRs,
    // 2 delivered, 29 pre-onboarding, and printed "Every merged PR in the window
    // has a successful metrics delivery." False for 29 of 31 — and those 29 are
    // precisely the population a backfill still owes, so the one reader who most
    // needs to act on this report was being told there was nothing to do.
    //
    // Built from the totals rather than written as prose per case, so a class
    // added later cannot silently fall out of the sentence again.
    const caveats = undecidedCaveats(report.totals);
    if (caveats.length) {
      L.push(
        `No gaps among the PRs this audit can decide. Of **${report.totals.merged_prs}** ` +
          `merged PR(s), ${caveats.join('; and ')}. Every other merged PR in the window ` +
          'delivered successfully.',
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
  {
    // The undecided classes belong on THIS branch too. Without this, a repo that
    // is clean apart from an undecided class is absent from `repos_with_gaps`,
    // so nothing about it reaches the report the moment any OTHER repo has a
    // gap — the reader sees a gap list and reasonably concludes it is the whole
    // story. Fleet-wide counts, which is why they are labelled as such: the
    // per-repo tables below break the same classes out for gap repos.
    const caveats = undecidedCaveats(report.totals);
    if (caveats.length) {
      L.push(
        `Fleet-wide, and separate from the gaps below, of **${report.totals.merged_prs}** ` +
          `merged PR(s) this audit did not decide: ${caveats.join('; and ')}.`,
      );
      L.push('');
    }
  }
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
    if (g.payload_missing) {
      L.push(`| ran but sent no payload (author unmapped) | ${g.payload_missing} |`);
    }
    if (g.pre_onboarding) {
      L.push(`| pre-onboarding (not a gap) | ${g.pre_onboarding} |`);
    }
    if (g.in_flight) {
      L.push(`| not yet decided (not a gap, not replayed) | ${g.in_flight} |`);
    }
    if (g.unverifiable) {
      L.push(`| undecidable, run record reaped (not a gap, not replayed) | ${g.unverifiable} |`);
    }
    L.push('');
    if (g.unverifiable) {
      // Deliberately NOT in the replay list and NOT a gap: the run record aged
      // out, so "no run" is not evidence of no delivery, and replaying would
      // re-deliver whatever did succeed. Unlike in_flight this never resolves on
      // its own, so the report has to hand over the PR numbers — otherwise the
      // only trace of the undecided set is a bare count nobody can act on.
      L.push(
        `**${g.unverifiable} PR(s) merged more than ${RUN_HISTORY_DAYS} days ago with no ` +
          'workflow-run record.** GitHub reaps run history, so the Actions API cannot tell a ' +
          'delivery that never fired from one whose record was deleted. Do NOT replay them on ' +
          'the strength of this report — check the consumer table for their `CodeCommit` rows, ' +
          'or narrow `--since` so the window sits inside the retained history.',
      );
      L.push('');
      L.push(
        `Undecidable PRs (${g.unverifiable}): ${g.unverifiable_prs.map((n) => `#${n}`).join(', ')}`,
      );
      L.push('');
    }
    if (g.payload_missing) {
      // Split out from the replay list on purpose. These PRs ran, succeeded, and
      // enqueued nothing because the author did not resolve, so the repair is a
      // map edit — replaying first writes to the prod queue and still delivers
      // nothing. Naming the fix beats naming the count.
      L.push(
        `**${g.payload_missing} PR(s) ran successfully but sent no payload** — no commit ` +
          'author or PR opener resolved through the `ENGINEER_EMAIL_MAP` repo variable, so ' +
          'collect-metrics produced nothing and both AWS steps were skipped while the run ' +
          'still concluded `success`. Replay will not fix these: add the missing logins to ' +
          '`ENGINEER_EMAIL_MAP` FIRST, then replay them.',
      );
      L.push('');
      L.push(`Unmapped-author PRs (${g.payload_missing}): ${g.payload_missing_prs.map((n) => `#${n}`).join(', ')}`);
      L.push('');
    }
    if (!g.replay.length) {
      // Every gap in this repo is a payload_missing one. Emitting the replay
      // preamble and a `-f pr_numbers=''` command here would hand over a paste
      // that dispatches a backfill over nothing.
      continue;
    }
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
  //
  // payload_missing IS a gap condition even though it is not replayable: the
  // author is missing score for that PR, which is the thing this audit measures.
  // Gating the gap verdict on replayability instead would make a repo whose only
  // defect is unfixable-by-replay report as clean.
  const gaps = results.filter(
    (r) =>
      r.classes.failed.length ||
      r.classes.never_fired.length ||
      r.classes.skipped_anomaly.length ||
      r.classes.payload_missing.length,
  );
  return {
    since: cfg.since,
    until: cfg.until,
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
      payload_missing: sum((r) => r.classes.payload_missing.length),
      unverifiable: sum((r) => r.classes.unverifiable.length),
    },
    repos_with_gaps: gaps.map((r) => ({
      repo: r.repo,
      failed: r.classes.failed.length,
      never_fired: r.classes.never_fired.length,
      skipped_anomaly: r.classes.skipped_anomaly.length,
      pre_onboarding: r.classes.pre_onboarding.length,
      in_flight: r.classes.in_flight.length,
      payload_missing: r.classes.payload_missing.length,
      unverifiable: r.classes.unverifiable.length,
      // Carried as numbers, not folded into `replay`: this list is what a human
      // must fix in ENGINEER_EMAIL_MAP before any replay of them is productive.
      payload_missing_prs: r.classes.payload_missing.map((p) => p.number).sort((a, b) => a - b),
      // Same reasoning, opposite remediation: these need a consumer-side lookup,
      // and a replay of them would re-deliver whatever already succeeded.
      unverifiable_prs: r.classes.unverifiable.map((p) => p.number).sort((a, b) => a - b),
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
    // exitCode + return, NOT process.exit: see the note at the end of main().
    // The `return` is load-bearing — setting exitCode does not stop execution,
    // so without it this would fall through to makeClient(undefined) and audit
    // the whole window unauthenticated, which is the failure this check exists
    // to prevent.
    process.exitCode = 2;
    return;
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
    process.exitCode = 2;
    return; // load-bearing, as above
  }

  // Prove every subject is readable BEFORE auditing any of it, so an unreadable
  // repo fails as UNKNOWN instead of producing a clean report over a repo whose
  // every endpoint answered 404. BOTH probes, because they cover different
  // grants and only one of them is implied by the other's success — see
  // assertActionsReadable.
  for (const repo of fleet) {
    await assertReadable(client, cfg, repo);
    await assertActionsReadable(client, cfg, repo);
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
      `payload_missing=${t.payload_missing} ` +
      `pre_onboarding=${t.pre_onboarding} in_flight=${t.in_flight} ` +
      `unverifiable=${t.unverifiable} api_calls=${report.api_calls}`,
  );
  for (const g of report.repos_with_gaps) {
    console.log(
      `  GAP ${g.repo}: failed=${g.failed} never_fired=${g.never_fired} ` +
        `skipped_anomaly=${g.skipped_anomaly} payload_missing=${g.payload_missing} ` +
        `unverifiable=${g.unverifiable} replay=${g.replay.length} PRs`,
    );
  }

  // 0 = clean, 1 = gaps found, 2 = the detector itself could not run. Keeping
  // "found something" distinct from "broke" is the whole point: a caller that
  // treats any non-zero exit as a gap would raise an issue on a rate-limit.
  //
  // exitCode, never process.exit(): stdout is a PIPE under the Actions runner,
  // and Node writes to a pipe asynchronously, so process.exit() terminates
  // without flushing whatever is still queued. Measured on node 22 against a
  // slow consumer, process.exit(1) delivered 56 of 2001 written lines and lost
  // the last one entirely — which here is the summary and the GAP lines, i.e.
  // exactly the evidence that explains the exit code. Assigning exitCode lets
  // main() return and the process exit naturally once the queue drains. The
  // JSON/markdown reports were never at risk (writeFileSync is synchronous).
  process.exitCode = report.repos_with_gaps.length ? 1 : 0;
}

// Only run when executed directly, so the unit tests can import the pure parts.
if (process.argv[1] && process.argv[1].endsWith('audit-delivery.mjs')) {
  main().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exitCode = 2;
  });
}
