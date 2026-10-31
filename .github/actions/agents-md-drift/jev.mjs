// JEV scoring for candidate pairs (LAB-7596). One question per request, all of a
// run's requests in a bounded pool. All or nothing: a missing key or any request
// that still fails after its retries makes the whole run unavailable, because a
// partial run would resolve findings it never rechecked. The key travels only in
// the Authorization header; no message here ever contains it.
import { JEV_ENDPOINT, JEV_MODEL, REQUESTS, bandOf, scoreOf } from "./questions.mjs";

export const CONCURRENCY = 20;
const ATTEMPTS = 3;
const TIMEOUT_MS = 90_000;
const BACKOFF_MS = 1000;
const MAX_WAIT_MS = 30_000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Throttling, a request timeout and server errors are transient; any other 4xx is not.
const transient = (s) => s === 408 || s === 429 || s >= 500;

// Retry-After (delta seconds or an HTTP date) when the server sent one, else
// exponential backoff; capped either way so one reply cannot stall the run.
function waitFor(attempt, res) {
  const h = res?.headers?.get?.("retry-after");
  const secs = h == null ? NaN : /^\s*\d+\s*$/.test(h) ? Number(h) * 1000 : Date.parse(h) - Date.now();
  const ms = Number.isFinite(secs) ? Math.max(0, secs) : BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(ms, MAX_WAIT_MS);
}

// The JSON state JEV reads for one pair. The PR and instruction-file text are
// data fields here, never part of the question.
export const stateFor = (pair, diffs) => ({
  changed_file: pair.file,
  agents_md: pair.agents_md,
  section_at_head: pair.section,
  diff: diffs[pair.file],
});

async function ask({ key, fetchImpl, sleep, state, questions }) {
  let last;
  for (let attempt = 1; ; attempt++) {
    let res;
    let body;
    try {
      res = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) body = await res.json();
    } catch (e) {
      last = res ? `response body unreadable (${e.name})` : `request failed (${e.name})`;
    }
    if (body !== undefined) {
      const v = body?.answers?.stale?.noul;
      if (typeof v !== "number" || v < 0 || v > 1) throw new Error("response has no answers.stale.noul between 0 and 1");
      return v;
    }
    if (res && !res.ok) {
      last = `HTTP ${res.status}`;
      if (!transient(res.status)) break;
    }
    if (attempt >= ATTEMPTS) break;
    await sleep(waitFor(attempt, res && !res.ok ? res : null));
  }
  throw new Error(last);
}

// { ok: true, scored: [{ ...pair, answers, score, band }] } or { ok: false, reason }.
export async function scorePairs({ pairs, diffs, key, fetchImpl = fetch, concurrency = CONCURRENCY, sleep = realSleep }) {
  // Nothing to ask (every pair over the cap) needs no key: the comment still
  // lists what went unchecked.
  if (pairs.length === 0) return { ok: true, scored: [] };
  if (!key) return { ok: false, reason: "TYPESAFE_JEV_API_KEY is not set" };
  const jobs = pairs.flatMap((p, i) => REQUESTS.map((questions, q) => ({ i, q, state: stateFor(p, diffs), questions })));
  const answers = pairs.map(() => []);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < jobs.length) {
      const j = jobs[next++];
      try {
        answers[j.i][j.q] = await ask({ key, fetchImpl, sleep, state: j.state, questions: j.questions });
      } catch (e) {
        failure ??= `${pairs[j.i].id}: ${e.message}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (failure) return { ok: false, reason: failure };
  const scored = pairs.map((p, i) => {
    const score = scoreOf(answers[i]);
    return { ...p, answers: answers[i], score, band: bandOf(score) };
  });
  return { ok: true, scored };
}
