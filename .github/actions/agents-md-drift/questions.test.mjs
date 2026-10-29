import assert from "node:assert/strict";
import { test } from "node:test";
import { DIFF_CAP, DIGEST, HIGH, MIDDLE, REQUESTS, TRUNCATION_MARKER, bandOf, cap, questionsDigest, scoreOf } from "./questions.mjs";

test("the questions match the calibrated digest", () => assert.equal(questionsDigest(), DIGEST));

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
