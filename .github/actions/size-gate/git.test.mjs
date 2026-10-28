// Unit tests for git.mjs against real temporary repositories (LAB-7587).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCommit, listFiles, readDiff, resolveBase, showBlob } from "./git.mjs";
import { commit, initRepo, makeRepo, run } from "./scenario-kit.mjs";

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

test("resolveBase: origin's default branch is the next candidate", () => {
  const root = initRepo();
  const fork = commit(root, { "a.go": "package a\n" });
  run(root, "update-ref", "refs/remotes/origin/main", fork);
  commit(root, { "b.go": "package a\n" });
  commit(root, { "c.go": "package a\n" });
  assert.equal(resolveBase(root, "", () => {}), fork);
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

test("showBlob returns the file at a ref, or null when absent", () => {
  const { root, base } = makeRepo({ base: { "a.go": "package a\n" }, head: { "a.go": null } });
  assert.equal(showBlob(root, base, "a.go"), "package a\n");
  assert.equal(showBlob(root, "HEAD", "a.go"), null);
});
