#!/usr/bin/env bash
# CB0 (docs/plan/cloud-brain.md): which ruvector crates and features build for
# wasm32-unknown-emscripten (and, for comparison, wasm32-unknown-unknown), and
# whether the Emscripten builds run. Prints a Markdown table; recorded in
# docs/validation/cloud-brain-spike.md. The probe is a plain program linked by
# emcc for Node (-Cpanic=abort), not built like the Worker; on
# wasm32-unknown-unknown "builds" means it compiles, nothing runs.
#
# Source: ruvnet/ruvector at the pinned commit the browser builds use. Set
# RUVECTOR_SRC to a local checkout that has the commit to skip the download.
# Needs the cloud-brain toolchain: the dated beta in cloud-brain/
# rust-toolchain.toml, and Emscripten as worker-build provisions it (run
# `bash cloud-brain/build.sh` once).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM=5356a84e2f784a33fa497da2e73440d469eb5542
TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$ROOT/cloud-brain/rust-toolchain.toml")"
CACHE="${WORKER_BUILD_CACHE:-$HOME/Library/Caches/worker-build}"
[[ -d "$CACHE" ]] || CACHE="$HOME/.cache/worker-build"
EMCC_DIR="$(ls -d "$CACHE"/emsdk-*/upstream/emscripten | sort -V | tail -1)"
export EM_CONFIG="$(ls "$CACHE"/emscripten-*.config | sort -V | tail -1)"
export PATH="$EMCC_DIR:$PATH"
WORK="$(mktemp -d)"
# KEEP_WORK=1 keeps the build folder (and its logs) for a look afterwards.
if [[ -z "${KEEP_WORK:-}" ]]; then trap 'rm -rf "$WORK"' EXIT; else echo "work: $WORK" >&2; fi
# Upstream's Cargo.lock pins the dependency versions (cargo prunes it to the
# probe, without --locked).
PATHS=(Cargo.toml Cargo.lock crates/ruvector-core crates/ruvector-turboquant crates/sona crates/ruvector-hyperbolic-hnsw patches/hnsw_rs)
if [[ -n "${RUVECTOR_SRC:-}" ]] && git -C "$RUVECTOR_SRC" cat-file -e "$UPSTREAM^{commit}" 2>/dev/null; then
  git -C "$RUVECTOR_SRC" archive "$UPSTREAM" "${PATHS[@]}" | tar -x -C "$WORK"
else
  git -C "$WORK" init -q src
  git -C "$WORK/src" remote add origin https://github.com/ruvnet/ruvector.git
  git -C "$WORK/src" fetch -q --depth 1 origin "$UPSTREAM"
  git -C "$WORK/src" archive FETCH_HEAD "${PATHS[@]}" | tar -x -C "$WORK"
fi
# One workspace member (the probe); keep upstream's dependency table, package
# defaults and hnsw_rs patch.
python3 - "$WORK/Cargo.toml" <<'EOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(r'(?ms)^exclude = \[.*?\]\n', '', text, count=1)
text = re.sub(r'(?ms)^members = \[.*?\]\n', 'members = ["probe"]\n', text, count=1)
text = re.sub(r'(?ms)^default-members = \[.*?\]\n', '', text, count=1)
open(path, 'w').write(text)
EOF
mkdir -p "$WORK/probe/src"
cat > "$WORK/probe/Cargo.toml" <<'EOF'
[package]
name = "probe"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
ruvector-core = { path = "../crates/ruvector-core", default-features = false, optional = true }
ruvector-hyperbolic-hnsw = { path = "../crates/ruvector-hyperbolic-hnsw", default-features = false, optional = true }
ruvector-sona = { package = "ruvector-sona", path = "../crates/sona", optional = true }

# wasm32-unknown-unknown has no random source by default; the browser builds
# give getrandom its JavaScript backend, and so does this comparison.
[target.'cfg(all(target_arch = "wasm32", target_os = "unknown"))'.dependencies]
getrandom02 = { package = "getrandom", version = "0.2", features = ["js"] }
getrandom03 = { package = "getrandom", version = "0.3", features = ["wasm_js"] }

[features]
core-memory = ["dep:ruvector-core", "ruvector-core/memory-only"]
core-storage = ["dep:ruvector-core", "ruvector-core/storage"]
core-simd = ["dep:ruvector-core", "ruvector-core/memory-only", "ruvector-core/simd"]
core-hnsw = ["dep:ruvector-core", "ruvector-core/memory-only", "ruvector-core/hnsw"]
hyperbolic = ["dep:ruvector-hyperbolic-hnsw"]
sona = ["dep:ruvector-sona"]

[profile.release]
opt-level = "s"
EOF
cat > "$WORK/probe/src/main.rs" <<'EOF'
// Uses each crate, so a build links it. With ruvector-core: 20 000 random
// 244-float brains into a VectorDB, then 10 searches, timed with std::time.
#[allow(unused_imports)]
use std::time::Instant;

fn main() {
    #[cfg(any(feature = "core-memory", feature = "core-storage", feature = "core-simd", feature = "core-hnsw"))]
    {
        use ruvector_core::types::{DbOptions, DistanceMetric, SearchQuery, VectorEntry};
        use ruvector_core::VectorDB;
        let mut options = DbOptions::default();
        options.dimensions = 244;
        options.distance_metric = DistanceMetric::Cosine;
        options.storage_path = std::env::temp_dir().join("probe.db").to_string_lossy().into_owned();
        let db = VectorDB::new(options).expect("VectorDB::new");
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; (seed >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0 };
        let t0 = Instant::now();
        for i in 0..20_000 {
            let vector: Vec<f32> = (0..244).map(|_| next()).collect();
            db.insert(VectorEntry { id: Some(format!("b{i}")), vector, metadata: None }).expect("insert");
        }
        let insert_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        let mut hits = 0;
        for _ in 0..10 {
            let vector: Vec<f32> = (0..244).map(|_| next()).collect();
            hits += db.search(SearchQuery { vector, k: 10, filter: None, ef_search: None }).expect("search").len();
        }
        println!("ruvector-core: 20000 inserts {insert_ms:.0} ms, 10 searches {:.1} ms, {hits} hits", t1.elapsed().as_secs_f64() * 1000.0);
    }
    #[cfg(feature = "hyperbolic")]
    {
        // 2 000 points in the Poincare ball (16 dims), then 10 searches.
        let mut index = ruvector_hyperbolic_hnsw::HyperbolicHnsw::default_config();
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; ((seed >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.2 };
        let t0 = Instant::now();
        for _ in 0..2_000 { index.insert((0..16).map(|_| next()).collect()).expect("insert"); }
        let insert_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        let mut hits = 0;
        for _ in 0..10 { let q: Vec<f32> = (0..16).map(|_| next()).collect(); hits += index.search(&q, 5).expect("search").len(); }
        println!("hyperbolic-hnsw: 2000 inserts {insert_ms:.0} ms, 10 searches {:.1} ms, {hits} hits", t1.elapsed().as_secs_f64() * 1000.0);
    }
    #[cfg(feature = "sona")]
    {
        // An agent learns 200 tasks and hands its state to a coordinator (the
        // federated path CB6 uses). session_duration_ms comes from SONA's
        // time_compat clock: 0 means the clock reads 0 on this target.
        use ruvector_sona::{EphemeralAgent, FederatedCoordinator};
        let t0 = Instant::now();
        let mut agent = EphemeralAgent::default_federated("probe", 64);
        for i in 0..200 { agent.process_task((0..64).map(|j| ((i * 31 + j) % 17) as f32 / 17.0).collect(), 0.7); }
        let spin = Instant::now();
        while spin.elapsed().as_millis() < 50 { std::hint::spin_loop(); }
        let export = agent.export_state();
        let duration = export.session_duration_ms;
        let mut coordinator = FederatedCoordinator::default_coordinator("probe-coordinator", 64);
        let result = coordinator.aggregate(export);
        println!("sona: 200 tasks + aggregate {:.0} ms, accepted {}, session_duration_ms {duration} (std clock {} s since 1970)",
            t0.elapsed().as_secs_f64() * 1000.0, result.trajectories_accepted,
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    }
}
EOF
export CARGO_TARGET_DIR="$WORK/target"
EMFLAGS="-Cpanic=abort -Cllvm-args=-enable-emscripten-cxx-exceptions=0 -Crelocation-model=static -Clink-arg=-sALLOW_MEMORY_GROWTH -Clink-arg=-sENVIRONMENT=node"
echo "| Configuration | wasm32-unknown-emscripten | runs (Node) | wasm32-unknown-unknown |"
echo "|---|---|---|---|"
for config in core-memory core-storage core-simd core-hnsw hyperbolic sona; do
  row="| \`$config\` |"
  log="$WORK/$config-emscripten.log"
  if RUSTFLAGS="$EMFLAGS" cargo "+$TOOLCHAIN" build -q --release --manifest-path "$WORK/probe/Cargo.toml" \
      --target wasm32-unknown-emscripten --features "$config" >"$log" 2>&1; then
    js="$CARGO_TARGET_DIR/wasm32-unknown-emscripten/release/probe.js"
    wasm="$CARGO_TARGET_DIR/wasm32-unknown-emscripten/release/probe.wasm"
    size=$(( $(wc -c <"$wasm") / 1024 ))
    row+=" builds, ${size} KB |"
    if out="$(node "$js" 2>&1)"; then row+=" $(echo "$out" | tail -1) |"; else row+=" fails: $( { echo "$out" | grep -m1 -i -E 'error|abort|panic' || echo 'no output'; } | cut -c1-90) |"; fi
    cp "$js" "$WORK/$config.js" 2>/dev/null || true
  else
    row+=" fails: $( { grep -m1 -E '^error' "$log" || echo 'error (see log)'; } | cut -c1-70) in $( { grep -m1 -E '^ *--> ' "$log" || echo 'unknown'; } | sed 's#.*/registry/src/[^/]*/##; s#^ *--> ##' | cut -c1-50) |"
    row+=" — |"
  fi
  log="$WORK/$config-unknown.log"
  if RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo "+$TOOLCHAIN" build -q --release --manifest-path "$WORK/probe/Cargo.toml" \
      --target wasm32-unknown-unknown --features "$config" >"$log" 2>&1; then
    row+=" builds |"
  else
    row+=" fails: $( { grep -m1 -E '^error' "$log" || echo 'error (see log)'; } | cut -c1-70) in $( { grep -m1 -E '^ *--> ' "$log" || echo 'unknown'; } | sed 's#.*/registry/src/[^/]*/##; s#^ *--> ##' | cut -c1-50) |"
  fi
  echo "$row"
done
