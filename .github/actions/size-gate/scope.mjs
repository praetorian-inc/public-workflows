// Which paths the size gate measures (LAB-7587). Ported from guard#9602's
// size-gate.mjs at 55e154911 with Python added; the include/exclude inputs are
// git pathspecs applied by git itself (config.mjs), not here.

// Test, declaration and protobuf files by name (AC7).
const TEST_SUFFIX =
  /(_test\.go|\.test\.tsx?|\.spec\.tsx?|\.d\.ts|\.pb\.go)$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;
const EXCLUDED_DIR =
  /(^|\/)(e2e|mocks?|__mocks__|generated|node_modules|vendor)(\/|$)|_gen\.go$|\.gen\.tsx?$|zz_generated/i;
const TEST_ONLY =
  /(^|\/)(__tests__|__fixtures__|fixtures|tests?|testdata|testutils?|testhelpers?|test-utils)(\/|$)|(^|\/)(test[-_]?utils?|test_?helpers?)\.(go|tsx?)$/i;
const LANGUAGE = /\.(go|tsx?|py)$/;

// The language a path is measured as: "go", "ts", "tsx", "py", or null.
export function language(p) {
  const m = LANGUAGE.exec(p);
  return m ? m[1] : null;
}

// In scope by path alone; the generated-header check needs the text.
export function inScope(p) {
  return language(p) !== null && !TEST_SUFFIX.test(p) && !EXCLUDED_DIR.test(p) && !TEST_ONLY.test(p);
}

// Only the standard Go generated-code header counts, and only before the first
// line of code, as Go requires; a match inside a string literal does not.
export function isGenerated(text) {
  let inBlock = false;
  for (const line of text.split("\n", 200)) {
    if (!inBlock && /^\/\/ Code generated .* DO NOT EDIT\.$/.test(line)) return true;
    let rest = line;
    if (inBlock) {
      const end = rest.indexOf("*/");
      if (end < 0) continue;
      rest = rest.slice(end + 2);
      inBlock = false;
    }
    // Strip whole /* … */ spans so code after one on the same line still counts as code.
    rest = rest.replace(/\/\*.*?\*\//g, "").trim();
    // A /* inside a line comment is comment text, not the start of a block.
    if (rest.startsWith("//")) continue;
    const open = rest.indexOf("/*");
    if (open >= 0) [rest, inBlock] = [rest.slice(0, open).trim(), true];
    if (rest) return false;
  }
  return false;
}

// A path that is in scope by name but exempt by its content: generated Go.
export function exemptByText(p, text) {
  return language(p) === "go" && isGenerated(text);
}
