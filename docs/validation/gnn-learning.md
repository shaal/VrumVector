# Trainable graph ranking

The graph reranker now learns its own message projection, aggregation, and
readout weights from each seed's measured descendants. The implementation is a
small, supervised GraphSAGE-style layer with mean parent aggregation, tanh
activations, analytic backpropagation, clipped gradients, and momentum SGD.
It replaces the former random attention layer's near-neutral normalized mean.
It does not claim to fine-tune the legacy attention/GRU weights.

Inputs include parent and candidate fitness, generation, track similarity,
context match, driver profile, vehicle settings, duration, and a stable track
identifier. Inputs are captured at retrieval time, before offspring outcomes
change the archive. Training uses the same signed improvement target as EMA.
One fifth of complete contexts (deterministic hash) are held out and never enter
the bounded 128-example rehearsal buffer. Feedback and graph scores are not
multiplied together a second time.

Weights, momentum, update counters, replay examples, and evaluation statistics
are stored in the existing IndexedDB adapter row. Missing WASM preserves its
checkpoint; corrupt data is rejected atomically. The driving archive is not
migrated or deleted. All learning stays in the browser.

## Measured result

Run `npm run benchmark:gnn -- docs/validation/gnn-heldout-benchmark.json`.
The committed report includes the protocol, predictions, and measured outcomes.
No held-out outcome was used to train the model or choose hyperparameters.

The first fixed-seed experiment collected 300 descendant outcomes across three
tracks and five profiles: 200 for training and 100 across five completely held-out
contexts. Each parent was obtained by three generations of actual car simulation,
then five batches of six fresh mutations were raced at 60 Hz. Both methods ranked
the same candidates using parent fitness and their predicted descendant feedback.
EMA accumulated only earlier feedback from that parent.

| Held-out measure | Graph | EMA |
|---|---:|---:|
| Feedback mean squared error (lower is better) | 0.02565 | 0.02260 |
| Mean progress of selected descendants | 1.6800 | 1.8067 |
| Better selection in paired comparisons | 6 | 10 |

Nine comparisons tied. The graph improved feedback error in one of the five
held-out contexts.

Paired bootstrap verdicts (`AI-Car-Racer/learning/decision.js`, expanded 95%
interval; positive means the graph is better) do not favour either method. The
fixed model makes the same choice in every round of a context, and every
profile on a track starts from the same seeded root population, so selection
is resampled by track and squared error by (track, root) seed.

| Held-out measure | Mean difference | 95% interval | Independent units | Verdict |
|---|---:|---|---:|---|
| Progress of selected descendants | −0.127 | — | 3 tracks | too few units (6 needed) |
| Squared feedback error, EMA minus graph | −0.0031 | [−0.0130, +0.0064] | 12 track seeds | inconclusive |

The graph does not beat EMA, and the data also does not show that EMA is
better. The five held-out contexts come from three tracks, which cannot support
a selection verdict either way. These short runs do not establish better long-run racing,
lap times, or generalization to new track geometry. EMA remains the default.
`gnn · experimental` is an explicit option, with EMA fallback until eight training
outcomes are available or whenever the graph backend cannot load.

## Reproducibility and remaining work

The upstream patch adds `OnlineGraphRanker` and `WasmGraphRanker` APIs, including
seeded initialization, training, explicit weight replacement, and complete
checkpoint export/import. `scripts/build-gnn-wasm.sh` builds those two added
modules as a small companion WASM crate, without unrelated native vector-store
dependencies. The original GNN binary remains available for legacy demos.

The source revision, patch hash, compiler, wasm-pack version, Cargo lockfile,
and binary hash accompany the vendored artifact. Native gradient checks compare
every analytic derivative against finite differences. Actual WASM tests verify
changed rankings, parent-message influence, exact optimizer continuation, and
invalid-input rejection. Browser tests exercise descendant feedback, IndexedDB
reload, unavailable WASM recovery, and retention of the EMA default.

Before any automatic promotion: gather longer and more diverse racing outcomes,
reserve a new untouched evaluation suite, compare multiple model seeds, and
require reliable improvement in selected descendants, not just training loss.
Issue #10's measured-improvement criterion remains open; a working optimizer is
not evidence that this model outperforms contextual EMA.
