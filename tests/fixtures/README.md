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
no `updatePhysics()`.
