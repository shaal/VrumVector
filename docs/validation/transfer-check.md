# Transfer check

**Check transfer** in the driver-learning panel answers one question for the
current track, style, and conditions (physics and generation length): does
starting a run from memories recorded under *other* tracks, styles, or
conditions give a better champion, or the same champion sooner, than starting
it fresh?

## How it works

1. `ruvectorBridge.transferCandidates()` returns up to six archived networks
   from other contexts, ranked by the base terms of live retrieval (raw track
   similarity × fitness, the same diversity preference, and the frozen
   consistency filter). It leaves out the terms that depend on learning state:
   the LoRA-adapted query, reranker feedback, and the dynamics term. It is
   read-only: it does not adapt the query through LoRA, record a reranker
   selection, fill the consistency cache, or record timings.
2. Two trial workers (`AI-Car-Racer/learning/trial-worker.js`) run one paired
   trial at a time, off the render path, with full 60 Hz sensor updates. Arm A
   starts from those memories; arm B starts from fresh drivers. Both arms
   restart from generation 0, share seeded random streams, and run six
   generations of 24 cars with the live mutation and initialization settings
   and fixed exploration (`AI-Car-Racer/learning/trial.js`).
3. The arm with the better final champion progress wins the trial. Equal
   champions are decided by summed champion progress over the six generations
   (the same champion sooner). Anything else is a tie. The population's mean
   progress is never used: it measures how a population is made up (memory
   offspring vs fresh drivers), not how good its champion is. An earlier
   version used it as a last tie-break; in some checks it decided up to 60% of
   the decided trials, so it was removed.
4. A paired sequential test by betting (`AI-Car-Racer/learning/sequential.js`,
   ported from ruvector-typesafe-core `loop_gate`) watches each direction and
   skips ties. A run stops as soon as either direction reaches 20× evidence
   (alpha 0.05 each way), or after 60 trials. The test state is saved after
   every trial, per context. **Continue check** adds trials to the same test;
   a stopped run or a closed tab keeps its evidence. A test is identified by
   its memory set and trial settings (mutation, initialization, generations,
   population, generation length). Changing either starts a new test, and the
   panel says so; an earlier verdict stays in force until the new test decides.
   Training often re-archives transferred champions under this context, which
   removes them from the memory set, so a later check can start a new test.
   A new test that stops before its first trial does not replace an unfinished
   one.
5. If fresh starts win, transfer is **paused** for this context. New
   generations keep only memories recorded under the same context, and a saved
   driver from another context is held back too. A driver the user loads with
   **Load** or **Restore Old Brain** is always used; an imported brain file
   follows the saved-driver rule. The panel shows the evidence and a **Resume
   transfer** button. If memories win, transfer is **confirmed** and nothing
   changes. Otherwise transfer stays on.

## What the verdict means

- **The compared thing is the starting procedure.** Memories take the elite
  slot and most mutation slots, as they do in live training. A pause means
  "seeding from these memories gave a worse champion, or the same champion
  later, than a fresh start here", not "these memories contain nothing useful".
- **False verdicts.** If the two procedures are equally good, each decided
  trial is a fair coin, and the chance that one test ever pauses is at most 5%
  (Ville's inequality), however often it is stopped and continued. The trials
  are independent because each one restarts both arms and never writes to the
  archive or the champion.
- **Re-testing adds risk.** Each new test (new memories, changed settings, or a
  re-check after **Resume transfer** with different settings) has its own 5%
  chance. A reviewer's simulation put one test's false-pause rate at about 2%
  within a single 60-trial run and about 5% if continued to the end; five
  separate re-tests raised the chance of at least one false pause to roughly
  8–22%.
- **Scope.** The check tests the six memories offered at check time, with 24
  cars and a cold start. A pause then holds back every memory from other
  contexts for this context, with 500 cars by default and a warm champion. How
  well the 24-car verdict carries over to 500 cars is not measured.
- **Duration.** A pause lasts until **Resume transfer**, **Start Fresh**, or a
  new test on this context that decides otherwise. The panel keeps entries for
  the 40 most recently checked contexts; older ones are dropped. Re-checking the
  same memories with the same settings replays the same trials and gives the
  same answer. All contexts share one stored record, so two tabs running checks
  at the same time can overwrite each other's entries.

## Why paired trials, not live A/B generations

The betting test is valid only when each pair is a fresh comparison.
Successive generations of one live run are not: once one arm's champion is
ahead, elitism keeps it ahead, so a lucky early lead would produce a long run of
"wins" and a false verdict. The survey plan
(`docs/plan/ruvector-upstream-adoption.md`, T5) proposed live A/B generations and
a verdict in the A/B panel. This design replaces the live generations for that
reason. The verdict and its controls appear in the driver-learning panel, next
to the memories it affects; the A/B panel shows a one-line summary.

## Measured

`npm run benchmark:transfer` runs the same trial loop and the same stopping
rule in Node on real physics (8-second generations). Memories are the champions
of six seeded 15-generation runs on the source track. As a control, "random"
memories are six uniform random networks, which carry no skill. Inconclusive
checks are continued (as **Continue check** does) up to 300 trials.
[Raw report](transfer-benchmark.json).

| Memories from | Checked on | Verdict | Trials | Memory / fresh / ties | Evidence | Mean best, memory / fresh |
|---|---|---|---:|---|---:|---|
| Triangle | Rectangle | confirmed | 25 | 19 / 4 / 2 | 22.0× | 3.12 / 2.52 |
| Rectangle | Triangle | inconclusive | 300 | 95 / 93 / 112 | 1.9× | 3.27 / 3.35 |
| random | Triangle | paused | 89 | 21 / 41 / 27 | 22.4× | 3.21 / 3.52 |
| random | Rectangle | inconclusive | 300 | 93 / 98 / 109 | 2.3× | 2.41 / 2.34 |

- Triangle experience gives Rectangle a better start, decided in 25 trials.
  This matches the direction of the earlier finding
  (`docs/plan/arch-cross-shape-transfer.md`, a different metric and setup), for
  this memory set.
- Rectangle experience on Triangle shows no detectable effect either way in 300 trials,
  so transfer stays on. The earlier finding that it slightly hurt is not
  reproduced by this measure.
- Seeding Triangle with useless networks costs enough that fresh starts win,
  and the check pauses it. On Rectangle the same useless seeding shows no
  detectable effect in 300 trials.
- Trials took about 1.7–2.1 s each in Node with the two arms run one after the
  other; the browser runs the arms in parallel. A 300-trial check therefore
  takes several minutes, spread over five **Continue check** runs. Longer
  generations take proportionally longer.

## Tests

- `tests/transfer.test.mjs`: betting arithmetic, latching, and JSON round trip;
  false rejections at most 5% over 2000 seeded no-effect runs of 200 trials; a
  deterministic real-physics trial arm; the outcome order (population mean never
  decides); pause, confirm, inconclusive, continue, changed memories or
  settings (the old verdict stays), per-trial saving, stop, Start Fresh during
  a run, no-memory, worker-error, and damaged-entry paths; the guard holds back
  only transferred memories, only for the paused context.
- `tests/learning-browser.mjs`: the real workers run three trials; the check
  leaves archive, feedback, and reranker state unchanged; a paused guard holds
  back the transferred seed and a saved driver from another context, keeps one
  from this context, and keeps a driver the user loads; **Resume transfer**
  clears the pause and moves focus; **Start Fresh** clears all pauses.
