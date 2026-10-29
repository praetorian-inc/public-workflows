import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKER, MAX_CHARS, code, decide, fenced, findingsOf, parseDrafts, parseState, withNotice } from "./comment.mjs";

const pair = (o) => ({ id: "p1", file: "svc/a.go", agents_md: "svc/AGENTS.md", heading: "Handlers", section: "## Handlers\nx", score: 0.9, band: "high", ...o });
const drafts = (m) => new Map(Object.entries(m));

test("untrusted text stays inside code spans and fences", () => {
  assert.equal(code("a`b"), "``a`b``");
  assert.equal(code("`x"), "`` `x ``");
  assert.equal(code("a\nb"), "`a b`");
  assert.equal(fenced("```\nx"), "````text\n```\nx\n````");
  assert.equal(fenced("x"), "```text\nx\n```");
});

test("high pairs group into one finding per section, highest first", () => {
  const f = findingsOf([
    pair({ file: "a.go", score: 0.85 }),
    pair({ file: "b.go", score: 0.95 }),
    pair({ heading: "Other", score: 0.81 }),
    pair({ heading: "Mid", score: 0.5, band: "middle" }),
  ]);
  assert.deepEqual(f.map((x) => [x.id, x.heading, x.confidence, x.files]), [
    ["f1", "Handlers", 0.95, ["a.go", "b.go"]],
    ["f2", "Other", 0.81, ["svc/a.go"]],
  ]);
});

test("no pairs and no previous comment: nothing is written", () => {
  assert.equal(decide({ previous: "", scored: [pair({ band: "low", score: 0.1 })], overflow: [], drafts: null, sha: "h1" }).body, null);
});

test("a high finding is posted with its draft, the middle band listed, nothing fails", () => {
  const { body } = decide({
    previous: "",
    scored: [pair({}), pair({ id: "p2", file: "b.go", heading: "Mid", score: 0.4, band: "middle" })],
    overflow: [],
    drafts: drafts({ f1: "Replace X with Y." }),
    sha: "h1",
  });
  assert.ok(body.startsWith(`${MARKER}\n<!-- agents-md-drift-state:`));
  assert.match(body, /### Drift findings\n\n#### `svc\/AGENTS\.md` § `Handlers`/);
  assert.match(body, /Confidence 0\.90\. Changed: `svc\/a\.go`\./);
  assert.match(body, /```text\nReplace X with Y\.\n```/);
  assert.match(body, /### Needs a human ruling[\s\S]*- `b\.go` → `svc\/AGENTS\.md` § `Mid`: confidence 0\.40/);
  assert.doesNotMatch(body, /### Resolved/);
});

test("a later push resolves a finding that is no longer high, keeping its text", () => {
  const first = decide({ previous: "", scored: [pair({})], overflow: [], drafts: drafts({ f1: "Fix it." }), sha: "h1" }).body;
  const second = decide({ previous: first, scored: [pair({ score: 0.3, band: "middle" })], overflow: [], drafts: null, sha: "h2" }).body;
  assert.match(second, /### Drift findings\n\nNo findings outstanding\./);
  assert.match(second, /### Resolved\n\n- `svc\/AGENTS\.md` § `Handlers`: Resolved at h2/);
  assert.match(second, /<details><summary>Original finding<\/summary>[\s\S]*Fix it\./);
  const state = parseState(second);
  assert.equal(Object.values(state.findings)[0].status, "resolved");
  // Back to high: open again, not resolved.
  const third = decide({ previous: second, scored: [pair({})], overflow: [], drafts: drafts({ f1: "Again." }), sha: "h3" }).body;
  assert.doesNotMatch(third, /### Resolved/);
  assert.match(third, /Again\./);
});

test("a previous finding the pair cap left unchecked stays open", () => {
  const first = decide({ previous: "", scored: [pair({})], overflow: [], drafts: null, sha: "h1" }).body;
  const overflow = [{ file: "svc/a.go", agents_md: "svc/AGENTS.md", sections: 3 }];
  const second = decide({ previous: first, scored: [], overflow, drafts: null, sha: "h2" }).body;
  assert.match(second, /#### `svc\/AGENTS\.md` § `Handlers`/);
  assert.doesNotMatch(second, /Resolved at/);
  assert.match(second, /### Not checked \(pair cap\)[\s\S]*- `svc\/a\.go` × `svc\/AGENTS\.md`: 3 section\(s\)/);
});

test("overflow alone creates the comment so no pair is dropped silently", () => {
  const { body } = decide({ previous: "", scored: [], overflow: [{ file: "x", agents_md: "AGENTS.md", sections: 1 }], drafts: null, sha: "h1" });
  assert.match(body, /No findings outstanding\.[\s\S]*### Not checked \(pair cap\)/);
});

test("a garbage or foreign state block is ignored", () => {
  assert.deepEqual(parseState("## x\n<!-- agents-md-drift-state:!!! -->"), { findings: {} });
  assert.deepEqual(parseState(`<!-- agents-md-drift-state:${Buffer.from("[1]").toString("base64")} -->`), { findings: {} });
  assert.deepEqual(parseState(undefined), { findings: {} });
});

test("parseDrafts accepts only the schema", () => {
  assert.equal(parseDrafts("nope"), null);
  assert.equal(parseDrafts('{"x":1}'), null);
  assert.deepEqual([...parseDrafts('{"drafts":[{"id":"f1","draft":"d"},{"id":2}]}')], [["f1", "d"]]);
});

test("the body fits the GitHub limit by shortening lists", () => {
  const scored = Array.from({ length: 3000 }, (_, i) => pair({ id: `p${i}`, file: `f${i}.go`, heading: `H${i}`, score: 0.5, band: "middle" }));
  const { body } = decide({ previous: "", scored, overflow: [], drafts: null, sha: "h1" });
  assert.ok(body.length <= MAX_CHARS);
  assert.match(body, /…and \d+ more \(the job summary lists them all\)\./);
});

test("withNotice updates an existing body in place and never creates one", () => {
  assert.equal(withNotice("", "JEV down"), null);
  const body = decide({ previous: "", scored: [pair({})], overflow: [], drafts: null, sha: "h1" }).body;
  const once = withNotice(body, "JEV was unavailable at h2");
  const twice = withNotice(once, "JEV was unavailable at h3");
  assert.equal((twice.match(/Notice:/g) ?? []).length, 1);
  assert.match(twice, /JEV was unavailable at h3/);
  assert.deepEqual(parseState(twice), parseState(body));
  assert.ok(twice.startsWith(MARKER));
});
