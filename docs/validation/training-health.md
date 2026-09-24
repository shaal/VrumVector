# Training health

The driver-learning panel shows a **Training health** pill during training:
Improving, Plateau, or Plateau while exploring, with the number of generations
since the champion last gained. It is a diagnostic. It does not change
training.

## Source

`AI-Car-Racer/learning/health.js` wraps the agentic clock from ruvector's
`emergent-time` crate (`vendor/ruvector/emergent_time_wasm`, upstream's prebuilt
55 KB package). Upstream's own README calls the clock "a diagnostic signal,
not a proven early-warning predictor", with no early-warning lead over a
windowed z-score or a Page–Hinkley detector on real agent traces.

## Mapping

One clock tick per generation. The clock was built for LLM agents, so only
four of its channels have a meaning here; the others stay 0.

| Clock channel | Training signal |
|---|---|
| belief | RMS change of the champion's weights (0 when the champion is unchanged) |
| plan | relative change of the mutation rate (adaptive exploration stages) |
| contradiction | drop of this generation's best below the previous generation's, in checkpoints |
| progress | gain of the champion's progress, in checkpoints |

Over an 8-generation window the clock reports **Healthy** (the champion
gained), **Drifting** (a small gain for a lot of change), **Stuck** (no gain and
no change), or **NeedsReplan** (the champion or the mutation rate changed
without a gain). The panel shows them as Improving, Slow progress, Plateau, and
Plateau while exploring. The pill appears from the second generation, and
while Improving it says how long ago the last gain was.

The clock's Contradicting, Collapsing, and NeedsHumanReview states cannot occur
here: the champion's progress never falls, and the contradiction level is not
fed. The contradiction channel itself also stays 0 in practice, because the
champion is carried into every generation and the physics is deterministic.
With adaptive exploration off (the default), the pill is therefore close to a
plain rule: a gain within the last 8 generations reads Improving, otherwise
Plateau.

## Units and thresholds

Progress must be measured in checkpoints, not laps. An earlier version divided
it by the track's gate count, so a steady gain read "Slow progress" on tracks
with many gates (always at 30 gates, in a reviewer's test) and upstream's
thresholds (Agentic Time Index ≥ 0.5 healthy, ≥ 0.1 drifting) misread most
improving windows. In checkpoints, upstream's thresholds read 3 of 104
improving tuning windows as Drifting and none of the held-out ones. The
thresholds here are 0.05 and 0.01, which removes those 3.

`npm run benchmark:health` reproduces this. Ground truth per generation:
"improving" when the champion gained within the last 8 generations, else
"plateau". Agreement means Healthy on improving windows, and Stuck or
NeedsReplan on plateau windows. [Raw report](training-health.json).

| Trace set | Traces | Windows | Thresholds 0.05 / 0.01 | Upstream 0.5 / 0.1 |
|---|---:|---:|---:|---:|
| Tuning: Rectangle and Triangle, 6 seeds each, 48 cars, 8 s | 12 | 384 | 100.0% | 99.2% (3 of 104 improving windows read Drifting) |
| Held out: Monza, Rectangle, Triangle, 3 new seeds each, 128 cars, 12 s | 9 | 288 | 100.0% | 100.0% |

Plateau windows split into Stuck (130 tuning, 114 held out) and NeedsReplan
(150 and 118). Each trace is 40 generations with adaptive exploration on.

The agreement is high by construction: the ground truth is the same "gain
within 8 generations" rule, and a plain counter would also score 100%. The
benchmark shows that the mapping does not misread real runs; it does not show
that the clock predicts anything. What the clock adds is the split of plateaus
into "no change" and "exploring without a gain", and a shared vocabulary for
the Auto Train mode. Auto Train bounces out of Polish on this snapshot's gain
counter; see [Auto Train](auto-train.md).

## Tests

`tests/health.test.mjs` runs the vendored WASM: nothing is reported before
the second generation; steady gains read Improving at 4, 9, and 30 gates
(dividing by the gate count fails this); a flat run reads Plateau; a change in
each input on its own (champion weights, mutation rate, generation best) reads
Plateau while exploring; a tiny gain against heavy churn is not Improving
(thresholds near 0 fail this); the gain counter resets; unusable rows are
ignored; and a real-physics run matches its improving and plateau windows
generation by generation. `tests/learning-browser.mjs` checks that the pill
appears and counts every generation during real training.
