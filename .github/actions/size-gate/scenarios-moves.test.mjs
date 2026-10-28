// End-to-end cross-file matching scenarios M1-M9 (LAB-7587): a function may
// move between files in one directory and keep its allowance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXT, LANGS, check, file, fn, makeRepo, source } from "./scenario-kit.mjs";

const repo = (lang, base, head) => makeRepo({ base: { [`keep.${EXT[lang]}`]: file(lang, 3), ...base }, head });
const count = (out, re) => out.split("\n").filter((l) => re.test(l)).length;

for (const lang of LANGS) {
  const at = (name, dir = "src") => `${dir}/${name}.${EXT[lang]}`;
  const legacy = at("legacy");
  const split = at("split");
  // legacy holds F plus a 100-line Z, so deleting it is not read as a rename.
  const legacyBase = (n) => source(lang, fn(lang, "F", n), fn(lang, "K", 5), fn(lang, "Z", 100));
  const zBase = { [legacy]: legacyBase(80) };
  const shrunk = source(lang, fn(lang, "K", 5), fn(lang, "Z", 100));

  test(`${lang} M1: a grandfathered function split into a sibling keeps its allowance`, () => {
    for (const n of [80, 75]) {
      const r = check(repo(lang, zBase, { [legacy]: shrunk, [split]: source(lang, fn(lang, "F", n, "1")) }));
      assert.equal(r.code, 0, `${n}: ${r.out}`);
    }
    const gone = check(repo(lang, zBase, { [legacy]: null, [split]: source(lang, fn(lang, "F", 80, "1")) }));
    assert.equal(gone.code, 0, gone.out);
  });

  test(`${lang} M2: a moved function that grows fails and names its source`, () => {
    const r = check(repo(lang, zBase, { [legacy]: shrunk, [split]: source(lang, fn(lang, "F", 81)) }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`\`F\` moved from \`${legacy}\`; it was 80 lines at the merge-base and is now 81`));
  });

  test(`${lang} M3: a moved function that was within its limit and is now over it fails`, () => {
    const r = check(repo(lang, { [legacy]: legacyBase(40) }, { [legacy]: shrunk, [split]: source(lang, fn(lang, "F", 51)) }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /`F` grew to 51 lines; the limit is 50/);
  });

  test(`${lang} M4: a move to another directory is a new function`, () => {
    const r = check(repo(lang, zBase, { [legacy]: shrunk, [at("split", "lib")]: source(lang, fn(lang, "F", 80)) }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /new function `F` is 80 lines; the limit is 50/);
  });

  test(`${lang} M5: a function renamed while moving is new`, () => {
    const r = check(repo(lang, zBase, { [legacy]: shrunk, [split]: source(lang, fn(lang, "New", 80)) }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /new function `New` is 80 lines/);
  });

  test(`${lang} M6: the same name in two changed base files is ambiguous`, () => {
    const [one, two] = [at("one"), at("two")];
    const base = { [one]: legacyBase(60), [two]: legacyBase(60) };
    const r = check(repo(lang, base, { [one]: shrunk, [two]: shrunk, [split]: source(lang, fn(lang, "F", 60)) }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`\`F\` \\(60 lines; the limit is 50\\) matches base functions in \`${one}\` and \`${two}\`; the match is ambiguous, so it is checked as a new function`));
  });

  test(`${lang} M7: an in-place edit is matched exactly even when a sibling has the same name`, () => {
    const [a, b] = [at("a"), at("b")];
    const base = { [a]: source(lang, fn(lang, "F", 60)), [b]: source(lang, fn(lang, "F", 60), fn(lang, "K", 5)) };
    const r = check(repo(lang, base, { [a]: source(lang, fn(lang, "F", 60, "1")), [b]: source(lang, fn(lang, "F", 60), fn(lang, "K", 5, "1")) }));
    assert.equal(r.code, 0, r.out);
  });

  test(`${lang} M8: a grandfathered function moved out and copied into two new siblings fails both`, () => {
    const head = { [legacy]: null, [at("s1")]: source(lang, fn(lang, "F", 80)), [at("s2")]: source(lang, fn(lang, "F", 80)) };
    const r = check(repo(lang, zBase, head));
    assert.equal(r.code, 1, r.out);
    assert.equal(count(r.out, /^::error .*`F` \(80 lines; the limit is 50\) .*ambiguous/), 2, r.out);
  });

  test(`${lang} M9: an in-place edit keeps the allowance and a sibling copy is checked as new`, () => {
    const [a, b] = [at("a"), at("b")];
    const r = check(repo(lang, { [a]: source(lang, fn(lang, "F", 80)) }, { [a]: source(lang, fn(lang, "F", 80, "1")), [b]: source(lang, fn(lang, "F", 80)) }));
    assert.equal(r.code, 1, r.out);
    assert.equal(count(r.out, new RegExp(`^::error file=${a}`)), 0, r.out);
    assert.match(r.out, new RegExp(`^::error file=${b}.*\`F\` in \`${b}\` matches the base function \`F\` in \`${a}\`, which \`${a}\` still holds in place; a copy does not inherit its allowance, so it is checked as a new function`, "m"));
  });
}
