// The deterministic pre-filter for instruction-file drift (LAB-7596). It pairs
// each changed code file with every level-2 and level-3 heading section of every
// AGENTS.md (and content-carrying CLAUDE.md) that governs it. A section need not
// name the changed code: an omission from a list the section keeps is a
// candidate too. Sectioning matches the calibration set exactly.
import { git, showBlob } from "../size-gate/git.mjs";
import { cap } from "./questions.mjs";

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// [{ heading, level, text }] for the ## and ### sections of a markdown text. A
// section runs to the next heading of the same or a higher level, so a ###
// section is also part of its ## parent. Headings inside fences are text.
export function sections(md) {
  const lines = md.split("\n");
  const hs = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (FENCE.test(l)) fence = !fence;
    else if (!fence) {
      const m = HEADING.exec(l);
      if (m) hs.push({ i, level: m[1].length, heading: m[2].trim() });
    }
  });
  return hs.flatMap((h, k) => {
    if (h.level !== 2 && h.level !== 3) return [];
    const next = hs.slice(k + 1).find((o) => o.level <= h.level);
    const text = lines.slice(h.i, next ? next.i : lines.length).join("\n").trim();
    return [{ heading: h.heading, level: h.level, text }];
  });
}

// A CLAUDE.md that is empty or only the `@AGENTS.md` import pointer carries no content.
export const carriesContent = (p, text) =>
  text !== null && (!/(^|\/)CLAUDE\.md$/.test(p) || !["@AGENTS.md", ""].includes(text.replace(/\s+/g, "")));

// The instruction files governing `file`, nearest first: AGENTS.md then
// CLAUDE.md in its directory, then in each ancestor up to the root.
export function governing(file, read) {
  const parts = file.split("/").slice(0, -1);
  const dirs = [""].concat(parts.map((_, k) => parts.slice(0, k + 1).join("/")));
  return dirs.reverse().flatMap((d) =>
    ["AGENTS.md", "CLAUDE.md"].map((n) => (d ? `${d}/${n}` : n)).filter((p) => carriesContent(p, read(p))),
  );
}

// The extension test the shell pre-filter uses: "." plus everything after the
// last dot (the whole path when there is none).
export const skipped = (file, skipList) => skipList.includes(`.${file.slice(file.lastIndexOf(".") + 1)}`);

// Order pairs nearest instruction file first, keep `maxPairs`, and group the
// rest by (file, instruction file) so the comment can list what went unchecked.
export function capPairs(all, maxPairs) {
  const sorted = all.map((p, k) => [p, k]).sort((a, b) => a[0].distance - b[0].distance || a[1] - b[1]).map(([p]) => p);
  const kept = sorted.slice(0, maxPairs);
  const groups = new Map();
  for (const p of sorted.slice(maxPairs)) {
    const k = JSON.stringify([p.file, p.agents_md]);
    const g = groups.get(k) ?? { file: p.file, agents_md: p.agents_md, sections: 0 };
    g.sections++;
    groups.set(k, g);
  }
  return { pairs: kept.map((p, i) => ({ id: `p${i + 1}`, ...p })), overflow: [...groups.values()] };
}

const DIFF_FLAGS = ["--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

// Candidate pairs for the PR base...head. Throws when git cannot answer, which
// the caller reports as "pre-filter unavailable".
export function buildPairs({ root, base, head, skipList, maxPairs }) {
  const range = `${base}...${head}`;
  const changed = git(root, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", range])
    .split("\0")
    .filter((f) => f && !skipped(f, skipList));
  const cache = new Map();
  const read = (p) => {
    if (!cache.has(p)) cache.set(p, showBlob(root, head, p));
    return cache.get(p);
  };
  const diffs = {};
  const all = [];
  for (const file of changed) {
    const mds = governing(file, read);
    if (mds.length === 0) continue;
    diffs[file] = cap(git(root, ["-c", "core.quotePath=false", "diff", ...DIFF_FLAGS, range, "--", file]));
    mds.forEach((agents_md, distance) => {
      // A heading text can repeat in one file; its occurrence number keeps
      // each section a separate finding.
      const seen = new Map();
      for (const s of sections(read(agents_md))) {
        const occurrence = (seen.get(s.heading) ?? 0) + 1;
        seen.set(s.heading, occurrence);
        all.push({ file, agents_md, heading: s.heading, occurrence, section: s.text, distance });
      }
    });
  }
  return { diffs, ...capPairs(all, maxPairs) };
}
