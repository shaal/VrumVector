#!/usr/bin/env bash
# CB0 (docs/plan/cloud-brain.md): ruvector-core's VectorDB (memory-only, flat
# index) inside the SQLite Durable Object, on wasm32-unknown-emscripten. Builds
# a throwaway copy of the Worker with ruvector-core added, runs it under
# `wrangler dev`, and prints inserts + 10 searches for 20 000 brains (3 times)
# and 50 000 brains, with the module's Wasm memory high-water mark. Recorded in
# docs/validation/cloud-brain-spike.md.
#
# RUVECTOR_SRC: a ruvector checkout that has the pinned commit (else it is
# downloaded). Needs the cloud-brain toolchain (see cloud-brain/README.md);
# PORT (default 8881) for wrangler dev.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM=5356a84e2f784a33fa497da2e73440d469eb5542
PORT="${PORT:-8881}"
WRANGLER="$ROOT/cloud-brain/node_modules/.bin/wrangler"
WORK="$(mktemp -d)"
DEV_PID=""
cleanup() {
  if [[ -n "$DEV_PID" ]]; then kill -INT -- "-$DEV_PID" 2>/dev/null || true; sleep 2; kill -KILL -- "-$DEV_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
PATHS=(Cargo.toml Cargo.lock crates/ruvector-core crates/ruvector-turboquant patches/hnsw_rs)
if [[ -n "${RUVECTOR_SRC:-}" ]] && git -C "$RUVECTOR_SRC" cat-file -e "$UPSTREAM^{commit}" 2>/dev/null; then
  git -C "$RUVECTOR_SRC" archive "$UPSTREAM" "${PATHS[@]}" | tar -x -C "$WORK"
else
  git -C "$WORK" init -q src
  git -C "$WORK/src" remote add origin https://github.com/ruvnet/ruvector.git
  git -C "$WORK/src" fetch -q --depth 1 origin "$UPSTREAM"
  git -C "$WORK/src" archive FETCH_HEAD "${PATHS[@]}" | tar -x -C "$WORK"
fi
# One member (the probe Worker); the Worker's release profile, not upstream's.
python3 - "$WORK/Cargo.toml" <<'EOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(r'(?ms)^exclude = \[.*?\]\n', '', text, count=1)
text = re.sub(r'(?ms)^members = \[.*?\]\n', 'members = ["brainprobe"]\n', text, count=1)
text = re.sub(r'(?ms)^default-members = \[.*?\]\n', '', text, count=1)
text = re.sub(r'(?ms)^\[profile\.release\]\n(?:(?!^\[).*\n)*', '[profile.release]\nopt-level = "s"\nlto = true\ncodegen-units = 1\npanic = "abort"\n\n', text, count=1)
open(path, 'w').write(text)
EOF
cp "$ROOT/cloud-brain/rust-toolchain.toml" "$WORK/"
mkdir -p "$WORK/brainprobe/src"
cp "$ROOT/cloud-brain/rust-toolchain.toml" "$WORK/brainprobe/"
cat > "$WORK/brainprobe/Cargo.toml" <<'EOF'
[package]
name = "brainprobe"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
worker = "=0.8.7"
serde_json = "1"
ruvector-core = { path = "../crates/ruvector-core", default-features = false, features = ["memory-only"] }
EOF
cat > "$WORK/brainprobe/wrangler.jsonc" <<'EOF'
{
  "name": "brainprobe",
  "main": "build/index.js",
  "compatibility_date": "2026-09-02",
  "compatibility_flags": ["new_module_registry"],
  "durable_objects": {"bindings": [{"name": "BRAIN", "class_name": "SharedBrain"}]},
  "migrations": [{"tag": "v1", "new_sqlite_classes": ["SharedBrain"]}]
}
EOF
cat > "$WORK/brainprobe/src/main.rs" <<'EOF'
// ruvector-core's VectorDB (memory-only, flat) inside the SQLite Durable
// Object: n random 244-float brains, then 10 searches.
use ruvector_core::types::{DbOptions, DistanceMetric, SearchQuery, VectorEntry};
use ruvector_core::VectorDB;
use worker::*;

fn main() {}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    env.durable_object("BRAIN")?.get_by_name("probe")?.fetch_with_request(req).await
}

#[durable_object]
pub struct SharedBrain {
    _state: State,
}

impl DurableObject for SharedBrain {
    fn new(state: State, _env: Env) -> Self {
        Self { _state: state }
    }
    async fn fetch(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        if url.path() != "/ruvector" {
            return Response::ok("probe");
        }
        let n: usize = url.query_pairs().find(|(k, _)| k == "n").and_then(|(_, v)| v.parse().ok()).unwrap_or(20_000);
        let mut options = DbOptions::default();
        options.dimensions = 244;
        options.distance_metric = DistanceMetric::Cosine;
        let db = VectorDB::new(options).map_err(|e| Error::RustError(e.to_string()))?;
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0
        };
        for i in 0..n {
            let vector: Vec<f32> = (0..244).map(|_| next()).collect();
            db.insert(VectorEntry { id: Some(format!("b{i}")), vector, metadata: None })
                .map_err(|e| Error::RustError(e.to_string()))?;
        }
        let mut hits = 0;
        for _ in 0..10 {
            let vector: Vec<f32> = (0..244).map(|_| next()).collect();
            hits += db
                .search(SearchQuery { vector, k: 10, filter: None, ef_search: None })
                .map_err(|e| Error::RustError(e.to_string()))?
                .len();
        }
        Response::from_json(&serde_json::json!({
            "n": n, "hits": hits, "bytes": core::arch::wasm32::memory_size(0) * 65_536,
        }))
    }
}
EOF
(cd "$WORK/brainprobe" && worker-build --emscripten --release >"$WORK/build.log" 2>&1) || { tail -20 "$WORK/build.log"; exit 1; }
echo "wasm: $(wc -c <"$WORK/brainprobe/build/index_bg.wasm") bytes"
# The build already ran; wrangler dev must not run one.
# Its own process group (perl's setpgrp; macOS has no setsid), so cleanup
# ends wrangler, its CLI and workerd together.
(cd "$WORK/brainprobe" && exec perl -e 'setpgrp(0, 0); exec @ARGV' "$WRANGLER" dev --port "$PORT" --ip 127.0.0.1 --persist-to "$WORK/state" --log-level warn \
  >"$WORK/dev.log" 2>&1) &
DEV_PID=$!
for _ in $(seq 1 600); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break; sleep 0.5; done
sleep 3
for n in 20000 20000 20000 50000; do
  curl -s -m 120 -w " %{time_total}s\n" "http://127.0.0.1:$PORT/ruvector?n=$n"
done
