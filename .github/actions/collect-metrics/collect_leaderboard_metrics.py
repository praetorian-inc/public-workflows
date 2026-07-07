#!/usr/bin/env python3
"""Collect PR metrics for the leaderboard and write the Lambda payload to $RUNNER_TEMP/payload.json.

Inputs come from environment variables set by the GitHub Actions workflow.
The only external dependency is `gh` (GitHub CLI), pre-installed on ubuntu-latest.
"""

import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import PurePosixPath

OUTPUT_PATH = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "payload.json")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def gh_warning(msg: str) -> None:
    print(f"::warning::{msg}")


def gh_error(msg: str) -> None:
    print(f"::error::{msg}")


def resolve_email(login: str, email_map: dict[str, str]) -> str:
    return email_map.get(login, "")


# ---------------------------------------------------------------------------
# Data fetching (two subprocess calls total)
# ---------------------------------------------------------------------------

def fetch_pr_commits(repo: str, pr_number: str) -> list[tuple[str, str]]:
    """Return [(sha, github_login), ...] for every commit in the PR."""
    result = subprocess.run(
        [
            "gh", "api", f"repos/{repo}/pulls/{pr_number}/commits",
            "--paginate",
            "--jq", r'.[] | "\(.sha)\t\(.author.login // "")"',
        ],
        capture_output=True, text=True, check=True,
    )
    commits = []
    for line in result.stdout.strip().splitlines():
        parts = line.strip().split("\t", 1)
        if len(parts) == 2 and parts[1]:
            commits.append((parts[0], parts[1]))
    return commits


_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def fetch_commit_file_stats(base_sha: str, head_sha: str) -> dict[str, list[tuple[int, int, str]]]:
    """Return {sha: [(adds, dels, filepath), ...]} via a single git-log call."""
    result = subprocess.run(
        ["git", "log", "--numstat", "--no-renames", "--format=%H", f"{base_sha}...{head_sha}"],
        capture_output=True, text=True,
    )
    stats: dict[str, list[tuple[int, int, str]]] = {}
    current_sha: str | None = None

    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if _SHA_RE.match(stripped):
            current_sha = stripped
            stats.setdefault(current_sha, [])
        elif current_sha:
            parts = stripped.split("\t")
            if len(parts) >= 3:
                try:
                    stats[current_sha].append((int(parts[0]), int(parts[1]), parts[2]))
                except ValueError:
                    pass
    return stats


# ---------------------------------------------------------------------------
# Author determination
# ---------------------------------------------------------------------------

def determine_authors(
    pr_commits: list[tuple[str, str]],
    commit_stats: dict[str, list[tuple[int, int, str]]],
    email_map: dict[str, str],
) -> tuple[str | None, list[str], list[dict]]:
    """Pick primary author by most lines; others are co-authors. Ties broken lexicographically.

    Returns (primary_email, co_author_emails, author_stats_list).
    author_stats_list has per-author additions/deletions for proportional scoring.
    """
    login_adds: dict[str, int] = defaultdict(int)
    login_dels: dict[str, int] = defaultdict(int)
    for sha, login in pr_commits:
        for adds, dels, _ in commit_stats.get(sha, []):
            login_adds[login] += adds
            login_dels[login] += dels

    author_stats: list[tuple[str, int, int, int]] = []
    for login in login_adds:
        email = resolve_email(login, email_map)
        adds = login_adds[login]
        dels = login_dels[login]
        if email:
            author_stats.append((email, adds + dels, adds, dels))
        else:
            gh_warning(f"No email mapping for committer {login}")

    if not author_stats:
        return None, [], []

    author_stats.sort(key=lambda x: -x[1])
    max_lines = author_stats[0][1]
    tied = [email for email, lines, _, _ in author_stats if lines == max_lines]
    primary = min(tied)
    co_authors = [email for email, _, _, _ in author_stats if email != primary]
    stats_list = [
        {"email": email, "additions": adds, "deletions": dels}
        for email, _, adds, dels in author_stats
    ]
    return primary, co_authors, stats_list


# ---------------------------------------------------------------------------
# Reviewers
# ---------------------------------------------------------------------------

def collect_reviewers(repo: str, pr_number: str, email_map: dict[str, str]) -> list[str]:
    result = subprocess.run(
        [
            "gh", "api", f"repos/{repo}/pulls/{pr_number}/reviews",
            "--paginate",
            "--jq", '[.[] | select(.state=="APPROVED" or .state=="COMMENTED" or .state=="CHANGES_REQUESTED") | select(.user != null) | .user.login | select(endswith("[bot]") | not)] | unique | .[]',
        ],
        capture_output=True, text=True, check=True,
    )
    # --paginate applies the jq filter per page, so dedupe across pages here.
    logins = list(dict.fromkeys(l.strip() for l in result.stdout.strip().splitlines() if l.strip()))

    pr_author_login = env("PR_AUTHOR")
    emails = []
    for login in logins:
        if login == pr_author_login:
            continue
        email = resolve_email(login, email_map)
        if email:
            emails.append(email)
        else:
            gh_warning(f"No email mapping for reviewer {login}")
    return emails


# ---------------------------------------------------------------------------
# Tickets
# ---------------------------------------------------------------------------

def extract_tickets(title: str, body: str) -> list[str]:
    text = f"{title} {body}"
    return sorted(set(re.findall(r"ENG-\d+", text)))


# ---------------------------------------------------------------------------
# Capability attribution (per-author)
# ---------------------------------------------------------------------------

def _file_matches_path(filepath: str, path: str) -> bool:
    if path == ".":
        return True
    prefix = path if path.endswith("/") else path + "/"
    return filepath.startswith(prefix) or filepath == path.rstrip("/")


def collect_capabilities(
    capability_map: list[dict],
    pr_commits: list[tuple[str, str]],
    commit_stats: dict[str, list[tuple[int, int, str]]],
    email_map: dict[str, str],
) -> list[dict]:
    """Return capabilities with per-author additions/deletions.

    Output shape:
      [{"name": "nmap", "authors": [{"email": "a@p.com", "additions": 80, "deletions": 10}, ...]}]
    """
    if not capability_map:
        return []

    sha_to_login = {sha: login for sha, login in pr_commits}

    # cap_name -> email -> {additions, deletions}
    caps: dict[str, dict[str, dict[str, int]]] = {}

    for sha, login in pr_commits:
        email = resolve_email(login, email_map)
        if not email:
            continue
        for adds, dels, filepath in commit_stats.get(sha, []):
            for entry in capability_map:
                path = entry.get("path", ".")
                fixed_name = entry.get("name")
                depth = entry.get("depth")

                if not _file_matches_path(filepath, path):
                    continue

                cap_name = None
                if fixed_name:
                    cap_name = fixed_name
                elif entry.get("filename"):
                    cap_name = PurePosixPath(filepath).stem
                elif depth is not None:
                    parts = PurePosixPath(filepath).parts
                    d = int(depth)
                    if len(parts) >= d:
                        cap_name = PurePosixPath(parts[d - 1]).stem or parts[d - 1]

                if cap_name:
                    author_map = caps.setdefault(cap_name, {})
                    rec = author_map.setdefault(email, {"additions": 0, "deletions": 0})
                    rec["additions"] += adds
                    rec["deletions"] += dels

    result = []
    for cap_name, authors in caps.items():
        author_list = [
            {"email": email, "additions": s["additions"], "deletions": s["deletions"]}
            for email, s in authors.items()
        ]
        result.append({"name": cap_name, "authors": author_list})
    return result


# ---------------------------------------------------------------------------
# Payload assembly
# ---------------------------------------------------------------------------

def build_payload(
    pr_commits: list[tuple[str, str]] | None = None,
    commit_stats: dict[str, list[tuple[int, int, str]]] | None = None,
) -> dict | None:
    email_map: dict[str, str] = json.loads(env("EMAIL_MAP", "{}"))
    capability_map: list[dict] = json.loads(env("CAPABILITY_MAP", "[]"))

    repo = env("REPO")
    pr_number = env("PR_NUMBER")
    base_sha = env("BASE_SHA")
    head_sha = env("HEAD_SHA")

    if pr_commits is None:
        pr_commits = fetch_pr_commits(repo, pr_number)
    if commit_stats is None:
        commit_stats = fetch_commit_file_stats(base_sha, head_sha)
        if pr_commits and not commit_stats:
            gh_warning(
                f"git log produced no stats for {base_sha}...{head_sha} "
                "(shallow or missing checkout?); falling back to PR-opener attribution"
            )

    primary, co_authors, author_stats = determine_authors(pr_commits, commit_stats, email_map)

    # Fall back to PR opener if no commit authors resolved
    if not primary:
        pr_author = env("PR_AUTHOR")
        primary = resolve_email(pr_author, email_map)
        if not primary:
            gh_warning(f"No email mapping for author {pr_author}, skipping metrics")
            return None
        author_stats = [{"email": primary, "additions": int(env("PR_ADDITIONS", "0")),
                         "deletions": int(env("PR_DELETIONS", "0"))}]

    reviewers = collect_reviewers(repo, pr_number, email_map)
    tickets = extract_tickets(env("PR_TITLE"), env("PR_BODY"))
    capabilities = collect_capabilities(capability_map, pr_commits, commit_stats, email_map)

    repo_name = repo.split("/")[-1] if "/" in repo else repo

    return {
        "repository": repo_name,
        "pr_number": int(pr_number),
        "author": primary,
        "co_authors": co_authors or None,
        "author_stats": author_stats,
        "merged_at": env("PR_MERGED_AT"),
        "additions": int(env("PR_ADDITIONS", "0")),
        "deletions": int(env("PR_DELETIONS", "0")),
        "files": int(env("PR_FILES", "0")),
        "tickets": tickets or None,
        "reviewers": reviewers or None,
        "capabilities": capabilities or None,
    }


def main() -> None:
    # Remove any leftover payload so the wrapper's existence check can never
    # report a stale file from a previous invocation.
    try:
        os.remove(OUTPUT_PATH)
    except FileNotFoundError:
        pass

    payload = build_payload()
    if payload is None:
        sys.exit(0)

    with open(OUTPUT_PATH, "w") as f:
        json.dump(payload, f, indent=2)

    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
