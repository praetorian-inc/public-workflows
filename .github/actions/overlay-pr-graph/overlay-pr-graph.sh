#!/usr/bin/env bash
# Fail-open: merge a code-only extract of this checkout's changed files into
# $DEST/graph.json, then write $DEST/pr-head-notes.md for reviewers that cannot
# run the graphify CLI. Never fails the caller.
set -u

DEST="${DEST:-graphify-out}"
prev_dest=""
while [ "$DEST" != "$prev_dest" ] && [ "$DEST" != "/" ]; do
  prev_dest="$DEST"
  DEST="${DEST%/}"
  DEST="${DEST%/.}"
done
MAX_FILES="${MAX_FILES:-40}"

note() { printf 'overlay-pr-graph: %s\n' "$1"; }

record() {
  if [ -L "$DEST" ] || [ -L "$DEST/.graphify-provenance.json" ]; then
    note "refusing symlink provenance"
    return 0
  fi
  python3 -I - "$DEST/.graphify-provenance.json" "$1" "$2" <<'PY' || true
import json, os, sys, tempfile
path, status, detail = sys.argv[1], sys.argv[2], sys.argv[3]
if os.path.islink(path) or os.path.islink(os.path.dirname(path) or "."):
    sys.exit(0)
try:
    with open(path, encoding="utf-8") as fh:
        prov = json.load(fh)
    if not isinstance(prov, dict):
        prov = {}
except Exception:
    prov = {}
prov["overlay"] = status
prov["overlayDetail"] = detail
parent = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(prefix=".prov.", dir=parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(prov, fh, separators=(",", ":"))
        fh.write("\n")
    os.replace(tmp, path)
finally:
    if os.path.lexists(tmp):
        os.unlink(tmp)
PY
}

if [ ! -s "$DEST/graph.json" ]; then
  note "no graph.json; skip"
  exit 0
fi
if [ -L "$DEST" ] || [ -L "$DEST/graph.json" ]; then
  note "refusing symlink dest"
  exit 0
fi
if ! command -v graphify >/dev/null 2>&1; then
  note "graphify not on PATH; base graph unchanged"
  record "skipped" "no-cli"
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  record "skipped" "no-python"
  exit 0
fi

EXCLUDES=()
while IFS= read -r p; do
  [ -n "${p//[[:space:]]/}" ] && EXCLUDES+=(":(exclude)$p")
done <<EOF
${REVIEW_EXCLUDE_PATHSPECS-}
EOF
if [ "${#EXCLUDES[@]}" -gt 0 ]; then
  diff_status="$(git -c core.quotePath=false diff --name-status -M HEAD^1 HEAD -- . "${EXCLUDES[@]}" 2>/dev/null || true)"
  if [ -z "$diff_status" ]; then
    diff_status="$(git -c core.quotePath=false diff --name-status -M HEAD~1 HEAD -- . "${EXCLUDES[@]}" 2>/dev/null || true)"
  fi
else
  diff_status="$(git -c core.quotePath=false diff --name-status -M HEAD^1 HEAD 2>/dev/null || true)"
  if [ -z "$diff_status" ]; then
    diff_status="$(git -c core.quotePath=false diff --name-status -M HEAD~1 HEAD 2>/dev/null || true)"
  fi
fi
if [ -z "$diff_status" ]; then
  note "no changed files"
  record "skipped" "no-diff"
  exit 0
fi

is_source() {
  case "$1" in
    *.go|*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.py|*.rs|*.java|*.rb|*.php|*.cs|*.kt|*.swift) return 0 ;;
    *) return 1 ;;
  esac
}

src_files=""
drop_files=""
count=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  status="${line%%$'\t'*}"
  rest="${line#*$'\t'}"
  case "$status" in
    D)
      path="$rest"
      is_source "$path" || continue
      drop_files="${drop_files}${path}"$'\n'
      ;;
    R*|C*)
      old="${rest%%$'\t'*}"
      new="${rest#*$'\t'}"
      if is_source "$old"; then
        drop_files="${drop_files}${old}"$'\n'
      fi
      path="$new"
      ;;
    A|M)
      path="$rest"
      ;;
    *)
      continue
      ;;
  esac
  [ -n "${path:-}" ] || continue
  case "$path" in
    *../*|/*) continue ;;
  esac
  is_source "$path" || continue
  if [ -L "$path" ] || [ ! -f "$path" ]; then
    continue
  fi
  src_files="${src_files}${path}"$'\n'
  drop_files="${drop_files}${path}"$'\n'
  count=$((count + 1))
done <<EOF
$diff_status
EOF

if [ "$count" -eq 0 ] && [ -z "$drop_files" ]; then
  note "no extractable source files"
  record "skipped" "no-source"
  exit 0
fi
if [ "$count" -gt "$MAX_FILES" ]; then
  note "diff has $count source files; cap is $MAX_FILES"
  record "skipped" "too-many-files"
  exit 0
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/overlay-pr-graph.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/tree"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [ -L "$path" ]; then
    continue
  fi
  mkdir -p "$tmp/tree/$(dirname "$path")"
  cp -P -- "$path" "$tmp/tree/$path"
done <<EOF
$src_files
EOF

set +e
if [ "$count" -eq 0 ]; then
  mkdir -p "$tmp/out/graphify-out"
  printf '%s\n' '{"nodes":[],"edges":[]}' > "$tmp/out/graphify-out/graph.json"
  extract_rc=0
else
  ( cd "$tmp/tree" && graphify extract . --no-cluster --out "$tmp/out" ) >"$tmp/extract.log" 2>&1
  extract_rc=$?
fi
overlay_graph="$tmp/out/graphify-out/graph.json"
if [ "$extract_rc" -ne 0 ] || [ ! -s "$overlay_graph" ]; then
  note "extract failed; base graph unchanged"
  record "failed" "extract"
  exit 0
fi

if [ -L "$DEST/graph.json.labels" ]; then
  rm -f -- "$DEST/graph.json.labels"
fi
set +e
python3 -I - "$DEST/graph.json" "$overlay_graph" "$src_files" "$drop_files" <<'PY'
import json, os, sys, tempfile
base_path, overlay_path, raw_files, raw_drop = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
changed = {line for line in raw_files.splitlines() if line}
drop = {line for line in raw_drop.splitlines() if line} | changed
base = json.load(open(base_path, encoding="utf-8"))
overlay = json.load(open(overlay_path, encoding="utf-8"))
base_nodes = base.get("nodes")
overlay_nodes = overlay.get("nodes")
if not isinstance(base_nodes, list) or not isinstance(overlay_nodes, list):
    sys.exit(1)
drop_ids = set()
kept = []
for node in base_nodes:
    if not isinstance(node, dict):
        continue
    src = node.get("source_file")
    if isinstance(src, str) and src in drop:
        node_id = node.get("id")
        if isinstance(node_id, str):
            drop_ids.add(node_id)
        continue
    kept.append(node)
new_ids = set()
for node in overlay_nodes:
    if not isinstance(node, dict):
        continue
    node_id = node.get("id")
    if isinstance(node_id, str):
        new_ids.add(node_id)
        drop_ids.discard(node_id)
    kept.append(node)
def keep_edge(edge):
    if not isinstance(edge, dict):
        return False
    src = edge.get("source_file")
    if isinstance(src, str) and src in drop:
        return False
    for end in (edge.get("source"), edge.get("target")):
        if isinstance(end, str) and end in drop_ids and end not in new_ids:
            return False
    return True
base_edges = base.get("edges") if isinstance(base.get("edges"), list) else []
overlay_edges = overlay.get("edges") if isinstance(overlay.get("edges"), list) else []
merged_edges = [e for e in base_edges if keep_edge(e)]
merged_edges.extend(e for e in overlay_edges if isinstance(e, dict))
base["nodes"] = kept
base["edges"] = merged_edges
if os.path.islink(base_path) or os.path.islink(os.path.dirname(base_path) or "."):
    sys.exit(1)
parent = os.path.dirname(base_path) or "."
fd, tmp_path = tempfile.mkstemp(prefix=".graph.", dir=parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(base, fh, separators=(",", ":"))
        fh.write("\n")
    os.replace(tmp_path, base_path)
finally:
    if os.path.lexists(tmp_path):
        os.unlink(tmp_path)
labels = []
for node in overlay_nodes:
    if isinstance(node, dict) and isinstance(node.get("label"), str):
        labels.append(node["label"])
label_path = base_path + ".labels"
if os.path.islink(label_path):
    sys.exit(1)
fd, label_tmp = tempfile.mkstemp(prefix=".labels.", dir=parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("\n".join(labels[:12]) + "\n")
    os.replace(label_tmp, label_path)
finally:
    if os.path.lexists(label_tmp):
        os.unlink(label_tmp)
PY
merge_rc=$?
if [ "$merge_rc" -ne 0 ]; then
  note "merge failed; graph may be unchanged"
  record "failed" "merge"
  exit 0
fi

if [ -L "$DEST/pr-head-notes.md" ]; then
  note "refusing symlink notes"
  record "applied" "$count"
  exit 0
fi
notes="$DEST/pr-head-notes.md"
{
  printf '%s\n\n' "# PR-head graph notes"
  printf '%s\n\n' "Built by the review workflow from a code-only extract of this PR's changed source files, merged into the default-branch graph. Confirm every claim at file:line. This file exists because some reviewers cannot run the graphify CLI."
} > "$notes"
if [ -s "$DEST/graph.json.labels" ]; then
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    {
      printf '\n## %s\n\n' "$label"
      graphify explain "$label" --graph "$DEST/graph.json" 2>/dev/null || printf '%s\n' "(explain failed)"
    } >> "$notes"
  done < "$DEST/graph.json.labels"
fi
rm -f "$DEST/graph.json.labels"
record "applied" "$count"
note "applied overlay for $count file(s)"
exit 0
