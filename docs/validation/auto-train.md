# Auto Train

**🤖 Auto Train** is an opt-in toggle under the 🌱 Fresh / 🏎️ Grind / ✨ Polish
presets. When it is on, it applies a preset, watches each generation, and
moves to the next preset on its own. It is off by default and is not saved
across reloads. Code: `AI-Car-Racer/learning/autoTrain.js`. Plan:
[training-ux-auto-mode.md](../plan/training-ux-auto-mode.md), Option 2.

## Rules

One phase step per generation, judged on the generation's best car.

| From | To | When |
|---|---|---|
| (turned on) | Fresh | at once |
| Fresh | Grind | the best car passes a checkpoint beyond the start line (fitness ≥ 2) |
| Grind | Polish | the best car completes a lap; after a plateau bounce, only once Grind has run 8 generations |
| Polish | Grind | 20 Polish generations without a champion gain, and the health clock does not read improving |
| any | Fresh | the track's walls change |

- **Why fitness ≥ 2.** Cars spawn touching the start gate
  (`computeStartInfoInPlace` in `main.js`), so every car scores 1 in its first
  frame, even one that never moves. The plan's "≥ 1 checkpoint" would always
  fire.
- **Plateau.** The decision uses the training-health snapshot (T6,
  [training health](training-health.md)): `sinceProgress`, the number of
  generations since the champion last gained, counted only over generations
  spent in Polish. The clock's state must not be Improving or Slow progress.
  On the benchmark traces the state was a plateau state on every generation
  where `sinceProgress` was 8 or more (442 of 442; 438 Plateau, 4 Plateau
  while exploring), so in practice the counter decides. The first generation
  after a learning-context change has no reading and makes no decision. A
  plain counter of generations without a new best is used only while the
  emergent-time WASM is not loaded (it failed, or is still loading).
- **The 8-generation Grind stay.** Without it, a lapping elite returns to
  Polish after one Grind generation, and the bounce explores almost nothing.
  20 and 8 are first guesses; nothing here compares them with other values.
- **Judged generations.** Only generations built after Auto Train set their
  preset count. The generation that is running when the toggle is turned on,
  or when a track change is found at the end of a generation, is skipped, and
  so is one queued before the simulation worker was ready.
- **User intent wins.** Moving a tuning control (the four sliders, the 1–5 car
  buttons, the sim-speed select), choosing a preset, demo mode, and a
  `__runBenchmark` run turn Auto Train off. Changes made by code without a
  user event (for example, multiplayer forcing 1×) are undone at the next
  generation, except multiplayer's 1×.

## What the panel shows

The preset Auto Train is running is outlined. A status line (a polite live
region, which changes only when the phase changes) says the phase, why it
changed, and what comes next. While it is on, each tuning control shows 🔒
after its value, and a note at the top of the tuning section says that moving
one turns Auto Train off.

## Real-physics run

`npm run benchmark:auto-train` ([raw report](auto-train.json)) runs Auto Train
with the real policy, preset values, genetic policy, and health clock on
Rectangle and Triangle, 6 seeds each, 60 generations each (39 minutes on 12
worker threads). It follows the app's path with Vector Memory off: each
learning context keeps its own champion, the clock resets when the context
changes, and the last generation's best brain seeds the next. Replaying the
720 recorded generations through the current `AutoTrainPolicy` gives the
same phase changes on all 12 traces.

| Track | Seeds | Fresh → Grind | Reached Polish (generation) | Plateau bounces | Returned to Polish | Polish champion after the return |
|---|---:|---|---|---:|---:|---|
| Rectangle (5 gates) | 6 | generation 0 on all 6 | 4 of 6 (3, 4, 5, 48) | 3 (at 33, 39, 43) | 3 (8 Grind generations each) | 11 → 11, 11 → 11, 14 → 15 |
| Triangle (9 gates) | 6 | generation 0 on all 6 | 1 of 6 (5) | 1 (at 53) | 0 (run ended) | — |

What this shows:

- **The phase changes fire as designed on real physics,** including the
  bounce and the 8-generation Grind stay.
- **Fresh lasts one generation.** With 500 random cars, at least one passes the
  first gate after the start line in generation 0 on every trace (the elite
  reaches 2 to 5 checkpoints). Fresh is therefore a one-generation cold start
  with conservative initialization. This answers the plan's open question 3:
  there is little Fresh left to skip.
- **Most runs never reach Polish in 60 generations.** 7 of 12 traces (2 of 6
  on Rectangle, 5 of 6 on Triangle) never complete a lap in a 15-second Grind
  round, so they stay in Grind. That is the intended rule (Grind until a lap),
  not a fault, but it means Polish and the bounce are rare without Vector
  Memory seeds.
- **No claim that bounces help.** After 3 bounces, the Polish champion gained
  once, by one checkpoint. That is too few to say anything.

What it does not show:

- It does not compare Auto Train with a fixed preset or with manual use, and
  it does not compare 20 and 8 with other values.
- Vector Memory seeds are not modelled (the app turns Vector Memory on by
  default), nor is the sensor stride the app uses above 2×: Grind runs at 20×
  in the app, with perception on only every few steps for most cars, so real
  Grind laps may come later than here.
- Per the project's rules, cross-track claims need n ≥ 6 per arm across at
  least 2 sessions. This is one deterministic session.

## Known limits

- **Multiplayer runs at 1×.** When multiplayer is on (the default), every
  preset's speed is held at 1×, so Grind does not run at 20×. The phases still
  change the population, round length, variance, and initialization.
- **Each Grind ↔ Polish switch is a new learning context.** The round length
  (15 s vs 25 s) is part of the context, so the coach, the health clock, and
  the transfer-check verdict are separate for each phase. A transfer pause
  found in Grind does not apply in Polish.
- **Adaptive gates hide plateaus.** Moving gates keeps the phase (only walls
  count as a new track), but each gate change is a new learning context and
  resets the health clock. If the gates move more often than every 21
  generations, Polish never bounces.
- **Reset Brain keeps the phase.** Only a change of walls restarts at Fresh.
- **The collapsed control panel shows no sign that Auto Train is running.**

## Tests

- `tests/auto-train.test.mjs` (in `npm run test:learning`), 13 tests:
  - a real spawn scores the start gate and stays in Fresh;
  - each transition fires at its threshold and not before, and the one-step
    rule holds;
  - a plateau bounces only after 20 Polish generations, for every
    non-improving state, and never when the clock reads improving;
  - a clock that was not reset does not bounce early;
  - the Grind stay lasts exactly 8 generations, with status text that does not
    change during it;
  - a loaded clock without a reading makes no decision, and the fallback
    counter is used only without the clock;
  - real health snapshots bounce a flat run after exactly 20 generations
    without a gain and never bounce steady gains;
  - controller: presets follow the phase, new walls restart at Fresh, moved
    gates do not, a generation built before the change is not judged, and
    drift is re-applied (except multiplayer's 1×).
- `tests/auto-train-browser.mjs` (`npm run test:auto-train:browser`, in CI),
  14 stages, in the real app:
  - turning Auto Train on applies Fresh, the locks and slider fills update, and
    the status text is correct;
  - real generations reach the hook after `DriverLearning.record`, and the Grind
    preset lands before the next generation is built (600 cars, 15 s, 20×);
  - the Polish, bounce, stay, and return path;
  - a new track restarts at Fresh before its first generation;
  - drift is restored;
  - keyboard, mouse, and type-ahead changes to the controls, a preset click,
    and the 1–5 buttons each turn it off;
  - the panel re-render keeps the state, and the mobile layout has no overflow;
  - demo mode turns it off;
  - a click made before the module loads is kept.
- `scripts/a11y-contrast.mjs` has an `auto-train-on` scenario (light and
  dark).
