"""Golden and error-path tests for the Python function extractor (LAB-7587).

The extractor is run as a subprocess exactly as the workflow runs it
(`python3 -I extract_py.py <abs path>...`), so these tests exercise the CLI
contract: one JSON object on stdout keyed by the paths given, exit 0 even
when individual files fail to parse.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
EXTRACTOR = os.path.join(HERE, "extract_py.py")
FIXTURES = os.path.normpath(
    os.path.join(HERE, "..", "..", "..", "_test-fixtures", "size-gate", "extract", "py")
)

GOOD_SOURCE = "def good():\n    return 1\n"
GOOD_ENTRY = {
    "functions": [{"name": "good", "start": 1, "end": 2, "isComponent": False}],
    "comments": [],
}


def run_extractor(test, *paths):
    """Run the extractor on `paths`; assert exit 0 and return the parsed JSON."""
    proc = subprocess.run(
        [sys.executable, "-I", EXTRACTOR, *paths],
        capture_output=True,
        text=True,
        check=False,
    )
    test.assertEqual(
        proc.returncode,
        0,
        f"extractor exited {proc.returncode}\nstderr:\n{proc.stderr}",
    )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        test.fail(f"stdout is not one JSON object ({exc}):\n{proc.stdout}")


def fixture_sources():
    return sorted(
        os.path.join(FIXTURES, name)
        for name in os.listdir(FIXTURES)
        if name.endswith(".py")
    )


def golden_for(source):
    with open(source[: -len(".py")] + ".golden.json", encoding="utf-8") as fh:
        return json.load(fh)


def write(directory, name, content):
    path = os.path.join(directory, name)
    mode = "wb" if isinstance(content, bytes) else "w"
    with open(path, mode) as fh:
        fh.write(content)
    return path


class GoldenFixtureTest(unittest.TestCase):
    def test_every_fixture_has_a_golden(self):
        sources = fixture_sources()
        self.assertGreaterEqual(len(sources), 2, f"too few fixtures in {FIXTURES}")
        for source in sources:
            with self.subTest(fixture=os.path.basename(source)):
                golden = source[: -len(".py")] + ".golden.json"
                self.assertTrue(os.path.isfile(golden), f"missing {golden}")

    def test_batched_run_matches_every_golden(self):
        sources = fixture_sources()
        out = run_extractor(self, *sources)
        self.assertEqual(sorted(out), sorted(sources))
        for source in sources:
            with self.subTest(fixture=os.path.basename(source)):
                self.assertEqual(out[source], golden_for(source))

    def test_duplicate_names_are_emitted_without_ordinals(self):
        source = os.path.join(FIXTURES, "duplicates.py")
        out = run_extractor(self, source)
        names = [fn["name"] for fn in out[source]["functions"]]
        self.assertEqual(names, ["setup", "other", "setup"])


LAMBDA_SOURCE = """\
square = (
    lambda a: (
        a * a
    )
)


class Widget:
    x = lambda self: 0


curried = lambda a: lambda b: a + b
a = b = lambda: 0
obj.y = lambda: 0
typed: object = lambda: 0
obj.z: object = lambda: 0
"""


class LambdaTest(unittest.TestCase):
    def test_lambdas_are_measured_and_named_like_go_literals(self):
        with tempfile.TemporaryDirectory() as directory:
            source = write(directory, "lambdas.py", LAMBDA_SOURCE)
            out = run_extractor(self, source)
        spans = [(fn["name"], fn["start"], fn["end"]) for fn in out[source]["functions"]]
        self.assertEqual(
            spans,
            [
                ("lambda:square", 2, 4),
                ("Widget>lambda:x", 9, 9),
                ("lambda:curried", 12, 12),
                ("lambda:curried>lambda:anon", 12, 12),
                ("lambda:anon", 13, 13),
                ("lambda:anon", 14, 14),
                ("lambda:typed", 15, 15),
                ("lambda:anon", 16, 16),
            ],
        )


COMMENT_SOURCE = """\
#!/usr/bin/env python3
# coding: utf-8
x = 1  # noqa: E501
text = '# noqa'
msg = f"{x!r} # no"
nested = f"{'# not either'}"
doc = \"\"\"
# pylint: disable=R0915
\"\"\"
    # pylint: disable=too-many-statements
"""


class CommentTest(unittest.TestCase):
    def test_only_real_comments_are_reported_with_their_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            source = write(directory, "comments.py", COMMENT_SOURCE)
            out = run_extractor(self, source)
        self.assertEqual(
            out[source]["comments"],
            [
                {"start": 1, "end": 1, "text": "#!/usr/bin/env python3"},
                {"start": 2, "end": 2, "text": "# coding: utf-8"},
                {"start": 3, "end": 3, "text": "# noqa: E501"},
                {"start": 10, "end": 10, "text": "# pylint: disable=too-many-statements"},
            ],
        )

    def test_declared_latin1_source_reports_its_comments(self):
        latin1 = b"# -*- coding: latin-1 -*-\nname = 'caf\xe9'  # caf\xe9\n"
        with tempfile.TemporaryDirectory() as directory:
            source = write(directory, "latin1.py", latin1)
            out = run_extractor(self, source)
        self.assertEqual(
            out[source]["comments"],
            [
                {"start": 1, "end": 1, "text": "# -*- coding: latin-1 -*-"},
                {"start": 2, "end": 2, "text": "# caf\u00e9"},
            ],
        )

    def test_comment_lines_match_ast_for_every_line_ending(self):
        lf = b"# head\ndef f():\n    # body\n    return 1\n"
        endings = {
            "cr": lf.replace(b"\n", b"\r"),
            "crlf": lf.replace(b"\n", b"\r\n"),
            "mixed": b"# head\r\ndef f():\r    # body\n    return 1\r",
        }
        for label, content in endings.items():
            with self.subTest(label), tempfile.TemporaryDirectory() as directory:
                source = write(directory, label + ".py", content)
                out = run_extractor(self, source)[source]
                self.assertNotIn("error", out)
                self.assertEqual(
                    [(c["start"], c["text"]) for c in out["comments"]],
                    [(1, "# head"), (3, "# body")],
                )
                self.assertEqual(out["functions"][0]["start"], 2)
                self.assertEqual(out["functions"][0]["end"], 4)


class PerFileErrorTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.good = write(self.dir, "good.py", GOOD_SOURCE)

    def tearDown(self):
        self._tmp.cleanup()

    def assert_error_entry(self, entry):
        self.assertEqual(entry["functions"], [])
        self.assertEqual(entry["comments"], [])
        self.assertIsInstance(entry.get("error"), str)
        self.assertNotEqual(entry["error"].strip(), "")

    def test_syntax_error_is_reported_and_other_files_still_extracted(self):
        bad = write(self.dir, "bad.py", "def broken(:\n    pass\n")
        out = run_extractor(self, bad, self.good)
        self.assertEqual(sorted(out), sorted([bad, self.good]))
        self.assert_error_entry(out[bad])
        self.assertEqual(out[self.good], GOOD_ENTRY)

    def test_missing_file_is_reported_and_other_files_still_extracted(self):
        missing = os.path.join(self.dir, "does-not-exist.py")
        out = run_extractor(self, missing, self.good)
        self.assert_error_entry(out[missing])
        self.assertEqual(out[self.good], GOOD_ENTRY)

    def test_undecodable_bytes_are_reported(self):
        binary = write(self.dir, "binary.py", b"def f():\n    return '\xff\xfe'\n")
        out = run_extractor(self, binary, self.good)
        self.assert_error_entry(out[binary])
        self.assertEqual(out[self.good], GOOD_ENTRY)


class NeverExecutesTest(unittest.TestCase):
    def test_top_level_code_is_not_run(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = os.path.join(directory, "executed.marker")
            source = write(
                directory,
                "side_effect.py",
                f"open({marker!r}, 'w').close()\n\n\ndef payload():\n    return 1\n",
            )
            out = run_extractor(self, source)
            self.assertFalse(os.path.exists(marker), "extractor executed the source")
            self.assertEqual(
                out[source]["functions"],
                [{"name": "payload", "start": 4, "end": 5, "isComponent": False}],
            )


if __name__ == "__main__":
    unittest.main()
