# Car collisions: cars that cannot drive through each other (plan)

**Status:** research and design only. Nothing here is built. Decisions D1–D4
below need an answer before task C1 starts.

**Goal:** an opt-in mode in which cars are solid. Cars can hit each other, a
hit has a cost, the cars' sensors can see other cars, and the population
learns to avoid collisions. Vector memory (ruvector) keeps, recalls, and
checks drivers from this mode separately from normal training.

**How to use:** each task in [Tasks](#tasks) is one `/ship-next` iteration: one
branch, one PR, one squash merge into `main`. Record measured results in
`docs/validation/car-collisions.md`, not in this checklist.

## What "learning to avoid collisions" can honestly mean

- **The genetic algorithm learns the avoidance.** Selection keeps the car that
  gets furthest. When a collision stops a car and the car's rays can see other
  cars, cars that brake or steer around traffic get further, so their weights
  spread. No new reward term is needed; project history shows that extra
  reward terms regress Triangle (F1, F1′, P2 in `ruvector-proof/`).
- **Vector memory does not steer the car frame by frame.** The simulation
  workers do not load the bridge. What ruvector does here:
  - keeps collision-mode drivers as their own learning context, so they never
    mix with normal-mode memories by accident;
  - recalls and ranks collision-competent drivers on similar tracks;
  - measures, with the paired transfer check (T5), whether normal-mode
    memories help collision mode or hurt it;
  - optionally chooses rival cars from the archive (task C7).

## The main finding: 500 cars start on one spot

Every AI car spawns at the same pose (`computeStartInfoInPlace` in `main.js`;
pose jitter is off by default). Two probes (the Node simulator, a live-like
population of one champion plus mutations and fresh cars) measured the
overlap after 3 simulated seconds:

| Track | Cars still alive at 3 s | Of those, overlapping another car | Overlapping pairs |
|---|---:|---:|---:|
| Rectangle, N = 500 | 439 | 413 | 77 043 |
| Triangle, N = 500 | 400 | 376 | 66 083 |
| Rectangle, N = 48 (second probe, other seed) | 36 | 30 | 132 |
| Triangle, N = 48 (second probe, other seed) | 46 | 38 | 243 |

So making the whole population solid does not work:

- **Collisions from frame 1** kill almost every car at the start line.
- **"Ghost for the first N frames"** kills most of the field at frame N.
- **"Ghost until separated"** leaves most cars ghosted, because similar
  brains follow similar paths.
- **A start grid** for 500 cars needs about 2 000 px of straight road; the
  preset loops are 4 500–5 600 px long in total.
- **Cost.** Bunched cars make every pair test real. At N = 500 that is about
  125 000 pair tests per step, and about 1.4 million ray-vs-car tests (estimate).

## Recommended design

### Collision heats (groups of K cars)

- Split the population into heats of **K = 8** cars. Cars collide only with
  cars in their own heat and pass through cars of other heats. Heats are
  interleaved (car `i` is in heat `i mod (N/K)`), so each heat mixes the
  elite, its mutants, and fresh cars.
- **Start:** one row across the start gate, per heat. Gate 0 is 417–752 px
  wide on the presets, and 8 cars at a 45 px pitch need about 315 px, so
  every car still touches the start gate on frame 1 (Auto Train and the
  fitness count rely on that). The elite keeps the centre slot, the current
  start pose. `poseInCorridor` (`sim-worker.js`) already checks wall clearance.
- **Cost** at N = 500: about 1 750 pair tests per step, linear in N (estimate).
- **K = N** gives "everyone races together", for small populations only.
- **On screen,** cars of other heats still overlap. The display needs a
  "focus the leader's heat" view (dim the other heats).

### What a hit does

- **Recommended: the striker crashes.** The car whose nose enters the other
  car crashes, as if it hit a wall; a head-on hit crashes both. The other car
  keeps going. This is the clearest "do not drive into things" signal, and it
  reuses the existing crash path (`damaged`, `deathFrame`, death causes).
- Alternatives:
  - **Both crash:** simplest, but rear-ended cars die for nothing, which adds
    fitness noise.
  - **Bump and slow down:** most physical, but the result depends on update
    order, can push cars into walls, gives a weaker signal (lost time only),
    and does not fit the "dead cars skip everything" fast path.
- **Crashed cars become non-solid** (no pile-ups in Triangle's 193 px apex).
  Cars stalled for a while likely should too.

### Seeing other cars

- **Recommended first: the existing 7 rays also hit solid cars in the heat.**
  - The network stays `[10, 16, 4]` (244 floats), `BRAIN_SCHEMA_VERSION`
    stays 6, and every saved brain stays valid.
  - The learned reflex "short ray → brake or turn" carries over, because a
    car looks like a wall.
  - Cost for K = 8: about 49 circle tests per sensing car, roughly double
    today's sensing cost and under about 0.5 ms per step at N = 500
    (estimate).
  - Limit: walls and cars look the same to the network.
- **Later, if needed: separate car inputs** (for example 3 inputs: nearest
  car's direction and closing speed). This changes the network to
  `[13, 16, 4]` (292 floats).
  - Today a schema bump wipes the whole vector database
    (`migrateBrainSchemaIfNeeded`).
  - A padding migration avoids that. New input weights go right after the
    old first-layer weights and are set to 0, so an old brain ignores the
    new inputs and drives exactly as before.
  - A larger genome is harder for the genetic algorithm (P6: about 500
    parameters overshot the budget). 292 is a moderate risk.

### Step order

Today each car moves and then senses before the next car moves. Collisions
need three passes per step:

1. Move all cars.
2. Resolve contacts at once: mark first, apply after, in a fixed order, with
   no random numbers. Paired trials depend on shared random streams.
3. Sense and run the network.

`Car.update()` splits into a physics method and a perception method.
`update()` stays as the combined call, so collision mode off is bit-identical
to today (a regression test proves it).

### One shared collision core

Four simulators must behave the same:

- the live worker (`sim-worker.js`);
- the A/B baseline worker (same file, second instance);
- the transfer-check trial worker (`learning/trial-worker.js`);
- the Node simulator used by every test and benchmark
  (`tests/helpers/simulation.mjs`).

Put heats, the start row, the contact test and response, and non-solid wrecks
in one classic script that all four load. `sim-worker.js` already has a
hand-kept copy of the car polygon (`makeCarPolygon`); do not add a second.

### Learning context and ruvector

- **Context.** Add a `collisions` field to `cleanContext` (`learning/policy.js`),
  for example `'off'` or `'striker/k8/rays'`. Append it to `contextKey` only
  when it is not `'off'`, so every existing key (champions, feedback,
  transfer guards) stays valid. `matchContext` treats a different collision
  mode as a non-exact match.
- **Separated automatically once the context has the field:** evaluation
  rows, reranker feedback, the coach and champion cache, transfer candidates,
  and late-result rejection.
- **Crash maps.** Leave car-contact deaths out of the Adaptive-gates crash
  centroid, or gates will chase pile-ups. A separate "contact heat" map is
  optional.
- **Death cause.** A new cause code (5 = car contact) must be added where
  causes are counted: `metricsComputeRow` in `main.js` and `causeHistogram` in
  `crashMapCodec.js` count unknown codes as "alive" today.
- **Archive metadata.** Add `carContact` and `nearCarRate` to `meta.driving`
  for the panel and for analysis.
- **SONA** keys patterns by track only, so it cannot tell the modes apart.
  Pause SONA steps in collision mode, or add the mode to the step.

## How to prove it works

Paired by track and seed, with shared random streams:

| Arm | Collisions | Start | Rays see cars |
|---|---|---|---|
| 1 | off | today | — |
| 2 | off | heat row | — |
| 3 | on | heat row | no |
| 4 | on | heat row | yes |
| 5 | on | heat row | yes, seeded from collision-mode memories (transfer check) |

- **Arm 2 vs arm 1** isolates the start-row change. Moving the start costs
  something: 40 px of jitter cost Triangle about 40% survival.
- **Avoidance test:** run each arm's champion in a fixed traffic fixture (the
  same 7 frozen rival brains per heat). Measure contact crashes per
  car-second, time to first contact, champion progress, and survival at 5 s
  and 10 s.
- **Lesion test:** run the same champion with cars hidden from its rays.
  If it learned to use them, contacts rise.
- **Regression:** with collisions off, results are bit-identical to today.
- **Rules:** Rectangle and Triangle, with a Triangle veto
  (`vetoedDecision` in `learning/decision.js`); n ≥ 6 per arm across at least
  2 sessions before a strong claim.

## Decisions needed before C1

- **D1 — Who collides.** Recommended: heats of 8 inside the AI population.
  Alternatives: the whole population (small N only), a few rival cars driven
  by archived champions (learners ghost each other), or only your own car.
- **D2 — What a hit does.** Recommended: the striker crashes; head-on crashes
  both. Alternatives: both crash, or a bump that slows the car.
- **D3 — How cars see cars.** Recommended: the existing rays also hit cars
  (no retraining, no migration). Alternative: separate car inputs (bigger
  network, padding migration).
- **D4 — Your car.** Recommended for now: no contact between your car and the
  AI, and multiplayer stays non-colliding (5 Hz, lagged, documented in
  `live-multiplayer.md`). One-way contact (your car hits AI poses) is possible
  at 1× later.

Smaller questions: keep wrecks as obstacles or not; cap the sensor stride in
collision mode (at 100× a car travels about 240 px between looks); a toggle
in the Experiments panel plus `?collide=1`, or a saved physics setting like
traction.

## Tasks

- [ ] **C1 — Shared collision core.** Heats, the start row per heat, an
  allocation-free triangle contact test, the striker rule, non-solid wrecks;
  `Car.update()` split into physics and perception. Node tests, including
  "collisions off is bit-identical". About 4–6 hours.
- [ ] **C2 — Wire into the four simulators.** Three-pass step, config in the
  `begin` and trial messages, death cause 5 counted correctly, heat and
  contact flags in snapshots, a toggle, and a stride cap. About 4 hours.
  depends: C1
- [ ] **C3 — Rays see cars.** Rays hit solid heat-mates; readings carry a
  `kind`; contact and near-car statistics in `DriverProfiles.summarize`.
  About 3 hours.
  depends: C2
- [ ] **C4 — Learning context and ruvector.** The backward-compatible
  `collisions` field, the `matchContext` factor, `meta.driving` fields,
  crash-map filtering, SONA guard. About 3 hours.
  depends: C2
- [ ] **C5 — Display.** Focus the leader's heat, draw contacts, and show the
  mode in the panel. About 3 hours.
  depends: C2
- [ ] **C6 — Benchmark and validation doc.** The five arms, the traffic
  fixture, the lesion test, two sessions, `docs/validation/car-collisions.md`.
  About 4 hours plus compute.
  depends: C3, C4
- [ ] **C7 — Optional.** Separate car inputs with the padding migration; the
  bump response; one-way contact with your car; rivals chosen from the
  archive.
  depends: C6
