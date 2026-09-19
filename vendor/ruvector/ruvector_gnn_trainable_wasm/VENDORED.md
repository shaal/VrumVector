# Trainable RuVector graph bindings

Upstream: ruvnet/ruvector@d5d3296cd90d688afae838d06a5fc2c023dd9107.
Companion build of the patched online.rs and online_wasm.rs modules; legacy GNN unchanged.
Rust 1.85.0; wasm-pack 0.13.1; web target; locked dependencies.
Rebuild with bash scripts/build-gnn-wasm.sh.

8bfed75bef99b0293e5f874acba555af7a73459546a2ac172bd301ae37e58ad5  scripts/ruvector-patches/gnn-online-training.patch
39affe26e08a0be7044066c12d5cd3e245fcd001ecb37bc7415868bb06a19690  vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm_bg.wasm
