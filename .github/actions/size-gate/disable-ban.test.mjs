// D1/D2: size-lint disable comments on added lines (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bannedLines } from "./disable-ban.mjs";
import { splitLines } from "./measure.mjs";
import { check, file, makeRepo, run } from "./scenario-kit.mjs";

// Each case is one comment, split by its path: .ts for /* */, .py for #, .go otherwise.
const pathFor = (t) => (t.startsWith("/*") ? "a.ts" : t.startsWith("#") ? "a.py" : "a.go");
const banned = (text, comment = text) => bannedLines(new Map([[1, text]]), [{ start: 1, end: 1, text: comment }], pathFor(comment)).length === 1;
// A block comment with every line added, or only line `only` (an inner-line edit).
const bannedIn = (text, only, lines = splitLines("a.ts", text)) =>
  bannedLines(new Map(lines.map((t, i) => [i + 1, t]).filter(([n]) => only === undefined || n === only)), [{ start: 1, end: lines.length, text }], "a.ts");

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
    "# ruff: noqa",
    "# flake8: noqa",
    "# ruff: noqa: PLR0915",
    "# ruff: disable[PLR0915]",
    "#ruff : disable [ E501 ,PLR0915, ]  # why",
    "# ruff: disable[too-many-statements]", // preview rule names
  ])
    assert.equal(banned(t), true, t);
});

test("D1: every pylint pragma that silences a size message", () => {
  for (const t of [
    "# pylint: disable=too-many-lines",
    "# pylint: disable=C0302",
    "def f():  # pylint: disable=too-many-statements,R0915",
    "# pylint: disable=all",
    "x = 1  # pylint: disable-next=all",
    "# pylint: skip-file",
    "# pylint: skip-file foo",
    "# pylint: disable-all",
    "# pylint: disable=r0915", // message ids ignore case
    "# pylint: disable-next=r0915",
    "# pylint: disable=c0302",
    "# pylint: disable=R", // categories
    "# pylint: disable-next=R",
    "# pylint: disable=C",
    "# pylint: disable=E,R",
    "# pylint: disable=I R",
    "# pylint: disable=design", // checker names ignore case
    "# pylint: disable=DESIGN",
    "# pylint: disable=format",
    "# pylint: disable-next=design",
    "# pylint: disable-msg=too-many-statements",
    "# pylint: disable-msg=R0915",
    "# pylint: disable-msg=R",
    "# pylint: disable-msg=too-many-lines",
    "# pylint: disable-msg=all",
    "# foo pylint: disable=too-many-statements",
    "# x-pylint: disable=R0915",
    "# pylint: enable=unused-import, disable=too-many-statements",
    "# pylint: enable=all, disable=R",
    "# pylint: enable=R0915, skip-file",
    "# pylint: disable=invalid-name disable=R0915",
    "# pylint: foo disable=R0915",
    "# pylint: disable = R0915",
    "# pylint: disable=foo.R0915",
    "# pylint: disable=too-many-statements,",
    "# pylint: disable=,R0915",
    "# pylint: disable=R0915; why",
    "# pylint: disable=foo # pylint: disable=R0915", // pylint reads the last pragma
  ])
    assert.equal(banned(t), true, t);
});

test("D1: a multi-line ESLint directive fails at its first added line", () => {
  for (const t of [
    "/* eslint\n   max-lines-per-function: off */",
    "/*\n eslint max-lines-per-function: off */",
    "/* eslint no-console: off,\n  max-lines-per-function: off */",
    "/* eslint-disable no-console,\n  max-lines-per-function */",
    "/* eslint-disable-next-line\n  max-lines-per-function */",
    "/* eslint-disable\n */",
    "/* eslint-disable -- because\n  reasons */",
    "/*\n eslint\n  no-console: off,\n  max-lines-per-function: off\n */",
    '/* eslint\n "max-lines-per-function": "off" */',
    '/* eslint max-lines-per-function: [\n "error", 500] */',
    "/*\n eslint-disable max-lines-per-function */",
    "/* eslint-disable\n max-lines-per-function */",
  ])
    assert.deepEqual(bannedIn(t), [1], t);
});

test("D1: editing only an inner line of a multi-line ESLint directive fails at that line", () => {
  assert.deepEqual(bannedIn("/* eslint\n   max-lines-per-function: off */", 2), [2]);
  assert.deepEqual(bannedIn("/* eslint-disable no-console,\n  max-lines-per-function,\n  no-alert */", 3), [3]);
});

test("D2: suppressions of non-size rules pass", () => {
  for (const t of [
    "x = 1  # noqa: E501",
    "x = 1  # noqa:F401",
    "def f():  # noqa: C901",
    "x := 1 //nolint:lll",
    "// eslint-disable-next-line no-console",
    "const nolintish = 1;",
    "# ruff: noqa: E501",
    "# noqa: PLR",
    "# noqa: PLR09",
    "# ruff: noqa: PLR",
    "# ruff: disable[PLR09]",
    "# ruff: disable[plr0915]",
    "# RUFF: disable[PLR0915]",
    ["x = 1  # ruff: disable[PLR0915]", "# ruff: disable[PLR0915]"], // own-line comments only
    "# ruff: disable[PLR0915 E501]",
    "# ruff: disable[E501] # ruff: disable[PLR0915]",
    "// eslint max-lines-per-function: off",
    "/** eslint max-lines-per-function: off */",
  ])
    assert.equal(banned(...[t].flat()), false, t);
});

test("D2: pylint pragmas that do not silence a size message pass", () => {
  for (const t of [
    "# pylint: disable=invalid-name",
    "# pylint: disable=all-caps-name",
    "# pylint: disable=r", // a lone lowercase letter is no token
    "# pylint: disable=R09",
    "# pylint: disable=TOO-MANY-STATEMENTS", // symbolic names keep case
    "# pylint: disable=TOO-MANY-LINES",
    "# PYLINT: disable=R0915",
    "# pylint : disable=R0915",
    "# xpylint: disable=R0915",
    "# pylint: disable-msg-next=R0915",
    "# pylint: x=1 disable=R0915",
    "# pylint: disable=R0915 =", // a parse error drops the pending pragma
    "# pylint: skip-file=1",
    "# pylint: disable:R0915",
    "# pylint: disable-next:R0915",
    "# pylint: disable=R0915x",
    "# pylint: disable=_R",
    "# pylint: disable=design-x",
    "# pylint: disable=refactor",
    "# pylint: disable=convention",
    "# pylint: disable=c",
    "# pylint: disable=W0302",
    "# pylint: enable=R0915",
    "# pylint: disable=R0915 # pylint: disable=foo",
  ])
    assert.equal(banned(t), false, t);
});

test("D2: multi-line comments ESLint does not read as a size directive pass", () => {
  for (const t of [
    "/**\n * eslint max-lines-per-function: off\n */",
    "/* eslint-env\n node */",
    "/* eslint-enable\n max-lines-per-function */",
    "/* global\n max-lines-per-function */",
    "/* see\n max-lines-per-function: off */",
    "/* eslint-disable no-console,\n no-alert */",
  ])
    assert.deepEqual(bannedIn(t), [], t);
  assert.deepEqual(bannedIn("/* eslint-disable-line\n max-lines-per-function */", 2), []); // may not span lines
  assert.deepEqual(bannedIn("/* eslint-disable no-console -- max-lines-per-function\n */", 2), []); // justification
});

test("bannedLines returns the line numbers", () => {
  const comments = [{ start: 7, end: 7, text: "# noqa" }, { start: 9, end: 9, text: "//nolint" }];
  assert.deepEqual(bannedLines(new Map([[3, "a"], [7, "x  # noqa"], [9, "//nolint"]]), comments, "a.py"), [7, 9]);
});

test("D1/D2 end to end: an added banned comment fails at its line; a coded noqa passes", () => {
  const bad = makeRepo({ base: { "m.py": file("py", 3) }, head: { "m.py": file("py", 3) + "x = 1  # noqa\n" } });
  const r = check(bad);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error file=m\.py,line=4::m\.py:4 adds a size-lint disable comment; split the code instead\./);
  const ok = makeRepo({ base: { "m.py": file("py", 3) }, head: { "m.py": file("py", 3) + "x = 1  # noqa: E501\n" } });
  assert.equal(check(ok).code, 0);
});

test("D1 end to end: a multi-line ESLint directive fails at its first line, or at an edited inner line", () => {
  const block = "/* eslint\n   max-lines-per-function: off */\n";
  const r = check(makeRepo({ base: { "m.ts": file("ts", 3) }, head: { "m.ts": file("ts", 3) + block } }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error file=m\.ts,line=4::m\.ts:4 adds a size-lint disable comment; split the code instead\./);
  assert.doesNotMatch(r.out, /line=5::/);
  const was = file("ts", 3) + '/* eslint\n   max-lines-per-function: ["error", 50] */\n';
  const s = check(makeRepo({ base: { "m.ts": was }, head: { "m.ts": file("ts", 3) + block } }));
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /::error file=m\.ts,line=5::m\.ts:5 adds a size-lint disable comment/);
});

test("D1 end to end: a quoted filename or diff.noprefix does not hide a banned comment", () => {
  const quoted = makeRepo({ base: { "q/base.ts": file("ts", 3) }, head: { 'q/we"ird.ts': "// eslint-disable\n" } });
  assert.equal(check(quoted).code, 1);
  const noprefix = makeRepo({ base: { "p.ts": file("ts", 3) }, head: { "p.ts": file("ts", 3) + "// eslint-disable\n" } });
  run(noprefix.root, "config", "diff.noprefix", "true");
  const r = check(noprefix);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error file=p\.ts,line=4::/);
});
