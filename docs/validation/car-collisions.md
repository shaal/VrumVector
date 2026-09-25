# Car collisions

Opt-in solid cars, planned in [car-collisions.md](../plan/car-collisions.md).
This page records what each task measured. C1 built the shared collision
core and the `Car.update()` split. C2 wired the core into all four
simulators, behind an experiment that is off by default, and changed who
crashes ([C2](#c2-the-four-simulators)). With the experiment off, training
behaves exactly as before.

## C1: the shared core

`AI-Car-Racer/collisions.js` is a classic script. It defines one global,
`CarCollisions`, and needs `utils.js` and `car.js` loaded first. The live and
A/B workers, the transfer-trial worker, and the Node simulator can all load
it, so they will resolve contacts the same way.

### The car's nose is its base, not its tip

The car body is a triangle (`Car.polygonAt`). Its tip points along
(sin, cos) of the car's angle. But a car moves the other way:
`#move` adds (sin, cos) × speed to `velocity`, then does `x -= velocity.x`.
So a car driving forward leads with the triangle's base, and the tip is its
rear. The old comment in `car.js` called the tip the front. It now says the
opposite, and the shape itself is unchanged.

A car's nose is the side of its outline that faces its own motion:

| The car is | Its nose |
|---|---|
| driving forward | the base (its front edge) |
| reversing | the two long sides |
| sliding sideways | also the long side on that side |
| slower than 0.1 px per step, or parked | none: it never strikes |

### Who crashes

**Replaced in C2** by "the car that moved into the other crashes"
([C2](#who-crashes-d2-changed-in-c2)). This was C1's rule.

The plan's rule was "the car whose nose enters the other car crashes; a
head-on hit crashes both". The C1 core read it like this:

- **Contact.** Two cars are in contact when they overlap at the end of the
  step, or when they touched during it. The core finds the moment they first
  touched, exactly, for straight-line motion. So two fast cars cannot pass
  through each other between two steps.
- **Entering.** At the moment of first touch, a car strikes when its nose
  touches the other car and its own motion carries it into the other car
  (at 0.1 px per step or more along the contact). A nose that reaches the
  other car later in the step, through its body, does not count. A car that
  is rammed while it reverses away does not strike. When two front corners
  meet at the same moment, the contact has two directions, and a car that
  moves into the other along either one strikes. So two mirror-image cars
  always both crash, and rounding never picks one.
- **Old contacts.** If the cars already touched at the start of the step,
  the core has no moment of first touch. Then a nose that touches the other
  car at any moment of the step strikes. Each nose is swept along its
  motion relative to the other car, so a fast front edge cannot jump over a
  thin tail.
- If one car strikes, it crashes and the other car keeps going. If both do
  (a head-on hit: both move into each other), both crash. If neither does
  (a tail or flank glance), nobody crashes.

### Other rules

- **Heats.** Car `i` is in heat `i mod H`, with `H = ceil(N / K)`. So no heat
  has more than K cars, and sizes differ by at most one. N = 500 and K = 8
  give 63 heats: 59 of 8 cars and 4 of 7.
- **Start slots.** Car 0 (the elite) always gets slot 0, today's start pose.
  In heat `h`, the k-th car gets slot `(k + h) mod (heat size)`. The
  population lists the elite's copies first and fresh cars last, so this
  spreads every kind of car over all slots. Without it, all fresh cars got
  the last slot, which is the one nearest a wall on 8 of 10 presets.
- **Start row.** The other slots alternate sides along gate 0, at a 45 px
  pitch. Every car then sits as far from the gate line as slot 0. A slot is
  used only if the car, after any first step (turned 0.03 rad either way,
  the most one step turns a car, and moved up to 0.5 px):
  - still touches gate 0;
  - touches no wall. The check grows the body by 1 px in width and in
    length, and it also sees a short wall that would lie inside the body.

  A slot must also be reachable from slot 0 without crossing a wall, and
  have its own lane: at least 33 px (the car's width plus 3 px) to the
  side of every other slot, so no car starts behind another. If fewer than
  K slots fit, the row is tried again at 34 px. Cars that still have no
  slot start at the start pose as ghosts.
- **Stagger.** On a gate that is not square to the heading, the row is
  staggered. Gate 0 of Rectangle puts slots from 44 px behind to 59 px ahead
  of slot 0, Oval from 43 px behind to 108 px ahead, Pentagon from 47 px
  behind to 63 px ahead, and Hexagon from 21 px behind to 28 px ahead. The
  other six presets have square gates and no stagger. That is under 1% of
  the distance a car covers in 15 s, and the slot rotation shares it over
  all kinds of car.
- **Not solid.** Wrecks, and cars that moved less than 0.1 px per step for
  120 steps (2 s), are not solid.
- **Ghosts.** Some cars are ghosts: they pass through other cars. That is a
  parked car that drives off again, a car that turns without moving, and a
  car without a start slot. A ghost becomes solid once it overlaps no live
  car of its heat. So a car cannot turn solid on top of another car, and it
  cannot park for 2 s to stay a ghost for good. A car turns without moving
  when it holds forward, reverse, and a turn together. Its body then sweeps
  around with no motion the rule can see.
- **Order.** The contact pass runs after every car has moved and before any
  car senses. It marks every crash first and applies them after, so the
  order of the pairs does not matter. It uses no random numbers.
- **After the pass,** `state.status` says which cars are solid (`isSolid`)
  and `state.mark` says which cars a contact crashed. Before the first pass,
  every car that is not a ghost reads as solid. `step()` runs the three
  passes for one step.

### `Car.update()` split

`update()` now calls `updatePhysics()` and then `updatePerception()`.
`updatePhysics()` returns false only when an AI car was already a wreck. A
car that crashes during the step still senses once, as before. Collision
mode (C2) calls the two halves in separate passes, through `step()`.

### Evidence

`tests/collisions.test.mjs` (part of `npm run test:learning`, 36 tests):

| Claim | How the test checks it |
|---|---|
| With collisions off, the split is bit-identical | Lockstep runs of `car.js` before the split (`tests/fixtures/car-before-split.js`) and after, compared value by value every step: Rectangle and Triangle, 2 seeds each, 40 cars (8 scripted drivers and 32 random brains), 15 s |
| The same holds for the collision step order | "Every car moves, then every car senses" matches the old loop on both tracks, both by hand and through `step()` with heats of one car |
| It holds on the other code paths | Laps on Oval (two laps), the sensor stride with a leader, the Careful style, a player car that crashes, respawns, and is then driven by the AI, and a 4-generation genetic run on both tracks |
| A wreck skips sensing and its network | A spy on the wreck's sensor and on the network |
| The contact test is correct | Touching, containment, near misses, and 20 000 random pairs against an independent edge-crossing-or-containment check |
| The swept test is correct | 6 000 random moving pairs against 300 sub-steps: no sampled touch is missed. Motion along an edge, infinite motion, and non-finite bodies |
| The nose rule works | Rear-end, head-on, offset head-on, T-bone, parked, reversing, sliding, glance, and side by side at one speed; symmetry on 20 000 random pairs |
| Noses are judged at first touch | A crossing where one nose touches first and the other only later, through the body, crashes one car. A car rammed while reversing away, and a creeping car that is T-boned, do not crash. `stallSpeed` from the state sets the slowest nose. A sliding car that pushes into another at 0.07 px per step along the contact does not strike; at 0.15 it does |
| Corner-to-corner ties | Two mirror-image cars from a traffic run, moved to 300 places on the track: both crash every time |
| Old contacts are judged over the whole step | Two pairs found by search: a nose that enters halfway through the step, and one that passes through and is clear again at the end |
| Fast cars cannot pass through | A front edge that jumps a thin tail in one 15 px step crashes; a head-on pass with a 28 px offset at 15 + 15 px per step crashes both |
| The broad phase drops no contact | 20 000 random pairs of cars of any size and speed, and two pairs found by search that touched early in the step and are now just over two bounding radii apart |
| Wrecks, parked cars, spinning cars, and ghosts behave as above | Parked for 119 steps is solid, 120 is not; ghost release only when clear; a spinning car hits nobody |
| Slots are fair | Every slot gets a fair share of the first and of the last tenth of the population |
| The contact pass allocates nothing | Young-generation bytes and garbage collections during 50 steps of 504 cars, set up so every path runs: swept-only and present contacts, spinners, stall ghosts, and ghost release. A control loop proves the probe works |
| The contact pass is deterministic | Two collision runs on each track match step by step; `Math.random` throws during every step |
| The start row fits | All 10 presets fit 8 cars at 45 px on gate 0. Every car registers gate 0 on frame 1 and survives it with 7 control sets (forward, reverse, idle, and each with a turn). Narrow gates as start gates: Hexagon's 130 px gate fits 3, Triangle's 198 px apex gate fits 3, and Triangle gate 2 fits 5 only at 34 px. A gate almost parallel to the heading still gives each car its own lane |
| A start slot survives its first step | 1 500 layouts of short walls just outside the car's outline, with and without a spatial grid; 150 corridors with short spikes where the slots are, a second corridor behind the wall, and a gate that may end mid-road; a fine sweep of a gate's end across a slot's edge; and a sweep of slots whose front edge is 0.05 to 0.9 px past the gate line. Every accepted slot registers the gate and survives one real step with each of the 7 control sets |

Mutation checks. Skipping perception on the death frame, or scaling the car
length by 1 + 10⁻¹⁵, makes the lockstep tests fail (at step 51 and step 3).
Each of these changes to `collisions.js` fails at least one test:

- in the start row: no turn in the start check, growing only its width,
  `poseClear` instead of `startClear`, no `pathClear`, the gate checked only
  at the spawn pose, only a forward first step, a first step sideways
  instead of along the heading, and a wall check that sees only crossings;
- in the striker rule: no entering check, an entering speed of any size
  above 0, half the threshold, a threshold not scaled to the edge length,
  the first axis instead of the one that opens last, no second direction
  for a tie (or ignoring it), no speed threshold for noses, old contacts
  judged only at their start, and a nose that is not swept;
- in the contact pass: a broad phase that ignores motion, no swept contact,
  no ghost for spinning cars or after a stall, no slot rotation, a
  never-separating axis for motion along an edge, and a stale status after
  a crash.

Three changes pass every test and change almost nothing: removing the cut
right after first touch, its 0.001-step window, and the tolerance for
"touching at the start". With the entering check in place, the cut is a
second guard: in 1.5 million random pairs (66 097 first touches, `-4` to
`15` px per step, with sideways slip), judging the noses over the whole
step instead gave the same result every time. A reviewer found the same
(0 of 63 783) and showed why: a car that moves into the other across one of
its sides has that side facing its motion.

Six review passes ran more mutations and probes, and the gaps they found
have tests. Against an "enters" oracle (a car strikes when its own motion
has a part along the contact at first touch), the final review found no
innocent car crashed in 120 000 random first touches over six populations;
the only disagreements were cars entering at under 0.1 px per step, which
the rule spares on purpose. The allocation probe found two real allocations
during review, a `Math.sqrt` call and a helper called with plain numbers,
and both are gone.
In Chromium, the core loaded through `importScripts` from both worker
folders and crashed the striker in a rear-end.

### Cost

`npm run benchmark:collisions` runs 500 cars in heats of 8 for 15 s: one
third scripted drivers at different speeds, two thirds random brains. The
contact pass runs natively; car physics and sensing run in the Node
simulator's vm context, which slows every global lookup, so the car times
are high. [Raw report](car-collisions.json). The machine was shared with
other jobs, so the times are upper bounds: a run a minute earlier gave two
to three times the worst-case and triangle-test times, with the same counts.

| Run | Contact pass, mean | p95 | First second | Cars (physics + sensing) |
|---|---:|---:|---:|---:|
| Rectangle, seed 1 | 0.049 ms | 0.08 ms | 0.36 ms | 4.4 ms |
| Triangle, seed 1 | 0.064 ms | 0.15 ms | 0.29 ms | 4.6 ms |
| Rectangle, seed 2 | 0.064 ms | 0.16 ms | 0.34 ms | 4.5 ms |
| Triangle, seed 2 | 0.058 ms | 0.14 ms | 0.30 ms | 4.7 ms |

The contact pass costs 1.1 to 1.4% of the cars' own work. The first second
includes compiling the code. Worst case, all 500 cars on one spot so every
pair in every heat touches (1 736 pairs): 1.0 ms per step. One triangle
test: about 120 ns. In these runs, 1 to 3 of about 160 contacts per run
were caught only by the swept test.

These numbers say nothing yet about learning. C6 measures that, with
n ≥ 6 per arm across at least 2 sessions.

### Limits

- **A cut-in crashes the car behind** (fixed in C2 by the new rule). If a car cuts in front of another and
  the car behind touches it with its nose, the car behind crashes. That is
  the plan's rule ("whose nose enters the other car"), but the car that cut
  in caused it. A reviewer's traffic probe found this is common: in 12 to
  23% of single-striker crashes, a car that had not turned for 5 steps was
  crashed by a turning car. Eight identical wall-following drivers on a
  start row lost 3 to 7 cars to contacts within 5 s on every preset (outer
  cars merging toward the middle), and the elite died in 8 of 20 runs. C6
  should report both. A rule that also crashes a car whose side moves into
  another would change the plan's rule, so it needs a decision.
- **Turning is not part of the motion.** The sweep uses straight-line
  motion. A turning car's front corner moves under 1 px per step because of
  the turn. A car that swings its tail into the nose of a car beside it
  crashes that car. Against an oracle that also turns the cars, a reviewer
  found 1.2% of random crossings judged differently: 0.3% of real touches
  missed, 0.5% with an innocent second car crashed, 0.04% with the wrong car
  crashed. In traffic it was 3 of about 930 contacts. Missed touches went no
  deeper than 0.82 px.
- **Cars that turn without moving are ghosts.** Moving cars pass through
  them, and C3's rays will not see them. With random brains, a reviewer
  found 4 to 6% of live car-steps were such cars, and about 6 of 160
  contacts in one run passed through one.
- **Creeping cars never strike.** A car slower than 0.1 px per step has no
  nose, so it can push slowly into another car without a crash.
- **A spared contact becomes an old contact.** If the entering check spares
  both cars at first touch (both enter slower than 0.1 px per step along
  the contact), the next step sees an old contact, where any nose that
  touches counts. So a slow car can still crash a step later. A reviewer
  saw this only with cars crawling at 0.1 to 0.4 px per step.
- **Glances are rare.** With straight-line motion, a new contact almost
  always involves a nose. A glance needs a turn, or an overlap left over
  from an earlier step.
- **Narrow start gates.** On a start gate too narrow for K cars, the cars
  without a slot start as ghosts on top of the elite. Clones that follow the
  same path stay ghosts.
- **Pose jitter.** The start row ignores pose jitter. (C2: collision mode
  ignores jitter.)
- **Top speed.** The start check covers a first step of up to 0.5 px, so a
  top speed up to 25. The slider stops at 15.
- **For C2.** The H1 demonstration recorder runs right after `car.update()`
  in `main.js`. If C2 moves `main.js` onto the split, the recorder must run
  after `updatePerception()`, or it records the inputs of the step before.
  (C2: `main.js` stays on `update()`.)

## C2: the four simulators

Collision mode is an experiment, off by default: 🧪 Experiments → "Solid
cars", or `?collide=1` in the URL. It is not a saved physics setting, so a
reload without the flag starts with it off. Turning it on or off starts a new
generation in the new mode. AI cars in the same heat of 8 are solid. Your own
cars never collide (D4), and rays do not see cars yet (C3).

### Who crashes (D2, changed in C2)

The user changed the rule on 2026-09-24: **the car that moved into the other
crashes.** The core does it in three steps, at every contact:

1. **The contact direction.** For cars that first touched during the step,
   the normal (or both normals, when two corners meet at the same moment) at
   the moment of first touch. For cars that already touched at its start,
   the direction that would push them apart soonest (their least overlap at
   the start; both directions when two tie). If the step does not press them
   together along it, they are coming apart.
2. **The road's shared motion is taken away.** The road runs along the wall
   nearest the middle of the pair (either way along it). When both cars move
   the same way along that line, the smaller of their two motions along it is
   taken from both. It is the traffic flow, not motion into the other car.
3. **Who closed.** A car crashes when what is left of its own motion closes
   on the other car at 0.1 px per step or more along a contact direction. If
   both close (a head-on hit), both crash. If neither does (a glance), nobody
   does.

Two guards keep solid cars from sinking into each other (added after
review):

- **Pressed deeper.** Cars that already touched and that the step presses
  together, with neither closing at 0.1 px per step, crash the one closing
  faster (both when equal). Without it, two cars that each drift in at 0.09
  px per step slid through each other in 333 steps.
- **Too deep.** Solid cars more than 2 px inside each other (`maxOverlap`)
  that the rule spares. A car pushed in during the step if it moves at 0.1
  px per step or more and it turned, or its own motion closes on the other.
  The one that pushed in crashes; if both did, the one that turned, else the
  one with more motion of its own (both when equal). If neither did (two
  slow cars, or cars coming apart), nobody crashes: both become ghosts until
  they are clear. Turning is not part of the motion the rule sees; in review,
  a car turning into a parked car it touched sank 16.6 px into it in a
  benchmark run, and two slow cars sank 20 px into each other. In the
  benchmark the guard acts 0 to 2 times per run.

In both, a car slower than 0.1 px per step is never the one that crashes.

Why the road: taken literally, "each car's motion toward the other along the
contact direction" gives C1's result. In a cut-in, the front of the car
behind runs into the side of the car that cut in, and that car moves along
its own side. A probe of the literal rule matched C1 on every test case and
on the traffic split below. Only the road tells a cut-in from a car that
drives into another's side at a small angle. Two other options were offered
(the literal rule, and the road rule plus "a car closing at least twice as
fast crashes alone"); the user chose the road rule.

What follows from it:

| Case | Who crashes |
|---|---|
| Rear-end | the car behind |
| Head-on | both |
| T-bone, or into a parked car | the car that drove in |
| A car cuts in, keeping pace with the car behind along the road | the car that cut in |
| A car cuts in, and the car behind gains on it along the road | both |
| C1's cut-in test (both at 10 px per step, the cutter turned 0.3 rad) | both: along the road the cutter makes 9.55 px per step |
| A car drifts sideways into the car beside it at the same road speed | the drifter (without the road it depends on which sides touch; in the test's corner-to-corner case, both) |
| Two cars overlap (under 2 px) without moving into each other | nobody |
| Two cars already touching, each pressing in slower than 0.1 px per step | the one pressing faster, both if equal |
| Two cars more than 2 px inside each other, neither pushing in | nobody: both become ghosts until they are clear |
| A car rammed while it reverses away | the rammer |
| A car crossing the road slowly in front of a fast car | the fast car: its front edge runs onto it |
| A car slower than 0.1 px per step | is never the one that crashes |

The rest of C1 is unchanged: heats, the start row, the swept contact test,
wrecks and parked cars not solid, ghosts, and the mark-then-apply order.

### The cut-in split

`npm run benchmark:collisions` (500 cars, heats of 8, 15 s, one third
scripted drivers at different speeds, two thirds random brains), seeds 1
and 2, then `--seeds 3,4,5,6` in a second session. The same traffic with
C1's core (`--core`, the file from git `79e59c9`) gives the C1 side.
Six runs per track; the shares are means, with the range.
[Raw report](car-collisions-c2.json).

| Track | Single-car crashes per run, C1 → C2 | Pairs where both crashed | C1 review's split | Road split |
|---|---|---|---|---|
| Rectangle | 135–151 → 106–116 | 9–17 → 27–42 | 13.3% (11.6–18.5) → 1.5% (0–2.7) | 15.9% (11.7–21.9) → 0.1% (0–0.9) |
| Triangle | 105–127 → 103–124 | 32–48 → 37–52 | 12.5% (7.6–16.0) → 11.0% (7.8–14.3) | 4.2% (0.8–6.3) → 0% (0–0) |

- **C1 review's split:** of the single-car crashes, the share where the
  crashed car had not turned for 5 steps and the other car turned in this
  step. In every such crash the turning car was ahead.
- **Road split:** the share where the crashed car moved along the road
  (sideways under 10% of its speed) and the other car moved across it.
- On Rectangle both splits fall to 0 to 3%. On Triangle the C1 review's
  split stays near 11%, but the road split is 0. In seeds 1 and 2, almost
  all of those Triangle crashes happen in the first second (steps 30 to
  41), where cars
  that turned earlier cross the start straight at 30 to 40 degrees to the
  walls. Such a car has not turned for 5 steps, but it moves across the
  road faster than the car it hits (for example 3.4 px per step sideways
  against 1.6), so it is the one that moved into the other.
- More crashes now take both cars (27 to 52 pairs per run, against 9 to
  48): a cut-in where the car behind was also catching up crashes both.
- Contact deaths per run: 162 to 193 of 500 cars in 15 s (C1: 156 to 173).
  The "too deep" guard fired 0 to 2 times per run.
- These numbers are about who crashes, not about learning. C6 measures
  learning, with n ≥ 6 per arm across at least 2 sessions.

### Wiring

| Simulator | What C2 changed |
|---|---|
| Live worker (`sim-worker.js`) | Loads `collisions.js` after `car.js`. A `begin` message with `collisions: {heatSize}` builds the start row and state (`CarCollisions.generation`), spawns car `i` at its slot (pose jitter is ignored), and runs `CarCollisions.step()` each step. It records each death (frame, slide, position) around the step, gives a contact death cause 5, and caps the sensor stride at 4. Snapshots carry `carFlags` (1 solid, 2 ghost or parked, 4 crashed by a contact) and `collisions: {heatSize, heats}`; `genEnd` carries a summary with `contactDeaths`. `poseInCorridor` now calls `CarCollisions.poseClear`. |
| A/B baseline worker | The same file. `main.js` sends the same `collisions` in its `begin`. |
| Transfer-trial worker (`learning/trial-worker.js`) | Loads the core; a `trial` message with `collisions` runs every generation in collision mode. The transfer check sends the mode of its learning context. |
| Node simulator (`tests/helpers/simulation.mjs`) | `new Simulation({collisions})`, the same start row and step. |

Elsewhere:

- **`main.js`** owns the mode (`carCollisions`, `?collide=1`,
  `setCarCollisions`). It still steps only your own cars, with `update()`,
  so the H1 recorder is unchanged. The A/B baseline copies the mode of the
  primary's current generation. `metricsComputeRow` counts cause 5 as
  `dcContact` and an unknown code as `dcOther`, never as alive, and records
  the mode (`collisions`); the metrics HUD shows "contact" in collision mode
  and "other" when there is any. `wallBumps` no longer counts contact
  deaths.
- **`crashMapCodec.js`** `causeHistogram` has `contact` and `other`.
- **`adaptiveGates.js`** leaves contact deaths out of the crash centroid.
- **Learning context** (`learning/policy.js`, pulled forward from C4):
  `cleanContext` has `collisions` (`'off'` or `'solid/k8'`), and
  `contextKey` appends it only when it is not off, so every key written
  before stays valid. A different mode is never an exact `matchContext`
  match. Champions, evaluation rows, reranker feedback, transfer guards, and
  late-result rejection all follow the key.

### Evidence

`npm run test:learning` (with `tests/collision-simulators.test.mjs`),
`npm run test:crash-maps`, and `npm run test:collisions:browser` (port 8895):

| Claim | How the test checks it |
|---|---|
| Collisions off, the live worker is bit-identical | `sim-worker.js` and a copy from before C2 (`tests/fixtures/sim-worker-before-c2.js`) run in a Node vm: `genEnd` and the last snapshot match on Rectangle and Triangle, with no field, `null`, `enabled: false`, pose jitter (the same draws and wall checks), and stride 1 |
| Collisions off, the trial worker is bit-identical | The same with `trial-worker-before-c2.js`: whole trial results match |
| Collisions off, the Node simulator is unchanged | Its results match the simulator of the trial worker from before C2 |
| The four simulators agree | Collision mode on both tracks: the live worker (stride 1) and the Node simulator match car by car (pose, crash, checkpoints, cause 5); the trial worker's simulator and the Node simulator give the same elite, fitness, survivors, and contact deaths |
| Collision mode is deterministic | Two live-worker runs, two trial runs, and two Node runs match; a collision trial differs from a normal one |
| Contact deaths are cause 5 | In the live worker, cause-5 count = `genEnd.collisions.contactDeaths` > 0; every one has a death frame and position; the snapshot flags match |
| The stride is capped | 4 at 100x with collisions (16 without) |
| The start row | All 8 slots fit; the elite starts at the normal pose; 8 start points shared by the heats |
| The new rule | Rear-end, head-on, T-bone, parked, reversing, sliding, glance, overlap without motion; the cut-in with and without catching up; the drifter; motion in opposite directions along the road is not shared; wrong-way traffic; a crossing car; first touch; corner ties; symmetry on 20 000 random pairs with and without a road |
| The road | The nearest wall segment (not its line), looked up at the middle of the pair (so both orders agree); odd walls skipped; the state's fixed road when no wall is usable |
| Cars that already touched | Pressing and parting; the direction from the start of the step (a searched pair that its end would get wrong); tied directions in either car order; slow drifts caught within a step or two, only the drifter when one drifts |
| Too deep | Cars that pushed in crash (by turning, or by their own motion); of two, the one that turned, else the one with more own motion (not the faster car); pairs nobody pushed into become ghosts, stay ghosts while they overlap, and are solid again when clear; a car turning into a parked car is caught at 2 px; two slow cars sinking into each other become ghosts at 2 px, and nobody crashes when one backs away; `strikeOutcome` has no turning to go on |
| Scratch state | Judging a pair never depends on the pair before it (20 000 pairs with a sliver) |
| Mutations | In review, 22 changes to the new rule each failed a test: no segment clamp, the road at one car, the start direction at the end of the step, no pressed-deeper guard, crashing every car that presses, a 50% tie, no creeping exemption, one tied direction, no fixed road, no too-deep guard, a 5 px limit, pressed pairs kept from the guard, ghosts dropped, "nobody" instead of ghosts, blaming the only mover, turning not counted as pushing in, turning ignored, both turned crashing both, absolute speed instead of own motion, turning flags kept by `strikeOutcome`, counting before the depth check, stale scratch. The harness is not in the repo |
| Shared road motion never counts | Adding the same motion along the road to both cars never changes the outcome (20 000 random pairs, 2 to 14 px per step). This holds for cars at 0.1 px per step or more: a slower car is never the one to crash, and added motion can lift it past that |
| Slow cars are never the ones to crash | 20 000 random pairs with a car under 0.1 px per step, any road |
| No allocation | The contact pass with walls and with a fixed road, 50 steps of 1 008 cars in heats of 16 that run every path (swept, pressing, parting, too deep, pressed deeper, tied): under 16 KB of young-generation growth and no garbage collection; storing an array in the too-deep guard fails it |
| The context key | Every key without collisions is unchanged; collision mode adds one field; labels and settings round-trip |
| Causes and crash centroid | `causeHistogram` has `contact` and `other`; the centroid skips cause 5 |
| The toggle and both workers | In Chromium: `?collide=1` ticks the toggle; the live and the A/B worker get `collisions: {heatSize: 8}` and a `'solid/k8'` context, and report contact deaths as cause 5; the metrics HUD counts them; the toggle off gives a normal generation with an `'off'` context and no flags; while paused the new generation starts paused; `setCarCollisions` from the console keeps the checkbox in step; the A/B baseline copies the primary generation's mode even after a change outside training; nothing is saved in localStorage |
| The transfer check | Trials take the mode from the context; a mode this build cannot run is refused |

### Cost

**The real worker.** `MEASURE=1 npm run test:collisions:browser`, headless
Chromium 147 on an Apple M3 Max: the whole step in `sim-worker.js`
(physics, contacts, sensing, the leader scan), N = 500, two generations of
15 s each, in two sessions (A / B). "Heats of 1" is collision mode where no
car can touch another: it costs only the three passes and, at 100x, the
stride cap. [Raw report](car-collisions-c2.json).

| Track | Speed | Off (stride 1 / 16), ms | Heats of 1 (stride 1 / 4), ms | Heats of 8, ms | Contact deaths per generation (heats of 8) |
|---|---|---|---|---|---|
| Rectangle | 2x | 1.08 / 1.05 | 1.04 / 0.96 | 0.69 / 0.71 | 190, 195 / 144, 127 |
| Rectangle | 100x | 0.25 / 0.20 | 0.37 / 0.36 | 0.27 / 0.27 | 185, 176 / 124, 122 |
| Triangle | 2x | 0.96 / 0.86 | 0.91 / 0.88 | 0.83 / 0.71 | 78, 72 / 94, 94 |
| Triangle | 100x | 0.25 / 0.22 | 0.34 / 0.31 | 0.38 / 0.27 | 60, 63 / 103, 104 |

- **The three passes cost nothing measurable:** at 2x, heats of 1 against
  off, -8% to +3%.
- **At 100x, collision mode costs 35 to 86% more per step** (heats of 1
  against off). Most of it is the stride cap: every car looks every 4 steps,
  not every 16. Part of it is the populations: each mode trains its own
  champion, and here the collision-mode populations kept more cars alive
  (238 to 358 against 125 to 226), and live cars cost more.
- **Contact deaths make a step cheaper**, because a wreck skips sensing and
  its network: with heats of 8 at 2x a step costs 13 to 37% less than off.
  How much depends on how many cars die, and that changes as a population
  learns (60 to 195 contact deaths per generation here).
- 20x is not in the table: the worker posts a snapshot every second tick
  there, which times one phase of the 4-step stride more than the others
  (a reviewer measured errors of -20% to +33%). At 2x and 100x almost every
  step is timed.
- The modes train different populations, so this compares cost, not
  learning. One machine, two sessions, measured just before the last change
  to the too-deep guard (it now makes ghosts where it used to crash a car;
  it acts 0 to 2 times per 15 s run).

**The contact pass alone** (`npm run benchmark:collisions`, Node): mean 0.06
to 0.08 ms per step over the 15 s (C1's core on the same traffic: 0.05 to
0.10), and 0.22 to 0.40 ms in the first second, when every car is alive and
bunched. Worst case, every heat-mate pair touching and pressing, each
looking up the road among Suzuka's 40 walls: 1.23 to 1.30 ms per step (C1's
core: 1.16 ms). The road lookup scans every wall, about 10 ns per wall per judged
contact; a reviewer measured the worst case at 0.44 ms with no walls, 1.1
ms with 40, and 3.9 ms with 200, and counted about 1 to 4 judged contacts
per step in the first second of real traffic (at most 17), so the scan does
not show there; the presets have at most 44 walls. The machine was shared,
so these are upper bounds.

### Limits

- **The road is the nearest wall.** In a corner, or where the walls are not
  parallel to the way cars drive, the line can be off, and a car that only
  shares the flow can be judged as moving across it. The benchmark ran on
  Rectangle and Triangle, whose walls are straight; curved tracks (Oval, the
  circuits) were not measured.
- **More crashes take both cars.** A cut-in where the car behind was also
  gaining along the road crashes both. The alternative (the car closing at
  least twice as fast crashes alone) was not chosen.
- **Cars that overlap without moving into each other stay overlapped**, up
  to 2 px deep. Past that, the too-deep guard acts.
- **The too-deep guard is a net, not physics.** A car that turned during
  the step counts as pushing in, even if its turn swung it away, and so does
  any own motion toward the other, however small. When nobody pushed in, the
  two cars pass through each other as ghosts until they are clear; two cars
  that keep driving together stay ghosts that long (in review, a creeping
  pair at a top speed of 3 did so for about 490 steps). In 108 review runs
  of benchmark traffic (6 tracks, top speeds 15, 5 and 3) the guard never
  made ghosts; every pair past 2 px ended in a crash.
- **Creeping cars.** A car slower than 0.1 px per step is never the one that
  crashes. Two of them pressing into each other become ghosts at 2 px.
- **Unchanged from C1:** turning is not part of the swept contact test; cars
  that turn in place are ghosts.
- **Left for later tasks.** Rays do not see cars (C3). A collision-mode
  generation can still recall normal-mode memories as transfer candidates,
  never as exact matches: how much a different mode counts is C4, with
  `meta.driving`, SONA, and contact deaths in the crash-map archive. Crash
  maps are not tagged with the mode yet, so with Adaptive gates on in
  collision mode, a layout from a normal-mode crash map can be recalled, and
  contact deaths still count in the gates' reach rates (C4). The display
  draws cars of all heats on top of each other (C5).
