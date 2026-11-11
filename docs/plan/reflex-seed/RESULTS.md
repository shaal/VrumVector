# Reflex seed (#62): results

One hand-written reflex driver (`AI-Car-Racer/learning/reflex.js`) takes slot 0
of a cold generation 0: no memories, no saved driver, no champion. The reflex
steers away from the nearer wall, lifts the throttle when the front ray is short
and the car is fast, and pulls toward the next gate. It is ON by default.
`localStorage.reflexSeed = '0'` turns it off for one browser.

## Method

- `scripts/benchmark-reflex.mjs`: paired `runTrialArm` runs. Both arms of a pair
  share every seeded stream (population and physics). The reflex car draws its
  random weights first, so cars 1..N-1 of generation 0 are identical in both
  arms (`tests/reflex.test.mjs`). Only slot 0 differs.
- Metric: the first generation whose champion completes a lap (`laps >= 1`).
  `>G-1` means no lap within the cap (censored).
- Settings: 20 s generations (the live default), profile `balanced`, mutation .22,
  conservative init .65.
- Two seed families (`s1`, `s2`) stand in for "two sessions". The simulator is
  deterministic, so this is seed-to-seed variance, not browser-session variance.
- Tuning (`REFLEX_TUNING`): the best of a small grid on Rect and Tri at 20 s,
  frozen before the paired runs. Every weight is within ±16, the shared cloud
  brain's limit (`cloud/wire.js` `maxWeight`).
- History: a first tuning had one weight of 20. The cloud brain refuses that, so
  it was re-tuned under the limit and every paired run was repeated. The first
  tuning gave the same picture: Tri 19 sooner, 0 later and 5 ties at N=24, and
  5 sooner, 0 later and 1 tie at N=500. The baseline arms are identical in both rounds.

## Raw results (baseline / reflex, first-lap generation)

Population 24, cap 80 generations (n = 24 per track):

| Track | Pairs |
|---|---|
| Rect | s1#0: 46 / 0, s1#1: 33 / 0, s1#2: 12 / 0, s1#3: >79 / 0, s1#4: 48 / 0, s1#5: 46 / 0, s1#6: >79 / 0, s1#7: 2 / 0, s1#8: 16 / 0, s1#9: 35 / 0, s1#10: 43 / 0, s1#11: 5 / 0, s2#0: >79 / 0, s2#1: 17 / 0, s2#2: 10 / 0, s2#3: 23 / 0, s2#4: 68 / 0, s2#5: >79 / 0, s2#6: 23 / 0, s2#7: >79 / 0, s2#8: >79 / 0, s2#9: >79 / 0, s2#10: 21 / 0, s2#11: 19 / 0 |
| Tri | s1#0: >79 / 1, s1#1: >79 / >79, s1#2: >79 / 20, s1#3: >79 / 27, s1#4: >79 / 3, s1#5: >79 / >79, s1#6: >79 / >79, s1#7: >79 / 51, s1#8: >79 / 43, s1#9: >79 / 27, s1#10: >79 / 58, s1#11: >79 / 69, s2#0: >79 / 12, s2#1: >79 / 13, s2#2: >79 / 5, s2#3: >79 / 13, s2#4: >79 / 22, s2#5: >79 / 18, s2#6: >79 / 37, s2#7: >79 / 24, s2#8: >79 / 66, s2#9: >79 / 11, s2#10: >79 / 23, s2#11: >79 / 40 |

Population 500 (the live `batchSize`), cap 40 generations (n = 6 per track):

| Track | Pairs |
|---|---|
| Rect | s1#0: >39 / 0, s1#1: 2 / 0, s1#2: 2 / 0, s2#3: 1 / 0, s2#4: 2 / 0, s2#5: 2 / 0 |
| Tri | s1#0: >39 / 1, s1#1: >39 / 1, s1#2: 21 / 2, s2#3: >39 / 2, s2#4: >39 / 1, s2#5: >39 / 1 |

Per-generation champion progress for every arm is in `n24.jsonl` and `n500.jsonl`.

## Summary

| Run | Track | Lapped (base → reflex) | Median first lap (censored = cap) | Reflex sooner / later / tie |
|---|---|---|---|---|
| N=24 | Rect | 17/24 → 24/24 | 39 → 0 | 24 / 0 / 0 |
| N=24 | Tri | 0/24 → 21/24 | >79 (80) → 25.5 (s1 47, s2 20) | 21 / 0 / 3 |
| N=500 | Rect | 5/6 → 6/6 | 2 → 0 | 6 / 0 / 0 |
| N=500 | Tri | 1/6 → 6/6 | >39 (40) → 1 | 6 / 0 / 0 |

Kill criterion (#62: drop the change if it gives less than 15% fewer generations on either shape):
the change clears it on both shapes at both population sizes. The baseline medians are
censored, so the Tri reductions are lower bounds.

## How strong is this evidence

- **Strong for Rect and Tri at this spawn.** No pair got slower: 57 sooner,
  0 later and 3 ties over 60 pairs. Both seed families agree. The three ties
  are Tri pairs where neither arm lapped. The apex local-optimum risk named in
  #62 did not show.
- **Much of the gain is the reflex itself, not faster learning.** The reflex
  alone laps Rect (10 progress in 20 s) and passes all 9 Tri gates without a
  lap. So on Rect the reflex arm records generation 0 every time, and on Tri
  the GA only has to finish the lap. At the live population (500) the cold
  baseline already laps Rect at generation 1–2 in 5 of 6 pairs, so the gain there is 1–2
  generations. On Tri the gain is large: 6/6 lap by generation 2, against
  1/6 by generation 39.
- **Tuned and measured on the same tracks and spawn.** The reflex's own score
  is sensitive to its tuning: `gateSteer` .5 instead of 1 takes Rect from 10
  to 3 gates, and `gateGain` 18 instead of 16 makes it lap Tri on its own. On the other presets the reflex alone is weak at 20 s: Oval,
  Hexagon and Pentagon 1 gate, Monza, Monaco and Spa 2, Silverstone and Suzuka
  4. Expect little gain on those tracks. The seed costs one car of the
  population, and that car matters only if it ranks as champion.
- **Not measured:** browser sessions (the Node simulator is deterministic),
  paired runs on tracks other than Rect and Tri, and warm starts. The reflex
  car is never added when any seed or champion exists, so the warm path is
  unchanged by construction.

## Where the reflex car is used

- Live training (`DriverLearning.build` → `buildPopulation`) on a cold start.
- The A/B view's baseline arm (`main.js`), whenever its coach is cold. Arm A
  may start from memory, so the A/B lift now measures memory against a
  reflex-seeded cold start. Do not compare A/B lifts from before and after #62.
- The transfer check's fresh arm (`transferCheck.js`). The fresh arm matches a
  live cold start, and the memory arm has seeds, so it never gets the reflex
  car. The test identity gains `|r1`, so earlier verdicts are re-tested.
- `reflexBrain()` is exported for #59, which can use it as a fixed baseline.
- Weight limit: the largest reflex weight is exactly 16. The default lerp
  mutation keeps every child within ±16. The sparse mutation of #63 (flag off)
  adds Gaussian noise, so with it on about half the close children of a reflex
  champion would exceed the cloud brain's limit.

Reproduce:

```
node scripts/benchmark-reflex.mjs --tracks=Rectangle,Triangle --family=s1 --runs=12
node scripts/benchmark-reflex.mjs --tracks=Triangle --family=s1 --runs=1 --population=500 --generations=40
```
