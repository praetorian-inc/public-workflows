// The single drift comment (LAB-7596). Pure functions: the workflow's post step
// finds the existing comment and writes whatever body this returns. All text
// from the PR, the instruction files and the drafting model is untrusted, so it
// only ever lands inside code spans or fences.
import { HIGH, JEV_MODEL, MIDDLE } from "./questions.mjs";

export const MARKER = "## Instruction-File Drift Detection";
export const MAX_CHARS = 65000;
const DRAFT_CAP = 4000;
const STATE = /<!-- agents-md-drift-state:([A-Za-z0-9+/=]*) -->/;
const NOTICE_TAG = "<!-- agents-md-drift-notice -->";

const longestRun = (s) => Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
export const code = (s) => {
  const t = String(s).replace(/\s*\n\s*/g, " ");
  const tick = "`".repeat(longestRun(t) + 1);
  return /^`|`$/.test(t) ? `${tick} ${t} ${tick}` : `${tick}${t}${tick}`;
};
export const fenced = (s) => {
  const f = "`".repeat(Math.max(3, longestRun(s) + 1));
  return `${f}text\n${s}\n${f}`;
};
const conf = (n) => n.toFixed(2);
const keyOf = (agents_md, heading) => JSON.stringify([agents_md, heading]);

// High-band pairs grouped into one finding per instruction-file section,
// highest confidence first; ids f1..fn are what the drafting model answers to.
export function findingsOf(scored) {
  const byKey = new Map();
  for (const p of scored.filter((s) => s.band === "high")) {
    const k = keyOf(p.agents_md, p.heading);
    const f = byKey.get(k) ?? { key: k, agents_md: p.agents_md, heading: p.heading, section: p.section, confidence: 0, files: [] };
    f.confidence = Math.max(f.confidence, p.score);
    if (!f.files.includes(p.file)) f.files.push(p.file);
    byKey.set(k, f);
  }
  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence).map((f, i) => ({ id: `f${i + 1}`, ...f }));
}

export const middleOf = (scored) => scored.filter((s) => s.band === "middle").sort((a, b) => b.score - a.score);

export function parseState(body) {
  const m = STATE.exec(body ?? "");
  try {
    const s = m && JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    return s && typeof s.findings === "object" && s.findings ? s : { findings: {} };
  } catch {
    return { findings: {} };
  }
}

// Drafts the model returned, by finding id; null when the output is unusable.
export function parseDrafts(raw) {
  try {
    const o = JSON.parse(raw);
    if (!Array.isArray(o?.drafts)) return null;
    return new Map(o.drafts.filter((d) => typeof d?.id === "string" && typeof d?.draft === "string").map((d) => [d.id, d.draft]));
  } catch {
    return null;
  }
}

// Current high findings are open. A previously open finding that is no longer
// high is resolved at this sha, text kept, unless the pair cap left it unchecked.
export function nextState(prev, findings, drafts, overflow, sha) {
  const out = {};
  const unchecked = (f) => overflow.some((o) => o.agents_md === f.agents_md && f.files.includes(o.file));
  for (const [k, f] of Object.entries(prev.findings)) {
    if (f.status === "open" && !unchecked(f)) out[k] = { ...f, status: "resolved", resolved_at: sha };
    else out[k] = f;
  }
  for (const f of findings) {
    const draft = (drafts?.get(f.id) ?? "").slice(0, DRAFT_CAP);
    out[f.key] = { agents_md: f.agents_md, heading: f.heading, files: f.files, confidence: f.confidence, draft, status: "open" };
  }
  return { findings: out };
}

function findingText(f) {
  const lines = [`Confidence ${conf(f.confidence)}. Changed: ${f.files.map(code).join(", ")}.`];
  if (f.draft) lines.push("", "Proposed edit (drafted by an LLM; review before applying):", "", fenced(f.draft));
  else lines.push("", "No proposed edit was drafted for this finding.");
  return lines.join("\n");
}

const more = (n) => (n > 0 ? [`- …and ${n} more (the job summary lists them all).`] : []);
const middleLine = (p) => `- ${code(p.file)} → ${code(p.agents_md)} § ${code(p.heading)}: confidence ${conf(p.score)}`;
const overflowLine = (o) => `- ${code(o.file)} × ${code(o.agents_md)}: ${o.sections} section(s)`;

function renderBody({ state, middle, overflow, sha, limit }) {
  const all = Object.values(state.findings);
  const open = all.filter((f) => f.status === "open");
  const resolved = all.filter((f) => f.status === "resolved");
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
  const out = [MARKER, `<!-- agents-md-drift-state:${encoded} -->`, "", `Checked at ${sha}.`, "", "### Drift findings", ""];
  if (open.length === 0) out.push("No findings outstanding.", "");
  for (const f of open) out.push(`#### ${code(f.agents_md)} § ${code(f.heading)}`, "", findingText(f), "");
  if (middle.length) {
    out.push("### Needs a human ruling", "", "JEV was unsure about these pairs. They never fail the check.", "");
    out.push(...middle.slice(0, limit).map(middleLine), ...more(middle.length - limit), "");
  }
  if (resolved.length) {
    out.push("### Resolved", "");
    for (const f of resolved) {
      out.push(`- ${code(f.agents_md)} § ${code(f.heading)}: Resolved at ${f.resolved_at}`, "");
      out.push("<details><summary>Original finding</summary>", "", findingText(f), "", "</details>", "");
    }
  }
  if (overflow.length) {
    out.push("### Not checked (pair cap)", "", "These pairs were over the per-PR cap and were not sent to JEV.", "");
    out.push(...overflow.slice(0, limit).map(overflowLine), ...more(overflow.length - limit), "");
  }
  out.push("---", `*Automated drift check: JEV ${JEV_MODEL} decides (finding at confidence ≥ ${conf(HIGH)}, human ruling at ≥ ${conf(MIDDLE)}); an LLM only drafts the edit.*`);
  return out.join("\n");
}

// Shrink the lists until the body fits GitHub's comment limit.
export function render(args) {
  for (const limit of [Infinity, 100, 20, 0]) {
    const body = renderBody({ ...args, limit });
    if (body.length <= MAX_CHARS) return body;
  }
  const note = "\n\n---\n*Drift report truncated to fit the GitHub comment size limit.*";
  return renderBody({ ...args, limit: 0 }).slice(0, MAX_CHARS - note.length) + note;
}

// The previous body with a one-line notice after the state block, replacing an
// older notice. null when there is no previous comment: a notice alone never
// creates one.
export function withNotice(previous, text) {
  if (!previous) return null;
  const lines = previous.split("\n").filter((l) => !l.startsWith(NOTICE_TAG));
  const at = lines.findIndex((l) => STATE.test(l));
  lines.splice(at >= 0 ? at + 1 : 1, 0, "", `${NOTICE_TAG}> **Notice:** ${text}`);
  return lines.join("\n").slice(0, MAX_CHARS);
}

// { body } to write, or { body: null } when no comment should be written.
export function decide({ previous, scored, overflow, drafts, sha }) {
  const state = nextState(parseState(previous), findingsOf(scored), drafts, overflow, sha);
  const middle = middleOf(scored);
  const open = Object.values(state.findings).some((f) => f.status === "open");
  if (!previous && !open && middle.length === 0 && overflow.length === 0) return { body: null };
  return { body: render({ state, middle, overflow, sha }) };
}

// The full lists, for $GITHUB_STEP_SUMMARY.
export function summary({ scored, overflow }) {
  const f = findingsOf(scored);
  const m = middleOf(scored);
  return [
    "## Instruction-file drift",
    "",
    `${scored.length} pair(s) scored: ${f.length} finding(s), ${m.length} needing a human ruling, ${overflow.length} file × instruction-file group(s) not checked (pair cap).`,
    "",
    ...f.map((x) => `- finding ${code(x.agents_md)} § ${code(x.heading)}: ${conf(x.confidence)}`),
    ...m.map(middleLine),
    ...overflow.map(overflowLine),
    "",
  ].join("\n");
}
