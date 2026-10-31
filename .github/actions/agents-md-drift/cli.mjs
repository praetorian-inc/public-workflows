// Entry point for the drift workflow's steps (LAB-7596):
//   node cli.mjs pairs   build candidate pairs   (BASE_SHA, HEAD_SHA, SKIP_EXTENSIONS, MAX_PAIRS)
//   node cli.mjs score   ask JEV about them      (TYPESAFE_JEV_API_KEY)
//   node cli.mjs render  the comment body        (PAIRS_STATUS, JEV_STATUS, HEAD_SHA, STRUCTURED_OUTPUT,
//                                                 PREVIOUS_FILE, PAYLOAD_FILE)
// Each step reads and writes files in $RUNNER_TEMP/agents-md-drift and
// step outputs in $GITHUB_OUTPUT. Nothing here fails the check: every failure
// is a notice and a pass.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { escapeData } from "../size-gate/report.mjs";
import { decide, findingsOf, parseDrafts, summary, withNotice } from "./comment.mjs";
import { CONCURRENCY, scorePairs } from "./jev.mjs";
import { buildPairs } from "./pairs.mjs";
import { REQUESTS } from "./questions.mjs";

const DEFAULT_MAX_PAIRS = 2000;

// The steps run from the PR's checkout, which the PR controls, so the work files
// live in the runner's temp directory where a PR cannot plant or redirect them.
// Every step of the job sees the same RUNNER_TEMP.
const workDir = (env) => path.join(env.RUNNER_TEMP || tmpdir(), "agents-md-drift");

function io(env, log) {
  const dir = workDir(env);
  const file = (n) => path.join(dir, n);
  return {
    log,
    file,
    read: (n) => JSON.parse(readFileSync(file(n), "utf8")),
    write: (n, v) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(n), JSON.stringify(v));
    },
    output: (k, v) => (env.GITHUB_OUTPUT ? appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`) : log(`${k}=${v}`)),
    summary: (s) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${s}\n`),
    notice: (title, msg) => log(`::notice title=${title}::${escapeData(msg)}`),
    warning: (title, msg) => log(`::warning title=${title}::${escapeData(msg)}`),
  };
}

function pairsCmd(env, x) {
  const maxPairs = env.MAX_PAIRS ? Number(env.MAX_PAIRS) : DEFAULT_MAX_PAIRS;
  if (!Number.isInteger(maxPairs) || maxPairs < 0) {
    x.notice("Instruction-file drift: not checked", `max_pairs must be a non-negative integer, got '${env.MAX_PAIRS}'.`);
    return x.output("status", "unavailable");
  }
  let built;
  try {
    const skipList = (env.SKIP_EXTENSIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    built = buildPairs({ root: env.ROOT || ".", base: env.BASE_SHA, head: env.HEAD_SHA, skipList, maxPairs });
  } catch (e) {
    x.notice("Instruction-file drift: not checked", `the pre-filter could not compute candidate pairs (${e.message.split("\n")[0]}); passing.`);
    return x.output("status", "unavailable");
  }
  x.write("pairs.json", built);
  if (built.sectionless.length) {
    const list = built.sectionless.join(", ");
    x.notice("Instruction-file drift: not checked", `no ## or ### section to pair in ${list}; changes those files govern were not checked against them.`);
    x.summary(`Instruction-file drift: not checked against ${list} (no ## or ### section).`);
  }
  const status = built.pairs.length || built.overflow.length ? "ok" : "none";
  x.output("status", status);
  x.output("count", built.pairs.length);
  const requests = built.pairs.length * REQUESTS.length;
  x.log(`${built.pairs.length} candidate pair(s), ${built.overflow.length} group(s) over the cap; ${requests} JEV request(s) at ${CONCURRENCY} concurrent.`);
}

async function scoreCmd(env, x, fetchImpl) {
  const { diffs, pairs, overflow } = x.read("pairs.json");
  const started = Date.now();
  const res = await scorePairs({ pairs, diffs, key: env.TYPESAFE_JEV_API_KEY, fetchImpl });
  if (!res.ok) {
    x.summary(`Instruction-file drift: JEV was unavailable (${res.reason}); drift was not checked.`);
    return x.output("jev", "unavailable");
  }
  x.log(`Scored ${pairs.length} pair(s) in ${Math.round((Date.now() - started) / 1000)}s.`);
  const scored = res.scored.map(({ answers, ...p }) => p);
  x.write("scored.json", { scored, overflow });
  const findings = findingsOf(scored).map((f) => ({ id: f.id, agents_md: f.agents_md, heading: f.heading, section: f.section, files: f.files, diffs: Object.fromEntries(f.files.map((n) => [n, diffs[n]])) }));
  x.write("findings.json", findings);
  x.summary(summary({ scored, overflow }));
  x.output("jev", "ok");
  x.output("high", findings.length);
}

function renderCmd(env, x) {
  const previous = env.PREVIOUS_FILE && existsSync(env.PREVIOUS_FILE) ? readFileSync(env.PREVIOUS_FILE, "utf8") : "";
  const sha = env.HEAD_SHA;
  let body;
  if (env.PAIRS_STATUS === "none") {
    body = decide({ previous, scored: [], overflow: [], drafts: null, sha }).body;
  } else if (env.JEV_STATUS === "ok") {
    const { scored, overflow } = x.read("scored.json");
    const expected = findingsOf(scored).length > 0;
    const drafts = expected ? parseDrafts(env.STRUCTURED_OUTPUT ?? "") : null;
    if (expected && !drafts) x.warning("Instruction-file drift: no drafts", "the drafting step returned no usable output; findings are posted without a proposed edit.");
    body = decide({ previous, scored, overflow, drafts, sha }).body;
  } else if (env.PAIRS_STATUS !== "ok") {
    // "unavailable" was already noticed by the pairs step with its reason; an
    // empty status means that step never finished (a crash or its timeout).
    if (!env.PAIRS_STATUS) {
      x.notice("Instruction-file drift: not checked", `the drift-pairs step did not finish at ${sha}; drift was not checked and existing findings were left as they were. Passing.`);
      x.summary("Instruction-file drift: the drift-pairs step did not finish; drift was not checked.");
    }
    body = withNotice(previous, `candidate pairs were not computed at ${sha}; findings were not rechecked.`);
  } else {
    x.notice("Instruction-file drift: JEV unavailable", `JEV was unavailable at ${sha}; drift was not checked and existing findings were left as they were. Passing.`);
    body = withNotice(previous, `JEV was unavailable at ${sha}; findings were not rechecked.`);
  }
  if (body) writeFileSync(env.PAYLOAD_FILE, JSON.stringify({ body }));
  x.output("action", body ? "write" : "none");
}

export async function main(argv, env = process.env, { log = console.log, fetchImpl = fetch } = {}) {
  const x = io(env, log);
  const cmd = argv[0];
  if (cmd === "pairs") return pairsCmd(env, x);
  if (cmd === "score") return scoreCmd(env, x, fetchImpl);
  if (cmd === "render") return renderCmd(env, x);
  throw new Error(`usage: cli.mjs pairs|score|render (got '${cmd}')`);
}

// Compare real paths: node resolves symlinks for import.meta.url but not for argv[1].
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
