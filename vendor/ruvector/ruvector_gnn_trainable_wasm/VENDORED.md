# Trainable RuVector graph bindings

Upstream: ruvnet/ruvector@5356a84e2f784a33fa497da2e73440d469eb5542.
Companion build of the patched online.rs and online_wasm.rs modules; legacy GNN unchanged.
Rust 1.85.0; wasm-pack 0.13.1; web target; locked dependencies; build paths remapped (reproducible).
Rebuild with bash scripts/build-gnn-wasm.sh.

8d8ccfbd02e5c640ad011a682a3a2d982d6fba83be5a7ada456762d23013a24a  scripts/ruvector-patches/gnn-online-training.patch
40a52f99b6434dc3891e7dfc0782fb75dcfe9af9a42f54e9e2559d52ba950a46  vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm_bg.wasm
