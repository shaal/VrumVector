# SONA checkpoint build

Upstream: ruvnet/ruvector@5356a84e2f784a33fa497da2e73440d469eb5542 (crates/sona).
Rust 1.85.0; wasm-pack 0.13.1; target web; features wasm; locked dependencies; build paths remapped (reproducible).
Rebuild with bash scripts/build-learning-wasm.sh.

Applied patches and generated binary SHA-256:
951db91ef70cf4678549425e19d47ad233e016c31c4f59f96ab0f0bbe16fc9fe  scripts/ruvector-patches/sona-find-patterns.patch
eb144dddd4e2c0d552c2a1c5776b03f59e495fd06827015a871c9362d8ec8475  scripts/ruvector-patches/sona-state-checkpoint.patch
2c0bb4548ea57a9a2ce46b81bc895457d7a1264a29c3d4f7f9e7b7c69ef2e6cf  vendor/ruvector/sona/ruvector_sona_bg.wasm
