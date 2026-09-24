# Behavioural cloning

`AI-Car-Racer/learning/clone.js` trains a copy (a "clone") of the
`[10, 16, 4]` driving network from recorded driving. It is task H3 of the
[human demonstration plan](../plan/human-demonstration.md). Nothing in the game
calls it yet: H2 builds the dataset from recordings, and H4 adds "Use my
driving".

## How it works

- **The deployed network, trained directly.** The hidden layer is
  `tanh(W1·x − b1)`, as in the game. The game presses a key when
  `sum > bias`. Training turns that into a probability,
  `p = sigmoid(sum − bias)`, and scores each key with binary cross-entropy
  (the usual loss for yes/no answers). `sum > bias` is exactly `p > 0.5`, so
  the trained weights drive the real network unchanged. The output is one
  244-float vector in the flat layout of `brainCodec.js`.
- **Plain JavaScript.** Mini-batch Adam (batch 64, rate 0.01) with a fixed seed
  (`seededRandom`). Each input is rescaled to mean 0 and spread 1 for
  training (spread at least 0.05). At the end the rescaling is moved into the
  first layer's weights and biases, so the game needs no change.
- **Rare keys weigh more.** For each key, the rarer value (for example "not
  forward", or "reverse held") gets weight `(common / rare)^0.5`, kept between
  1 and 10. Then both values are scaled so the average weight is 1. The
  weights come from the training rows and are the same for every lag.
- **Time-block split.** Each run is cut into 2-second blocks (120 steps); a
  last piece shorter than 1 second joins the block before it. A seeded shuffle
  holds out whole blocks until 20% of the rows are held out. Neighbouring
  steps are nearly the same, so a split by single steps would inflate
  held-out scores.
- **Key lag.** Row `t` pairs the inputs sensed at the end of step `t` with the
  keys held during step `t + k`. `car.update()` moves first and senses last,
  so `k = 1` is the key that acts on that state; a person reacts later. The
  trainer tries `k` = 1, 2, 4, 6, … 16. Every lag trains 10 epochs; the two
  with the lowest held-out loss train on until the held-out loss has not
  improved for 30 epochs (at most 150). All lags are scored on the same
  held-out rows, at least 60 of them (1 second); lags too long for the data
  are dropped. The lowest loss wins.
- **Pairs never cross a run boundary or the train/held-out boundary.**
- **Mirrored copies (for H2).** An optional `sameSplitAs` list puts a copied
  row on the same side of the split as its original.
- **Worker.** `trainCloneInWorker()` runs the same code in
  `learning/clone-worker.js`, so training does not block the page. It reports
  progress, can be cancelled (it then rejects with an `AbortError`), and
  otherwise rejects with a reason code (`not-enough-data`, `invalid-data`,
  `invalid-options`, `worker-failed`, or `diverged`).
- **Report.** Chosen `k`, epochs, per-key held-out F1, precision, and recall,
  all-four-keys agreement on held-out and training pairs, the key balance, the
  loss of every lag, and the largest weight.

## Test: copy a known network from its own driving

`npm run test:cloning` (`tests/cloning.test.mjs`, 1–2 minutes). A short
genetic run (24 generations of 24 cars, 15 seconds each) makes a teacher
network on each track. The teacher then drives one car in the real simulator
from up to 40 starts near the spawn (up to 12 px and 0.12 rad off), 15 seconds
each or until it crashes, until 18,000 steps are recorded. The recording
stores what a person's recording stores: for each step after the car first
moves, the keys held during the step and the 10 inputs sensed at its end. The
trainer runs with its defaults.

Then the teacher, the clone, and a network that only holds forward each drive
one 30-second round from the spawn and from 12 new starts.

| | Rectangle | Triangle |
|---|---:|---:|
| Recorded steps (runs) | 18,338 (31) | 18,273 (35) |
| Share of steps with forward / left / right / reverse held | 65% / 47% / 24% / 25% | 76% / 6% / 61% / 50% |
| Chosen lag `k` | 1 | 1 |
| Epochs (best epoch) | 111 (81) | 150 (143) |
| All four keys right, held-out blocks | 98.4% | 98.9% |
| All four keys right, training pairs | 98.6% | 98.8% |
| All four keys right, fresh runs | 88.1% | 98.3% |
| Held-out F1: forward / left / right / reverse | 0.994 / 0.997 / 0.993 / 0.995 | 0.999 / 0.975 / 0.998 / 0.996 |
| From the spawn: teacher | 4 checkpoints, no crash | 4 checkpoints, crash at step 333 |
| From the spawn: clone | 4 checkpoints, no crash | 4 checkpoints, crash at step 331 |
| From the spawn: forward only | 2 checkpoints, crash at step 120 | 3 checkpoints, crash at step 137 |
| 13 starts, total checkpoints: teacher / clone / forward only | 42 / 43 / 26 | 46 / 45 / 39 |
| Starts where the clone matched the teacher exactly | 8 of 13 | 12 of 13 |
| Largest weight | 37 | 33 |

The test requires at least 95% held-out agreement and `k = 1`. On every one of
the 13 starts, the clone must be within one checkpoint of the teacher. That
alone is too easy on Triangle: the forward-only network is also within one
checkpoint on all 13 starts there. So the test also requires the clone's total
to be within 5% of the teacher's, and checks that forward only fails that.

**Fresh runs** are about 6,000 steps of new runs from new starts (9 runs on
Rectangle). They are never used for early stopping or the lag choice, so they
are the unbiased check. On Rectangle, one of the nine fresh runs went where no
training run went (2 checkpoints and no crash in 15 seconds); the clone
matched only 26% of its steps there. The other eight fresh runs scored
97–99%. A clone is good only where the recording has data. The test only
requires 85% on fresh runs, to catch a collapse.

**Other teachers (a one-off check, not in the tests).** With the same recipe,
teachers from other seeds gave:

| Teacher seed | Chosen `k` | Held-out agreement | Starts within one checkpoint (of 13) | Total checkpoints, teacher / clone |
|---|---:|---:|---:|---:|
| Rectangle `a` | 1 | 97.4% | 12 | 67 / 58 |
| Rectangle `c` | 1 | 95.2% | 12 | 81 / 79 |
| Rectangle `d` | 1 | 99.0% | 13 | 39 / 38 |
| Triangle `a` | 1 | 99.9% | 13 | 37 / 36 |
| Triangle `c` | 1 | 98.9% | 13 | 39 / 39 |
| Triangle `d` | 1 | 99.5% | 13 | 35 / 38 |

All chose `k = 1` and passed 95% held-out agreement. Two Rectangle clones
(`a`, `c`) missed by more than one checkpoint on one start, and two totals
(Rectangle `a`, Triangle `d`) were more than 5% off. Teacher `b`, used in the
tests, passes every check on both tracks. Rectangle `a` and `d` and Triangle
`a` and `c` hold some key on fewer than 2% or more than 98% of steps, so the
test would refuse them as teachers.

## Test: the lag choice

The same genetic run, but with every car's keys acting 9 steps late
(150 ms), gives a teacher that drives well with that delay, as a person does.
The key that fits the inputs of step `t` is then held at step `t + 10`. These
teachers hold some keys all the time (Rectangle: forward always, right never;
Triangle: left always); the timing shows in the keys that change.

| Teacher | Candidates | Chosen `k` | Held-out agreement |
|---|---|---:|---:|
| Own driving (above), both tracks | default | 1 | 98.4%, 98.9% |
| Rectangle, adapted to 9 steps late | default | 10 | 99.2% |
| Triangle, adapted to 9 steps late | default | 10 | 98.4% |
| Rectangle, adapted to 9 steps late | 1, 4, 9, 13, 16 | 9 | 97.4% |
| Triangle, adapted to 9 steps late | 1, 4, 9, 13, 16 | 9 | 97.2% |
| Triangle teacher from above, keys 5 steps late in the simulator | default | 6 | 97.2% |

The held-out loss has a clear low point at the true lag: for example 0.024 at
10 against 0.119 at 8 and 0.189 at 12 on Rectangle. Without 10 among the
candidates, the nearest one (9) won on both tracks. In a one-off check with
three other recording and trainer seeds per track, the choice was again 10,
and 9 without 10, every time.

**Known limit (a `todo` test).** The Rectangle teacher from above, with its
keys 9 steps late in the simulator, crashes after about 2.2 seconds in every
run, with few key changes. On that data the trainer picks 8, not 10. With keys
12 steps late (a one-off check), it picked 6, not 13. When every run is the
same short drive into a wall, the recording does not show when the keys act.

## Other tests

- `predict()` matches `NeuralNetwork.feedForward` bit for bit (200 random
  networks, 20 inputs each), and the teacher matches its own recording on
  every step at `k = 1`.
- The recording harness drives exactly as the game does (same final position
  and progress as `Simulation.run`), and skips the idle start.
- The same seed gives the same weights and report; another seed gives other
  weights; the dataset is not changed. This holds within one JavaScript
  engine; `Math.tanh` and `Math.exp` may differ in the last bit between
  browsers.
- Refused with a reason: an empty dataset, mismatched lengths, a NaN,
  infinite, or non-number input, a key other than 0 or 1, one block only, runs
  too short for any lag, too few held-out pairs, bad options, and bad
  `sameSplitAs` links. Options left `undefined` take their defaults.
- A small dataset (480 steps, four blocks) still trains; asking for more
  scored pairs drops the longest lags.
- A key that is never pressed gets F1 "not defined" and is never pressed by
  the clone; a key that is always pressed is always pressed.
- Pairs never cross a run boundary (including a reused episode id) or the
  train/held-out boundary. Held-out rows are whole blocks, the seed picks
  them, and linked rows follow the rows they copy.
- The worker script, driven in Node, returns the same weights, reports
  progress and errors, cancels, and rejects when it cannot start. A failing
  progress callback is logged and the result still arrives.
  `npm run test:cloning:browser` runs the real module worker in Chromium.
  Across four runs it trained 12,000 steps (3 lags) in 1.6–3.3 seconds, and
  the page's longest wait between 4 ms timer ticks stayed under 6 ms. The
  weights matched training on the page, and in Node 22 (reported, not
  required).

## Cost

About 27 ms per epoch for 14,500 training pairs, and 7–9 seconds for a full
training of 18,000 steps (5 minutes of driving, all 9 lags) in the test runs,
in Node 22 on the development machine. One measurement while the machine was
busy took 15 seconds. Time grows with steps × epochs × lags. In a one-off run (not in the tests) on
180,000 Triangle steps, the size of the full store of 10 five-minute
demonstrations, training took 78 seconds (278 epochs over all lags), the
whole Node process used 157 MB, and held-out agreement was 99.1%. H4 should
show progress, or train on fewer demonstrations.

## Limits

- **The teacher is the same network shape, so an exact copy exists.** A
  person is not a network; their clone will score lower. These tests show the
  trainer works. They do not show that a person can be copied.
- **Held-out blocks are slightly optimistic.** The same blocks pick the epoch
  and the lag, and they sit between training blocks of the same runs. That is
  why fresh runs can score lower.
- **Closed-loop results depend on the teacher.** Small differences compound.
  See the table of other teachers above.
- **The lag choice needs varied driving.** See the known limit above. When the
  copy fits poorly, neighbouring lags can also swap: on 10 random synthetic
  datasets (not car driving), one picked 2 instead of 1.
- **Large weights, so mutation changes a clone less.** The clone copies the
  teacher's keys, not its weights. Its weights are about 10 times larger: the
  root mean square per layer is 2–11 against 0.3–0.7 for the teacher, and the
  largest is 33–37, while genetic-run weights stay within ±1. The genetic
  run mutates a weight to `w(1 − a) + a·u` with `u` random in ±1; at the
  default mutation rate 0.22, `a` is 0.11 or 0.40 (`buildPopulation`). In a
  one-off check (not in the tests), 10 mutated copies of each network changed
  the keys on this share of the steps of its own recording:

  | Mutation `a` | Rectangle teacher | Rectangle clone | Triangle teacher | Triangle clone |
  |---:|---:|---:|---:|---:|
  | 0.11 | 43% | 3% | 17% | 1% |
  | 0.40 | 82% | 9% | 63% | 6% |

  So the offspring of a clone stay close to it. H4 and H5 must decide whether
  that is good (refinement) or too little exploration (a larger mutation for
  clone offspring, or weight decay in the trainer).
