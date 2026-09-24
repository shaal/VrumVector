# Crash-map similarity

Adaptive gates recall archived crash maps and apply a stored gate layout only
when the recalled map is similar enough (`CRASH_SIM_MIN = 0.55` in
`AI-Car-Racer/adaptiveGates.js`) and its survival is at least three points
higher.

## The defect

Every index the bridge searches returns a distance-like score where 0 means
identical: VectorDB cosine distance (`1 - cos`), and the hyperbolic adapter's
squashed Poincaré distance. Track and dynamics retrieval converted it with
`1 - score`. Crash-map retrieval used `1 - score / 2`.

Crash grids are `log1p` counts and are L2-normalised, so no component is
negative and cosine is in [0, 1]. With `1 - score / 2`, the reported similarity
was `(1 + cos) / 2`. It never fell below 0.5, and the 0.55 floor admitted any
map with cosine ≥ 0.10.

Crash retrieval now uses `similarityFromDistance` in
`AI-Car-Racer/archive/similarity.js`: `1 - score`, clamped to [0, 1]. A
missing or non-numeric score counts as no match.

## Measured effect

`npm run benchmark:crash-similarity` runs real physics. Each generation
searches the vendored VectorDB for the top 5 crash maps archived earlier on the
same track, then applies the similarity floor. The script counts maps that are
eligible under the floor. It does not model the other adaptive-gate checks
(geometry signature, survival lift, stored layout), so an eligible map is not
necessarily applied.

| Settings | Track | Crash maps | Recalled | Eligible before | Eligible after | Cosine P10 / median / P90 |
|---|---|---:|---:|---:|---:|---|
| 32 cars, 8 s, 6 seeds × 15 gens | Rectangle | 69 | 330 | 328 (99%) | 297 (90%) | 0.553 / 0.718 / 0.823 |
| 32 cars, 8 s, 6 seeds × 15 gens | Triangle | 90 | 435 | 435 (100%) | 392 (90%) | 0.550 / 0.776 / 0.924 |
| 500 cars, 20 s (app default), 3 seeds × 10 gens | Rectangle | 30 | 135 | 135 (100%) | 135 (100%) | 0.801 / 0.888 / 0.938 |
| 500 cars, 20 s (app default), 3 seeds × 10 gens | Triangle | 30 | 135 | 135 (100%) | 135 (100%) | 0.728 / 0.933 / 0.960 |

Before the fix, the similarity floor rejected almost nothing at any setting.
At the app defaults, 500 deaths per generation give dense, stable crash maps,
so every recall is above the floor either way and the fix changes nothing.
With small populations (32 cars), crash maps are sparse and about one recall in
ten falls below the floor; those layouts are no longer eligible.

## Index geometry

Crash maps now stay on the cosine `VectorDB` when the brain, track, and
dynamics stores switch to the hyperbolic index (`?hhnsw=1` or
`setIndexKind('hyperbolic')`). Before, the crash store switched too. Poincaré
distances between crash maps were 15 to 23, so with the old conversion every
non-identical map reported about 0.50, just under the 0.55 floor, even at cosine
0.92. Hyperbolic mode therefore recalled only identical crash maps. With the new
`1 - score`, a hyperbolic crash store would report about 0.

## Reset

`_debugReset` (used by **Start Fresh**) cleared the crash-map mirror but kept
the crash store. After one new crash map was archived, a recall could return a
purged map. A browser probe recalled a purged map at similarity 1.0 before the
fix and only the new map after it. The reset now replaces the crash store too.

## Tests

`npm run test:crash-maps` checks the conversion (including clamping and bad
input). It runs real encoded crash maps through the vendored VectorDB and the
bridge's `crashLayoutFromHit` mapping, and confirms that the reported
similarity equals the true cosine and that the floor admits strong matches and
rejects weak and disjoint maps. A source check confirms that
`recommendCrashLayouts` uses that mapping and that the crash store is always a
`VectorDB`. Restoring `1 - dist / 2` in the helper or in the bridge fails the
suite.

`npm run test:learning:browser` archives a weak crash map through the real
bridge and checks the recalled similarity against its cosine in both the
euclidean and the hyperbolic index geometry.
