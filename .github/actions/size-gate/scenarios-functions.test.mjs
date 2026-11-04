// End-to-end function-rule scenarios N1-N15 (LAB-7587, LAB-7641).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXT, LANGS, check, component, file, fn, makeRepo, source } from "./scenario-kit.mjs";

// Every repo carries one small in-scope file so the liveness floor holds.
const repo = (lang, base, head) => makeRepo({ base: { [`keep.${EXT[lang]}`]: file(lang, 3), ...base }, head });

// Component rules hold wherever JSX parses: TSX, JSX, and JSX in plain .js, .mjs and .cjs.
const COMPONENT_LANGS = ["tsx", "jsx", "js", "mjs", "cjs"];

// A method of exactly n lines on a type or class, so names are qualified.
function method(lang, n, tok) {
  if (lang === "go") return fn("go", "T.M", n, tok);
  if (lang === "py") return ["class C:", `    def m(self):`, ...Array(n - 1).fill(`        x = ${tok}`)];
  return ["class C {", "  m() {", ...Array(n - 2).fill(`    x += ${tok};`), "  }", "}"];
}

for (const lang of LANGS) {
  const p = `src/a.${EXT[lang]}`;
  const one = (base, head) => check(repo(lang, { [p]: base }, { [p]: head }));

  test(`${lang} N1: a new 51-line function warns; 50 does not`, () => {
    const r = one(source(lang), source(lang, fn(lang, "F", 51)));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`::warning file=${p},line=\\d+::${p}:\\d+ new function \`F\` is 51 lines; the limit is 50`));
    assert.equal(one(source(lang), source(lang, fn(lang, "F", 50))).code, 0);
  });

  test(`${lang} N2: an existing function grown from 40 to 51 warns`, () => {
    const r = one(source(lang, fn(lang, "F", 40)), source(lang, fn(lang, "F", 51)));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /`F` grew to 51 lines; the limit is 50/);
  });

  test(`${lang} N3: a previously over-limit function warns when changed or grown`, () => {
    const base = source(lang, fn(lang, "F", 60));
    const changed = one(base, source(lang, fn(lang, "F", 60, "1")));
    assert.equal(changed.code, 0, changed.out);
    assert.match(changed.out, /`F` changed at 60 lines; advisory threshold 50/);
    const grown = one(base, source(lang, fn(lang, "F", 61, "1")));
    assert.equal(grown.code, 0, grown.out);
    assert.match(grown.out, /`F` grew from 60 to 61 lines; advisory threshold 50/);
    const shrunk = one(base, source(lang, fn(lang, "F", 57, "1")));
    assert.equal(shrunk.code, 0, shrunk.out);
    assert.match(shrunk.out, /`F` changed at 57 lines; advisory threshold 50/);
  });

  test(`${lang} N4: an unchanged 80-line function in a changed file passes`, () => {
    const r = one(source(lang, fn(lang, "F", 80), fn(lang, "G", 5)), source(lang, fn(lang, "F", 80), fn(lang, "G", 5, "1")));
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /::warning file=.*`F`/);
  });

  test(`${lang} N7: a git mv of a file holding an unchanged 80-line function passes`, () => {
    const q = `src/b.${EXT[lang]}`;
    const text = source(lang, fn(lang, "F", 80));
    const r = check(repo(lang, { [p]: text }, { [p]: null, [q]: text }));
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /::warning file=.*`F`/);
  });

  test(`${lang} N8: a qualified method is matched across an unrelated insertion above it`, () => {
    const base = source(lang, method(lang, 80, "0"));
    const head = source(lang, fn(lang, "G", 5), method(lang, 80, "1"));
    const r = one(base, head);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning file=.*`m` changed at 80 lines|::warning file=.*`C\.m` changed at 80 lines|::warning file=.*`T\.M` changed at 80 lines/);
  });
}

for (const lang of COMPONENT_LANGS) {
  test(`${lang} N5: a new 151-line component warns; 150 does not`, () => {
    const p = `src/a.${lang}`;
    const one = (head) => check(repo(lang, { [p]: source(lang) }, { [p]: head }));
    const r = one(source(lang, component("C", 151)));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /new function `C` is 151 lines; the limit is 150/);
    assert.equal(one(source(lang, component("C", 150))).code, 0);
  });

  test(`${lang} N6: a 120-line component that loses its JSX warns`, () => {
    const p = `src/a.${lang}`;
    const r = check(repo(lang, { [p]: source(lang, component("C", 120)) }, { [p]: source(lang, fn(lang, "C", 120)) }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /`C` is now 120 lines; the limit is 50/);
  });

  test(`${lang} N11: a 100-line function that gains JSX warns on growth`, () => {
    const p = `src/a.${lang}`;
    const one = (head) => check(repo(lang, { [p]: source(lang, fn(lang, "C", 100)) }, { [p]: head }));
    const grown = one(source(lang, component("C", 120)));
    assert.equal(grown.code, 0, grown.out);
    assert.match(grown.out, /`C` grew from 100 to 120 lines; advisory threshold 150/);
    const changed = one(source(lang, component("C", 100, "1")));
    assert.equal(changed.code, 0, changed.out);
    assert.doesNotMatch(changed.out, /::warning file=.*`C`/);
  });
}

test("go N12: a duplicate name's ordinal carries no allowance; an unchanged duplicate still passes", () => {
  const p = "src/a.go";
  const one = (head) => check(repo("go", { [p]: source("go", fn("go", "init", 60), fn("go", "init", 100)) }, { [p]: head }));
  const grown = one(source("go", fn("go", "init", 5, "2"), fn("go", "init", 100, "1")));
  assert.equal(grown.code, 0, grown.out);
  assert.match(grown.out, /`init#2` \(100 lines; the limit is 50\) matches base functions in `src\/a\.go`; the match is ambiguous/);
  const kept = one(source("go", fn("go", "init", 5, "2"), fn("go", "init", 60), fn("go", "init", 100)));
  assert.equal(kept.code, 0, kept.out);
  const copied = check(repo("go", { [p]: source("go", fn("go", "init", 100)) }, { [p]: source("go", fn("go", "init", 100), fn("go", "init", 100)) }));
  assert.equal(copied.code, 0, copied.out);
  assert.match(copied.out, /`init#2` in `src\/a\.go` matches the base function `init`.*copy exceeds the 50-line advisory threshold/);
});

for (const lang of ["ts", "py"]) {
  test(`${lang} N10: bare-CR line endings neither hide a function's growth nor a file's length`, () => {
    const cr = (t) => t.replaceAll("\n", "\r");
    const p = `src/a.${EXT[lang]}`;
    const grown = check(repo(lang, { [p]: cr(source(lang, fn(lang, "F", 40))) }, { [p]: cr(source(lang, fn(lang, "F", 60))) }));
    assert.equal(grown.code, 0, grown.out);
    assert.match(grown.out, /`F` grew to 60 lines; the limit is 50/);
    const big = check(repo(lang, {}, { [p]: cr(file(lang, 501)) }));
    assert.equal(big.code, 0, big.out);
    assert.match(big.out, /::warning file=.*is 501 lines, over the 400-line advisory threshold/);
  });
}

test("py N9: a HEAD file with a syntax error fails", () => {
  const p = "src/a.py";
  const r = check(repo("py", { [p]: source("py", fn("py", "F", 5)) }, { [p]: "def f(:\n    pass\n" }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error file=src\/a\.py::src\/a\.py cannot parse: /);
});

test("py: a base file that does not parse counts everything as new, with a warning", () => {
  const p = "src/a.py";
  const r = check(repo("py", { [p]: "def f(:\n" }, { [p]: source("py", fn("py", "F", 51)) }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning file=src\/a\.py::src\/a\.py did not parse at the merge-base/);
  assert.match(r.out, /new function `F` is 51 lines/);
});

test("py: a previously over-limit function in a Latin-1 file parses and warns", () => {
  const p = "src/a.py";
  const latin1 = (tok) => Buffer.from(source("py", ["# -*- coding: latin-1 -*-"], fn("py", "café", 60, tok)), "latin1");
  const r = check(repo("py", { [p]: latin1("0") }, { [p]: latin1("1") }));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /did not parse at the merge-base/);
  assert.match(r.out, /`café` changed at 60 lines; advisory threshold 50/);
});

test("py N13: a new 60-line parenthesized lambda warns", () => {
  const p = "src/a.py";
  const lam = ["handler = (", "    lambda: [", ...Array(58).fill("        0,"), "    ]", ")"];
  const r = check(repo("py", { [p]: source("py") }, { [p]: source("py", lam) }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /new function `lambda:handler` is 60 lines; the limit is 50/);
});

test("py N14: replacing an over-limit annotated lambda with a differently named one is checked as new", () => {
  const p = "src/a.py";
  const lam = (name) => [`${name}: object = (`, "    lambda: [", ...Array(58).fill("        0,"), "    ]", ")"];
  const r = check(repo("py", { [p]: source("py", lam("old")) }, { [p]: source("py", lam("new")) }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /new function `lambda:new` is 60 lines; the limit is 50/);
});

for (const lang of COMPONENT_LANGS) {
  test(`${lang} N15: a previously over-limit component that loses JSX warns when changed or grown`, () => {
    const p = `src/a.${lang}`;
    const one = (head) => check(repo(lang, { [p]: source(lang, component("C", 200)) }, { [p]: head }));
    const changed = one(source(lang, fn(lang, "C", 200)));
    assert.equal(changed.code, 0, changed.out);
    assert.match(changed.out, /`C` changed at 200 lines; advisory threshold 50/);
    const grown = one(source(lang, fn(lang, "C", 201)));
    assert.equal(grown.code, 0, grown.out);
    assert.match(grown.out, /`C` grew from 200 to 201 lines; advisory threshold 50/);
  });
}
