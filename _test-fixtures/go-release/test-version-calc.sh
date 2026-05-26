#!/usr/bin/env bash
set -euo pipefail

# Unit tests for the version calculation algorithm used by
# go-release.yml and go-auto-tag.yml. Mirrors the inline bash
# script exactly — any change there must be reflected here.

PASSED=0
FAILED=0

TAG_PREFIX="v"
DEFAULT_BUMP="patch"
MAJOR_PATTERN="[major-release]"
MINOR_PATTERN="[minor-release]"
SEED_VERSION="0.1.0"

calc_version() {
  local latest_tag="$1"
  local commit_msg="$2"
  local branch="${3:-}"

  if [ -z "$latest_tag" ]; then
    echo "${TAG_PREFIX}${SEED_VERSION}"
    return
  fi

  local VERSION=${latest_tag#"$TAG_PREFIX"}
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+(-[a-zA-Z0-9._+-]+)?)?$ ]]; then
    echo "ERROR:invalid-semver"
    return
  fi

  local MAJOR MINOR PATCH
  MAJOR=$(echo "$VERSION" | cut -d. -f1)
  MINOR=$(echo "$VERSION" | cut -d. -f2)
  PATCH=$(echo "$VERSION" | cut -d. -f3 | cut -d- -f1)
  MAJOR=${MAJOR:-0}; MINOR=${MINOR:-0}; PATCH=${PATCH:-0}

  if ! [[ "$MAJOR" =~ ^[0-9]+$ && "$MINOR" =~ ^[0-9]+$ && "$PATCH" =~ ^[0-9]+$ ]]; then
    echo "ERROR:non-numeric"
    return
  fi

  local BUMP="$DEFAULT_BUMP"
  if printf "%s\n" "$commit_msg" | grep -qF "$MAJOR_PATTERN"; then
    BUMP="major"
  elif printf "%s\n" "$commit_msg" | grep -qF "$MINOR_PATTERN"; then
    BUMP="minor"
  elif [[ "$branch" == release/* || "$branch" == breaking/* ]]; then
    BUMP="major"
  elif [[ "$branch" == feat/* || "$branch" == feature/* ]]; then
    BUMP="minor"
  fi

  case "$BUMP" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
    *) echo "ERROR:invalid-bump"; return ;;
  esac

  echo "${TAG_PREFIX}${MAJOR}.${MINOR}.${PATCH}"
}

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $test_name"
    PASSED=$((PASSED + 1))
  else
    echo "  FAIL: $test_name (expected=$expected, got=$actual)"
    FAILED=$((FAILED + 1))
  fi
}

echo "=== Version Calculation Tests ==="
echo ""

echo "--- Seed version (no existing tags) ---"
assert_eq "no tags → v0.1.0" "v0.1.0" "$(calc_version "" "fix: something")"

echo "--- Patch bump (default) ---"
assert_eq "v1.2.3 + fix → v1.2.4" "v1.2.4" "$(calc_version "v1.2.3" "fix: something")"
assert_eq "v0.0.1 + chore → v0.0.2" "v0.0.2" "$(calc_version "v0.0.1" "chore: cleanup")"
assert_eq "v10.20.30 + fix → v10.20.31" "v10.20.31" "$(calc_version "v10.20.30" "fix: big numbers")"

echo "--- Minor bump ---"
assert_eq "v1.2.3 + [minor-release] → v1.3.0" "v1.3.0" "$(calc_version "v1.2.3" "feat: add foo [minor-release]")"
assert_eq "v1.2.3 + feat/ branch → v1.3.0" "v1.3.0" "$(calc_version "v1.2.3" "fix: something" "feat/add-thing")"
assert_eq "v1.2.3 + feature/ branch → v1.3.0" "v1.3.0" "$(calc_version "v1.2.3" "fix: something" "feature/add-thing")"

echo "--- Major bump ---"
assert_eq "v1.2.3 + [major-release] → v2.0.0" "v2.0.0" "$(calc_version "v1.2.3" "breaking: remove API [major-release]")"
assert_eq "v1.2.3 + release/ branch → v2.0.0" "v2.0.0" "$(calc_version "v1.2.3" "fix: something" "release/v2")"
assert_eq "v1.2.3 + breaking/ branch → v2.0.0" "v2.0.0" "$(calc_version "v1.2.3" "fix: something" "breaking/remove-api")"

echo "--- Pre-release suffix stripping ---"
assert_eq "v1.0.1-pre-guard-0 → v1.0.2" "v1.0.2" "$(calc_version "v1.0.1-pre-guard-0" "fix: something")"
assert_eq "v2.0.0-rc1 → v2.0.1" "v2.0.1" "$(calc_version "v2.0.0-rc1" "fix: something")"
assert_eq "v1.0.0-alpha → v1.0.1" "v1.0.1" "$(calc_version "v1.0.0-alpha" "fix: something")"

echo "--- Priority: commit message overrides branch name ---"
assert_eq "[major-release] overrides feat/ → v2.0.0" "v2.0.0" "$(calc_version "v1.2.3" "[major-release]" "feat/something")"
assert_eq "[minor-release] overrides release/ → v1.3.0" "v1.3.0" "$(calc_version "v1.2.3" "[minor-release]" "release/v2")"

echo "--- Edge cases ---"
assert_eq "v0.0.0 + patch → v0.0.1" "v0.0.1" "$(calc_version "v0.0.0" "fix: init")"
assert_eq "v0.0.0 + major → v1.0.0" "v1.0.0" "$(calc_version "v0.0.0" "[major-release]")"

echo "--- Custom TAG_PREFIX ---"
_save_TAG_PREFIX="$TAG_PREFIX"
TAG_PREFIX="release-"
assert_eq "release-1.2.3 + fix → release-1.2.4" "release-1.2.4" "$(calc_version "release-1.2.3" "fix: something")"
TAG_PREFIX="$_save_TAG_PREFIX"

echo "--- Custom SEED_VERSION ---"
_save_SEED_VERSION="$SEED_VERSION"
SEED_VERSION="1.0.0"
assert_eq "no tags + custom seed 1.0.0 → v1.0.0" "v1.0.0" "$(calc_version "" "fix: init")"
SEED_VERSION="$_save_SEED_VERSION"

echo "--- Custom DEFAULT_BUMP=minor ---"
_save_DEFAULT_BUMP="$DEFAULT_BUMP"
DEFAULT_BUMP="minor"
assert_eq "v1.2.3 + chore + default minor → v1.3.0" "v1.3.0" "$(calc_version "v1.2.3" "chore: something")"
DEFAULT_BUMP="$_save_DEFAULT_BUMP"

echo "--- Malformed tag missing patch component ---"
assert_eq "v1.2 (no patch) + fix → v1.2.1" "v1.2.1" "$(calc_version "v1.2" "fix: something")"

echo "--- Validation: rejects non-semver tags ---"
assert_eq "vfoo → rejected" "ERROR:invalid-semver" "$(calc_version "vfoo" "fix: something")"
assert_eq "v1 → rejected" "ERROR:invalid-semver" "$(calc_version "v1" "fix: something")"
assert_eq "v1.2.a[\$(id)] → rejected" "ERROR:invalid-semver" "$(calc_version 'v1.2.a[$(id)]' "fix: something")"

echo "--- Validation: rejects invalid bump ---"
_save_DEFAULT_BUMP="$DEFAULT_BUMP"
DEFAULT_BUMP="patchh"
assert_eq "invalid bump 'patchh' → rejected" "ERROR:invalid-bump" "$(calc_version "v1.2.3" "fix: something")"
DEFAULT_BUMP="$_save_DEFAULT_BUMP"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
