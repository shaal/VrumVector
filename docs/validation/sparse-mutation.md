# Sparse additive mutation (#63)

**Result: no gain. The change ships behind a flag that is off by default, in
the browser and in the cloud trainer.** The kill criterion of #63 ("no gain
at n≥6 on either shape") is met on both shapes.

## What changed

- **Off (default):** every one of the 244 weights moves toward uniform noise,
  `w = lerp(w, U(-1,1), amount)`. This is the same, draw for draw, as before.
- **On:** each weight moves with probability `p = 0.15`, by `w += N(0, σ)`,
  with `σ = sigmaScale · amount` and `sigmaScale = 1`. The other weights stay
  the parent's.
- **Where:**
  - `learning/policy.js` `mutateInto` (the live path, through `buildPopulation`).
  - `main.js` `fillMutated` (the fallback path).
  - `cloud-brain/core/src/brain.rs` `mutate` (the cloud trainer).
- **Switches:**
  - Browser: `globalThis.vvSparseMutation = true` (or `{p, sigmaScale}`) in the console.
  - Cloud: the Worker variable `TRAIN_SPARSE_MUTATION=true`.
- `p` and `σ` were fixed before any measured run. They were not tuned on the
  measured seeds. The Grind and Polish presets were not retuned, because the
  change ships off.

## Method

- **Command:** `node scripts/benchmark-sparse-mutation.mjs --family=<A|B> --runs=6`.
- **Pairing:** each pair runs `runTrialArm` twice, lerp and sparse. Both arms
  use the same seeded physics and population streams, and both start fresh
  (no memories).
- **Settings:** population 100, 25 generations, 20 s a generation, mutation
  0.22, profile balanced, maxSpeed 15, traction 0.5.
- **Sample:** Rectangle and Triangle; two disjoint seed families (A and B,
  the "sessions"); n = 6 per family, so n = 12 per track.
- **Metrics:**
  - **Best after K:** the champion's progress after 25 generations, as
    checkpoints + laps × gates.
  - **First lap:** the first generation (0-based) whose best car laps.
  - **Beat parent:** the mutated children that strictly beat the elite copy
    of their parent, driven in the same generation.
- **Decision rule, fixed before the runs:** turn it on only if, on both
  tracks with the families pooled, sparse wins more paired trials than it
  loses (best after K, then area) and the median paired difference in best
  after K is > 0.

## Summary (n = 12 per track)

| Track | Sparse wins | Lerp wins | Ties | Sign test p | Median best (lerp / sparse) | Median diff | Beat parent (lerp / sparse) | Lapped in 25 (lerp / sparse) | Median first lap (lerp / sparse) |
|---|---|---|---|---|---|---|---|---|---|
| Rectangle | 6 | 6 | 0 | 1.00 | 8 / 8.5 | 0 | 0.39% / 0.29% | 11 / 7 | 9 / 5 |
| Triangle | 6 | 5 | 1 | 1.00 | 4.5 / 5 | 0 | 0.074% / 0.129% | 0 / 0 | — |

Decision: **off**.

## How strong the evidence is

- **Weak in both directions.** On both tracks the paired wins are a coin
  flip (p = 1.0). The median difference is 0. This sample cannot rule out an
  effect of ±1 checkpoint.
- **Rectangle:** sparse fails to lap more often (5 of 12 runs never lap,
  against 1 of 12 for lerp). When it does lap, it laps sooner (median
  generation 5 against 9). Taken together, these runs are bimodal and do not
  show a clear win.
- **Triangle:** no arm laps in 25 generations, so the first-lap metric says
  nothing there.
- **Beat parent:** it is below 1.5% for both arms, so the counts are small
  (19 to 100 children out of 25 632 per arm and track). Sparse is lower on Rectangle and higher on
  Triangle. #63 estimated "10–30% more children that beat their parent". The
  data shows nothing like that on Rectangle.
- **Cloud trainer:** the cloud trainer itself was not benchmarked. Its unit
  test (`cloud-brain/core/tests/train.rs`) runs four pinned sessions per arm.
  In that one set, sparse archived a better child in 4 of 4 sessions, against
  2 of 4 for lerp. That is n = 1 set, not evidence, but it could justify a
  measured cloud run later.
- **Not tested:**
  - Other values of `p` or `σ`.
  - Seeded (memory) starts.
  - The population of 500 that the game uses.

## Raw runs

The same data is in [sparse-mutation.json](sparse-mutation.json).

| Run | Lerp best | Sparse best | Lerp first lap | Sparse first lap | Lerp beat/children | Sparse beat/children | Winner |
|---|---|---|---|---|---|---|---|
| Rectangle A0 | 6 | 4 | 24 | — | 5/2136 | 1/2136 | lerp |
| Rectangle A1 | 12 | 3 | 4 | — | 14/2136 | 3/2136 | lerp |
| Rectangle A2 | 8 | 5 | 15 | — | 3/2136 | 3/2136 | lerp |
| Rectangle A3 | 8 | 9 | 10 | 2 | 5/2136 | 12/2136 | sparse |
| Rectangle A4 | 8 | 8 | 9 | 9 | 14/2136 | 5/2136 | sparse |
| Rectangle A5 | 8 | 9 | 13 | 7 | 7/2136 | 13/2136 | sparse |
| Triangle A0 | 4 | 6 | — | — | 2/2136 | 1/2136 | sparse |
| Triangle A1 | 6 | 4 | — | — | 3/2136 | 0/2136 | lerp |
| Triangle A2 | 4 | 5 | — | — | 0/2136 | 1/2136 | sparse |
| Triangle A3 | 4 | 4 | — | — | 1/2136 | 1/2136 | lerp |
| Triangle A4 | 9 | 4 | — | — | 2/2136 | 0/2136 | lerp |
| Triangle A5 | 4 | 5 | — | — | 1/2136 | 13/2136 | sparse |
| Rectangle B0 | 9 | 9 | 2 | 17 | 16/2136 | 7/2136 | lerp |
| Rectangle B1 | 11 | 12 | 0 | 0 | 4/2136 | 10/2136 | sparse |
| Rectangle B2 | 5 | 9 | — | 5 | 4/2136 | 11/2136 | sparse |
| Rectangle B3 | 8 | 9 | 21 | 3 | 8/2136 | 5/2136 | sparse |
| Rectangle B4 | 11 | 4 | 8 | — | 7/2136 | 2/2136 | lerp |
| Rectangle B5 | 8 | 3 | 5 | — | 13/2136 | 3/2136 | lerp |
| Triangle B0 | 4 | 7 | — | — | 0/2136 | 1/2136 | sparse |
| Triangle B1 | 6 | 6 | — | — | 1/2136 | 1/2136 | sparse |
| Triangle B2 | 5 | 4 | — | — | 1/2136 | 0/2136 | lerp |
| Triangle B3 | 4 | 4 | — | — | 0/2136 | 0/2136 | tie |
| Triangle B4 | 7 | 5 | — | — | 5/2136 | 3/2136 | lerp |
| Triangle B5 | 6 | 6 | — | — | 3/2136 | 12/2136 | sparse |
