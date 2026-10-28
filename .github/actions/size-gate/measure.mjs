// Physical line counts for in-scope files (LAB-7587), ported from guard#9602.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { exemptByText, inScope, language } from "./scope.mjs";

// Line breaks as each parser numbers them, so counts match its positions:
// go/scanner \n only; Python ast \n, \r\n, \r; TypeScript adds U+2028/9.
const TS_BREAK = /\r\n|[\r\n\u2028\u2029]/;
const BREAK = { go: /\n/, py: /\r\n|\r|\n/, ts: TS_BREAK, tsx: TS_BREAK };

export const splitLines = (p, t) => t.split(BREAK[language(p)] ?? /\n/);

// A last line without a trailing break still counts.
export function lineCount(p, t) {
  const parts = splitLines(p, t);
  return parts.length - (parts.length > 1 && parts.at(-1) === "" ? 1 : 0);
}

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
    if (text !== null && !exemptByText(p, text)) loc.set(p, lineCount(p, text));
  }
  return loc;
}

// Why a symlink's target is not a listed in-scope file in the checkout, or null.
function linkProblem(top, abs, listed) {
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return "a path that does not exist";
  }
  const rel = path.relative(top, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return "a path outside the checkout";
  const shown = rel.split(path.sep).join("/");
  if (!lstatSync(real).isFile() || !inScope(shown) || !listed.has(shown)) return `\`${shown}\`, which is not an in-scope file`;
  return null;
}

const isLink = (root, p) => {
  try {
    return lstatSync(path.join(root, p)).isSymbolicLink();
  } catch {
    return false;
  }
};

const LINK_RULE = "an in-scope symlink must resolve to an in-scope file inside the checkout, which is then checked on its own";

// measureTree skips symlinks, so an in-scope one could hide code: it passes
// only when its target is itself a listed in-scope file, measured on its own.
export function symlinkErrors(root, paths) {
  const listed = new Set(paths);
  const top = realpathSync(root);
  const errors = [];
  for (const p of listed) {
    if (!inScope(p) || !isLink(root, p)) continue;
    const why = linkProblem(top, path.join(root, p), listed);
    if (why) errors.push({ file: p, msg: `is a symlink to ${why}; ${LINK_RULE}.` });
  }
  return errors;
}
