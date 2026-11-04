// Legacy baselines are accepted for callers that still pass one. Their shape
// is validated, but entries no longer decide whether source length fails CI.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FILE_MAX } from "./config.mjs";
import { showBlob } from "./git.mjs";

// Every measured file over the limit, sorted by path.
export const oversized = (loc) =>
  Object.fromEntries([...loc].filter(([, n]) => n > FILE_MAX).sort(([a], [b]) => (a < b ? -1 : 1)));

// Invalid input still fails the check rather than silently hiding bad data.
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
