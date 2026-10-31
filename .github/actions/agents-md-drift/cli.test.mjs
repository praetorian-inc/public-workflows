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
  // The runner's temp directory, outside the (untrusted) checkout.
  const runnerTemp = mkdtempSync(path.join(tmpdir(), "drift-runner-temp-"));
  t.after(() => rmSync(runnerTemp, { recursive: true, force: true }));
  const work = path.join(runnerTemp, "agents-md-drift");
  const env = {
    ROOT: root, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
    BASE_SHA: base, HEAD_SHA: head, SKIP_EXTENSIONS: ".md", PAYLOAD_FILE: path.join(root, "payload.json"), PREVIOUS_FILE: path.join(root, "previous.md"),
  };
  const outputs = () => Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const logs = [];
  const run = (cmd, extra = {}, fetchImpl) => {
    writeFileSync(out, "");
    return main([cmd], { ...env, ...extra }, { log: (s) => logs.push(s), fetchImpl });
  };
  return { root, work, env, outputs, logs, run };
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
  const findings = JSON.parse(readFileSync(path.join(s.work, "findings.json"), "utf8"));
  assert.deepEqual(findings.map((f) => [f.id, f.heading, f.files]), [["f1", "Handlers", ["b.go"]]]);
  assert.match(findings[0].diffs["b.go"], /\+b/);
  assert.match(readFileSync(s.env.GITHUB_STEP_SUMMARY, "utf8"), /2 pair\(s\) scored: 1 finding/);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", STRUCTURED_OUTPUT: '{"drafts":[{"id":"f1","draft":"Every handler is listed: a, b."}]}' });
  assert.deepEqual(s.outputs(), { action: "write" });
  const { body } = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8"));
  assert.match(body, /Every handler is listed: a, b\./);
  assert.ok(!s.logs.join("\n").includes(KEY));
});

// The work files live under $RUNNER_TEMP, never in the PR checkout the steps
// run from, so a PR cannot plant or redirect them.
test("work files live under RUNNER_TEMP, and a work dir planted in the checkout is ignored", async (t) => {
  const s = setup(t);
  const cwd = process.cwd();
  process.chdir(s.root);
  t.after(() => process.chdir(cwd));
  const planted = path.join(s.root, ".agents-md-drift");
  mkdirSync(planted);
  const decoy = { scored: [{ id: "p1", file: "x.go", agents_md: "AGENTS.md", heading: "Planted", section: "## Planted", score: 0.99, band: "high" }], overflow: [] };
  writeFileSync(path.join(planted, "scored.json"), JSON.stringify(decoy));
  await s.run("pairs");
  assert.equal(existsSync(path.join(s.work, "pairs.json")), true);
  assert.equal(existsSync(path.join(planted, "pairs.json")), false);
  await s.run("score", { TYPESAFE_JEV_API_KEY: KEY }, jev);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", STRUCTURED_OUTPUT: "" });
  const { body } = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8"));
  assert.match(body, /`Handlers`/);
  assert.doesNotMatch(body, /Planted/);
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

test("a pairs step that never finished: render notices and only annotates an existing comment", async (t) => {
  const s = setup(t);
  await s.run("render", { PAIRS_STATUS: "" });
  assert.deepEqual(s.outputs(), { action: "none" });
  assert.equal(existsSync(s.env.PAYLOAD_FILE), false);
  assert.ok(s.logs.some((l) => l.startsWith("::notice title=Instruction-file drift: not checked::the drift-pairs step did not finish")));
  assert.match(readFileSync(s.env.GITHUB_STEP_SUMMARY, "utf8"), /drift-pairs step did not finish/);
  await s.run("pairs");
  await s.run("score", { TYPESAFE_JEV_API_KEY: KEY }, jev);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", STRUCTURED_OUTPUT: "" });
  writeFileSync(s.env.PREVIOUS_FILE, JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body);
  for (const status of ["", "unavailable"]) {
    await s.run("render", { PAIRS_STATUS: status });
    const body = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body;
    assert.match(body, /Notice:\*\* candidate pairs were not computed at [0-9a-f]+; findings were not rechecked\./);
    assert.match(body, /#### `AGENTS\.md` § `Handlers`/);
    assert.doesNotMatch(body, /Resolved at/);
  }
});

test("score with every pair over the cap needs no key and lists the overflow", async (t) => {
  const s = setup(t);
  await s.run("pairs", { MAX_PAIRS: "0" });
  assert.deepEqual(s.outputs(), { status: "ok", count: "0" });
  await s.run("score", {});
  assert.deepEqual(s.outputs(), { jev: "ok", high: "0" });
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", STRUCTURED_OUTPUT: "" });
  assert.match(JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body, /### Not checked \(pair cap\)\n[\s\S]*`b\.go` × `AGENTS\.md`: 2 section\(s\)/);
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
  const { overflow } = JSON.parse(readFileSync(path.join(s.work, "pairs.json"), "utf8"));
  assert.deepEqual(overflow, [{ file: "b.go", agents_md: "AGENTS.md", sections: 1 }]);
});

test("pairs: a sectionless instruction file keeps the run on ok so its findings stay open", async (t) => {
  const s = setup(t);
  await s.run("pairs");
  await s.run("score", { TYPESAFE_JEV_API_KEY: KEY }, jev);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", STRUCTURED_OUTPUT: "" });
  const first = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body;
  const g = (...a) => execFileSync("git", a, { cwd: s.root, encoding: "utf8" }).trim();
  writeFileSync(path.join(s.root, "AGENTS.md"), "# Title\nOnly a preamble.\n");
  writeFileSync(path.join(s.root, "c.go"), "c\n");
  g("add", "-A");
  g("commit", "-qm", "flatten");
  const next = g("rev-parse", "HEAD");
  await s.run("pairs", { HEAD_SHA: next });
  assert.deepEqual(s.outputs(), { status: "ok", count: "0" });
  await s.run("score", { TYPESAFE_JEV_API_KEY: KEY }, jev);
  writeFileSync(s.env.PREVIOUS_FILE, first);
  await s.run("render", { PAIRS_STATUS: "ok", JEV_STATUS: "ok", HEAD_SHA: next, STRUCTURED_OUTPUT: "" });
  const body = JSON.parse(readFileSync(s.env.PAYLOAD_FILE, "utf8")).body;
  assert.match(body, /§ `Handlers`/);
  assert.doesNotMatch(body, /Resolved at/);
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
