// Source length is advisory: changed files over FILE_WARN (400) lines warn,
// including files above the former FILE_MAX (500). Integrity checks remain hard.
// A hand-written file may not exempt itself by gaining a generated header.
import { FILE_MAX, FILE_WARN } from "./config.mjs";
import { showBlob } from "./git.mjs";
import { readRegular } from "./measure.mjs";
import { exemptByText, inScope } from "./scope.mjs";

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
export function checkFiles({ root, base, loc, diff }) {
  const errors = gainedHeader(root, base, diff.status).map(([file, msg]) => ({ file, msg }));
  const warnings = [];
  for (const p of diff.added.keys()) {
    const n = loc.get(p);
    if (n > FILE_WARN)
      warnings.push({ file: p, msg: `is ${n} lines, over the ${FILE_WARN}-line advisory threshold (previous hard limit ${FILE_MAX}).`, review: true });
  }
  return { errors, warnings };
}
