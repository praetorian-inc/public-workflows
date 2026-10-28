// Golden tests for the TypeScript/TSX function extractor (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "..", "_test-fixtures", "size-gate", "extract");
const EXTRACTOR = join(HERE, "extract-ts.mjs");

function run(...paths) {
  return JSON.parse(execFileSync(process.execPath, [EXTRACTOR, ...paths], { encoding: "utf8" }));
}

for (const lang of ["ts", "tsx"]) {
  const dir = join(FIXTURES, lang);
  const sources = readdirSync(dir).filter((f) => f.endsWith(`.${lang}`));
  test(`${lang} fixtures exist`, () => assert.ok(sources.length > 0));
  for (const name of sources) {
    test(`${lang}/${name} matches its golden`, () => {
      const src = join(dir, name);
      const golden = JSON.parse(readFileSync(src.replace(/\.tsx?$/, ".golden.json"), "utf8"));
      assert.deepEqual(run(src)[src], golden);
    });
  }
}

test("a file the parser cannot produce statements from is a per-file error; exit 0", () => {
  const d = mkdtempSync(join(tmpdir(), "extract-ts-"));
  try {
    const bad = join(d, "bad.ts");
    const good = join(d, "good.ts");
    writeFileSync(bad, ")))");
    writeFileSync(good, "function g() {\n  return 1;\n}\n");
    const out = run(bad, good);
    assert.deepEqual(out[bad].functions, []);
    assert.match(out[bad].error, /./);
    assert.deepEqual(out[good], { functions: [{ name: "g", start: 1, end: 3, isComponent: false }] });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a missing file is a per-file error", () => {
  const out = run("/nonexistent/x.ts");
  assert.match(out["/nonexistent/x.ts"].error, /./);
});
