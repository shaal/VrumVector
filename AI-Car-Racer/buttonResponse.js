function pauseGame(){
    // App not booted yet (classic scripts still loading). Queue the intent;
    // main.js drains __pendingStart after begin/animate are defined.
    if (typeof pause === 'undefined' || typeof phase === 'undefined'){
        window.__pendingStart = true;
        markStartOverlayStarting();
        return;
    }

    // First Start click: leave the page-load gate and build+run the swarm.
    // (Population build is deferred until this moment so the Start CTA is
    // clickable as soon as the overlay paints — not after a multi-second
    // worker/brain setup.)
    if (window.__awaitingStart){
        window.__awaitingStart = false;
        window.__firstStart = false;
        window.__pendingStart = false;
        pause = false;
        const btn = document.getElementById("pause");
        if (btn){
            btn.textContent = "Pause";
            btn.classList.remove('start-cta');
        }
        markStartOverlayStarting();
        try { if (typeof syncStartOverlay === 'function') syncStartOverlay(); } catch (_) {}
        if (typeof begin === 'function'){
            begin();
        } else {
            // main.js still evaluating — re-queue so the boot footer can start.
            window.__pendingStart = true;
        }
        return;
    }

    // Normal Pause / Play toggle after training has started.
    pause = !pause;
    const btn = document.getElementById("pause");
    if (btn){
        btn.textContent = pause ? "Play" : "Pause";
        btn.classList.remove('start-cta');
    }
    // Halt / resume the worker's AI step loop too. Without this, sim-worker
    // would keep burning CPU while the user has paused — and on resume the
    // accumulator would stampede a huge backlog of physics steps at once.
    if (typeof simWorker !== 'undefined' && simWorker){
        simWorker.postMessage({ type: 'setPause', pause });
    }
    try { if (typeof syncStartOverlay === 'function') syncStartOverlay(); } catch (_) {}
}

function markStartOverlayStarting(){
    const ob = document.getElementById('startOverlayBtn');
    if (!ob) return;
    ob.classList.add('is-starting');
    ob.disabled = true;
    const label = ob.querySelector('.start-overlay-label');
    if (label) label.textContent = 'Starting\u2026';
}

// Canvas-centered Start overlay — present in index.html for first paint,
// kept in sync here once the app boots. Mirrors the panel's ▶ Start CTA.
function syncStartOverlay(){
    let el = document.getElementById('startOverlay');
    // Show while awaiting Start on the training screen. Before main.js sets
    // `phase`, treat as showable so the static HTML overlay stays visible
    // during script load (that was the multi-second "can't click yet" gap).
    const show = !!window.__awaitingStart &&
        (typeof phase === 'undefined' || phase === 4);
    if (!show){
        if (el) el.hidden = true;
        return;
    }
    if (!el){
        el = document.createElement('div');
        el.id = 'startOverlay';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'Start training');
        el.innerHTML =
            '<button type="button" class="start-overlay-btn" id="startOverlayBtn">' +
                '<span class="start-overlay-icon" aria-hidden="true">▶</span>' +
                '<span class="start-overlay-label">Start Training</span>' +
                '<span class="start-overlay-hint">or press the Start button in the panel</span>' +
            '</button>';
        const host = document.getElementById('canvasDiv') || document.body;
        host.appendChild(el);
    }
    const btn = el.querySelector('#startOverlayBtn');
    if (btn && btn.dataset.earlyBound !== '1' && btn.dataset.bound !== '1'){
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
            if (typeof pauseGame === 'function') pauseGame();
            else window.__pendingStart = true;
        });
    }
    // Reset busy state when re-showing (e.g. Customize Track → back to train).
    if (btn && window.__awaitingStart){
        btn.disabled = false;
        btn.classList.remove('is-starting');
        const label = btn.querySelector('.start-overlay-label');
        if (label) label.textContent = 'Start Training';
    }
    el.hidden = false;
}
window.syncStartOverlay = syncStartOverlay;
window.markStartOverlayStarting = markStartOverlayStarting;

// Route a phase-4 user back into the track editor. Mirrors backPhase()'s
// cleanup (pause the worker, close any SONA trajectory) but sets phase=0
// so the next nextPhase() call lands on phase 1 — i.e. the classic
// "draw your own track" entry point. Triggered by the ✏️ Customize Track
// button added to the training panel.
function customizeTrack(){
    if (typeof simWorker !== 'undefined' && simWorker){
        try { simWorker.postMessage({ type: 'setPause', pause: true }); } catch(_){}
    }
    try {
        if (phase === 4 && !window.rvDisabled && window.__rvBridge){
            var fit = Number(window.__rvSessionBestFitness) || 0;
            window.__rvBridge.endPhase4Trajectory(fit);
        }
    } catch (e) { console.warn('[sona] customize exit failed', e); }
    phase = 0;
    nextPhase();
}
function save(){
    const progressVal = bestCar.checkPointsCount+bestCar.laps*road.checkPointList.length/seconds;
    if(localStorage.getItem("progress")){
        var progressArray = JSON.parse(localStorage.getItem("progress"));
        progressArray.push(fastLap);
        localStorage.setItem("progress",JSON.stringify(progressArray));
    }
    else{
        localStorage.setItem("progress",JSON.stringify([fastLap]));
    }
    // P5.D: record per-batch graph annotations parallel to progress[]. Two
    // signals per generation: (1) was this batch initialised from the vector
    // archive (currentSeedIds non-empty); (2) how much did the top-K seed
    // ordering shift vs the previous batch (captures EMA-reranker effect of
    // the prior observe() call plus any archive-update reshuffle).
    var seeded = (typeof currentSeedIds !== 'undefined' && currentSeedIds && currentSeedIds.length > 0);
    var prev = (typeof window.__rvLastSeedIdsForGraph !== 'undefined' && window.__rvLastSeedIdsForGraph) || null;
    var curr = seeded ? currentSeedIds : [];
    var shift = prev ? rankShiftForGraph(prev, curr) : 0;
    window.__rvLastSeedIdsForGraph = curr.slice();
    var annArr = localStorage.getItem("rvAnnotations") ? JSON.parse(localStorage.getItem("rvAnnotations")) : [];
    annArr.push({ seeded: seeded, shift: shift });
    localStorage.setItem("rvAnnotations", JSON.stringify(annArr));

    localStorage.setItem("oldBestBrain",(localStorage.getItem("bestBrain")));
    // serializeBrain converts Float32Array weights/biases to plain arrays so
    // JSON.stringify produces clean output (Float32Array serialises as
    // {"0":x,"1":y,...} otherwise, which doesn't revive with .length).
    localStorage.setItem("bestBrain",JSON.stringify(serializeBrain(bestCar.brain)));
}

// Spearman's-footrule shift over the union of top-K ids (mirrors the
// computeRankShift in uiPanels.js used by the P5.C reranker indicator).
// Ids present in only one list count as rank K, so a drop-out from
// position i and a fresh promotion into position i both contribute K-i.
function rankShiftForGraph(prev, curr){
    if (!prev.length && !curr.length) return 0;
    var K = Math.max(prev.length, curr.length);
    var prevIdx = new Map(); for (var i=0;i<prev.length;i++) prevIdx.set(prev[i], i);
    var currIdx = new Map(); for (var j=0;j<curr.length;j++) currIdx.set(curr[j], j);
    var union = new Set(); prev.forEach(function(id){union.add(id);}); curr.forEach(function(id){union.add(id);});
    var sum = 0;
    union.forEach(function(id){
        var pi = prevIdx.has(id) ? prevIdx.get(id) : K;
        var ci = currIdx.has(id) ? currIdx.get(id) : K;
        sum += Math.abs(pi - ci);
    });
    return sum;
}
function restoreOldBrain(){
    localStorage.setItem("bestBrain", localStorage.getItem("oldBestBrain"));
    restartBatch();
}

// === Phase A — named brain saves (multi-slot localStorage) =================
//
// Mirrors the single-slot save()/restoreOldBrain() pair above but with
// arbitrary user-named slots, keyed under `vv_brainsave_<name>`. Each slot
// stores the same shape as serializeBrain(bestCar.brain) plus light meta
// (fitness, savedAt, optional trackId/generation) for the dropdown label.
//
// Load reuses the existing seeding pathway: write to localStorage.bestBrain
// + restartBatch(), exactly like restoreOldBrain. Start-fresh wipes every
// piece of trained state — IDB archive via bridge._debugReset(), the
// localStorage prior, the lap timer — and reloads.
const BRAIN_SAVE_PREFIX = "vv_brainsave_";

function _brainSavesList(){
    var out = [];
    for (var i = 0; i < localStorage.length; i++){
        var k = localStorage.key(i);
        if (k && k.indexOf(BRAIN_SAVE_PREFIX) === 0){
            out.push(k.slice(BRAIN_SAVE_PREFIX.length));
        }
    }
    out.sort();
    return out;
}
function refreshBrainSavesDropdown(selectedName){
    var sel = document.getElementById("brainSavesSelect");
    if (!sel) return;
    var names = _brainSavesList();
    sel.innerHTML = "";
    if (names.length === 0){
        var opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no saves yet)";
        opt.disabled = true;
        opt.selected = true;
        sel.appendChild(opt);
        return;
    }
    for (var i = 0; i < names.length; i++){
        var n = names[i];
        var opt2 = document.createElement("option");
        opt2.value = n;
        // Decorate the label with fitness if we can read it cheaply.
        var label = n;
        try {
            var raw = localStorage.getItem(BRAIN_SAVE_PREFIX + n);
            if (raw){
                var slot = JSON.parse(raw);
                if (slot && typeof slot.fitness === "number"){
                    label += "  (fit " + slot.fitness.toFixed(1) + ")";
                }
            }
        } catch (_) {}
        opt2.textContent = label;
        if (selectedName && n === selectedName) opt2.selected = true;
        sel.appendChild(opt2);
    }
}
function brainSaveAs(){
    if (typeof bestCar === "undefined" || !bestCar || !bestCar.brain){
        window.alert("No best brain to save yet — train at least one generation first.");
        return;
    }
    // Default name: timestamp-fitness, e.g. "2026-04-24-1830-fit42". The user
    // can rename freely; only the prompt response is used as the key.
    var fit = Number(window.__rvSessionBestFitness) || 0;
    var ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    var defaultName = ts + "-fit" + fit.toFixed(0);
    var name = (window.prompt("Name this saved brain:", defaultName) || "").trim();
    if (!name) return;
    if (localStorage.getItem(BRAIN_SAVE_PREFIX + name)){
        if (!window.confirm('"' + name + '" already exists. Overwrite?')) return;
    }
    var slot = {
        name: name,
        savedAt: new Date().toISOString(),
        fitness: fit,
        // Optional context — used only for dropdown labels and inspection.
        // Best-effort; missing fields don't break anything.
        trackId: (window.lastEmbeddedTrackId || null),
        // serializeBrain is a global from main.js; its output is the shape
        // localStorage.bestBrain expects, so Load is a one-line copy.
        brain: serializeBrain(bestCar.brain),
    };
    localStorage.setItem(BRAIN_SAVE_PREFIX + name, JSON.stringify(slot));
    refreshBrainSavesDropdown(name);
}
function brainSaveLoad(){
    var sel = document.getElementById("brainSavesSelect");
    var name = sel && sel.value;
    if (!name){ window.alert("Pick a saved brain from the dropdown first."); return; }
    var raw = localStorage.getItem(BRAIN_SAVE_PREFIX + name);
    if (!raw){ window.alert('Saved brain "' + name + '" not found.'); refreshBrainSavesDropdown(); return; }
    var slot;
    try { slot = JSON.parse(raw); } catch (_) {
        window.alert('Saved brain "' + name + '" is corrupted.');
        return;
    }
    if (!slot || !slot.brain){
        window.alert('Saved brain "' + name + '" is empty.');
        return;
    }
    var ok = window.confirm(
        'Load "' + name + '"?\n\n' +
        'This will REPLACE the current best brain with the saved one and ' +
        'restart the batch.\n\nProceed?'
    );
    if (!ok) return;
    // Mirror restoreOldBrain: write to bestBrain, restart. The seeding
    // loop in main.js reads localStorage.bestBrain when the batch begins.
    localStorage.setItem("bestBrain", JSON.stringify(slot.brain));
    if (typeof restartBatch === "function") restartBatch();
}
function brainSaveDelete(){
    var sel = document.getElementById("brainSavesSelect");
    var name = sel && sel.value;
    if (!name) return;
    if (!window.confirm('Delete saved brain "' + name + '"? This cannot be undone.')) return;
    localStorage.removeItem(BRAIN_SAVE_PREFIX + name);
    refreshBrainSavesDropdown();
}
async function brainStartFresh(){
    var ok = window.confirm(
        "Start with an empty brain?\n\n" +
        "This will WIPE everything trained so far:\n" +
        " • the live archive (all archived brains, tracks, dynamics)\n" +
        " • the saved best brain + fast lap\n" +
        " • the lineage DAG\n" +
        "\n" +
        "Your named brain saves are NOT deleted (use Delete for those).\n" +
        "The page will reload. Proceed?"
    );
    if (!ok) return;
    // Wipe IDB + bridge in-memory state via bridge._debugReset(). The
    // bridge surfaces this on window for the verifier console; we use the
    // same hook here.
    try {
        if (window.__rvBridge && typeof window.__rvBridge._debugReset === "function"){
            await window.__rvBridge._debugReset();
        }
    } catch (e) { console.warn("[brain-saves] _debugReset failed", e); }
    // Wipe legacy localStorage trained state. Named saves
    // (vv_brainsave_*) are deliberately preserved so a fresh-start
    // doesn't lose the user's curated slots.
    var legacyKeys = ["bestBrain", "oldBestBrain", "fastLap", "progress", "rvAnnotations"];
    for (var i = 0; i < legacyKeys.length; i++){
        try { localStorage.removeItem(legacyKeys[i]); } catch (_) {}
    }
    location.reload();
}
// =========================================================================
function resetFastLap(){
    // Phase A: scope the reset to the CURRENT track only. The legacy
    // global `localStorage.fastLap` key was retired at boot; the new
    // per-track keys are vv_fastlap_<trackHash>. Use the bridge helper
    // exposed by main.js to look up the current track's key.
    try {
        if (window.__vvFastLap && typeof window.__vvFastLap.trackKey === 'function') {
            const k = window.__vvFastLap.trackKey();
            if (k) localStorage.removeItem(k);
            // Re-sync the global cache so the UI reflects the cleared state.
            if (typeof window.__vvFastLap.syncFromStore === 'function') {
                window.__vvFastLap.syncFromStore();
                return;
            }
        }
    } catch (_) {}
    // Fallback for the case where the bridge helper isn't loaded yet
    // (e.g., during very early boot). Match the pre-Phase-A behaviour
    // of clearing the in-memory cache.
    fastLap = '--';
    if (typeof lastLap !== 'undefined') lastLap = null;
}
function destroyBrain(){
    localStorage.removeItem("bestBrain");
    // Phase A: legacy fastLap key is already retired at boot; this
    // removal is a no-op now but kept so any pre-Phase-A revert leaves
    // a clean slate. resetFastLap() handles the per-track keys.
    localStorage.removeItem("fastLap");
    resetFastLap();
}

// Phase A: bulk clear of every per-track fastLap. Wired from the
// 🧠 Brain saves disclosure (utils.js) for the destructive bulk option,
// distinct from resetFastLap() which only clears the current track.
function clearAllFastLaps(){
    var keys = [];
    try {
        for (var i = 0; i < localStorage.length; i++){
            var k = localStorage.key(i);
            if (k && window.__vvFastLap && k.indexOf(window.__vvFastLap.prefix) === 0){
                keys.push(k);
            }
        }
    } catch (_) {}
    if (keys.length === 0){
        window.alert('No fast-lap records to clear.');
        return;
    }
    if (!window.confirm('Clear ALL ' + keys.length + ' track fast-lap record' +
                        (keys.length === 1 ? '' : 's') +
                        '? This cannot be undone.\n\nNamed brain saves are NOT affected.')){
        return;
    }
    for (var j = 0; j < keys.length; j++) localStorage.removeItem(keys[j]);
    // Resync display.
    try {
        if (window.__vvFastLap && typeof window.__vvFastLap.syncFromStore === 'function'){
            window.__vvFastLap.syncFromStore();
        }
    } catch (_) {}
}
function submitTrack(){
    road.getTrack();
    road.roadEditor.checkPointModeChange(false);
    road.roadEditor.editModeChange(false);
}
function deleteTrack(){
    if(localStorage.getItem("trackInner")){
        localStorage.removeItem("trackInner");
    }
    if(localStorage.getItem("trackOuter")){
        localStorage.removeItem("trackOuter");
    }
    if(localStorage.getItem("checkPointList")){
        localStorage.removeItem("checkPointList");
    }
    location.reload();
}
function saveTrack(){
    localStorage.setItem("trackInner",JSON.stringify(road.roadEditor.points));
    localStorage.setItem("trackOuter",JSON.stringify(road.roadEditor.points2))
    localStorage.setItem("checkPointList",JSON.stringify(road.roadEditor.checkPointListEditor))
}
function savePhysics(){
    localStorage.setItem("maxSpeed", JSON.stringify(maxSpeed));
    localStorage.setItem("traction", traction);
}
function checkPoint(onOff){
    road.roadEditor.checkPointModeChange(onOff);
}
function deleteLastPoint(){
    road.roadEditor.deleteLast();
}
function resetTrainCount(){
    localStorage.setItem("trainCount", JSON.stringify(0));
    localStorage.setItem("progress", JSON.stringify([]));
    localStorage.setItem("rvAnnotations", JSON.stringify([]));
    window.__rvLastSeedIdsForGraph = null;
}
function nextPhase(){
    phase+=1;
    switch(phase){
        case 1:
            road.roadEditor.checkPointModeChange(false);
            road.roadEditor.editModeChange(true);
            phaseToLayout(phase);
            break;
        case 2:
            road.roadEditor.editModeChange(true);
            road.roadEditor.checkPointModeChange(true);
            phaseToLayout(phase);
            break;
        case 3:
            road.roadEditor.checkPointModeChange(false);
            road.roadEditor.editModeChange(false);
            phaseToLayout(phase);
            saveTrack();
            submitTrack();
            embedCurrentTrack();

            break;
        case 4:
            // Force the sim worker to re-ingest road geometry. The track may
            // have been reshaped in phases 1-2 since the last phase-4 entry;
            // without this the worker would keep using stale borders and
            // AI cars would phase through the current visible track.
            if (typeof invalidateWorkerInit === 'function') invalidateWorkerInit();
            begin();
            road.roadEditor.checkPointModeChange(false);
            road.roadEditor.editModeChange(false);
            phaseToLayout(phase);
            submitTrack();
            // P2.A — frame a SONA trajectory around the whole training session.
            // The trackVec was embedded in phase 3 (embedCurrentTrack), so it's
            // available here on window.currentTrackVec. When the bridge isn't
            // ready yet (first boot of a cold session) this is a silent no-op.
            try {
                window.__rvSessionBestFitness = 0;
                if (!window.rvDisabled && window.__rvBridge && window.currentTrackVec) {
                    window.__rvBridge.beginPhase4Trajectory(window.currentTrackVec);
                }
            } catch (e) { console.warn('[sona] phase-4 begin failed', e); }
            // pauseGame();
            break;
    }
}
function backPhase(){
    // Stop the sim worker from burning CPU in the background while the user
    // edits the track / tunes physics. The worker resumes automatically on
    // the next phase-4 entry because performBegin() posts a new 'begin'
    // which implicitly unpauses stepping.
    if (phase === 4 && typeof simWorker !== 'undefined' && simWorker) {
        try { simWorker.postMessage({ type: 'setPause', pause: true }); } catch (_) {}
    }
    // P2.A — if we're leaving phase 4, close the SONA trajectory first so its
    // steps get clustered into ReasoningBank patterns before the session state
    // tears down. Uses the running session-best fitness that main.js maintains
    // after each archiveBrain call.
    try {
        if (phase === 4 && !window.rvDisabled && window.__rvBridge) {
            var fit = Number(window.__rvSessionBestFitness) || 0;
            window.__rvBridge.endPhase4Trajectory(fit);
        }
    } catch (e) { console.warn('[sona] phase-4 end failed', e); }
    phase-=2;
    nextPhase();
}
function setN(value){
    batchSize=value;
}
function setSeconds(value){
    nextSeconds=value;
}
function setMutateValue(value){
    mutateValue=value;
}
// P2.C Conservative Init setter. Clamps to [0, 1] and persists to
// localStorage so the bias survives reload. Only consumed inside
// fillRandom() on cold-random init paths — the worker never reads this
// directly; the bias is baked into the flat weights buffer before ship.
function setConservativeInit(value){
    const n = parseFloat(value);
    conservativeInit = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    try { localStorage.setItem("conservativeInit", String(conservativeInit)); } catch (_) {}
}
// Training-phase presets. Each entry sets the knobs that dominate training
// feel: N, simSpeed, seconds, mutateValue, conservativeInit. Values are
// step-aligned to the slider granularity so the DOM reflects them exactly.
//   fresh  — cold / early: honest 2×, conservative wall-reflex bias, explore
//   grind  — elite exists: farm generations + grow the ruvector archive
//   polish — refine lap times: wider pop, low variance, longer gens
const TRAINING_PRESETS = {
    fresh:  { N: 500,  simSpeed: 2,  seconds: 15, mutate: 0.25, conservativeInit: 0.70 },
    grind:  { N: 600,  simSpeed: 20, seconds: 15, mutate: 0.18, conservativeInit: 0.50 },
    polish: { N: 800,  simSpeed: 2,  seconds: 25, mutate: 0.05, conservativeInit: 0.30 }
};

function applyTrainingPreset(name){
    const p = TRAINING_PRESETS[name];
    if (!p) return;
    // Drive the same code paths the sliders use so every downstream
    // consumer (worker, graphProgress, etc.) sees the change exactly as
    // if the user had dragged them.
    setN(p.N);
    setSeconds(p.seconds);
    setMutateValue(p.mutate);
    setSimSpeed(p.simSpeed);
    if (typeof p.conservativeInit === 'number' && typeof setConservativeInit === 'function') {
        setConservativeInit(p.conservativeInit);
    }
    // Reflect values in the DOM so the user can see what changed.
    const bs = document.getElementById('batchSizeInput');
    if (bs){ bs.value = p.N; document.getElementById('batchSizeOutput').value = 'Batch Size: ' + p.N; }
    const se = document.getElementById('secondsInput');
    if (se){ se.value = p.seconds; document.getElementById('secondsOutput').value = 'Round Length: ' + p.seconds; }
    const mv = document.getElementById('mutateValueInput');
    if (mv){ mv.value = p.mutate; document.getElementById('mutateValueOutput').value = 'Variance: ' + p.mutate; }
    const ci = document.getElementById('conservativeInitInput');
    if (ci && typeof p.conservativeInit === 'number'){
        ci.value = p.conservativeInit;
        const co = document.getElementById('conservativeInitOutput');
        if (co) co.value = 'Conservative Init: ' + p.conservativeInit;
    }
    const ss = document.getElementById('simSpeedInput');
    if (ss){ ss.value = String(p.simSpeed); }
}

function setSimSpeed(value){
    const n = Number(value);
    simSpeed = (Number.isFinite(n) && n > 0) ? n : 1;
    _simStepAccum = 0;
    _lastTickWall = performance.now();
    // Forward to the sim worker so its AI-car accumulator tracks the same
    // multiplier. Guarded because buttonResponse.js loads before main.js
    // in the script order — simWorker may not exist during phase-3 boot.
    if (typeof simWorker !== 'undefined' && simWorker){
        simWorker.postMessage({ type: 'setSimSpeed', v: simSpeed });
    }
}

function restartBatch(){
    begin();
}
function setMaxSpeed(value){
    maxSpeed = value;
    begin();
}
function makeInvincible(){
    playerCar.invincible = !playerCar.invincible;
    playerCar2.invincible = !playerCar2.invincible;
    invincible = playerCar.invincible;
    document.getElementById('hide').innerText = playerCar.invincible?"Invincible Off":"Invincible On";
}
function setTraction(value){
    traction = value;
    begin();
}

// Rasterize the finalized track at 224×224 and hand it to the CNN embedder,
// then publish the resulting 512-d vector on window.currentTrackVec. main.js
// reads this global on every begin()/nextBatch() to drive bridge seeding +
// archival (see P4.C wiring). Safe to call when the bridge isn't ready or
// the embed throws — we just fall through to the stock (rv-less) path.
//
// Note: we redraw the track paths directly at the target resolution rather
// than downscaling the 3200×1800 game canvas. A 14× downscale with default
// bilinear filtering collapses 2-px strokes into ~0.14-px intensity, making
// the input effectively all-black and the embedding invariant to track
// shape. Re-rasterising with thick strokes preserves the geometry that the
// CNN needs in order to produce meaningfully different vectors per track.
function embedCurrentTrack(){
    try {
        const bridge = window.__rvBridge;
        if (!bridge || typeof bridge.info !== 'function' || !bridge.info().ready){
            return;
        }
        if (typeof road === 'undefined' || !road || !road.roadEditor) return;
        const src = document.getElementById('myCanvas');
        if (!src || !src.width || !src.height) return;

        const W = 224, H = 224;
        const tmp = document.createElement('canvas');
        tmp.width = W; tmp.height = H;
        const tctx = tmp.getContext('2d');
        tctx.fillStyle = '#000';
        tctx.fillRect(0, 0, W, H);

        const sx = W / src.width;
        const sy = H / src.height;
        const re = road.roadEditor;

        // Inner + outer track boundaries as two closed white loops.
        tctx.strokeStyle = '#ffffff';
        tctx.lineWidth = 3;
        drawPolyline(tctx, re.points, sx, sy, true);
        drawPolyline(tctx, re.points2, sx, sy, true);

        // Checkpoints in green so the embedder can key on their distribution
        // (count, spacing, orientation) distinctly from the track outline.
        tctx.strokeStyle = '#00ff00';
        tctx.lineWidth = 2;
        if (re.checkPointListEditor){
            for (const cp of re.checkPointListEditor){
                if (!cp || !cp[0] || !cp[1]) continue;
                tctx.beginPath();
                tctx.moveTo(cp[0].x * sx, cp[0].y * sy);
                tctx.lineTo(cp[1].x * sx, cp[1].y * sy);
                tctx.stroke();
            }
        }

        const rgba = tctx.getImageData(0, 0, W, H).data;
        const rgb = new Uint8Array(W * H * 3);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3){
            rgb[j]     = rgba[i];
            rgb[j + 1] = rgba[i + 1];
            rgb[j + 2] = rgba[i + 2];
        }
        const vec = bridge.embedTrack(rgb, W, H);
        window.currentTrackVec = vec;
        const head = Array.from(vec.slice(0, 4)).map(n => n.toFixed(3)).join(', ');
        console.log(`[ruvector] track embedded — dim=${vec.length}, head=[${head}, ...]`);
    } catch (e){
        console.warn('[ruvector] embedCurrentTrack failed', e);
        window.currentTrackVec = null;
    }
}

function drawPolyline(ctx, pts, sx, sy, close){
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x * sx, pts[0].y * sy);
    for (let i = 1; i < pts.length; i++){
        ctx.lineTo(pts[i].x * sx, pts[i].y * sy);
    }
    if (close) ctx.closePath();
    ctx.stroke();
}