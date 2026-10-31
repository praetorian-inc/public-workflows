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
// A section's identity in its file. The first occurrence of a heading keeps the
// two-element key that comments written before occurrences existed carry.
const keyOf = (agents_md, heading, occurrence = 1) =>
  JSON.stringify(occurrence > 1 ? [agents_md, heading, occurrence] : [agents_md, heading]);
const where = (f) => `${code(f.agents_md)} § ${code(f.heading)}${(f.occurrence ?? 1) > 1 ? ` (occurrence ${f.occurrence})` : ""}`;

// High-band pairs grouped into one finding per instruction-file section,
// highest confidence first; ids f1..fn are what the drafting model answers to.
export function findingsOf(scored) {
  const byKey = new Map();
  for (const p of scored.filter((s) => s.band === "high")) {
    const occurrence = p.occurrence ?? 1;
    const k = keyOf(p.agents_md, p.heading, occurrence);
    const f = byKey.get(k) ?? { key: k, agents_md: p.agents_md, heading: p.heading, occurrence, section: p.section, confidence: 0, files: [] };
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
    out[f.key] = { agents_md: f.agents_md, heading: f.heading, occurrence: f.occurrence, files: f.files, confidence: f.confidence, draft, status: "open" };
  }
  return { findings: out };
}

const SIZE_NOTE = "shortened to fit the GitHub comment size limit";

function findingText(f) {
  const lines = [`Confidence ${conf(f.confidence)}. Changed: ${f.files.map(code).join(", ")}.`];
  if (f.draft) lines.push("", "Proposed edit (drafted by an LLM; review before applying):", "", fenced(f.draft));
  if (f.draft && f.draft_shortened) lines.push("", `*Proposed edit ${SIZE_NOTE}.*`);
  if (!f.draft) lines.push("", f.draft_shortened ? `*Proposed edit dropped: report ${SIZE_NOTE}.*` : "No proposed edit was drafted for this finding.");
  return lines.join("\n");
}

const more = (n) => (n > 0 ? [`- …and ${n} more (the job summary lists them all).`] : []);
const middleLine = (p) => `- ${code(p.file)} → ${where(p)}: confidence ${conf(p.score)}`;
const overflowLine = (o) => `- ${code(o.file)} × ${code(o.agents_md)}: ${o.sections} section(s)`;

function renderBody({ state, middle, overflow, sha, limit, omitted = 0, shrunk = false }) {
  const all = Object.values(state.findings);
  const open = all.filter((f) => f.status === "open");
  const resolved = all.filter((f) => f.status === "resolved");
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
  const out = [MARKER, `<!-- agents-md-drift-state:${encoded} -->`, "", `Checked at ${sha}.`, "", "### Drift findings", ""];
  if (open.length === 0) out.push("No findings outstanding.", "");
  for (const f of open) out.push(`#### ${where(f)}`, "", findingText(f), "");
  if (omitted > 0) out.push(`- …and ${omitted} more finding(s) (the job summary lists them all).`, "");
  if (middle.length) {
    out.push("### Needs a human ruling", "", "JEV was unsure about these pairs. They never fail the check.", "");
    out.push(...middle.slice(0, limit).map(middleLine), ...more(middle.length - limit), "");
  }
  if (resolved.length) {
    out.push("### Resolved", "");
    for (const f of resolved) {
      out.push(`- ${where(f)}: Resolved at ${f.resolved_at}`, "");
      out.push("<details><summary>Original finding</summary>", "", findingText(f), "", "</details>", "");
    }
  }
  if (overflow.length) {
    out.push("### Not checked (pair cap)", "", "These pairs were over the per-PR cap and were not sent to JEV.", "");
    out.push(...overflow.slice(0, limit).map(overflowLine), ...more(overflow.length - limit), "");
  }
  if (shrunk) out.push(`*Drift report ${SIZE_NOTE}.*`, "");
  out.push("---", `*Automated drift check: JEV ${JEV_MODEL} decides (finding at confidence ≥ ${conf(HIGH)}, human ruling at ≥ ${conf(MIDDLE)}); an LLM only drafts the edit.*`);
  return out.join("\n");
}

// Smaller and smaller states for a body over the limit, each whole: resolved
// drafts go first, then resolved findings, then open drafts are shortened and
// dropped, and last the lowest-confidence open findings are left out. The body
// is never cut as text, so the state block and every fence stay intact.
const isOpen = ([, f]) => f.status === "open";
const cut = (n) => ([k, f]) => [k, (f.draft ?? "").length > n ? { ...f, draft: f.draft.slice(0, n), draft_shortened: true } : f];
const STAGES = [
  (e) => e,
  (e) => e.map(([k, f]) => (isOpen([k, f]) ? [k, f] : cut(0)([k, f]))),
  (e) => e.filter(isOpen),
  ...[1000, 250, 0].map((n) => (e) => e.filter(isOpen).map(cut(n))),
  ...[100, 20, 0].map((n) => (e) => e.filter(isOpen).map(cut(0)).sort((a, b) => b[1].confidence - a[1].confidence).slice(0, n)),
];

// The largest version of the report that fits `max` characters.
export function render({ state, max = MAX_CHARS, ...args }) {
  const entries = Object.entries(state.findings);
  const open = entries.filter(isOpen).length;
  let body = "";
  for (const [i, stage] of STAGES.entries()) {
    const kept = stage(entries);
    const shrunk = { findings: Object.fromEntries(kept) };
    for (const limit of [Infinity, 100, 20, 0]) {
      body = renderBody({ ...args, state: shrunk, limit, omitted: open - kept.filter(isOpen).length, shrunk: i > 0 });
      if (body.length <= max) return body;
    }
  }
  return body;
}

// Remove a notice in either shape: the tag on its own line before the quote, or
// the single line (tag then quote) that earlier comments carry, which GitHub
// renders as an HTML block rather than a blockquote. The blank line before it
// goes too, so repeated notices never pile up blank lines.
function withoutNotice(lines) {
  const out = [...lines];
  for (let j = out.length - 1; j >= 0; j--) {
    if (!out[j].startsWith(NOTICE_TAG)) continue;
    const n = out[j] === NOTICE_TAG && out[j + 1]?.startsWith("> **Notice:**") ? 2 : 1;
    const blank = j > 0 && out[j - 1] === "" ? 1 : 0;
    out.splice(j - blank, n + blank);
  }
  return out;
}

// The previous body with a notice after the state block, replacing an older
// notice. A previous body too big to take it is re-rendered from its own state
// rather than cut. null when there is no previous comment: a notice alone never
// creates one.
export function withNotice(previous, text) {
  if (!previous) return null;
  const notice = ["", NOTICE_TAG, `> **Notice:** ${text}`];
  const room = MAX_CHARS - notice.join("\n").length - 1;
  let lines = withoutNotice(previous.split("\n"));
  if (lines.join("\n").length > room) {
    const sha = /^Checked at (.+)\.$/m.exec(previous)?.[1] ?? "an earlier commit";
    lines = render({ state: parseState(previous), middle: [], overflow: [], sha, max: room }).split("\n");
  }
  const at = lines.findIndex((l) => STATE.test(l));
  lines.splice(at >= 0 ? at + 1 : 1, 0, ...notice);
  return lines.join("\n");
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
    ...f.map((x) => `- finding ${where(x)}: ${conf(x.confidence)}`),
    ...m.map(middleLine),
    ...overflow.map(overflowLine),
    "",
  ].join("\n");
}
