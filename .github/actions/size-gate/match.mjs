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
  for (const h of head) {
    // A rename source is the origin only within one directory and language.
    const at = sameHome(h.origin, h.file) ? h : { ...h, origin: null };
    for (const fn of h.functions) out.push(matchOne(at, fn, byFile, pool));
  }
  return guardClaims(out);
}

const sameHome = (a, b) => a !== null && keyOf(a, "") === keyOf(b, "");

// An ordinal is not an identity: a function whose name occurs more than once
// in its file, at the merge-base or HEAD, keeps an allowance only with a body
// unchanged from a same-named base function in its origin file; otherwise its
// match is ambiguous and it is checked as new.
function matchOne(h, fn, byFile, pool) {
  const m = byName(h, fn, byFile, pool);
  if (!(fn.dup || m.base?.fn.dup) || m.base?.fn.text === fn.text) return m;
  const bare = (f) => f.dup ?? f.name;
  const twin = [...(byFile.get(h.origin)?.values() ?? [])].find((b) => bare(b) === bare(fn) && b.text === fn.text);
  if (twin) return { file: h.file, fn, kind: "exact", base: { file: h.origin, fn: twin } };
  return m.base ? { file: h.file, fn, kind: "ambiguous", others: [m.base.file] } : m;
}

function byName(h, fn, byFile, pool) {
  const exact = h.origin && byFile.get(h.origin)?.get(fn.name);
  if (exact) return { file: h.file, fn, kind: "exact", base: { file: h.origin, fn: exact } };
  const candidates = (pool.get(keyOf(h.file, fn.name)) ?? []).filter((c) => c.file !== h.origin);
  if (candidates.length === 0) return { file: h.file, fn, kind: "new" };
  if (candidates.length === 1) return { file: h.file, fn, kind: "moved", base: candidates[0] };
  return { file: h.file, fn, kind: "ambiguous", others: candidates.map((c) => c.file) };
}

// Every base function has at most one claimant (plan §5.3 step 5c). An exact
// in-place match is a claim: it keeps the allowance, and any later exact or
// pool-matched copy is a "copy", checked as new. With no exact claim, two or more pool claims
// are all "shared", so copy-paste never hands out a second allowance.
function guardClaims(matches) {
  const held = new Set();
  for (const m of matches.filter((m) => m.kind === "exact")) {
    if (held.has(m.base.fn)) m.kind = "copy";
    held.add(m.base.fn);
  }
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
