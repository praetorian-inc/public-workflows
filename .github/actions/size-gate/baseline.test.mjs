// Unit tests for baseline.mjs (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { oversized, readBaseBaseline, readBaseline } from "./baseline.mjs";
import { baselineJson, makeRepo } from "./scenario-kit.mjs";

const B = "b.json";

test("oversized keeps files over 500, sorted by path", () => {
  assert.deepEqual(Object.entries(oversized(new Map([["z", 501], ["a", 900], ["m", 500]]))), [["a", 900], ["z", 501]]);
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
