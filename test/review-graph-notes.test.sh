#!/usr/bin/env bash
# write-notes.sh explains the fetched graph. It must not extract.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO_ROOT/.github/actions/review-graph-notes/write-notes.sh"
PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }

if grep -q 'graphify extract' "$SCRIPT"; then
  bad "notes script does not extract" "extract invocation present"
else
  ok "notes script does not extract"
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/review-graph-notes.XXXXXX")"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/repo/graphify-out" "$T/repo/.grok-review"
cat > "$T/bin/graphify" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "extract" ]; then
  echo extract >&2
  exit 1
fi
if [ "$1" = "explain" ]; then
  if [ "$2" = "main" ]; then
    printf 'Source: src/untouched.txt\n'
  elif [ "$2" = "changed_main" ]; then
    printf 'Source: src/changed.txt\n'
  else
    printf 'explains %s\n' "$2"
  fi
  exit 0
fi
exit 1
EOF
chmod +x "$T/bin/graphify"
printf '%s\n' '{"nodes":[{"id":"untouched_main","label":"main","source_file":"src/untouched.txt"},{"id":"changed_main","label":"main","source_file":"src/changed.txt"}],"edges":[]}' > "$T/repo/graphify-out/graph.json"
printf '%s\n' "src/changed.txt" > "$T/repo/.grok-review/changed-files.txt"
(
  cd "$T/repo"
  PATH="$T/bin:$PATH" DEST=graphify-out CHANGED=.grok-review/changed-files.txt bash "$SCRIPT"
)
if grep -q 'Source: src/changed.txt' "$T/repo/graphify-out/pr-head-notes.md" && ! grep -q 'Source: src/untouched.txt' "$T/repo/graphify-out/pr-head-notes.md"; then
  ok "explain uses the changed node id, not the shared label"
else
  bad "explain uses the changed node id, not the shared label" "notes=$(cat "$T/repo/graphify-out/pr-head-notes.md" 2>/dev/null || echo missing)"
fi

printf '%s\n' '{"nodes":[{"id":"dup","label":"Dup","source_file":"src/dup.go"},{"id":"dup","label":"Dup","source_file":"src/dup.go"},{"id":"other","label":"Other","source_file":"src/dup.go"}],"edges":[]}' > "$T/repo/graphify-out/graph.json"
printf '%s\n' "src/dup.go" > "$T/repo/.grok-review/changed-files.txt"
rm -f "$T/repo/graphify-out/pr-head-notes.md"
(
  cd "$T/repo"
  PATH="$T/bin:$PATH" DEST=graphify-out CHANGED=.grok-review/changed-files.txt bash "$SCRIPT"
)
dup_count="$(grep -c 'explains dup' "$T/repo/graphify-out/pr-head-notes.md" || true)"
if [ "$dup_count" -eq 1 ] && grep -q 'explains other' "$T/repo/graphify-out/pr-head-notes.md"; then
  ok "duplicate node id is explained once"
else
  bad "duplicate node id is explained once" "dup_count=$dup_count"
fi

mkdir -p "$T/victim"
printf '%s\n' '{"nodes":[{"id":"kept","label":"keptFn","source_file":"pkg/old.go"}],"edges":[]}' > "$T/victim/graph.json"
printf 'SECRET\n' > "$T/victim/pr-head-notes.md"
rm -rf "$T/linkrepo"
mkdir -p "$T/linkrepo"
ln -s "$T/victim" "$T/linkrepo/graphify-out"
printf '%s\n' "pkg/old.go" > "$T/linkrepo/changed.txt"
(
  cd "$T/linkrepo"
  PATH="$T/bin:$PATH" DEST=graphify-out CHANGED=changed.txt bash "$SCRIPT"
)
if grep -q SECRET "$T/victim/pr-head-notes.md"; then
  ok "symlink dest is not written"
else
  bad "symlink dest is not written" "write-through"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
