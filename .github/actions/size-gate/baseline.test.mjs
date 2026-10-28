// Unit tests for baseline.mjs (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { oversized, ratchet, readBaseBaseline, readBaseline } from "./baseline.mjs";
import { baselineJson, makeRepo } from "./scenario-kit.mjs";

const B = "b.json";
const r = (loc, baseline, baseBaseline, renames = new Map()) =>
  ratchet({ loc: new Map(Object.entries(loc)), baseline, baseBaseline, renames, baselinePath: B });

test("oversized keeps files over 300, sorted by path", () => {
  assert.deepEqual(Object.entries(oversized(new Map([["z", 301], ["a", 900], ["m", 300]]))), [["a", 900], ["z", 301]]);
});

test("ratchet: an entry that matches its file and the base passes", () => {
  assert.deepEqual(r({ a: 400 }, { a: 400 }, { a: 400 }), []);
  assert.deepEqual(r({ a: 400 }, { a: 400 }, null), []);
});

test("ratchet: every tree-side failure", () => {
  assert.deepEqual(r({}, { a: 400 }, null), [["a", "is listed in b.json but no longer exists or is out of scope. Remove the entry."]]);
  assert.deepEqual(r({ a: 300 }, { a: 400 }, null), [["a", "is now 300 lines, within the 300-line limit. Remove its entry from b.json."]]);
  assert.deepEqual(r({ a: 401 }, { a: 400 }, null), [["a", "grew to 401 lines; b.json allows 400. Baselined files may not grow."]]);
  assert.deepEqual(r({ a: 399 }, { a: 400 }, null), [["a", "shrank to 399 lines. Lower its b.json entry from 400 to 399 in this PR."]]);
});

test("ratchet: the baseline only shrinks, following renames", () => {
  assert.deepEqual(r({ a: 400 }, { a: 400 }, {}), [["a", "was added to b.json; the baseline can only shrink."]]);
  assert.deepEqual(r({ a: 410 }, { a: 410 }, { a: 400 }), [["a", "b.json entry rose from 400 to 410; the baseline can only shrink."]]);
  assert.deepEqual(r({ n: 400 }, { n: 400 }, { o: 400 }, new Map([["n", "o"]])), []);
});

test("readBaseline: missing is null, broken JSON throws", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sg-bl-"));
  assert.equal(readBaseline(root, B), null);
  writeFileSync(path.join(root, B), "{");
  assert.throws(() => readBaseline(root, B), /cannot read b\.json/);
  writeFileSync(path.join(root, B), baselineJson({ x: 301 }));
  assert.deepEqual(readBaseline(root, B), { x: 301 });
});

test("readBaseBaseline: absent at the ref is null", () => {
  const repo = makeRepo({ base: { [B]: baselineJson({ x: 301 }) }, head: { [B]: null } });
  assert.deepEqual(readBaseBaseline(repo.root, repo.base, B), { x: 301 });
  assert.equal(readBaseBaseline(repo.root, repo.head, B), null);
});

test("readBaseline and readBaseBaseline refuse a files map that is not path -> line count", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sg-bl-"));
  const bad = [[{ files: [] }, /b\.json: "files" must be an object/], [{ files: null }, /"files" must be an object/],
    [{ files: { "a.go": "x" } }, /b\.json: entry "a\.go" is "x"; it must be a non-negative integer/],
    [{ files: { "a.go": {} } }, /entry "a\.go" is \{\}/], [{ files: { "a.go": -1 } }, /entry "a\.go" is -1/],
    [{ files: { "a.go": 1.5 } }, /entry "a\.go" is 1\.5/]];
  for (const [body, re] of bad) {
    writeFileSync(path.join(root, B), JSON.stringify(body));
    assert.throws(() => readBaseline(root, B), re, JSON.stringify(body));
  }
  const repo = makeRepo({ base: { [B]: JSON.stringify({ files: { "a.go": "400" } }) } });
  assert.throws(() => readBaseBaseline(repo.root, repo.base, B), /:b\.json: entry "a\.go" is "400"/);
});
