// End-to-end function-rule scenarios N1-N12 (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXT, LANGS, check, component, file, fn, makeRepo, source } from "./scenario-kit.mjs";

// Every repo carries one small in-scope file so the liveness floor holds.
const repo = (lang, base, head) => makeRepo({ base: { [`keep.${EXT[lang]}`]: file(lang, 3), ...base }, head });

// A method of exactly n lines on a type or class, so names are qualified.
function method(lang, n, tok) {
  if (lang === "go") return fn("go", "T.M", n, tok);
  if (lang === "py") return ["class C:", `    def m(self):`, ...Array(n - 1).fill(`        x = ${tok}`)];
  return ["class C {", "  m() {", ...Array(n - 2).fill(`    x += ${tok};`), "  }", "}"];
}

for (const lang of LANGS) {
  const p = `src/a.${EXT[lang]}`;
  const one = (base, head) => check(repo(lang, { [p]: base }, { [p]: head }));

  test(`${lang} N1: a new 51-line function fails; 50 passes`, () => {
    const r = one(source(lang), source(lang, fn(lang, "F", 51)));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`::error file=${p},line=\\d+::${p}:\\d+ new function \`F\` is 51 lines; the limit is 50`));
    assert.equal(one(source(lang), source(lang, fn(lang, "F", 50))).code, 0);
  });

  test(`${lang} N2: an existing function grown from 40 to 51 fails`, () => {
    const r = one(source(lang, fn(lang, "F", 40)), source(lang, fn(lang, "F", 51)));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /`F` grew to 51 lines; the limit is 50/);
  });

  test(`${lang} N3: a grandfathered 60-line function may change but not grow`, () => {
    const base = source(lang, fn(lang, "F", 60));
    assert.equal(one(base, source(lang, fn(lang, "F", 60, "1"))).code, 0);
    const grown = one(base, source(lang, fn(lang, "F", 61, "1")));
    assert.equal(grown.code, 1, grown.out);
    assert.match(grown.out, /`F` was 60 lines at the merge-base and is now 61; an over-limit function may change but not grow/);
    assert.equal(one(base, source(lang, fn(lang, "F", 57, "1"))).code, 0);
  });

  test(`${lang} N4: an unchanged 80-line function in a changed file passes`, () => {
    const r = one(source(lang, fn(lang, "F", 80), fn(lang, "G", 5)), source(lang, fn(lang, "F", 80), fn(lang, "G", 5, "1")));
    assert.equal(r.code, 0, r.out);
  });

  test(`${lang} N7: a git mv of a file holding an unchanged 80-line function passes`, () => {
    const q = `src/b.${EXT[lang]}`;
    const text = source(lang, fn(lang, "F", 80));
    const r = check(repo(lang, { [p]: text }, { [p]: null, [q]: text }));
    assert.equal(r.code, 0, r.out);
  });

  test(`${lang} N8: a qualified method is matched across an unrelated insertion above it`, () => {
    const base = source(lang, method(lang, 80, "0"));
    const head = source(lang, fn(lang, "G", 5), method(lang, 80, "1"));
    const r = one(base, head);
    assert.equal(r.code, 0, r.out);
  });
}

test("tsx N5: a new 151-line component fails; 150 passes", () => {
  const p = "src/a.tsx";
  const one = (head) => check(repo("tsx", { [p]: source("tsx") }, { [p]: head }));
  const r = one(source("tsx", component("C", 151)));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /new function `C` is 151 lines; the limit is 150/);
  assert.equal(one(source("tsx", component("C", 150))).code, 0);
});

test("tsx N6: a 120-line component that loses its JSX fails", () => {
  const p = "src/a.tsx";
  const r = check(repo("tsx", { [p]: source("tsx", component("C", 120)) }, { [p]: source("tsx", fn("tsx", "C", 120)) }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /`C` is now 120 lines; the limit is 50/);
});

test("tsx N11: a grandfathered 100-line function that gains JSX may change but not grow", () => {
  const p = "src/a.tsx";
  const one = (head) => check(repo("tsx", { [p]: source("tsx", fn("tsx", "C", 100)) }, { [p]: head }));
  const grown = one(source("tsx", component("C", 120)));
  assert.equal(grown.code, 1, grown.out);
  assert.match(grown.out, /`C` was 100 lines at the merge-base and is now 120; an over-limit function may change but not grow/);
  assert.equal(one(source("tsx", component("C", 100, "1"))).code, 0);
});

test("go N12: a duplicate name's ordinal carries no allowance; an unchanged duplicate still passes", () => {
  const p = "src/a.go";
  const one = (head) => check(repo("go", { [p]: source("go", fn("go", "init", 60), fn("go", "init", 100)) }, { [p]: head }));
  const grown = one(source("go", fn("go", "init", 5, "2"), fn("go", "init", 100, "1")));
  assert.equal(grown.code, 1, grown.out);
  assert.match(grown.out, /`init#2` \(100 lines; the limit is 50\) matches base functions in `src\/a\.go`; the match is ambiguous/);
  const kept = one(source("go", fn("go", "init", 5, "2"), fn("go", "init", 60), fn("go", "init", 100)));
  assert.equal(kept.code, 0, kept.out);
  const copied = check(repo("go", { [p]: source("go", fn("go", "init", 100)) }, { [p]: source("go", fn("go", "init", 100), fn("go", "init", 100)) }));
  assert.equal(copied.code, 1, copied.out);
  assert.match(copied.out, /`init#2` in `src\/a\.go` matches the base function `init`.*a copy does not inherit its allowance/);
});

for (const lang of ["ts", "py"]) {
  test(`${lang} N10: bare-CR line endings neither hide a function's growth nor a file's length`, () => {
    const cr = (t) => t.replaceAll("\n", "\r");
    const p = `src/a.${EXT[lang]}`;
    const grown = check(repo(lang, { [p]: cr(source(lang, fn(lang, "F", 40))) }, { [p]: cr(source(lang, fn(lang, "F", 60))) }));
    assert.equal(grown.code, 1, grown.out);
    assert.match(grown.out, /`F` grew to 60 lines; the limit is 50/);
    const big = check(repo(lang, {}, { [p]: cr(file(lang, 301)) }));
    assert.equal(big.code, 1, big.out);
    assert.match(big.out, /new file is 301 lines; the limit is 300/);
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
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::warning file=src\/a\.py::src\/a\.py did not parse at the merge-base/);
  assert.match(r.out, /new function `F` is 51 lines/);
});

test("py N12: a new 60-line parenthesized lambda fails", () => {
  const p = "src/a.py";
  const lam = ["handler = (", "    lambda: [", ...Array(58).fill("        0,"), "    ]", ")"];
  const r = check(repo("py", { [p]: source("py") }, { [p]: source("py", lam) }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /new function `lambda:handler` is 60 lines; the limit is 50/);
});
