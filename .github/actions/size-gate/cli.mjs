#!/usr/bin/env node
// Size gate CLI (LAB-7587).
//
//   node cli.mjs check    --root <repo>   file and function limits, baseline ratchet
//   node cli.mjs baseline --root <repo>   regenerate the baseline file
//
// Shared flags: --baseline <file> (default .github/size-baseline.json),
// --include <glob>..., --exclude <glob>..., --min-scanned <n>. The workflow
// passes the same values as SIZE_GATE_* environment variables.
import { FILE_MAX, parseConfig, pathspecs, UsageError } from "./config.mjs";
import { listFiles, readDiff, resolveBase } from "./git.mjs";
import { measureTree, symlinkErrors } from "./measure.mjs";
import { baseLengths, readBaseBaseline, readBaseline, writeBaseline } from "./baseline.mjs";
import { checkFiles } from "./files-check.mjs";
import { checkFunctions } from "./functions-check.mjs";
import { escapeData, report } from "./report.mjs";

const log = (m) => console.log(m);

// Measure the scope and refuse a walk too small to be real (a vacuous pass).
function measure(cfg, paths) {
  const loc = measureTree(cfg.root, paths);
  if (loc.size < cfg.minScanned)
    throw new Error(`size gate scanned ${loc.size} files; expected ≥ ${cfg.minScanned} — the scope is wrong`);
  return loc;
}

function runBaseline(cfg) {
  const n = writeBaseline(cfg.root, cfg.baselinePath, measure(cfg, listFiles(cfg.root, pathspecs(cfg.include, cfg.exclude))));
  log(`wrote ${cfg.baselinePath}: ${n} files over ${FILE_MAX} lines`);
  return 0;
}

function runCheck(cfg, env) {
  const specs = pathspecs(cfg.include, cfg.exclude);
  const base = resolveBase(cfg.root, cfg.base, log, cfg.defaultBranch, cfg.pullRequest);
  const paths = listFiles(cfg.root, specs);
  const loc = measure(cfg, paths);
  const diff = readDiff(cfg.root, base, specs);
  let baseline = readBaseline(cfg.root, cfg.baselinePath);
  if (baseline === null) {
    log(`::notice::${cfg.baselinePath} does not exist; checking against an empty baseline.`);
    baseline = {};
  }
  const baseBaseline = readBaseBaseline(cfg.root, base, cfg.baselinePath);
  const baseLines = baseBaseline ? undefined : baseLengths(cfg.root, base, baseline, diff.renames);
  const files = checkFiles({ root: cfg.root, base, loc, diff, baseline, baseBaseline, baseLines, baselinePath: cfg.baselinePath });
  const fns = checkFunctions({ root: cfg.root, base, diff, goExtractor: cfg.goExtractor });
  const errors = [...symlinkErrors(cfg.root, paths, listFiles(cfg.root, []), specs), ...files.errors, ...fns.errors];
  const warnings = [...files.warnings, ...fns.warnings];
  report({ errors, warnings, base, scanned: loc.size, baselined: Object.keys(baseline).length, env, log });
  return errors.length ? 1 : 0;
}

function main(argv, env) {
  let cfg;
  try {
    cfg = parseConfig(argv, env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    return 2;
  }
  try {
    return cfg.mode === "baseline" ? runBaseline(cfg) : runCheck(cfg, env);
  } catch (e) {
    log(`::error::${escapeData(e.message)}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2), process.env);
