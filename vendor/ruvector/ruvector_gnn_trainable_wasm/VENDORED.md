# Trainable RuVector graph bindings

Upstream: ruvnet/ruvector@d5d3296cd90d688afae838d06a5fc2c023dd9107.
Companion build of the patched online.rs and online_wasm.rs modules; legacy GNN unchanged.
Rust 1.85.0; wasm-pack 0.13.1; web target; locked dependencies.
Rebuild with bash scripts/build-gnn-wasm.sh.

8d8ccfbd02e5c640ad011a682a3a2d982d6fba83be5a7ada456762d23013a24a  scripts/ruvector-patches/gnn-online-training.patch
39affe26e08a0be7044066c12d5cd3e245fcd001ecb37bc7415868bb06a19690  vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm_bg.wasm
