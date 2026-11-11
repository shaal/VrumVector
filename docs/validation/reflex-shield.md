# Reflex shield (#73): results

The shield lets the hand-written reflex (`AI-Car-Racer/learning/reflex.js`
`reflexBrain()`) drive any frame where a wall is close. The front ray's
reading (1 − offset, high = close) must be above `front`, or another ray's
reading above `side`. The reflex then sets all four controls for that frame,
after the driving style (`car.js` `Car.makeShield`, `Car.shieldDanger`).
`cloud-brain/sim` mirrors it (`run_shielded`). Verification and cloud training
never use it.

**Verdict: the shield does not clear the kill criterion. It stays OFF.**
`globalThis.vvReflexShield = true` (or `{front, side}`) turns it on for one
page, from the next generation.

## Method

- `scripts/benchmark-reflex-shield.mjs`: paired `runTrialArm` runs. Both arms of
  a pair share the population and physics streams and the live cold start (the
  reflex seed of #62 in slot 0). Only the shield differs.
- Settings: K = 30 generations, population 24, 20 s generations, profile
  `balanced`, mutation .22, conservative init .65.
- Tracks: Rectangle and Triangle, and Oval, where the reflex alone is weak
  (1 gate in 20 s). n = 12 per track: two seed families (`s1`, `s2`), 6 pairs each.
  The simulator is deterministic, so this is seed-to-seed variance, not
  browser-session variance.
- Thresholds frozen before the measured runs: `front .4`, `side .6`
  (`Car.SHIELD_DEFAULTS`). This was the lowest early crash rate of a pilot on a
  third seed family (`tune`, 2 pairs on Rect and Tri), over front .4–.75 and side .6–.85.
  Every pair cut the crash rate by only 3–5 points in the pilot.
- Each arm's final champion drives one 60 s solo evaluation, with the shield and
  without it ("bare"). The kill-criterion comparison is the shield arm's
  champion with the shield against the baseline champion without it. The order
  is laps, then best lap, then progress.
- Reflex measured: sha256 prefix `c3ba943d6c6556c7` of `reflexBrain()` (the #62 tuning).
- Crash rate: the share of the population damaged at the end of a generation.
  "Fires": frames where the shield drove, over all cars of all K generations.

## Summary (front .4, side .6, n = 12 per track)

| Track | Shield champion vs off champion (better / worse / tie) | Crash rate g0–4, off → on | Crash rate all gens, off → on | Champions lapping, off → on (bare) | Median laps in 60 s, off → on | Shield fires / 1000 driven frames | Fires per car per lap |
|---|---|---|---|---|---|---|---|
| Rect | 8 / 4 / 0 (s1 4/2, s2 4/2) | 50.1% → 48.7% | 51.5% → 47.6% | 12 → 12 (2) | 6 → 6 | 158 | 389 |
| Tri | 5 / 7 / 0 (s1 3/3, s2 2/4) | 44.2% → 39.8% | 46.0% → 39.4% | 12 → 12 (0) | 2 → 1.5 | 354 | 3 129 |
| Oval | 0 / 12 / 0 (s1 0/6, s2 0/6) | 52.8% → 0.0% | 54.3% → 0.0% | 10 → 0 (0) | 6 → 0 | 1 000 | no laps |

Other numbers:

- Champions that crashed in the 60 s evaluation, off → on with the shield → on bare:
  Rect 4 → 0 → 12, Tri 1 → 3 → 4, Oval 3 → 0 → 0.
- First generation whose training champion lapped (20 s), off → on:
  Tri 4 of 12 pairs lapped within 30 generations → 12 of 12, all by generation 2.
  Rect: generation 0 in both arms (the reflex seed laps Rect alone). Oval: 10 of 12 → 0 of 12.
- Median best lap of the champions, off → on: Rect 8.94 → 8.86 s, Tri 19.37 → 17.78 s.

## How strong is this evidence

- **Strong that it fails on Oval.** All 12 pairs are worse, in both seed families. On
  Oval at least one ray reads above a threshold on every frame of every car. So
  the shield drives 100% of frames, and the reflex alone does not lap Oval. The cars never
  crash, and they never lap.
- **Moderate that it does not help Triangle laps.** 5 better and 7 worse. The shield
  finds a first lap much sooner (12/12 pairs by generation 2, against 4/12 by
  generation 29). But after 30 generations its champions do not lap more (median
  1.5 against 2 laps in 60 s). This is a small sample: one more pair either way
  changes the split.
- **Weak gain on Rectangle.** 8 better and 4 worse, and both families agree (4/2).
  The shield mostly saves crashes in the 60 s evaluation (0 against 4 crashed).
- **The shield hides bad brains, as #73 warned.** Without the shield, the shield
  arm's champions almost never lap: Rect 2/12, Tri 0/12. The baseline's champions
  lap 12/12 on both. The population stops learning to avoid walls itself.
- **Crash cuts are small where it does not take over.** The estimate in #73 was 20–50%
  fewer crashes in early generations. The measured cut is 3% relative on Rect (50.1 → 48.7)
  and 10% on Tri (44.2 → 39.8). A cut to 0% happens only on Oval, where the shield
  drives every frame.

## Sensitivity (exploratory, not the frozen setting)

The same benchmark with `front .75`, `side .85` on family `s1` (n = 6 per track),
run after the measured runs. The shield then fires on 2–5% of driven frames,
and it no longer takes over Oval. It still does not help:

| Track | Better / worse / tie | Crash rate g0–4, off → on | Fires / 1000 driven frames | Champions lapping bare, on arm |
|---|---|---|---|---|
| Rect | 3 / 2 / 1 | 52.1% → 49.3% | 21 | 3 / 6 |
| Tri | 3 / 3 / 0 | 45.3% → 40.3% | 53 | 2 / 6 |
| Oval | 1 / 4 / 1 | 50.1% → 51.4% | 52 | 1 / 6 |

## Not measured

- Browser sessions: the Node simulator is deterministic, so session variance is
  not in these numbers.
- Population 500 (the live `batchSize`), collision mode, the sensor stride, and
  styles other than `balanced`. With `SENSOR_STRIDE` > 1, cars outside the
  privileged set sense, and so get the shield, only every few frames.
- Warm starts (memories or a saved driver).

## Parity

- `cloud-brain/sim` `run_shielded` drives as `car.js` with `Car.shield` set:
  200 of 200 cases in `tests/fixtures/cloud-brain-sim/shield-traces.json` are
  identical frame by frame. This includes which frames the shield drove, and
  `shieldFrames`. The cases are random and reflex-like brains on 5 presets,
  4 settings (balanced, careful and wild styles) and 2 threshold pairs. The
  fixture holds its own reflex brain, so a retune of `reflex.js` does not
  invalidate it.
- Shield off: `node scripts/cloud-brain-sim-traces.mjs` remakes
  `traces.json` byte for byte, and the existing traces still pass.
- The Worker (`cloud-brain/core`, `cloud-brain/src`) is unchanged: verification and
  cloud training run without the shield. A verified lap is always the brain's own.

## Raw results

`reflex-shield.jsonl` (measured) and `reflex-shield-sensitivity.jsonl` hold every
pair, with per-generation crash rate, shield frames, driven frames and laps.
`g` = gates passed (no lap); `crash` = crashed in the 60 s evaluation.

### Measured (front .4, side .6)

| Pair | Crash g0–4 off / on | Off champion | On champion, shield | On champion, bare |
|---|---|---|---|---|
| Rect s1#0 | 46% / 48% | 6L 9.63s | 6L 8.83s | 3g crash |
| Rect s1#1 | 53% / 52% | 6L 9.19s | 6L 8.85s | 1L 9.45s crash |
| Rect s1#2 | 55% / 52% | 2L 8.88s crash | 6L 8.86s | 3g crash |
| Rect s1#3 | 48% / 46% | 6L 8.57s | 6L 8.77s | 3g crash |
| Rect s1#4 | 61% / 53% | 6L 8.75s | 6L 8.84s | 3g crash |
| Rect s1#5 | 49% / 50% | 3L 8.62s crash | 6L 8.73s | 1L 9.65s crash |
| Rect s2#0 | 48% / 50% | 5L 8.78s crash | 6L 9.54s | 3g crash |
| Rect s2#1 | 48% / 46% | 6L 9.65s | 6L 8.9s | 3g crash |
| Rect s2#2 | 49% / 45% | 6L 8.75s | 6L 8.82s | 3g crash |
| Rect s2#3 | 41% / 41% | 4L 9.66s crash | 6L 8.89s | 4g crash |
| Rect s2#4 | 52% / 50% | 6L 8.99s | 6L 9s | 3g crash |
| Rect s2#5 | 52% / 51% | 6L 9.7s | 6L 8.95s | 3g crash |
| Tria s1#0 | 50% / 36% | 1L 16.13s | 3L 17.78s | 3g |
| Tria s1#1 | 33% / 31% | 2L 19.37s | 1L 18.07s crash | 6g crash |
| Tria s1#2 | 53% / 44% | 1L 16.07s crash | 3L 18.43s | 2g |
| Tria s1#3 | 43% / 34% | 2L 19.37s | 1L 17.17s | 6g crash |
| Tria s1#4 | 49% / 46% | 2L 19.37s | 2L 16.72s | 3g |
| Tria s1#5 | 43% / 45% | 5L 11.7s | 3L 17.17s | 6g |
| Tria s2#0 | 45% / 48% | 1L 17.5s | 1L 18.35s crash | 2g |
| Tria s2#1 | 38% / 30% | 2L 19.37s | 1L 17.78s | 3g crash |
| Tria s2#2 | 47% / 37% | 2L 19.37s | 1L 18.3s crash | 2g |
| Tria s2#3 | 44% / 43% | 2L 19.37s | 3L 18.07s | 7g crash |
| Tria s2#4 | 39% / 39% | 2L 19.37s | 1L 16.85s | 3g |
| Tria s2#5 | 46% / 44% | 2L 19.37s | 2L 16.68s | 6g |
| Oval s1#0 | 54% / 0% | 4g crash | 1g | 1g |
| Oval s1#1 | 46% / 0% | 6L 8.56s | 1g | 1g |
| Oval s1#2 | 60% / 0% | 7L 7.9s | 1g | 1g |
| Oval s1#3 | 41% / 0% | 7L 8s | 1g | 1g |
| Oval s1#4 | 54% / 0% | 6L 9.77s | 1g | 1g |
| Oval s1#5 | 46% / 0% | 4L 12.89s | 1g | 1g |
| Oval s2#0 | 40% / 0% | 6L 8.71s | 1g | 1g |
| Oval s2#1 | 53% / 0% | 7L 8.18s | 1g | 1g |
| Oval s2#2 | 53% / 0% | 2L 10.06s crash | 1g | 1g |
| Oval s2#3 | 71% / 0% | 4g crash | 1g | 1g |
| Oval s2#4 | 56% / 0% | 6L 9.07s | 1g | 1g |
| Oval s2#5 | 59% / 0% | 7L 7.98s | 1g | 1g |

### Sensitivity (front .75, side .85)

| Pair | Crash g0–4 off / on | Off champion | On champion, shield | On champion, bare |
|---|---|---|---|---|
| Oval s1#0 | 54% / 53% | 4g crash | 4g crash | 4g crash |
| Oval s1#1 | 46% / 48% | 6L 8.56s | 7L 8.3s | 7L 8.3s |
| Oval s1#2 | 60% / 58% | 7L 7.9s | 6L 8.62s | 1g crash |
| Oval s1#3 | 41% / 56% | 7L 8s | 5L 10.54s | 1g |
| Oval s1#4 | 54% / 54% | 6L 9.77s | 3L 8.9s crash | 1g crash |
| Oval s1#5 | 46% / 39% | 4L 12.89s | 1L 12.62s crash | 1g crash |
| Tria s1#0 | 50% / 48% | 1L 16.13s | 2L 12.18s | 3g crash |
| Tria s1#1 | 33% / 28% | 2L 19.37s | 1L 17.6s | 3g crash |
| Tria s1#2 | 53% / 49% | 1L 16.07s crash | 1L 16.03s | 1L 16.07s crash |
| Tria s1#3 | 43% / 38% | 2L 19.37s | 2L 11.69s crash | 1L 12.85s crash |
| Tria s1#4 | 49% / 41% | 2L 19.37s | 1L 14.48s | 6g crash |
| Tria s1#5 | 43% / 38% | 5L 11.7s | 1L 18.48s | 6g crash |
| Rect s1#0 | 46% / 44% | 6L 9.63s | 6L 9.63s | 6L 9.63s |
| Rect s1#1 | 53% / 51% | 6L 9.19s | 6L 9.36s | 6L 9.36s |
| Rect s1#2 | 55% / 54% | 2L 8.88s crash | 2L 8.7s crash | 3g crash |
| Rect s1#3 | 48% / 44% | 6L 8.57s | 7L 8.37s | 5g crash |
| Rect s1#4 | 61% / 54% | 6L 8.75s | 6L 8.95s | 1L 9.5s crash |
| Rect s1#5 | 49% / 48% | 3L 8.62s crash | 6L 8.92s | 4g crash |

Reproduce (each pair is about 20 s; finished pairs are skipped on a rerun):

```
node scripts/benchmark-reflex-shield.mjs --tracks=Rectangle,Triangle,Oval --family=s1 --runs=6
node scripts/benchmark-reflex-shield.mjs --tracks=Rectangle,Triangle,Oval --family=s2 --runs=6
node scripts/benchmark-reflex-shield.mjs --tracks=Rectangle,Triangle,Oval --family=s1 --runs=6 --front=.75 --side=.85
```
