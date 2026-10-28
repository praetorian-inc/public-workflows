// The size baseline: grandfathered files over the limit, and the ratchet that
// lets it only shrink (LAB-7587). Ported from guard#9602's check().
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FILE_MAX } from "./config.mjs";
import { showBlob } from "./git.mjs";
import { lineCount } from "./measure.mjs";

// Every measured file over the limit, sorted by path.
export const oversized = (loc) =>
  Object.fromEntries([...loc].filter(([, n]) => n > FILE_MAX).sort(([a], [b]) => (a < b ? -1 : 1)));

// A non-number entry would make every ratchet comparison false and let the
// file grow, so the whole map is checked before use; a throw fails the gate.
function validated(files, where) {
  if (typeof files !== "object" || files === null || Array.isArray(files))
    throw new Error(`${where}: "files" must be an object of path to line count`);
  for (const [p, n] of Object.entries(files))
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error(`${where}: entry ${JSON.stringify(p)} is ${JSON.stringify(n)}; it must be a non-negative integer line count`);
  return files;
}

function filesOf(text, where) {
  let files;
  try {
    files = JSON.parse(text).files;
  } catch (e) {
    throw new Error(`cannot read ${where}: ${e.message}`);
  }
  return validated(files === undefined ? {} : files, where);
}

// The working-tree baseline, or null when the file does not exist.
export function readBaseline(root, baselinePath) {
  let text;
  try {
    text = readFileSync(path.join(root, baselinePath), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`cannot read ${baselinePath}: ${e.message}`);
  }
  return filesOf(text, baselinePath);
}

// The baseline at a commit, or null when it does not exist there yet.
export function readBaseBaseline(root, ref, baselinePath) {
  const text = showBlob(root, ref, baselinePath);
  return text === null ? null : filesOf(text, `${ref}:${baselinePath}`);
}

// With no baseline at the merge-base, the merge-base files bound a new one:
// each entry's file length there, keyed by its merge-base path.
export function baseLengths(root, ref, baseline, renames) {
  const out = {};
  for (const p of Object.keys(baseline)) {
    const from = renames.get(p) ?? p;
    const text = showBlob(root, ref, from);
    if (text !== null) out[from] = lineCount(text);
  }
  return out;
}

export function writeBaseline(root, baselinePath, loc) {
  const files = oversized(loc);
  const body = { limit: FILE_MAX, generatedBy: "node .github/actions/size-gate/cli.mjs baseline", files };
  mkdirSync(path.dirname(path.join(root, baselinePath)), { recursive: true });
  writeFileSync(path.join(root, baselinePath), JSON.stringify(body, null, 2) + "\n");
  return Object.keys(files).length;
}

// One entry against the tree: gone, back under the limit, grown or shrunk.
function entryError(n, entry, B) {
  if (n === undefined) return `is listed in ${B} but no longer exists or is out of scope. Remove the entry.`;
  if (n <= FILE_MAX) return `is now ${n} lines, within the ${FILE_MAX}-line limit. Remove its entry from ${B}.`;
  if (n > entry) return `grew to ${n} lines; ${B} allows ${entry}. Baselined files may not grow.`;
  if (n < entry) return `shrank to ${n} lines. Lower its ${B} entry from ${entry} to ${n} in this PR.`;
  return null;
}

// No exception for drift on main: when two PRs combine into a file over
// its entry, the fix is to shrink the file or revert, never to raise it.
function shrinkError(was, entry, B) {
  if (was === undefined) return `was added to ${B}; the baseline can only shrink.`;
  return entry > was ? `${B} entry rose from ${was} to ${entry}; the baseline can only shrink.` : null;
}

// A first baseline cannot grandfather a new file or one grown since the merge-base.
function firstError(was, entry, B) {
  if (was === undefined) return `did not exist at the merge-base, which has no ${B}; a new file cannot be baselined.`;
  if (entry > was) return `${B} allows ${entry} lines but it was ${was} at the merge-base, which has no ${B}; a baseline entry cannot exceed it.`;
  return null;
}

// Ratchet failures for every baseline entry, as [path, message] pairs.
// baseLines (from baseLengths) applies only when baseBaseline is null.
export function ratchet({ loc, baseline, baseBaseline, renames, baselinePath: B, baseLines }) {
  const out = [];
  for (const [p, entry] of Object.entries(baseline)) {
    const err = entryError(loc.get(p), entry, B);
    if (err) out.push([p, err]);
    const at = (m) => m[renames.get(p) ?? p] ?? m[p];
    const base = baseBaseline ? shrinkError(at(baseBaseline), entry, B) : baseLines && firstError(at(baseLines), entry, B);
    if (base) out.push([p, base]);
  }
  return out;
}
