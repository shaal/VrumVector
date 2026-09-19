#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
UPSTREAM=d5d3296cd90d688afae838d06a5fc2c023dd9107
git -C "$BUILD" init -q upstream
git -C "$BUILD/upstream" remote add origin https://github.com/ruvnet/ruvector.git
git -C "$BUILD/upstream" fetch -q --depth 1 origin "$UPSTREAM"
git -C "$BUILD/upstream" checkout -q --detach FETCH_HEAD
git -C "$BUILD/upstream" apply "$ROOT/scripts/ruvector-patches/gnn-online-training.patch"
# Compile the two added upstream modules as a small companion binding. This
# avoids bringing unrelated vector-store and native-only dependencies to WASM;
# legacy JsRuvectorLayer remains available in its existing vendored package.
mkdir -p "$BUILD/gnn/src"
cp "$BUILD/upstream/crates/ruvector-gnn/src/online.rs" "$BUILD/gnn/src/"
cp "$BUILD/upstream/crates/ruvector-gnn-wasm/src/online_wasm.rs" "$BUILD/gnn/src/"
printf 'pub mod online;\nmod online_wasm;\npub use online_wasm::WasmGraphRanker;\n' > "$BUILD/gnn/src/lib.rs"
cat > "$BUILD/gnn/Cargo.toml" <<'TOML'
[package]
name = "ruvector-gnn-trainable-wasm"
version = "0.1.0"
edition = "2021"
license = "MIT OR Apache-2.0"
repository = "https://github.com/shaal/VrumVector"
description = "Trainable browser lineage graph bindings for RuVector"
[workspace]
[lib]
crate-type = ["cdylib", "rlib"]
[dependencies]
serde = {version="1", features=["derive"]}
serde_json = {version="1", features=["float_roundtrip"]}
wasm-bindgen = "0.2"
[package.metadata.wasm-pack.profile.release]
wasm-opt = false
TOML
LOCK="$ROOT/scripts/ruvector-patches/gnn.Cargo.lock"
if [[ -f "$LOCK" ]]; then cp "$LOCK" "$BUILD/gnn/Cargo.lock"; else cargo generate-lockfile --manifest-path "$BUILD/gnn/Cargo.toml"; fi
cargo test --locked --manifest-path "$BUILD/gnn/Cargo.toml"
wasm-pack build "$BUILD/gnn" --target web --release --locked
cp "$BUILD/gnn/Cargo.lock" "$LOCK"
DEST="$ROOT/vendor/ruvector/ruvector_gnn_trainable_wasm"
mkdir -p "$DEST"
cp "$BUILD/gnn/pkg/ruvector_gnn_trainable_wasm"* "$DEST/"
{
  echo '# Trainable RuVector graph bindings'
  echo
  echo "Upstream: ruvnet/ruvector@$UPSTREAM."
  echo 'Companion build of the patched online.rs and online_wasm.rs modules; legacy GNN unchanged.'
  echo 'Rust 1.85.0; wasm-pack 0.13.1; web target; locked dependencies.'
  echo 'Rebuild with bash scripts/build-gnn-wasm.sh.'
  echo
  sha256sum "$ROOT/scripts/ruvector-patches/gnn-online-training.patch" "$DEST/ruvector_gnn_trainable_wasm_bg.wasm" | sed "s|$ROOT/||g"
} > "$DEST/VENDORED.md"
node "$ROOT/tests/gnn-wasm.mjs"
