#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
# Reproducible output: panic-location strings otherwise embed the random build
# folder and the local Cargo home (which includes the user's home folder name).
export RUSTFLAGS="--remap-path-prefix=$BUILD=/build --remap-path-prefix=$(cd "$BUILD" && pwd -P)=/build --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
UPSTREAM=5356a84e2f784a33fa497da2e73440d469eb5542
git -C "$BUILD" init -q upstream
git -C "$BUILD/upstream" remote add origin https://github.com/ruvnet/ruvector.git
# Upstream rewrote its history once; shaal/ruvector tags every base this repo
# has vendored (vv/*), so fall back to the fork if upstream stops serving it.
if ! git -C "$BUILD/upstream" fetch -q --depth 1 origin "$UPSTREAM"; then
  git -C "$BUILD/upstream" remote add fork https://github.com/shaal/ruvector.git
  git -C "$BUILD/upstream" fetch -q --depth 1 fork "$UPSTREAM"
fi
git -C "$BUILD/upstream" checkout -q --detach FETCH_HEAD
for patch in "$ROOT"/scripts/ruvector-patches/sona-*.patch; do
  git -C "$BUILD/upstream" apply "$patch"
done
cp -R "$BUILD/upstream/crates/sona" "$BUILD/sona"
printf '\n[workspace]\n' >> "$BUILD/sona/Cargo.toml"
LOCK="$ROOT/scripts/ruvector-patches/sona.Cargo.lock"
if [[ -f "$LOCK" ]]; then cp "$LOCK" "$BUILD/sona/Cargo.lock"; else cargo generate-lockfile --manifest-path "$BUILD/sona/Cargo.toml"; fi
cargo test --locked --manifest-path "$BUILD/sona/Cargo.toml" checkpoint::tests
wasm-pack build "$BUILD/sona" --target web --release --features wasm --locked
cp "$BUILD/sona/Cargo.lock" "$LOCK"
DEST="$ROOT/vendor/ruvector/sona"
cp "$BUILD/sona/pkg/ruvector_sona.js" "$BUILD/sona/pkg/ruvector_sona_bg.wasm" "$BUILD/sona/pkg/ruvector_sona.d.ts" "$BUILD/sona/pkg/ruvector_sona_bg.wasm.d.ts" "$DEST/"
{
  echo '# SONA checkpoint build'
  echo
  echo "Upstream: ruvnet/ruvector@$UPSTREAM (crates/sona)."
  echo 'Rust 1.85.0; wasm-pack 0.13.1; target web; features wasm; locked dependencies; build paths remapped (reproducible).'
  echo 'Rebuild with bash scripts/build-learning-wasm.sh.'
  echo
  echo 'Applied patches and generated binary SHA-256:'
  sha256sum "$ROOT"/scripts/ruvector-patches/sona-*.patch "$DEST/ruvector_sona_bg.wasm" | sed "s|$ROOT/||g"
} > "$DEST/VENDORED.md"
node "$ROOT/tests/learning-wasm.mjs"
