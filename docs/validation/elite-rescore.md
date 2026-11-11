# Elite re-score (issue #61): measured, ships OFF

**Verdict:** no variant clears the issue's kill criterion. The criterion is at least 5 points of survival gain on both Rectangle and Triangle. The code ships behind a flag that is OFF by default: `window.__eliteRescore` or `?rescore=1`.

## What the change does

`AI-Car-Racer/eliteRescore.js` runs in `sim-worker.js` `endGen`.

1. It takes the top 8 cars by `DriverProfiles.rank`.
2. It drives each car again alone, with full sensors (`senseEveryFrame`). Each car drives from the canonical pose and from 3 jittered poses. The poses use a radius of 12 px and ±6°, and each pose must pass `CarCollisions.poseClear`.
3. It crowns the car with the best mean rank (`mode: 'mean'`) or the best minimum rank (`mode: 'min'`).

The re-score skips collision mode.

There are two candidate pools:

- `pool: 'top'` uses the issue as written. It takes the top 8 whatever their progress.
- `pool: 'tied'` is the default when you turn the flag on. It takes only the top cars whose rank is exactly the plain winner's: the same progress, style score and (with the #60 time tie-break on) last-gate frame. A winner with no progress is not re-scored.

The learning coach (`learning/policy.js` `LearningCoach.record`) keeps a new champion only when it is strictly better on progress, then style, then (with #60 on) time. So `top` can crown a car with less progress. The coach then drops that car and also misses the record that the plain winner set. With `tied`, the coach sees the same fitness, style and time as for the plain winner, so it decides the same way. With the balanced profile (style 0) and the tie-break off, as in this benchmark, `tied` means "the winner's progress".

The `best` Δ < 0 values in the table below come from both pools. In the `tied` arms they cannot come from a lost record. They come from the runs drifting apart once a different brain seeds the next generation. So the data does not separate the lost-record harm of `top` from that drift.

## Method

The script is `scripts/benchmark-elite-rescore.mjs`, and the raw rows are in `elite-rescore-rows.jsonl`.

- **Loop:** paired `runTrialArm` loops, 12 generations each. N = 100, generations are 15 s long, and the profile is balanced.
- **Pairing:** all arms of a seed share the population stream and the physics stream. The re-score poses use a stream of their own.
- **Metric:** after the last generation, the coach's champion drives alone from 16 held-out jittered poses (12 px, ±6°, a third stream). Survival is the share of those runs that end without a crash.
- **Stride 1:** the population senses every frame, which is the trial-worker default. Two seed namespaces (`s1` and `s2`) count as the two sessions, with 4 seeds each, so n = 8 per track.
- **Stride 4:** the population skips 3 of 4 sensor reads, which models Grind. This is one namespace (`g1`) with 6 seeds, so n = 6 per track.

To reproduce:

```
node scripts/benchmark-elite-rescore.mjs --ns=s1 --seeds=4
node scripts/benchmark-elite-rescore.mjs --report --inputs=docs/validation/elite-rescore-rows.jsonl
```

## Results: paired survival Δ (arm − control), percentage points

| stride | track | top·mean | top·min | tied·mean | tied·min |
|---|---|---|---|---|---|
| 1 | Rectangle (n=8) | −3.1 (0/3/5) | +1.6 (2/3/3) | −3.9 (0/1/7) | −3.9 (0/1/7) |
| 1 | Triangle (n=8) | −1.6 (0/1/7) | +6.3 (1/2/5) | −1.6 (0/1/7) | −1.6 (0/1/7) |
| 4 | Rectangle (n=6) | +13.5 (1/0/5) | +3.1 (1/1/4) | +13.5 (1/0/5) | +13.5 (1/0/5) |
| 4 | Triangle (n=6) | +14.6 (2/1/3) | +17.7 (3/1/2) | −16.7 (0/1/5) | −8.3 (1/1/4) |

Each cell shows the mean Δ, then (wins/losses/ties). The smallest sign-test p in the table is 0.25. Survival is bimodal: most champions survive all 16 poses or none. So one seed moves a mean by 13–17 points. For example, the stride-4 Triangle top·mean raw Δ is [+88, −100, 0, 0, 0, +100].

**How strong is this evidence:** weak. No cell is significant.

- **Stride 1** is the harness the issue names. There, every variant is at or below +6.3 on at least one track, and most are slightly negative.
- **Stride 4, top·mean** is the only variant with a point estimate above +5 on both tracks. That estimate comes from one namespace and n=6, with 1 decided seed on Rectangle (+81) and 3 on Triangle. Treat it as a lead to retest with more seeds, not as a result.

Other observations:

- The crown changed in 0–11 of the 12 generations.
- The coach adopted a changed crown in 0–3 of the 12 generations, because of the strict-improvement rule.
- The champion's canonical `best` was the same or lower in nearly every pair. It was higher in only 2 seeds: +1 for one stride-1 Rectangle seed (min arm), and +3 for one stride-4 Rectangle seed (all 4 arms).

## Cost

| | `top` pool | `tied` pool |
|---|---|---|
| Extra car-frames per generation vs N·frames (N = 100) | 17–27% | 9–14% |
| Projected to the live N = 500 (car-frames scale 1/N) | 3–5.5% | 2–3% |
| Extra sim time per generation (stride 1, N = 100) | 27–33% | 14–20% |

- The extra sim time numbers are wall ms. Three benchmark processes shared the CPU, so they are noisy.
- At stride 4 the population is cheaper, so the relative overhead is about 2–3× higher.
- The re-score runs synchronously in `endGen`. That is a one-off pause at the end of each generation, and it does not depend on N.
  - In the browser smoke test it took about 30 ms with 4 s generations. Those were early generations, where most candidates crash soon.
  - In the benchmark it took 215–278 ms per 15 s generation for `tied`, and 576–977 ms for `top`. That projects to about 0.3 s (`tied`) or 0.8–1.3 s (`top`) at the default 20 s. Three benchmark processes shared the CPU, so these are upper estimates.

## Follow-ups

- The re-score cannot help much while the coach adopts only strictly higher fitness. A coach-side robustness signal is the real next step, for example a tie-break on re-score mean. Build it on the #60 time tie-break, which has landed behind its own flag.
- Retest stride-4 top·mean with at least 2 namespaces and n ≥ 12 per track before you turn on any variant.
