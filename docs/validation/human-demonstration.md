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
| The car has moved since it was put at the start | "Waiting for your car to move." This drops the idle start, and the wait after each crash reset. |
| The car is the same car as in the last step | The first step of a new car is never recorded. |

A generation that ends during a recording does not reset your car. This uses
the same rule as a live multiplayer lap. Auto Train leaves the 1× in place
while recording.

### When a recording ends

- **Stop** (the same button).
- **Five minutes of samples** (18 000).
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

A recording with less than 1 second of samples is not saved.

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
| `samples`, `seconds`, `elapsedSteps` | counts |
| `laps`, `checkpoints`, `crashes`, `crashSteps` | the person's progress while recorded |
| `context` | the learning context: walls key (`track`), `maxSpeed`, `traction`, driving style, round length (as it started) |
| `track` | canvas size, walls, checkpoints, and `startInfo`, in the trial worker's format |
| `createdAt`, `endedAt`, `stopReason`, `version`, `car` | bookkeeping |

A full 5-minute recording is 810 000 bytes of samples
(18 000 × (40 + 1 + 4)), plus the track.

**Laps and checkpoints** count the steps the person drove: recorded steps,
and the step that crashed (one step can finish a lap and hit a wall).
Leaving the start is not a checkpoint, because the parked car already
touches the start gate; closing a lap through it is. Without a crash, a
drive earns one checkpoint less than the AI fitness count
(`checkPointsCount + laps × gates`).

### Known limits

- The parked car before its first move is never recorded, so no sample has
  a car at rest as its input. The plan's rule ("the car has moved") asks for
  this. A trainer that needs "press W at rest" examples would need a change
  here.
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
  - The latest sample equals `playerCar2.lastInputs` and the network's input.
    Pause and Play break the step sequence.
  - Stop saves one IndexedDB record with typed arrays, the training walls
    key, the physics, and the gate list. It applies the speed asked for while
    recording (20×).
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
