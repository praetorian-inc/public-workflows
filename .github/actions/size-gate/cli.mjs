#!/usr/bin/env node
// Size gate CLI (LAB-7587).
//
//   node cli.mjs check    --root <repo>   file and function limits, baseline ratchet
//   node cli.mjs baseline --root <repo>   regenerate the baseline file
//
// Shared flags: --baseline <file> (default .github/size-baseline.json),
// --include <glob>..., --exclude <glob>..., --min-scanned <n>. The workflow
// passes the same values as SIZE_GATE_* environment variables.
import { parseConfig, pathspecs, UsageError } from "./config.mjs";
import { listFiles, readDiff, resolveBase } from "./git.mjs";
import { measureTree } from "./measure.mjs";
import { readBaseBaseline, readBaseline, writeBaseline } from "./baseline.mjs";
import { checkFiles } from "./files-check.mjs";
import { escapeData, report } from "./report.mjs";

const log = (m) => console.log(m);

// Measure the scope and refuse a walk too small to be real (a vacuous pass).
function measure(cfg, specs) {
  const loc = measureTree(cfg.root, listFiles(cfg.root, specs));
  if (loc.size < cfg.minScanned)
    throw new Error(`size gate scanned ${loc.size} files; expected ≥ ${cfg.minScanned} — the scope is wrong`);
  return loc;
}

function runBaseline(cfg) {
  const n = writeBaseline(cfg.root, cfg.baselinePath, measure(cfg, pathspecs(cfg.include, cfg.exclude)));
  log(`wrote ${cfg.baselinePath}: ${n} files over 300 lines`);
  return 0;
}

function runCheck(cfg, env) {
  const specs = pathspecs(cfg.include, cfg.exclude);
  const base = resolveBase(cfg.root, cfg.base, log);
  const loc = measure(cfg, specs);
  const diff = readDiff(cfg.root, base, specs);
  let baseline = readBaseline(cfg.root, cfg.baselinePath);
  if (baseline === null) {
    log(`::notice::${cfg.baselinePath} does not exist; checking against an empty baseline.`);
    baseline = {};
  }
  const baseBaseline = readBaseBaseline(cfg.root, base, cfg.baselinePath);
  const { errors, warnings } = checkFiles({ loc, diff, baseline, baseBaseline, baselinePath: cfg.baselinePath });
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
