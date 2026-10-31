// The file rule (LAB-7587): new files over FILE_MAX (500) lines fail,
// unbaselined files over FILE_MAX fail, the baseline ratchet holds, and added
// or changed files over FILE_WARN (400) lines warn. Ported from guard#9602's
// check(); the disable-comment ban reads parsed comments, so it lives in
// functions-check.mjs.
// A hand-written file may not exempt itself by gaining a generated header.
import { FILE_MAX, FILE_WARN } from "./config.mjs";
import { oversized, ratchet } from "./baseline.mjs";
import { showBlob } from "./git.mjs";
import { readRegular } from "./measure.mjs";
import { exemptByText, inScope } from "./scope.mjs";

function unbaselined(loc, baseline, diff, B) {
  const out = [];
  for (const [p, n] of Object.entries(oversized(loc))) {
    if (p in baseline) continue;
    if (!diff.atBase.has(p) && !diff.renames.has(p)) out.push([p, `new file is ${n} lines; the limit is ${FILE_MAX}. Split it.`]);
    else out.push([p, `is ${n} lines and not in ${B}; the limit is ${FILE_MAX}. Shrink it to ${FILE_MAX} or fewer.`]);
  }
  return out;
}

const GAINED =
  "gained a `// Code generated … DO NOT EDIT.` header it did not have at the merge-base; a hand-written file cannot be made exempt by adding the header. Exclude the path with `exclude-paths` if it really is generated now.";

// A file at the merge-base that was not exempt by its text there may not
// become exempt by gaining a generated header; a new file (A) may.
function gainedHeader(root, base, status) {
  const out = [];
  for (const [p, s] of status) {
    if (s.code === "A" || s.code === "D" || !inScope(p)) continue;
    const head = readRegular(root, p);
    if (head === null || !exemptByText(p, head)) continue;
    const was = showBlob(root, base, s.from);
    if (was !== null && !exemptByText(s.from, was)) out.push([p, GAINED]);
  }
  return out;
}

// { errors, warnings }, each a list of { file, line?, msg }.
export function checkFiles({ root, base, loc, diff, baseline, baseBaseline, baseLines, baselinePath }) {
  const pairs = [
    ...gainedHeader(root, base, diff.status),
    ...unbaselined(loc, baseline, diff, baselinePath),
    ...ratchet({ loc, baseline, baseBaseline, baseLines, renames: diff.renames, baselinePath }),
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
