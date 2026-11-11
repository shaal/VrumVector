# Reflex re-injection (#72): results

When progress stalls, one fresh `reflexBrain()` takes the first novel slot of
the next generation (`buildPopulation` option `reinjectReflex`, period M = 5).
It fires when the plan has `stagnant` 5, then at 10, 15, ... while the stall
lasts. It never takes the elite slot, and it needs a champion or a seed, so a
cold generation 0 keeps only the #62 seed.

**Verdict: OFF.** It did not clear the kill criterion. In the live setting
(the #62 seed ON) it changed nothing: 36 ties in 36 pairs. Turn it on for one
browser with `localStorage.reflexReinject = '1'`. #72 stays open.

## Method

- `scripts/benchmark-reflex-reinject.mjs`: paired `runTrialArm` runs. Both arms
  share every seeded stream (population and physics). The re-injected reflex
  draws its random weights first, so the two arms are identical up to the
  first stagnation flag (`tests/reflex.test.mjs`).
- Flag: the first generation whose plan has `stagnant === 5`. That generation
  gets the reflex.
- Metric: generations from the flag to the first generation at or after it
  that improves the incumbent (the `LearningCoach.record` rule). No
  improvement before the cap counts as the cap (`+` below, censored).
- Settings: population 24, 60 generations, 20 s, profile `balanced`, mutation
  .22, conservative init .65, fixed exploration (`plan(.22, false)`: novel .1,
  so 2 novel slots).
- Tracks: Rectangle and Triangle, and Oval, where the reflex alone is weak
  (1 gate in 20 s). Two seed families (`s1`, `s2`), 6 pairs each: n = 12 per
  track and condition.
- Two conditions:
  - **Live (seed ON):** the #62 reflex seed is in generation 0 of both arms.
    This is the default and the primary result.
  - **No seed (seed OFF):** no reflex in generation 0. This stands in for a
    population that never saw the reflex.
- Rule, fixed before the runs: gain = 1 - mean(re-inject) / mean(baseline).
  Drop it if the gain is under 5% on both Rect and Tri. Ship it ON only if it
  clears 5% on one of them in the live condition and does not get worse on
  the other.

## Raw results (baseline / re-inject, generations from flag to improvement)

`fN` is the flag generation. Rows for every arm, with per-generation champion
progress, are in `reinject.jsonl`.

Live (seed ON):

| Track | Pairs |
|---|---|
| Rect | s1#0: f6 3/3, s1#1: f6 3/3, s1#2: f6 0/0, s1#3: f6 2/2, s1#4: f8 8/8, s1#5: f8 52+/52+, s2#0: f6 2/2, s2#1: f6 2/2, s2#2: f6 24/24, s2#3: f6 2/2, s2#4: f11 10/10, s2#5: f6 10/10 |
| Tri | s1#0: f6 14/14, s1#1: f6 54+/54+, s1#2: f9 51+/51+, s1#3: f6 54+/54+, s1#4: f6 29/29, s1#5: f6 29/29, s2#0: f6 11/11, s2#1: f6 33/33, s2#2: f6 54+/54+, s2#3: f6 54+/54+, s2#4: f6 54+/54+, s2#5: f6 16/16 |
| Oval | s1#0: f10 1/1, s1#1: f7 7/7, s1#2: f7 21/21, s1#3: f9 43/43, s1#4: f18 16/16, s1#5: f6 2/2, s2#0: f19 9/9, s2#1: f9 6/6, s2#2: f10 6/6, s2#3: f7 3/3, s2#4: f8 6/6, s2#5: f13 15/15 |

No seed (seed OFF):

| Track | Pairs |
|---|---|
| Rect | s1#0: f6 5/0, s1#1: f13 45/0, s1#2: f6 45/0, s1#3: f8 38/0, s1#4: f6 16/0, s1#5: f6 0/0, s2#0: f6 10/0, s2#1: f6 21/0, s2#2: f6 25/0, s2#3: f9 1/0, s2#4: f6 0/0, s2#5: f9 11/0 |
| Tri | s1#0: f6 1/0, s1#1: f8 52+/0, s1#2: f9 10/0, s1#3: f11 49+/0, s1#4: f6 0/0, s1#5: f8 52+/0, s2#0: f6 8/0, s2#1: f6 18/0, s2#2: f8 52+/0, s2#3: f6 1/0, s2#4: f6 7/0, s2#5: f7 53+/0 |
| Oval | s1#0: f10 3/3, s1#1: f6 7/7, s1#2: f6 54+/54+, s1#3: f6 54+/54+, s1#4: f6 54+/54+, s1#5: f6 54+/54+, s2#0: f6 6/6, s2#1: f6 54+/54+, s2#2: f6 54+/54+, s2#3: f6 54+/54+, s2#4: f6 14/14, s2#5: f6 54+/54+ |

## Summary

| Condition | Track | Mean (censored = cap) | Median | Gain | Sooner / later / tie | Final best |
|---|---|---|---|---|---|---|
| Live | Rect | 9.83 → 9.83 | 3 → 3 | 0% | 0 / 0 / 12 | 12.00 → 12.00 |
| Live | Tri | 37.75 → 37.75 | 42 → 42 | 0% | 0 / 0 / 12 | 11.50 → 11.50 |
| Live | Oval | 11.25 → 11.25 | 6.5 → 6.5 | 0% | 0 / 0 / 12 | 11.25 → 11.25 |
| No seed | Rect | 18.08 → 0 | 13.5 → 0 | 100% | 10 / 0 / 2 (sign p = .002) | 5.67 → 11.50 |
| No seed | Tri | 25.25 → 0 | 14 → 0 | 100% | 11 / 0 / 1 (sign p = .001) | 4.92 → 11.92 |
| No seed | Oval | 38.50 → 38.50 | 54 → 54 | 0% | 0 / 0 / 12 | 2.58 → 2.58 |

## How strong is this evidence

- **Strong that it does nothing in the live setting.** All 36 live pairs are
  identical, generation for generation, over 60 generations. The re-inject arm
  got 8–11 re-injected reflex cars per pair. None raised a generation's best
  progress. The likely cause:
  with the #62 seed, generation 0 already holds the reflex, and the champion
  is the reflex or a descendant at least as good. A fresh copy scores at most
  the same, and a tie does not replace the incumbent. The #62 note that mutation erodes the reflex
  does not show up as a lost champion: the elite slot keeps it.
- **The no-seed gain is the #62 effect, late.** Without a generation-0 seed,
  the re-injected reflex is the first reflex the population sees. On Rect and
  Tri it scores more than the stalled champion (Rect laps, Tri passes 9
  gates), so it improves at once (0 generations, every pair). The #62 seed
  already gives that gain at generation 0, so this adds nothing to a live
  cold start.
- **Where it could still help: warm starts.** A live run with memories or a
  saved driver gets no #62 seed (`buildPopulation` adds it only on a cold
  start). If that warm champion is weaker than the reflex on the current
  track, the no-seed rows suggest a re-injection would lift it. That was not
  measured here. A paired warm-start benchmark is the next test for #72.
- **Oval: no help in either condition.** The reflex alone passes 1 of 4
  gates in 20 s (`RESULTS.md`), so it never beats a champion there.
- **Limits.** The Node simulator is deterministic, so the seed families are
  seed-to-seed variance, not browser-session variance. The benchmark uses
  fixed exploration (2 novel slots of 24, no mutation boost). Live adaptive
  play at stagnant 5 has 20% novel slots and 1.25× mutation; at stagnant 10,
  35% and 1.7×. One population size (24) only.

## Where the option is wired

- Live training (`DriverLearning.build` → `buildPopulation`), read from
  `localStorage.reflexReinject` (`reflexReinjectEnabled`, default OFF).
- The A/B view's baseline arm (`main.js` `buildBrainsBufferB`) reads the same
  flag, so both arms differ only in memory.
- `runTrialArm` passes `reinjectReflex` through. The transfer check does not
  set it.
- With the flag on, loading a saved driver can put one re-injected reflex next
  to it in the first generation: the plan is made from the old coach before
  its champion is cleared. The next result resets the stall count.

Reproduce:

```
# For each family (s1, s2) and condition (seed ON, --seed=0):
node scripts/benchmark-reflex-reinject.mjs --tracks=Rectangle,Triangle,Oval --family=s1 --runs=6 --output=docs/plan/reflex-seed/reinject.jsonl
node scripts/benchmark-reflex-reinject.mjs --tracks=Rectangle,Triangle,Oval --family=s1 --runs=6 --seed=0 --output=docs/plan/reflex-seed/reinject.jsonl
```
