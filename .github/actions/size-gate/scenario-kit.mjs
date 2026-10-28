// Test fixtures for the size gate (LAB-7587): throwaway git repositories and
// generated source text, so no 301-line fixture file is ever committed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate fixture repos from the user's git config and hooks.
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

export const run = (root, ...args) =>
  execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();

export function initRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "size-gate-"));
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "commit.gpgsign", "false");
  return root;
}

// Write (string) or delete (null) each path; does not stage.
export function write(root, files) {
  for (const [p, text] of Object.entries(files)) {
    const abs = path.join(root, p);
    if (text === null) rmSync(abs, { force: true });
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  }
}

// Write, stage everything and commit; returns the new commit's sha.
export function commit(root, files, msg = "c") {
  write(root, files);
  run(root, "add", "-A");
  run(root, "commit", "-q", "--allow-empty", "-m", msg);
  return run(root, "rev-parse", "HEAD");
}

// base commit, then head commit; `untracked` files are written after head.
export function makeRepo({ base = {}, head = {}, untracked = {} }) {
  const root = initRepo();
  const baseSha = commit(root, base, "base");
  const headSha = commit(root, head, "head");
  write(root, untracked);
  return { root, base: baseSha, head: headSha };
}

export const EXT = { go: "go", ts: "ts", tsx: "tsx", py: "py" };
export const LANGS = Object.keys(EXT);
const COMMENT = { go: "//", ts: "//", tsx: "//", py: "#" };
const lines = (arr) => arr.join("\n") + "\n";

// An n-line source file with no functions: a header, then comment filler.
export function file(lang, n, header) {
  const first = header ?? (lang === "go" ? "package p" : `${COMMENT[lang]} file`);
  return lines([first, ...Array.from({ length: n - 1 }, (_, i) => `${COMMENT[lang]} filler ${i}`)]);
}

// A function of exactly n lines (first to last line). `tok` varies the body
// text so an edit at the same length is still a change.
export function fn(lang, name, n, tok = "0") {
  if (lang === "py") return [`def ${name}():`, ...Array(n - 1).fill(`    x = ${tok}`)];
  if (lang === "go") {
    const dot = name.indexOf(".");
    const sig = dot < 0 ? `func ${name}() {` : `func (r *${name.slice(0, dot)}) ${name.slice(dot + 1)}() {`;
    return [sig, ...Array(n - 2).fill(`\t_ = ${tok}`), "}"];
  }
  return [`function ${name}() {`, ...Array(n - 2).fill(`  x += ${tok};`), "}"];
}

// A TSX component of exactly n lines; its JSX makes the 150-line limit apply.
export const component = (name, n, tok = "0") =>
  [`function ${name}() {`, ...Array(n - 3).fill(`  x += ${tok};`), "  return <div />;", "}"];

// A source file holding the given functions (arrays of lines from fn()).
export function source(lang, ...fns) {
  const head = lang === "go" ? ["package p", "", "type T struct{}", ""] : lang === "py" ? [] : ["let x = 0;", ""];
  return lines([...head, ...fns.flatMap((f) => [...f, ""])]);
}

const CLI = new URL("./cli.mjs", import.meta.url).pathname;

// Run the CLI in a fixture repo without the runner's own GITHUB_* outputs.
export function runCli(root, args, env = {}) {
  const clean = Object.fromEntries(Object.entries(GIT_ENV).filter(([k]) => !/^(GITHUB_|SIZE_GATE_)/.test(k)));
  try {
    const out = execFileSync("node", [CLI, ...args, "--root", root], { env: { ...clean, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

// `check` against the repo's base commit.
export const check = (repo, env = {}, args = []) => runCli(repo.root, ["check", ...args], { SIZE_GATE_BASE: repo.base, ...env });

export const baselineJson = (files) => JSON.stringify({ limit: 300, generatedBy: "test", files }, null, 2) + "\n";
