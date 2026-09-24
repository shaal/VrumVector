# Human demonstration: teach the AI by driving (plan)

**Goal:** a person drives a few laps with WASD, the app trains a copy of the
`[10, 16, 4]` driving network on those laps (behavioural cloning), the copy
seeds the genetic algorithm, and a paired-trial check (the T5 machinery) says
whether starting from the copy beats a fresh start on this track.

**How to use:** each task below is one `/ship-next` iteration: one branch, one
PR, one squash merge into `main`. Run them in order. Record measured results
in `docs/validation/human-demonstration.md`, not in this checklist.

## What already exists

- **The human car sees what the AI sees.** The WASD car (`playerCar2`) is a
  `Car` with a `Sensor` and a brain. `car.update()` computes the same 10
  inputs every physics step: 7 ray readings (`1 - offset`), `speed/maxSpeed`,
  and the car-local direction to the next checkpoint (`lf`, `lr`), because
  player cars are "privileged" and never skip perception. It runs on the main
  thread in `main.js` (the `playerSteps` loop), at `simSpeed` × 60 Hz.
- **Keys are separate from AI output.** `Controls.manual` holds the held WASD
  keys; `resolve()` merges them with AI output per axis. With AI driving off,
  `controls.{forward,left,right,reverse}` are the human's keys.
- **The network.** `NeuralNetwork.feedForward`: hidden layer `tanh(Wx − b)`,
  output layer a hard threshold `sum > bias` (a boolean per control). Flat
  layout (244 floats, `brainCodec.js`): per level, biases then weights, with
  `weights[j·out + i]` from input `j` to output `i`.
- **Seeding.** `buildPopulation({seeds, incumbent, plan})` (`learning/policy.js`)
  puts a protected seed in the elite slot and mutates the rest around the seed
  pool. `DriverLearning.build()` already takes seed pools from memory.
- **Paired trials (T5).** `learning/trial.js` (`runTrialArm`,
  `compareOutcomes`), `learning/trial-worker.js` (two workers, common random
  numbers, full 60 Hz sensors), and `learning/sequential.js` (anytime-valid
  betting test, 20× evidence each way). `learning/transferCheck.js` wires
  them to "memories vs fresh starts". A demonstration check is the same test
  with a different arm A: seeds `[clone]` instead of transferred memories.
- **Corrections for free.** `PlayerAssist` ("AI driving") already lets the AI
  drive the human car while held keys override one axis at a time. Frames
  where the person overrides are corrective labels in exactly the states the
  AI visits (DAgger-style). This is task H7.

## Design

### 1. Recording (what one sample is)

- One sample per physics step of the WASD car, while all of these hold:
  recording is on, AI driving is off (pure human), the car is not damaged,
  training is at 1× (recording forces `simSpeed` 1, as multiplayer does), and
  the car has moved since the start.
- Sample = the 10 inputs the car computed at the end of step `t` and the four
  keys held at step `t + k`. `car.update()` moves first and senses last, so
  `k = 1` is the key that acts on that state. A person also reacts about
  150–250 ms (9–15 steps) late; `k` is a trainer setting chosen on held-out
  data (H3), so the raw log stores inputs and keys per step, unpaired.
- Add `Car.lastInputs` (a `Float32Array(10)` written when perception runs) so
  the recorder reads exactly what the network would see. No second sensor pass.
- A demonstration stores: samples, laps and checkpoints reached, crashes, the
  learning context (walls key, checkpoints, `maxSpeed`, `traction`), and a
  timestamp. Storage: IndexedDB, local only, up to 10 demonstrations and 5
  minutes each (about 1 MB each as Float32). Never sent anywhere; multiplayer
  does not transmit it.

### 2. Dataset

- Drop the idle start, and the steps after a crash until the next reset.
- **Mirror augmentation.** The rays are symmetric (`lerp(+spread/2,
  −spread/2)`), so a mirrored sample is: rays reversed, `lr` negated, `lf` and
  speed unchanged, left and right keys swapped. This doubles the data and
  removes the bias of tracks that turn mostly one way. A test must prove the
  mirror with real sensors on a mirrored track before it is used.
- **Split by time blocks** (for example 2-second blocks), not by random steps.
  Neighbouring steps are nearly identical, so a random split inflates held-out
  accuracy.
- Report the key balance. Forward is held most of the time; left, right, and
  reverse are rare. The trainer weights rare keys up.

### 3. Behavioural cloning

- Train the exact deployed network with a smooth stand-in for the threshold:
  `p_i = sigmoid(sum_i − bias_i)` and binary cross-entropy per key. At run time
  `sum > bias` is exactly `p > 0.5`, so training and driving agree. Hidden
  layer unchanged (`tanh`).
- Plain JS, Adam, mini-batches, fixed seed, in a Worker (244 parameters and
  about 20 000 samples train in well under a second per epoch). Early stop on
  the held-out blocks. Output: one 244-float vector in the flat layout.
- Report per-key held-out F1, all-four-keys agreement, and closed-loop progress:
  the clone drives the same track in the trial simulator for one round length
  (checkpoints reached, crash time), next to the demonstration's own progress.
- Expect covariate shift. A cloned driver drifts into states the person never
  showed and crashes. That is acceptable: the clone is a seed, not the final
  driver. The genetic algorithm explores around it; H7 adds corrections.

### 4. Seeding

- "Use my driving" adds the clone to the next generation's seed pool with kind
  `demonstration` (the panel's source line shows "1 from your driving"). With
  no champion in this context, the clone takes the protected elite slot.
- Opt-in and per context. The clone is offered only on the context it was
  recorded on (same walls and physics). Other contexts go through the check.
- Optional: archive the clone in vector memory with `meta.source =
  'demonstration'`, so retrieval can offer it on similar tracks, under the
  existing transfer check.

### 5. Verification: the paired-trial check

- Extract the trial loop of `runTransferCheck` into `runPairedCheck({arms,
  identity, store})`. The transfer check becomes one caller; "Check my
  driving" is the second.
- Arm A: seeds `[clone]` (plus the mirrored clone if H2 proves the mirror).
  Arm B: fresh drivers. Same trial settings as the transfer check (6
  generations × 24 cars, live mutation and initialization), same winner rule
  (final champion progress, then the same champion sooner), same test (20×
  evidence each way, alpha 0.05, up to 60 trials, resumable). Each trial
  restarts both arms, so trials are independent and the test is valid.
- Verdicts: **"Your driving helps"** (A wins with 20× evidence): the seed stays
  on. **"Fresh starts beat your driving"**: the seed is turned off for this
  context, with the evidence shown. **Inconclusive**: the seed stays opt-in.
- Identity: hash of the clone plus trial settings, stored per context (like
  `vv.transferGuard`, separate key).
- A second, optional comparison: clone vs the current memory seeds. It answers
  "does my driving add anything to what memory already provides?"

## Risks and limits

- **The network may not be able to copy a person.** Outputs are four on/off
  keys from 10 inputs, with no memory of the last step. Smooth human steering
  (tapping keys) can look inconsistent to it. The held-out F1 and closed-loop
  numbers will show this; do not claim a benefit before the paired check does.
- **Profiles.** `DriverProfiles.apply` reshapes outputs for Calm, Careful, and
  Wild. The recording is the raw keys. Trials and seeding run under the
  profile of the context the demonstration was recorded on.
- **Small n.** One person's demonstrations on one track are one sample of
  "human". The benchmark (H6) uses a scripted teacher so it can run many seeds;
  real human fixtures are reported separately.
- **Claims across tracks** follow the project rules: Rectangle and Triangle
  both, n ≥ 6 per arm across ≥ 2 sessions before a strong claim.

## Tasks

- [x] **H1 — Record demonstrations.** `Car.lastInputs`; a recorder on the
  `playerSteps` loop (1× forced, AI driving off, not damaged); IndexedDB store
  with context and a 10 × 5-minute cap; Record / Stop in the driver-learning
  panel with a live sample count and laps. Tests: node (scripted keys in the
  trial simulator give the expected pairs), browser (real WASD key presses
  record samples; AI driving or damage pauses recording). About 3–4 hours.
- [ ] **H2 — Dataset: filter, mirror, split.** Idle-start and post-crash
  filtering, mirror augmentation with a symmetry test on a mirrored track, and
  time-block splits. About 2 hours. (H1 already skips the idle start and the
  damaged steps, and stores `crashSteps`; H2 decides what else to drop around
  a crash.)
  depends: H1
- [ ] **H3 — Behavioural-cloning trainer.** Sigmoid stand-in, BCE, rare-key
  weights, Adam, early stop, key lag `k` chosen on held-out blocks, in a
  Worker. Tests: it recovers a known teacher network from that network's own
  driving (held-out agreement ≥ 95%, closed-loop progress within one
  checkpoint of the teacher); same seed gives the same weights. About 3–4
  hours.
  depends: H2
- [ ] **H4 — Seed from a demonstration.** "Use my driving" in the panel, the
  `demonstration` seed kind, the source count, and the per-context offer
  rule. About 2 hours.
  depends: H3
- [ ] **H5 — "Check my driving" paired trials.** Extract `runPairedCheck`
  from `transferCheck.js` (the transfer-check tests must still pass
  unchanged), add the demonstration arms, verdict storage, and panel text.
  About 3 hours.
  depends: H4, T5
- [ ] **H6 — Benchmark and validation doc.** `scripts/benchmark-demonstration.mjs`:
  a scripted teacher (a trained champion plus key noise) records
  demonstrations on Rectangle and Triangle, 6 seeds each, 2 sessions; report
  BC accuracy, closed-loop progress, and the paired verdict vs fresh starts.
  Add at least one real human demonstration as a fixture. About 3 hours plus
  compute.
  depends: H5
- [ ] **H7 — Corrections while the AI drives (optional).** With AI driving on,
  record only the steps where the person overrides an axis, and fine-tune the
  clone on them. This targets the states the clone actually reaches. About
  3 hours.
  depends: H3

## Defaults for the open questions (2026-09-24; change at H1 review if needed)

1. **Which car:** the WASD car only (the panel calls it "your car"). The
   arrow-key car can follow later.
2. **Multiplayer:** solo only at first; no recording while multiplayer is on.
3. **Other tracks:** a clone seeds another track only through vector memory
   and the transfer check, never directly.
4. **Raw data:** keep raw demonstrations (within the 10 × 5-minute cap), so a
   clone can be retrained after a trainer change. H1 keeps the newest 10: a
   new recording replaces the oldest, and the panel says so first.
