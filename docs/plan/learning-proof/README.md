# Driver-learning policy experiment

This small experiment found mixed results. Adaptive exploration won 7 paired seeds, tied 34, and lost 4 on final best checkpoint progress. It is therefore **off by default** for new visitors; users can opt in. The experiment does not establish a universal improvement.

## Reproduce

```sh
npm run benchmark:learning -- --seeds=3 --generations=15 --population=24 --seconds=6 --output=docs/plan/learning-proof/policy-benchmark.json
```

The harness uses the actual car physics, sensor code, collision detection, neural network, and preset checkpoint geometry. Each of 90 runs contains 15 generations of 24 cars, with six simulated seconds per generation at 60 Hz. Three paired seeds are shared across fixed/adaptive modes and profiles on each track. Both modes protect the same evaluated champion. All simulated car states were finite.

No vector archive, renderer, networking, or sensor skipping is involved. This isolates the genetic exploration schedule, not the full ruvector system. Profile speed limits make short-run scores a poor measure of driving safety or personality. The same-network physics tests separately verify the styles' control differences.

## Final best checkpoint progress

Values below are means across the three paired seeds. Higher progress is better; population survival can fall when more challengers explore.

| Track | Profile | Fixed | Adaptive | Adaptive wins / ties / losses |
| --- | --- | ---: | ---: | --- |
| Rectangle | Balanced | 2.33 | 2.33 | 0 / 3 / 0 |
| Rectangle | Calm | 2.00 | 2.00 | 0 / 3 / 0 |
| Rectangle | Careful | 2.00 | 2.67 | 2 / 1 / 0 |
| Rectangle | Wild | 2.00 | 2.33 | 1 / 2 / 0 |
| Rectangle | Reckless | 3.00 | 2.33 | 0 / 1 / 2 |
| Triangle | Balanced | 4.00 | 4.00 | 0 / 3 / 0 |
| Triangle | Calm | 3.00 | 3.67 | 2 / 1 / 0 |
| Triangle | Careful | 3.33 | 4.00 | 1 / 2 / 0 |
| Triangle | Wild | 4.00 | 3.67 | 0 / 2 / 1 |
| Triangle | Reckless | 3.33 | 3.33 | 0 / 3 / 0 |
| Monza | Balanced | 2.33 | 2.00 | 0 / 2 / 1 |
| Monza | Calm | 2.33 | 2.33 | 0 / 3 / 0 |
| Monza | Careful | 2.00 | 2.00 | 0 / 3 / 0 |
| Monza | Wild | 2.00 | 2.00 | 0 / 3 / 0 |
| Monza | Reckless | 2.00 | 2.33 | 1 / 2 / 0 |

## Paired verdicts

`scripts/benchmark-learning.mjs` reports a paired bootstrap verdict for
adaptive minus fixed final best progress (`AI-Car-Racer/learning/decision.js`).
All five profiles on one track start from the same seeded population, so the
verdict resamples whole (track, seed) clusters, not single pairs. Settings:
10000 resamples; an expanded percentile 95% interval (Hesterberg), which kept
false passes near 2% on simulated symmetric no-effect data, including tied
whole-checkpoint deltas; fewer than 6 clusters is always inconclusive. **pass**
means the interval's lower bound reaches 0.25 checkpoints. **fail** means the
upper bound is below 0.25, so a gain of that size is ruled out ("no meaningful
improvement", not necessarily a regression). A track whose own interval lies
below zero vetoes a pooled pass.

| Run | Rectangle | Triangle | Monza | Overall |
|---|---|---|---|---|
| 3 seeds (this report) | too few clusters (3) | too few clusters (3) | too few clusters (3) | inconclusive: Δ +0.09 [−0.08, +0.31], 45 pairs in 9 clusters |
| 6 seeds ([raw](policy-benchmark-6seeds.json)) | inconclusive: Δ 0.00 [−0.30, +0.29] | inconclusive: Δ +0.13 [−0.06, +0.43] | inconclusive: Δ +0.10 [−0.04, +0.30] | **fail**: Δ +0.08 [−0.03, +0.19], 90 pairs in 18 clusters |

With six seeds, a gain of 0.25 checkpoints from adaptive exploration is ruled
out overall, though no single track rules it out. The six-seed run extends the
three-seed run (its first three seeds are the same 90 records), so it is more
data, not an independent replication. One of the 15 track/profile cells has an
interval that excludes zero: Triangle / Calm, Δ +0.67 [+0.17, +1.15]. Its lower
bound is below the 0.25 threshold, and with 15 cells about 0.4 such results are
expected by chance at the 2.5% level. The default stays at fixed exploration.

## Interpretation and limits

- Balanced tied on Rectangle and Triangle, and lost one Monza seed. There is no evidence here to enable adaptation universally.
- Careful improved in some Rectangle and Triangle seeds. Reckless regressed on Rectangle and improved in one Monza seed. Effects depend on track and profile.
- Champion preservation prevented loss of the best previously evaluated checkpoint score within a run. It cannot guarantee the same trajectory under different timing, perception, or vehicle settings.
- The benchmark is short and has only three seeds per comparison. Longer runs, more seeds, and held-out tracks are needed for statistical or transfer-learning claims.
- The default retains fixed exploration while exposing adaptive exploration for experimentation. No speed bonus has been added to the primary checkpoint objective.

[Raw results, configuration, and every generation](policy-benchmark.json) are committed alongside this report.
