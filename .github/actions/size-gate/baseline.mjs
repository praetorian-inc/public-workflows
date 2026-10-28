// The size baseline: grandfathered files over the limit, and the ratchet that
// lets it only shrink (LAB-7587). Ported from guard#9602's check().
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FILE_MAX } from "./config.mjs";
import { showBlob } from "./git.mjs";

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

// Ratchet failures for every baseline entry, as [path, message] pairs.
export function ratchet({ loc, baseline, baseBaseline, renames, baselinePath: B }) {
  const out = [];
  for (const [p, entry] of Object.entries(baseline)) {
    const err = entryError(loc.get(p), entry, B);
    if (err) out.push([p, err]);
    if (!baseBaseline) continue;
    const was = baseBaseline[renames.get(p) ?? p] ?? baseBaseline[p];
    // No exception for drift on main: when two PRs combine into a file over
    // its entry, the fix is to shrink the file or revert, never to raise it.
    if (was === undefined) out.push([p, `was added to ${B}; the baseline can only shrink.`]);
    else if (entry > was) out.push([p, `${B} entry rose from ${was} to ${entry}; the baseline can only shrink.`]);
  }
  return out;
}
