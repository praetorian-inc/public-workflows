// Limits and run configuration for the size gate (LAB-7587). Flags win over the
// environment, which is how the reusable workflow passes its inputs.
import path from "node:path";

export const FILE_MAX = 300;
export const FILE_WARN = 200;
export const FUNCTION_MAX = 50;
export const COMPONENT_MAX = 150;
export const DEFAULT_BASELINE = ".github/size-baseline.json";

export class UsageError extends Error {}

const MODES = new Set(["check", "baseline"]);
const VALUE_FLAGS = new Set(["--root", "--baseline", "--include", "--exclude", "--min-scanned"]);

// Newline-separated list input; blank lines dropped, whitespace trimmed.
const list = (s) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

function count(raw, name) {
  if (!/^\d+$/.test(String(raw).trim())) throw new UsageError(`${name} must be a whole number, got '${raw}'`);
  return Number(raw);
}

function readFlags(args) {
  const flags = { "--include": [], "--exclude": [] };
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown argument '${flag}'`);
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (Array.isArray(flags[flag])) flags[flag].push(value);
    else flags[flag] = value;
  }
  return flags;
}

export function parseConfig(argv, env) {
  const [mode, ...rest] = argv;
  if (!MODES.has(mode)) throw new UsageError("usage: cli.mjs check|baseline [--root dir] [--baseline file] [--include glob]... [--exclude glob]... [--min-scanned n]");
  const f = readFlags(rest);
  return {
    mode,
    root: path.resolve(f["--root"] ?? "."),
    baselinePath: f["--baseline"] ?? (env.SIZE_GATE_BASELINE || DEFAULT_BASELINE),
    include: f["--include"].length ? f["--include"] : list(env.SIZE_GATE_INCLUDE),
    exclude: f["--exclude"].length ? f["--exclude"] : list(env.SIZE_GATE_EXCLUDE),
    minScanned: count(f["--min-scanned"] ?? (env.SIZE_GATE_MIN_SCANNED || "1"), "min-scanned-files"),
    base: env.SIZE_GATE_BASE || "",
    defaultBranch: env.SIZE_GATE_DEFAULT_BRANCH || "",
    // The runner sets GITHUB_EVENT_NAME to the caller's event in every step.
    pullRequest: env.GITHUB_EVENT_NAME === "pull_request",
    goExtractor: env.SIZE_GATE_GO_EXTRACTOR || "",
  };
}

// git pathspecs for the include and exclude globs; git does the matching.
export const pathspecs = (include, exclude) => [
  ...include.map((g) => `:(glob)${g}`),
  ...exclude.map((g) => `:(exclude,glob)${g}`),
];
