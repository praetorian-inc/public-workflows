#!/usr/bin/env bash
# Fail-open contract for overlay-pr-graph.sh. No network. A fake graphify
# stands in for the pinned CLI.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO_ROOT/.github/actions/overlay-pr-graph/overlay-pr-graph.sh"
PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: missing $SCRIPT" >&2
  exit 1
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/overlay-pr-graph-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/bin" "$T/repo/graphify-out"
cat > "$T/bin/graphify" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "extract" ]; then
  out=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--out" ]; then
      out="$arg"
    fi
    prev="$arg"
  done
  mkdir -p "$out/graphify-out"
  printf '%s\n' '{"nodes":[{"id":"new_fn","label":"newFn","source_file":"pkg/new.go","source_location":"L1"}],"edges":[{"source":"new_fn","target":"kept","relation":"calls","source_file":"pkg/new.go"}]}' > "$out/graphify-out/graph.json"
  exit 0
fi
if [ "$1" = "explain" ]; then
  printf 'explains %s\n' "$2"
  exit 0
fi
exit 1
EOF
chmod +x "$T/bin/graphify"

git -C "$T/repo" init -q
git -C "$T/repo" config user.email "t@example.com"
git -C "$T/repo" config user.name "t"
printf 'package old\n' > "$T/repo/pkg_old.go"
mkdir -p "$T/repo/pkg"
git -C "$T/repo" add pkg_old.go
git -C "$T/repo" commit -q -m base
printf 'package p\nfunc newFn() {}\n' > "$T/repo/pkg/new.go"
git -C "$T/repo" add pkg/new.go
git -C "$T/repo" commit -q -m head

printf '%s\n' '{"nodes":[{"id":"stale","label":"stale","source_file":"pkg/new.go"},{"id":"kept","label":"kept","source_file":"pkg/old.go"}],"edges":[{"source":"stale","target":"kept","relation":"calls","source_file":"pkg/new.go"},{"source":"kept","target":"kept","relation":"contains","source_file":"pkg/old.go"}]}' > "$T/repo/graphify-out/graph.json"
printf '%s\n' '{"headSha":"base"}' > "$T/repo/graphify-out/.graphify-provenance.json"

(
  cd "$T/repo"
  PATH="$T/bin:$PATH" DEST=graphify-out MAX_FILES=40 bash "$SCRIPT"
)

python3 -I - "$T/repo/graphify-out/graph.json" <<'PY'
import json, sys
g = json.load(open(sys.argv[1], encoding="utf-8"))
ids = {n["id"] for n in g["nodes"]}
assert "stale" not in ids, ids
assert "new_fn" in ids, ids
assert "kept" in ids, ids
edge_files = {e.get("source_file") for e in g["edges"]}
assert "pkg/old.go" in edge_files, edge_files
assert any(e.get("source") == "new_fn" for e in g["edges"])
PY
if [ $? -eq 0 ]; then
  ok "replaces nodes for changed files and keeps the rest"
else
  bad "replaces nodes for changed files and keeps the rest" "merge assertion failed"
fi

if grep -q 'explains newFn' "$T/repo/graphify-out/pr-head-notes.md" 2>/dev/null; then
  ok "writes explain notes for overlay labels"
else
  bad "writes explain notes for overlay labels" "notes=$(cat "$T/repo/graphify-out/pr-head-notes.md" 2>/dev/null || echo missing)"
fi

prov="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["overlay"])' "$T/repo/graphify-out/.graphify-provenance.json")"
if [ "$prov" = "applied" ]; then
  ok "provenance overlay=applied"
else
  bad "provenance overlay=applied" "got ${prov}"
fi

printf '%s\n' '{"nodes":[{"id":"only","label":"only","source_file":"a.go"}],"edges":[]}' > "$T/repo/graphify-out/graph.json"
(
  cd "$T/repo"
  PATH="/usr/bin:/bin" DEST=graphify-out bash "$SCRIPT"
)
if python3 -I -c 'import json,sys; assert json.load(open(sys.argv[1]))["nodes"][0]["id"]=="only"' "$T/repo/graphify-out/graph.json"; then
  ok "missing CLI leaves the base graph"
else
  bad "missing CLI leaves the base graph" "graph changed without CLI"
fi

for wf in claude-code.yml codex-code.yml gemini-code.yml grok-code.yml; do
  if grep -q 'bash _pw/.github/actions/overlay-pr-graph/overlay-pr-graph.sh' "$REPO_ROOT/.github/workflows/$wf"; then
    ok "$wf calls overlay-pr-graph"
  else
    bad "$wf calls overlay-pr-graph" "step missing"
  fi
done

mkdir -p "$T/victim" "$T/linkrepo"
printf 'SECRET\n' > "$T/victim/.graphify-provenance.json"
ln -s "$T/victim" "$T/linkrepo/graphify-out"
printf '%s\n' '{"nodes":[{"id":"x","label":"x","source_file":"a.go"}],"edges":[]}' > "$T/victim/graph.json"
(
  cd "$T/linkrepo"
  PATH="$T/bin:$PATH" DEST=graphify-out bash "$SCRIPT"
)
if grep -q SECRET "$T/victim/.graphify-provenance.json"; then
  ok "symlink dest is not written"
else
  bad "symlink dest is not written" "provenance was replaced through the link"
fi

mkdir -p "$T/slashvictim" "$T/slashrepo"
printf 'SECRET\n' > "$T/slashvictim/.graphify-provenance.json"
printf '%s\n' '{"nodes":[{"id":"x","label":"x","source_file":"a.go"}],"edges":[]}' > "$T/slashvictim/graph.json"
ln -s "$T/slashvictim" "$T/slashrepo/graphify-out"
(
  cd "$T/slashrepo"
  PATH="$T/bin:$PATH" DEST=graphify-out/ bash "$SCRIPT"
)
if grep -q SECRET "$T/slashvictim/.graphify-provenance.json" && ! grep -q new_fn "$T/slashvictim/graph.json"; then
  ok "trailing-slash symlink dest is not written"
else
  bad "trailing-slash symlink dest is not written" "write-through with DEST=graphify-out/"
fi

for form in 'graphify-out/.' 'graphify-out/./'; do
  mkdir -p "$T/dotvictim"
  printf 'SECRET\n' > "$T/dotvictim/.graphify-provenance.json"
  printf '%s\n' '{"nodes":[{"id":"x","label":"x","source_file":"a.go"}],"edges":[]}' > "$T/dotvictim/graph.json"
  rm -rf "$T/dotrepo"
  mkdir -p "$T/dotrepo"
  ln -s "$T/dotvictim" "$T/dotrepo/graphify-out"
  (
    cd "$T/dotrepo"
    PATH="$T/bin:$PATH" DEST="$form" bash "$SCRIPT"
  )
  if grep -q SECRET "$T/dotvictim/.graphify-provenance.json" && ! grep -q new_fn "$T/dotvictim/graph.json"; then
    ok "symlink dest form $form is not written"
  else
    bad "symlink dest form $form is not written" "write-through"
  fi
done

mkdir -p "$T/delrepo/graphify-out" "$T/delrepo/pkg"
git -C "$T/delrepo" init -q
git -C "$T/delrepo" config user.email "t@example.com"
git -C "$T/delrepo" config user.name "t"
printf 'package gone\n' > "$T/delrepo/pkg/gone.go"
printf 'package keep\n' > "$T/delrepo/pkg/keep.go"
git -C "$T/delrepo" add pkg
git -C "$T/delrepo" commit -q -m base
git -C "$T/delrepo" rm -q pkg/gone.go
git -C "$T/delrepo" commit -q -m drop
printf '%s\n' '{"nodes":[{"id":"gone","label":"gone","source_file":"pkg/gone.go"},{"id":"keep","label":"keep","source_file":"pkg/keep.go"}],"edges":[{"source":"gone","target":"keep","relation":"calls","source_file":"pkg/gone.go"}]}' > "$T/delrepo/graphify-out/graph.json"
printf '%s\n' '{"headSha":"base"}' > "$T/delrepo/graphify-out/.graphify-provenance.json"
(
  cd "$T/delrepo"
  PATH="$T/bin:$PATH" DEST=graphify-out bash "$SCRIPT"
)
if python3 -I -c 'import json,sys; g=json.load(open(sys.argv[1])); ids={n["id"] for n in g["nodes"]}; assert "gone" not in ids, ids; assert "keep" in ids; assert all(e.get("source_file")!="pkg/gone.go" for e in g["edges"])' "$T/delrepo/graphify-out/graph.json"; then
  ok "deleted source drops stale nodes"
else
  bad "deleted source drops stale nodes" "stale node remained"
fi

mkdir -p "$T/exrepo/graphify-out" "$T/exrepo/pkg" "$T/exrepo/gen"
git -C "$T/exrepo" init -q
git -C "$T/exrepo" config user.email "t@example.com"
git -C "$T/exrepo" config user.name "t"
printf 'package old\n' > "$T/exrepo/pkg/old.go"
git -C "$T/exrepo" add pkg/old.go
git -C "$T/exrepo" commit -q -m base
printf 'package gen\n' > "$T/exrepo/gen/out.go"
git -C "$T/exrepo" add gen/out.go
git -C "$T/exrepo" commit -q -m head
printf '%s\n' '{"nodes":[{"id":"gen","label":"gen","source_file":"gen/out.go"},{"id":"kept","label":"kept","source_file":"pkg/old.go"}],"edges":[]}' > "$T/exrepo/graphify-out/graph.json"
printf '%s\n' '{"headSha":"base"}' > "$T/exrepo/graphify-out/.graphify-provenance.json"
(
  cd "$T/exrepo"
  PATH="$T/bin:$PATH" DEST=graphify-out REVIEW_EXCLUDE_PATHSPECS='gen/*' bash "$SCRIPT"
)
prov="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("overlay"))' "$T/exrepo/graphify-out/.graphify-provenance.json")"
if [ "$prov" = "skipped" ] && python3 -I -c 'import json,sys; ids={n["id"] for n in json.load(open(sys.argv[1]))["nodes"]}; assert "gen" in ids' "$T/exrepo/graphify-out/graph.json"; then
  ok "exclude pathspec skips generated source"
else
  bad "exclude pathspec skips generated source" "overlay=$prov"
fi

printf 'VICTIM\n' > "$T/victim-tmp"
ln -sf "$T/victim-tmp" "$T/repo/graphify-out/graph.json.tmp"
(
  cd "$T/repo"
  PATH="$T/bin:$PATH" DEST=graphify-out bash "$SCRIPT"
)
if grep -q VICTIM "$T/victim-tmp" && [ ! -L "$T/repo/graphify-out/graph.json" ]; then
  ok "graph.json.tmp symlink is not followed"
else
  bad "graph.json.tmp symlink is not followed" "write-through"
fi

printf 'VICTIM\n' > "$T/victim-prov"
ln -sf "$T/victim-prov" "$T/repo/graphify-out/.graphify-provenance.json.tmp"
(
  cd "$T/repo"
  PATH="/usr/bin:/bin" DEST=graphify-out bash "$SCRIPT"
)
if grep -q VICTIM "$T/victim-prov"; then
  ok "provenance tmp symlink is not followed"
else
  bad "provenance tmp symlink is not followed" "write-through"
fi

for wf in claude-code.yml codex-code.yml gemini-code.yml grok-code.yml; do
  if awk '/Clear _pw before the overlay-script checkout/,/Checkout overlay script/' "$REPO_ROOT/.github/workflows/$wf" | grep -q 'rm -rf -- _pw'; then
    ok "$wf clears _pw before overlay checkout"
  else
    bad "$wf clears _pw before overlay checkout" "clear step missing"
  fi
done

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
