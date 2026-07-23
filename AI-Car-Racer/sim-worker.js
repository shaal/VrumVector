// sim-worker.js
// AI-car sim running off the main thread. Main owns rendering + UI + ruvector
// bridge + player cars; the worker owns the AI population, physics stepping,
// sensor raycasts, NN forward, damage + checkpoint detection, bestCar
// selection, the step-cap accumulator, and the generation-end trigger.
//
// Message protocol (main ↔ worker):
//
//   main → worker
//     { type: 'init',   canvasW, canvasH, borders, checkPointList }
//     { type: 'begin',  N, seconds, maxSpeed, traction, startInfo,
//                        brains: Float32Array(N*FLAT_LENGTH) }
//     { type: 'setSimSpeed', v }
//     { type: 'setPause', pause }
//     { type: 'setTraction', v }
//     { type: 'setMaxSpeed', v }
//
//   worker → main
//     { type: 'ready' }
//     { type: 'snapshot', ...see postSnapshot }   — throttled to ~60Hz
//     { type: 'genEnd', bestBrain, fitness, laps, lapTimes, checkPointsCount, frameCount }
//
// The worker keeps an identity-stable bestEpoch counter that increments each
// time it promotes a new `bestCar`. Main uses that to refresh the dynamics-
// embedder identity guard; without it, recording would reset on every
// snapshot.

importScripts('utils.js', 'spatialGrid.js', 'network.js', 'controls.js', 'sensor.js', 'car.js');

// Worker-scope globals that sensor.js / car.js read directly by name.
self.frameCount = 0;
self.bestCar = null;
self.road = null;
self.traction = 0.5;
self.maxSpeed = 15;
self.invincible = false;
self.SENSOR_STRIDE = 1;

// Sim state owned entirely by the worker.
let cars = [];
let pause = true;
let simSpeed = 1;
let seconds = 15;
let startInfo = null;
let _accum = 1;
let _lastTickWall = 0;
// Soft per-tick step safety (overridden by maxStepsForSpeed at runtime).
const MAX_STEPS = 60; // legacy name; runtime uses maxAccumForSpeed / maxStepsPerTick
let bestEpoch = 0;

// Per-tick wall-time budget base. Scaled up with simSpeed so 100× can burn
// real CPU instead of yielding every 20ms after only a handful of steps.
// Heavy N still self-limits via the budget; light/mid N at high speed needs
// a larger slice to approach the requested multiplier.
const TICK_BUDGET_MS = 20;

// Max sim-frame backlog kept across ticks. Old hard cap of 60 dropped almost
// all of a 100× accumulator every tick (100× × 16ms × 60fps ≈ 96 steps
// requested, 60 kept, rest discarded) — effective rate collapsed to ~1–2×.
function maxAccumForSpeed(ss) {
    // Keep up to ~1s of sim-time debt so temporary main-thread stalls can
    // catch up, without letting the queue grow without bound.
    const s = (Number.isFinite(ss) && ss > 0) ? ss : 1;
    return Math.max(60, Math.ceil(s * 60));
}
function tickBudgetForSpeed(ss) {
    const s = (Number.isFinite(ss) && ss > 0) ? ss : 1;
    if (s <= 2) return 16;
    if (s <= 5) return 24;
    if (s <= 20) return 40;
    if (s <= 50) return 60;
    return 100; // 100× — burn hard; main thread paints from latest snapshot only
}
function maxStepsPerTick(ss) {
    // Don't artificially stop early when budget remains; allow a full
    // second of sim per tick at high speed (budget will cut first if heavy).
    const s = (Number.isFinite(ss) && ss > 0) ? ss : 1;
    return Math.max(60, Math.ceil(s * 60));
}

// Flat-brain layout — see brainCodec.js on the main side. Hard-coded here so
// the worker doesn't have to importScripts a module (importScripts only loads
// classic scripts). If TOPOLOGY changes upstream, bump both sides.
// Phase P5: [10,16,4] topology — hidden width 8→16 capacity bump for the
// Triangle-apex policy. Inputs unchanged from P1 (7 rays + speed + lf + lr).
const FLAT_LENGTH = 244;
const TOPOLOGY = [10, 16, 4];

// --- message handling --------------------------------------------------------

self.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
        case 'init':        handleInit(m);        break;
        case 'begin':       handleBegin(m);       break;
        case 'setSimSpeed':
            simSpeed = (Number.isFinite(m.v) && m.v > 0) ? m.v : 1;
            // Avoid a huge catch-up step right after a speed jump.
            _lastTickWall = performance.now();
            break;
        case 'setPause':    handlePause(m.pause); break;
        case 'setTraction': self.traction = m.v;  break;
        case 'setMaxSpeed': self.maxSpeed = m.v;  break;
        // Phase 1C (F4) — minimal A/B-baseline freeze-sync hook. When
        // the primary pins its archive in `frozen` mode, it can post
        // `{type:'freeze', snapshot}` so this worker starts from the
        // identical archive view. We gate on the functions existing
        // (this worker has no bridge today — the hook is a no-op
        // until the A/B postMessage wiring lands; see
        // consistency/worker-sync.js for the producer helper).
        // Existing A/B setups that never post this message continue
        // to work unchanged.
        case 'freeze':      handleFreeze(m);      break;
    }
};

function handleFreeze(m) {
    if (!m || !m.snapshot) return;
    try {
        if (typeof self.importSnapshot === 'function') {
            self.importSnapshot(m.snapshot);
        }
        if (typeof self.setConsistencyMode === 'function') {
            self.setConsistencyMode('frozen');
        }
    } catch (e) {
        // Never throw out of onmessage — the worker would die silently.
        // Log through postMessage so main.js sees the failure.
        try { self.postMessage({ type: 'debug', event: 'freezeSyncFailed', error: String(e && e.message || e) }); }
        catch (_) { /* drop */ }
    }
}

function handleInit(m) {
    // Build a bare `road` object compatible with sensor/car's global reads.
    // The main-side Road class drags in DOM dependencies (roadEditor,
    // canvas), so we can't just instantiate it here.
    self.road = {
        left: 0, right: m.canvasW, top: 0, bottom: m.canvasH,
        borders: m.borders, checkPointList: m.checkPointList,
        borderGrid: null, cpGrid: null
    };
    self.road.borderGrid = new SpatialGrid(m.canvasW, m.canvasH, 200);
    self.road.borderGrid.addSegments(self.road.borders);
    self.road.cpGrid = new SpatialGrid(m.canvasW, m.canvasH, 200);
    if (self.road.checkPointList && self.road.checkPointList.length) {
        self.road.cpGrid.addSegments(self.road.checkPointList);
    }
}

// Build a car polygon at an arbitrary pose without allocating a Car (avoids
// instantiating Sensor + NeuralNetwork just to validate a spawn). Matches
// car.js #createPolygon exactly — keep the two in sync.
function makeCarPolygon(x, y, angle, width, height){
    const halfLen = height / 2, halfWid = width / 2;
    const fx = Math.sin(angle), fy = Math.cos(angle);
    const rx = Math.cos(angle), ry = -Math.sin(angle);
    return [
        { x: x + fx * halfLen,              y: y + fy * halfLen              },
        { x: x - fx * halfLen + rx * halfWid, y: y - fy * halfLen + ry * halfWid },
        { x: x - fx * halfLen - rx * halfWid, y: y - fy * halfLen - ry * halfWid },
    ];
}
function poseInCorridor(x, y, angle, width, height){
    const poly = makeCarPolygon(x, y, angle, width, height);
    const borders = self.road && self.road.borders;
    if (!borders) return true;
    const grid = self.road.borderGrid;
    if (grid){
        const ids = grid.queryPolygon(poly);
        for (let k = 0; k < ids.length; k++){
            const b = borders[ids[k]];
            if (b && polysIntersect(poly, b)) return false;
        }
        return true;
    }
    for (let i = 0; i < borders.length; i++){
        if (polysIntersect(poly, borders[i])) return false;
    }
    return true;
}

function handleBegin(m) {
    const _t0 = performance.now();
    self.frameCount = 0;
    self.bestCar = null;
    bestEpoch = 0;
    seconds = m.seconds;
    self.maxSpeed = m.maxSpeed;
    self.traction = m.traction;
    startInfo = m.startInfo;

    // Pose jitter: uniform disk around the canonical spawn (already offset
    // forward from cp0 gate-mid by computeStartInfoInPlace in main.js, which
    // gives each sample room to breathe even on apex-tight corridors like the
    // Triangle preset). Rejection-sample against road.borders; fall back to
    // canonical on persistent misses. Elite at i=0 keeps canonical pose so
    // fitness comparisons across generations stay anchored.
    const jit = m.poseJitter || {};
    const jitterR   = Math.max(0, +jit.radiusPx || 0);
    const jitterA   = (+jit.angleDeg || 0) * Math.PI / 180;
    const jitterMax = Math.max(1, +jit.maxAttempts || 8);
    const canonicalAngle = startInfo.heading || 0;
    let jitterRejected = 0, jitterFallback = 0;

    const N = m.N;
    const flat = m.brains;
    cars = new Array(N);
    for (let i = 0; i < N; i++) {
        let x = startInfo.x, y = startInfo.y, angle = canonicalAngle;
        if (i >= 1 && jitterR > 0){
            let accepted = false;
            for (let att = 0; att < jitterMax; att++){
                const r = Math.sqrt(Math.random()) * jitterR;    // uniform-in-disk
                const phi = Math.random() * 2 * Math.PI;
                const jx = startInfo.x + r * Math.cos(phi);
                const jy = startInfo.y + r * Math.sin(phi);
                const ja = canonicalAngle + (Math.random() * 2 - 1) * jitterA;
                if (poseInCorridor(jx, jy, ja, 30, 50)){
                    x = jx; y = jy; angle = ja; accepted = true; break;
                }
                jitterRejected++;
            }
            if (!accepted) jitterFallback++;
        }
        const c = new Car(x, y, 30, 50, 'AI', m.maxSpeed, angle);
        assignBrainFromFlat(c.brain, flat, i * FLAT_LENGTH);
        cars[i] = c;
    }
    if (jitterR > 0){
        self.postMessage({ type: 'debug', event: 'poseJitter', rejected: jitterRejected, fallback: jitterFallback, jittered: N - 1 });
    }
    self.bestCar = cars.length ? cars[0] : null;
    if (self.bestCar) bestEpoch = 1;

    _accum = 1;                               // match main's "guarantee one step" priming
    _lastTickWall = performance.now();
    pause = false;
    startLoop();
    self.postMessage({
        type: 'debug',
        event: 'beginBuilt',
        N,
        ms: performance.now() - _t0
    });
    // Publish one pose snapshot immediately so the main thread can paint the
    // parked swarm even when page-load re-pauses before the first step ticks.
    // steps=0 keeps the HUD honest ("not stepping yet"). Must run after
    // beginBuilt so a postSnapshot throw doesn't hide the build timing.
    try {
        postSnapshot(0, 0);
    } catch (e) {
        self.postMessage({
            type: 'debug',
            event: 'previewSnapFail',
            err: (e && e.message) || String(e)
        });
    }
}

function handlePause(p) {
    pause = p;
    if (!pause) {
        _lastTickWall = performance.now();
        startLoop();
    }
}

// --- brain helpers -----------------------------------------------------------

function assignBrainFromFlat(brain, flat, offset) {
    let k = offset;
    for (let L = 0; L < brain.levels.length; L++) {
        const level = brain.levels[L];
        for (let j = 0; j < level.biases.length;  j++) level.biases[j]  = flat[k++];
        for (let w = 0; w < level.weights.length; w++) level.weights[w] = flat[k++];
    }
}

function flattenBrain(brain) {
    const out = new Float32Array(FLAT_LENGTH);
    let k = 0;
    for (let L = 0; L < brain.levels.length; L++) {
        const level = brain.levels[L];
        for (let j = 0; j < level.biases.length;  j++) out[k++] = level.biases[j];
        for (let w = 0; w < level.weights.length; w++) out[k++] = level.weights[w];
    }
    return out;
}

// --- main loop ---------------------------------------------------------------
// MessageChannel scheduling avoids the browser's setTimeout(0) ~4ms clamp,
// which capped throughput at ~250 ticks/s and made high simSpeed starve.

const _tickChannel = new MessageChannel();
let _loopScheduled = false;
_tickChannel.port1.onmessage = () => {
    _loopScheduled = false;
    if (pause) return;
    stepOnce();
    // Re-arm immediately while running so the worker stays hot at high speed.
    if (!pause) scheduleTick();
};

function scheduleTick() {
    if (_loopScheduled) return;
    _loopScheduled = true;
    _tickChannel.port2.postMessage(null);
}

function startLoop() {
    scheduleTick();
}

function computeStride(ss) {
    // Heavier LOD at high speed: non-champion AI reuse last controls more often.
    if (ss <= 2) return 1;
    if (ss <= 5) return 2;
    if (ss <= 20) return 4;
    if (ss <= 50) return 8;
    return 16;
}

let _prevTickEnd = 0;
const WORKER_HITCH_MS = 60;
// At high speed, snapshot less often so postMessage packing doesn't dominate.
let _stepsSinceSnap = 0;

function stepOnce() {
    const now = performance.now();
    // Gap between end of the previous tick and start of this one.
    const tickGap = _prevTickEnd > 0 ? now - _prevTickEnd : 0;
    let dt = (now - _lastTickWall) / 1000;
    _lastTickWall = now;
    // Slightly larger clamp at high speed so a single long tick after archive
    // work still converts into useful catch-up instead of being truncated to
    // 0.25s of wall (which dropped most of a 100× burst under the old cap).
    const dtCap = simSpeed >= 50 ? 0.5 : 0.25;
    if (dt > dtCap) dt = dtCap;
    _accum += simSpeed * dt * 60;
    const accumCap = maxAccumForSpeed(simSpeed);
    if (_accum > accumCap) _accum = accumCap;

    const budgetMs = tickBudgetForSpeed(simSpeed);
    const stepCap = maxStepsPerTick(simSpeed);
    self.SENSOR_STRIDE = computeStride(simSpeed);

    // Drain until empty, step cap, or wall budget — leftover stays in _accum
    // for the next tick (no pre-debit of the whole queue).
    const simStart = performance.now();
    const cpLen = self.road.checkPointList.length;
    let stepsRun = 0;
    let maxStepMs = 0;
    while (_accum >= 1 && stepsRun < stepCap) {
        if (performance.now() - simStart > budgetMs) break;
        const stepStart = performance.now();
        if (self.frameCount >= 60 * seconds) {
            postSnapshot(performance.now() - simStart, stepsRun);
            endGen();
            return;
        }
        self.frameCount++;
        _accum -= 1;
        for (let i = 0; i < cars.length; i++) {
            const cc = cars[i];
            const prevDamaged = cc.damaged;
            // Snapshot prior-frame slide flag so endGen can classify slide-out
            // deaths separately from head-on / side-scrape. Capturing before
            // update() is cheap and avoids allocating a parallel buffer.
            const prevSlide = !!cc.slide;
            cc.update(self.road.borders, self.road.checkPointList);
            if (!prevDamaged && cc.damaged) {
                cc.deathFrame = self.frameCount;
                cc.slideAtDeath = prevSlide;
                // Crash locus for adaptive-gates / heat analysis on main.
                cc.deathX = cc.x;
                cc.deathY = cc.y;
            }
        }
        // O(N) live-champion scan (prefer alive). At high simSpeed scan every
        // other step — a 1-frame lag on the yellow highlight is invisible and
        // saves a full population walk. Always scan if the current champion
        // just died so rays hop immediately.
        const needBestScan = simSpeed < 50
            || (self.frameCount & 1) === 0
            || (self.bestCar && self.bestCar.damaged);
        if (needBestScan) {
            let bestFitAlive = -Infinity, bestAlive = null;
            let bestFitAll = -Infinity, bestAll = null;
            for (let i = 0; i < cars.length; i++) {
                const c = cars[i];
                const f = c.checkPointsCount + c.laps * cpLen;
                if (f > bestFitAll) { bestFitAll = f; bestAll = c; }
                if (!c.damaged && f > bestFitAlive) { bestFitAlive = f; bestAlive = c; }
            }
            const bestC = bestAlive || bestAll;
            if (bestC && self.bestCar !== bestC) {
                self.bestCar = bestC;
                bestEpoch++;
                // New champion wasn't privileged this step (LOD may have skipped
                // its perception). Refresh rays immediately so the same-tick
                // snapshot shows sensors on the new leader, not a blank/stale set.
                if (!bestC.damaged && bestC.sensor) {
                    try { bestC.sensor.update(self.road.borders); } catch (_) {}
                }
            }
        }
        stepsRun++;
        const stepMs = performance.now() - stepStart;
        if (stepMs > maxStepMs) maxStepMs = stepMs;
    }
    const simMs = performance.now() - simStart;

    // Snapshot cadence: every tick at low speed; every ~2–3 ticks at 100× so
    // packing N poses doesn't eat the budget we just freed for stepping.
    _stepsSinceSnap += stepsRun;
    const snapEvery = simSpeed >= 50 ? 3 : (simSpeed >= 20 ? 2 : 1);
    const wantSnap = stepsRun > 0 && (
        _stepsSinceSnap >= snapEvery ||
        // Always snap if we did a meaningful chunk this tick.
        stepsRun >= 30
    );
    const postStart = performance.now();
    if (wantSnap) {
        postSnapshot(simMs, stepsRun);
        _stepsSinceSnap = 0;
    }
    const postMs = performance.now() - postStart;

    const tickEnd = performance.now();
    const tickMs = tickEnd - now;
    _prevTickEnd = tickEnd;

    // Report worker-side hitches so main can attribute snapGap to its real
    // cause: gc (large tickGap, small tick work), one-huge-step (maxStep
    // dominates), or postMessage cost (postMs dominates).
    if (tickGap + tickMs > WORKER_HITCH_MS) {
        self.postMessage({
            type: 'debug',
            event: 'slowTick',
            gap: tickGap,
            tick: tickMs,
            maxStep: maxStepMs,
            post: postMs,
            steps: stepsRun
        });
    }
}

// --- snapshots ---------------------------------------------------------------

function postSnapshot(simMs, steps) {
    const N = cars.length;
    const cpLen = self.road.checkPointList.length || 1;

    const positions = new Float32Array(N * 5);
    for (let i = 0; i < N; i++) {
        const c = cars[i];
        const o = i * 5;
        positions[o]     = c.x;
        positions[o + 1] = c.y;
        positions[o + 2] = c.angle;
        positions[o + 3] = c.damaged ? 1 : 0;
        positions[o + 4] = c.checkPointsCount + c.laps * cpLen;
    }

    let bestIdx = -1;
    if (self.bestCar) {
        for (let i = 0; i < N; i++) {
            if (cars[i] === self.bestCar) { bestIdx = i; break; }
        }
    }

    let bestRays = null, bestReadings = null, bestControls = null;
    let bestSpeed = 0, bestMaxSpeed = self.maxSpeed, bestDamaged = 0;
    let bestCheckpoints = 0, bestLaps = 0, bestLapTimes = null;
    // Task 2.D: brain-decision viz. bestInputs = the 10-float input vector fed
    // into the NN on the best car's last forward pass this tick (7 rays + speed
    // + lf + lr). bestOutputActivations = the 4 pre-threshold sums (sum-bias)
    // for forward/left/right/reverse; thresholded(x>0) must match bestControls
    // by construction since both come from the SAME forward pass the controls
    // were derived from. The LOD gate in car.js guarantees bestCar always runs
    // perception, so these are never stale placeholder values.
    let bestInputs = null, bestOutputActivations = null;
    if (self.bestCar && self.bestCar.sensor && self.bestCar.sensor.rays.length) {
        const bc = self.bestCar;
        const rays = bc.sensor.rays;
        bestRays = new Float32Array(rays.length * 4);
        for (let i = 0; i < rays.length; i++) {
            bestRays[i * 4]     = rays[i][0].x;
            bestRays[i * 4 + 1] = rays[i][0].y;
            bestRays[i * 4 + 2] = rays[i][1].x;
            bestRays[i * 4 + 3] = rays[i][1].y;
        }
        const readings = bc.sensor.readings;
        bestReadings = new Float32Array(rays.length * 3);
        for (let i = 0; i < rays.length; i++) {
            const r = readings[i];
            if (r) {
                bestReadings[i * 3]     = r.x;
                bestReadings[i * 3 + 1] = r.y;
                bestReadings[i * 3 + 2] = r.offset;
            } else {
                bestReadings[i * 3]     = 0;
                bestReadings[i * 3 + 1] = 0;
                bestReadings[i * 3 + 2] = -1;
            }
        }
        const ctrl = bc.controls;
        bestControls = [
            ctrl.forward ? 1 : 0,
            ctrl.left    ? 1 : 0,
            ctrl.right   ? 1 : 0,
            ctrl.reverse ? 1 : 0
        ];
        bestSpeed = bc.speed;
        bestMaxSpeed = bc.maxSpeed;
        bestDamaged = bc.damaged ? 1 : 0;
        bestCheckpoints = bc.checkPointsCount;
        bestLaps = bc.laps;
        bestLapTimes = Array.isArray(bc.lapTimes) ? bc.lapTimes.slice() : null;
        // Capture input + output pre-threshold vectors from the best car's
        // most recent forward pass. levels[0].inputs is the scratch buffer
        // feedForward just wrote; levels[last].preThreshold is the sum-bias
        // pre-gate vector populated by the modified Level.feedForward in
        // network.js. Both are owned by the worker's brain object — copy
        // into fresh Float32Arrays so we can postMessage-transfer them.
        try {
            const lvls = bc.brain && bc.brain.levels;
            if (lvls && lvls.length) {
                const inArr = lvls[0].inputs;
                if (inArr && inArr.length) bestInputs = new Float32Array(inArr);
                const outLvl = lvls[lvls.length - 1];
                if (outLvl && outLvl.preThreshold && outLvl.preThreshold.length) {
                    bestOutputActivations = new Float32Array(outLvl.preThreshold);
                }
            }
        } catch (_) { /* bail quietly — viz is non-critical */ }
    }

    const transfer = [positions.buffer];
    if (bestRays)     transfer.push(bestRays.buffer);
    if (bestReadings) transfer.push(bestReadings.buffer);
    if (bestInputs)              transfer.push(bestInputs.buffer);
    if (bestOutputActivations)   transfer.push(bestOutputActivations.buffer);

    self.postMessage({
        type: 'snapshot',
        frameCount: self.frameCount,
        bestIdx, bestEpoch,
        positions, N,
        bestRays, bestReadings, bestControls,
        bestSpeed, bestMaxSpeed, bestDamaged,
        bestCheckpoints, bestLaps, bestLapTimes,
        bestInputs, bestOutputActivations,
        simMs, steps
    }, transfer);
}

function endGen() {
    // Re-pick the fitness elite across the whole population — including
    // damaged cars. Live bestCar prefers survivors for the ray overlay; the
    // brain we archive/seed from should still be whoever got furthest.
    const cpLen = self.road.checkPointList.length || 0;
    let elite = null, eliteFit = -Infinity;
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        const f = c.checkPointsCount + c.laps * cpLen;
        if (f > eliteFit) { eliteFit = f; elite = c; }
    }
    if (!elite) return;
    self.bestCar = elite;
    const bc = elite;
    const flat = flattenBrain(bc.brain);

    // Population-wide stats: per-car checkpoint counts + death frames. Main
    // thread derives median / p90 / survival@T percentiles from these arrays,
    // so new buckets can be added without touching the worker.
    const N = cars.length;
    const popCheckpoints = new Int16Array(N);
    const popDeathFrames = new Int32Array(N);   // -1 sentinel = survived to timeout
    // popDeathCauses encodes per-car terminal state: 0=head-on, 1=side-scrape,
    // 2=slide-out, 3=stalled, 4=alive. Mutually exclusive — sum across buckets
    // equals N. Classification is O(N) at endGen (no per-frame cost).
    const popDeathCauses = new Int8Array(N);
    // Crash positions (x,y per car). Alive / never-damaged → NaN so consumers
    // can skip. Used by AdaptiveGates crash-heat curriculum on main.
    const popDeathXY = new Float32Array(N * 2);
    let wallBumps = 0, stillAlive = 0;
    for (let i = 0; i < N; i++) {
        const c = cars[i];
        popCheckpoints[i] = c.checkPointsCount | 0;
        if (c.damaged) {
            wallBumps++;
            popDeathFrames[i] = (c.deathFrame != null ? c.deathFrame : self.frameCount) | 0;
            popDeathXY[i * 2]     = (c.deathX != null ? c.deathX : c.x);
            popDeathXY[i * 2 + 1] = (c.deathY != null ? c.deathY : c.y);
            // Forward speed magnitude — `c.speed` is scalar along the car's
            // heading axis; |speed|/maxSpeed > 0.7 means the car was driving
            // hard into the wall rather than scraping it laterally.
            const maxSpd = c.maxSpeed || 1;
            const fwdMag = Math.abs(c.speed || 0);
            // Priority: slide-out > head-on > side-scrape. Slide-out is a
            // distinctive traction-loss failure even at high forward speed,
            // so we tag it first when c.slideAtDeath was latched at impact.
            if (c.slideAtDeath) {
                popDeathCauses[i] = 2; // slide-out
            } else if (fwdMag > 0.7 * maxSpd) {
                popDeathCauses[i] = 0; // head-on
            } else {
                popDeathCauses[i] = 1; // side-scrape (low forward vel, lateral impact)
            }
        } else {
            stillAlive++;
            popDeathFrames[i] = -1;
            popDeathCauses[i] = (c.checkPointsCount | 0) >= 1 ? 4 : 3;
            popDeathXY[i * 2] = NaN;
            popDeathXY[i * 2 + 1] = NaN;
        }
    }

    // Elite's last-tick hidden-layer activations for SONA trajectory
    // recording. Network topology is [10, 16, 4]; level 0's outputs is the
    // most informative internal state. Copied (not transferred in-place)
    // because the worker continues to own the underlying brain object.
    let bestHiddenActivations = null;
    try {
        const lev0 = bc.brain && bc.brain.levels && bc.brain.levels[0];
        if (lev0 && lev0.outputs) bestHiddenActivations = new Float32Array(lev0.outputs);
    } catch (_) {}

    const transfer = [
        flat.buffer,
        popCheckpoints.buffer,
        popDeathFrames.buffer,
        popDeathCauses.buffer,
        popDeathXY.buffer,
    ];
    if (bestHiddenActivations) transfer.push(bestHiddenActivations.buffer);

    self.postMessage({
        type: 'genEnd',
        bestBrain: flat,
        fitness: bc.checkPointsCount + bc.laps * cpLen,
        laps: bc.laps,
        lapTimes: Array.isArray(bc.lapTimes) ? bc.lapTimes.slice() : [],
        checkPointsCount: bc.checkPointsCount,
        frameCount: self.frameCount,
        popN: N,
        popWallBumps: wallBumps,
        popStillAlive: stillAlive,
        popCheckpoints, popDeathFrames, popDeathCauses, popDeathXY,
        bestHiddenActivations,
        genSeconds: seconds
    }, transfer);
    // Wait for main's next `begin` — stepping is paused until then.
    pause = true;
}

// Ready signal so main can sync init before posting begin().
self.postMessage({ type: 'ready' });
