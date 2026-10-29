// git plumbing for the size gate (LAB-7587), ported from guard#9602. Every call
// is an argv array to the git binary; nothing goes through a shell.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inScope } from "./scope.mjs";
import { escapeData } from "./report.mjs";

export const git = (root, args, opts = {}) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, ...opts });

const z = (out) => out.split("\0").filter(Boolean);

export function isCommit(root, rev) {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function originHead(root) {
  try {
    return git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// refs/remotes/origin/<branch>, or null (with a notice) for an invalid name.
// git validates it; the name only ever travels as one argv entry.
function originBranch(root, branch, log) {
  if (!branch) return null;
  const ref = `refs/remotes/origin/${branch}`;
  try {
    git(root, ["check-ref-format", ref], { stdio: "ignore" });
    return ref;
  } catch {
    log(`::notice::SIZE_GATE_DEFAULT_BRANCH '${escapeData(branch)}' is not a valid branch name; ignoring it.`);
    return null;
  }
}

// The merge-base of HEAD with the first usable candidate: SIZE_GATE_BASE (the
// PR base or the pre-push commit), origin/HEAD, origin/<SIZE_GATE_DEFAULT_BRANCH>,
// origin/main, then HEAD~1. With none, HEAD itself, which checks nothing new.
export function resolveBase(root, envBase, log, defaultBranch = "") {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const mergeBase = (c) => git(root, ["merge-base", c, "HEAD"]).trim();
  const usable = envBase && !/^0+$/.test(envBase) && isCommit(root, envBase);
  // A fallback already at HEAD (origin on a default-branch push) would check nothing; try the next.
  const fallbacks = () => [originHead(root), originBranch(root, defaultBranch, log), "origin/main", "HEAD~1"];
  const name = usable ? envBase : fallbacks().find((c) => c && isCommit(root, c) && mergeBase(c) !== head);
  if (envBase && !usable)
    log(`::notice::SIZE_GATE_BASE '${escapeData(envBase)}' is not a resolvable commit here; comparing with ${name ?? "HEAD"}.`);
  if (!name) {
    log("::warning::No base commit resolves; a HEAD base checks nothing new on this run.");
    return head;
  }
  return mergeBase(name);
}

// Tracked plus untracked (not ignored) paths under the pathspecs.
export const listFiles = (root, specs) =>
  [...new Set(z(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...specs])))];

// The subset of `paths` the pathspecs match, by git's own matching: the paths
// go into a throwaway index, so they need not exist as listed.
export function matchSpecs(root, specs, paths) {
  if (specs.length === 0 || paths.length === 0) return new Set(paths);
  const tmp = mkdtempSync(path.join(tmpdir(), "size-gate-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
  try {
    const blob = git(root, ["hash-object", "--stdin"], { input: "" }).trim();
    const info = paths.map((p) => `100644 ${blob}\t${p}\0`).join("");
    git(root, ["update-index", "-z", "--index-info"], { env, input: info });
    return new Set(z(git(root, ["ls-files", "-z", "--cached", "--", ...specs], { env })));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// path -> { code: A|M|D|R, from }, from `git diff --name-status` against base.
function readStatus(root, base, specs) {
  const status = new Map();
  const out = git(root, ["-c", "core.quotePath=false", "diff", "-M", "--name-status", "-z", base, "--", ...specs]).split("\0");
  for (let i = 0; i < out.length - 1; ) {
    const code = out[i++][0];
    if (code === "R" || code === "C") {
      const [from, to] = [out[i++], out[i++]];
      status.set(to, code === "R" ? { code: "R", from } : { code: "A", from: null });
    } else {
      const p = out[i++];
      status.set(p, { code: code === "A" ? "A" : code === "D" ? "D" : "M", from: code === "A" ? null : p });
    }
  }
  return status;
}

// C escapes git uses in a quoted path; any other escaped character stands for itself.
const C_ESCAPE = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

// Decode a path git C-quoted ("b/we\"ird.ts", octal bytes for control chars).
function unquote(q) {
  const parts = [];
  for (const [, esc, lit] of q.slice(1, -1).matchAll(/\\([0-7]{3}|.)|([^\\]+)/gs)) {
    if (lit !== undefined) parts.push(Buffer.from(lit));
    else parts.push(Buffer.from([/^[0-7]/.test(esc) ? parseInt(esc, 8) : (C_ESCAPE[esc] ?? esc.charCodeAt(0))]));
  }
  return Buffer.concat(parts).toString("utf8");
}

// The path on a "+++ " header line, or null for a deletion. The prefix is
// forced to b/ below; git ends an unquoted name with a tab when it has a space.
function newSidePath(line) {
  const raw = line.slice(4).replace(/\t$/, "");
  if (raw === "/dev/null") return null;
  return (raw.startsWith('"') ? unquote(raw) : raw).slice(2);
}

// Added line numbers per new-side path, from a zero-context patch. Explicit
// prefixes override diff.noprefix and diff.mnemonicPrefix in the repo config;
// --text and --no-textconv keep .gitattributes from hiding or rewriting a hunk.
function readAdded(root, base, specs) {
  const added = new Map();
  const flags = ["-M", "--unified=0", "--text", "--no-textconv", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
  const patch = git(root, ["-c", "core.quotePath=false", "diff", ...flags, base, "--", ...specs]);
  let file = null;
  let line = 0;
  let inHeader = false; // an added line "++ b/x" reads "+++ b/x" inside a hunk
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) [inHeader, file] = [true, null];
    else if (inHeader && l.startsWith("+++ ")) {
      file = newSidePath(l);
      if (file && !added.has(file)) added.set(file, new Map());
    } else if (l.startsWith("@@")) [inHeader, line] = [false, Number(/\+(\d+)/.exec(l)[1])];
    else if (!inHeader && file && l.startsWith("+")) added.get(file).set(line++, l.slice(1));
  }
  return added;
}

// Untracked files never reach `git diff`: every line is added.
function addUntracked(root, specs, added, status) {
  for (const p of z(git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...specs]))) {
    if (!inScope(p)) continue;
    try {
      const lines = readFileSync(path.join(root, p), "utf8").split("\n");
      added.set(p, new Map(lines.map((t, i) => [i + 1, t])));
      status.set(p, { code: "A", from: null });
    } catch {
      /* not a readable file */
    }
  }
}

export function readDiff(root, base, specs) {
  const status = readStatus(root, base, specs);
  const added = readAdded(root, base, specs);
  addUntracked(root, specs, added, status);
  const renames = new Map([...status].filter(([, s]) => s.code === "R").map(([p, s]) => [p, s.from]));
  const atBase = new Set(z(git(root, ["ls-tree", "-r", "-z", "--name-only", base])));
  return { status, added, renames, atBase };
}

// A file's text at a ref, or null when the ref has no such file. Pass
// encoding "buffer" for its raw bytes.
export function showBlob(root, ref, p, encoding = "utf8") {
  try {
    return git(root, ["show", `${ref}:${p}`], { encoding, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
