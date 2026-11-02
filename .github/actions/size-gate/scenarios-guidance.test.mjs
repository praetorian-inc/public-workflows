// Split guidance on failing runs (LAB-7708): printed once after the error
// annotations and after the summary table, and never on a passing run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GUIDANCE } from "./report.mjs";
import { check, file, makeRepo } from "./scenario-kit.mjs";

const repo = (head, untracked = {}) => makeRepo({ base: { "keep.go": file("go", 3) }, head, untracked });

// Run the gate with a step-summary file; return the exit code, log, and summary.
function gate(r) {
  const summaryPath = path.join(mkdtempSync(path.join(tmpdir(), "size-gate-summary-")), "summary.md");
  const { code, out } = check(r, { GITHUB_STEP_SUMMARY: summaryPath });
  let summary = "";
  try {
    summary = readFileSync(summaryPath, "utf8");
  } catch {}
  return { code, out, summary };
}

const count = (s, sub) => s.split(sub).length - 1;

test("G1: an error run prints the guidance once in the log, after the error annotations", () => {
  const { code, out } = gate(repo({ "d/a.go": file("go", 501), "d/b.go": file("go", 502) }));
  assert.equal(code, 1, out);
  assert.equal(count(out, GUIDANCE), 1, out);
  const lastError = out.lastIndexOf("::error ");
  assert.ok(lastError >= 0 && out.indexOf(GUIDANCE) > lastError, out);
});

test("G2: an error run puts the guidance in the step summary after the table", () => {
  const { summary } = gate(repo({ "d/a.go": file("go", 501) }));
  assert.equal(count(summary, GUIDANCE), 1, summary);
  assert.ok(summary.indexOf(GUIDANCE) > summary.lastIndexOf("| error |"), summary);
});

test("G3: the guidance covers the split rules and the caller's AGENTS.md", () => {
  for (const want of [/by responsibility/, /next addition/, /pure move/, /_part2/, /_utils/, /_helpers/, /squeezing/, /baseline entry/, /AGENTS\.md/])
    assert.match(GUIDANCE, want);
});

test("G4: a clean run prints no guidance", () => {
  const { code, out, summary } = gate(repo({ "d/a.go": file("go", 10) }));
  assert.equal(code, 0, out);
  assert.ok(!out.includes(GUIDANCE) && !summary.includes(GUIDANCE), out + summary);
});

test("G5: a warnings-only run prints no guidance", () => {
  const { code, out, summary } = gate(repo({}, { "d/a.go": file("go", 450) }));
  assert.equal(code, 0, out);
  assert.match(out, /::warning /);
  assert.ok(!out.includes(GUIDANCE) && !summary.includes(GUIDANCE), out + summary);
});
