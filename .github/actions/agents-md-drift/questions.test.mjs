import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DIFF_CAP, DIGEST, HIGH, MIDDLE, REQUESTS, TRUNCATION_MARKER, bandOf, cap, questionsDigest, scoreOf } from "./questions.mjs";

test("the questions match the calibrated digest", () => assert.equal(questionsDigest(), DIGEST));

// The digest covers everything JEV reads that the calibration pinned, so a
// changed truncation marker cannot ship without a rerun (palatine decision.json:
// sha256 of [model, state.diff_cap_chars, state.truncation_marker, requests]).
test("the digest covers the model, diff cap, truncation marker and requests", () => {
  const h = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  assert.equal(DIGEST, h(["jev-1.13.0", DIFF_CAP, TRUNCATION_MARKER, REQUESTS]));
  assert.equal(DIGEST, "0273dae56d37174f1ab7a626d9d1b6e283f8250cef933df004ab8abeba54f687");
});

test("two single-question requests under the key stale", () => {
  assert.equal(REQUESTS.length, 2);
  for (const r of REQUESTS) assert.deepEqual(Object.keys(r), ["stale"]);
});

test("the new-definition question drops the 'not mentioned' clause", () => {
  assert.match(REQUESTS[1].stale.instructions, /a missing mention of new code is not staleness/);
  for (const r of REQUESTS) assert.doesNotMatch(r.stale.instructions, /not mentioned anywhere/);
});

test("score is the max and the bands are 0.80 / 0.25", () => {
  assert.equal(HIGH, 0.8);
  assert.equal(MIDDLE, 0.25);
  assert.equal(scoreOf([0.1, 0.82]), 0.82);
  assert.equal(bandOf(0.8), "high");
  assert.equal(bandOf(0.79), "middle");
  assert.equal(bandOf(0.25), "middle");
  assert.equal(bandOf(0.249), "low");
});

test("diffs are capped with a marker", () => {
  assert.equal(cap("abc"), "abc");
  const long = "x".repeat(DIFF_CAP + 5);
  assert.equal(cap(long), "x".repeat(DIFF_CAP) + TRUNCATION_MARKER);
});
