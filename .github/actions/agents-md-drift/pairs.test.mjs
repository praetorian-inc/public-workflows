import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPairs, capPairs, carriesContent, governing, sections, skipped } from "./pairs.mjs";

test("sections: ## and ### only, nested ### inside its ## parent, fenced headings ignored", () => {
  const md = ["# Title", "intro", "## A", "a1", "### A.1", "x", "```", "## not a heading", "```", "## B ##", "b"].join("\n");
  const s = sections(md);
  assert.deepEqual(s.map((x) => [x.heading, x.level]), [["A", 2], ["A.1", 3], ["B", 2]]);
  assert.match(s[0].text, /### A\.1[\s\S]*## not a heading/);
  assert.equal(s[1].text, "### A.1\nx\n```\n## not a heading\n```");
  assert.equal(s[2].text, "## B ##\nb");
});

test("sections: an ATX heading may be indented up to three spaces, not four", () => {
  const md = ["   ## A", "a", " ### A.1", "x", "    ## code, not a heading", "## B", "b"].join("\n");
  assert.deepEqual(sections(md).map((x) => [x.heading, x.level]), [["A", 2], ["A.1", 3], ["B", 2]]);
});

// CommonMark fence rules: a fence closes only on the same character, at least
// as long as the opener, with nothing but whitespace after it and at most three
// spaces of indent. A backtick opener's info string cannot contain a backtick.
test("sections: a fence closes only on a matching CommonMark closing fence", () => {
  const headings = (lines) => sections(lines.join("\n")).map((x) => x.heading);
  // A shorter run inside a longer fence is text.
  assert.deepEqual(headings(["## A", "````", "```", "## in", "```", "````", "## B"]), ["A", "B"]);
  // The other fence character is text.
  assert.deepEqual(headings(["## A", "~~~", "```", "## in", "~~~", "## B"]), ["A", "B"]);
  // A line with an info string never closes a fence.
  assert.deepEqual(headings(["## A", "```", "```js", "## in", "```", "## B"]), ["A", "B"]);
  // A backtick run whose info string holds a backtick is not an opener.
  assert.deepEqual(headings(["## A", "``` a`b", "## B"]), ["A", "B"]);
  // Four spaces of indent is not a fence (opener or closer).
  assert.deepEqual(headings(["## A", "    ```", "## B"]), ["A", "B"]);
  assert.deepEqual(headings(["## A", "```", "    ```", "## in", "   ```", "## B"]), ["A", "B"]);
  // Trailing whitespace after a closer is allowed.
  assert.deepEqual(headings(["## A", "~~~~ sh", "## in", "~~~~~  ", "## B"]), ["A", "B"]);
});

test("carriesContent drops an empty or pointer-only CLAUDE.md, never an AGENTS.md", () => {
  assert.equal(carriesContent("x/CLAUDE.md", " @AGENTS.md \n"), false);
  assert.equal(carriesContent("CLAUDE.md", ""), false);
  assert.equal(carriesContent("CLAUDE.md", "## Real"), true);
  assert.equal(carriesContent("AGENTS.md", ""), true);
  assert.equal(carriesContent("AGENTS.md", null), false);
});

test("governing: every ancestor, nearest first, AGENTS.md before CLAUDE.md", () => {
  const files = { "AGENTS.md": "r", "a/AGENTS.md": "a", "a/CLAUDE.md": "@AGENTS.md", "a/b/CLAUDE.md": "## b" };
  assert.deepEqual(governing("a/b/c.go", (p) => files[p] ?? null), ["a/b/CLAUDE.md", "a/AGENTS.md", "AGENTS.md"]);
  assert.deepEqual(governing("top.go", (p) => files[p] ?? null), ["AGENTS.md"]);
});

test("governing: AGENTS.md before CLAUDE.md when both carry content in one directory", () => {
  const files = { "AGENTS.md": "r", "CLAUDE.md": "## rc", "a/AGENTS.md": "a", "a/CLAUDE.md": "## ac" };
  assert.deepEqual(governing("a/x.go", (p) => files[p] ?? null), ["a/AGENTS.md", "a/CLAUDE.md", "AGENTS.md", "CLAUDE.md"]);
});

test("skipped uses the shell pre-filter's extension rule", () => {
  assert.equal(skipped("a/b.md", [".md"]), true);
  assert.equal(skipped("Makefile", [".md"]), false);
  assert.equal(skipped("a.go", [".md"]), false);
});

test("capPairs keeps the nearest first and groups the overflow by file and instruction file", () => {
  const all = [
    { file: "x", agents_md: "AGENTS.md", heading: "r1", distance: 1 },
    { file: "x", agents_md: "a/AGENTS.md", heading: "a1", distance: 0 },
    { file: "x", agents_md: "AGENTS.md", heading: "r2", distance: 1 },
    { file: "y", agents_md: "AGENTS.md", heading: "r1", distance: 1 },
  ];
  const { pairs, overflow } = capPairs(all, 2);
  assert.deepEqual(pairs.map((p) => [p.id, p.heading]), [["p1", "a1"], ["p2", "r1"]]);
  assert.deepEqual(overflow, [
    { file: "x", agents_md: "AGENTS.md", sections: 1 },
    { file: "y", agents_md: "AGENTS.md", sections: 1 },
  ]);
  assert.equal(capPairs(all, 10).overflow.length, 0);
});

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "drift-pairs-"));
  const g = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  const put = (p, s) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), s);
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  return { root, g, put };
}

test("buildPairs pairs each changed code file with every governing section", (t) => {
  const { root, g, put } = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put("AGENTS.md", "## Root\nr\n");
  put("svc/AGENTS.md", "## Handlers\nlist: a\n### Detail\nd\n");
  put("svc/a.go", "package a\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  put("svc/b.go", "package b\n");
  put("svc/my file.go", "package c\n");
  put("svc/notes.md", "doc\n");
  put("svc/AGENTS.md", "## Handlers\nlist: a\n### Detail\nd\n## Added\nnew\n");
  g("add", "-A");
  g("commit", "-qm", "head");
  const head = g("rev-parse", "HEAD");

  const { diffs, pairs, overflow } = buildPairs({ root, base, head, skipList: [".md"], maxPairs: 2000 });
  assert.deepEqual(Object.keys(diffs).sort(), ["svc/b.go", "svc/my file.go"]);
  assert.match(diffs["svc/b.go"], /^diff --git a\/svc\/b\.go b\/svc\/b\.go/);
  assert.match(diffs["svc/b.go"], /\+package b/);
  const forB = pairs.filter((p) => p.file === "svc/b.go").map((p) => [p.agents_md, p.heading, p.distance]);
  assert.deepEqual(forB, [
    ["svc/AGENTS.md", "Handlers", 0],
    ["svc/AGENTS.md", "Detail", 0],
    ["svc/AGENTS.md", "Added", 0],
    ["AGENTS.md", "Root", 1],
  ]);
  assert.equal(pairs.length, 8);
  assert.equal(pairs[0].section, "## Handlers\nlist: a\n### Detail\nd");
  assert.deepEqual(overflow, []);

  const capped = buildPairs({ root, base, head, skipList: [".md"], maxPairs: 6 });
  assert.equal(capped.pairs.length, 6);
  assert.ok(capped.pairs.every((p) => p.distance === 0));
  assert.deepEqual(capped.overflow.map((o) => [o.file, o.agents_md, o.sections]), [
    ["svc/b.go", "AGENTS.md", 1],
    ["svc/my file.go", "AGENTS.md", 1],
  ]);
});

test("buildPairs numbers a repeated heading so each section keeps its own identity", (t) => {
  const { root, g, put } = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put("AGENTS.md", "## Notes\na\n## Other\n### Notes\nb\n## Notes\nc\n");
  put("a.go", "package a\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  put("a.go", "package a // x\n");
  g("add", "-A");
  g("commit", "-qm", "head");
  const head = g("rev-parse", "HEAD");
  const { pairs } = buildPairs({ root, base, head, skipList: [], maxPairs: 10 });
  assert.deepEqual(pairs.map((p) => [p.heading, p.occurrence]), [["Notes", 1], ["Other", 1], ["Notes", 2], ["Notes", 3]]);
});

test("buildPairs reports a governing file with no ## or ### section", (t) => {
  const { root, g, put } = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put("AGENTS.md", "# Title\nOnly a preamble.\n");
  put("svc/AGENTS.md", "## Handlers\nlist: a\n");
  put("svc/a.go", "package a\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  put("svc/a.go", "package a // x\n");
  g("add", "-A");
  g("commit", "-qm", "head");
  const head = g("rev-parse", "HEAD");
  const { pairs, sectionless } = buildPairs({ root, base, head, skipList: [], maxPairs: 10 });
  assert.deepEqual(pairs.map((p) => [p.agents_md, p.heading]), [["svc/AGENTS.md", "Handlers"]]);
  assert.deepEqual(sectionless, ["AGENTS.md"]);
});

test("buildPairs throws when git cannot answer", (t) => {
  const { root } = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => buildPairs({ root, base: "deadbeef", head: "HEAD", skipList: [], maxPairs: 10 }));
});
