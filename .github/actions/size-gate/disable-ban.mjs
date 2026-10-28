// Size-lint disable comments the gate refuses on an added line (LAB-7587).
// The Go and ESLint forms are ported from guard#9602; the Python forms are new.
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
  /#\s*pylint\s*:\s*disable(-next)?\s*=[\w,\s-]*\b(too-many-lines|too-many-statements|C0302|R0915|all)(?![\w-])/,
  /#\s*pylint\s*:\s*skip-file\b/,
];

// The line numbers among added lines (Map line -> text) that carry one.
export const bannedLines = (added) =>
  [...added].filter(([, text]) => DISABLE.some((re) => re.test(text))).map(([line]) => line);
