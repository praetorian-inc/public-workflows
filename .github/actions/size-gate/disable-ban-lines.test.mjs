// The disable ban joins a comment to git's added lines, which count "\n" only,
// whatever line breaks the parser counts (LAB-7587, plan rev2 §5 L1-L9, J4, E1-E3).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as measure from "./measure.mjs";
import { check, file, makeRepo } from "./scenario-kit.mjs";

const BAN = /adds a size-lint disable comment; split the code instead\./;
const banAt = (p, n) => new RegExp(`::error file=${p.replace(".", "\\.")},line=${n}::${p.replace(".", "\\.")}:${n} adds a size-lint disable comment`);
const BASE = { "keep.go": file("go", 3) };
const LS = "\u2028";

const bannedAt = (head, p, n, base = BASE) => {
  const r = check(makeRepo({ base, head }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, banAt(p, n), r.out);
};

test("L1: a py comment after bare CRs is banned at its git line", () => {
  bannedAt({ "a.py": "x = 1\n\r\r# ruff: noqa\n" }, "a.py", 2);
});

test("L2: a py trailing noqa after bare CRs is banned at git line 1", () => {
  bannedAt({ "a.py": "x = 1\r\r\ry = 2  # noqa\n" }, "a.py", 1);
});

test("L3: a ts directive after bare CRs is banned at git line 2", () => {
  bannedAt({ "a.ts": "\n\r\r\r/* eslint-disable max-lines */" }, "a.ts", 2);
});

test("L4: a ts directive after U+2028 breaks is banned at git line 1", () => {
  bannedAt({ "a.ts": `${LS}${LS}${LS}/* eslint-disable max-lines */` }, "a.ts", 1);
});

test("L5: a ruff own-line disable after a bare CR is banned at git line 1", () => {
  bannedAt({ "d.py": "x = 1\r# ruff: disable[PLR0915]\n" }, "d.py", 1);
});

test("L6: a directive appended after a string holding U+2028 is banned at its git line", () => {
  const s = `export const s = "a${LS}b";\nexport const x = 1;\n`;
  bannedAt({ "a.ts": `${s}/* eslint-disable max-lines */\n` }, "a.ts", 3, { "a.ts": s });
});

test("L7: an unchanged directive after a U+2028 line is not banned when a later line changes", () => {
  const s = `export const s = "a${LS}b";\n/* eslint-disable max-lines */\n`;
  const r = check(makeRepo({ base: { "e.ts": `${s}export const y = 1;\n` }, head: { "e.ts": `${s}export const y = 2;\n` } }));
  assert.doesNotMatch(r.out, BAN, r.out);
});

test("L8: Go counts \\n only, so a //nolint after bare CRs is banned at git line 2", () => {
  bannedAt({ "a.go": "package p\n\rvar x = 1\r\r//nolint\n" }, "a.go", 2);
});

test("L9: gitLines maps each parser line to its git line", () => {
  for (const [p, t, want] of [
    ["a.py", "a\r\r\nb", [1, 1, 2]], // "a", "" and "b": a \r, then a \r\n
    ["a.ts", `a${LS}b\nc`, [1, 1, 2]],
    ["a.tsx", "a\r\nb\rc", [1, 2, 2]],
    ["a.go", "a\r\rb\nc\n", [1, 2, 3]],
  ]) {
    const g = measure.gitLines(p, t);
    assert.deepEqual(g, want, JSON.stringify(t));
    assert.equal(g.length, measure.splitLines(p, t).length, JSON.stringify(t));
  }
});

test("J4: JSX text that looks like a comment is not banned", () => {
  for (const t of ["<p>/* eslint-disable max-lines */</p>", "<p>{x}// nolint here</p>"]) {
    const r = check(makeRepo({ base: BASE, head: { "c.tsx": `export const C = (x: number) => ${t};\n` } }));
    assert.doesNotMatch(r.out, BAN, `${t}\n${r.out}`);
  }
});

// E1-E3 run the real Python extractor end to end (plan rev2 §3).
const UTF7 = "# coding: utf-7\n";

test("E1: a utf-7 file whose noqa ruff reads as a comment is banned at git line 2", () => {
  bannedAt({ "a.py": `${UTF7}x = +ACI-0  # noqa: PLR0915 +ACI-\n` }, "a.py", 2);
});

test("E2: a utf-7 file whose codec adds a line break fails as cannot parse", () => {
  const r = check(makeRepo({ base: BASE, head: { "a.py": `${UTF7}x = 1  +AAoAIw- noqa\n` } }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a\.py cannot parse: /, r.out);
});

test("E3: an own-line ruff disable in a Latin-1 file is banned despite its non-UTF-8 byte", () => {
  const text = "# -*- coding: latin-1 -*-\nx = 1\n# ruff: disable[PLR0915]  # café\n";
  bannedAt({ "a.py": Buffer.from(text, "latin1") }, "a.py", 3);
});
