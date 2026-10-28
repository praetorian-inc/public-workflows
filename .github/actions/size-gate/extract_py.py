"""List the functions and lambdas in Python sources for the size gate.

Usage: python3 -I extract_py.py <file>...

Prints one JSON object mapping each path, as given, to
{"functions": [{"name", "start", "end", "isComponent"}], "error"?}.
Parse-only: the sources are read and parsed with ast, never executed.
"""

import ast
import json
import sys

FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)


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


def extract_file(path):
    """Return the per-file result for one path; errors never raise."""
    try:
        with open(path, "rb") as fh:
            source = fh.read()
        tree = ast.parse(source, filename=path)
        functions = []
        _collect(tree, "", "", _lambda_hints(tree), functions)
    except (OSError, SyntaxError, ValueError, RecursionError) as exc:
        return {"functions": [], "error": f"{type(exc).__name__}: {exc}"}
    return {"functions": functions}


def main(argv):
    result = {path: extract_file(path) for path in argv}
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
