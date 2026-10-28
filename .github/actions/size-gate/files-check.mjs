// The file rule (LAB-7587): new files over 300 lines fail, unbaselined files
// over 300 fail, the baseline ratchet holds, and added or changed files over
// 200 lines warn, and added lines may not disable size lints. Ported from guard#9602's check().
import { FILE_MAX, FILE_WARN } from "./config.mjs";
import { oversized, ratchet } from "./baseline.mjs";
import { bannedLines } from "./disable-ban.mjs";

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
  for (const [p, lines] of diff.added) {
    const n = loc.get(p);
    if (n === undefined) continue;
    for (const line of bannedLines(lines))
      errors.push({ file: p, line, msg: "adds a size-lint disable comment; split the code instead." });
    if (n > FILE_WARN && n <= FILE_MAX)
      warnings.push({ file: p, msg: `is ${n} lines, over the ${FILE_WARN}-line soft limit (hard limit ${FILE_MAX}).` });
  }
  return { errors, warnings };
}
