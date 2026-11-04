// Cohesion guidance for source-length warnings: printed once even though the
// job passes, and not printed for integrity-only failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GUIDANCE } from "./report.mjs";
import { baselineJson, check, file, fn, makeRepo, source } from "./scenario-kit.mjs";

const repo = (head, untracked = {}) => makeRepo({ base: { "keep.go": file("go", 3) }, head, untracked });

// Run the gate with a step-summary file; return the exit code, log, and summary.
function gate(r) {
  const dir = mkdtempSync(path.join(tmpdir(), "size-gate-summary-"));
  const summaryPath = path.join(dir, "summary.md");
  const outputPath = path.join(dir, "outputs.txt");
  const { code, out } = check(r, { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath });
  let summary = "";
  try {
    summary = readFileSync(summaryPath, "utf8");
  } catch {}
  return { code, out, summary, outputs: readFileSync(outputPath, "utf8") };
}

const count = (s, sub) => s.split(sub).length - 1;

test("G1: warnings print the guidance once in the log, after the annotations", () => {
  const { code, out } = gate(repo({ "d/a.go": file("go", 501), "d/b.go": file("go", 502) }));
  assert.equal(code, 0, out);
  assert.equal(count(out, GUIDANCE), 1, out);
  const lastWarning = out.lastIndexOf("::warning ");
  assert.ok(lastWarning >= 0 && out.indexOf(GUIDANCE) > lastWarning, out);
});

test("G2: a warning run puts the guidance in the step summary after the table", () => {
  const { summary } = gate(repo({ "d/a.go": file("go", 501) }));
  assert.equal(count(summary, GUIDANCE), 1, summary);
  assert.ok(summary.indexOf(GUIDANCE) > summary.lastIndexOf("| warning |"), summary);
});

test("G3: the guidance covers cohesive retention and concept-based splitting", () => {
  for (const want of [/advisory/, /cohesive long unit may remain/, /by responsibility/, /next addition/, /pure move/, /_part2/, /_utils/, /_helpers/, /baseline entry/, /AGENTS\.md/])
    assert.match(GUIDANCE, want);
});

test("G4: a clean run prints no guidance", () => {
  const { code, out, summary } = gate(repo({ "d/a.go": file("go", 10) }));
  assert.equal(code, 0, out);
  assert.ok(!out.includes(GUIDANCE) && !summary.includes(GUIDANCE), out + summary);
});

test("G5: a warnings-only run prints guidance without blocking", () => {
  const { code, out, summary } = gate(repo({}, { "d/a.go": file("go", 450) }));
  assert.equal(code, 0, out);
  assert.match(out, /::warning /);
  assert.equal(count(out, GUIDANCE), 1, out);
  assert.equal(count(summary, GUIDANCE), 1, summary);
});

test("G6: an over-threshold function gets the guidance on a passing run", () => {
  const { code, out } = gate(repo({ "d/a.go": source("go", fn("go", "F", 51)) }));
  assert.equal(code, 0, out);
  assert.equal(count(out, GUIDANCE), 1, out);
});

test("G7: an integrity error without length warnings prints no guidance", () => {
  const { code, out, summary } = gate(repo({ "d/a.py": "def f(:\n    pass\n" }));
  assert.equal(code, 1, out);
  assert.ok(!out.includes(GUIDANCE) && !summary.includes(GUIDANCE), out + summary);
});

test("G8: a baselined file that grew gets the guidance without failing", () => {
  const B = ".github/size-baseline.json";
  const r = makeRepo({ base: { "big.go": file("go", 600), [B]: baselineJson({ "big.go": 600 }) }, head: { "big.go": file("go", 610) } });
  const { code, out } = gate(r);
  assert.equal(code, 0, out);
  assert.equal(count(out, GUIDANCE), 1, out);
});

test("G9: successful checks expose file and function warnings in structured annotations and outputs", () => {
  const { code, out, summary, outputs } = gate(repo({
    "d/a.go": file("go", 501),
    "d/f.go": source("go", fn("go", "F", 51)),
  }));
  assert.equal(code, 0, out);
  assert.match(out, /::warning file=d\/a\.go::d\/a\.go is 501 lines, over the 400-line advisory threshold/);
  assert.match(out, /::warning file=d\/f\.go,line=\d+::d\/f\.go:\d+ new function `F` is 51 lines; the limit is 50/);
  assert.match(summary, /\| warning \| `d\/f\.go:\d+` \|/);
  assert.match(outputs, /violations=0\nwarnings=2\nbase-sha=[a-f0-9]+\n/);
});
