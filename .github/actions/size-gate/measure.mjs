// Physical line counts for in-scope files (LAB-7587), ported from guard#9602.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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

const posix = (p) => p.split(path.sep).join("/");
const outside = (rel) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

// A directory link exposes every file under it at a new name, so each file
// in scope under either name must be a listed in-scope file itself (B1).
function dirProblem(top, real, link, listed) {
  for (const e of readdirSync(real, { recursive: true, withFileTypes: true })) {
    const abs = path.join(e.parentPath, e.name);
    const shown = posix(path.relative(top, abs));
    if (e.isSymbolicLink()) return `a directory holding the symlink \`${shown}\``;
    if (!e.isFile()) continue;
    const exposed = inScope(`${link}/${posix(path.relative(real, abs))}`) || inScope(shown);
    if (exposed && !(inScope(shown) && listed.has(shown))) return `a directory exposing \`${shown}\`, which is not an in-scope file`;
  }
  return null;
}

// Why a symlink hides code, or null. A link of any name to a directory is
// checked; a file link only under an in-scope name.
function linkProblem(top, abs, p, listed) {
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return inScope(p) ? "a path that does not exist" : null;
  }
  const rel = path.relative(top, real);
  if (lstatSync(real).isDirectory()) return outside(rel) ? "a directory outside the checkout" : dirProblem(top, real, p, listed);
  if (!inScope(p)) return null;
  if (outside(rel)) return "a path outside the checkout";
  const shown = posix(rel);
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
const DIR_RULE = "a directory symlink must stay inside the checkout and expose only in-scope files that are checked on their own";

// measureTree skips symlinks, so a link could hide code: a file link passes
// only when its target is a listed in-scope file, measured on its own; a
// directory link only when every in-scope file under it is.
export function symlinkErrors(root, paths) {
  const listed = new Set(paths);
  const top = realpathSync(root);
  const errors = [];
  for (const p of listed) {
    if (!isLink(root, p)) continue;
    const why = linkProblem(top, path.join(root, p), p, listed);
    const rule = why?.startsWith("a directory") ? DIR_RULE : LINK_RULE;
    if (why) errors.push({ file: p, msg: `is a symlink to ${why}; ${rule}.` });
  }
  return errors;
}
