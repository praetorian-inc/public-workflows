// On a pull request the file rule and the symlink rule report only paths the
// PR touches; a push still checks the whole repository (LAB-7704).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { EXT, LANGS, baselineJson as bj, check, commit, file, initRepo, makeRepo, run } from "./scenario-kit.mjs";

const B = ".github/size-baseline.json";
const PR = { GITHUB_EVENT_NAME: "pull_request" };
const PUSH = { GITHUB_EVENT_NAME: "push" };
const repo = (lang, base, head) => makeRepo({ base: { [`keep.${EXT[lang]}`]: file(lang, 3), ...base }, head });
const NOTICE = /::notice::pull_request: file-size and symlink errors are limited to files this PR touches/;

for (const lang of LANGS) {
  const [p, q] = [`d/a.${EXT[lang]}`, `d/b.${EXT[lang]}`];
  const edit = { [`keep.${EXT[lang]}`]: file(lang, 4) };

  test(`${lang} P1: an untouched unbaselined file over the limit fails a push, not a PR`, () => {
    const r = repo(lang, { [p]: file(lang, 600) }, edit);
    const pr = check(r, PR);
    assert.equal(pr.code, 0, pr.out);
    assert.match(pr.out, NOTICE);
    assert.equal(check(r, PUSH).code, 1);
  });

  test(`${lang} P2: an untouched baselined file past its entry fails a push, not a PR`, () => {
    const r = repo(lang, { [p]: file(lang, 605), [B]: bj({ [p]: 600 }) }, edit);
    assert.equal(check(r, PR).code, 0);
    const push = check(r, PUSH);
    assert.equal(push.code, 1);
    assert.match(push.out, /grew to 605 lines/);
  });

  test(`${lang} P3: a file the PR touches is still checked`, () => {
    const grown = check(repo(lang, { [p]: file(lang, 600), [B]: bj({ [p]: 600 }) }, { [p]: file(lang, 605) }), PR);
    assert.equal(grown.code, 1);
    assert.match(grown.out, /grew to 605 lines/);
    const unbaselined = check(repo(lang, { [p]: file(lang, 550) }, { [p]: file(lang, 560) }), PR);
    assert.equal(unbaselined.code, 1);
    assert.match(unbaselined.out, new RegExp(`${p} is 560 lines and not in`));
    const fresh = check(repo(lang, {}, { [q]: file(lang, 501) }), PR);
    assert.equal(fresh.code, 1);
    assert.match(fresh.out, /new file is 501 lines/);
  });
}

test("P4: a baseline entry the PR changes is checked even when its file is untouched", () => {
  const base = { "keep.go": file("go", 3), "d/a.go": file("go", 600), [B]: bj({ "d/a.go": 600 }) };
  const raised = check(makeRepo({ base, head: { [B]: bj({ "d/a.go": 610 }) } }), PR);
  assert.equal(raised.code, 1);
  assert.match(raised.out, /entry rose from 600 to 610/);
  const dropped = check(makeRepo({ base, head: { [B]: bj({}) } }), PR);
  assert.equal(dropped.code, 1);
  assert.match(dropped.out, /d\/a\.go is 600 lines and not in/);
});

test("P5: a stale entry fails a push, not a PR; deleting or renaming its file is the PR's", () => {
  const base = { "keep.go": file("go", 3), "d/a.go": file("go", 600), [B]: bj({ "d/a.go": 600, "gone.go": 700 }) };
  const r = makeRepo({ base, head: { "keep.go": file("go", 4) } });
  assert.equal(check(r, PR).code, 0);
  assert.match(check(r, PUSH).out, /gone\.go is listed in .* but no longer exists/);
  const deleted = check(makeRepo({ base, head: { "d/a.go": null } }), PR);
  assert.equal(deleted.code, 1);
  assert.match(deleted.out, /d\/a\.go is listed in .* but no longer exists/);
  const renamed = check(makeRepo({ base, head: { "d/a.go": null, "d/c.go": file("go", 600) } }), PR);
  assert.equal(renamed.code, 1);
  assert.match(renamed.out, /d\/a\.go is listed in .* but no longer exists/);
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
