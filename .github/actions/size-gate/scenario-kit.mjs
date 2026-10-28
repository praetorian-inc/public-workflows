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
