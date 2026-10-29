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

test("a file that does not parse is a per-file error; exit 0", () => {
  const d = mkdtempSync(join(tmpdir(), "extract-ts-"));
  try {
    const bad = join(d, "bad.ts");
    const good = join(d, "good.ts");
    writeFileSync(bad, ")))");
    writeFileSync(good, "function g() {\n  return 1;\n}\n");
    const out = run(bad, good);
    assert.deepEqual(out[bad].functions, []);
    assert.deepEqual(out[bad].comments, []);
    assert.match(out[bad].error, /./);
    assert.deepEqual(out[good], {
      functions: [{ name: "g", start: 1, end: 3, isComponent: false }],
      comments: [],
    });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a recoverable syntax error is a per-file error too, as in Go and Python", () => {
  const d = mkdtempSync(join(tmpdir(), "extract-ts-"));
  try {
    const stray = join(d, "stray.ts");
    writeFileSync(stray, "function f() {\n  return 1;\n}\n}\nfunction g() {\n  return 2;\n}\n");
    assert.deepEqual(run(stray)[stray], {
      functions: [],
      comments: [],
      error: "Declaration or statement expected.",
    });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a missing file is a per-file error", () => {
  const out = run("/nonexistent/x.ts");
  assert.match(out["/nonexistent/x.ts"].error, /./);
  assert.deepEqual(out["/nonexistent/x.ts"].comments, []);
});

// JSX text after a ">" or "}" is text, not a comment (plan rev2 §2 J1-J3).
function commentsOf(src) {
  const d = mkdtempSync(join(tmpdir(), "extract-ts-"));
  try {
    const f = join(d, "a.tsx");
    writeFileSync(f, src);
    return run(f)[f].comments.map(({ start, text }) => [start, text]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("J1/J2: JSX text that looks like a comment is not a comment", () => {
  assert.deepEqual(commentsOf("const a = <p>/* eslint-disable max-lines */</p>;\n"), []);
  assert.deepEqual(commentsOf("const b = (x: number) => <p>{x}// nolint here</p>;\n"), []);
});

test("J3: real comments next to JSX are still found, at their lines", () => {
  for (const [src, want] of [
    ["const a = <p>{/* eslint-disable max-lines */}</p>;\n", [1, "/* eslint-disable max-lines */"]],
    ['const b = <div // eslint-disable-line max-lines\n a="1"></div>;\n', [1, "// eslint-disable-line max-lines"]],
    ["\nconst el = <p/>; // nolint\n", [2, "// nolint"]],
    ["function f() {\n  return <p></p> /* eslint-disable */;\n}\n", [2, "/* eslint-disable */"]],
  ])
    assert.deepEqual(commentsOf(src), [want], src);
});
