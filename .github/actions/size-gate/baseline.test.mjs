// Unit tests for baseline.mjs (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { baseLengths, oversized, ratchet, readBaseBaseline, readBaseline } from "./baseline.mjs";
import { baselineJson, makeRepo } from "./scenario-kit.mjs";

const B = "b.json";
const r = (loc, baseline, baseBaseline, renames = new Map(), baseLines = undefined) =>
  ratchet({ loc: new Map(Object.entries(loc)), baseline, baseBaseline, renames, baselinePath: B, baseLines });

test("oversized keeps files over 500, sorted by path", () => {
  assert.deepEqual(Object.entries(oversized(new Map([["z", 501], ["a", 900], ["m", 500]]))), [["a", 900], ["z", 501]]);
});

test("ratchet: an entry that matches its file and the base passes", () => {
  assert.deepEqual(r({ a: 600 }, { a: 600 }, { a: 600 }), []);
  assert.deepEqual(r({ a: 600 }, { a: 600 }, null), []);
});

test("ratchet: every tree-side failure", () => {
  assert.deepEqual(r({}, { a: 600 }, null), [["a", "is listed in b.json but no longer exists or is out of scope. Remove the entry."]]);
  assert.deepEqual(r({ a: 500 }, { a: 600 }, null), [["a", "is now 500 lines, within the 500-line limit. Remove its entry from b.json."]]);
  assert.deepEqual(r({ a: 601 }, { a: 600 }, null), [["a", "grew to 601 lines; b.json allows 600. Baselined files may not grow."]]);
  assert.deepEqual(r({ a: 599 }, { a: 600 }, null), [["a", "shrank to 599 lines. Lower its b.json entry from 600 to 599 in this PR."]]);
});

test("ratchet: the baseline only shrinks, following renames", () => {
  assert.deepEqual(r({ a: 600 }, { a: 600 }, {}), [["a", "was added to b.json; the baseline can only shrink."]]);
  assert.deepEqual(r({ a: 610 }, { a: 610 }, { a: 600 }), [["a", "b.json entry rose from 600 to 610; the baseline can only shrink."]]);
  assert.deepEqual(r({ n: 600 }, { n: 600 }, { o: 600 }, new Map([["n", "o"]])), []);
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

test("ratchet: with no merge-base baseline, entries are bounded by the merge-base files", () => {
  const none = "did not exist at the merge-base, which has no b.json; a new file cannot be baselined.";
  assert.deepEqual(r({ a: 600 }, { a: 600 }, null, new Map(), {}), [["a", none]]);
  assert.deepEqual(r({ a: 600 }, { a: 600 }, null, new Map(), { a: 250 }),
    [["a", "b.json allows 600 lines but it was 250 at the merge-base, which has no b.json; a baseline entry cannot exceed it."]]);
  assert.deepEqual(r({ a: 600 }, { a: 600 }, null, new Map(), { a: 600 }), []);
  assert.deepEqual(r({ n: 600 }, { n: 600 }, null, new Map([["n", "o"]]), { o: 610 }), []);
  assert.deepEqual(r({ a: 600 }, { a: 600 }, { a: 600 }, new Map(), {}), [], "a merge-base baseline decides alone");
});

test("baseLengths: the merge-base length of each entry's file, following renames", () => {
  const repo = makeRepo({ base: { "a.go": "x\ny\n", "o.go": "1\n2\n3\n" } });
  assert.deepEqual(baseLengths(repo.root, repo.base, { "a.go": 1, "n.go": 1, "z.go": 1 }, new Map([["n.go", "o.go"]])),
    { "a.go": 2, "o.go": 3 });
});
