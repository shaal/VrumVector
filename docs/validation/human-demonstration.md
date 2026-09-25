# Human demonstration

A person drives the WASD car, and the app records what the car's network saw
and which keys the person held. Later tasks train a copy of the network on
these recordings and test whether it helps. Plan:
[human-demonstration.md](../plan/human-demonstration.md). This page records
what each task shipped and what was measured.

## H1 — Recording

**Record my driving** is a button in the driver profile panel, under
"Teach by driving". Nothing is recorded until the person presses it. Code:
`AI-Car-Racer/learning/demonstration.js` (the recorder and the store) and
`AI-Car-Racer/learning/session.js` (the panel).

### What one sample is

- One sample per physics step of the WASD car, taken right after
  `car.update()` in the `playerSteps` loop of `main.js`.
- **Inputs:** the 10 numbers the network received in that step:
  7 rays (`1 - offset`), `speed / maxSpeed`, and the car-local direction to
  the next checkpoint (forward, right). `car.update()` writes them to
  `Car.lastInputs` when perception runs, so the recorder reads exactly what
  the network saw. There is no second sensor pass.
- **Keys:** the four keys that moved the car in that step, as bits
  (forward 1, left 2, right 4, reverse 8).
- **Step number:** counts physics steps since recording started. The log is
  not paired. A trainer pairs the inputs of step `t` with the keys of step
  `t + k`. `lagPairs(demonstration, k)` returns only the pairs whose samples
  are exactly `k` step numbers apart with no sample missing between them.
- **Breaks.** Skipped steps (see below), a new car, and a car that moves
  further in one step than its top speed allows (a crash reset, a car moved
  to the start) all leave a gap. A pause, a hidden tab, and a freeze (more
  than 250 ms between two steps) each skip one step number. In all three
  the screen stood still while the person could still change keys. So no
  lag pair spans a break. A shorter stutter is replayed as a burst of steps
  with the same keys, and those samples are kept.
- **Rest steps (added in H2).** Every race starts from rest. So the recorder
  also keeps the last 0.5 s (30 steps) of the car parked at its start pose
  before it moves: at the start, and after each crash reset. It holds these
  steps until the car moves. Then it stores them just before the first
  moving sample and marks them in `rest`. Their keys are the keys actually
  held (usually none); H2's dataset gives them the keys that moved the car.
  A step that is not at rest (AI driving, another speed, invincibility, no
  keyboard focus) starts the 0.5 s again. So does a new track or new
  physics before the first sample. A pause or a freeze does not, because
  the parked car senses the same thing on every step. Rest samples are
  numbered as the steps right before the move. If the car never moves, they
  are not stored.

### When a step is recorded

All of these must hold. Otherwise the step is skipped, and the panel says why.

| Condition | If not |
|---|---|
| Multiplayer is off | Record cannot start. Turning Multiplayer on stops and saves the recording. |
| Adaptive green gates are off | Record cannot start, and turning them on ends a recording. They can move the gates between generations, and each move is a new context. |
| The simulation runs at 1× | Recording sets 1× and locks the speed menu. Stop unlocks it and applies the last speed asked for while recording (for example, by a preset), or else the speed from before. |
| WASD keys reach the car | "Paused: WASD keys are not reaching your car." This covers another window having focus (the page then releases every key) and typing into one of the page's own controls. Otherwise the car would coast without a choice by the person. |
| AI driving is off | "Paused while AI driving is on." |
| Invincibility is off | "Paused while invincibility is on." A car that drives through walls is not a useful example. |
| The car is not damaged | "Paused: your car crashed." The crash is counted. |
| The car has moved since it was put at the start | "Waiting for your car to move." The idle start and the wait after each crash reset are not driving. Only their last 0.5 s is kept, as rest steps (above). |
| The car is the same car as in the last step | The first step of a new car is never recorded. |

A generation that ends during a recording does not reset your car. This uses
the same rule as a live multiplayer lap. Auto Train leaves the 1× in place
while recording.

### When a recording ends

- **Stop** (the same button).
- **Five minutes of samples** (18 000, rest steps included).
- **The context changes:** the walls or checkpoints, the top speed, the
  traction, or the driving style. One recording has one context, and later
  trials run under its driving style. What was recorded so far is saved with
  the old context. A change before the first sample loses nothing: the
  recording takes the new context.
- **Multiplayer or Adaptive green gates turn on.** The panel shows the
  result, then why Record is unavailable.
- **The panel is hidden:** the A/B view, or another phase. Stop would be out
  of reach.
- **The page closes or reloads.** The recording is saved while the page
  closes. This save skips the cap. The next time the panel opens (or the
  page returns from the back-forward cache), the oldest recordings over the
  cap are removed, and the panel says so.
- **An error** inside the recorder ends the recording, not the game loop.

A recording with less than 1 second of driving is not saved. Rest steps do
not count toward that second.

### What is stored

IndexedDB database `vv-demonstrations`, in this browser only. It opens the
first time the driver profile panel opens. Nothing is sent anywhere;
multiplayer does not transmit it. The store keeps the newest 10 recordings.
With 10 saved, the panel says that a new recording replaces the oldest. The
transaction that saves a recording also removes the oldest over the cap. A
connection that the browser closed (for example, after clearing site data)
is reopened once.

| Field | Content |
|---|---|
| `inputs` | `Float32Array`, 10 per sample (`inputOrder` names them) |
| `keys` | `Uint8Array`, 1 per sample (`keyOrder` names the bits) |
| `sampleSteps` | `Uint32Array`, the step number of each sample |
| `rest` | `Uint8Array`, 1 per sample: 1 for a rest step (the car parked before it moved) |
| `samples`, `seconds`, `elapsedSteps`, `restSamples` | counts: `samples` includes the rest steps; `seconds` is the driving time, without them (the panel shows the same) |
| `laps`, `checkpoints`, `crashes`, `crashSteps` | the person's progress while recorded |
| `context` | the learning context: walls key (`track`), `maxSpeed`, `traction`, driving style, round length (as it started) |
| `track` | canvas size, walls, checkpoints, and `startInfo`, in the trial worker's format |
| `createdAt`, `endedAt`, `stopReason`, `version`, `car` | bookkeeping (`version` 2 since H2 added `rest`; version 1 records have no rest steps) |

A full 5-minute recording is 828 000 bytes of samples
(18 000 × (40 + 1 + 4 + 1)), plus the track.

**Laps and checkpoints** count the steps the person drove: recorded steps,
and the step that crashed (one step can finish a lap and hit a wall).
Leaving the start is not a checkpoint, because the parked car already
touches the start gate; closing a lap through it is. Without a crash, a
drive earns one checkpoint less than the AI fitness count
(`checkPointsCount + laps × gates`).

### Known limits

- Rest steps are kept only for a car parked exactly at its start pose
  (same position, speed 0). A car that stopped anywhere else is recorded as
  normal driving, with the keys held.
- The rules above use the car's start pose. `window.__switchTrackInMemory`
  (a benchmark hook) moves the car without a new start pose; the jump rule
  still breaks the log, but a parked car there counts as moved.
- Invincibility can only be turned on in phase 3, which ends a recording.
  From the console, a car that drove through walls while invincible is
  recorded again once invincibility is off.

### Tests

- `node --test tests/demonstration.test.mjs` (part of `npm run test:learning`):
  scripted WASD keys drive the real car physics and sensors in the Node
  simulator (`tests/helpers/simulation.mjs`).
  - `Car.lastInputs` equals the network's input on each of 90 steps of the
    WASD car, and for AI cars after a 1-second trial run.
  - 400 scripted steps give 400 samples. Each sample holds the inputs of its
    step and the keys that moved the car, all four keys occur, and the step
    numbers are consecutive. The 30 idle steps before are not recorded.
  - A key-only wall follower drives 60 seconds on Rectangle without a crash.
    The recorder's laps equal the car's, and its checkpoints equal
    `laps × gates + checkPointsCount − 1`.
  - AI driving (the panel toggle, and the car's own co-driver flag), another
    speed, invincibility, a crash, and a pause each break the log. With a
    test clock, a 400 ms freeze and a loss of focus break it at exactly
    those samples, while a 240 ms stutter and several steps in one frame do
    not. After the
    crash reset, the parked car is not recorded until it moves. The script
    knows the seven unbroken runs, and `lagPairs` returns exactly the pairs
    inside them, for k = 1 and k = 12.
  - A new car, a car moved to the start with W held, a changed track, a
    changed style, new physics, multiplayer, Adaptive gates, a hidden panel,
    an error inside a step, the size cap, and a recording under 1 second
    behave as described above.
  - Rest steps: after a long wait, exactly the last 30 steps are stored,
    with the inputs the parked car sensed and the keys held (a held A does
    not move a parked car). They end right before the step that moved the
    car. A pause keeps them and renumbers them. AI driving, another speed,
    or a new track before the first sample starts the wait again (the same
    track in a new array does not). A car moved by AI driving stores none.
    W from the first step, or stopping while parked, stores none. They do
    not count toward the 1-second minimum, and the size cap drops the oldest
    first.
  - With W held through a crash reset, leaving the start is not counted. A
    lap that ends on the crash step is counted.
  - The saved count follows a save that finishes after the next recording
    starts.
  - Removing any one of these rules (the jump break, the pause break, the
    freeze break, the focus pause, the start-gate rule, the crash-step count,
    the style check, the Adaptive-gates block and stop, the hidden-panel
    stop, the saved count) makes a test fail. `tests/auto-train.test.mjs` checks
    that Auto Train leaves the recording's 1× alone.
- `npm run test:demonstration:browser` (`tests/demonstration-browser.mjs`,
  port 8889): the real app in headless Chromium, with real WASD key presses.
  - Multiplayer on makes Record unavailable; a click does nothing. A
    recording that starts at 1× unlocks the speed menu when it stops. Record
    sets 1×, locks the menu, and waits for the car to move.
  - Pressing W and then W + A records samples with those keys (3 = forward +
    left, nothing else).
  - A generation ends during the recording and the car is not replaced.
  - AI driving pauses recording while W is held, and so do a lost keyboard
    focus, focus on a checkbox in the panel, and a real crash. In all three, physics keeps stepping but no
    sample is added. The reset car is not recorded until W is pressed again.
    Then its last 0.5 s parked (20–30 steps) is stored before the move: no
    keys, speed 0, numbered as the steps right before it.
  - The latest sample equals `playerCar2.lastInputs` and the network's input.
    Pause and Play break the step sequence.
  - Stop saves one IndexedDB record with typed arrays, the training walls
    key, the physics, and the gate list. It applies the speed asked for while
    recording (20×). The record, as IndexedDB returns it, converts to the
    cloning dataset in the page (H2): one row per sample, rest rows labelled
    W, and twice the rows with mirroring.
  - Multiplayer on, `setMaxSpeed(10)`, and the A/B view each stop and save a
    recording (the second with the old top speed). Focus stays on the button
    when it becomes unavailable, and the status gives the result, then the
    reason. A recording under 1 second is not saved.
  - The store keeps the newest 10. Saving, counting, listing, and pruning
    each work after the connection was closed. A reload saves the current
    recording, and opening the panel then restores the cap and says so.
    Adaptive green gates make Record unavailable.
  - At 390 × 844 (read back from the page) the panel fits, with no
    horizontal page scroll.
- `scripts/a11y-contrast.mjs` has a `driver-recording` scenario: the panel
  while recording, in light and dark themes.

## H2 — Dataset

`AI-Car-Racer/learning/dataset.js` turns stored demonstrations into the rows
that the cloning trainer (`learning/clone.js`, H3) learns from. Nothing in
the game calls it yet; H4 adds "Use my driving".

### What it does

- `demonstrationDataset(demonstrations, options)` takes one stored
  demonstration or a list of them: as IndexedDB returns them, or a JSON copy
  with plain arrays. It returns `{inputs, keys, episode, report}` in the
  format of the plan's H3 note, plus `sameSplitAs` when mirroring. There is
  one row per sample. Keys are unpacked from the bitmask (1 forward, 2 left,
  4 right, 8 reverse). A new episode starts at every gap in `sampleSteps`,
  at every demonstration, and at every mirrored run.
- **Rest steps.** `rest: 'label'` (the default) gives each rest step the
  keys of the step that moved the car. That is usually W, but it is
  whatever the driver pressed (two teachers first moved with A + S and with
  A + D + S).
  `'drop'` removes rest steps. `'keep'` keeps the keys actually held; it is
  only there for comparisons.
- **Crash trim.** `crashTrim: N` drops the last N steps before each crash.
  The default is 0 (see the measurements).
- **Mirror.** `mirror: true` adds the mirror image of every run: the rays
  in reverse order, the same speed, the same forward distance to the next
  checkpoint (`lf`), its sideways distance (`lr`) negated, and left and
  right swapped. Each mirrored run is its own episode, and `sameSplitAs` links
  each of its rows to the row it copies. So a block and its mirror land on
  the same side of the trainer's time-block split. The default is off (see
  the measurements).
- It checks every demonstration first. Bad data is refused with
  `invalid-data` (a `CloneError`, as in the trainer), naming the
  demonstration and the sample. One bad record refuses the whole call, so
  H4 may want to convert records one at a time. Bad or unknown options are
  refused with `invalid-options`. Version 1 records (before H2) have no rest
  steps and convert as they are. The caller picks the records: normally
  those of one context (H4).
- `report` has the counts (samples, rows, runs, rest rows kept and dropped,
  crashes, rows dropped before crashes, mirrored rows) and the key balance.
- `mirrorInputs`, `mirrorKeyBits`, and `mirrorBrain` (the mirror image of a
  network) are exported too. H5's optional mirrored seed can use the last
  one.

### The mirror, proved with the real sensors

`mirroredSimulation()` (`tests/helpers/demonstrator.mjs`) reflects a
preset's walls and gates from left to right (x becomes 3200 − x) and moves
the spawn with them. A car at (x, y) with angle a then has its mirror image
at (3200 − x, y) with angle −a.

- **Sensors: exact.** We checked 6,712 poses on Rectangle and 3,374 on
  Triangle. They lie along real drives and at random places, headings,
  speeds, and next checkpoints. At every pose, the mirror-image car on the
  mirrored track read exactly the mirrored inputs. The largest difference
  was 0, so they match bit for bit.
- **Mirrored network: exact.** On 6,000 random pairs of network and input,
  `mirrorBrain` pressed exactly the mirrored keys.
- **Physics: not quite symmetric.** A mirrored car driven with left and
  right swapped follows the mirror image exactly, until one step where only
  one of the two cars ends a slide. `Car.#move` ends a slide when
  `|velocity.x| − speed·sin(angle)` is small. The mirror image flips the
  sign of `sin(angle)` but not of `|velocity.x|`. The same check also
  compares `|velocity.y|` with `speed·sin(angle)` (not `cos`), which is
  not symmetric either. A scripted slider stayed
  exact for 3,600 steps on Rectangle, 3,539 of them sliding. The Rectangle
  teacher split at step 133, and the two paths then drifted 530 px apart. So
  a mirrored sample is exactly what the sensors would see, but the mirrored
  track drives slightly differently. Fixing that check would change the
  physics for every driver, so H2 leaves it alone.

### Measurements

`scripts/benchmark-dataset.mjs`. Teachers are short genetic runs, as in
H3: 24 generations of 24 cars, 15 seconds each. The seeds are `h2-s1-*` in
session 1 and `h2-s2-*` in session 2, with 6 teachers per track and session,
so 12 per track. A teacher is used if at least two of its keys change (each
held on 2–98% of its steps). This rule refused 5 seeds on Rectangle and 3
on Triangle.

Each teacher drives the WASD car through H1's recorder
(`tests/helpers/demonstrator.mjs`). The first run starts at the spawn and
the others at jittered starts. Each run waits 40 steps at rest (so 30 rest
steps are kept). Then the teacher drives for up to 15 seconds or until it
crashes. A recording stops after 40 runs or 18,000 rows, which gives about
30 runs and 16,000 rows. About 2 in 3 runs end in a crash. Noisy recordings add mistakes about once
every 3 seconds, each lasting 10–30 steps (about 10% of all steps). In a
"swap" mistake the steering goes the wrong way. In a "late" mistake the keys
stay held too long.

Each way of building the dataset is one "arm". Every clone trains twice.
Once with the trainer's defaults: it chooses the key lag, as it will for a
person in H4. Once with the lag fixed at 1, the teachers' true lag. The
second measures the effect of the data alone, because a wrong lag choice
can hide it. The scores are:

- **Fresh agreement:** all four keys right on about 6,000 steps of new,
  clean runs by the teacher. These steps are never used in training, and
  every arm uses the same ones.
- **Pulls away:** of 13 starts from rest (the spawn and 12 jittered starts),
  how many the clone leaves (it moves more than 20 px within 3 seconds).
- **Checkpoints:** the total over 13 thirty-second rounds from rest.
- **Mirrored track:** the same 13 starts, mirrored, on the mirrored track.

The teachers hold forward on 69% (Rectangle) and 63% (Triangle) of their
moving steps, left on 54% and 41%, right on 40% and 47%, and reverse on 41%
and 43%. The paired columns compare the same teacher from the same starts. They
count the teachers for whom an arm was better, the same, or worse. The full
data, with one line per teacher and arm, is in
[cloning-dataset.json](cloning-dataset.json). To reproduce it, run
`node scripts/benchmark-dataset.mjs run <session> <track>` for sessions 1
and 2 on both tracks (about 12 minutes each), then
`node scripts/benchmark-dataset.mjs summary`.

**Rest steps** (clean recordings, no mirror, no trim, the trainer chooses
the lag; with the lag fixed at 1 the picture is the same):

| | Rectangle: keep | drop | **label** | Triangle: keep | drop | **label** |
|---|---:|---:|---:|---:|---:|---:|
| Clones that pull away from all 13 starts (of 12) | 0 | 10 | 11 | 0 | 12 | 12 |
| Starts pulled away (of 156) | 1 | 151 | 154 | 2 | 156 | 156 |
| Checkpoints, mean | 12.6 | 53.7 | 55.2 | 10.1 | 44.0 | 45.9 |
| Checkpoints vs label: better / same / worse | 0 / 0 / 12 | 2 / 4 / 6 | | 0 / 0 / 12 | 1 / 4 / 7 | |
| Fresh agreement, mean | 97.7% | 98.0% | 97.7% | 96.0% | 95.1% | 96.9% |

The teachers themselves reach 53.7 checkpoints on Rectangle and 43.8 on
Triangle. A network that only holds forward reaches 26 and 39. The teachers
leave 150 of 156 starts on Rectangle and 155 of 156 on Triangle.

With the keys actually held, the clones almost never leave the start (3 of
312 starts, and no clone leaves all 13). They learn "at rest, press
nothing", as H3 found. With the rest steps
dropped, the clones copy their teachers' starts (151 and 156). With labels
they do a little better: 154 and 156, more than the teachers themselves,
because every labelled run shows the car pulling away. One Rectangle clone
(`h2-s2-6`) still stays put on 2 of its 13 starts, where its teacher stays
on 3. Labelled clones also reach slightly more checkpoints: over both
tracks, dropping was better for 3 teachers and worse for 13. On average,
the rest rows change agreement on moving steps by less than 2 points. For
single teachers, dropping them lowered it by up to 10 points and raised it
by up to 5.
**Decision:** rest steps are labelled, as the plan says.

**Mirroring** (clean recordings, labelled rest steps):

| | Rectangle: off | on | Triangle: off | on |
|---|---:|---:|---:|---:|
| Fresh agreement, the trainer chooses the lag | 97.7% | 86.8% | 96.9% | 88.9% |
| … vs off: better / same / worse | | 0 / 0 / 12 | | 0 / 0 / 12 |
| Fresh agreement, lag fixed at 1 | 98.1% | 92.1% | 96.1% | 92.8% |
| … vs off: better / same / worse | | 0 / 0 / 12 | | 1 / 0 / 11 |
| Clones for which the trainer chose a lag other than 1 | 0 | 3 | 1 | 3 |
| Checkpoints on the recorded track, lag fixed at 1 | 54.7 | 32.8 | 45.9 | 44.4 |
| … vs off: better / same / worse | | 0 / 3 / 9 | | 3 / 4 / 5 |
| Checkpoints on the mirrored track, lag fixed at 1 | 28.6 | 32.3 | 35.7 | 42.8 |
| … vs off: better / same / worse | | 7 / 2 / 3 | | 10 / 1 / 1 |

On the mirrored track, a teacher itself reaches 29.3 (Rectangle) and 36.9
(Triangle). Its mirror image (`mirrorBrain`) reaches 53.4 and 43.6.

Mirroring costs agreement on the recorded track. With the lag fixed at 1,
it was lower for 23 of 24 teachers, in both sessions (Rectangle −6.5 and
−5.5 points; Triangle −5.5 and −1.0). It also misleads the lag choice. The
trainer chose a wrong lag (2 to 14) for 6 of the 24 mirrored datasets, and
for 1 of the 24 others. With the trainer's own lag choice, the mean cost
grows to 8–11 points.

The evolved teachers are not symmetric. Where a state and its mirror look
alike, the mirrored rows ask for other keys than the teacher pressed, and
the 16-neuron network must fit both. The mirror helps on the mirrored track
(17 of 24 teachers) and costs on the recorded one. On Rectangle one clone
fell from 194 to 39 checkpoints (to 28 with the trainer's lag choice).
**Decision:** mirroring is off by default. A clone seeds only the context
it was recorded on (plan, Design 4), so the recorded track is what counts.
The option stays for tracks that turn both ways and for H6.

**Dropping steps before a crash** (labelled rest steps, no mirror, lag fixed
at 1):

| Recording | Dropped before each crash | Rectangle: fresh agreement (vs 0: better / same / worse) | Rectangle: checkpoints (vs 0) | Triangle: fresh agreement (vs 0) | Triangle: checkpoints (vs 0) |
|---|---:|---|---|---|---|
| clean | 0 | 98.1% | 54.7 | 96.1% | 45.9 |
| clean | 30 steps | 97.1% (4 / 1 / 7) | 53.8 (2 / 5 / 5) | 95.0% (4 / 2 / 6) | 45.3 (2 / 7 / 3) |
| swap mistakes | 0 | 89.3% | 48.1 | 90.9% | 41.0 |
| swap mistakes | 30 steps | 88.9% (4 / 0 / 8) | 44.3 (4 / 1 / 7) | 88.8% (3 / 1 / 8) | 40.1 (3 / 4 / 5) |
| swap mistakes | 60 steps | 89.0% (6 / 0 / 6) | 50.2 (6 / 1 / 5) | 88.7% (5 / 1 / 6) | 40.8 (3 / 6 / 3) |
| late mistakes | 0 | 91.4% | 44.5 | 92.0% | 42.6 |
| late mistakes | 30 steps | 92.0% (7 / 0 / 5) | 43.4 (4 / 4 / 4) | 90.6% (3 / 1 / 8) | 44.5 (5 / 6 / 1) |
| late mistakes | 60 steps | 90.9% (5 / 0 / 7) | 43.7 (4 / 4 / 4) | 91.7% (3 / 2 / 7) | 43.5 (5 / 4 / 3) |

No trim helps reliably. The mean differences are small and split both
ways. On clean recordings, trimming costs a little. Single teachers swing by
up to 23 points, and by up to 20 even without a change of lag, so one
training run per arm is noisy. The means and the better / same / worse counts are
what to read. With the trainer choosing the lag, the picture is the same but
noisier. It chose a wrong lag (2 to 16) for up to 4 of the 12 noisy clones
in an arm.

The benchmark logs every step whose keys a mistake changed. That shows why
a trim does so little:

- Mistakes change the keys on about 7% of the rows (swap) and about 3%
  (late: the held keys are often what the teacher would press anyway).
- 36–56% of the crashes follow a mistake within 1 second. For comparison,
  13–26% of all recorded steps do.
- The rows a 30-step trim drops hold more mistakes than the rest (8–18%),
  but 82–92% of them are still correct driving.
- A 30-step trim removes only 5–18% of all mistake rows (60 steps: 9–27%).
  Most mistakes never lead to a crash.
- The mistakes themselves cost far more than any trim changes: agreement
  falls from 96–98% to 89–92%.

**Decision:** nothing more is dropped around a crash (`crashTrim: 0`). H1
already drops the damaged steps and the idle wait. H6's real human
recordings may show otherwise, and the option stays.

### Tests

- `node --test tests/dataset.test.mjs` (part of `npm run test:cloning`,
  20–40 seconds on a busy machine):
  - The mirror with the real sensors, the physics, and `mirrorBrain`, as
    above. The physics test requires at least one drive to split at a slide
    step, so the known limit stays visible.
  - Recorder output converts as the plan's H3 note says. The recording is a
    scripted racer on Rectangle: 12 runs with rest waits and crashes. The
    test checks one row per sample, the key bits, and a new episode exactly
    at each step gap. It checks the same pairs as H1's `lagPairs` for
    k = 1, 2, 9, and 16. It also checks several demonstrations, a JSON copy,
    and a version 1 record.
  - Labelled rest steps carry the keys of the move. `drop` removes them.
    A rest block that is not followed by the move is dropped in every mode.
  - `crashTrim` drops exactly the steps in the window before each crash.
  - Mirrored rows are the mirrored inputs and keys, as runs of their own.
    They are linked row by row, stay on their original's side of the split,
    and the trainer accepts them.
  - Malformed demonstrations and options are refused with a reason.
  - On both tracks, H3's teacher (seed `b`) records through H1's recorder.
    A clone trained with labelled rest steps presses forward at rest and
    leaves all 9 starts. With the keys actually held, it presses nothing
    and leaves none.
- `tests/cloning.test.mjs`: H3's test of H1's stored format now calls
  `demonstrationDataset`.
- The recorder's rest steps: see H1's tests above.

### Limits

- **Teachers are networks, not people.** Evolved networks are not
  symmetric: a teacher reaches 29 checkpoints on the mirrored Rectangle,
  against 53 for its mirror image. That is why mirroring costs so much here.
  A person may drive more symmetrically. H6's human recordings can check.
- **The two kinds of mistake are guesses** at how people slip. With real
  mistakes that end in crashes more often, a crash trim could still help.
  Also, these teachers crash often on their own (about 2 in 3 clean runs), so
  many rows before a crash are the teacher's own correct driving. That is
  part of why trimming costs a little on clean recordings.
- **Some teachers are odd drivers.** One drives mostly in reverse (its
  clones pull away in reverse, as it does), and several hold one steering
  key almost all the time. A person drives differently.
- **One trainer seed per arm,** so training noise is not measured apart
  from the effect of the data.
- **One layout per shape.** Rectangle and Triangle, 12 teachers each, over
  two sessions. The rest-step results and the mirror's cost in agreement
  hold in both sessions. The mirror's cost in checkpoints does not: on
  Triangle it turns into a small gain in session 2. The crash-trim results
  are small and split both ways.
- **Checkpoints are coarse,** and most clone rounds end in a crash (7 to 11
  of 13), as the teachers' own rounds do (7 to 10).
