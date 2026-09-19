# SONA checkpoint build

Upstream: ruvnet/ruvector@d5d3296cd90d688afae838d06a5fc2c023dd9107 (crates/sona).
Rust 1.85.0; wasm-pack 0.13.1; target web; features wasm; locked dependencies.
Rebuild with bash scripts/build-learning-wasm.sh.

Applied patches and generated binary SHA-256:
317262d5acfbe09c1c61dd9618a90455393a1224b909d0017d51fe8920ee3c0b  scripts/ruvector-patches/sona-find-patterns.patch
e6385b8b1b2601fb4d5304352960367767f7697a022f1c00ebcc62b8937dd928  scripts/ruvector-patches/sona-state-checkpoint.patch
6db810afd2705c99f3e912b8187831f9f634bb2e8f3e842230c214169d36dcd2  vendor/ruvector/sona/ruvector_sona_bg.wasm
