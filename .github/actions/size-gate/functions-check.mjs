// Changed functions over their advisory threshold warn, including growth of
// functions already over the threshold at the merge-base. Parse and disable-
// comment checks still fail.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMPONENT_MAX, FUNCTION_MAX } from "./config.mjs";
import { bannedLines } from "./disable-ban.mjs";
import { extractAll } from "./extract.mjs";
import { showBlob } from "./git.mjs";
import { matchFunctions } from "./match.mjs";
import { readRegular, splitLines } from "./measure.mjs";
import { exemptByText, inScope, language } from "./scope.mjs";

const limit = (f) => (f.isComponent ? COMPONENT_MAX : FUNCTION_MAX);
const len = (f) => f.end - f.start + 1;
// The function's lines, split as its parser numbered them.
const body = (p, text, f) => splitLines(p, text).slice(f.start - 1, f.end).join("\n");
const tick = (s) => `\`${s}\``;
const list = (files) => {
  const t = files.map(tick);
  return t.length < 2 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
};
const measured = (p, text) => text !== null && language(p) && inScope(p) && !exemptByText(p, text);

// The changed files on each side: HEAD for A/M/R, the merge-base blob for M/R/D.
function sides(root, base, diff) {
  const head = [];
  const old = [];
  for (const [p, s] of diff.status) {
    if (s.code !== "D") {
      const text = readRegular(root, p);
      if (measured(p, text)) head.push({ file: p, origin: s.code === "A" ? null : s.from, text });
    }
    if (s.code !== "A") {
      // The extractor reads the original bytes, as it does a HEAD file.
      const bytes = showBlob(root, base, s.from, "buffer");
      const text = bytes?.toString("utf8") ?? null;
      if (measured(s.from, text)) old.push({ file: s.from, text, bytes });
    }
  }
  return { head, old };
}

// Extract both sides in one batch per language; base blobs go to temp files.
function extractSides(root, { head, old }, goExtractor) {
  const tmp = mkdtempSync(path.join(tmpdir(), "size-gate-base-"));
  try {
    head.forEach((h) => (h.abs = path.join(root, h.file)));
    old.forEach((b, i) => {
      b.abs = path.join(tmp, `${i}${path.extname(b.file)}`);
      writeFileSync(b.abs, b.bytes);
    });
    const out = extractAll([...head, ...old].map((x) => x.abs), goExtractor);
    for (const x of [...head, ...old]) Object.assign(x, out.get(x.abs));
    for (const x of [...head, ...old]) for (const f of x.functions) f.text = body(x.file, x.text, f);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const AMBIGUOUS = "the match is ambiguous, so it is checked as a new function";

// Growth of a previously over-limit function remains visible even when gaining
// JSX raises its current threshold above its new length.
function grandfathered(m, n, x, lim) {
  const nb = len(m.base.fn);
  const from = m.kind === "moved" ? `${x} moved from ${tick(m.base.file)};` : x;
  if (n > nb) return `${from} grew from ${nb} to ${n} lines; advisory threshold ${lim}.`;
  if (n > lim && m.base.fn.text !== m.fn.text) return `${from} changed at ${n} lines; advisory threshold ${lim}.`;
  return null;
}

// The advisory message for one match, or null when unchanged/within limits.
function verdict(m) {
  const h = m.fn;
  const [n, lim, x] = [len(h), limit(h), tick(h.name)];
  const matched = m.kind === "exact" || m.kind === "moved";
  if (matched && len(m.base.fn) > limit(m.base.fn)) return grandfathered(m, n, x, lim);
  if (n <= lim) return null;
  if (m.kind === "new") return `new function ${x} is ${n} lines; the limit is ${lim}`;
  if (m.kind === "ambiguous") return `${x} (${n} lines; the limit is ${lim}) matches base functions in ${list(m.others)}; ${AMBIGUOUS}`;
  if (m.kind === "shared")
    return `${x} (${n} lines; the limit is ${lim}) claims the same base function in ${tick(m.base.file)} as ${list(m.others)}; ${AMBIGUOUS}`;
  if (m.kind === "copy")
    return `${x} in ${tick(m.file)} matches the base function ${tick(m.base.fn.name)} in ${tick(m.base.file)}, which ${tick(m.base.file)} still holds in place; the copy exceeds the ${lim}-line advisory threshold`;
  const b = m.base.fn;
  if (b.text === h.text) return null;
  const nb = len(b);
  return n > nb ? `${x} grew to ${n} lines; the limit is ${lim}` : `${x} is now ${n} lines; the limit is ${lim}`;
}

// Added lines that disable a size lint, read from each HEAD file's parsed
// comments. A file that does not parse already fails with "cannot parse".
function banErrors(head, diff) {
  const errors = [];
  for (const h of head) {
    const added = diff.added.get(h.file);
    if (h.error || !added) continue;
    for (const line of bannedLines(added, h.comments, h.file, h.text))
      errors.push({ file: h.file, line, msg: "adds a size-lint disable comment; remove it so advisory warnings remain visible." });
  }
  return errors;
}

// { errors, warnings }, each a list of { file, line?, msg, review? }.
export function checkFunctions({ root, base, diff, goExtractor }) {
  const s = sides(root, base, diff);
  const errors = [];
  const warnings = [];
  if (s.head.length === 0) return { errors, warnings };
  extractSides(root, s, goExtractor);
  for (const b of s.old.filter((b) => b.error))
    warnings.push({ file: b.file, msg: `did not parse at the merge-base (${b.error}); its functions are checked as new.` });
  for (const h of s.head.filter((h) => h.error))
    errors.push({ file: h.file, msg: `cannot parse: ${h.error}. Fix the syntax or exclude the path.` });
  errors.push(...banErrors(s.head, diff));
  for (const m of matchFunctions(s.old, s.head.filter((h) => !h.error))) {
    const msg = verdict(m);
    if (msg) warnings.push({ file: m.file, line: m.fn.start, msg, review: true });
  }
  return { errors, warnings };
}
