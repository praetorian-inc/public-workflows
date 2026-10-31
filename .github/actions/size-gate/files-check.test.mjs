// Unit tests for files-check.mjs and the annotation format (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFiles } from "./files-check.mjs";
import { annotation, escapeData } from "./report.mjs";

const diff = (o = {}) => ({ status: new Map(), atBase: new Set(o.atBase ?? []), renames: new Map(o.renames ?? []), added: new Map((o.added ?? []).map((p) => [p, new Map()])) });
const run = (loc, d, baseline = {}) =>
  checkFiles({ loc: new Map(Object.entries(loc)), diff: d, baseline, baseBaseline: null, baselinePath: "b.json" });

test("a new oversized file and an old unbaselined one get different messages", () => {
  const { errors } = run({ n: 501, o: 502 }, diff({ atBase: ["o"] }));
  assert.deepEqual(errors, [
    { file: "n", msg: "new file is 501 lines; the limit is 500. Split it." },
    { file: "o", msg: "is 502 lines and not in b.json; the limit is 500. Shrink it to 500 or fewer." },
  ]);
});

test("a renamed oversized file is not new", () => {
  const { errors } = run({ n: 501 }, diff({ renames: [["n", "o"]] }));
  assert.match(errors[0].msg, /not in b\.json/);
});

test("warnings: only added or changed files of 401-500 lines", () => {
  const { warnings, errors } = run({ a: 401, b: 500, c: 400, d: 450 }, diff({ added: ["a", "b", "c"] }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((w) => w.file), ["a", "b"]);
  assert.equal(warnings[0].msg, "is 401 lines, over the 400-line soft limit (hard limit 500).");
});

test("annotations escape the message and the file property", () => {
  assert.equal(escapeData("a%b\r\nc"), "a%25b%0D%0Ac");
  assert.equal(annotation("error", { file: "a.go", msg: "m" }), "::error file=a.go::a.go m");
  assert.equal(annotation("warning", { file: "a,b:c.go", line: 7, msg: "x\ny" }), "::warning file=a%2Cb%3Ac.go,line=7::a,b:c.go:7 x%0Ay");
});
