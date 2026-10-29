// End-to-end disable-ban scenarios (LAB-7587): an added size-lint disable
// comment fails even when .gitattributes or a textconv driver hides its hunk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, file, makeRepo, run } from "./scenario-kit.mjs";

const BAN = /adds a size-lint disable comment; split the code instead\./;
const cases = [
  ["go", "*.go -diff", "package p\n\nvar y = 1 //nolint:funlen\n"],
  ["go", "*.go binary", "package p\n\nvar y = 1 //nolint:funlen\n"],
  ["py", "*.py -diff", "# ruff: noqa\nx = 1\n"],
];

for (const [lang, attr, text] of cases) {
  test(`DB1: a ${lang} disable comment added beside "${attr}" fails`, () => {
    const repo = makeRepo({ base: { [`keep.${lang}`]: file(lang, 3) }, head: { ".gitattributes": `${attr}\n`, [`src/a.${lang}`]: text } });
    const r = check(repo);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, BAN);
  });
}

test("DB2: a textconv driver cannot hide an added disable comment", () => {
  const head = { ".gitattributes": "*.go diff=hide\n", "src/a.go": "package p\n\nvar y = 1 //nolint:funlen\n" };
  const repo = makeRepo({ base: { "keep.go": file("go", 3) }, head });
  run(repo.root, "config", "diff.hide.textconv", "true");
  const r = check(repo);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, BAN);
});
