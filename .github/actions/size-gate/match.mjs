// Cross-file function matching within one directory and language (LAB-7587,
// plan §5.3 steps 4-7). Pure: no I/O.
import path from "node:path";
import { language } from "./scope.mjs";

// .ts and .tsx are one language for matching; Go and Python stand alone.
const family = (file) => (language(file) === "tsx" ? "ts" : language(file));
const keyOf = (file, name) => `${path.posix.dirname(file)}::${family(file)}::${name}`;

// base: [{ file, functions }] for every changed base-side file.
// head: [{ file, origin, functions }]; origin is the same path (M) or the
// rename source (R), null for an added file.
// Returns one entry per HEAD function:
//   { file, fn, kind: "exact"|"moved"|"new"|"ambiguous"|"shared"|"copy", base?, others? }
export function matchFunctions(base, head) {
  const byFile = new Map(base.map((b) => [b.file, new Map(b.functions.map((f) => [f.name, f]))]));
  const pool = new Map();
  for (const b of base)
    for (const f of b.functions) {
      const k = keyOf(b.file, f.name);
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push({ file: b.file, fn: f });
    }
  const out = [];
  for (const h of head)
    for (const fn of h.functions) out.push(matchOne(h, fn, byFile, pool));
  return guardClaims(out);
}

function matchOne(h, fn, byFile, pool) {
  const exact = h.origin && byFile.get(h.origin)?.get(fn.name);
  if (exact) return { file: h.file, fn, kind: "exact", base: { file: h.origin, fn: exact } };
  const candidates = (pool.get(keyOf(h.file, fn.name)) ?? []).filter((c) => c.file !== h.origin);
  if (candidates.length === 0) return { file: h.file, fn, kind: "new" };
  if (candidates.length === 1) return { file: h.file, fn, kind: "moved", base: candidates[0] };
  return { file: h.file, fn, kind: "ambiguous", others: candidates.map((c) => c.file) };
}

// Every base function has at most one claimant (plan §5.3 step 5c). An exact
// in-place match is a claim: it keeps the allowance, and any pool-matched copy
// is a "copy", checked as new. With no exact claim, two or more pool claims
// are all "shared", so copy-paste never hands out a second allowance.
function guardClaims(matches) {
  const held = new Set(matches.filter((m) => m.kind === "exact").map((m) => m.base.fn));
  const claims = new Map();
  for (const m of matches) {
    if (m.kind !== "moved") continue;
    if (held.has(m.base.fn)) {
      m.kind = "copy";
      continue;
    }
    if (!claims.has(m.base.fn)) claims.set(m.base.fn, []);
    claims.get(m.base.fn).push(m);
  }
  for (const group of claims.values()) {
    if (group.length < 2) continue;
    for (const m of group) {
      m.kind = "shared";
      m.others = group.filter((o) => o !== m).map((o) => o.file);
    }
  }
  return matches;
}
