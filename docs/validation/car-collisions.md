# Car collisions

Opt-in solid cars, planned in [car-collisions.md](../plan/car-collisions.md).
This page records what each task measured. So far only C1 is built: the
shared collision core and the `Car.update()` split. No simulator uses the
core yet (that is C2), so training behaves exactly as before.

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

The plan's rule is "the car whose nose enters the other car crashes; a
head-on hit crashes both". The core reads it like this:

- **Contact.** Two cars are in contact when they overlap at the end of the
  step, or when they touched during it. The core finds the moment they first
  touched, exactly, for straight-line motion. So two fast cars cannot pass
  through each other between two steps.
- **Entering.** At the moment of first touch, a car strikes when its nose
  touches the other car and its own motion carries it into the other car
  (at 0.1 px per step or more along the contact). A nose that reaches the
  other car later in the step, through its body, does not count. A car that
  is rammed while it reverses away does not strike.
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

`tests/collisions.test.mjs` (part of `npm run test:learning`, 33 tests):

| Claim | How the test checks it |
|---|---|
| With collisions off, the split is bit-identical | Lockstep runs of `car.js` before the split (`tests/fixtures/car-before-split.js`) and after, compared value by value every step: Rectangle and Triangle, 2 seeds each, 40 cars (8 scripted drivers and 32 random brains), 15 s |
| The same holds for the collision step order | "Every car moves, then every car senses" matches the old loop on both tracks, both by hand and through `step()` with heats of one car |
| It holds on the other code paths | Laps on Oval (two laps), the sensor stride with a leader, the Careful style, a player car that crashes, respawns, and is then driven by the AI, and a 4-generation genetic run on both tracks |
| A wreck skips sensing and its network | A spy on the wreck's sensor and on the network |
| The contact test is correct | Touching, containment, near misses, and 20 000 random pairs against an independent edge-crossing-or-containment check |
| The swept test is correct | 6 000 random moving pairs against 300 sub-steps: no sampled touch is missed. Motion along an edge, infinite motion, and non-finite bodies |
| The nose rule works | Rear-end, head-on, offset head-on, T-bone, parked, reversing, sliding, glance, and side by side at one speed; symmetry on 20 000 random pairs |
| Noses are judged at first touch | A crossing where one nose touches first and the other only later, through the body, crashes one car. A car rammed while reversing away, and a creeping car that is T-boned, do not crash. `stallSpeed` from the state sets the slowest nose |
| Old contacts are judged over the whole step | Two pairs found by search: a nose that enters halfway through the step, and one that passes through and is clear again at the end |
| Fast cars cannot pass through | A front edge that jumps a thin tail in one 15 px step crashes; a head-on pass with a 28 px offset at 15 + 15 px per step crashes both |
| The broad phase drops no contact | 20 000 random pairs of cars of any size and speed, and two pairs found by search that touched early in the step and are now just over two bounding radii apart |
| Wrecks, parked cars, spinning cars, and ghosts behave as above | Parked for 119 steps is solid, 120 is not; ghost release only when clear; a spinning car hits nobody |
| Slots are fair | Every slot gets a fair share of the first and of the last tenth of the population |
| The contact pass allocates nothing | Young-generation bytes and garbage collections during 50 steps of 504 cars, set up so every path runs: swept-only and present contacts, spinners, stall ghosts, and ghost release. A control loop proves the probe works |
| The contact pass is deterministic | Two collision runs on each track match step by step; `Math.random` throws during every step |
| The start row fits | All 10 presets fit 8 cars at 45 px on gate 0. Every car registers gate 0 on frame 1 and survives it with 7 control sets (forward, reverse, idle, and each with a turn). Narrow gates as start gates: Hexagon's 130 px gate fits 3, Triangle's 198 px apex gate fits 3, and Triangle gate 2 fits 5 only at 34 px. A gate almost parallel to the heading still gives each car its own lane |
| A start slot survives its first step | 1 500 layouts of short walls just outside the car's outline, with and without a spatial grid; 150 corridors with short spikes where the slots are, a second corridor behind the wall, and a gate that may end mid-road; and a fine sweep of a gate's end across a slot's edge. Every accepted slot registers the gate and survives one real step with each of the 7 control sets |

Mutation checks. Skipping perception on the death frame, or scaling the car
length by 1 + 10⁻¹⁵, makes the lockstep tests fail (at step 51 and step 3).
Of 20 changes to `collisions.js`, 17 fail at least one test: removing the
turn from the start check, growing only its width, using `poseClear` in the
start row, dropping `pathClear`, checking the gate only at the spawn pose,
a wall check that sees only crossings, judging old contacts at their start
only, not sweeping the nose, no entering check, no speed threshold for
noses, a broad phase that ignores motion, no swept contact, no ghost for
spinning cars, no slot rotation, a never-separating axis for motion along
an edge, no ghost after a stall, and a stale status after a crash. The 3
that pass change almost nothing: the moment right after first touch (the
cut, and its 0.001-step window) and the tolerance for "touching at the
start". With the entering check in place, the cut is a second guard: in
1.5 million random pairs (66 097 first touches, `-4` to `15` px per step,
with sideways slip), judging the noses over the whole step instead gave the
same result every time.

Four reviewers ran more mutations and probes, and the gaps they found have
tests. The allocation probe found two real allocations during review, a
`Math.sqrt` call and a helper called with plain numbers, and both are gone.
In Chromium, the core loaded through `importScripts` from both worker
folders and crashed the striker in a rear-end.

### Cost

`npm run benchmark:collisions` runs 500 cars in heats of 8 for 15 s: one
third scripted drivers at different speeds, two thirds random brains. The
contact pass runs natively; car physics and sensing run in the Node
simulator's vm context, which slows every global lookup, so the car times
are high. [Raw report](car-collisions.json). The machine was shared with
other jobs, so the times are upper bounds.

| Run | Contact pass, mean | p95 | First second | Cars (physics + sensing) |
|---|---:|---:|---:|---:|
| Rectangle, seed 1 | 0.091 ms | 0.13 ms | 0.83 ms | 7.9 ms |
| Triangle, seed 1 | 0.059 ms | 0.13 ms | 0.33 ms | 5.6 ms |
| Rectangle, seed 2 | 0.057 ms | 0.13 ms | 0.30 ms | 5.0 ms |
| Triangle, seed 2 | 0.072 ms | 0.17 ms | 0.26 ms | 8.1 ms |

The contact pass costs about 1% of the cars' own work. The first second
includes compiling the code. Worst case, all 500 cars on one spot so every
pair in every heat touches (1 736 pairs): 0.97 ms per step. One triangle
test: about 120 ns. In these runs, 1 to 3 of about 160 contacts per run
were caught only by the swept test.

These numbers say nothing yet about learning. C6 measures that, with
n ≥ 6 per arm across at least 2 sessions.

### Limits

- **A cut-in crashes the car behind.** If a car cuts in front of another and
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
- **Glances are rare.** With straight-line motion, a new contact almost
  always involves a nose. A glance needs a turn, or an overlap left over
  from an earlier step.
- **Narrow start gates.** On a start gate too narrow for K cars, the cars
  without a slot start as ghosts on top of the elite. Clones that follow the
  same path stay ghosts.
- **Pose jitter.** The start row ignores pose jitter. C2 decides whether
  collision mode allows jitter.
- **Top speed.** The start check covers a first step of up to 0.5 px, so a
  top speed up to 25. The slider stops at 15.
