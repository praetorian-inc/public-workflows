// Unit tests for git.mjs against real temporary repositories (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import path from "node:path";
import { bannedLines } from "./disable-ban.mjs";
import { isCommit, listFiles, readDiff, resolveBase, showBlob } from "./git.mjs";
import { commit, initRepo, makeRepo, run, write } from "./scenario-kit.mjs";

const ZERO = "0000000000000000000000000000000000000000";

test("resolveBase: SIZE_GATE_BASE goes through merge-base with HEAD", () => {
  const root = initRepo();
  const fork = commit(root, { "a.go": "package a\n" });
  run(root, "checkout", "-q", "-b", "feature");
  commit(root, { "b.go": "package a\n" });
  run(root, "checkout", "-q", "main");
  const mainTip = commit(root, { "c.go": "package a\n" });
  run(root, "checkout", "-q", "feature");
  const logs = [];
  assert.equal(resolveBase(root, mainTip, (m) => logs.push(m)), fork);
  assert.deepEqual(logs, []);
});

test("resolveBase: a zero or unknown SIZE_GATE_BASE falls through to origin, then HEAD~1", () => {
  const root = initRepo();
  const first = commit(root, { "a.go": "package a\n" });
  commit(root, { "b.go": "package a\n" });
  const logs = [];
  assert.equal(resolveBase(root, ZERO, (m) => logs.push(m)), first);
  assert.equal(resolveBase(root, "deadbeef", (m) => logs.push(m)), first);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^::notice::/);
});

test("resolveBase: a fallback whose merge-base is HEAD is skipped, so a default-branch push compares with HEAD~1", () => {
  const root = initRepo();
  const first = commit(root, { "a.go": "package a\n" });
  const tip = commit(root, { "b.go": "package a\n" });
  run(root, "update-ref", "refs/remotes/origin/main", tip);
  run(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  for (const env of [ZERO, "deadbeef"]) assert.equal(resolveBase(root, env, () => {}, "main"), first);
});

test("resolveBase: origin's default branch is the next candidate", () => {
  const root = initRepo();
  const fork = commit(root, { "a.go": "package a\n" });
  run(root, "update-ref", "refs/remotes/origin/main", fork);
  commit(root, { "b.go": "package a\n" });
  commit(root, { "c.go": "package a\n" });
  assert.equal(resolveBase(root, "", () => {}), fork);
});

test("resolveBase: without origin/HEAD, origin/<SIZE_GATE_DEFAULT_BRANCH> comes before origin/main", () => {
  const root = initRepo();
  const fork = commit(root, { "a.go": "package a\n" });
  run(root, "update-ref", "refs/remotes/origin/develop", fork);
  const later = commit(root, { "b.go": "package a\n" });
  run(root, "update-ref", "refs/remotes/origin/main", later);
  commit(root, { "c.go": "package a\n" });
  assert.equal(resolveBase(root, "", () => {}, "develop"), fork);
  const logs = [];
  assert.equal(resolveBase(root, "", (m) => logs.push(m), "bad..name"), later);
  assert.match(logs[0], /^::notice::SIZE_GATE_DEFAULT_BRANCH 'bad\.\.name' is not a valid branch name/);
});

test("resolveBase: a single commit compares with HEAD and warns", () => {
  const root = initRepo();
  const only = commit(root, { "a.go": "package a\n" });
  const logs = [];
  assert.equal(resolveBase(root, "", (m) => logs.push(m)), only);
  assert.match(logs.at(-1), /^::warning::/);
});

test("isCommit", () => {
  const root = initRepo();
  const sha = commit(root, {});
  assert.equal(isCommit(root, sha), true);
  assert.equal(isCommit(root, ZERO), false);
  assert.equal(isCommit(root, "HEAD~1"), false);
});

test("readDiff: statuses, renames, added lines and untracked files", () => {
  const body = Array.from({ length: 20 }, (_, i) => `// line ${i}`).join("\n") + "\n";
  const { root, base } = makeRepo({
    base: { "d/keep.go": "package d\n\nvar x = 1\n", "d/old.go": body, "d/gone.py": "x = 1\n" },
    head: { "d/keep.go": "package d\n\nvar x = 2\nvar y = 3\n", "d/old.go": null, "d/new.go": body, "d/gone.py": null, "d/add.ts": "let a;\n" },
    untracked: { "d/u.py": "a = 1\nb = 2\n" },
  });
  const d = readDiff(root, base, []);
  assert.deepEqual(d.status.get("d/keep.go"), { code: "M", from: "d/keep.go" });
  assert.deepEqual(d.status.get("d/new.go"), { code: "R", from: "d/old.go" });
  assert.deepEqual(d.status.get("d/gone.py"), { code: "D", from: "d/gone.py" });
  assert.deepEqual(d.status.get("d/add.ts"), { code: "A", from: null });
  assert.deepEqual(d.status.get("d/u.py"), { code: "A", from: null });
  assert.equal(d.renames.get("d/new.go"), "d/old.go");
  assert.deepEqual([...d.added.get("d/keep.go")], [[3, "var x = 2"], [4, "var y = 3"]]);
  assert.deepEqual([...d.added.get("d/u.py")], [[1, "a = 1"], [2, "b = 2"], [3, ""]]);
  assert.equal(d.atBase.has("d/old.go"), true);
  assert.equal(d.atBase.has("d/add.ts"), false);
});

test("readDiff: a symlink that becomes a regular file (status T) reports its added lines at the path", () => {
  const root = initRepo();
  write(root, { "t.go": "package x\n" });
  symlinkSync("t.go", path.join(root, "x.go"));
  const base = commit(root, {}, "base");
  write(root, { "x.go": null });
  commit(root, { "x.go": "package x\n\nvar y = 1 //nolint\n" }, "head");
  assert.match(run(root, "diff", "--name-status", base), /^T\tx\.go$/m);
  const d = readDiff(root, base, []);
  assert.deepEqual(d.status.get("x.go"), { code: "M", from: "x.go" });
  assert.deepEqual([...bannedLines(d.added.get("x.go"))], [3]);
});

test("readDiff and listFiles honor include and exclude pathspecs", () => {
  const { root, base } = makeRepo({
    base: { "a/x.go": "package a\n", "b/y.go": "package b\n" },
    head: { "a/x.go": "package a\n\n", "b/y.go": "package b\n\n", "a/skip/z.go": "package z\n" },
  });
  const specs = [":(glob)a/**", ":(exclude,glob)a/skip/**"];
  assert.deepEqual(listFiles(root, specs), ["a/x.go"]);
  assert.deepEqual([...readDiff(root, base, specs).status.keys()], ["a/x.go"]);
  assert.deepEqual(listFiles(root, [":(exclude,glob)b/**"]).sort(), ["a/skip/z.go", "a/x.go"]);
  assert.deepEqual(listFiles(root, []).sort(), ["a/skip/z.go", "a/x.go", "b/y.go"]);
});

test("readDiff: a path with a space keeps its name", () => {
  const { root, base } = makeRepo({ base: {}, head: { "a b/x.go": "package a\n" } });
  assert.deepEqual([...readDiff(root, base, []).added.keys()], ["a b/x.go"]);
});

test("readDiff: a C-quoted path keeps its name, in order with its neighbours", () => {
  const { root, base } = makeRepo({
    base: { "q/a.ts": "let a;\n", "q/old.ts": "x\ny\nz\nw\n" },
    head: { "q/a.ts": "let a;\nlet b;\n", 'q/we"ird.ts': "let c;\n", "q/back\\slash.ts": "let d;\n", "q/old.ts": null, "q/new.ts": "x\ny\nz\nw\nv\n" },
  });
  const added = readDiff(root, base, []).added;
  assert.deepEqual([...added.get('q/we"ird.ts')], [[1, "let c;"]]);
  assert.deepEqual([...added.get("q/back\\slash.ts")], [[1, "let d;"]]);
  assert.deepEqual([...added.get("q/a.ts")], [[2, "let b;"]]);
  assert.deepEqual([...added.get("q/new.ts")], [[5, "v"]]);
});

test("readDiff: escaped tab, octal control byte and raw UTF-8 inside a quoted name", () => {
  const names = ['q/t\tab é".ts', "q/c\u0001.ts"];
  const { root, base } = makeRepo({ base: {}, head: Object.fromEntries(names.map((n) => [n, "let a;\n"])) });
  const added = readDiff(root, base, []).added;
  for (const n of names) assert.deepEqual([...(added.get(n) ?? [])], [[1, "let a;"]], JSON.stringify(n));
});

test("readDiff: diff.noprefix and diff.mnemonicPrefix in the repo config change nothing", () => {
  for (const [key, val] of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"]]) {
    const { root, base } = makeRepo({ base: { "x.go": "package x\n" }, head: { "x.go": "package x\n\nvar y = 1\n" } });
    run(root, "config", key, val);
    assert.deepEqual([...readDiff(root, base, []).added.get("x.go")], [[2, ""], [3, "var y = 1"]], key);
  }
});

test("showBlob returns the file at a ref, or null when absent", () => {
  const { root, base } = makeRepo({ base: { "a.go": "package a\n" }, head: { "a.go": null } });
  assert.equal(showBlob(root, base, "a.go"), "package a\n");
  assert.equal(showBlob(root, "HEAD", "a.go"), null);
});
