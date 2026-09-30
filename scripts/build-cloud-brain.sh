#!/usr/bin/env bash
# The cloud brain Worker (docs/plan/cloud-brain.md, CB2): fetch the pinned
# ruvector sources the service builds on, then (optionally) test and build.
#
#   bash scripts/build-cloud-brain.sh           fetch, native tests, Worker build
#   bash scripts/build-cloud-brain.sh --fetch   fetch only (cloud-brain/build.sh runs this)
#   bash scripts/build-cloud-brain.sh --test    fetch, native tests, and a check that the Worker
#                                               still builds for wasm32-unknown-unknown (the
#                                               fallback target, D1; no Emscripten needed)
#
# ruvector-core (memory-only, a flat index) comes from upstream 5356a84e2, the
# commit the browser's wasm builds use, into cloud-brain/.work/ruvector
# (ignored by git; fetched again only when the pin or this script changes).
# RUVECTOR_SRC: a ruvector checkout that has the commit (else it is fetched,
# from shaal/ruvector if upstream stops serving it). Needs the cloud-brain
# toolchain (cloud-brain/README.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM=5356a84e2f784a33fa497da2e73440d469eb5542
DEST="$ROOT/cloud-brain/.work/ruvector"
# The crates the service needs, and the workspace files they inherit from.
PATHS=(Cargo.toml Cargo.lock crates/ruvector-core crates/ruvector-turboquant patches/hnsw_rs)
# The pin, the paths and this script: a change to any of them fetches again.
STAMP="$UPSTREAM $(printf '%s ' "${PATHS[@]}")$(shasum -a 256 "$0" | cut -c1-16)"
mode="${1:-all}"
tmp=""
held=0
trap 'if [[ -n "$tmp" ]]; then rm -rf "$tmp"; fi' EXIT

LOCK="$ROOT/cloud-brain/.work/.lock"
fetch() {
  if [[ -f "$DEST/.vv-source" && "$(cat "$DEST/.vv-source")" == "$STAMP" ]]; then return; fi
  # One fetch at a time (wrangler and a test may build together).
  mkdir -p "$(dirname "$LOCK")"
  local waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    sleep 1; waited=$((waited + 1))
    if (( waited > 600 )); then echo "build-cloud-brain: $LOCK held for 10 minutes; remove it if no fetch is running" >&2; exit 1; fi
  done
  held=1
  trap 'if (( held )); then rmdir "$LOCK" 2>/dev/null || true; fi; if [[ -n "$tmp" ]]; then rm -rf "$tmp"; fi' EXIT
  # Another fetch may have finished while this one waited.
  if [[ -f "$DEST/.vv-source" && "$(cat "$DEST/.vv-source")" == "$STAMP" ]]; then rmdir "$LOCK"; held=0; return; fi
  tmp="$(mktemp -d)"
  if [[ -n "${RUVECTOR_SRC:-}" ]] && git -C "$RUVECTOR_SRC" cat-file -e "$UPSTREAM^{commit}" 2>/dev/null; then
    git -C "$RUVECTOR_SRC" archive "$UPSTREAM" "${PATHS[@]}" | tar -x -C "$tmp"
  else
    git -C "$tmp" init -q src
    git -C "$tmp/src" remote add origin https://github.com/ruvnet/ruvector.git
    if ! git -C "$tmp/src" fetch -q --depth 1 origin "$UPSTREAM"; then
      git -C "$tmp/src" remote add fork https://github.com/shaal/ruvector.git
      git -C "$tmp/src" fetch -q --depth 1 fork "$UPSTREAM"
    fi
    git -C "$tmp/src" archive FETCH_HEAD "${PATHS[@]}" | tar -x -C "$tmp"
    rm -rf "$tmp/src"
  fi
  # A workspace of the two crates only: the rest of upstream is not fetched.
  python3 - "$tmp/Cargo.toml" <<'EOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(r'(?ms)^exclude = \[.*?\]\n', '', text, count=1)
text = re.sub(r'(?ms)^members = \[.*?\]\n', 'members = ["crates/ruvector-core", "crates/ruvector-turboquant"]\n', text, count=1)
text = re.sub(r'(?ms)^default-members = \[.*?\]\n', '', text, count=1)
open(path, 'w').write(text)
EOF
  rm -rf "$DEST"
  mkdir -p "$(dirname "$DEST")"
  mv "$tmp" "$DEST"
  tmp=""
  echo "$STAMP" > "$DEST/.vv-source"
  rmdir "$LOCK"
  held=0
  echo "build-cloud-brain: ruvector $UPSTREAM in cloud-brain/.work/ruvector"
}

fetch
[[ "$mode" == --fetch ]] && exit 0
cd "$ROOT/cloud-brain"
cargo test --locked -p vectorvroom-brain-core
cargo check --locked -p vectorvroom-brain --target wasm32-unknown-unknown
[[ "$mode" == --test ]] && exit 0
bash build.sh
