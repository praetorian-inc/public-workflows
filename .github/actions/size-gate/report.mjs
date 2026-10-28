// GitHub workflow-command output for the size gate (LAB-7587).
import { appendFileSync } from "node:fs";

// Escape a workflow-command message so a newline cannot start a new command.
export const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
// Property values also may not contain the ':' and ',' separators.
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

// One annotation line for { file, line?, msg }.
export function annotation(kind, { file, line, msg }) {
  const props = line ? `file=${escapeProperty(file)},line=${line}` : `file=${escapeProperty(file)}`;
  const where = line ? `${file}:${line}` : file;
  return `::${kind} ${props}::${escapeData(`${where} ${msg}`)}`;
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function summary({ errors, warnings, base, scanned }) {
  const rows = [
    ...errors.map((e) => `| error | \`${cell(e.file)}${e.line ? `:${e.line}` : ""}\` | ${cell(e.msg)} |`),
    ...warnings.map((w) => `| warning | \`${cell(w.file)}\` | ${cell(w.msg)} |`),
  ];
  const head = `## Size gate\n\nScanned ${scanned} files against \`${base.slice(0, 12)}\`: ${errors.length} errors, ${warnings.length} warnings.\n`;
  return rows.length ? `${head}\n| Kind | Where | Message |\n| --- | --- | --- |\n${rows.join("\n")}\n` : head;
}

// Print annotations and the totals line; write the step summary and outputs.
export function report({ errors, warnings, base, scanned, baselined, env, log }) {
  for (const w of warnings) log(annotation("warning", w));
  for (const e of errors) log(annotation("error", e));
  log(`size gate: scanned ${scanned} files against ${base.slice(0, 12)}; ${baselined} baselined, ${errors.length} errors, ${warnings.length} warnings`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary({ errors, warnings, base, scanned }));
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `violations=${errors.length}\nwarnings=${warnings.length}\nbase-sha=${base}\n`);
}
