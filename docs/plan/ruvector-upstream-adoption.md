# Adopt upstream ruvector improvements (September 2026)

**Origin:** a survey of `ruvnet/ruvector` `main` at `5356a84e2` (2026-09-23) against
the vendored base `d5d3296cd` (2026-04-20). Four parallel reviews covered SONA,
GNN/HNSW/WASM, new WASM crates, and the evolution/harness tooling.

**How to use:** each task is one `/ship-next` iteration: one branch, one PR, one
squash merge into `main`. Run them in order. Record measured results in the
task's own doc or proof file, not in this checklist.

## What the survey found

- Upstream `main` history was rewritten. `d5d3296cd` is no longer an ancestor
  of `origin/main`; it survives on `shaal/ruvector`
  `wip/local-main-archive-20260421`.
- SONA: #552 makes single-step trajectories train the internal LoRA; #481 fixes
  `get_patterns`. No new WASM exports and no breaking changes to the calls this
  project makes. Both local SONA patches still need to exist, but they need a
  rebase.
- GNN: `gnn-online-training.patch` still applies. Upstream GNN WASM still has no
  training or checkpoint API.
- HNSW: upstream wasm32 still falls back to a flat index. The #773 silent-drop
  bug does not affect the vendored HNSW backend (0 misses in the reproduction).
- New crates that fit: `emergent-time-wasm` (training-health states) and
  `ruvector-graph-condense-wasm` (min-cut species). Ideas worth porting to JS:
  the paired bootstrap from `ruvector-sota-bench` and the sequential promotion
  gate from `ruvector-typesafe-core`.
- Not a fit: KGE (cannot embed unseen tracks), the typesafe text engine, Darwin
  / Flywheel / MetaHarness (LLM-agent tooling, Node only), Turbo4 / RaBitQ
  cascade (native only), and roughly 60 retrieval-scale or unrelated crates.

## Tasks

- [x] **T1 — Fix crash-map similarity.** `AI-Car-Racer/ruvectorBridge.js`
  converts crash-map cosine distance with `1 - dist/2`, while tracks, dynamics,
  and upstream use `1 - dist`. Crash grids are non-negative, so the value never
  falls below 0.5 and `CRASH_SIM_MIN = 0.55` (`adaptiveGates.js`) accepted any
  layout with cosine ≥ 0.10. Use `1 - dist`, clamp to [0, 1], add a regression
  test, and measure how many recalled layouts pass the gate before and after.
- [x] **T2 — Rebuild SONA on upstream `main`.** Rebase
  `sona-find-patterns.patch` (drop the `get_patterns` hunk that #481 made
  obsolete; keep `find_patterns`) and `sona-state-checkpoint.patch` (new
  `lib.rs` context). Regenerate `sona.Cargo.lock`, rebuild with the pinned
  toolchain, update `VENDORED.md`, and prove that existing checkpoints still
  import. Update the stale `WasmSonaEngine` stub comment in
  `AI-Car-Racer/sona/engine.js`.
- [x] **T3 — Make every ruvector build reproducible without the orphaned SHA.**
  Move the GNN companion build off `d5d3296cd` onto an upstream `main` SHA
  (prove that the binary is identical or explain the difference). Push
  `feat/hnsw-wasm-backend` to `shaal/ruvector` so the vendored HNSW backend has
  a durable source. Record the fork-pin decision (Option 2) in
  `docs/plan/ruvector-upstream-patches.md`.
- [x] **T4 — Paired bootstrap verdicts for learning benchmarks.** Port
  `pairedBootstrapDecision` (`crates/ruvector-sota-bench/harness/src/statistics.ts`,
  ADR-306) to a dependency-free JS module. Report pass / fail / inconclusive
  for adaptive-vs-fixed in `scripts/benchmark-learning.mjs` and graph-vs-EMA in
  `scripts/benchmark-gnn.mjs`. Enforce the n ≥ 5 per arm floor. *(Shipped with
  n ≥ 6 independent units, this project's rule, plus cluster resampling and a
  small-sample interval correction; see `docs/plan/learning-proof/README.md`.)*
- [ ] **T5 — Sequential verdict for the A/B comparison and a transfer guard.**
  Port the paired sequential test (anytime-valid e-value, accept at 20×) from
  `ruvector-typesafe-core` `loop_gate`. Feed it paired per-generation outcomes
  from the A/B mode (vector memory vs. no retrieval). Show the verdict in the
  A/B panel. When memory trails the control with evidence, pause cross-context
  (transfer) seeds for that learning context.
  depends: T4 (shared statistics module)
- [ ] **T6 — Training-health states from `emergent-time-wasm`.** Vendor the
  prebuilt browser package, feed it per-generation learning metrics, tune the
  thresholds so that steady improvement does not read as "Drifting", and show a
  training-health pill in the driver-learning panel.
- [ ] **T7 — Auto Train mode.** Build the opt-in `Auto Train` toggle from
  `docs/plan/training-ux-auto-mode.md` (Fresh → Grind → Polish, plateau bounce).
  Use the T6 health state for plateau detection.
  depends: T6
- [ ] **T8 — Brain species from `ruvector-graph-condense-wasm`.** Vendor the
  crate (with a build patch for the wasm-opt SIMD validation failure), condense
  the brain archive into species, and offer species-diverse seeding as an
  explicit experiment. Keep the current default unless a paired benchmark
  supports a change.
- [ ] **T9 — Rebuild the older locally built WASM packages reproducibly.**
  Found during T3: `ruvector_wasm`, `ruvector_cnn_wasm`, `ruvector_dag_wasm`,
  `ruvector_hyperbolic_hnsw_wasm`, `ruvector_learning_wasm`, and the unused
  `ruvector_gnn_wasm` were built on a local machine in April. Their panic
  strings embed the local Cargo registry path, including the home folder name.
  Rebuild each one from a pinned source (the `vv/*` tags on `shaal/ruvector`)
  with the path-remapped build, prove that its behaviour is unchanged, and
  remove `ruvector_gnn_wasm` if nothing uses it. Note: `VENDORED.md` for
  several of them says the April source tree was "-dirty".
