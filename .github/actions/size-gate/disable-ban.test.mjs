// D1/D2: size-lint disable comments on added lines (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bannedLines } from "./disable-ban.mjs";
import { check, file, makeRepo } from "./scenario-kit.mjs";

const banned = (text) => bannedLines(new Map([[1, text]])).length === 1;

test("D1: every banned form, one per pattern", () => {
  for (const t of [
    "x := 1 //nolint",
    "func F() { // nolint:funlen",
    "x := 1 //nolint:lll,revive",
    "//revive:disable:function-length",
    "// eslint-disable-next-line",
    "f(); // eslint-disable-line max-lines-per-function",
    "/* eslint max-lines: off */",
    "x = 1  # noqa",
    "def f():  # noqa: PLR0915",
    "# pylint: disable=too-many-lines",
    "# pylint: disable=C0302",
    "def f():  # pylint: disable=too-many-statements,R0915",
  ])
    assert.equal(banned(t), true, t);
});

test("D2: suppressions of non-size rules pass", () => {
  for (const t of [
    "x = 1  # noqa: E501",
    "x = 1  # noqa:F401",
    "def f():  # noqa: C901",
    "# pylint: disable=invalid-name",
    "x := 1 //nolint:lll",
    "// eslint-disable-next-line no-console",
    "const nolintish = 1;",
  ])
    assert.equal(banned(t), false, t);
});

test("bannedLines returns the line numbers", () => {
  assert.deepEqual(bannedLines(new Map([[3, "a"], [7, "x  # noqa"], [9, "//nolint"]])), [7, 9]);
});

test("D1/D2 end to end: an added banned comment fails at its line; a coded noqa passes", () => {
  const bad = makeRepo({ base: { "m.py": file("py", 3) }, head: { "m.py": file("py", 3) + "x = 1  # noqa\n" } });
  const r = check(bad);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error file=m\.py,line=4::m\.py:4 adds a size-lint disable comment; split the code instead\./);
  const ok = makeRepo({ base: { "m.py": file("py", 3) }, head: { "m.py": file("py", 3) + "x = 1  # noqa: E501\n" } });
  assert.equal(check(ok).code, 0);
});
