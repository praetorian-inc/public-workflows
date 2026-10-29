// Size-lint disable comments the gate refuses on an added line (LAB-7587).
// The Go and ESLint forms are ported from guard#9602; the Python forms are new.
import { splitLines } from "./measure.mjs";

const DISABLE = [
  /\/\/\s*nolint(?![\w:])/, // bare //nolint disables every linter, funlen and revive included
  /\/\/\s*nolint:[\w,\s-]*\b(funlen|revive|all)\b/,
  /revive:disable/,
  /eslint-disable(-next-line|-line)?\s*(--[^\n]*?)?(\*\/|$)/, // bare, with or without "-- reason"
  /eslint-disable(-next-line|-line)?\b[^\n]*\b(max-lines|max-lines-per-function)\b/,
  /\/\*\s*eslint\s+[^\n]*\b(max-lines|max-lines-per-function)\b/, // inline rule config
  // bare # noqa silences every flake8/ruff rule; "# ruff: noqa" and "# flake8: noqa" do it file-wide
  /#\s*((ruff|flake8)\s*:\s*)?noqa\b(?!\s*:)/i,
  /#\s*((ruff|flake8)\s*:\s*)?noqa\s*:[\w,\s-]*\b(PLR0915|C0302|R0915)\b/i,
  // ruff's own-line range suppression; preview also takes rule names
  /^\s*#\s*ruff\s*:\s*disable\s*\[\s*([\w-]+\s*,\s*)*(PLR0915|too-many-statements)\s*(,\s*[\w-]+\s*)*,?\s*\]/,
];

// pylint's pragma grammar (pylint/utils/pragma_parser.py): the last "# … pylint:"
// in a comment, read token by token; a syntax error drops the rest of it.
const PRAGMA = /^.*#.*?\bpylint:\s*([^;#\n]+)/;
const TOKEN = /(\b(?:disable-next|disable-msg|disable-all|enable-msg|skip-file|disable|enable)\b)|([\w-]{2,}|[CREIWF]\d*)|(=)/g;
const TAKES_MESSAGES = new Set(["disable-next", "disable-msg", "enable-msg", "disable", "enable"]);
const IGNORES_FILE = new Set(["disable-all", "skip-file"]);
// Message ids and checker names (design owns R0915, format C0302) ignore case.
const SIZE_MESSAGE = (m) => /^(all|R|C|too-many-lines|too-many-statements)$/.test(m) || /^(r0915|c0302|design|format)$/i.test(m);

// The [action, messages] pairs pylint applies from one pragma body.
function pragmas(body) {
  const out = [];
  let [action, messages, needAssign] = [null, [], false];
  const flush = () => {
    if (TAKES_MESSAGES.has(action) && messages.length === 0) return false; // "disable=" names nothing
    out.push([action, messages]);
    return true;
  };
  for (const [, keyword, message, assign] of body.matchAll(TOKEN)) {
    if (assign) {
      if (!needAssign) return out; // "=" after a keyword that takes none, or before any keyword
      needAssign = false;
    } else if (needAssign) return out; // "disable" must be followed by "="
    else if (message) messages.push(message);
    else {
      if (action !== null && !flush()) return out;
      [action, messages, needAssign] = [keyword, [], TAKES_MESSAGES.has(keyword)];
    }
  }
  if (action !== null) flush();
  return out;
}

function silencesPylint(text) {
  const body = PRAGMA.exec(text)?.[1];
  if (body === undefined) return false;
  return pragmas(body).some(([action, messages]) => IGNORES_FILE.has(action) || (action.startsWith("disable") && messages.some(SIZE_MESSAGE)));
}

// ESLint reads a block comment as a directive when its text before any
// " -- reason", trimmed, starts with the directive's name. "eslint-disable-line"
// may not span lines, so a multi-line one is no directive.
const DIRECTIVE = /^(eslint(?:-disable(?:-next-line)?)?)(?:\s|$)/;
const SIZE_RULE = /\b(max-lines|max-lines-per-function)\b/;

function sizeDirective(value) {
  const part = value.split(/\s-{2,}\s/)[0].trim();
  const name = DIRECTIVE.exec(part)?.[1];
  if (name === undefined) return false;
  return SIZE_RULE.test(part) || (name !== "eslint" && part === name); // bare disable: every rule
}

const disables = (t) => silencesPylint(t) || DISABLE.some((re) => re.test(t));

// The line numbers among added lines (Map line -> text) that carry one, read
// from the parser's comments of the file at path p, so a string is never one.
// A multi-line directive counts once, at its first added line. Only ruff's
// regex reads what precedes a comment, so a comment after code gets "x " first.
export function bannedLines(added, comments, p) {
  const lines = [...added.keys()].sort((a, b) => a - b);
  const hits = new Set();
  for (const c of comments) {
    if (c.text.startsWith("/*") && sizeDirective(c.text.slice(2, -2))) {
      const first = lines.find((n) => c.start <= n && n <= c.end);
      if (first !== undefined) hits.add(first);
      continue;
    }
    splitLines(p, c.text).forEach((seg, k) => {
      const n = c.start + k;
      if (!added.has(n)) return;
      const after = k === 0 && added.get(n).trim() !== seg.trim();
      if (disables(after ? `x ${seg}` : seg)) hits.add(n);
    });
  }
  return lines.filter((n) => hits.has(n));
}
