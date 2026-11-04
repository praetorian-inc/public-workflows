// Length warnings report changed source on pull requests and pushes; structural
// symlink errors still cover only touched paths on PRs (LAB-7704).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { EXT, LANGS, baselineJson as bj, check, commit, file, initRepo, makeRepo, run } from "./scenario-kit.mjs";

const B = ".github/size-baseline.json";
const PR = { GITHUB_EVENT_NAME: "pull_request" };
const PUSH = { GITHUB_EVENT_NAME: "push" };
const repo = (lang, base, head) => makeRepo({ base: { [`keep.${EXT[lang]}`]: file(lang, 3), ...base }, head });
const NOTICE = /::notice::pull_request: symlink and generated-header errors are limited to files this PR touches/;

for (const lang of LANGS) {
  const [p, q] = [`d/a.${EXT[lang]}`, `d/b.${EXT[lang]}`];
  const edit = { [`keep.${EXT[lang]}`]: file(lang, 4) };

  test(`${lang} P1: an untouched over-limit file is not attributed to this PR or push`, () => {
    const r = repo(lang, { [p]: file(lang, 600) }, edit);
    const pr = check(r, PR);
    assert.equal(pr.code, 0, pr.out);
    assert.match(pr.out, NOTICE);
    const push = check(r, PUSH);
    assert.equal(push.code, 0, push.out);
    assert.doesNotMatch(push.out, new RegExp(`::warning file=${p}`));
  });

  test(`${lang} P2: an untouched legacy entry cannot create a length failure`, () => {
    const r = repo(lang, { [p]: file(lang, 605), [B]: bj({ [p]: 600 }) }, edit);
    assert.equal(check(r, PR).code, 0);
    const push = check(r, PUSH);
    assert.equal(push.code, 0, push.out);
    assert.doesNotMatch(push.out, /::warning file=/);
  });

  test(`${lang} P3: a file the PR touches is still checked`, () => {
    const grown = check(repo(lang, { [p]: file(lang, 600), [B]: bj({ [p]: 600 }) }, { [p]: file(lang, 605) }), PR);
    assert.equal(grown.code, 0, grown.out);
    assert.match(grown.out, new RegExp(`::warning file=${p}::${p} is 605 lines`));
    const unbaselined = check(repo(lang, { [p]: file(lang, 550) }, { [p]: file(lang, 560) }), PR);
    assert.equal(unbaselined.code, 0, unbaselined.out);
    assert.match(unbaselined.out, new RegExp(`${p} is 560 lines, over the 400-line advisory threshold`));
    const fresh = check(repo(lang, {}, { [q]: file(lang, 501) }), PR);
    assert.equal(fresh.code, 0, fresh.out);
    assert.match(fresh.out, /::warning file=.*is 501 lines/);
  });
}

test("P4: changing a legacy baseline entry does not block or warn on unchanged source", () => {
  const base = { "keep.go": file("go", 3), "d/a.go": file("go", 600), [B]: bj({ "d/a.go": 600 }) };
  const raised = check(makeRepo({ base, head: { [B]: bj({ "d/a.go": 610 }) } }), PR);
  assert.equal(raised.code, 0, raised.out);
  assert.doesNotMatch(raised.out, /::warning file=/);
  const dropped = check(makeRepo({ base, head: { [B]: bj({}) } }), PR);
  assert.equal(dropped.code, 0, dropped.out);
  assert.doesNotMatch(dropped.out, /::warning file=/);
});

test("P5: stale legacy entries and deleted files do not cause length failures", () => {
  const base = { "keep.go": file("go", 3), "d/a.go": file("go", 600), [B]: bj({ "d/a.go": 600, "gone.go": 700 }) };
  const r = makeRepo({ base, head: { "keep.go": file("go", 4) } });
  assert.equal(check(r, PR).code, 0);
  assert.equal(check(r, PUSH).code, 0);
  const deleted = check(makeRepo({ base, head: { "d/a.go": null } }), PR);
  assert.equal(deleted.code, 0, deleted.out);
  const renamed = check(makeRepo({ base, head: { "d/a.go": null, "d/c.go": file("go", 600) } }), PR);
  assert.equal(renamed.code, 0, renamed.out);
});

test("P6: a bad symlink fails the PR that adds it, not a PR that leaves it alone", () => {
  const root = initRepo();
  commit(root, { "keep.go": file("go", 3) });
  const link = (p, target) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    symlinkSync(target, path.join(root, p));
  };
  link("a.go", "missing.go");
  const base = commit(root, {});
  commit(root, { "keep.go": file("go", 4) });
  assert.equal(check({ root, base }, PR).code, 0);
  assert.equal(check({ root, base }, PUSH).code, 1);
  link("b.go", "missing.go");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "link");
  const added = check({ root, base }, PR);
  assert.equal(added.code, 1);
  assert.match(added.out, /::error file=b\.go::b\.go is a symlink to a path that does not exist/);
  assert.doesNotMatch(added.out, /file=a\.go/);
});

test("P7: a PR that breaks or feeds an untouched link owns its error", () => {
  const setup = () => {
    const root = initRepo();
    mkdirSync(path.join(root, "lib"), { recursive: true });
    symlinkSync("lib/a.go", path.join(root, "a.go"));
    symlinkSync("lib", path.join(root, "vendor"));
    const base = commit(root, { "keep.go": file("go", 3), "lib/a.go": file("go", 3) });
    return { root, base };
  };
  const unrelated = setup();
  commit(unrelated.root, { "keep.go": file("go", 4) });
  assert.equal(check(unrelated, PR).code, 0);
  const deleted = setup();
  commit(deleted.root, { "lib/a.go": null });
  const out = check(deleted, PR);
  assert.equal(out.code, 1);
  assert.match(out.out, /::error file=a\.go::a\.go is a symlink to a path that does not exist/);
  const fed = setup();
  symlinkSync("../keep.go", path.join(fed.root, "lib", "x.go"));
  run(fed.root, "add", "-A");
  run(fed.root, "commit", "-q", "-m", "nested link");
  const exposed = check(fed, PR);
  assert.equal(exposed.code, 1);
  assert.match(exposed.out, /::error file=vendor::vendor is a symlink to a directory holding the symlink/);
});

test("P8: a link through a linked directory follows that directory to its target", () => {
  const root = initRepo();
  mkdirSync(path.join(root, "lib"), { recursive: true });
  symlinkSync("lib", path.join(root, "vendor"));
  symlinkSync("vendor/a.go", path.join(root, "a.go"));
  const base = commit(root, { "keep.go": file("go", 3), "lib/a.go": file("go", 3), "lib/b.go": file("go", 3) });
  commit(root, { "lib/a.go": null });
  const out = check({ root, base }, PR);
  assert.equal(out.code, 1);
  assert.match(out.out, /::error file=a\.go::a\.go is a symlink to a path that does not exist/);
});

test("P9: a link that leaves and re-enters the checkout, or runs through a deleted link, stays the PR's", () => {
  const setup = (target) => {
    const root = initRepo();
    mkdirSync(path.join(root, "lib"), { recursive: true });
    symlinkSync("lib", path.join(root, "vendor"));
    symlinkSync(target(root), path.join(root, "a.go"));
    const base = commit(root, { "keep.go": file("go", 3), "lib/a.go": file("go", 3), "lib/b.go": file("go", 3) });
    return { root, base };
  };
  const reentry = setup((root) => `../${path.basename(root)}/lib/a.go`);
  commit(reentry.root, { "lib/a.go": null });
  const out = check(reentry, PR);
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /::error file=a\.go::a\.go is a symlink to a path that does not exist/);
  const via = setup(() => "vendor/a.go");
  run(via.root, "rm", "-q", "vendor");
  run(via.root, "commit", "-q", "-m", "drop vendor");
  const dropped = check(via, PR);
  assert.equal(dropped.code, 1, dropped.out);
  assert.match(dropped.out, /::error file=a\.go::a\.go is a symlink to a path that does not exist/);
});
