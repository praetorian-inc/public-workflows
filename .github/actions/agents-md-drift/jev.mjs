// JEV scoring for candidate pairs (LAB-7596). One question per request, all of a
// run's requests in a bounded pool. All or nothing: a missing key or any request
// that still fails after its retries makes the whole run unavailable, because a
// partial run would resolve findings it never rechecked. The key travels only in
// the Authorization header; no message here ever contains it.
import { JEV_ENDPOINT, JEV_MODEL, REQUESTS, bandOf, scoreOf } from "./questions.mjs";

export const CONCURRENCY = 20;
const ATTEMPTS = 3;
const TIMEOUT_MS = 90_000;

// The JSON state JEV reads for one pair. The PR and instruction-file text are
// data fields here, never part of the question.
export const stateFor = (pair, diffs) => ({
  changed_file: pair.file,
  agents_md: pair.agents_md,
  section_at_head: pair.section,
  diff: diffs[pair.file],
});

async function ask({ key, fetchImpl, state, questions }) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      last = `request failed (${e.name})`;
      continue;
    }
    if (res.ok) {
      const v = (await res.json())?.answers?.stale?.noul;
      if (typeof v !== "number") throw new Error("response has no numeric answers.stale.noul");
      return v;
    }
    last = `HTTP ${res.status}`;
    if (res.status < 500) break;
  }
  throw new Error(last);
}

// { ok: true, scored: [{ ...pair, answers, score, band }] } or { ok: false, reason }.
export async function scorePairs({ pairs, diffs, key, fetchImpl = fetch, concurrency = CONCURRENCY }) {
  if (!key) return { ok: false, reason: "TYPESAFE_JEV_API_KEY is not set" };
  const jobs = pairs.flatMap((p, i) => REQUESTS.map((questions, q) => ({ i, q, state: stateFor(p, diffs), questions })));
  const answers = pairs.map(() => []);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < jobs.length) {
      const j = jobs[next++];
      try {
        answers[j.i][j.q] = await ask({ key, fetchImpl, state: j.state, questions: j.questions });
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
