#!/usr/bin/env python3
"""Unit tests for collect_leaderboard_metrics.py (stdlib unittest, no deps).

Run: python3 -m unittest discover -s .github/actions/collect-metrics -v
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import collect_leaderboard_metrics as clm  # noqa: E402


def _proc(stdout: str):
    return mock.Mock(stdout=stdout, returncode=0)


class DetermineAuthorsTest(unittest.TestCase):
    EMAIL_MAP = {"alice": "alice@p.com", "bob": "bob@p.com", "alice2": "alice@p.com"}

    def test_primary_by_most_lines(self):
        commits = [("s1", "alice"), ("s2", "bob")]
        stats = {"s1": [(100, 10, "a.go")], "s2": [(5, 5, "b.go")]}
        primary, cos, stats_list = clm.determine_authors(commits, stats, self.EMAIL_MAP)
        self.assertEqual(primary, "alice@p.com")
        self.assertEqual(cos, ["bob@p.com"])
        self.assertEqual(
            sorted((s["email"], s["additions"], s["deletions"]) for s in stats_list),
            [("alice@p.com", 100, 10), ("bob@p.com", 5, 5)],
        )

    def test_multiple_logins_same_email_aggregate_once(self):
        commits = [("s1", "alice"), ("s2", "alice2"), ("s3", "bob")]
        stats = {
            "s1": [(10, 0, "a.go")],
            "s2": [(10, 0, "a.go")],
            "s3": [(15, 0, "b.go")],
        }
        primary, cos, stats_list = clm.determine_authors(commits, stats, self.EMAIL_MAP)
        # alice's two logins total 20 lines > bob's 15; exactly one entry per email
        self.assertEqual(primary, "alice@p.com")
        self.assertEqual(cos, ["bob@p.com"])
        self.assertEqual(len(stats_list), 2)

    def test_tie_break_is_lexicographic(self):
        commits = [("s1", "bob"), ("s2", "alice")]
        stats = {"s1": [(10, 0, "a")], "s2": [(10, 0, "b")]}
        primary, _, _ = clm.determine_authors(commits, stats, self.EMAIL_MAP)
        self.assertEqual(primary, "alice@p.com")

    def test_unmapped_logins_yield_none(self):
        commits = [("s1", "stranger")]
        stats = {"s1": [(10, 0, "a")]}
        primary, cos, stats_list = clm.determine_authors(commits, stats, self.EMAIL_MAP)
        self.assertIsNone(primary)
        self.assertEqual(cos, [])
        self.assertEqual(stats_list, [])


class FetchCommitFileStatsTest(unittest.TestCase):
    SHA_A = "a" * 40
    SHA_B = "b" * 40

    @mock.patch.object(clm.subprocess, "run")
    def test_parses_numstat_and_binary_rows(self, run):
        run.return_value = _proc(
            f"{self.SHA_A}\n"
            "10\t2\tpkg/x.go\n"
            "-\t-\tassets/logo.png\n"
            f"{self.SHA_B}\n"
            "3\t1\tREADME.md\n"
        )
        stats = clm.fetch_commit_file_stats("base", "head")
        self.assertEqual(
            stats[self.SHA_A], [(10, 2, "pkg/x.go"), (0, 0, "assets/logo.png")]
        )
        self.assertEqual(stats[self.SHA_B], [(3, 1, "README.md")])
        args = run.call_args[0][0]
        self.assertIn("--no-renames", args)

    @mock.patch.object(clm.subprocess, "run")
    def test_empty_output_yields_empty_stats(self, run):
        run.return_value = _proc("")
        self.assertEqual(clm.fetch_commit_file_stats("base", "head"), {})


class FetchPrCommitsTest(unittest.TestCase):
    @mock.patch.object(clm.subprocess, "run")
    def test_drops_commits_without_login_with_warning(self, run):
        run.return_value = _proc("sha1\talice\nsha2\t\nsha3\tbob\n")
        with mock.patch.object(clm, "gh_warning") as warn:
            commits = clm.fetch_pr_commits("o/r", "1")
        self.assertEqual(commits, [("sha1", "alice"), ("sha3", "bob")])
        warn.assert_called_once()


class CollectReviewersTest(unittest.TestCase):
    @mock.patch.object(clm.subprocess, "run")
    def test_cross_page_dedupe_and_author_exclusion(self, run):
        # --paginate applies the jq filter per page: same login can repeat.
        run.return_value = _proc("alice\nbob\nalice\ncarol\n")
        env = {"PR_AUTHOR": "carol"}
        email_map = {"alice": "alice@p.com", "bob": "bob@p.com", "carol": "carol@p.com"}
        with mock.patch.dict(os.environ, env):
            emails = clm.collect_reviewers("o/r", "1", email_map)
        self.assertEqual(emails, ["alice@p.com", "bob@p.com"])
        args = run.call_args[0][0]
        self.assertIn("--paginate", args)
        jq = args[args.index("--jq") + 1]
        self.assertIn("select(.user != null)", jq)


class ExtractTicketsTest(unittest.TestCase):
    def test_case_insensitive_deduped_sorted(self):
        tickets = clm.extract_tickets("eng-42 fixes ENG-7", "also Eng-42 mentioned")
        self.assertEqual(tickets, ["ENG-42", "ENG-7"])

    def test_no_tickets(self):
        self.assertEqual(clm.extract_tickets("chore: tidy", ""), [])


class CapabilitiesTest(unittest.TestCase):
    EMAIL_MAP = {"alice": "alice@p.com"}
    COMMITS = [("s1", "alice")]

    def test_fixed_name_root_path(self):
        stats = {"s1": [(5, 1, "cmd/main.go")]}
        caps = clm.collect_capabilities(
            [{"path": ".", "name": "nmap"}], self.COMMITS, stats, self.EMAIL_MAP
        )
        self.assertEqual(caps[0]["name"], "nmap")
        self.assertEqual(
            caps[0]["authors"], [{"email": "alice@p.com", "additions": 5, "deletions": 1}]
        )

    def test_path_prefix_must_match(self):
        stats = {"s1": [(5, 1, "other/main.go")]}
        caps = clm.collect_capabilities(
            [{"path": "caps/", "name": "x"}], self.COMMITS, stats, self.EMAIL_MAP
        )
        self.assertEqual(caps, [])

    def test_filename_and_depth_modes(self):
        stats = {"s1": [(5, 1, "caps/nuclei/scan.yaml")]}
        by_file = clm.collect_capabilities(
            [{"path": "caps/", "filename": True}], self.COMMITS, stats, self.EMAIL_MAP
        )
        self.assertEqual(by_file[0]["name"], "scan")
        by_depth = clm.collect_capabilities(
            [{"path": "caps/", "depth": 2}], self.COMMITS, stats, self.EMAIL_MAP
        )
        self.assertEqual(by_depth[0]["name"], "nuclei")


class MainStalePayloadTest(unittest.TestCase):
    def test_stale_payload_removed_when_no_new_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            stale = os.path.join(tmp, "payload.json")
            with open(stale, "w") as f:
                f.write('{"stale": true}')
            with mock.patch.object(clm, "OUTPUT_PATH", stale), \
                 mock.patch.object(clm, "build_payload", return_value=None), \
                 self.assertRaises(SystemExit) as ctx:
                clm.main()
            self.assertEqual(ctx.exception.code, 0)
            self.assertFalse(os.path.exists(stale))


if __name__ == "__main__":
    unittest.main()
