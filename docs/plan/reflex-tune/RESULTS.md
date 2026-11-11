# Reflex tuned per track (#70): results

On a cold start, the reflex car of #62 (slot 0 of generation 0) now uses a
tuning fitted to the current track. `AI-Car-Racer/learning/reflexTuner.js`
searches the 11 numbers of `REFLEX_TUNING` with short drives of the reflex
car alone. The result is cached per track, so the next cold start on the
same track reuses it. It is ON by default. `localStorage.reflexTune = '0'`
turns it off for one browser.

## The tuner

- Candidate 0 is the fixed tuning. Then 19 uniform draws over wide bounds,
  then 5 rounds that sample around the best 4 with a spread that shrinks
  each round: 52 search drives in all.
- Score: gates passed, then the same gates sooner (`driveScore`).
- Noise-robust ranking: the car is deterministic, so the noise source is the
  live sensor stride. At `simSpeed` > 2 the sim worker lets AI cars that are
  not the leader skip sensor reads (`sim-worker.js` `computeStride`). The
  fixed tuning and the best 4 candidates are also driven at stride 2 and 4
  (10 more drives), and the winner has the best mean over strides 1, 2 and 4.
  Without this step, one tuned Rect reflex scored 11 at stride 1 and 2 at stride 2.
- The fixed tuning is always a finalist, a tie goes to it, and a finalist
  must score at least the fixed tuning's score at stride 1. So the tuned reflex
  is never worse than the fixed one at stride 1 or on the mean over strides
  1, 2 and 4 (the drive it was scored on, not the GA run that follows).
- Bounds keep every weight within ±16, the shared cloud brain's limit
  (`cloud/wire.js` `maxWeight`). A test checks the corners and 300 random points.
- Drive length: the generation length of the context (20 s by default).

Where it runs:

- Live training: `DriverLearning.build` (`session.js`) after `buildPopulation`.
  On a cache miss the search runs on the page's main thread, with the page's
  own `Car`, within a 1200 ms budget. The budget is checked between drives and
  covers the search drives only; the 10 finalist drives run after it. It never
  tunes on a road that is not the context's track.
- An in-memory memo per context backs the cache, so the A/B arms and the
  transfer check share one tuning when `localStorage` cannot be written.
- The A/B view's baseline arm (`main.js`) uses the same tuning.
- The transfer check's fresh arm uses the same tuning (`runTrialArm`
  `reflexTuning`). `DriverLearning.checkTransfer` tunes on demand when no
  tuning is cached yet. The test identity gains `|t<hash>`, so verdicts from
  before #70 are re-tested once. If the cache later evicts the context (20
  entries) and the re-tune finds a different tuning, the test runs again.
- Only slot 0 of a cold start changes. The reflex car that #72 re-injects on
  a stall (flag off) takes a later slot and stays the fixed reflex.
- Cache: `localStorage['vv.reflexTuning']`, keyed by track geometry, style,
  max speed, traction, generation length and collision mode. So a change to
  any of these is a new search (0.1–0.5 s), not only a new track. The newest
  20 contexts are kept. A tampered or out-of-bounds entry is dropped on read.
  The key carries a version (`v1`) to bump when the search or the car's
  physics or sensors change; old entries are not re-checked otherwise.

## Method

- `scripts/benchmark-reflex-tune.mjs`: paired `runTrialArm` cold starts. Both
  arms have the reflex car and share every seeded stream (population and
  physics). The only difference is the reflex car's tuning: fixed against tuned.
  The tuner has its own seed per pair, so tuner variance is in the results.
- Metric: the first generation whose champion completes a lap. `>G-1` means
  no lap within the cap (censored).
- Settings: 20 s generations, profile `balanced`, mutation .22, conservative .65,
  stride 1 in the GA arms (as in #62).
- Two seed families (`s1`, `s2`) stand in for two sessions. The simulator is
  deterministic, so this is seed-to-seed variance, not browser-session variance.
- Fixed before any paired result: Rect and Tri, and three presets where the
  fixed reflex alone is weak (Oval and Hexagon 1 gate, Monza 2 at 20 s).
  n = 12 per track at population 24 (cap 80), and n = 6 on Hexagon and Tri at
  population 500, the live `batchSize` (cap 40). No track was added or dropped.

## Raw results (fixed / tuned, first-lap generation)

Population 24, cap 80 (n = 12 per track):

| Track | Pairs |
|---|---|
| Oval | s1#0: 10 / 0, s1#1: 5 / 0, s1#2: 3 / 0, s1#3: 22 / 3, s1#4: 3 / 0, s1#5: 61 / 0, s2#6: 8 / 0, s2#7: 12 / 0, s2#8: 1 / 1, s2#9: 6 / 0, s2#10: 2 / 0, s2#11: >79 / 0 |
| Hexagon | s1#0: >79 / 0, s1#1: 52 / 0, s1#2: >79 / >79, s1#3: 4 / 32, s1#4: 27 / 0, s1#5: >79 / 0, s2#6: 49 / 19, s2#7: >79 / >79, s2#8: 8 / 0, s2#9: 40 / 29, s2#10: >79 / 0, s2#11: 11 / 0 |
| Monza | s1#0: 3 / 0, s1#1: 1 / 0, s1#2: 1 / 0, s1#3: 1 / 0, s1#4: 1 / 0, s1#5: 1 / 0, s2#6: 1 / 0, s2#7: 1 / 0, s2#8: 1 / 0, s2#9: 1 / 0, s2#10: 1 / 0, s2#11: 8 / 0 |
| Rect | all 12 pairs: 0 / 0 |
| Tri | s1#0: 21 / 21, s1#1: 30 / 30, s1#2: 11 / 11, s1#3: 39 / 39, s1#4: 48 / 48, s1#5: >79 / >79, s2#6: 2 / 2, s2#7: 5 / 0, s2#8: 1 / 1, s2#9: 56 / 56, s2#10: 71 / 45, s2#11: 22 / 22 |

Population 500, cap 40 (n = 6 per track):

| Track | Pairs |
|---|---|
| Hexagon | s1#0: 2 / 0, s1#1: >39 / 0, s1#2: >39 / 0, s2#3: 4 / 1, s2#4: 2 / 0, s2#5: 20 / 1 |
| Tri | s1#0: 9 / 9, s1#1: 3 / 3, s1#2: 2 / 2, s2#3: 3 / 3, s2#4: 1 / 1, s2#5: 2 / 2 |

Tuner score per pair (fixed → tuned, mean over strides 1, 2, 4), population 24:

| Track | Scores |
|---|---|
| Oval | 1→7, 1→8, 1→8, 1→2, 1→8.7, 1→8, 1→8, 1→8, 1→2, 1→9, 1→9, 1→8 |
| Hexagon | 1→8, 1→7, 1→1, 1→4, 1→6.7, 1→8, 1→4, 1→1, 1→5, 1→4, 1→8, 1→7 |
| Monza | 3.3→8.7, 3.3→8, 3.3→8, 3.3→8.3, 3.3→8, 3.3→8, 3.3→8, 3.3→5, 3.3→8, 3.3→8, 3.3→8, 3.3→8 |
| Rect | 10→10 to 11.7 (tuning changed in 7 of 12) |
| Tri | 7.7→7.7 in 10 of 12, 7.7→14 and 7.7→8 in 2 |

Every row, with per-generation champion progress and the tuning found, is in
`n24.jsonl` and `n500.jsonl`.

## Summary

| Run | Track | Lapped (fixed → tuned) | Median first lap (censored = cap) | Mean | Tuned sooner / later / tie |
|---|---|---|---|---|---|
| N=24 | Oval | 11/12 → 12/12 | 7 → 0 | 17.8 → 0.3 | 11 / 0 / 1 |
| N=24 | Hexagon | 7/12 → 10/12 | 50.5 → 0 (s1 66 → 0, s2 44.5 → 9.5) | 49.3 → 20.0 | 9 / 1 / 2 |
| N=24 | Monza | 12/12 → 12/12 | 1 → 0 | 1.8 → 0 | 12 / 0 / 0 |
| N=24 | Rect | 12/12 → 12/12 | 0 → 0 | 0 → 0 | 0 / 0 / 12 |
| N=24 | Tri | 11/12 → 11/12 | 26 → 26 | 32.2 → 29.6 | 2 / 0 / 10 |
| N=500 | Hexagon | 4/6 → 6/6 | 12 → 0 | 18.0 → 0.3 | 6 / 0 / 0 |
| N=500 | Tri | 6/6 → 6/6 | 2.5 → 2.5 | 3.3 → 3.3 | 0 / 0 / 6 |

Kill criterion (#70: drop the tuner if it gives less than 15% gain on the weak
presets, or if it costs more time than it saves): on the three weak presets
the mean generations to the first lap fall by 59–100% at population 24, and
by 98% on Hexagon at 500. The time cost is far below one generation (next
section). The change clears the criterion and ships ON.

Read the weak-preset gain per track, not as one range. Monza's 100% is one
generation: the fixed arm already laps at generation 1 in 10 of 12 pairs.
The large gains are Oval (mean 17.8 → 0.3) and Hexagon (49.3 → 20.0 at
population 24, 18.0 → 0.3 at 500). Hexagon also has the one pair that got slower.

Time cost:

- Browser (`tests/reflex-tune-browser.mjs`, headless Chromium, Oval, 20 s
  drives): 62 drives in 102–120 ms on the main thread over 5 runs, once per
  context. A cached tuning is read in under 0.1 ms. A reviewer measured 100 s
  generations at 280–450 ms, and 0.86–1.5 s with the CPU throttled 4–6x.
- Node: 0.6–1 s for one tune in a single process; 0.75–3 s with 14 benchmark
  processes running at once. A drive stops when the car crashes, so tracks
  where most candidates crash early tune faster.
- One live generation is 20 s of simulation. So the tuner costs well under
  one generation and saves between 1 (Monza) and about 30 (Hexagon, mean) of them.

## How strong is this evidence

- **Strong on the three weak presets at this spawn.** 32 pairs sooner, 1 later
  and 3 ties over 36 pairs at population 24 (two-sided sign test on 33 decided
  pairs: p < 1e-8). Both seed families agree on every track. At the live
  population (500) on Hexagon, 6 of 6 pairs are sooner.
- **Most of the gain is the tuned reflex itself.** The tuned reflex alone
  laps Oval, Hexagon and Monza in most pairs, so the tuned arm records
  generation 0. This is the same pattern as #62 on Rect.
- **Tuner variance is real.** On Hexagon the tuner found nothing in 2 of 12
  pairs (score stays 1), and those pairs tie the fixed arm. In 1 pair
  (Hexagon s1#3: 4 → 32) the tuned reflex passed 4 gates without a lap, and
  the GA took longer to finish the lap from it. This is the local-optimum risk
  named in #62. It happened once in 36 weak-preset pairs.
- **Rect and Tri: about no change, as expected.** The fixed tuning was fitted
  there, and the stride-robust ranking keeps it in most pairs. On Tri, 2 pairs
  got sooner (5 → 0, 71 → 45) and none later.
- **Not measured:** browser sessions over many runs (the Node simulator is
  deterministic), the other weak presets (Pentagon, Silverstone, Monaco, Spa,
  Suzuka; the tuner alone takes them from 1–4 to 7–11 gates in a probe, not a
  paired run), warm starts (unchanged by construction: there is no reflex car),
  collision mode (the tuner drives from the start line, not from the heat's
  start row), and the GA after generation 0 at live strides: the GA arms run
  at stride 1. A reviewer probe found the tuned reflex alone never worse than
  the fixed one at strides 8 and 16 on six tracks.

Reproduce:

```
node scripts/benchmark-reflex-tune.mjs --tracks=Oval --family=s1 --start=0 --runs=6 --output=test-results/rt/n24-Oval-s1.jsonl
node scripts/benchmark-reflex-tune.mjs --tracks=Hexagon --family=s1 --start=0 --runs=3 --population=500 --generations=40 --output=test-results/rt/n500-Hexagon-s1.jsonl
node scripts/summarize-reflex-tune.mjs test-results/rt/*.jsonl
```

The `s2` family used `--start=6` (population 24) and `--start=3` (population 500).
