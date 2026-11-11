# R1: time tie-break in live fitness (#60), measured and shipped OFF

**Date:** 2026-11-11
**Issue:** shaal/VrumVector#60 (Reflex lessons 1)
**Outcome:** the code ships behind `DriverProfiles.settings.timeTieBreak`, which is OFF by default. The measurement does not clear the kill criterion, so nothing turns it on.

## What the flag does

- `car.js` records `lastGateFrame`: the frame of the last gate a car gained, laps included.
- `DriverProfiles.rank` adds `1e-3/(1+lastGateFrame)` when the flag is on. The term is at most 5e-4, so it never outweighs a gate.
- Workers send `lastGateFrame` with a generation result only when the flag is on.
- `LearningCoach.record` then takes a tied champion (same progress, no worse style) whose last gate came strictly sooner than the stored one. A tie win does not reset stagnation.
- Turn it on: `begin` messages to `sim-worker.js` take `timeTieBreak:true`, and so do `trial` messages to `learning/trial-worker.js`. `main.js` sends neither yet.
- With the flag OFF, results, messages and champions are the same as before. The bit-identity tests pass.

## Cheap check: how often the top gate count ties

Share of generations where two or more cars share the top gate count. These are the off arms below: 30 generations, 48 cars, 30 s each.

- Rectangle: 62% mean (runs 33% to 100%).
- Triangle: 68% mean (runs 17% to 93%).
- Earlier probe (20 s, 24 or 100 cars): ties are common on plateaus. Ties are rare in generations where the champion laps at N=24 (2 of 9 and 0 of 9). They are common at N=100 (9 of 13). The live population is N=500, which is not measured.

## Paired runs

`node scripts/benchmark-time-tiebreak.mjs --track=<T> --runs=0-7 --generations=30 --population=48 --seconds=30`

- Each run is a paired `runTrialArm`: the two arms share the population and physics streams, so they differ only by the tie-break.
- Cold start, balanced profile, no collisions.
- Each arm's champion then drives one deterministic solo run of 30 s on the same track and start. "lap" is its best lap, and "crash" means it crashed.
- "surv" is the share of the last generation still undamaged.

### Rectangle (n=8)

| run | off best | on best | off lap s | on lap s | off crash | on crash | off surv | on surv |
|---|---|---|---|---|---|---|---|---|
| 0 | 12 | 6 | 13.07 | 28.78 | 0 | 0 | 0.48 | 0.69 |
| 1 | 12 | 13 | 12.73 | 11.77 | 0 | 0 | 0.65 | 0.65 |
| 2 | 8 | 8 | 23.07 | 21.48 | 0 | 1 | 0.81 | 0.56 |
| 3 | 9 | 17 | 17.4 | 9.12 | 0 | 0 | 0.48 | 0.46 |
| 4 | 3 | 6 | -- | 20.92 | 0 | 1 | 0.71 | 0.67 |
| 5 | 14 | 10 | 10.83 | 11.8 | 0 | 1 | 0.58 | 0.40 |
| 6 | 12 | 12 | 12.25 | 13.9 | 0 | 0 | 0.63 | 0.48 |
| 7 | 2 | 13 | -- | 12.84 | 0 | 0 | 0.56 | 0.40 |

- Best progress: on ahead in 4 runs, off ahead in 2, equal in 2.
- Lap time, on/off, for the 6 runs where both champions lapped: 0.524, 0.925, 0.931, 1.090, 1.135, 2.202. The median is about 1.01, so there is no lap gain.
- Champion crashes: off 0/8, on 3/8. Mean final survival: off 0.612, on 0.536.

### Triangle (n=8)

| run | off best | on best | off crash | on crash | off surv | on surv |
|---|---|---|---|---|---|---|
| 0 | 6 | 4 | 0 | 1 | 0.63 | 0.42 |
| 1 | 7 | 7 | 1 | 1 | 0.44 | 0.44 |
| 2 | 4 | 4 | 1 | 0 | 0.42 | 0.60 |
| 3 | 5 | 4 | 0 | 1 | 0.56 | 0.65 |
| 4 | 10 | 4 | 1 | 0 | 0.17 | 0.81 |
| 5 | 4 | 5 | 1 | 1 | 0.58 | 0.31 |
| 6 | 5 | 5 | 1 | 1 | 0.40 | 0.44 |
| 7 | 4 | 4 | 1 | 0 | 0.25 | 0.42 |

- Only one champion lapped (off, run 4, 29.45 s). Triangle laps are an open problem (`../../triangle-apex-investigation-2026-04-23.md`), so lap time on Triangle cannot be measured.
- Best progress: off ahead in 3 runs, on ahead in 1, equal in 4.
- Champion crashes: off 6/8, on 5/8. Mean final survival: off 0.430, on 0.510.

## Verdict

- Kill criterion: drop the change if laps are less than 2% faster, or if the crash rate rises on Tri.
- Rectangle: no lap gain (median ratio about 1.01), and the champion crash rate rose from 0/8 to 3/8.
- Triangle: lap time is not measurable. The crash rate did not rise (6/8 to 5/8), and progress was slightly worse.
- The criterion is not cleared, so the flag stays OFF.
- Evidence strength: **weak**. This is n=8 per track in **one** session, and the measurement rule asks for at least 2 sessions. The arms diverge after the first broken tie, so the per-run spread is large (lap ratio 0.52 to 2.20). This data does not show a harm either. It shows no measurable gain.
- Not measured: N=500 (the live size, where ties are likely more common), the Polish phase of a long live run, other profiles, and collision mode.
- Same family: the reverted F1′ tie-break (`../f1-prime/PROOF.md`) used a forward-speed accumulator. This one uses gate time, and the Rectangle crash rise points the same way.
