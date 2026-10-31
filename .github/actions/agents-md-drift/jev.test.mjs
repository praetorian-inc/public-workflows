import assert from "node:assert/strict";
import { test } from "node:test";
import { scorePairs, stateFor } from "./jev.mjs";
import { JEV_ENDPOINT, JEV_MODEL, REQUESTS } from "./questions.mjs";

const KEY = "sk-test-secret-value";
const pairs = [
  { id: "p1", file: "a.go", agents_md: "AGENTS.md", heading: "H", section: "## H\nx" },
  { id: "p2", file: "b.go", agents_md: "AGENTS.md", heading: "H", section: "## H\nx" },
];
const diffs = { "a.go": "diff a", "b.go": "diff b" };
const ok = (v) => ({ ok: true, status: 200, json: async () => ({ answers: { stale: { noul: v } } }) });
const status = (s) => ({ ok: false, status: s, json: async () => ({}) });
const withHeaders = (r, h) => ({ ...r, headers: new Headers(h) });
// Records each backoff instead of waiting on a real clock.
const clock = () => {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
};

test("stateFor passes PR and instruction text as data fields", () => {
  assert.deepEqual(stateFor(pairs[0], diffs), { changed_file: "a.go", agents_md: "AGENTS.md", section_at_head: "## H\nx", diff: "diff a" });
});

test("one question per request, pinned model, score is the max", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, auth: init.headers.Authorization, body });
    const q = REQUESTS.findIndex((r) => JSON.stringify(r) === JSON.stringify(body.questions));
    return ok(body.state.changed_file === "a.go" ? [0.3, 0.85][q] : [0.1, 0.05][q]);
  };
  const res = await scorePairs({ pairs, diffs, key: KEY, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(seen.length, 4);
  for (const s of seen) {
    assert.equal(s.url, JEV_ENDPOINT);
    assert.equal(s.auth, `Bearer ${KEY}`);
    assert.equal(s.body.model, JEV_MODEL);
    assert.deepEqual(Object.keys(s.body.questions), ["stale"]);
  }
  assert.deepEqual(res.scored.map((p) => [p.id, p.score, p.band]), [["p1", 0.85, "high"], ["p2", 0.1, "low"]]);
});

test("a missing key is unavailable without a request", async () => {
  let calls = 0;
  const res = await scorePairs({ pairs, diffs, key: "", fetchImpl: async () => (calls++, ok(1)) });
  assert.deepEqual(res, { ok: false, reason: "TYPESAFE_JEV_API_KEY is not set" });
  assert.equal(calls, 0);
});

test("no pairs to ask is ok without a key or a request", async () => {
  let calls = 0;
  const res = await scorePairs({ pairs: [], diffs: {}, key: "", fetchImpl: async () => (calls++, ok(1)) });
  assert.deepEqual(res, { ok: true, scored: [] });
  assert.equal(calls, 0);
});

test("5xx and network errors retry, then succeed", async () => {
  const replies = [status(503), new TypeError("boom")];
  const fetchImpl = async () => {
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r ?? ok(0.5);
  };
  const { sleep } = clock();
  const res = await scorePairs({ pairs: pairs.slice(0, 1), diffs, key: KEY, fetchImpl, concurrency: 1, sleep });
  assert.equal(res.ok, true);
  assert.equal(res.scored[0].band, "middle");
});

test("429 and 408 retry with exponential backoff; so does an unreadable body", async () => {
  const run = async (replies) => {
    const { waits, sleep } = clock();
    const res = await scorePairs({ pairs: pairs.slice(0, 1), diffs, key: KEY, fetchImpl: async () => replies.shift() ?? ok(0.9), concurrency: 1, sleep });
    return [res.ok, waits];
  };
  assert.deepEqual(await run([status(429), status(408)]), [true, [1000, 2000]]);
  const cut = { ok: true, status: 200, json: async () => { throw new SyntaxError("cut"); } };
  assert.deepEqual(await run([cut]), [true, [1000]]);
});

test("Retry-After is honoured in seconds or as a date, and capped", async () => {
  const run = async (h) => {
    const replies = [withHeaders(status(429), h)];
    const { waits, sleep } = clock();
    await scorePairs({ pairs: pairs.slice(0, 1), diffs, key: KEY, fetchImpl: async () => replies.shift() ?? ok(0), concurrency: 1, sleep });
    return waits[0];
  };
  assert.equal(await run({ "Retry-After": "7" }), 7000);
  assert.equal(await run({ "Retry-After": "3600" }), 30000);
  const d = await run({ "Retry-After": new Date(Date.now() + 5000).toUTCString() });
  assert.ok(d > 3000 && d <= 5000, String(d));
  assert.equal(await run({ "Retry-After": "soon" }), 1000);
});

test("another 4xx such as 404 is not retried either", async () => {
  let calls = 0;
  const { waits, sleep } = clock();
  const res = await scorePairs({ pairs: pairs.slice(0, 1), diffs, key: KEY, fetchImpl: async () => (calls++, status(404)), concurrency: 1, sleep });
  assert.deepEqual([res.reason, calls, waits.length], ["p1: HTTP 404", 1, 0]);
});

test("a 4xx is not retried and makes the whole run unavailable, without the key in the reason", async () => {
  let calls = 0;
  const res = await scorePairs({ pairs, diffs, key: KEY, fetchImpl: async () => (calls++, status(401)), concurrency: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "p1: HTTP 401");
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test("three failed attempts give up; a non-numeric answer is unavailable", async () => {
  let calls = 0;
  const { waits, sleep } = clock();
  const res = await scorePairs({ pairs: pairs.slice(0, 1), diffs, key: KEY, fetchImpl: async () => (calls++, status(500)), concurrency: 1, sleep });
  assert.deepEqual([res.ok, res.reason, calls], [false, "p1: HTTP 500", 3]);
  assert.deepEqual(waits, [1000, 2000]);
  const bad = await scorePairs({ pairs: pairs.slice(0, 1), diffs, key: KEY, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /noul/);
});

test("concurrency is bounded", async () => {
  let live = 0;
  let peak = 0;
  const many = Array.from({ length: 30 }, (_, i) => ({ ...pairs[0], id: `p${i + 1}` }));
  const fetchImpl = async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 2));
    live--;
    return ok(0);
  };
  const res = await scorePairs({ pairs: many, diffs, key: KEY, fetchImpl, concurrency: 5 });
  assert.equal(res.ok, true);
  assert.equal(peak, 5);
});
