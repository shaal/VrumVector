# Car collisions: cars that cannot drive through each other (plan)

**Status:** C1 and C2 are built. C1: the shared core
`AI-Car-Racer/collisions.js` and the `Car.update()` split. C2: all four
simulators use the core, behind an experiment that is off by default
(🧪 Experiments → "Solid cars", or `?collide=1`). Decisions D1–D4 were
taken on 2026-09-24; D2 was changed the same day, during C2 (below).
Results: [validation](../validation/car-collisions.md).

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
  elite, its mutants, and fresh cars. Built in C1 with `ceil(N / K)` heats,
  so no heat has more than K cars.
- **Start:** one row across the start gate, per heat. Gate 0 is 417–752 px
  wide on the presets, and 8 cars at a 45 px pitch need about 315 px, so
  every car still touches the start gate on frame 1 (Auto Train and the
  fitness count rely on that). The elite keeps the centre slot, the current
  start pose. `poseInCorridor` (`sim-worker.js`) already checks wall clearance.
  Built in C1: the elite keeps today's start pose as slot 0, and the other
  slots alternate sides, so an even K has one more slot on one side (and
  walls can push slots to one side). The slots rotate by heat, so fresh cars
  do not always get the slot nearest a wall. On gates that are not square to
  the heading, the row is staggered (up to 108 px ahead on Oval).
- **Cost** at N = 500: about 1 750 pair tests per step, linear in N (estimate).
- **K = N** gives "everyone races together", for small populations only.
- **On screen,** cars of other heats still overlap. The display needs a
  "focus the leader's heat" view (dim the other heats).

### What a hit does

- **Decided (D2, 2026-09-24): the car that moved into the other crashes.**
  First, the motion both cars share along the road is taken away: along the
  line of the wall nearest the pair, when both cars move the same way, the
  smaller of their two motions. Then each car's remaining motion is compared
  along the contact direction at the moment of first touch. The car closing
  on the other crashes, as if it hit a wall; if both close (head-on), both
  crash; if neither closes (a glance), nobody does. So a car that cuts in
  front of another is the one that crashes; the car behind crashes too only
  if it was catching up along the road. It reuses the existing crash path
  (`damaged`, `deathFrame`, death causes). Two guards keep solid cars from
  sinking into each other: cars that already touch and are pressed deeper
  crash the one closing faster, and cars more than 2 px inside each other
  crash the one that pushed in (by turning, or by its own motion); if
  neither did, both become ghosts until they are clear. Built in C2;
  details and the measured split:
  [validation](../validation/car-collisions.md#c2-the-four-simulators).
- **Why the road.** Taken literally ("each car's motion toward the other"),
  the rule gives C1's result in a cut-in: at the moment of touch, the front
  of the car behind runs into the cutter's side, and the cutter moves along
  its own side. A cut-in and a car driving into another's side at a small
  angle are the same motion; only the road tells them apart. Two other
  options were offered: the literal rule (no change from C1 in practice),
  and the road rule plus "a car closing at least twice as fast as the other
  crashes alone". The user chose the road rule.
- **Replaced: C1's striker rule.** The car whose nose enters the other car
  crashed. It crashed the car behind in a cut-in (12 to 23% of single-car
  crashes in a C1 review).
- Alternatives:
  - **Both crash:** simplest, but rear-ended cars die for nothing, which adds
    fitness noise.
  - **Bump and slow down:** most physical, but the result depends on update
    order, can push cars into walls, gives a weaker signal (lost time only),
    and does not fit the "dead cars skip everything" fast path.
- **Crashed cars become non-solid** (no pile-ups in Triangle's 193 px apex).
  Cars stalled for a while likely should too.
- **Built in C2 (replacing C1's nose test):** the contact is found at the
  moment the cars first touch during the step (swept along the motion, so
  fast cars cannot pass through each other). A car crashes when its own
  motion, less the shared road motion, closes on the other car at 0.1 px per
  step or more along the contact direction. A car rammed while it reverses
  away does not crash, a car slower than 0.1 px per step is never the one
  that crashes, and cars that overlap (under 2 px) without moving into each
  other crash nobody. The car's triangle tip is its rear (a car moves away from it,
  `x -= velocity.x`). Details:
  [validation](../validation/car-collisions.md#c2-the-four-simulators).

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
  for example `'off'` or `'solid/k8/rays'`. Append it to `contextKey` only
  when it is not `'off'`, so every existing key (champions, feedback,
  transfer guards) stays valid. `matchContext` treats a different collision
  mode as a non-exact match. **Built in C2** (pulled forward from C4, so
  collision-mode results are kept under their own key and never count as
  normal-mode results): the field (`'off'` or `'solid/k8'`), the key, and
  "never an exact match". A collision-mode generation can still recall
  normal-mode memories as transfer candidates, at full weight: how much a
  different mode counts in `matchContext` (its factor) stays in C4.
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

## Decisions (taken 2026-09-24)

- **D1 — Who collides.** **Taken:** heats of 8 inside the AI population.
  Alternatives: the whole population (small N only), a few rival cars driven
  by archived champions (learners ghost each other), or only your own car.
- **D2 — What a hit does.** **Taken, then changed (2026-09-24, during C2):**
  the car that moved into the other crashes, with the motion both cars share
  along the road taken away first; head-on crashes both, a glance nobody.
  First taken as "the striker (whose nose enters) crashes", built in C1.
  Alternatives: both crash, or a bump that slows the car.
- **D3 — How cars see cars.** **Taken:** the existing rays also hit cars
  (no retraining, no migration). Alternative: separate car inputs (bigger
  network, padding migration).
- **D4 — Your car.** **Taken for now:** no contact between your car and the
  AI, and multiplayer stays non-colliding (5 Hz, lagged, documented in
  `live-multiplayer.md`). One-way contact (your car hits AI poses) is possible
  at 1× later.

Smaller defaults (change them at C1 review if needed):

- **Pose jitter in collision mode** (decided in C2): ignored. The start row
  places every car, and car 0 (the elite) keeps the normal start pose.

- Wrecks and cars stalled for 2 s are not solid. Built in C1: "stalled" means
  under 0.1 px per step for 120 steps. A stalled car that drives off again,
  or a car that turns without moving, is a ghost until it overlaps no live
  heat-mate, so parking cannot buy a permanent ghost.
- In collision mode the sensor stride is capped at 4 (the 20× level); at 100×
  a car would otherwise travel about 240 px between looks.
- The toggle is an experiment in the Experiments panel plus `?collide=1`, off
  by default and not a saved physics setting.

## Tasks

- [x] **C1 — Shared collision core.** Heats, the start row per heat, an
  allocation-free triangle contact test, the striker rule, non-solid wrecks;
  `Car.update()` split into physics and perception. Node tests, including
  "collisions off is bit-identical". About 4–6 hours.
- [x] **C2 — Wire into the four simulators.** Three-pass step, config in the
  `begin` and trial messages, death cause 5 counted correctly, heat and
  contact flags in snapshots, a toggle, and a stride cap. About 4 hours.
  depends: C1
  - [x] Add `collisions.js` after `car.js` to both workers' `importScripts`.
    In collision mode, replace the per-car `update()` loop with
    `CarCollisions.step(cars, state, borders, checkPoints)`: every car's
    `updatePhysics()`, then `resolveContacts()`, then `updatePerception()`
    for the cars whose `updatePhysics()` returned true. With collisions off,
    keep calling `update()`.
  - [x] Per generation: `CarCollisions.generation(N, config, start, road)`
    builds the start row (`rowSize(N, K)` slots) and the state; car `i`
    spawns at `spawnPose(row, i, state)`. Pose jitter is ignored in
    collision mode.
  - [x] The core sets `damaged` and `contactCrash`, and `state.mark[i]` for
    the step. The live and A/B workers record `prevDamaged` and `prevSlide`
    before `step()` and set `deathFrame`, `slideAtDeath`, `deathX`,
    `deathY` after it; `endGen` gives a contact death cause 5.
  - [x] Snapshots carry `carFlags` from `CarCollisions.flags` (solid, ghost
    or parked, crashed by a contact) and the heat count; C3's rays read
    `isSolid(state, i)`.
  - [x] `sim-worker.js` `poseInCorridor` calls `CarCollisions.poseClear`.
  - [x] `main.js` stays on `update()` (only your own cars step there), so
    the H1 demonstration recorder is unchanged.
  - [x] The new blame rule (D2, changed during C2), cause 5 in
    `metricsComputeRow` and `causeHistogram` (an unknown code is "other",
    not "alive"), contact deaths out of the Adaptive-gates crash centroid,
    the sensor stride capped at 4, the Experiments toggle and `?collide=1`,
    and C4's `collisions` context field and key.
- [ ] **C3 — Rays see cars.** Rays hit solid heat-mates; readings carry a
  `kind`; contact and near-car statistics in `DriverProfiles.summarize`.
  About 3 hours.
  depends: C2
- [ ] **C4 — Learning context and ruvector.** The backward-compatible
  `collisions` field, the `matchContext` factor, `meta.driving` fields,
  crash-map filtering, SONA guard. About 3 hours.
  depends: C2
  - [x] Pulled forward into C2: the `collisions` field in `cleanContext`,
    appended to `contextKey` only when it is not `'off'`, and "a different
    mode is never an exact match". Contact deaths are already left out of
    the Adaptive-gates crash centroid.
  - [ ] Still to do: the `matchContext` factor for a different mode,
    `carContact` and `nearCarRate` in `meta.driving`, contact deaths in the
    crash-map archive (a separate heat map, or filtered out), crash maps
    tagged with the mode (so Adaptive gates never recall a normal-mode layout
    in collision mode, and reach rates leave contact deaths out), and the
    SONA guard.
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
