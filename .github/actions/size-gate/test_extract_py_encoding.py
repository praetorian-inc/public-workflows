"""Encoding tests for the Python comment reader (LAB-7587).

ruff reads every file as UTF-8; pylint and flake8 read the PEP 263 encoding.
The extractor must report the comments of both views, and must fail a file
whose declared encoding adds or removes line breaks.
"""

import os
import tempfile
import unittest

from test_extract_py import run_extractor


def extract(test, data):
    """Write `data` to a temp .py file and return the extractor's entry for it."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "a.py")
        with open(path, "wb") as fh:
            fh.write(data)
        return run_extractor(test, path)[path]


def spans(entry):
    return [(c["start"], c["end"], c["text"]) for c in entry["comments"]]


class EncodingViewsTest(unittest.TestCase):
    def test_p1_utf8_view_finds_comment_hidden_by_utf7(self):
        entry = extract(self, b"# coding: utf-7\nx = +ACI-0  # noqa: E741 +ACI-\n")
        self.assertNotIn("error", entry)
        hits = [c for c in entry["comments"] if c["text"].startswith("# noqa: E741")]
        self.assertEqual([(c["start"], c["end"]) for c in hits], [(2, 2)])

    def test_p2_utf7_that_creates_a_line_fails(self):
        entry = extract(self, b"# coding: utf-7\nx = 1 +AAoAIw- noqa\n")
        self.assertIn("error", entry)
        self.assertEqual(entry["comments"], [])

    def test_p3_unicode_escape_that_creates_a_line_fails(self):
        entry = extract(self, b"# coding: unicode_escape\nx = 1 \\n# noqa\n")
        self.assertIn("error", entry)
        self.assertEqual(entry["comments"], [])

    def test_p4_latin1_comment_reported_once(self):
        data = "# coding: latin-1\nx = 1\n# café\n".encode("latin-1")
        entry = extract(self, data)
        self.assertNotIn("error", entry)
        self.assertEqual(
            spans(entry), [(1, 1, "# coding: latin-1"), (3, 3, "# café")]
        )

    def test_p5_utf8_bom_comment_reported_once_at_line_1(self):
        entry = extract(self, b"\xef\xbb\xbf# hello\nx = 1\n")
        self.assertNotIn("error", entry)
        self.assertEqual(spans(entry), [(1, 1, "# hello")])

    def test_p6_ascii_only_latin1_dedupes_views(self):
        entry = extract(self, b"# coding: latin-1\nx = 1  # noqa\n")
        self.assertNotIn("error", entry)
        self.assertEqual(
            spans(entry), [(1, 1, "# coding: latin-1"), (2, 2, "# noqa")]
        )


class RawEncodingViewTest(unittest.TestCase):
    """flake8 and pylint detect the cookie on raw bytes, where a lone CR is
    not a line break, so a cookie on normalized line 3 still applies."""

    def test_n1_cr_only_cookie_on_line_3_reports_raw_view_comment(self):
        data = (
            b"#!/usr/bin/env python\r# x\r# coding: utf-7\r"
            b'import os; x = "+ACIAIw- noqa"\r'
        )
        entry = extract(self, data)
        self.assertNotIn("error", entry)
        self.assertIn((4, 4, '# noqa"'), spans(entry))

    def test_n1_mixed_endings_cookie_reports_raw_view_comment(self):
        data = b'#a\r#b\n# coding: utf-7\nimport os; x = "+ACIAIw- noqa"\n'
        entry = extract(self, data)
        self.assertNotIn("error", entry)
        self.assertIn((4, 4, '# noqa"'), spans(entry))

    def test_n1_raw_view_that_creates_a_line_fails(self):
        data = b"#!/usr/bin/env python\r# x\r# coding: utf-7\rx = 1 +AAoAIw- noqa\r"
        entry = extract(self, data)
        self.assertIn("error", entry)
        self.assertEqual(entry["comments"], [])

    def test_n1_cr_only_latin1_cookie_on_line_1_is_not_failed(self):
        data = "# coding: latin-1\rx = 1\r# café\r".encode("latin-1")
        entry = extract(self, data)
        self.assertNotIn("error", entry)
        self.assertEqual(
            spans(entry), [(1, 1, "# coding: latin-1"), (3, 3, "# café")]
        )


if __name__ == "__main__":
    unittest.main()
