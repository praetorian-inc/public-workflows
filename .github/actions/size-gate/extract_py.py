"""List the functions in Python sources for the size gate.

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


def _collect(node, prefix, out):
    """Append every def under node, pre-order (source order), __qualname__ names."""
    for child in ast.iter_child_nodes(node):
        if isinstance(child, FUNCTION_NODES):
            name = prefix + child.name
            out.append(
                {
                    "name": name,
                    "start": _start_line(child),
                    "end": child.end_lineno,
                    "isComponent": False,
                }
            )
            _collect(child, name + ".<locals>.", out)
        elif isinstance(child, ast.ClassDef):
            _collect(child, prefix + child.name + ".", out)
        else:
            _collect(child, prefix, out)


def extract_file(path):
    """Return the per-file result for one path; errors never raise."""
    try:
        with open(path, "rb") as fh:
            source = fh.read()
        tree = ast.parse(source, filename=path)
        functions = []
        _collect(tree, "", functions)
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
