// The file rule (LAB-7587): new files over 300 lines fail, unbaselined files
// over 300 fail, the baseline ratchet holds, and added or changed files over
// 200 lines warn. Ported from guard#9602's check().
import { FILE_MAX, FILE_WARN } from "./config.mjs";
import { oversized, ratchet } from "./baseline.mjs";

function unbaselined(loc, baseline, diff, B) {
  const out = [];
  for (const [p, n] of Object.entries(oversized(loc))) {
    if (p in baseline) continue;
    if (!diff.atBase.has(p) && !diff.renames.has(p)) out.push([p, `new file is ${n} lines; the limit is ${FILE_MAX}. Split it.`]);
    else out.push([p, `is ${n} lines and not in ${B}; the limit is ${FILE_MAX}. Shrink it to ${FILE_MAX} or fewer.`]);
  }
  return out;
}

// { errors, warnings }, each a list of { file, line?, msg }.
export function checkFiles({ loc, diff, baseline, baseBaseline, baselinePath }) {
  const pairs = [
    ...unbaselined(loc, baseline, diff, baselinePath),
    ...ratchet({ loc, baseline, baseBaseline, renames: diff.renames, baselinePath }),
  ];
  const errors = pairs.map(([file, msg]) => ({ file, msg }));
  const warnings = [];
  for (const p of diff.added.keys()) {
    const n = loc.get(p);
    if (n > FILE_WARN && n <= FILE_MAX)
      warnings.push({ file: p, msg: `is ${n} lines, over the ${FILE_WARN}-line soft limit (hard limit ${FILE_MAX}).` });
  }
  return { errors, warnings };
}
