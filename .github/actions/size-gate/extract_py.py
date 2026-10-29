"""List the functions and lambdas in Python sources for the size gate.

Usage: python3 -I extract_py.py <file>...

Prints one JSON object mapping each path, as given, to
{"functions": [{"name", "start", "end", "isComponent"}],
 "comments": [{"start", "end", "text"}], "error"?}.
Comments are tokenize's COMMENT tokens, so `#` inside a string is not one.
They are read in the declared encoding, in the encoding flake8 and pylint
detect on the raw bytes, and, like ruff, as UTF-8; a file whose declared
encoding adds or removes line breaks gets "error".
Parse-only: the sources are read and parsed with ast, never executed.
"""

import ast
import io
import json
import sys
import tokenize

FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)
UTF8 = ("utf-8", "utf-8-sig")


def _start_line(node):
    """First line of a def, counting its decorators."""
    return min([node.lineno] + [d.lineno for d in node.decorator_list])


def _entry(name, start, end):
    return {"name": name, "start": start, "end": end, "isComponent": False}


def _lambda_hints(tree):
    """Map each lambda that is the whole value of `name = lambda ...` or
    `name: T = lambda ...` to name."""
    hints = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
        elif isinstance(node, ast.AnnAssign):
            target = node.target
        else:
            continue
        if isinstance(target, ast.Name) and isinstance(node.value, ast.Lambda):
            hints[node.value] = target.id
    return hints


def _collect(node, prefix, enclosing, hints, out):
    """Append every def and lambda under node, pre-order (source order).

    Defs get __qualname__ names; lambdas are named like the Go extractor's
    function literals: `<enclosing>>lambda:<var>`, `anon` without a var.
    """
    for child in ast.iter_child_nodes(node):
        if isinstance(child, FUNCTION_NODES):
            name = prefix + child.name
            out.append(_entry(name, _start_line(child), child.end_lineno))
            _collect(child, name + ".<locals>.", name, hints, out)
        elif isinstance(child, ast.Lambda):
            name = enclosing + ">" if enclosing else ""
            name += "lambda:" + hints.get(child, "anon")
            out.append(_entry(name, child.lineno, child.end_lineno))
            _collect(child, prefix, name, hints, out)
        elif isinstance(child, ast.ClassDef):
            qualname = prefix + child.name
            _collect(child, qualname + ".", qualname, hints, out)
        else:
            _collect(child, prefix, enclosing, hints, out)


def _declared(data, enc):
    """data decoded in enc, refusing a codec that adds or removes line breaks."""
    text = data.decode(enc)
    if enc in UTF8:
        return text
    pieces = [line.decode(enc) for line in data.split(b"\n")]
    if "\n".join(pieces) != text or any("\r" in p or "\n" in p for p in pieces):
        raise ValueError("declared encoding moves line breaks")
    return text


def _detect(data):
    """detect_encoding on data, or None when it cannot detect one."""
    try:
        return tokenize.detect_encoding(io.BytesIO(data).readline)[0]
    except SyntaxError:
        return None


def _views(data, source):
    """Each text a linter may read, all in data's (normalized) line numbering:
    the declared encoding; the encoding flake8 and pylint detect on the raw
    source, where a lone \\r does not end a line; and UTF-8 as ruff reads it.

    Raises ValueError when a declared encoding adds or removes line breaks.
    """
    enc = tokenize.detect_encoding(io.BytesIO(data).readline)[0]
    views = [_declared(data, enc)]
    raw = _detect(source)
    if raw not in (None, enc) and raw not in UTF8:
        views.append(_declared(data, raw))
    if enc not in UTF8:
        try:
            views.append(data.decode("utf-8"))
        except UnicodeDecodeError:
            pass
    return list(dict.fromkeys(views))


def _comments(source):
    """Every comment in every view, in source order, as 1-based lines and raw text.

    ast ends a line at \\r\\n, \\r or \\n, but tokenize reads \\n-split lines,
    so endings are normalized first. That is done on bytes because CPython's
    tokenizer normalizes line endings on bytes before it decodes.
    """
    data = source.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    found = {
        (tok.start[0], tok.end[0], tok.string)
        for view in _views(data, source)
        for tok in tokenize.generate_tokens(io.StringIO(view).readline)
        if tok.type == tokenize.COMMENT
    }
    return [{"start": s, "end": e, "text": t} for s, e, t in sorted(found)]


def extract_file(path):
    """Return the per-file result for one path; errors never raise."""
    try:
        with open(path, "rb") as fh:
            source = fh.read()
        tree = ast.parse(source, filename=path)
        functions = []
        _collect(tree, "", "", _lambda_hints(tree), functions)
        comments = _comments(source)
    except (OSError, SyntaxError, ValueError, RecursionError, tokenize.TokenError) as exc:
        error = f"{type(exc).__name__}: {exc}"
        return {"functions": [], "comments": [], "error": error}
    return {"functions": functions, "comments": comments}


def main(argv):
    result = {path: extract_file(path) for path in argv}
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
