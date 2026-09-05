#!/usr/bin/env bash
# Fail-open fetch of the latest successful graphify-graph.yml artifact (ENG-5658).
#
# Always exits 0. A missing workflow, run, artifact, or any API/download
# failure writes present=false and leaves DEST empty of graph.json — the
# review job continues without a graph. Never fails a review over this.
#
# Env (all optional except a token):
#   GH_TOKEN / GITHUB_TOKEN  — token with actions:read on GITHUB_REPOSITORY
#   GITHUB_REPOSITORY        — owner/repo (Actions provides this)
#   DEST                     — directory to place graph.json (default: graphify-out)
#   GITHUB_OUTPUT            — if set, writes present, head_sha, skip_reason, run_id
#
# On present=true:
#   $DEST/graph.json
#   $DEST/.graphify-provenance.json  (best-effort; missing sidecar is not a skip)
set -u

present=false
head_sha=""
skip_reason=""
run_id=""
head_branch=""
run_url=""
run_updated=""

DEST="${DEST:-graphify-out}"
slug="${GITHUB_REPOSITORY:-}"

emit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      printf 'present=%s\n' "$present"
      printf 'head_sha=%s\n' "$head_sha"
      printf 'skip_reason=%s\n' "$skip_reason"
      printf 'run_id=%s\n' "$run_id"
    } >> "$GITHUB_OUTPUT"
  fi
  if [ "$present" = "true" ]; then
    echo "graph present run_id=${run_id} head_sha=${head_sha}"
  else
    echo "graph skipped: ${skip_reason:-unknown}"
  fi
}

finish() {
  emit
  exit 0
}

skip() {
  skip_reason=$1
  present=false
  finish
}

# Token: prefer GH_TOKEN (gh's documented var), then GITHUB_TOKEN.
if [ -z "${GH_TOKEN:-}" ]; then
  GH_TOKEN="${GITHUB_TOKEN:-}"
fi
export GH_TOKEN
export GH_PROMPT_DISABLED=1
export GH_NO_UPDATE_NOTIFIER=1

if [ -z "$GH_TOKEN" ]; then
  skip "no-token"
fi
if [ -z "$slug" ]; then
  skip "no-repo"
fi
case "$slug" in
  */*) ;;
  *) skip "bad-repo" ;;
esac

# Every gh/python failure becomes a skip, never a job failure.
set +e
br=$(gh api "repos/${slug}" --jq '.default_branch' 2>/dev/null)
rc=$?
set -e
if [ "$rc" -ne 0 ] || [ -z "$br" ]; then
  skip "no-default-branch"
fi

set +e
run_json=$(gh run list -R "$slug" --workflow graphify-graph.yml --status success \
  --branch "$br" -L 1 \
  --json databaseId,headSha,headBranch,url,updatedAt \
  --jq '.[0] // empty' 2>/dev/null)
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  skip "api-error"
fi
if [ -z "$run_json" ]; then
  skip "no-run"
fi

set +e
run_id=$(printf '%s' "$run_json" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["databaseId"])' 2>/dev/null)
head_sha=$(printf '%s' "$run_json" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("headSha") or "")' 2>/dev/null)
head_branch=$(printf '%s' "$run_json" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("headBranch") or "")' 2>/dev/null)
run_url=$(printf '%s' "$run_json" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("url") or "")' 2>/dev/null)
run_updated=$(printf '%s' "$run_json" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("updatedAt") or "")' 2>/dev/null)
set -e
case "$run_id" in
  ''|*[!0-9]*) skip "bad-run-json" ;;
esac

set +e
names=$(gh api "repos/${slug}/actions/runs/${run_id}/artifacts" --jq '.artifacts[].name' 2>/dev/null)
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  skip "api-error"
fi
if [ -z "$names" ]; then
  skip "no-artifact"
fi

count=$(printf '%s\n' "$names" | grep -c . || true)
artifact=""
if [ "$count" -eq 1 ]; then
  artifact=$names
else
  graphs=$(printf '%s\n' "$names" | grep -- '-graph$' || true)
  gcount=$(printf '%s\n' "$graphs" | grep -c . || true)
  if [ "$gcount" -eq 1 ]; then
    artifact=$graphs
  else
    skip "ambiguous-artifact"
  fi
fi
# Artifact names are an allowlist matching graphify-graph.yml's own gate.
case "$artifact" in
  ""|*[!A-Za-z0-9._-]*) skip "bad-artifact-name" ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/fetch-review-graph.XXXXXX") || skip "mktemp-failed"
# shellcheck disable=SC2064
trap 'rm -rf -- "$tmp"' EXIT

set +e
gh run download -R "$slug" "$run_id" -n "$artifact" -D "$tmp" >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  skip "download-failed"
fi

graph=""
if [ -f "$tmp/graph.json" ]; then
  graph="$tmp/graph.json"
else
  # upload-artifact of a nested path can preserve graphify-out/graph.json
  set +e
  graph=$(find "$tmp" -name graph.json -type f -print 2>/dev/null | head -n 1)
  set -e
fi
if [ -z "$graph" ] || [ ! -s "$graph" ]; then
  skip "invalid-graph"
fi

set +e
python3 -I -c 'import json,sys; n=json.load(open(sys.argv[1], encoding="utf-8")).get("nodes"); assert isinstance(n, list) and len(n) > 0' "$graph"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  skip "invalid-graph"
fi

mkdir -p -- "$DEST" || skip "dest-failed"
# Refuse to write through a symlink DEST (PR-planted link could escape the workspace).
if [ -L "$DEST" ]; then
  skip "dest-symlink"
fi
cp -f -- "$graph" "$DEST/graph.json" || skip "copy-failed"

fetched_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || true)
prov="$DEST/.graphify-provenance.json"
set +e
python3 -I -c '
import json, sys
out = {
    "fetchedAt": sys.argv[1],
    "headBranch": sys.argv[2],
    "headSha": sys.argv[3],
    "repo": sys.argv[4],
    "runCompletedAt": sys.argv[5],
    "workflowRunId": int(sys.argv[6]),
    "workflowRunUrl": sys.argv[7],
}
open(sys.argv[8], "w", encoding="utf-8").write(json.dumps(out, separators=(",", ":")) + "\n")
' "${fetched_at}" "${head_branch}" "${head_sha}" "${slug}" "${run_updated}" "${run_id}" "${run_url}" "$prov"
prov_rc=$?
set -e
if [ "$prov_rc" -ne 0 ]; then
  echo "WARNING: could not write provenance sidecar (graph is present; freshness falls back to file mtime)"
  rm -f -- "$prov"
fi

present=true
skip_reason=""
finish
