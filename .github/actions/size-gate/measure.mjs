// Physical line counts for in-scope files (LAB-7587), ported from guard#9602.
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { exemptByText, inScope } from "./scope.mjs";

// A last line without a trailing newline still counts.
export const lineCount = (t) => t.split("\n").length - (t.endsWith("\n") ? 1 : 0);

// Read a working-tree file when it is a regular file; null otherwise.
export function readRegular(root, p) {
  let st;
  try {
    st = lstatSync(path.join(root, p));
  } catch {
    return null; // deleted in the working tree
  }
  return st.isFile() ? readFileSync(path.join(root, p), "utf8") : null;
}

// Map of every in-scope, non-generated regular file among `paths` to its length.
export function measureTree(root, paths) {
  const loc = new Map();
  for (const p of new Set(paths)) {
    if (!inScope(p)) continue;
    const text = readRegular(root, p);
    if (text !== null && !exemptByText(p, text)) loc.set(p, lineCount(text));
  }
  return loc;
}
