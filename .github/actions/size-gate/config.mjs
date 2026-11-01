// Limits and run configuration for the size gate (LAB-7587). Flags win over the
// environment, which is how the reusable workflow passes its inputs.
import path from "node:path";
import { parseArgs } from "node:util";

export const FILE_MAX = 500;
export const FILE_WARN = 400;
export const FUNCTION_MAX = 50;
export const COMPONENT_MAX = 150;
export const DEFAULT_BASELINE = ".github/size-baseline.json";

export class UsageError extends Error {}

const MODES = new Set(["check", "baseline"]);
// Every flag takes a value; --include and --exclude repeat. node:util parseArgs
// was chosen over a dependency (LAB-7699).
const OPTIONS = {
  root: { type: "string" },
  baseline: { type: "string" },
  include: { type: "string", multiple: true },
  exclude: { type: "string", multiple: true },
  "min-scanned": { type: "string" },
};

// Newline-separated list input; blank lines dropped, whitespace trimmed.
const list = (s) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

function count(raw, name) {
  if (!/^\d+$/.test(String(raw).trim())) throw new UsageError(`${name} must be a whole number, got '${raw}'`);
  return Number(raw);
}

export function parseConfig(argv, env) {
  const [mode, ...rest] = argv;
  if (!MODES.has(mode)) throw new UsageError("usage: cli.mjs check|baseline [--root dir] [--baseline file] [--include glob]... [--exclude glob]... [--min-scanned n]");
  let f;
  try {
    f = parseArgs({ args: rest, options: OPTIONS, strict: true }).values;
  } catch (e) {
    if (String(e.code).startsWith("ERR_PARSE_ARGS_")) throw new UsageError(e.message);
    throw e;
  }
  return {
    mode,
    root: path.resolve(f.root ?? "."),
    baselinePath: f.baseline ?? (env.SIZE_GATE_BASELINE || DEFAULT_BASELINE),
    include: f.include ?? list(env.SIZE_GATE_INCLUDE),
    exclude: f.exclude ?? list(env.SIZE_GATE_EXCLUDE),
    minScanned: count(f["min-scanned"] ?? (env.SIZE_GATE_MIN_SCANNED || "1"), "min-scanned-files"),
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
