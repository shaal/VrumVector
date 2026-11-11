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
- The tuning (`REFLEX_TUNING`) was chosen on a small grid on Rect and Tri at 20 s,
  then frozen before any paired run.

## Raw results (baseline / reflex, first-lap generation)

Population 24, cap 80 generations (n = 24 per track):

| Track | Pairs |
|---|---|
| Rect | s1#0: 46 / 0, s1#1: 33 / 0, s1#2: 12 / 0, s1#3: >79 / 0, s1#4: 48 / 0, s1#5: 46 / 0, s1#6: >79 / 0, s1#7: 2 / 0, s1#8: 16 / 0, s1#9: 35 / 0, s1#10: 43 / 0, s1#11: 5 / 0, s2#0: >79 / 0, s2#1: 17 / 0, s2#2: 10 / 0, s2#3: 23 / 0, s2#4: 68 / 0, s2#5: >79 / 0, s2#6: 23 / 0, s2#7: >79 / 0, s2#8: >79 / 0, s2#9: >79 / 0, s2#10: 21 / 0, s2#11: 19 / 0 |
| Tri | s1#0: >79 / 55, s1#1: >79 / >79, s1#2: >79 / 60, s1#3: >79 / 11, s1#4: >79 / 69, s1#5: >79 / 19, s1#6: >79 / >79, s1#7: >79 / >79, s1#8: >79 / 48, s1#9: >79 / 17, s1#10: >79 / 20, s1#11: >79 / 51, s2#0: >79 / 4, s2#1: >79 / 54, s2#2: >79 / 22, s2#3: >79 / 26, s2#4: >79 / 9, s2#5: >79 / 16, s2#6: >79 / 29, s2#7: >79 / 31, s2#8: >79 / 57, s2#9: >79 / 1, s2#10: >79 / >79, s2#11: >79 / >79 |

Population 500 (the live `batchSize`), cap 40 generations (n = 6 per track):

| Track | Pairs |
|---|---|
| Rect | s1#0: >39 / 0, s1#1: 2 / 0, s1#2: 2 / 0, s2#3: 1 / 0, s2#4: 2 / 0, s2#5: 2 / 0 |
| Tri | s1#0: >39 / 3, s1#1: >39 / 6, s1#2: 21 / 21, s2#3: >39 / 1, s2#4: >39 / 2, s2#5: >39 / 8 |

Per-generation champion progress for every arm is in `n24.jsonl` and `n500.jsonl`.

## Summary

| Run | Track | Lapped (base / reflex) | Median first lap (censored = cap) | Reflex sooner / later / tie |
|---|---|---|---|---|
| N=24 | Rect | 17 / 24 → 24 / 24 | 39 → 0 | 24 / 0 / 0 |
| N=24 | Tri | 0 / 24 → 19 / 24 | >80 → 39.5 | 19 / 0 / 5 |
| N=500 | Rect | 5 / 6 → 6 / 6 | 2 → 0 | 6 / 0 / 0 |
| N=500 | Tri | 1 / 6 → 6 / 6 | >40 → 4.5 | 5 / 0 / 1 |

Kill criterion (#62: drop if less than 15% fewer generations on either shape):
cleared on both shapes at both population sizes. The baseline medians are
censored, so the Tri reductions are lower bounds.

## How strong is this evidence

- **Tri is the real test.** The reflex alone passes 6 of 9 gates there, so the
  GA must still find the lap. Across both families, no pair got slower: 19–0 at
  N=24 and 5–0 at N=500. The apex local-optimum risk named in #62 did not show:
  every tie is a pair where neither arm lapped, or both lapped at the same generation.
- **Rect is decided before the GA runs.** The reflex car alone laps Rect in
  20 s, so the reflex arm always records generation 0. That is a real gain for
  a player on Rect, but it says nothing about learning. At the live population
  (500) the cold baseline already laps Rect at generation 1–2, so the gain there
  is 1–2 generations.
- **Tuned and measured on the same tracks and spawn.** On the other presets
  the reflex alone is weak at 20 s: Oval, Hexagon and Pentagon 1 gate, Monza,
  Monaco and Spa 2, Silverstone 3, Suzuka 1 lap. Expect little gain there.
  The seed costs one car of the population, and that car only matters if it
  ranks as champion.
- **Not measured:** browser sessions (the Node simulator is deterministic),
  tracks other than Rect and Tri in paired runs, and warm starts (the reflex
  car is never added when any seed or champion exists, so the warm path is
  unchanged by construction).

Reproduce:

```
node scripts/benchmark-reflex.mjs --tracks=Rectangle,Triangle --family=s1 --runs=12
node scripts/benchmark-reflex.mjs --tracks=Triangle --family=s1 --runs=1 --population=500 --generations=40
```
