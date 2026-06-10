#!/usr/bin/env python3
"""Validate Agent Skill `SKILL.md` frontmatter.

Checks each skill's YAML frontmatter against the agentskills.io specification
(https://agentskills.io/specification) plus the Praetorian extensions `tags`
(controlled vocabulary) and `related` (skill links), both of which guard-core's
skill loader reads.

This is the canonical, locally-runnable copy of the validator that the
`skill-quality.yml` reusable workflow inlines for CI. Keep the two in sync.

Usage:
    python3 validate-skills.py                 # validate */SKILL.md in cwd
    python3 validate-skills.py --dir path/to/skills
    python3 validate-skills.py --glob '*/SKILL.md' --tags web,cloud,cicd,llm,cred

Requires: jsonschema, PyYAML.
Exit code: 0 if all skills valid, 1 otherwise.
"""
import argparse
import glob
import os
import sys

import yaml
from jsonschema import Draft202012Validator

DEFAULT_TAGS = ["web", "cloud", "cicd", "llm", "cred"]


def build_validator(tag_vocab):
    # agentskills.io core + Praetorian extensions. additionalProperties:false
    # catches frontmatter key typos (e.g. `descriptoin:`, `tag:`).
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "required": ["name", "description"],
        "properties": {
            "name": {"type": "string", "maxLength": 64,
                     "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$"},
            "description": {"type": "string", "minLength": 1, "maxLength": 1024},
            "license": {"type": "string"},
            "compatibility": {"type": "string", "maxLength": 500},
            "metadata": {"type": "object", "additionalProperties": {"type": "string"}},
            "allowed-tools": {"type": "string"},
            "tags": {"type": "array", "minItems": 1, "items": {"enum": tag_vocab}},
            "related": {"type": "array", "items": {"type": "string"}},
        },
    }
    return Draft202012Validator(schema)


def frontmatter(path):
    # utf-8-sig strips a leading BOM (some Windows editors prepend one); text
    # mode already normalizes CRLF/CR via universal newlines.
    with open(path, encoding="utf-8-sig") as fh:
        txt = fh.read()
    if not txt.startswith("---\n"):
        raise ValueError("missing leading '---' frontmatter")
    body = txt[4:]
    # Closing delimiter: a '---' line mid-file ('\n---\n') or at EOF with no
    # trailing newline ('\n---').
    end = body.find("\n---\n")
    if end == -1:
        if not body.endswith("\n---"):
            raise ValueError("unterminated frontmatter (no closing '---')")
        end = len(body) - 4
    return yaml.safe_load(body[:end])


def validate(directory, skills_glob, tag_vocab):
    validator = build_validator(tag_vocab)
    pattern = os.path.join(directory, skills_glob)
    files = sorted(
        f for f in glob.glob(pattern, recursive=True)
        if not os.path.basename(os.path.dirname(f)).startswith(("_", "."))
    )
    errors = []
    if not files:
        # A wrong --dir/--glob (or a repo whose layout drifted from the default)
        # would otherwise report success vacuously and silently disable the gate.
        errors.append(
            f"no SKILL.md matched '{pattern}' (after excluding _*/.* dirs) — "
            "check the working-directory / skills-glob")
        return files, errors
    for f in files:
        d = os.path.basename(os.path.dirname(f))
        try:
            fm = frontmatter(f)
        except Exception as e:  # noqa: BLE001 — surface any parse failure verbatim
            errors.append(f"{f}: invalid frontmatter — {e}")
            continue
        if not isinstance(fm, dict):
            errors.append(f"{f}: frontmatter is not a mapping")
            continue
        for err in sorted(validator.iter_errors(fm), key=lambda e: list(e.path)):
            loc = ".".join(map(str, err.path)) or "(root)"
            errors.append(f"{f}: [{loc}] {err.message}")
        if isinstance(fm.get("name"), str) and fm["name"] != d:
            errors.append(
                f"{f}: name '{fm['name']}' must equal parent directory '{d}' (agentskills.io)")
        at = fm.get("allowed-tools")
        if isinstance(at, str) and "," in at:
            errors.append(
                f"{f}: allowed-tools must be space-separated, not comma — got '{at}'")
    return files, errors


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=".", help="directory containing skill subdirectories")
    ap.add_argument("--glob", default="*/SKILL.md", help="glob for each skill's SKILL.md")
    ap.add_argument("--tags", default=",".join(DEFAULT_TAGS),
                    help="comma-separated controlled vocabulary for `tags`")
    args = ap.parse_args()
    tag_vocab = [t.strip() for t in args.tags.split(",") if t.strip()]

    files, errors = validate(args.dir, args.glob, tag_vocab)
    print(f"Validated {len(files)} skill(s) matching '{args.glob}' "
          f"(excluding _*/.* dirs)\n")
    if errors:
        print(f"❌ {len(errors)} problem(s):")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("✓ all skills conform to agentskills.io core + Praetorian extensions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
