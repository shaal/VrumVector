# tests/fixtures/

Deterministic archive snapshots for the GNN-reranker replay test
(`tests/gnn-replay.html`).

Each JSON file is an object with `brains`, `tracks`, and `observations` arrays
whose shape matches `ruvectorBridge.persist()`'s output (the format `hydrate()`
reads). `ruvectorBridge.hydrateFromFixture(fixture)` ingests one.

## Why these are hand-crafted (not real recorded archives)

These are **hand-crafted deterministic** fixtures, not captures from a real
training session. Each was constructed so the expected GNN top-1 is an
identifiable brain whose fitness is ≥ the EMA top-1's fitness, and the
lineage topology is explicit so the reviewer can verify correctness by eye
(see each fixture's `_doc` field).

Generator: `tests/fixtures/build-fixtures.mjs` (Node). Re-run with
`node tests/fixtures/build-fixtures.mjs` after editing to regenerate the JSON
files.

## car-before-split.js

A byte-exact copy of `AI-Car-Racer/car.js` from before `Car.update()` was
split into `updatePhysics()` and `updatePerception()` (car collisions, task
C1). `tests/collisions.test.mjs` runs it and the current `car.js` side by
side and requires identical results at every step. Do not edit it. If a
change to `car.js` is meant to change driving, that test fails by design:
make the same driving change to this copy by hand, in the same commit, and
say why. Keep the copy's old combined `update()`; the test checks that it has
no `updatePhysics()`. The copy predates `Car.lastInputs` (human
demonstrations, H1), which records the network's inputs and changes no
driving.

## sim-worker-before-c2.js and trial-worker-before-c2.js

Byte-exact copies of `AI-Car-Racer/sim-worker.js` and
`AI-Car-Racer/learning/trial-worker.js` from before car collisions were wired
into them (task C2). `tests/collision-simulators.test.mjs` runs each copy and
the current worker side by side with collisions off and requires identical
messages (genEnd, the last snapshot, trial results). Do not edit them. If a
change to a worker is meant to change what it simulates or posts with
collisions off, that test fails by design: make the same change to the copy
by hand, in the same commit, and say why.
