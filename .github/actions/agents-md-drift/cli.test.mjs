import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "./cli.mjs";

const KEY = "sk-test-secret-value";

function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), "drift-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  const put = (p, s) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), s);
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  put("AGENTS.md", "## Handlers\nEvery handler is listed: a.\n## Style\ns\n");
  put("a.go", "a\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  put("b.go", "b\n");
  g("add", "-A");
  g("commit", "-qm", "head");
  const head = g("rev-parse", "HEAD");
  const out = path.join(root, "out.txt");
  writeFileSync(out, "");
  const env = {
    ROOT: root, WORK_DIR: path.join(root, ".agents-md-drift"), GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
    BASE_SHA: base, HEAD_SHA: head, SKIP_EXTENSIONS: ".md", PAYLOAD_FILE: path.join(root, "payload.json"), PREVIOUS_FILE: path.join(root, "previous.md"),
  };
  const outputs = () => Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const logs = [];
  const run = (cmd, extra = {}, fetchImpl) => {
    writeFileSync(out, "");
    return main([cmd], { ...env, ...extra }, { log: (s) => logs.push(s), fetchImpl });
  };
  return { root, env, outputs, logs, run };
}

// JEV says the Handlers section is stale for b.go and Style is not.
const jev = async (_url, init) => {
  const { state } = JSON.parse(init.body);
  const v = state.section_at_head.startsWith("## Handlers") ? 0.9 : 0.05;
  return { ok: true, status: 200, json: async () => ({ answers: { stale: { noul: v } } }) };
};

test("pairs → score → render posts one finding with its draft", async (t) => {
  const s = setup(t);
  await s.run("pairs", { MAX_PAIRS: "2000" });
  assert.deepEqual(s.outputs(), { status: "ok", count: "2" });
  await s.run("score", { TYPESAFE_JEV_API_KEY: KEY }, jev);
  assert.deepEqual(s.outputs(), { jev: "ok", high: "1" });
  const findings = JSON.parse(readFileSync(path.join(s.env.WORK_DIR, "findings.json"), "utf8"));
  assert.deepEqual(findings.map((f) => [f.id, f.heading, f.files]), [["f1", "Handlers", ["b.go"]]]);
  assert.match(findings[0].diffs["b.go"], /\+b/);
  assert.match(readFileSync(s.env.GITHUB_STEP_SUMMARY, "utf8"), /2 pair\(s\) scored: 1 finding/);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", STRUCTURED_OUTPUT: '{"drafts":[{"id":"f1","draft":"Every handler is listed: a, b."}]}' });
  assert.deepEqual(s.outputs(), { action: "write" });
  const { body } = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8"));
  assert.match(body, /Every handler is listed: a, b\./);
  assert.ok(!s.logs.join("\n").includes(KEY));
});

test("no key: score is unavailable; render leaves no new comment and notices", async (t) => {
  const s = setup(t);
  await s.run("pairs");
  await s.run("score", { TYPESAFE_JEV_API_KEY: "" }, jev);
  assert.deepEqual(s.outputs(), { jev: "unavailable" });
  assert.match(readFileSync(s.env.GITHUB_STEP_SUMMARY, "utf8"), /JEV was unavailable/);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "unavailable" });
  assert.deepEqual(s.outputs(), { action: "none" });
  assert.equal(existsSync(s.env.PAYLOAD_FILE), false);
  assert.ok(s.logs.some((l) => l.startsWith("::notice title=Instruction-file drift: JEV unavailable::")));
});

test("JEV unavailable with an existing comment: notice in place, findings untouched", async (t) => {
  const s = setup(t);
  await s.run("pairs");
  await s.run("score", { TYPESAFE_JEV_API_KEY: KEY }, jev);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", STRUCTURED_OUTPUT: "" });
  const first = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body;
  assert.ok(s.logs.some((l) => l.startsWith("::warning title=Instruction-file drift: no drafts::")));
  writeFileSync(s.env.PREVIOUS_FILE, first);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "" });
  const second = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body;
  assert.match(second, /Notice:\*\* JEV was unavailable at [0-9a-f]+; findings were not rechecked\./);
  assert.match(second, /#### `AGENTS\.md` § `Handlers`/);
  assert.doesNotMatch(second, /Resolved at/);
});

test("pairs: a git failure or a bad max_pairs is a notice and status unavailable", async (t) => {
  const s = setup(t);
  await s.run("pairs", { BASE_SHA: "0000000" });
  assert.deepEqual(s.outputs(), { status: "unavailable" });
  await s.run("pairs", { MAX_PAIRS: "-1" });
  assert.deepEqual(s.outputs(), { status: "unavailable" });
  assert.equal(s.logs.filter((l) => l.startsWith("::notice title=Instruction-file drift: not checked::")).length, 2);
});

test("pairs: only skipped files changed is none; the cap overflows into the comment", async (t) => {
  const s = setup(t);
  await s.run("pairs", { SKIP_EXTENSIONS: ".md,.go" });
  assert.deepEqual(s.outputs(), { status: "none", count: "0" });
  await s.run("pairs", { MAX_PAIRS: "1" });
  assert.deepEqual(s.outputs(), { status: "ok", count: "1" });
  const { overflow } = JSON.parse(readFileSync(path.join(s.env.WORK_DIR, "pairs.json"), "utf8"));
  assert.deepEqual(overflow, [{ file: "b.go", agents_md: "AGENTS.md", sections: 1 }]);
});

test("a later push that reverts the code: pairs is none and render resolves, or writes nothing", async (t) => {
  const s = setup(t);
  await s.run("pairs");
  await s.run("score", { TYPESAFE_JEV_API_KEY: KEY }, jev);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", STRUCTURED_OUTPUT: "" });
  const first = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body;
  const g = (...a) => execFileSync("git", a, { cwd: s.root, encoding: "utf8" }).trim();
  g("rm", "-q", "b.go");
  g("commit", "-qm", "revert");
  const revert = g("rev-parse", "HEAD");
  await s.run("pairs", { HEAD_SHA: revert });
  assert.deepEqual(s.outputs(), { status: "none", count: "0" });
  writeFileSync(s.env.PREVIOUS_FILE, first);
  await s.run("render", { PAIRS_STATUS: "none", HEAD_SHA: revert });
  const body = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body;
  assert.match(body, /No findings outstanding\./);
  assert.match(body, new RegExp(`Resolved at ${revert}`));
  rmSync(s.env.PREVIOUS_FILE);
  rmSync(s.env.PAYLOAD_FILE);
  await s.run("render", { PAIRS_STATUS: "none", HEAD_SHA: revert });
  assert.deepEqual(s.outputs(), { action: "none" });
  assert.equal(existsSync(s.env.PAYLOAD_FILE), false);
});
