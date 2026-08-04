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

  // The SAME defect on the plural flag, which the round-4 fix above left open —
  // the cited instance got fixed, the class did not. `--repos=` leaves out.repos
  // as '', the `if (out.repos)` split below is skipped, and resolveFleet's
  // `if (!names)` is true for '' — so it enumerates the whole org. Measured, not
  // reasoned: `parseArgs(['--repos='])` then resolveFleet issued
  // `GET /orgs/praetorian-inc/repos?per_page=100&type=all`. A caller doing
  // `--repos="$REPOS"` with REPOS unset therefore turns a targeted audit into an
  // org-wide sweep, which is both the wrong subject and ~20x the API budget.
  if (out.repos === '') {
    throw new Error(
      '--repos was passed with an empty value — refusing to fall back to an org-wide fleet audit',
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
    if (out.repos) {
      const raw = out.repos;
      out.repos = out.repos.split(',').map((s) => s.trim()).filter(Boolean);
      // `--repos=,,` survives the '' check above and reaches here as []. That is
      // TRUTHY, so resolveFleet does not org-enumerate — it iterates nothing and
      // returns an empty fleet, which main()'s zero-fleet guard catches at exit 2.
      // Safe, but it reports the WRONG CAUSE: that guard's message blames the
      // fleet probe or the token, when the actual fault is the caller's own flag
      // value. Same class as the round-4 empty-`repo` diagnostic.
      if (!out.repos.length) {
        throw new Error(
          `--repos contained no repository names (got ${JSON.stringify(raw)}) — this is a caller ` +
            'bug in the flag value, not an unreadable org',
        );
      }
    }
  }

  // The SAME class two flags further on. The `--repo` fix and then the `--repos`
  // fix above each closed the cited instance and left the class open; these are
  // the two remaining members. Every date check below is gated on
  // `if (out.since)` / `if (out.until)`, and both are false for '' — so a flag
  // passed empty skips the format, calendar-roll-over, future and ordering
  // checks in their entirety and reads as ABSENT rather than as invalid.
  // Measured with `now` pinned to 2026-08-04T12:00:00Z:
  //   --since 2026-01-01 --until ''  ->  until=(none)      upper bound GONE
  //   --since ''                     ->  since=2026-07-05  the --days default
  //
  // `--until` is the dangerous direction, and it is dangerous on the exact path
  // this tool tells operators to walk: mergeRenames prints a two-step
  // remediation whose own text warns "Do NOT re-run (1) without --until",
  // because an unbounded first step re-reads every post-rename PR as
  // NEVER_FIRED and manufactures a replay list against the prod queue. A shell
  // variable that expands to nothing turns following that instruction into the
  // failure the instruction exists to prevent — silently, since '' currently
  // means "no upper bound" rather than "bad flag".
  if (out.since === '') {
    throw new Error(
      '--since was passed with an empty value — refusing to silently fall back to the --days default',
    );
  }
  if (out.until === '') {
    throw new Error(
      '--until was passed with an empty value — refusing to silently drop the upper bound',
    );
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

  // The FULL path is interpolated into an API URL path as well (`hasCaller`), so
  // validating only the basename below was the same defect one variable over —
  // and that comment names the mechanism exactly ("a value containing `/` or
  // `..` re-targets the request"), about the one part of the path that cannot
  // contain either. Measured, not reasoned: `--caller-path
  // ../../../../orgs/evil/x.yml` passes the basename check (basename `x.yml`),
  // and `new URL('/repos/praetorian-inc/guard/contents/' + that, API_BASE)`
  // resolves to `https://api.github.com/orgs/evil/x.yml` — off the repo
  // entirely, with the Bearer token attached.
  //
  // Deliberately NOT anchored to `.github/workflows/`: the caller-renamed
  // remediation prints `--caller-path <previous_filename>`, and a workflow moved
  // INTO that directory has a previous path outside it, so anchoring would
  // reject the command this report tells an operator to run.
  if (out.callerPath.startsWith('/')) {
    throw new Error(
      `--caller-path must be repo-relative, not absolute, got ${out.callerPath}`,
    );
  }
  if (out.callerPath.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(
      `--caller-path must not contain empty, "." or ".." path segments, got ${out.callerPath}`,
    );
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

  // The REPOSITORY IDENTIFIERS, which the block above should have covered and
  // did not. It says "both are validated, not just the one a reviewer happened to
  // cite" and then validates the two workflow filenames while leaving the owner
  // and repo names — which sit in the SAME URLs, one path segment to the left —
  // completely unchecked. `--repo` was shape-checked only
  // (`/^[^/\s]+\/[^/\s]+$/`: one slash, no whitespace) and `--repos` entries were
  // trimmed and nothing more. Measured, all four ACCEPTED before this:
  //
  //   --repo o/n;id   --repo 'o/n$(id)'   --repo 'o/n`id`'   --repo o/n&&id
  //
  // Only whitespace was rejected, and no payload needs whitespace. That value is
  // then interpolated into the `gh workflow run --repo ${owner}/${repo}` command
  // the report hands to a human mid-incident.
  //
  // The reachable direction is worse than the injection one, and it is a SILENT
  // FALSE CLEAN. `#` and `?` do not need to reach a shell: they re-target the URL
  // in the fetch layer, measured with the WHATWG parser —
  //
  //   /repos/o/guard#old/contents/.github/workflows/c.yml  ->  /repos/o/guard
  //   /repos/o/n?x/pulls                                   ->  /repos/o/n
  //   /repos/../x/pulls                                    ->  /x/pulls
  //
  // — so one entry of `--repos guard#old,caeruleus` collapses BOTH of its probes
  // onto the repo metadata endpoint. `assertReadable` gets a 200 and passes;
  // `hasCaller` gets the same 200, finds no `.content`, and answers `false`. The
  // subject is dropped, `caeruleus` survives so the zero-fleet guard never fires,
  // and the audit reports CLEAN on a fleet that never included the repo it was
  // asked about. Reproduced: `["guard#old","caeruleus"]` -> fleet `["caeruleus"]`,
  // and `guard?x` identically, against `["guard","caeruleus"]` -> both.
  //
  // That defeats `assertReadable`, whose entire purpose is that an explicitly
  // named subject may not be silently dropped. A guard is not load-bearing if the
  // value reaching it can make two different requests look like one.
  //
  // This is round 9's finding one variable over, for the third time in this file:
  // that round fixed `--caller-path` traversal and its comment even says
  // "rejecting `..` does nothing about `?` or `#`, which re-target the request" —
  // about the path, while the repo name in the same URL went unvalidated. The
  // pattern is now explicit: when a value is validated because it lands in a URL
  // path, EVERY value in that path gets the same treatment in the same commit.
  //
  // Charsets are GitHub's own, so nothing legitimate is rejected: an owner is
  // alphanumeric-plus-hyphen, max 39, not hyphen-initial; a repo name is
  // alphanumeric plus `.`, `_`, `-`, max 100. `.` and `..` match that charset and
  // are rejected by name, because they are the traversal segments.
  const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  if (!OWNER.test(out.owner)) {
    throw new Error(
      `owner must be a GitHub login (letters, digits, hyphens; max 39; no leading hyphen), got ${out.owner}`,
    );
  }
  for (const name of out.repos ?? []) assertRepoName(name);
  return out;
}

// Exported because it is used on two populations with different trust levels and
// the same failure direction: operator flags in parseArgs, and the names returned
// by the org enumeration in resolveFleet. The API population should never fail
// this — GitHub cannot mint a repo name outside its own charset — which is
// exactly why it is checked there rather than assumed: if it ever does fail, the
// audit must stop loudly (exit 2, `status=unknown`) instead of quietly walking a
// re-targeted URL. Cost is one regex per repo.
export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export function assertRepoName(name) {
  if (!REPO_NAME.test(name)) {
    throw new Error(
      `repository name must be letters, digits, . _ - (max 100), got ${JSON.stringify(name)} — ` +
        'characters outside that set re-target the API request instead of failing, which drops ' +
        'the subject from the fleet and reports clean',
    );
  }
  if (name === '.' || name === '..') {
    throw new Error(
      `repository name may not be ${JSON.stringify(name)} — it matches the charset and traverses the API path`,
    );
  }
}

// Single-quote for a POSIX shell. Used on values that land inside a command the
// report tells a HUMAN to paste, where the reader is responding to an alert and
// is the least likely person to audit what they were handed.
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

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

// Why a record is `unverifiable`. Carried ON THE RECORD and rendered from the
// records present, rather than written once as prose, because the class started
// with one cause and the report's paragraph said so — "merged more than 400 days
// ago with no workflow-run record". Round 9 added a second cause, and a sentence
// that names one cause for a class that has two is false for whichever half is
// not named. Deriving the causes from the data means a third one added later
// cannot make the paragraph wrong again.
//
// Each string completes "the Actions API cannot decide this delivery because …".
export const UNVERIFIABLE_REAPED =
  `merged more than ${RUN_HISTORY_DAYS} days ago and has no workflow-run record — ` +
  'GitHub reaps run history, so "no run" out there is not evidence either way';
export const UNVERIFIABLE_ATTEMPT_UNREADABLE =
  'an earlier attempt of its run could not be read (404 or empty body), so whether ' +
  'that attempt sent the payload is unknown';

// Classification is pure so it can be unit-tested without touching the network.
// `byHead` is the already-deduplicated head_sha -> run map. `now` is a parameter
// so the grace window is testable against a fixed clock rather than by sleeping;
// every production caller keeps the real clock.
// `outsideWindow` is merged PRs the caller's date window EXCLUDED. They are never
// classified — they only widen the collision guard below, which is blind to a
// collision whose other half sits outside the window. Defaults to empty so every
// existing caller and test keeps its current behaviour.
//
// TWO clock anchors, not one, because the two age tests below want opposite ends
// of the audit's own duration and each has a silent direction to avoid:
//
//   `fetchedAt` — when this repo's PR/run lists were READ. The grace test asks
//     "could a run for this PR exist but not be indexed yet", and the evidence it
//     reasons about is that snapshot, not the wall clock at classification time.
//     A fleet audit is minutes to tens of minutes long (guard's wide run: ~10
//     min), so a `now` read after the fetches ages every PR past a 15-minute
//     grace it was inside of when the list was taken -> false never_fired ->
//     replay -> a second write to prod.
//   `now` — the CURRENT clock, for the run-history horizon. Here the conservative
//     direction is the opposite one: an older anchor makes a PR look younger,
//     which keeps it out of `unverifiable` and inside `never_fired`, i.e. back on
//     the replay list. So this test wants the LATEST time available.
//
// Both asymmetries point the same way — never manufacture a gap — which is why
// they are opposite ends. `fetchedAt` defaults to `now` so every existing caller
// and test is unchanged.
export function classify(
  prs,
  byHead,
  onboardedTs,
  now = Date.now(),
  outsideWindow = [],
  fetchedAt = now,
) {
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
      // The remediation is MANUAL ATTRIBUTION, and it says so instead of naming
      // the narrowing that used to be here. Narrowing --since until only one of
      // the colliders is in range does not clear this repo: it moves the other
      // collider OUTSIDE the window, where the guard immediately below fires on
      // the same precondition this one did (a run exists on the shared SHA) and
      // says narrowing cannot fix it. Measured by following the old advice — step
      // one threw "narrow --since", step two threw "narrowing cannot fix this" —
      // so the operator was sent in a circle while a real gap sat behind it.
      // Guidance that is wrong in the writing direction is followed exactly once,
      // and this file already says so about the rename message below.
      throw new Error(
        `${nums} share head_sha ${sha.slice(0, 8)} — delivery is joined by head SHA, so one ` +
          "PR's successful run would be credited to the other and a real gap would read as " +
          `delivered. Attribute the runs on ${sha.slice(0, 8)} to their PRs by hand before ` +
          'trusting this repo. Narrowing --since to isolate one of them does NOT settle it: ' +
          'that only moves the other outside the window, where it is still credited and this ' +
          'audit refuses again for the same reason.',
      );
    }
  }
  // Same unsoundness, other half outside the window. The remediation is DIFFERENT
  // and that is why this is a separate message rather than a wider count: for an
  // in-window pair the advice is "narrow the window so only one is in range", and
  // here narrowing is what created the problem — the collider is already excluded
  // and its run is still being credited. Only attributing the runs on that SHA by
  // hand settles it.
  for (const pr of outsideWindow) {
    // A closed-unmerged PR fired no delivery, so nothing on its head SHA can be
    // credited to anyone and refusing over it would be a false alarm. auditRepo
    // already filters on merged_at; this is here because classify is pure and
    // exported, and the version without it printed "merged null" into an
    // operator-facing refusal — a message whose own text shows it is wrong.
    if (!pr.merged_at) continue;
    if (!byShaCount.has(pr.head.sha) || !byHead.get(pr.head.sha)) continue;
    const inWin = prs
      .filter((p) => p.head.sha === pr.head.sha)
      .map((p) => `#${p.number}`)
      .join(', ');
    throw new Error(
      `${inWin} (in window) and #${pr.number} (merged ${pr.merged_at}, OUTSIDE the audited ` +
        `window) share head_sha ${pr.head.sha.slice(0, 8)} — delivery is joined by head SHA, ` +
        `so a run belonging to #${pr.number} would be credited to ${inWin} and a real gap ` +
        'would read as delivered. Narrowing the window cannot fix this, because the colliding ' +
        `PR is already excluded by it: attribute the runs on that SHA by hand ` +
        `(gh run list --commit ${pr.head.sha}) before trusting this repo.`,
    );
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
      } else if (fetchedAt - Date.parse(pr.merged_at) < GRACE_MS) {
        // The OTHER half of the in_flight problem, and the half the original
        // in_flight fix missed: that one covered "a run exists but has not
        // concluded", while this covers "the run row does not exist YET".
        // GitHub creates and indexes a workflow run a moment after the merge, so
        // a PR merged seconds ago legitimately has no run visible — identical
        // symptom to never_fired, opposite meaning. Calling it never_fired puts
        // a delivery that is about to happen on the replay list, which
        // double-delivers, and consumer-side idempotency is not established
        // (ENG-5789). Withholding is safe for the same reason as in_flight: the
        // next audit reads a settled run list and decides it for real.
        //
        // Anchored on `fetchedAt`, NOT `now` — see the header. This used to read
        // `now`, with a comment claiming "the window counts back from now, so a
        // freshly merged PR is always in range". That is false as soon as the
        // audit outlives the grace: the PR list is read first, and every minute
        // spent on runs, onboarding and probes moves `now` away from it.
        classes.in_flight.push(rec);
      } else if (now - Date.parse(pr.merged_at) > RUN_HISTORY_DAYS * DAY) {
        // Beyond the run-history horizon, "no run row" is not evidence. Ordered
        // AFTER pre_onboarding deliberately: a PR that merged before the repo
        // had a caller is decided by GIT history, which does not expire, so that
        // verdict is still sound out here and is the more useful of the two.
        // Only a PR that WAS expected to deliver and has no queryable record
        // reaches this branch.
        rec.unverifiable_reason = UNVERIFIABLE_REAPED;
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
// Returns 'sent' | 'not_sent', or 'unknown' when the jobs cannot be read and the
// caller passed unreadableIsFatal:false. It NEVER answers 'not_sent' for an
// unreadable list: a run whose steps cannot be read is not evidence of a delivery,
// and it is not evidence of the absence of one either.
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
// `unreadableIsFatal` is what makes the head-wide walk safe to widen. For the row
// the audit must DECIDE, an unreadable jobs list has to stop everything: turning
// it into "nothing was sent" is a replay instruction built on no evidence. But the
// walk now also probes AUXILIARY evidence — sibling runs on the same head and
// earlier attempts — and those are old by nature (guard's shared heads date from
// the dual-trigger era), so their job lists are the ones GitHub reaps first. With
// a fatal read, one reaped sibling would exit 2 on a whole fleet audit and produce
// no report at all. Passing false answers 'unknown' instead, which the caller
// turns into `unverifiable` for that ONE record: undecided, not replayed, and the
// other repos still get audited.
//
// A rename and a truncated page still throw either way. Those are facts about the
// probe itself being wrong, not about one record's history being unreadable.
export async function probeSqsStep(
  client,
  cfg,
  repo,
  jobsPath,
  label,
  { requireStep = true, unreadableIsFatal = true } = {},
) {
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
    if (!unreadableIsFatal) return 'unknown';
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

  // Steps are flattened across EVERY job in the run, so more than one can carry
  // this name — a matrix over the delivery job produces one per shard, and
  // `.find()` would silently let whichever job the API happens to return first
  // decide delivery for the whole run. That guess is wrong in BOTH directions:
  // pick the shard that succeeded while another failed and a missing delivery
  // reads as clean; pick the failed one and a real delivery reads as a gap.
  // Unanimous matches carry no ambiguity and still decide. A disagreement means
  // the one-send-step-per-run assumption this function is built on no longer
  // holds, which is the same class of violation as the missing-step arm below
  // and gets the same answer: refuse, rather than resolve it by array order.
  const steps = list.flatMap((j) => j.steps || []);
  const matches = steps.filter((s) => s.name === SQS_STEP);
  const step = matches[0];
  if (matches.length > 1) {
    const sent = matches.filter((s) => s.conclusion === 'success').length;
    if (sent !== 0 && sent !== matches.length) {
      throw new Error(
        `${repo}: ${label} has ${matches.length} steps named "${SQS_STEP}" and they ` +
          `DISAGREE (${sent} succeeded, ${matches.length - sent} did not) — delivery for ` +
          'this run cannot be decided from a step name alone. Whichever job the API ' +
          'returned first would otherwise have decided it. Narrow the probe to the ' +
          'delivering job before trusting this repo.',
      );
    }
  }
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

// pr.number -> EVERY runs-list row on that PR's head, newest first. Pure.
//
// Replaces `successRunIdsByHead`, which grouped only the SUCCESSFUL runs. That
// was the wrong population for both probe paths, and in the silent direction: a
// job can complete `Send metrics to SQS` and then die in post-job cleanup
// (harden-runner, configure-aws-credentials and checkout all register post steps,
// and a cancellation lands the same way), so a NON-success sibling is exactly as
// capable of having delivered as a successful one. Filtering them out made the
// probe blind to a delivery on the head it was asked about — and for the records
// `recoverHiddenDeliveries` handles, every sibling is non-success BY
// CONSTRUCTION, because dedupeByHead ranks success first, so a success on that
// head would have won the ranking and the row would not be `failed` at all.
//
// Only heads with more than one row are returned: with a single row the caller's
// own record already IS that row, so an entry would carry no information.
export function headRunsByPr(prs, runs) {
  const byHead = new Map();
  for (const r of runs) {
    const list = byHead.get(r.head_sha) || [];
    list.push({
      id: r.id,
      conclusion: r.conclusion,
      run_attempt: typeof r.run_attempt === 'number' ? r.run_attempt : 1,
      created_at: r.created_at,
    });
    byHead.set(r.head_sha, list);
  }
  // Newest first, explicitly rather than trusting the endpoint's order: the walk
  // below stops at the first send it finds, and "the newest run that sent" is the
  // one an operator will go and read.
  for (const list of byHead.values()) {
    list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }
  const out = new Map();
  for (const pr of prs) {
    const list = byHead.get(pr.head.sha);
    if (list && list.length > 1) out.set(pr.number, list);
  }
  return out;
}

// Every place a delivery for ONE HEAD can hide, walked in cost order, shared by
// both probe paths. `runs` is the caller's own run first, then its siblings on the
// same head newest-first; each entry is `{ id, conclusion, run_attempt }`.
//
// The unit is the HEAD, not the row, because dedupeByHead keeps exactly one run
// per head and the rows it discards are not interchangeable with the one it kept.
// Within a run the unit is the ATTEMPT, and every attempt is probed regardless of
// its own conclusion — for the same reason the row's own run is probed despite a
// failed conclusion: a non-success conclusion is not evidence that nothing was
// sent. Restricting either walk to successes was the same defect in two places.
//
// `requireStep` tracks the CONCLUSION of the run-or-attempt being probed, never
// the call site. For a SUCCESSFUL one a missing send step means the reusable was
// renamed and the whole audit must stop; for a non-success one it means the run
// died before the send, which is ordinary. Hardcoding either answer keeps one of
// those two properties and loses the other, so the flag is derived instead.
//
// Returns:
//   sent             — the first send found: `{ run_id, attempt }`, attempt null
//                      for the run's current state. null if nothing sent.
//   ownLatestSuccess — the latest attempt OF THE CALLER'S OWN RUN that concluded
//                      success and did not send. Own-run-only on purpose: see the
//                      payload_missing branch in recoverHiddenDeliveries.
//   unreadable       — some attempt record could not be read, so "nothing sent
//                      here" is not a fact about this head. Reported alongside
//                      `sent` rather than instead of it: a send that IS found
//                      decides the head no matter what else was unreadable.
async function walkHeadForSend(client, cfg, repo, runs, ownRunId) {
  let ownLatestSuccess = null;
  let unreadable = false;
  for (const run of runs) {
    const own = run.id === ownRunId;
    const base = `/repos/${cfg.owner}/${repo}/actions/runs/${run.id}`;
    const label = own
      ? `run ${run.id} (conclusion ${run.conclusion})`
      : `run ${run.id} (sibling on the same head, conclusion ${run.conclusion})`;
    // Only the OWN run's unreadable jobs are fatal — see probeSqsStep.
    const verdict = await probeSqsStep(client, cfg, repo, `${base}/jobs`, label, {
      requireStep: run.conclusion === 'success',
      unreadableIsFatal: own,
    });
    if (verdict === 'sent') {
      return { sent: { run_id: run.id, attempt: null }, ownLatestSuccess, unreadable };
    }
    if (verdict === 'unknown') unreadable = true;
    for (let n = (run.run_attempt || 1) - 1; n >= 1; n--) {
      const path = `${base}/attempts/${n}`;
      const att = await client.gh(path);
      if (!att || att.__missing) {
        // An unreadable attempt is NOT skipped over silently any more. It used to
        // `continue` with a comment calling that "over-reporting, never a silent
        // double-delivery" — false in the writing direction: leaving the record
        // `failed` leaves it on the REPLAY list, and replaying is what writes to
        // prod. The caller turns this into `unverifiable`, which replayList
        // excludes.
        unreadable = true;
        continue;
      }
      const ok = att.conclusion === 'success';
      // An attempt is auxiliary evidence on every run, the caller's own included:
      // its ROW was already read and classified, so an unreadable attempt makes
      // this head undecided rather than the audit unrunnable.
      const av = await probeSqsStep(client, cfg, repo, `${path}/jobs`, `${label} attempt ${n}`, {
        requireStep: ok,
        unreadableIsFatal: false,
      });
      if (av === 'sent') {
        return { sent: { run_id: run.id, attempt: n }, ownLatestSuccess, unreadable };
      }
      if (av === 'unknown') unreadable = true;
      // `ownLatestSuccess` is set only on a POSITIVE not_sent, never merely
      // because the attempt concluded success. The caller turns it into
      // `payload_missing` — a definite "this PR's author has no score" claim —
      // and a jobs list nobody could read is not evidence for a definite claim.
      // Setting it before the probe (the first way I wrote this) would let one
      // 404 manufacture that claim, which is the same error direction as the
      // silent `continue` above.
      if (av === 'not_sent' && ok && own && ownLatestSuccess === null) ownLatestSuccess = n;
    }
  }
  return { sent: null, ownLatestSuccess, unreadable };
}

export async function verifyPayloads(client, cfg, repo, recs, headRunIds = null) {
  const verdicts = new Map();
  for (const rec of recs) {
    // The own run is probed FIRST and the walk returns on the first send, so the
    // common case (a successful run that did send) still costs exactly one call
    // per delivered record — this function's dominant cost, ~1054 on a 90-day
    // guard window. Siblings and attempts are only reached once the winner has
    // said `not_sent`, which bounds them by the payload_missing count (2).
    const own = {
      // Defaulted to `success`, NOT left undefined, because this function only
      // ever receives `delivered` records and `requireStep` is derived from the
      // conclusion: an absent field would silently answer "not a success", which
      // turns the rename detector OFF for the ~1054-run population it exists to
      // watch — a check that cannot fail. The default is also the conservative
      // direction (requireStep true throws rather than shrugging).
      conclusion: rec.conclusion === undefined ? 'success' : rec.conclusion,
      id: rec.run_id,
      run_attempt: rec.run_attempt || 1,
    };
    const siblings = (headRunIds?.get(rec.number) || []).filter((r) => r.id !== rec.run_id);
    const { sent, unreadable } = await walkHeadForSend(
      client,
      cfg,
      repo,
      [own, ...siblings],
      rec.run_id,
    );
    let verdict = 'not_sent';
    if (sent) {
      verdict = 'sent';
      // The own run's own current state sending is the ORDINARY case and gets no
      // stamp. Anything else is a rescue, and the field says which hiding place
      // it came out of, because that is where an operator has to look.
      if (sent.run_id !== rec.run_id) {
        rec.sent_by_run_id = sent.run_id;
        if (sent.attempt !== null) rec.sent_by_run_attempt = sent.attempt;
      } else if (sent.attempt !== null) rec.sent_by_attempt = sent.attempt;
    } else if (unreadable) {
      // Nothing sent that could be READ. `not_sent` here would demote the record
      // to payload_missing — a definite "this author has no score" claim built on
      // an attempt nobody could read. `unverifiable` is the class for exactly that.
      verdict = 'unverifiable';
      rec.unverifiable_reason = UNVERIFIABLE_ATTEMPT_UNREADABLE;
    }
    verdicts.set(rec.run_id, verdict);
  }
  return verdicts;
}

// Every way an ALREADY-DELIVERED payload can hide behind a row whose conclusion
// is not `success` — each of which ends with that PR on the REPLAY list and a
// second copy of its metrics in the prod queue; consumer-side idempotency is not
// established (ENG-5789), and replaying is the one error direction that writes.
// They are one class, and the walk is one function (`walkHeadForSend`) so a place
// closed on this side cannot stay open on the delivered side:
//
//   - The run's OWN `Send metrics to SQS` step succeeded and the job failed
//     afterwards. The send is the last authored step, but harden-runner,
//     configure-aws-credentials and checkout all register post-job cleanup that
//     runs after it and can fail the job — and a cancellation lands the same way.
//     So a `failure`/`cancelled` conclusion does not imply nothing was sent.
//   - A PRIOR ATTEMPT of the same run sent. A re-run REPLACES the runs-list row
//     rather than adding one, so that attempt is invisible to every ranking rule
//     dedupeByHead could apply.
//   - A SIBLING RUN on the same head sent. dedupeByHead keeps ONE row per head,
//     and for the records that reach this function every discarded sibling is
//     non-success by construction (a success would have won the ranking), which
//     is precisely why filtering siblings to successes — as the old
//     `successRunIdsByHead` did — left this open on both sides.
//   - Any ATTEMPT of any of those, success or not, for the first reason above.
//
// Not an enumeration to trust: the walk is head-wide and attempt-exhaustive, so a
// hiding place is covered by the traversal rather than by appearing on this list.
//
// Measured on the first of them: across all 101 non-success leaderboard-metrics
// runs guard has, ZERO carry a successful SQS step — every one dies at `Set up
// job`, `Checkout reusable workflow scripts`, or `Configure AWS credentials`,
// i.e. strictly before the send. So it is latent, not live, and fixed anyway
// because the failure is silent and writes to prod.
//
// Cost is bounded by what would be REPLAYED, never by population: one jobs call
// per record here, plus one per sibling on a shared head, plus attempt probes only
// for runs past attempt 1 (guard: 5 of 1537 runs, 2 of them non-success).
export async function recoverHiddenDeliveries(client, cfg, repo, classes, headRunIds = null) {
  for (const key of ['failed', 'skipped_anomaly']) {
    const kept = [];
    for (const rec of classes[key]) {
      const own = {
        id: rec.run_id,
        conclusion: rec.conclusion,
        run_attempt: rec.run_attempt || 1,
      };
      const siblings = (headRunIds?.get(rec.number) || []).filter((r) => r.id !== rec.run_id);
      const { sent, ownLatestSuccess, unreadable } = await walkHeadForSend(
        client,
        cfg,
        repo,
        [own, ...siblings],
        rec.run_id,
      );
      if (sent) {
        // Which hiding place it came out of, because that is what an operator has
        // to open to check the claim. `needsPayloadProbe` keys on these fields, so
        // every rescue route must stamp one of them.
        if (sent.run_id === rec.run_id) {
          if (sent.attempt === null) rec.sent_despite_conclusion = rec.conclusion;
          else rec.recovered_attempt = sent.attempt;
        } else {
          rec.sent_by_run_id = sent.run_id;
          if (sent.attempt !== null) rec.sent_by_run_attempt = sent.attempt;
        }
        classes.delivered.push(rec);
      } else if (unreadable) {
        // Nothing sent that could be READ. The old code `continue`d past the
        // unreadable attempt and left the record `failed`, which its own comment
        // called "over-reporting, never a silent double-delivery". Wrong in the
        // writing direction: `failed` IS the replay list, and a replay writes.
        // `unverifiable` is the existing class for "delivery cannot be decided",
        // and replayList excludes it.
        //
        // Ordered BEFORE payload_missing, which is the reverse of how I first
        // wrote it. The argument for the other order was "positive evidence
        // outranks an unreadable one, or a 404 silences a real gap" — true about
        // evidence, wrong about the CLAIM. payload_missing asserts this PR
        // delivered nothing and sends an operator to edit ENGINEER_EMAIL_MAP and
        // re-run, and the re-run writes to the prod queue. An unreadable sibling
        // or attempt is a place the send could be hiding, so that assertion is
        // not established. Undecided-with-a-reason loses no information: the
        // report names the reason and points at `gh run list --commit <sha>`.
        rec.unverifiable_reason = UNVERIFIABLE_ATTEMPT_UNREADABLE;
        classes.unverifiable.push(rec);
      } else if (ownLatestSuccess !== null) {
        // Every piece of evidence on this head was READ, none of it a send, and
        // an attempt of THIS row's run concluded success — only now is
        // payload_missing honest. Stamped with the LATEST such attempt, because
        // that is the one an operator will open.
        //
        // Own-run-only: a SIBLING that succeeded without sending is not evidence
        // about this row's payload, so it cannot earn this class; such a record
        // simply stays on the replay list, which is the reported direction rather
        // than the silent one.
        rec.recovered_attempt = ownLatestSuccess;
        rec.payload = 'missing';
        classes.payload_missing.push(rec);
      } else kept.push(rec);
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
//   sent_by_run_id         — rescued from a SIBLING run on the same head.
//                            Re-probing reads THIS row's run, which is the failed
//                            one that sent nothing, so it demotes a delivery that
//                            was just proven — the same trap as the attempt case,
//                            reached by the route added in round 9.
//
// A record carries exactly one: `walkHeadForSend` returns on the first send it
// finds, and each route stamps its own field.
export function needsPayloadProbe(rec) {
  return (
    rec.recovered_attempt === undefined &&
    rec.sent_despite_conclusion === undefined &&
    rec.sent_by_run_id === undefined
  );
}

// Pure, so the demotion is testable without a network.
export function applyPayloadVerdicts(classes, verdicts) {
  const kept = [];
  for (const rec of classes.delivered) {
    const verdict = verdicts.get(rec.run_id);
    if (verdict === 'not_sent') {
      rec.payload = 'missing';
      classes.payload_missing.push(rec);
    } else if (verdict === 'unverifiable') {
      // Not `delivered` (nothing readable sent) and not `payload_missing` (that
      // asserts the author has no score, on the strength of an attempt nobody
      // could read). Both of those are claims; this class is the absence of one.
      classes.unverifiable.push(rec);
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
  const state = { calls: 0, dupes: 0 };
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
  // `identity` is REQUIRED and is the row's key. It used to be inferred from the
  // row's shape — `it.id ?? it.number ?? it.sha` — and that guess is wrong for
  // exactly one of the five call sites, in the false-clean direction. On a
  // single-commit page a file's `sha` is the BLOB hash, i.e. its CONTENT, so two
  // files with identical bytes in one commit collided and the second was dropped
  // and counted as a benign `dupes++`. When the dropped row is the caller
  // workflow itself, onboardedAt's rename probe below cannot find it, reads "not
  // a rename", dates onboarding to the rename commit and excuses every earlier
  // PR as pre_onboarding — a false clean, and one that depends on nothing but
  // the order two files happen to appear in. Measured: same blob with the caller
  // SECOND returned a clean onboarding date, caller FIRST threw, and distinct
  // blobs threw in both orders.
  //
  // So the fix is the boundary, not the one site: a shape guess that is right
  // four times out of five is a trap for the sixth caller, who inherits whichever
  // field happens to exist. Declaring the key makes the commits site's `sha` —
  // where a commit SHA genuinely IS the row identity — read as a deliberate
  // choice rather than as the same coincidence. Fail CLOSED on a missing
  // declaration: an undeclared key throws, which surfaces as exit 2 /
  // `status=unknown`, never as a quietly shorter list.
  // There is deliberately NO early-stop hook. One existed, unused by all five
  // callers, and an unused early stop in this particular function is worse than
  // dead code: truncating a walk is the exact mechanism behind every false clean
  // this script exists to refuse, so shipping the lever invites a future
  // "optimization" to reintroduce it in one line. A caller that genuinely needs
  // to stop early must add it back and argue for it here, against the note on the
  // closed-PR fetch in auditRepo explaining why ordering makes it unsafe there.
  async function ghPaged(path, pluck, { identity } = {}) {
    if (typeof identity !== 'function') {
      throw new Error(
        `ghPaged(${path}): an explicit \`identity\` function is required — the row key ` +
          'must be declared by the caller, never inferred from the row shape.',
      );
    }
    let url = path;
    const items = [];
    const seen = new Set();
    while (url) {
      const res = await request(url);
      if (res.status === 404) break;
      if (!res.ok) throw new Error(`${res.status} on ${url}`);
      const body = await res.json();
      const batch = pluck ? pluck(body) : body;
      // Paginating a list that MUTATES under the cursor can hand back the same
      // row twice, and a duplicate is not cosmetic here: it double-counts a
      // merged PR (inflating merged_prs) or a run, and — worse — it inflates
      // `got.length` in runsInRange, where the shortfall assertion is
      // `got.length < total`. A duplicate can therefore MASK a real truncation,
      // defeating the one check standing between this audit and the silent
      // 1000-cap clamp that shipped 420 phantom gaps. Deduping strengthens that
      // assertion rather than weakening it: after this, a short slice is short.
      //
      // Counted rather than thrown, because with the immutable orderings below a
      // duplicate proves an INSERTION, which loses nothing — see the note on the
      // closed-PR fetch in auditRepo for why insertion is the benign direction
      // and what the residual is.
      for (const it of batch) {
        // A row whose declared key is absent is PUSHED THROUGH undeduped rather
        // than dropped or thrown on. Dropping is the false-clean direction at the
        // walks that CARRY the gaps — drop a closed-PR row and that merged PR is
        // never audited, so its missing delivery is never reported; drop the
        // caller's row from a commit's file list and a rename goes undetected —
        // and every current call site's key (`id`, `number`, `filename`, a commit
        // `sha`) is mandatory in the API's own schema, so a nullish key means the
        // response is not the shape we think it is, and keeping the row preserves
        // the evidence for the assertions downstream.
        //
        // The residual runs the other way, and only at runsInRange: there,
        // dropping would UNDERSTATE `got.length` and trip `got.length < total`
        // into a refusal (noisy, but fail-closed), whereas keeping a keyless row
        // that the mutating list served twice counts it twice and can mask a
        // truncation of exactly that size — `got.length > total` is tolerated as
        // ordinary insertion two paragraphs above, so nothing else catches it.
        // Reaching it needs all three at once: a runs response violating its own
        // schema, that row re-served under the cursor, and a matching shortfall.
        // Not worth a per-call-site policy; recorded so the next reader does not
        // read the paragraph above as "keeping is safe everywhere".
        const id = identity(it) ?? null;
        if (id !== null) {
          if (seen.has(id)) {
            state.dupes++;
            continue;
          }
          seen.add(id);
        }
        items.push(it);
      }
      // Extracted by REGEX, not by splitting on ',': a URL carrying a comma in a
      // query parameter splits the `rel="next"` entry in two, and the half that
      // matches `rel="next"` is then missing its opening `<`, so the slice below
      // returned junk and pagination stopped SILENTLY at page 1 — a truncated
      // fetch read as a complete one, i.e. a false clean. No URL this script
      // builds contains a comma today, so this is a latent trap rather than a
      // live defect; it is one line either way, and the failure direction is the
      // one this whole script exists to refuse.
      const link = res.headers.get('link') || '';
      const next = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
      url = next ? next[1] : null;
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
  // writes. Over-fetching runs is very nearly free of the mirror error: the join
  // is by head SHA against an already-bounded PR list, so a run whose own PR is
  // outside the window is normally never looked up. The one exception is a head
  // SHA shared by an in-window and an out-of-window PR, where the excluded PR's
  // run IS looked up and credited — auditRepo therefore feeds the excluded merged
  // PRs to classify's collision guard, which refuses that case rather than
  // clamping runs and reintroducing the false never_fired described above.
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
      { identity: (r) => r.id },
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

export async function hasCaller(client, cfg, repo) {
  // Encoded per SEGMENT, never as a whole string: encodeURIComponent turns `/`
  // into `%2F`, which the contents API does not read as a directory separator,
  // so encoding whole would 404 on every legitimate nested path — i.e. on the
  // default. Both this and the `..` rejection in parseArgs are load-bearing and
  // neither implies the other: encodeURIComponent leaves `..` untouched (dots
  // are unreserved), and rejecting `..` does nothing about `?` or `#`, which
  // re-target the request just as effectively by starting a query or a fragment
  // — `.github/wo?rk/x.yml` requests `/repos/o/r/contents/.github/wo`.
  const path = cfg.callerPath.split('/').map(encodeURIComponent).join('/');
  const f = await client.gh(`/repos/${cfg.owner}/${repo}/contents/${path}`);
  if (!f || f.__missing || !f.content) return false;
  // CONTENT probe: the caller must actually call the reusable. A repo can carry
  // a same-named file that calls something else entirely. Content, not
  // filename, and not the check name: a workflow has three independent
  // identities and they routinely disagree, so a filename probe under-counts.
  //
  // But a raw substring probe over the whole file counts a MENTION as a call, and
  // that is not hypothetical — it fires on this repo, on the default path, in
  // org-enumerated fleet mode. `public-workflows` IS the reusable's home, so the
  // default --caller-path resolves to the reusable ITSELF, and that file carries a
  // commented drop-in caller template whose `uses:` line names its own pinned ref:
  //
  //   #       uses: praetorian-inc/public-workflows/.github/workflows/leaderboard-metrics.yml@<sha>
  //
  // Measured: the substring matched, so hasCaller said true and the repo joined
  // the fleet — while `/actions/workflows/leaderboard-metrics.yml/runs` reported
  // total_count=0, because a reusable accrues no runs of its own; the real
  // deliveries are recorded against this repo's actual caller,
  // leaderboard-metrics-caller.yml (total_count=15). Every merged PR would then
  // classify never_fired and the report would print a replay command against the
  // PROD queue for deliveries that had in fact succeeded. A fabricated replay list
  // is the worst output this tool can produce, and a commented example was enough
  // to produce it.
  //
  // So: strip comments and require the reference to sit on a `uses:` line. A YAML
  // comment starts at a `#` that begins a line or follows whitespace (`a#b` is
  // not one), which is why the strip is anchored rather than a bare indexOf('#') —
  // and why a real caller's trailing ` # v2.16.3` version pin is removed without
  // touching the ref in front of it. Requiring `uses:` is the half that turns
  // "mentions" into "calls"; both halves are needed, since a commented line
  // still contains `uses:`.
  const stripComment = (l) => l.replace(/(^|\s)#.*$/, '$1');
  return b64(f.content)
    .split('\n')
    .some((l) => {
      const code = stripComment(l);
      return /(^|\s)uses:\s/.test(code) && code.includes(cfg.reusable);
    });
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
  const discovered = !names;
  if (discovered) {
    // Same immutable ordering as the closed-PR fetch, for the same reason and in
    // the same direction. This endpoint defaults to created DESC, so a repo
    // created mid-enumeration lands at position 1 and shifts a boundary row past
    // the cursor — dropping a repo from the fleet. A dropped repo is never
    // audited, reports nothing, and the fleet still says clean: the identical
    // false-clean direction, one level up. Explicit asc so new repos append
    // behind the cursor instead.
    const repos = await client.ghPaged(
      `/orgs/${cfg.owner}/repos?per_page=100&type=all&sort=created&direction=asc`,
      undefined,
      { identity: (r) => r.id },
    );
    names = repos.filter((r) => !r.archived && !r.disabled).map((r) => r.name);
  }

  // ONE validation site, covering BOTH provenances, ahead of every request that
  // embeds a name. A name outside GitHub's charset does not 404 — it RE-TARGETS
  // the URL, and the symptom here is a repo quietly missing from the fleet,
  // byte-indistinguishable from "not onboarded". If this ever throws the audit
  // stops loudly at exit 2 / `status=unknown`, the only acceptable outcome for a
  // detector that cannot trust its own subject list.
  //
  // Both branches, deliberately, and not because the org API might return a name
  // GitHub itself forbids. Validating only the discovered branch would leave the
  // EXPLICIT one trusting `parseArgs` to have run — true of the CLI path and of
  // nothing else, and this function is exported. That is the same "one variable
  // over" shape being fixed at the parse boundary: the guard has to sit where the
  // value meets the URL, not at whichever entrance was audited first.
  for (const name of names) assertRepoName(name);

  if (!discovered) {
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
    undefined,
    // A COMMIT sha is the row identity here, unlike the blob `sha` on the
    // single-commit file page below. Declared rather than inherited precisely so
    // the two cannot be confused again.
    { identity: (c) => c.sha },
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
      // FILENAME, not `sha`: on this endpoint `sha` is the blob hash, so two
      // identical files collide and the loser is dropped — and the row this probe
      // needs is the caller workflow. A path appears at most once in one commit's
      // file list (a rename appears once, as the new path), so the filename is the
      // row identity.
      { identity: (f) => f.filename },
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
          // QUOTED, because this is the one value in the sentence that comes from
          // the AUDITED REPO rather than from this process: a git filename may
          // contain `;`, `$(…)`, backticks and spaces, and the sentence it lands
          // in is a two-step command the report tells an operator to run while
          // responding to a false-clean alert. A rename FROM a hostile filename
          // is a stored payload with a human as the interpreter. Quoting rather
          // than validating, deliberately: the value is DATA here, and rejecting
          // it would turn a weird-but-legitimate filename into a refusal to
          // report the rename at all — which is the false clean this message
          // exists to prevent.
          `(1) --caller-path ${shq(entry.previous_filename)} --since ${cfg.since} --until ${cut}, then ` +
          `(2) --since ${cut} with the current caller path. Do NOT re-run (1) without --until: ` +
          'the old filename has no runs after the rename, so every later PR would come back ' +
          'never_fired and land on the replay list.',
      );
    }
  }

  return dates[0] || null;
}

// Exported for the boundary-collision test. The wiring is the load-bearing half
// of that guard — classify() cannot see an out-of-window PR unless auditRepo
// hands it one — and a pure classify() test passes whether or not this function
// actually does.
export async function auditRepo(client, cfg, repo) {
  // Read BEFORE the first fetch, and used only for the in_flight grace window —
  // see the two-anchor note on classify(). Per repo rather than per process
  // because it dates THIS repo's PR snapshot, which is what the grace test reasons
  // about; a process-wide start would be conservative too, just needlessly looser
  // for repo #20 of a fleet.
  const fetchedAt = Date.now();
  const sinceTs = Date.parse(`${cfg.since}T00:00:00Z`);
  const untilTs = cfg.until ? Date.parse(`${cfg.until}T00:00:00Z`) : null;

  // `pulls` is a plain list endpoint and is NOT subject to the 1000-result cap
  // that bites the runs endpoint (guard returned all 1419).
  //
  // ORDERED BY AN IMMUTABLE KEY, AND THIS IS LOAD-BEARING.
  //
  // This fetch used to be `sort=updated&direction=desc` with an early stop once
  // updated_at fell below --since — cheap, and unsound. Offset pagination reads
  // POSITIONS, so any row that moves between page N and page N+1 shifts the rest:
  // a PR sitting at position 250 that gets touched (a comment, a label, a push)
  // jumps to position 1, every row behind it shifts back one, and the row that
  // was at the page boundary is now BEHIND the cursor and is never returned. It
  // is dropped from the audit entirely. `updated_at` is the most frequently
  // mutated field on the resource, so the old ordering maximised exactly the
  // event that loses rows, on the busiest repos, on every audit.
  //
  // A dropped merged PR cannot be classified, so it cannot be reported as a gap:
  // the loss direction is a FALSE CLEAN, which is the one direction this detector
  // exists to eliminate.
  //
  // `created_at` never changes, so no row can move. What remains is insertion and
  // removal of rows, and with direction=asc the two are not symmetric:
  //   * INSERTION — a PR closing mid-audit joins the list at its creation
  //     position. Ordered oldest-first that is at or after the cursor, so nothing
  //     already read shifts out of reach; at worst one row is served twice, and
  //     ghPaged dedupes it (counted as state.dupes).
  //   * REMOVAL — a closed PR being REOPENED leaves the list and shifts the tail
  //     forward one, which can carry a row past the cursor with no duplicate to
  //     signal it. This is the one residual, and it is not closed here: it needs a
  //     mutation-free snapshot the REST API does not offer. It is bounded by "a
  //     reopen must land inside the seconds this loop is running", against a
  //     merged-PR field that cannot itself be reopened.
  // Descending would invert this — new closes would land at position 1 and shift
  // the whole list — so the direction is as load-bearing as the sort key.
  //
  // The cost is a full history walk: asc puts the window at the END, so there is
  // no valid early stop (measured: guard 65 pages, public-workflows 2,
  // caeruleus 1, at 100/page). That buys back more than it spends — see the
  // boundary-coverage note below, which the old early stop is what made partial.
  const fetched = await client.ghPaged(
    `/repos/${cfg.owner}/${repo}/pulls?state=closed&per_page=100&sort=created&direction=asc`,
    undefined,
    { identity: (p) => p.number },
  );
  const inWindow = (p) => {
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
  };
  const prs = fetched.filter(inWindow);
  // Merged PRs the window EXCLUDED, kept only so the head-SHA collision guard in
  // classify() can see them. runsInRange deliberately over-fetches past --until,
  // and its comment claims that is harmless because "a run with no PR in the
  // window is simply never looked up". That claim is false in exactly one case:
  // if an EXCLUDED merged PR shares a head SHA with an INCLUDED one, the excluded
  // PR's run is looked up — under the included PR's SHA — and credited to it. The
  // in-window guard cannot see it, because from inside the window that SHA has a
  // count of one. So a collision straddling the boundary is the one collision that
  // reads as a clean delivery, which is the failure direction this whole guard
  // exists to refuse.
  //
  // Reachability is not hypothetical on either half. Collisions are OBSERVED (two
  // pairs in guard's 5291 merged PRs, one branch opened against two bases), and
  // the two-window partition is the DESIGNED workflow for the caller rename above
  // — `--since A --until cut` then `--since cut` — so the boundary is something
  // operators are told to place, not an accident.
  //
  // Coverage is now COMPLETE on both sides, and the immutable ordering above is
  // what made it so. The previous revision of this comment recorded the upper
  // side as complete and the lower side as best-effort, because pagination walked
  // from newest and stopped once updated_at fell below --since — so a PR merged
  // before the window was present only if something had touched it since, and
  // closing that "properly means paging further back on every audit". Removing
  // the early stop is exactly that page-further-back, and it was not adopted for
  // this reason: it fell out of fixing the drift defect. Both halves of the
  // collision guard are now fed by the same full history, so a collision
  // straddling EITHER boundary is visible.
  //
  // Worth recording as the shape of the mistake: the asymmetry was reasoned about
  // carefully and defended as principled, while the ordering that produced it was
  // not examined at all. The cheap half of a guard was documented as the honest
  // limit of the expensive half.
  const outsideWindow = fetched.filter((p) => p.merged_at && !inWindow(p));

  const runs = await runsInRange(client, cfg, repo);
  const onboarded = await onboardedAt(client, cfg, repo);
  const classes = classify(
    prs,
    dedupeByHead(runs),
    onboarded ? Date.parse(onboarded) : null,
    Date.now(),
    outsideWindow,
    fetchedAt,
  );
  // pr.number -> every run on that PR's head. Built here because `prs` and `runs`
  // are both in scope (classify's contract stays head-SHA-only), and built ONCE
  // for both probe paths: they ask the same question from opposite sides, and the
  // round-8 finding was one of them being fixed while the other was not.
  const headRunIds = headRunsByPr(prs, runs);
  // Recover BEFORE the payload probe, not after: a record rescued from a prior
  // attempt or a sibling run joins `delivered` or `payload_missing` with its
  // verdict already determined by the run it was rescued from, so running it
  // through verifyPayloads again would re-probe the CURRENT (failed) run and
  // demote it straight back. Ordering is the whole correctness of this pair, and
  // `needsPayloadProbe` is the other half of it.
  await recoverHiddenDeliveries(client, cfg, repo, classes, headRunIds);
  // Only the successful runs need the payload probe: every other class already
  // knows it did not deliver, so there is nothing to demote.
  applyPayloadVerdicts(
    classes,
    await verifyPayloads(
      client,
      cfg,
      repo,
      classes.delivered.filter(needsPayloadProbe),
      headRunIds,
    ),
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
//
// `unverifiableReasons` is the distinct set of per-record reasons actually
// present. Passing them rather than hardcoding the paragraph is what keeps the
// `unverifiable` sentence true as the class grows a second and third cause;
// defaults to empty so a caller that has none still gets a correct, if less
// specific, sentence.
export function undecidedCaveats(totals, unverifiableReasons = []) {
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
    const because = unverifiableReasons.length
      ? ` — ${unverifiableReasons.join('; or ')}`
      : ' for want of a readable run record';
    out.push(
      `**${totals.unverifiable}** cannot be decided from the Actions API${because}. These ` +
        'are NOT replayable on this report: a replay would re-deliver anything that did ' +
        'succeed. Decide them from the consumer table, not from the Actions API, or narrow ' +
        'the window',
    );
  }
  return out;
}

// The distinct `unverifiable` reasons across a set of records, in a stable order
// so the report does not churn between runs.
export function unverifiableReasons(recs) {
  return [...new Set(recs.map((r) => r.unverifiable_reason).filter(Boolean))].sort();
}

// The audit's evidence ceiling, stated in the REPORT and not only in this file's
// header. The deepest probe is step-level: probeSqsStep reads the `Send metrics
// to SQS` step's conclusion, so `delivered` means "enqueued to the metrics
// queue", never "scored". Nothing here reads DynamoDB.
//
// That makes the two directions asymmetric, and only one of them was stated. The
// GAPS direction is sound — a payload never enqueued cannot produce a
// `CodeCommit` row. The CLEAN direction was not: a payload that enqueued and was
// then dropped consumer-side classifies `delivered`, and the report told the
// operator "Every merged PR in the window has a successful metrics delivery",
// i.e. everyone got their score. ENG-5775 is a MEASURED instance of exactly that
// — Leaderboard V2 shipped dark while producer runs stayed green — so this is
// the live failure mode, not a theoretical one. A false clean is also the one
// direction this whole detector exists to eliminate, which is why it may not be
// left implicit here.
//
// ENG-5689 requires the fix to state what its chosen signal does not cover.
// undecidedCaveats covers the classes the audit cannot DECIDE; this covers the
// boundary past which it cannot SEE.
const COVERAGE_CEILING =
  '_Coverage: this audit verifies delivery **to the metrics queue** only. A payload that ' +
  'enqueued successfully and was then lost between the queue and the `CodeCommit` table is ' +
  'invisible here; that population needs the consumer-side reconciliation (ENG-5688)._';

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
    const caveats = undecidedCaveats(report.totals, report.unverifiable_reasons);
    if (caveats.length) {
      L.push(
        `No gaps among the PRs this audit can decide. Of **${report.totals.merged_prs}** ` +
          `merged PR(s), ${caveats.join('; and ')}. Every other merged PR in the window ` +
          'delivered successfully.',
      );
    } else {
      L.push('No gaps. Every merged PR in the window enqueued a successful metrics delivery.');
    }
    // On the clean branch too, and via an early return that skips the footer —
    // so the ceiling has to be pushed here as well as there. This is the branch
    // that needs it MOST: it is the one that says "nothing to do".
    L.push('');
    L.push(COVERAGE_CEILING);
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
    const caveats = undecidedCaveats(report.totals, report.unverifiable_reasons);
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
      // Cause-neutral on purpose. This row used to read "run record reaped",
      // which was the only cause when it was written and is now one of two — a
      // row label is prose too, and it goes false the same way the paragraph
      // below did. The causes are listed under the table, from the records.
      L.push(`| undecidable by the Actions API (not a gap, not replayed) | ${g.unverifiable} |`);
    }
    L.push('');
    if (g.unverifiable) {
      // Deliberately NOT in the replay list and NOT a gap: the run record aged
      // out, so "no run" is not evidence of no delivery, and replaying would
      // re-deliver whatever did succeed. Unlike in_flight this never resolves on
      // its own, so the report has to hand over the PR numbers — otherwise the
      // only trace of the undecided set is a bare count nobody can act on.
      // Rendered from the records rather than written as prose: the paragraph
      // below used to name the 400-day cause as if it were the only one, which
      // went false the moment the class gained a second cause. The colon is
      // conditional so an empty list cannot leave the report promising an
      // enumeration it does not then print.
      const reasons = g.unverifiable_reasons || [];
      L.push(
        `**${g.unverifiable} PR(s) whose delivery the Actions API cannot decide.** Do NOT ` +
          'replay them on the strength of this report — check the consumer table for their ' +
          '`CodeCommit` rows, or narrow `--since` so the window sits inside the retained ' +
          `history.${reasons.length ? ' Why they are undecidable, from the records themselves:' : ''}`,
      );
      L.push('');
      if (reasons.length) {
        for (const reason of reasons) L.push(`- ${reason}`);
        L.push('');
      }
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
    L.push('>');
    // This list does not shrink when a repair succeeds, and saying so is the
    // difference between a stale entry and a second score row. Delivery is joined
    // through `cfg.callerFile` only, while a repair is dispatched through
    // `cfg.backfillCaller` — a separate workflow whose runs carry the default
    // branch's SHA, not the PR's, so no head-SHA join can see them and the audit
    // is structurally unable to observe its own remediation (ENG-5790). The
    // onboarding boundary can also land early on a merge-commit-introduced caller,
    // adding an entry that was never a gap. Both err toward listing too much, so
    // the check belongs at DISPATCH time, where the write happens.
    // `cfg.callerFile` is deliberately NOT interpolated here. renderMarkdown is
    // called in tests and by buildReport consumers with a cfg carrying only
    // `owner` and `backfillCaller` — the fields the replay command needs — so
    // naming callerFile would render the literal string `undefined` into an
    // operator-facing warning. `backfillCaller` is safe because the command
    // directly above already depends on it.
    L.push(
      '> This report cannot see previous repairs: a gap is joined to its delivery through ' +
        `the metrics caller's runs, while a repair is dispatched through \`${cfg.backfillCaller}\` ` +
        "— a different workflow, whose runs carry the default branch's SHA rather than the " +
        "PR's, so no head-SHA join can find them. Check the repo's backfill-caller run history " +
        'before dispatching: a PR already repaired there still appears above, and replaying it ' +
        'writes a second copy.',
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
  L.push('');
  L.push(COVERAGE_CEILING);
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
    // Fleet-wide, for the two prose branches. Outside `totals` because every other
    // key there is a count and code that sums totals would trip over a string
    // array; the per-repo tables get their own copy below.
    unverifiable_reasons: unverifiableReasons(results.flatMap((r) => r.classes.unverifiable)),
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
      unverifiable_reasons: unverifiableReasons(r.classes.unverifiable),
      replay: replayList(r.classes),
    })),
    repos: results,
  };
}

// ── Emitting a workflow command safely ──────────────────────────────────────
//
// `::error::<message>` is LINE-ORIENTED: the runner reads it to the end of the
// line, so a message that contains a newline does not produce a two-line error —
// it produces a SECOND command that the runner obeys.
//
// Reproduced with one thrown error, no privileges, straight from an input:
//
//   --repo $'a/b\n::add-mask::SECRET\n::error::forged'
//     ::error::--repo must be owner/name, got a/b
//     ::add-mask::SECRET
//     ::error::forged
//
// Three directives from one throw. `::add-mask::` is the mild one; the direction
// that matters for a DETECTOR is `::stop-commands::`, which switches command
// processing off for everything after it — an injected value could suppress the
// very error being raised about it, and this tool's whole purpose is to be the
// thing that does not go quiet.
//
// No input is attacker-controlled today: every one is set by the caller
// workflow's author (repo defaults to github.repository), so this is hardening,
// not a live exploit — stated plainly rather than dressed up, because the fix is
// three replaces and GitHub documents them as required for any interpolated
// message. `%` MUST be escaped first, or the escapes below get re-escaped.
export const wfEscape = (s) =>
  String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// Single emitter, so the escape cannot be forgotten at a call site. The two
// constant messages carry no interpolation and need no escaping; they route
// through here anyway, because a rule with two exceptions is how the next
// interpolated message ends up emitted raw.
export const wfError = (msg) => console.error(`::error::${wfEscape(msg)}`);

async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    // Fail LOUDLY. A detector that silently reports "0 gaps" because it had no
    // credentials is the exact failure class this script exists to catch.
    wfError(
      'GITHUB_TOKEN (or GH_TOKEN) is unset — refusing to run. An unauthenticated audit would report a clean fleet it never actually read.',
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
    wfError(
      'resolved ZERO caller repos — the fleet probe is broken or the token cannot read the org. Refusing to report a clean fleet.',
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

  // 0 = clean, 1 = gaps found, 2 = the detector itself could not run, 3 = no gaps
  // but some records are UNDECIDED. Keeping "found something" distinct from
  // "broke" is the whole point: a caller that treats any non-zero exit as a gap
  // would raise an issue on a rate-limit.
  //
  // 3 exists because `in_flight` and `unverifiable` are deliberately not gap
  // conditions (see buildReport) and that is right — an unconcluded run is not a
  // gap — but "not a gap" is not "clean", and collapsing the two put the only
  // machine-readable signal in the false-clean direction: measured, an audit whose
  // ONLY records were in_flight, or unverifiable, or both, exited 0 and the action
  // published `status=clean has_gaps=false gap_count=0`. The markdown report was
  // honest the whole time (undecidedCaveats prints "not yet decided either way"),
  // so the human artifact said undecided while the output a workflow branches on
  // said clean — and this action's own docs instruct callers to branch on `status`.
  // A detector may answer "yes", "no", or "I do not know yet"; it may not answer
  // "no" when it means the third.
  //
  // Gaps still DOMINATE: a repo with both a real gap and an in-flight PR exits 1,
  // because the gap is the actionable finding and demoting it to "undecided" would
  // lose it. And this is NOT reported as exit 2 / `status=unknown`, which means
  // "the detector could not run, its outputs are unreliable" and is bound to
  // `has_gaps` being unwritten — an audit that completed and decided every record
  // it could is not a broken run, and conflating them would make one in-flight PR
  // look like infrastructure failure.
  //
  // exitCode, never process.exit(): stdout is a PIPE under the Actions runner,
  // and Node writes to a pipe asynchronously, so process.exit() terminates
  // without flushing whatever is still queued. Measured on node 22 against a
  // slow consumer, process.exit(1) delivered 56 of 2001 written lines and lost
  // the last one entirely — which here is the summary and the GAP lines, i.e.
  // exactly the evidence that explains the exit code. Assigning exitCode lets
  // main() return and the process exit naturally once the queue drains. The
  // JSON/markdown reports were never at risk (writeFileSync is synchronous).
  const undecided = t.in_flight + t.unverifiable;
  process.exitCode = report.repos_with_gaps.length ? 1 : undecided ? 3 : 0;
}

// Only run when executed directly, so the unit tests can import the pure parts.
if (process.argv[1] && process.argv[1].endsWith('audit-delivery.mjs')) {
  main().catch((e) => {
    wfError(e.message);
    process.exitCode = 2;
  });
}
