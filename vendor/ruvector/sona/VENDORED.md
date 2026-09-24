# SONA checkpoint build

Upstream: ruvnet/ruvector@5356a84e2f784a33fa497da2e73440d469eb5542 (crates/sona).
Rust 1.85.0; wasm-pack 0.13.1; target web; features wasm; locked dependencies.
Rebuild with bash scripts/build-learning-wasm.sh.

Applied patches and generated binary SHA-256:
951db91ef70cf4678549425e19d47ad233e016c31c4f59f96ab0f0bbe16fc9fe  scripts/ruvector-patches/sona-find-patterns.patch
eb144dddd4e2c0d552c2a1c5776b03f59e495fd06827015a871c9362d8ec8475  scripts/ruvector-patches/sona-state-checkpoint.patch
5832ba699dbbddb9bf3bfb50635f85515e5c7811a8797e373ecb07e7b32d7c3a  vendor/ruvector/sona/ruvector_sona_bg.wasm
