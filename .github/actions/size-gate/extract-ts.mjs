// TypeScript/TSX function extractor for the size gate (LAB-7587).
// Usage: node extract-ts.mjs <file>... ; prints one JSON object keyed by path.
// Parse-only: ts.createSourceFile never evaluates the code it reads.
import { readFileSync } from "node:fs";
import ts from "typescript";

const K = ts.SyntaxKind;
const FUNCTION_KINDS = new Set([
  K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration,
  K.Constructor, K.GetAccessor, K.SetAccessor,
]);
const JSX_KINDS = new Set([K.JsxElement, K.JsxSelfClosingElement, K.JsxFragment]);

const join = (outer, name) => (outer ? `${outer}>${name}` : name);
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function propName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

// The name a function expression or arrow takes from where it sits.
function contextName(node) {
  const p = node.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return propName(p.name);
  if (ts.isCallExpression(p) && p.arguments.includes(node)) return calleeName(p.expression);
  if (ts.isExportAssignment(p)) return "default";
  if (ts.isBinaryExpression(p) && p.right === node) return calleeName(p.left);
  return null;
}

// The class or object-literal owner prefix for members ("Svc.", "api.").
function ownerPrefix(node) {
  let p = node.parent;
  if (ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) p = p.parent;
  if (ts.isClassLike(p)) return p.name ? `${p.name.text}.` : "";
  if (ts.isObjectLiteralExpression(p) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) {
    return `${p.parent.name.text}.`;
  }
  return "";
}

function leafName(node) {
  const owner = ownerPrefix(node);
  if (ts.isConstructorDeclaration(node)) return `${owner}constructor`;
  if (ts.isGetAccessor(node)) return `get ${owner}${propName(node.name) ?? "anon"}`;
  if (ts.isSetAccessor(node)) return `set ${owner}${propName(node.name) ?? "anon"}`;
  if (ts.isMethodDeclaration(node)) return `${owner}${propName(node.name) ?? "anon"}`;
  if (ts.isFunctionDeclaration(node)) return node.name ? node.name.text : "default";
  const ctx = contextName(node);
  if (ctx) return `${owner}${ctx}`;
  return node.name ? node.name.text : "anon";
}

// True when JSX appears in this function's own body, not in a nested function.
function ownsJsx(body) {
  let found = false;
  const visit = (n) => {
    if (found || FUNCTION_KINDS.has(n.kind)) return;
    if (JSX_KINDS.has(n.kind)) found = true;
    else ts.forEachChild(n, visit);
  };
  if (JSX_KINDS.has(body.kind)) return true;
  ts.forEachChild(body, visit);
  return found;
}

function collect(sf) {
  const out = [];
  const walk = (node, outer) => {
    let next = outer;
    if (FUNCTION_KINDS.has(node.kind) && node.body) {
      next = join(outer, leafName(node));
      out.push({
        name: next,
        start: lineOf(sf, node.getStart(sf)),
        end: lineOf(sf, node.end),
        isComponent: ownsJsx(node.body),
      });
    }
    ts.forEachChild(node, (child) => walk(child, next));
  };
  walk(sf, "");
  return out;
}

const isJsxElementOrFragment = (n) => n.kind === K.JsxElement || n.kind === K.JsxFragment;

// Whether trivia after this token can hold a comment, or is JsxText instead.
// Ported from ts-api-utils src/comments.ts canHaveTrailingTrivia:
// https://github.com/JoshuaKGoldberg/ts-api-utils/blob/e59a11b8d93e85e5049d2ec335c9c7134dfd7e73/src/comments.ts
function canHaveTrailingTrivia(token) {
  const p = token.parent;
  if (token.kind === K.CloseBraceToken) return p.kind !== K.JsxExpression || !isJsxElementOrFragment(p.parent);
  if (token.kind !== K.GreaterThanToken) return true;
  switch (p.kind) {
    case K.JsxClosingElement:
    case K.JsxClosingFragment:
      return !isJsxElementOrFragment(p.parent.parent); // only after the top element
    case K.JsxOpeningElement:
      return token.end !== p.end; // a type-argument ">"; else the body follows
    case K.JsxOpeningFragment:
      return false;
    case K.JsxSelfClosingElement:
      return token.end !== p.end || !isJsxElementOrFragment(p.parent);
  }
  return true;
}

// Every comment in source order, found the way ts-api-utils forEachComment
// finds them: leading trivia of each token, plus trailing trivia except at
// end of file. JSDoc nodes repeat their parent token's leading comments, and
// JsxText is text, so neither is scanned; nor is the trailing trivia of a JSX
// ">" or "}", which is JsxText too. The scanner skips a shebang.
function comments(sf) {
  const jsx = sf.languageVariant === ts.LanguageVariant.JSX;
  const text = sf.getFullText();
  const seen = new Map();
  const add = (pos, end) => {
    if (!seen.has(pos)) {
      seen.set(pos, { start: lineOf(sf, pos), end: lineOf(sf, end), text: text.slice(pos, end) });
    }
  };
  const visit = (node) => {
    if (ts.isJSDoc(node) || node.kind === K.JsxText) return;
    const children = node.getChildren(sf);
    if (children.length > 0) return children.forEach(visit);
    ts.forEachLeadingCommentRange(text, node.pos, add);
    if (node.kind !== K.EndOfFileToken && (!jsx || canHaveTrailingTrivia(node))) ts.forEachTrailingCommentRange(text, node.end, add);
  };
  visit(sf);
  return [...seen.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
}

function extractFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { functions: [], comments: [], error: `cannot read: ${err.message}` };
  }
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  // Any diagnostic fails, as in Go and Python: recovery can cut a function short.
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    return { functions: [], comments: [], error: ts.flattenDiagnosticMessageText(diags[0].messageText, "\n") };
  }
  return { functions: collect(sf), comments: comments(sf) };
}

const result = {};
for (const path of process.argv.slice(2)) result[path] = extractFile(path);
process.stdout.write(`${JSON.stringify(result)}\n`);
