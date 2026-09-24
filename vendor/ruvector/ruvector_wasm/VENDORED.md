# Vendored: ruvector_wasm (VectorDB with the hnsw-wasm backend)

Upstream `ruvector-wasm` falls back to a flat index on wasm32. This build adds
an HNSW backend for the browser (`HnswWasmIndex`, wrapping
`ruvector-hyperbolic-hnsw`). See `docs/plan/ruvector-hnsw-in-wasm.md`.

| Field | Value |
|-------|-------|
| Source | `shaal/ruvector` branch `feat/hnsw-wasm-backend`, tag `vv/hnsw-wasm-backend-5f2a9a75` |
| Source commit | `5f2a9a75c372c89031d40c3a68f8d085a227085e` |
| Crate | `crates/ruvector-wasm` |
| Built | 2026-04-24, `wasm-pack build --target web --release` (local macOS build) |
| Vendored by | commit `ea7bd82` |
| Binary SHA-256 | `11aa4ae1a5734557461162e8da078b13f60eafcdeed407aa65930ccaa4edebbf` |

The four backend commits sit on upstream history from before upstream rewrote
`main`, so the source exists only on the fork. The fork keeps the branch and
the tag.

This binary predates the path-remapped build scripts. Its panic strings still
contain the local Cargo registry path. A reproducible rebuild is tracked in
`docs/plan/ruvector-upstream-adoption.md` (T9).
