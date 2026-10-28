// The function rule (LAB-7587, plan §5.3): a function over its limit fails
// unless it is unchanged, or it was already over its limit at the merge-base
// (here or in a sibling file it moved from) and did not grow.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMPONENT_MAX, FUNCTION_MAX } from "./config.mjs";
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
      const text = showBlob(root, base, s.from);
      if (measured(s.from, text)) old.push({ file: s.from, text });
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
      writeFileSync(b.abs, b.text);
    });
    const out = extractAll([...head, ...old].map((x) => x.abs), goExtractor);
    for (const x of [...head, ...old]) Object.assign(x, out.get(x.abs));
    for (const x of [...head, ...old]) for (const f of x.functions) f.text = body(x.file, x.text, f);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const AMBIGUOUS = "the match is ambiguous, so it is checked as a new function";
const NO_GROWTH = "an over-limit function may change but not grow";

// A function over its own limit at the merge-base may not grow, whatever its
// HEAD limit: gaining JSX does not raise a grandfathered function's allowance.
function grandfathered(m, n, x) {
  const nb = len(m.base.fn);
  if (n <= nb) return null;
  const was = `${nb} lines at the merge-base and is now ${n}; ${NO_GROWTH}`;
  return m.kind === "moved" ? `${x} moved from ${tick(m.base.file)}; it was ${was}` : `${x} was ${was}`;
}

// The failure message for one match, or null when it passes.
function verdict(m) {
  const h = m.fn;
  const [n, lim, x] = [len(h), limit(h), tick(h.name)];
  const matched = m.kind === "exact" || m.kind === "moved";
  if (matched && len(m.base.fn) > limit(m.base.fn)) return grandfathered(m, n, x);
  if (n <= lim) return null;
  if (m.kind === "new") return `new function ${x} is ${n} lines; the limit is ${lim}`;
  if (m.kind === "ambiguous") return `${x} (${n} lines; the limit is ${lim}) matches base functions in ${list(m.others)}; ${AMBIGUOUS}`;
  if (m.kind === "shared")
    return `${x} (${n} lines; the limit is ${lim}) claims the same base function in ${tick(m.base.file)} as ${list(m.others)}; ${AMBIGUOUS}`;
  if (m.kind === "copy")
    return `${x} in ${tick(m.file)} matches the base function ${tick(m.base.fn.name)} in ${tick(m.base.file)}, which ${tick(m.base.file)} still holds in place; a copy does not inherit its allowance, so it is checked as a new function`;
  const b = m.base.fn;
  if (b.text === h.text) return null;
  const nb = len(b);
  return n > nb ? `${x} grew to ${n} lines; the limit is ${lim}` : `${x} is now ${n} lines; the limit is ${lim}`;
}

// { errors, warnings }, each a list of { file, line?, msg }.
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
  for (const m of matchFunctions(s.old, s.head.filter((h) => !h.error))) {
    const msg = verdict(m);
    if (msg) errors.push({ file: m.file, line: m.fn.start, msg });
  }
  return { errors, warnings };
}
