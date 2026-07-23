const canvas=document.getElementById("myCanvas");
const ctx = canvas.getContext("2d");
canvas.width = 3200;
canvas.height = 1800;

// Fallback matches the Rectangle preset — Road/roadEditor take startInfo by
// reference, so computeStartInfoInPlace() below mutates it to the actual
// first-checkpoint midpoint once track geometry is known.
const startInfo = {x: canvas.width - canvas.width/10, y: canvas.height/2, startWidth: canvas.width/40, heading: 0};
const road=new Road(startInfo);

// Track-relative spawn: midpoint of checkpoint[0], heading toward
// checkpoint[1]'s midpoint. Falls back to the original world-coord anchor
// when no checkpoints are loaded yet (shouldn't happen past getTrack() but
// the guard keeps first-render robust).
function computeStartInfoInPlace(cpList){
    if (!cpList || !cpList.length || !cpList[0] || cpList[0].length < 2) return startInfo;
    const g0 = cpList[0];
    const mx = (g0[0].x + g0[1].x) / 2;
    const my = (g0[0].y + g0[1].y) / 2;
    let hx, hy;
    if (cpList.length >= 2 && cpList[1] && cpList[1].length >= 2){
        const g1 = cpList[1];
        hx = (g1[0].x + g1[1].x) / 2 - mx;
        hy = (g1[0].y + g1[1].y) / 2 - my;
    } else {
        // Single-checkpoint fallback: perpendicular to the gate, rotated 90° CCW.
        hx = -(g0[1].y - g0[0].y);
        hy =  (g0[1].x - g0[0].x);
    }
    // Car motion convention (car.js:322-323): `this.x -= velocity.x` where
    // velocity = (sin(angle), cos(angle)) * speed — so the car moves in
    // direction (-sin, -cos), not (sin, cos). To face cp[1] we therefore need
    // atan2(-hx, -hy), not atan2(hx, hy). The earlier code had the sign
    // inverted, which worked by accident for axis-aligned gates (polygon
    // overlap masked the bug) but drove cars away from cp[1] on diagonal
    // gates like the Oval's lower-right slant.
    const heading = Math.atan2(-hx, -hy);
    // Spawn just shy of cp[0] on the side opposite cp[1], so simple forward
    // driving crosses cp[0] in the first frame. Offset ≈ 20px is small enough
    // that the 30×50 car polygon already straddles cp[0] at spawn (leading
    // edge ~5px past the gate), yet large enough to keep the tip clear of
    // the gate endpoints that sit on the corridor walls.
    const len = Math.sqrt(hx*hx + hy*hy);
    const offset = Math.min(20, len * 0.05);
    startInfo.x = mx - (len > 0 ? hx / len * offset : 0);
    startInfo.y = my - (len > 0 ? hy / len * offset : 0);
    startInfo.heading = heading;
    return startInfo;
}

// Pick checkpoints from whichever snapshot is available: road.checkPointList
// after getTrack() has run, otherwise the roadEditor's live editor array
// (populated from localStorage at page load).
function currentCheckpointList(){
    if (road.checkPointList && road.checkPointList.length) return road.checkPointList;
    const ed = road.roadEditor && road.roadEditor.checkPointListEditor;
    return (ed && ed.length) ? ed : null;
}

computeStartInfoInPlace(currentCheckpointList());

// Pose jitter config — OFF by default. Empirically, uniform-disk jitter
// around the canonical spawn regresses narrow-apex tracks (Triangle loses
// ~40% survival at radius=40) while helping wider corridors. The code path
// stays in place as an opt-in for users whose tracks have room for it:
//   window.__poseJitter = { radiusPx: 40, angleDeg: 15, maxAttempts: 8 }
// Applied to AI cars only (not elite at i=0, not player cars).
window.__poseJitter = window.__poseJitter || { radiusPx: 0, angleDeg: 0, maxAttempts: 8 };

// Default training knobs — tuned for visible ruvector warm-start + higher
// early survival (not micro-bench cold starts). Presets (Fresh/Grind/Polish)
// still override these when clicked.
//   N=500     — enough lottery tickets for gen-0 survivors without thrashing
//   20s gens  — less noisy fitness for archive quality
//   mutate 0.22 — explore without shredding a decent elite every gen
//   consInit 0.65 — bias random brains toward "ease off near walls"
var batchSize = 500;
var nextSeconds = 20;
var seconds = 20;
var mutateValue = 0.22;
// P2.C Conservative Init: biases gen-0 random brains toward
// "reverse when a ray reads short" (close wall). 0 = pure random (no-op,
// bit-identical to pre-P2.C baseline). 1 = maximum bias. Persisted to
// localStorage via setConservativeInit(). Only applied on cold-random-init
// paths (fillRandom callers); ruvector-seeded brains are left untouched.
var conservativeInit = 0.65;
var playerCar;
var playerCar2;
// AI population lives entirely inside sim-worker.js. bestCar on main is a
// proxy object updated from snapshot messages — it mirrors just enough of the
// worker's real bestCar (position, angle, sensor state, controls, lap data)
// for rendering, perf HUD, and the save()/archive paths in buttonResponse.js.
var bestCar = null;
var bestBrainFlat = null;          // Float32Array(FLAT_LENGTH) — updated on genEnd
var _cachedBestBrainObj = null;    // inflated lazily via __rvUnflatten
var _cachedBestBrainSeq = 0;       // bumped whenever bestBrainFlat replaced
var latestSnapshot = null;
var invincible=false;
var traction=0.5;

var frameCount = 0;                // mirrors worker's frameCount via snapshots

// === Phase A — track-aware fast lap =====================================
// Three pieces of state, all globals because main.js is a classic script
// and other classic-script files (buttonResponse.js, brainExport.js) read
// `fastLap` directly. We KEEP `fastLap` as a global cache of the *current
// track's* best lap so existing callers continue to work; we just resync
// it whenever the active track changes (see _syncFastLapForCurrentTrack).
//
// Storage shape: localStorage.vv_fastlap_<trackHash> = JSON of
// { timeS, recordedAt, generation }. trackHash is xxHash32 of the 512-d
// CNN track embedding (window.currentTrackVec) — same Phase 0 hash util
// that content-addresses brains; Phase A re-uses it under the alias
// hashVec for naming honesty.
//
// `lastLap` is in-memory only: it tracks the most recent *completed* lap
// in this session, regardless of whether it was a record. Persisting
// "last" would conflate it with "fastest"; the value of last-lap is
// real-time signal during a run, not historical.
//
// `allTimeBest` is a derived cache: min over every vv_fastlap_* entry.
// Recomputed on track change and on new-record. Cheap (small N).
var fastLap = '--';
var lastLap = null;
var allTimeBest = null;
const FASTLAP_PREFIX = 'vv_fastlap_';

// Async-load the hash util once. main.js is a classic script; archive/hash.js
// is an ES module — dynamic import() bridges them. Until it resolves,
// _trackHash() returns null and the fast-lap logic falls back to '--' (no
// regression vs. pre-Phase-A: the legacy global was '--' on first load too).
let __hashVec = null;
import('./archive/hash.js').then((m) => { __hashVec = m.hashVec || m.hashBrain; })
    .catch((e) => { console.warn('[fastlap] hash util load failed', e); });

// Track-hash cache so we don't re-xxHash the 512-dim vec on every render.
let __trackHashCache = { vec: null, hash: null };
function _trackHash() {
    const v = window.currentTrackVec;
    if (!v || !v.length || !__hashVec) return null;
    if (__trackHashCache.vec === v) return __trackHashCache.hash;
    try {
        const h = __hashVec(v);
        __trackHashCache = { vec: v, hash: h };
        return h;
    } catch (e) {
        console.warn('[fastlap] hash failed', e);
        return null;
    }
}
function _trackKey() {
    const h = _trackHash();
    return h ? (FASTLAP_PREFIX + h) : null;
}
function _readFastLapForCurrentTrack() {
    const key = _trackKey();
    if (!key) return '--';
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return '--';
        const obj = JSON.parse(raw);
        return (typeof obj.timeS === 'number') ? obj.timeS : '--';
    } catch (_) { return '--'; }
}
function _writeFastLapForCurrentTrack(timeS, generation) {
    const key = _trackKey();
    if (!key) return false;
    try {
        localStorage.setItem(key, JSON.stringify({
            timeS: timeS,
            recordedAt: new Date().toISOString(),
            generation: (generation | 0),
        }));
        return true;
    } catch (e) {
        console.warn('[fastlap] write failed', e);
        return false;
    }
}
function _computeAllTimeBest() {
    let best = Infinity;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || k.indexOf(FASTLAP_PREFIX) !== 0) continue;
            try {
                const obj = JSON.parse(localStorage.getItem(k));
                if (obj && typeof obj.timeS === 'number' && obj.timeS < best) best = obj.timeS;
            } catch (_) {}
        }
    } catch (_) {}
    return Number.isFinite(best) ? best : null;
}
// Re-sync the global cache from localStorage. Called on boot (after the
// hash util loads), on track change, on reset, and after a new-record write.
function _syncFastLapForCurrentTrack() {
    fastLap = _readFastLapForCurrentTrack();
    allTimeBest = _computeAllTimeBest();
}
// Exposed on window so buttonResponse.js (classic script, separate file)
// can call them without a module bridge. Kept namespaced under __vvFastLap
// so we don't pollute the global namespace beyond `fastLap` itself.
window.__vvFastLap = {
    syncFromStore: _syncFastLapForCurrentTrack,
    write: _writeFastLapForCurrentTrack,
    read: _readFastLapForCurrentTrack,
    trackKey: _trackKey,
    allTimeBest: _computeAllTimeBest,
    setLastLap: function (t) { lastLap = (typeof t === 'number') ? t : null; },
    getLastLap: function () { return lastLap; },
    prefix: FASTLAP_PREFIX,
};

// Legacy retirement: silently drop the pre-Phase-A track-confused
// localStorage.fastLap key. The old value was attributed to no specific
// track, so migrating it would be misleading; clean cut is honest.
try { localStorage.removeItem('fastLap'); } catch (_) {}

// Polling boot-sync: when the hash util eventually loads AND
// currentTrackVec eventually becomes available, sync the cache so the
// timer renders the right number on the very first paint that has both.
// Bounded retries; gives up silently if neither materializes (display
// stays '--' which is the correct "no record on this track yet" state).
(function _bootSyncFastLap() {
    let tries = 0;
    const id = setInterval(() => {
        if (__hashVec && window.currentTrackVec) {
            _syncFastLapForCurrentTrack();
            clearInterval(id);
        } else if (++tries > 60) {
            clearInterval(id);
        }
    }, 250);
})();
// =========================================================================

// Sim-speed multiplier. Worker owns the AI-car accumulator; main owns a
// parallel accumulator for the 2 player cars only. They drift slightly under
// load, but the UX impact is nil — AI training is what the user watches at
// 100×; player cars are only driven during phase-3 physics tuning at 1×.
// Default 2×: last "honest" speed before sensor stride > 1 (cleaner fitness
// for the archive + still visibly faster than realtime).
var simSpeed = 2;
var _simStepAccum = 0;             // retained name so setSimSpeed stays stable
var _lastTickWall = performance.now();

var wallStart = performance.now();

var acceleration = .05;
var breakAccel = .05;
let pause=true;
var phase = 0; //0 welcome, 1 track, 2 checkpoints, 3 physics, 4 training
var maxSpeed = 15;
// Default entry flow: land straight on phase 4 (training) with a preloaded
// rectangle track. The sim stays paused until the user hits Start — no
// auto-run on page load. The old draw-a-track-from-scratch flow is still one
// click away via "Customize Track" (buttonResponse.js) and can also be forced
// with `?edit=1` on the URL for dev use.
//
// __awaitingStart — session gate: every fresh page load waits for an explicit
//   Start / Demo click before the worker steps. Cleared by pauseGame().
//   Inline script in index.html sets this true for first paint; do NOT force
//   it back to true here if an early Start click already cleared the gate
//   while the rest of main.js was still evaluating.
// __firstStart — first-ever visitor (no trainCount yet); drives CTA copy and
//   the stronger amber Start button styling.
if (window.__awaitingStart !== false) {
    window.__awaitingStart = true;
}
window.__firstStart = !localStorage.getItem('trainCount');
if (new URLSearchParams(location.search).get('edit') === '1') {
    nextPhase(); // → phase 1 (track draw)
} else {
    // Replicate the state transitions that phases 1-3 produce when the user
    // walks through them: lock the editor, persist defaults, populate road
    // borders + checkpoints from the editor points, embed the track vector.
    road.roadEditor.checkPointModeChange(false);
    road.roadEditor.editModeChange(false);
    saveTrack();
    submitTrack();
    try { embedCurrentTrack(); } catch (_) {}
    // Open the SONA trajectory for the auto-boot path too — mirrors the
    // explicit-start path in buttonResponse.js:176. Without this, addPhase4Step
    // no-ops because sona/engine.js gates on `_traj` being set, and trajectory
    // recording never happens for visitors who land directly in phase 4.
    try {
        if (!window.rvDisabled && window.__rvBridge && window.__rvBridge.beginPhase4Trajectory){
            window.__rvBridge.beginPhase4Trajectory(window.currentTrackVec || null);
        }
    } catch (e) { console.warn('[sona] beginTrajectory on auto-boot failed', e); }
    phase = 3;
    nextPhase(); // → phase 4 (training)
}
if (localStorage.getItem("traction")){
    traction=JSON.parse(localStorage.getItem("traction"));
}
if (localStorage.getItem("maxSpeed")){
    maxSpeed=JSON.parse(localStorage.getItem("maxSpeed"));
}
// Phase A: legacy `fastLap` localStorage key retired in the boot block
// above; per-track values now live under vv_fastlap_<trackHash>. The
// initial hydration from those keys happens in _bootSyncFastLap() once
// both the hash util and currentTrackVec are available.
if (localStorage.getItem("conservativeInit")){
    const v = parseFloat(localStorage.getItem("conservativeInit"));
    if (Number.isFinite(v)) conservativeInit = Math.max(0, Math.min(1, v));
}
// Vector-memory integration (P4.C). `?rv=0` disables the bridge entirely;
// `currentSeedIds` carries the retrieval set across begin()→nextBatch() so
// archiveBrain can record parent lineage and observe() can credit the seeds.
var rvDisabled = new URLSearchParams(location.search).get('rv') === '0';
var currentSeedIds = [];
var generation = 0;

// Perf overlay — always on, disable with `?perf=0`. Reported ~6 Hz so the
// DOM write doesn't contaminate the draw bucket it's trying to measure.
// Buckets:
//   frameDelta — time BETWEEN successive rAF fires. This is the *real* FPS
//     source: the browser caps rAF at the monitor refresh, so callback
//     duration alone would report fake FPS > 60.
//   sim        — worker's reported per-step sim time (AI cars only).
//   draw       — road + cars render on main.
//   rAF        — total main-thread callback duration; with the worker
//                refactor this should stay tiny regardless of N.
//   steps      — physics steps the worker ran since the last snapshot.
var perfEnabled = new URLSearchParams(location.search).get('perf') !== '0';
var perfBuf = { frameDelta: [], sim: [], draw: [], rAF: [], steps: [] };
var _lastRafWall = 0;
var perfBufCap = 60;
var perfTick = 0;
var perfHud = null;

// Hitch detector. Fires when the wall-time gap between expected events
// (snapshot arrival, rAF fire) exceeds HITCH_MS. This is the primary tool
// for diagnosing the periodic "freeze every few seconds" — averages in the
// perf buffer smooth over spikes and hide them. Hitches are kept in a
// small ring and rendered in the HUD + logged to console. Disable with
// `?hitch=0`.
var hitchEnabled = new URLSearchParams(location.search).get('hitch') !== '0';
var HITCH_MS = 80;
var hitches = [];
var HITCH_MAX = 6;
var _lastSnapWall = 0;
function recordHitch(kind, ms, extra){
    if (!hitchEnabled) return;
    var entry = { t: performance.now(), kind: kind, ms: ms, extra: extra || '' };
    hitches.push(entry);
    if (hitches.length > HITCH_MAX) hitches.shift();
    try { console.warn('[hitch]', kind, ms.toFixed(1) + 'ms', extra || ''); } catch(_){}
}
function perfPush(key, v){
    var arr = perfBuf[key];
    arr.push(v);
    if (arr.length > perfBufCap) arr.shift();
}
function perfAvg(arr){
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}
function perfEnsureHud(){
    if (perfHud) return perfHud;
    perfHud = document.createElement('div');
    perfHud.id = 'perf-hud';
    perfHud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99998;' +
        'background:rgba(12,14,18,.88);color:#a8e6a0;padding:8px 10px;' +
        'border-radius:4px;font:11px/1.35 ui-monospace,Menlo,monospace;' +
        'pointer-events:none;min-width:170px;';
    perfHud.addEventListener('click', function(){ perfHud.classList.toggle('expanded'); });
    document.body.appendChild(perfHud);
    return perfHud;
}
var RENDER_TOP_K = (function(){
    var p = new URLSearchParams(location.search).get('topK');
    var n = p ? parseInt(p, 10) : 32;
    return (isFinite(n) && n >= 0) ? n : 32;
})();
var FULL_RENDER = new URLSearchParams(location.search).get('fullRender') === '1';

// Step cap mirrors worker's MAX_STEPS — applied here only to the main-thread
// player-car accumulator so a frozen tab coming back doesn't stampede 2
// player cars through a thousand backlogged physics steps.
var MAX_STEPS_PER_RAF = 60;

// Player-car sensor stride. AI-car stride lives inside the worker.
var SENSOR_STRIDE = 1;
function computeSensorStride(){
    if (simSpeed <= 2) return 1;
    if (simSpeed <= 5) return 2;
    if (simSpeed <= 20) return 3;
    return 4;
}

function perfRender(){
    if (!perfEnabled) return;
    var hud = perfEnsureHud();
    var frameDelta = perfAvg(perfBuf.frameDelta);
    var sim = perfAvg(perfBuf.sim);
    var draw = perfAvg(perfBuf.draw);
    var work = perfAvg(perfBuf.rAF);
    var steps = perfAvg(perfBuf.steps);
    var fps = frameDelta > 0 ? (1000 / frameDelta).toFixed(1) : '--';
    var nCars = latestSnapshot ? latestSnapshot.N : 0;
    var fpsColor = '#a8e6a0';
    if (frameDelta > 0){
        var fpsNum = 1000 / frameDelta;
        if (fpsNum < 30) fpsColor = '#f07070';
        else if (fpsNum < 55) fpsColor = '#f0c060';
    }
    // Hitches block is wrapped in .perf-hitches — collapsed by default via
    // CSS, click anywhere on #perf-hud to toggle the .expanded class.
    var hitchHtml = '';
    if (hitchEnabled){
        var nowT = performance.now();
        var hitchLines = '';
        for (var i = hitches.length - 1; i >= 0; i--){
            var h = hitches[i];
            var ago = ((nowT - h.t) / 1000).toFixed(1);
            var col = h.ms > 300 ? '#f07070' : '#f0c060';
            hitchLines += '<div style="color:' + col + ';opacity:.9;">' +
                h.ms.toFixed(0) + 'ms ' + h.kind +
                (h.extra ? ' <span style="opacity:.7;">' + h.extra + '</span>' : '') +
                ' <span style="opacity:.55;">-' + ago + 's</span></div>';
        }
        var count = hitches.length;
        hitchHtml =
            '<div class="perf-hitches-header" style="margin-top:6px;border-top:1px solid #334;padding-top:4px;color:#f0c060;font-size:.95em;">' +
                'hitches (' + count + ') <span style="opacity:.6;font-size:.85em;">click to toggle</span>' +
            '</div>' +
            '<div class="perf-hitches">' + hitchLines + '</div>';
    }
    hud.innerHTML =
        '<div style="color:#fff;margin-bottom:3px;"><b>perf</b></div>' +
        '<div style="font-size:1.4em;line-height:1.1;color:' + fpsColor + ';">' + fps + ' <span style="font-size:.6em;opacity:.7;">fps</span></div>' +
        '<div style="margin-top:4px;opacity:.85;">N=' + nCars + '</div>' +
        '<div style="margin-top:3px;">sim   ' + sim.toFixed(2) + ' ms <span style="opacity:.55;font-size:.85em">(worker)</span></div>' +
        '<div>draw  ' + draw.toFixed(2) + ' ms</div>' +
        '<div>main  ' + work.toFixed(2) + ' ms</div>' +
        '<div>steps ' + steps.toFixed(1) + '/snap</div>' +
        hitchHtml;
}

function bridgeReady(){
    if (rvDisabled) return false;
    var b = window.__rvBridge;
    return !!(b && b.info && b.info().ready && window.__rvUnflatten);
}

// Phase 1A (F3) — staged warm-restart import. The UI file picker in
// uiPanels.js runs its own import directly, but we also support a "load on
// boot" path: if `?snapshots=1` is present AND `window.__pendingSnapshotImport`
// is set (by a tour step, a test harness, or an earlier UI click that
// deferred the import), we replay that snapshot before the sim starts. Any
// errors are logged + non-fatal — the app still boots.
async function __runStagedSnapshotImport(){
    try {
        var usp = new URLSearchParams(window.location.search || '');
        if (usp.get('snapshots') !== '1') return;
    } catch (_) { return; }
    var staged = window.__pendingSnapshotImport;
    if (!staged) return;
    var b = window.__rvBridge;
    if (!b || typeof b.ready !== 'function' || typeof b.importSnapshot !== 'function') return;
    try {
        await b.ready();
        var res = b.importSnapshot(staged);
        var c = (res && res.counts) || null;
        console.log('[ruvector] staged snapshot import complete', c);
    } catch (e) {
        console.warn('[ruvector] staged snapshot import failed', e);
    } finally {
        try { delete window.__pendingSnapshotImport; } catch (_) { window.__pendingSnapshotImport = null; }
    }
}
// Fire-and-forget: the import runs in parallel with the normal boot. Sim
// start doesn't depend on this promise — workers seed from the archive
// lazily, so even if import lands after begin() the next generation will
// still pick up the imported brains.
if (typeof window !== 'undefined') {
    __runStagedSnapshotImport();
}

// Phase 1C (F4) — honour `?consistency=fresh|eventual|frozen` at boot.
// Default is `fresh` (today's behaviour), so the flag is opt-in. The
// URL flag is also how the A/B harness pins a known mode across a
// page reload. Invalid values are ignored with a warn; the bridge
// stays on `fresh`. Mirrors the `?hhnsw=1` / `?snapshots=1` pattern.
async function __applyUrlConsistencyFlag(){
    let m = null;
    try {
        var usp = new URLSearchParams(window.location.search || '');
        m = usp.get('consistency');
    } catch (_) { return; }
    if (!m) return;
    const valid = ['fresh', 'eventual', 'frozen'];
    if (!valid.includes(m)) {
        console.warn('[ruvector] ignoring invalid ?consistency=' + m);
        return;
    }
    // The sidecar module that assigns window.__rvBridge loads
    // asynchronously; poll briefly so we don't race with it on slow
    // first loads. 20×100ms ≈ 2s ceiling matches existing patterns.
    var b = null;
    for (let i = 0; i < 20; i++) {
        b = window.__rvBridge;
        if (b && typeof b.ready === 'function' && typeof b.setConsistencyMode === 'function') break;
        await new Promise(res => setTimeout(res, 100));
    }
    if (!b || typeof b.ready !== 'function' || typeof b.setConsistencyMode !== 'function') {
        console.warn('[ruvector] URL flag ?consistency=' + m + ' — bridge never appeared');
        return;
    }
    try {
        await b.ready();
        b.setConsistencyMode(m);
        console.log('[ruvector] consistency mode set via URL flag: ' + m);
    } catch (e) {
        console.warn('[ruvector] setConsistencyMode from URL flag failed', e);
    }
}
if (typeof window !== 'undefined') {
    __applyUrlConsistencyFlag();
}

// Phase 2A (F2) — honour `?federation=1` at boot. Opt-in flag that
// flips the bridge to the fan-out + union + GNN-rerank retrieval path.
// Default off → recommendSeeds is byte-identical to the pre-2A single-
// index behaviour. Mirrors the `?consistency=` / `?hhnsw=1` poll-until-
// ready pattern so we don't race the sidecar loader on slow first loads.
async function __applyUrlFederationFlag(){
    let on = false;
    try {
        var usp = new URLSearchParams(window.location.search || '');
        on = usp.get('federation') === '1';
    } catch (_) { return; }
    if (!on) return;
    var b = null;
    for (let i = 0; i < 20; i++) {
        b = window.__rvBridge;
        if (b && typeof b.ready === 'function' && typeof b.setFederationEnabled === 'function') break;
        await new Promise(res => setTimeout(res, 100));
    }
    if (!b || typeof b.ready !== 'function' || typeof b.setFederationEnabled !== 'function') {
        console.warn('[ruvector] URL flag ?federation=1 — bridge never appeared');
        return;
    }
    try {
        await b.ready();
        b.setFederationEnabled(true);
        console.log('[ruvector] federation mode enabled via URL flag');
    } catch (e) {
        console.warn('[ruvector] setFederationEnabled from URL flag failed', e);
    }
}
if (typeof window !== 'undefined') {
    __applyUrlFederationFlag();
}

// Phase 2B (F6) — honour `?crosstab=1` at boot. Opt-in flag that opens the
// BroadcastChannel('vectorvroom-archive') and wires archiveBrain's broadcast
// hook. Default off → no channel is opened and archiveBrain's hot path is
// one boolean check per insert. Mirrors the ?federation=1 poll-until-ready
// pattern because the bridge sidecar can finish loading slightly after the
// DOM is ready on slow first-loads.
async function __applyUrlCrosstabFlag(){
    let on = false;
    try {
        var usp = new URLSearchParams(window.location.search || '');
        on = usp.get('crosstab') === '1';
    } catch (_) { return; }
    if (!on) return;
    var b = null;
    for (let i = 0; i < 20; i++) {
        b = window.__rvBridge;
        if (b && typeof b.ready === 'function' && typeof b.setCrosstabEnabled === 'function') break;
        await new Promise(res => setTimeout(res, 100));
    }
    if (!b || typeof b.ready !== 'function' || typeof b.setCrosstabEnabled !== 'function') {
        console.warn('[ruvector] URL flag ?crosstab=1 — bridge never appeared');
        return;
    }
    try {
        await b.ready();
        b.setCrosstabEnabled(true);
        console.log('[ruvector] cross-tab live training enabled via URL flag');
    } catch (e) {
        console.warn('[ruvector] setCrosstabEnabled from URL flag failed', e);
    }
}
if (typeof window !== 'undefined') {
    __applyUrlCrosstabFlag();
}

// Phase 3C — honour `?archive=<url>` at boot. Opt-in flag that auto-fetches
// a remote .vvarchive bundle and runs it through bridge.importSnapshot. We
// gate on BOTH `?snapshots=1` AND `?archive=<url>` so the default
// experience is unchanged unless the user explicitly opts into Phase 1A
// first. Errors are logged + non-fatal — the app still boots on a bad URL.
async function __applyUrlArchiveFlag(){
    let url = null;
    try {
        var usp = new URLSearchParams(window.location.search || '');
        if (usp.get('snapshots') !== '1') return;
        url = usp.get('archive');
    } catch (_) { return; }
    if (!url) return;
    var b = null;
    for (let i = 0; i < 20; i++) {
        b = window.__rvBridge;
        if (b && typeof b.ready === 'function' && typeof b.importSnapshot === 'function') break;
        await new Promise(res => setTimeout(res, 100));
    }
    if (!b || typeof b.ready !== 'function' || typeof b.importSnapshot !== 'function') {
        console.warn('[ruvector] URL flag ?archive — bridge never appeared');
        return;
    }
    try {
        await b.ready();
        const { fetchArchive } = await import('./share/url.js');
        const { snapshot } = await fetchArchive(url);
        const res = b.importSnapshot(snapshot);
        const c = (res && res.counts) || { brains: 0, tracks: 0, dynamics: 0, observations: 0 };
        console.log('[ruvector] ?archive import ok — brains ' + c.brains +
            ' · tracks ' + c.tracks + ' · dynamics ' + c.dynamics +
            ' · obs ' + c.observations);
    } catch (e) {
        console.warn('[ruvector] ?archive import failed: ' + (e.message || e));
    }
}
if (typeof window !== 'undefined') {
    __applyUrlArchiveFlag();
}

// -----------------------------------------------------------------------------
// Metrics HUD — per-generation survival %, median / p90 checkpoints, wall-bumps.
// Also serves as the on-screen data source for __runBenchmark / __abTest CSVs.
// -----------------------------------------------------------------------------
var metricsHud = null;
var metricsEnabled = true;
var __metricsLog = [];          // every genEnd appends one row (HUD ring + CSV source)
var __metricsLiveAlive = 0;     // updated per-tick from handleSnapshot
var __benchmarkCtx = null;      // set while __runBenchmark is active

function metricsEnsureHud(){
    if (metricsHud) return metricsHud;
    metricsHud = document.createElement('div');
    metricsHud.id = 'metrics-hud';
    // Centered at the top of the screen — out of the way of the left-column
    // pills (Explain / Guided tour / preset picker) and the right-column
    // training controls. `left:50%;transform:translateX(-50%)` centers the
    // box regardless of its width; `text-align:center` keeps the metric
    // lines centered within the box.
    metricsHud.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99998;' +
        'background:rgba(12,14,18,.88);color:#a8c8ff;padding:8px 10px;' +
        'border-radius:4px;font:11px/1.35 ui-monospace,Menlo,monospace;' +
        'pointer-events:none;min-width:180px;text-align:center;';
    document.body.appendChild(metricsHud);
    return metricsHud;
}

function __percentileI16(sortedArr, q){
    if (!sortedArr.length) return 0;
    const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * q));
    return sortedArr[idx];
}

function metricsComputeRow(m){
    const FPS = 60;
    const N = m.popN | 0;
    if (!N || !m.popCheckpoints) return null;
    const cpSorted = Int16Array.from(m.popCheckpoints).sort();
    const df = m.popDeathFrames;
    const survivedAt = (frameBudget) => {
        let alive = 0;
        for (let i = 0; i < N; i++){ if (df[i] === -1 || df[i] > frameBudget) alive++; }
        return alive / N;
    };
    // Death-cause breakdown (0=head-on, 1=side-scrape, 2=slide-out, 3=stalled,
    // 4=alive). Buckets are mutually exclusive; sum must equal N. Fallback to
    // zeros if an older worker build didn't send popDeathCauses.
    let dcHead = 0, dcSide = 0, dcSlide = 0, dcStalled = 0, dcAlive = 0;
    const dc = m.popDeathCauses;
    if (dc){
        for (let i = 0; i < N; i++){
            const b = dc[i] | 0;
            if (b === 0) dcHead++;
            else if (b === 1) dcSide++;
            else if (b === 2) dcSlide++;
            else if (b === 3) dcStalled++;
            else dcAlive++;
        }
    }
    return {
        gen: generation,
        popN: N,
        medCheckpoints: __percentileI16(cpSorted, 0.5),
        p90Checkpoints: __percentileI16(cpSorted, 0.9),
        maxCheckpoints: cpSorted[N - 1],
        wallBumps: m.popWallBumps | 0,
        stillAlive: m.popStillAlive | 0,
        dcHeadOn: dcHead,
        dcSide: dcSide,
        dcSlide: dcSlide,
        dcStalled: dcStalled,
        dcAlive: dcAlive,
        survival5s:  +survivedAt(5  * FPS).toFixed(4),
        survival10s: +survivedAt(10 * FPS).toFixed(4),
        survivalEnd: +(m.popStillAlive / N).toFixed(4),
        bestFitness: m.fitness,
        bestLaps: m.laps,
        bestLapMin: (m.lapTimes && m.lapTimes.length) ? Math.min.apply(null, m.lapTimes) : null,
        genSeconds: m.genSeconds
    };
}

function metricsRender(){
    if (!metricsEnabled) return;
    const hud = metricsEnsureHud();
    const last = __metricsLog[__metricsLog.length - 1];
    const liveN = latestSnapshot ? latestSnapshot.N : 0;
    const pct = (v) => (v * 100).toFixed(0) + '%';
    let body = '<div style="color:#fff;margin-bottom:3px;"><b>metrics</b></div>';
    body += '<div>alive ' + __metricsLiveAlive + ' / ' + liveN + '</div>';
    if (last){
        body += '<div style="margin-top:4px;opacity:.75;font-size:.9em;">gen ' + last.gen + ' · N=' + last.popN + '</div>';
        body += '<div>med cp  <b>' + last.medCheckpoints + '</b> · p90 <b>' + last.p90Checkpoints + '</b> · max <b>' + last.maxCheckpoints + '</b></div>';
        body += '<div>head-on <b>' + last.dcHeadOn + '</b> · side <b>' + last.dcSide +
                '</b> · slide <b>' + last.dcSlide + '</b> · stalled <b>' + last.dcStalled +
                '</b> · alive <b>' + last.dcAlive + '</b></div>';
        body += '<div>surv 5s <b>' + pct(last.survival5s) + '</b> · 10s <b>' + pct(last.survival10s) + '</b> · end <b>' + pct(last.survivalEnd) + '</b></div>';
    } else {
        body += '<div style="opacity:.6;">(awaiting first genEnd)</div>';
    }
    if (__benchmarkCtx){
        body += '<div style="margin-top:4px;color:#f0c060;">bench: ' + __benchmarkCtx.label +
                ' (' + __benchmarkCtx.done + '/' + __benchmarkCtx.target + ')</div>';
    }
    hud.innerHTML = body;
}

// -----------------------------------------------------------------------------
// Worker bootstrap + message plumbing
// -----------------------------------------------------------------------------
const simWorker = new Worker('sim-worker.js');
var workerReady = false;
var workerInited = false;
var pendingBegin = null;

simWorker.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type){
        case 'ready':
            workerReady = true;
            // Never auto-start a pending begin while the Start CTA is still
            // waiting — boot used to race performBegin here and freeze input.
            if (pendingBegin && !window.__awaitingStart){
                const pb = pendingBegin; pendingBegin = null; performBegin(pb.N);
            } else if (window.__awaitingStart){
                pendingBegin = null;
            }
            break;
        case 'snapshot':
            handleSnapshot(m);
            break;
        case 'genEnd':
            handleGenEnd(m);
            break;
        case 'debug':
            if (hitchEnabled && m.event === 'beginBuilt' && m.ms > 30){
                recordHitch('workerBegin', m.ms, 'N=' + m.N);
            }
            if (hitchEnabled && m.event === 'slowTick'){
                // Classify the slow tick so we can see at a glance which
                // bucket is the culprit: GC pause, one huge step, or post.
                const parts = [];
                if (m.gap  > 20) parts.push('gap=' + m.gap.toFixed(0));
                if (m.tick > 30) parts.push('tick=' + m.tick.toFixed(0));
                if (m.maxStep > 25) parts.push('maxStep=' + m.maxStep.toFixed(0));
                if (m.post > 5)   parts.push('post=' + m.post.toFixed(0));
                const totalMs = m.gap + m.tick;
                recordHitch('wkTick', totalMs, parts.join(' ') + ' st=' + m.steps);
            }
            break;
    }
};
simWorker.onerror = (err) => {
    console.error('[sim-worker] error', err.message || err, err.filename, err.lineno);
};

// bestCar identity epoch: the worker increments bestEpoch each time a new
// car is promoted. Main creates a fresh proxy object on every change so the
// dynamics embedder's identity-based reset (_owningCar !== car) fires
// correctly at generation boundaries.
var _bestProxyEpoch = -1;
function handleSnapshot(m){
    if (hitchEnabled){
        const now = performance.now();
        if (_lastSnapWall > 0){
            const gap = now - _lastSnapWall;
            if (gap > HITCH_MS) recordHitch('snapGap', gap);
        }
        _lastSnapWall = now;
    }
    latestSnapshot = m;
    frameCount = m.frameCount;
    // Live alive-count: position stride is 5 per car, field 3 is damaged 0|1.
    if (m.positions && m.N){
        let alive = 0;
        const N = m.N, pos = m.positions;
        for (let i = 0; i < N; i++){ if (!pos[i*5 + 3]) alive++; }
        __metricsLiveAlive = alive;
    }
    if (m.bestIdx >= 0){
        if (m.bestEpoch !== _bestProxyEpoch || !bestCar){
            bestCar = makeBestCarProxy();
            _bestProxyEpoch = m.bestEpoch;
        }
        updateBestCarProxy(bestCar, m);
        // Sample rate: ~60Hz regardless of simSpeed. Old code ran recordFrame
        // inside the per-step loop (so at simSpeed=100 × N=big, thousands of
        // calls/sec); now it's one per snapshot. The temporal embedder summary
        // stats don't need the extra resolution — spacing is uniform.
        if (window.__rvDynamics){
            try { window.__rvDynamics.recordFrame(bestCar); } catch (_) {}
        }
    }
}

function makeBestCarProxy(){
    const proxy = {
        x: 0, y: 0, angle: 0, damaged: false,
        speed: 0, maxSpeed: 0,
        checkPointsCount: 0, laps: 0, lapTimes: '--',
        controls: { forward: false, left: false, right: false, reverse: false },
        sensor: { rayCount: 7, rays: [], readings: [] },
        // Task 2.D brain-decision viz. Populated from the sim-worker snapshot's
        // bestInputs (10-float NN input vector) and bestOutputActivations
        // (4-float pre-threshold sum-minus-bias per output). Start as null so
        // inputVisual() can skip the bar panel on the very first frame before
        // a snapshot arrives.
        brainInputs: null,
        brainOutputActivations: null
    };
    // Lazy-inflated brain — save() and archiveBrain() both read bestCar.brain.
    // We key the cache on _cachedBestBrainSeq so a stale inflate survives only
    // until the next genEnd overwrites bestBrainFlat. Uses the inline
    // inflater rather than window.__rvUnflatten so save() keeps working even
    // when the ruvector sidecar failed to load (wasm 404, etc).
    Object.defineProperty(proxy, 'brain', {
        get(){
            if (!bestBrainFlat) return null;
            if (_cachedBestBrainObj && proxy.__brainSeq === _cachedBestBrainSeq){
                return _cachedBestBrainObj;
            }
            _cachedBestBrainObj = inflateBrainInline(bestBrainFlat);
            proxy.__brainSeq = _cachedBestBrainSeq;
            return _cachedBestBrainObj;
        },
        configurable: true
    });
    return proxy;
}

function updateBestCarProxy(p, m){
    const i = m.bestIdx;
    const pos = m.positions;
    p.x = pos[i*5];
    p.y = pos[i*5 + 1];
    p.angle = pos[i*5 + 2];
    p.damaged = !!m.bestDamaged;
    p.speed = m.bestSpeed;
    p.maxSpeed = m.bestMaxSpeed;
    p.checkPointsCount = m.bestCheckpoints;
    p.laps = m.bestLaps;
    p.lapTimes = (m.bestLapTimes && m.bestLapTimes.length) ? m.bestLapTimes : '--';
    p.controls.forward = !!(m.bestControls && m.bestControls[0]);
    p.controls.left    = !!(m.bestControls && m.bestControls[1]);
    p.controls.right   = !!(m.bestControls && m.bestControls[2]);
    p.controls.reverse = !!(m.bestControls && m.bestControls[3]);

    // Rebuild rays/readings in the shape sensor.draw() and dynamicsEmbedder
    // expect: rays = Array<[{x,y},{x,y}]>, readings = Array<null|{x,y,offset}>.
    const rays = [], readings = [];
    if (m.bestRays){
        const R = m.bestRays;
        const nRays = R.length / 4;
        for (let i = 0; i < nRays; i++){
            rays.push([
                {x: R[i*4],     y: R[i*4 + 1]},
                {x: R[i*4 + 2], y: R[i*4 + 3]}
            ]);
        }
    }
    if (m.bestReadings){
        const R = m.bestReadings;
        const nR = R.length / 3;
        for (let i = 0; i < nR; i++){
            const offset = R[i*3 + 2];
            if (offset < 0){
                readings.push(null);
            } else {
                readings.push({x: R[i*3], y: R[i*3 + 1], offset});
            }
        }
    }
    p.sensor.rays = rays;
    p.sensor.readings = readings;
    // Task 2.D: carry the NN input + pre-threshold output vectors over to the
    // proxy so inputVisual() can draw them. These arrays are transferred from
    // the worker — the message holds them briefly; we keep our own reference.
    p.brainInputs = m.bestInputs || null;
    p.brainOutputActivations = m.bestOutputActivations || null;
}

function handleGenEnd(m){
    bestBrainFlat = m.bestBrain;
    _cachedBestBrainSeq++;
    if (bestCar){
        bestCar.laps = m.laps;
        bestCar.lapTimes = m.lapTimes && m.lapTimes.length ? m.lapTimes : '--';
        bestCar.checkPointsCount = m.checkPointsCount;
    }
    try {
        if (window.DemoPresentation && typeof window.DemoPresentation.onGenEnd === 'function'){
            window.DemoPresentation.onGenEnd(m);
        }
    } catch (_) {}
    // Adaptive green gates (opt-in): nudge bottleneck CPs before the next
    // begin() so the worker reinits with the updated layout. Must run before
    // performNextBatch → begin.
    try {
        if (window.AdaptiveGates && typeof window.AdaptiveGates.onGenEnd === 'function'){
            window.AdaptiveGates.onGenEnd(m);
        }
    } catch (e) { console.warn('[adaptiveGates] hook failed', e); }
    // Always feed the crash-map HNSW when adaptive is off too, so the index
    // accumulates "similar crash problem" memories for later retrieval.
    try {
        if ((!window.AdaptiveGates || !window.AdaptiveGates.isEnabled || !window.AdaptiveGates.isEnabled()) &&
            !window.rvDisabled && window.__rvBridge &&
            typeof window.__rvBridge.encodeCrashMap === 'function' &&
            typeof window.__rvBridge.archiveCrashMap === 'function' &&
            m.popDeathXY && m.popN) {
            const vec = window.__rvBridge.encodeCrashMap(m.popDeathXY, m.popN);
            if (vec) {
                const cps = (road && road.checkPointList) ? road.checkPointList : null;
                let nDeaths = 0;
                for (let i = 0; i < m.popN; i++) {
                    if (Number.isFinite(m.popDeathXY[i * 2])) nDeaths++;
                }
                const geoSig = (window.AdaptiveGates && window.AdaptiveGates.geometrySignature)
                    ? window.AdaptiveGates.geometrySignature()
                    : null;
                window.__rvBridge.archiveCrashMap(vec, {
                    survival: m.popN ? (m.popStillAlive | 0) / m.popN : 0,
                    fitness: m.fitness || 0,
                    generation: generation | 0,
                    nDeaths: nDeaths,
                    nGates: cps ? cps.length : 0,
                    cps: cps,
                    geometrySig: geoSig,
                });
            }
        }
    } catch (e) { console.warn('[crash-map] passive archive failed', e); }
    // Feed one SONA trajectory step per generation — elite's last-tick hidden
    // activations as the embedding, generation fitness as the reward scalar.
    // Lazy-open the trajectory on the first genEnd after SONA becomes ready,
    // because the bridge loads async and the auto-boot call in the phase init
    // block above sometimes fires before sonaReady() returns true.
    try {
        const b = window.__rvBridge;
        if (!window.rvDisabled && b && b.info){
            const i = b.info();
            if (i.sona && i.sona.ready && !i.sona.trajectoryOpen && b.beginPhase4Trajectory){
                // Lazy-embed: currentTrackVec may be null if the module-load
                // call to embedCurrentTrack ran before the bridge's async init
                // finished. Retry here; beginTrajectory refuses null vecs.
                if (!window.currentTrackVec && typeof embedCurrentTrack === 'function'){
                    try { embedCurrentTrack(); } catch (_) {}
                }
                b.beginPhase4Trajectory(window.currentTrackVec || null);
            }
            if (b.addPhase4Step && m.bestHiddenActivations){
                b.addPhase4Step(m.bestHiddenActivations, null, m.fitness || 0);
            }
        }
    } catch (e) { console.warn('[sona] genEnd hook failed', e); }
    try {
        const row = metricsComputeRow(m);
        if (row){
            __metricsLog.push(row);
            if (__metricsLog.length > 5000) __metricsLog.shift();
            metricsRender();
            if (__benchmarkCtx && !__benchmarkCtx.done_flag){
                __benchmarkCtx.done += 1;
                const liveRv = __rvToggleSnapshot();
                liveRv.trackLabel = __benchmarkCtx.config.trackLabel;
                liveRv.cold = __benchmarkCtx.config.cold;
                __benchmarkCtx.rows.push(Object.assign({label: __benchmarkCtx.label}, liveRv, row));
                if (__benchmarkCtx.done >= __benchmarkCtx.target){
                    __benchmarkCtx.done_flag = true;
                    __benchmarkCtx.resolve(__benchmarkCtx.rows.slice());
                }
            }
        }
    } catch (e){ console.warn('[metrics] genEnd handler failed', e); }
    performNextBatch(m);
}

// -----------------------------------------------------------------------------
// Brain buffer builder — produces the N×FLAT_LENGTH Float32Array shipped to the worker.
// Applies ruvector seeding / localStorage fallback + mutation directly on flat
// weights (no intermediate NeuralNetwork objects for the bulk of the population).
// -----------------------------------------------------------------------------
const FLAT_LENGTH = 244;
// Mirror of brainCodec.BRAIN_SCHEMA_VERSION — duplicated because main.js is a
// classic script and can't import ES modules. Keep in sync with brainCodec.js.
// Used to gate the localStorage.bestBrain seeding path below; ruvector owns the
// actual schema migration (see migrateBrainSchemaIfNeeded in ruvectorBridge.js).
const BRAIN_SCHEMA_VERSION = 6;

function flattenBrainInline(brain){
    const out = new Float32Array(FLAT_LENGTH);
    let k = 0;
    for (let L = 0; L < brain.levels.length; L++){
        const level = brain.levels[L];
        for (let j = 0; j < level.biases.length;  j++) out[k++] = level.biases[j];
        for (let w = 0; w < level.weights.length; w++) out[k++] = level.weights[w];
    }
    return out;
}
// Mirror of brainCodec.unflatten — standalone so bestCar.brain keeps working
// when the ES-module sidecar fails to load.
function inflateBrainInline(flat){
    if (!flat) return null;
    const NN = globalThis.NeuralNetwork;
    if (!NN) return null;
    const net = new NN([10, 16, 4]);
    let k = 0;
    for (let L = 0; L < net.levels.length; L++){
        const level = net.levels[L];
        for (let j = 0; j < level.biases.length;  j++) level.biases[j]  = flat[k++];
        for (let w = 0; w < level.weights.length; w++) level.weights[w] = flat[k++];
    }
    return net;
}
function copyFlat(dst, dstOff, src){
    for (let i = 0; i < FLAT_LENGTH; i++) dst[dstOff + i] = src[i];
}
function fillMutated(dst, dstOff, src, amt){
    if (amt <= 0){ copyFlat(dst, dstOff, src); return; }
    for (let i = 0; i < FLAT_LENGTH; i++){
        dst[dstOff + i] = lerp(src[i], Math.random() * 2 - 1, amt);
    }
}
// fillRandom(dst, dstOff, applyConservativeBias?)
//
// `applyConservativeBias` is a cold-path opt-in. When truthy AND the global
// `conservativeInit` > 0, the generated weights are post-processed to bias
// gen-0 brains toward "reverse when any ray reads short (close wall)".
// When the flag is omitted/false, or conservativeInit === 0, the function
// produces bit-identical output to the pre-P2.C pure-random init — so the
// default path is a no-op (see buildBrainsBuffer: ruvector-seeded novel
// cars pass no flag, preserving pure-random semantics for the seeded mix).
//
// NN topology (car.js:42 → [10, 16, 4]) — flat layout (FLAT_LENGTH=244):
//   [  0.. 15] L1 biases (16)
//   [ 16..175] L1 weights, indexed weights[j*16 + i]
//              j = input (0..9), i = hidden (0..15)
//              j in [0..6] are the 7 rays (s.offset → 1-offset, so HIGH = close)
//              j=7 speed/maxSpeed, j=8 lf, j=9 lr (checkpoint-dir in car frame)
//   [176..179] L2 biases (4)
//   [180..243] L2 weights, indexed weights[j*4 + i]
//              j = hidden (0..15), i = output (0..3)
//              i=0 forward, i=1 left, i=2 right, i=3 reverse (car.js:158-161)
//
// Bias strategy: build a coherent input→hidden→output chain so "high ray"
// → "hidden activates" → "forward OFF, reverse ON":
//   L1 ray→hidden: w += +0.5 * c  (amplify close-wall signal into hidden)
//   L2 hidden→forward (i=0): w += -0.5 * c
//   L2 hidden→reverse (i=3): w += +0.5 * c
// All post-bias weights are clamped to [-1, 1] (network's init range).
function fillRandom(dst, dstOff, applyConservativeBias){
    for (let i = 0; i < FLAT_LENGTH; i++) dst[dstOff + i] = Math.random() * 2 - 1;
    // Fast path: omitted flag OR slider at 0 → no-op, bit-identical to
    // pre-P2.C. Must stay ordered BEFORE any bias math runs.
    if (!applyConservativeBias) return;
    const c = conservativeInit;
    if (!(c > 0)) return;
    const push = 0.5 * c;
    // L1 ray→hidden weights: input indices 0..6 (rays), hidden 0..15.
    // Slot in flat buffer: 16 (L1 biases) + j*16 + i.
    for (let j = 0; j < 7; j++){
        for (let i = 0; i < 16; i++){
            const k = dstOff + 16 + j * 16 + i;
            let v = dst[k] + push;
            if (v > 1) v = 1; else if (v < -1) v = -1;
            dst[k] = v;
        }
    }
    // L2 hidden→output weights: hidden j=0..15, output i=0 (forward) and i=3 (reverse).
    // Slot: 176 (through L1) + 4 (L2 biases) + j*4 + i = 180 + j*4 + i.
    for (let j = 0; j < 16; j++){
        const kF = dstOff + 180 + j * 4 + 0;
        let vF = dst[kF] - push;
        if (vF > 1) vF = 1; else if (vF < -1) vF = -1;
        dst[kF] = vF;
        const kR = dstOff + 180 + j * 4 + 3;
        let vR = dst[kR] + push;
        if (vR > 1) vR = 1; else if (vR < -1) vR = -1;
        dst[kR] = vR;
    }
}

function buildBrainsBuffer(N){
    const out = new Float32Array(N * FLAT_LENGTH);
    currentSeedIds = [];
    let seededFromBridge = false;
    // P3.F — per-generation seed-source tally. Every slot increments exactly
    // one bucket so the three sum to N. Handed to the bridge below for
    // exposure via bridge.info().seedSources → the Vector Memory panel.
    let srcArchive = 0, srcPrior = 0, srcRandom = 0;

    if (bridgeReady()){
        try {
            const bridge = window.__rvBridge;
            const trackVec = window.currentTrackVec || null;
            if (window.__rvDynamics && typeof bridge.setQueryDynamicsVec === 'function'){
                try {
                    const qDyn = window.__rvDynamics.queryVector();
                    bridge.setQueryDynamicsVec(qDyn);
                } catch (_) {}
            }
            const seeds = bridge.recommendSeeds(trackVec, 10);
            if (seeds && seeds.length > 0){
                currentSeedIds = seeds.map(s => s.id);
                const nElite = Math.min(1, N);
                const nNovel = Math.max(1, Math.floor(N * 0.1));
                const remaining = N - nElite - nNovel;
                const nLight = Math.max(0, Math.floor(remaining / 2));
                const nHeavy = Math.max(0, remaining - nLight);
                const lightAmt = mutateValue * 0.5;
                const heavyAmt = Math.min(1, mutateValue * 1.8);
                for (let i = 0; i < N; i++){
                    const off = i * FLAT_LENGTH;
                    if (i < nElite){
                        copyFlat(out, off, seeds[0].vector);
                        srcArchive++;
                    } else if (i < nElite + nLight){
                        fillMutated(out, off, seeds[(i - nElite) % seeds.length].vector, lightAmt);
                        srcArchive++;
                    } else if (i < nElite + nLight + nHeavy){
                        fillMutated(out, off, seeds[(i - nElite - nLight) % seeds.length].vector, heavyAmt);
                        srcArchive++;
                    } else {
                        fillRandom(out, off);
                        srcRandom++;
                    }
                }
                console.log('[ruvector] seeded ' + N + ' cars from ' + seeds.length +
                    ' retrievals (elite=' + nElite + ', light=' + nLight +
                    ', heavy=' + nHeavy + ', novel=' + nNovel + ')');
                seededFromBridge = true;
            }
        } catch (e) {
            console.warn('[ruvector] seeding failed — falling back to stock', e);
        }
    }

    if (!seededFromBridge){
        // Only trust localStorage.bestBrain when the persisted schema version
        // matches. On a version miss, the bridge's migrator has either
        // already cleared the key or is about to — either way, seeding from
        // a stale-semantics brain would inject wrong-era weights into a
        // fresh population, so fall through to random.
        const schemaOK = (typeof localStorage !== 'undefined') &&
            (localStorage.getItem('brainSchemaVersion') === String(BRAIN_SCHEMA_VERSION));
        if (schemaOK && localStorage.getItem("bestBrain")){
            const savedBrain = JSON.parse(localStorage.getItem("bestBrain"));
            const savedNN = reviveBrain(savedBrain);
            const savedFlat = flattenBrainInline(savedNN);
            for (let i = 0; i < N; i++){
                const off = i * FLAT_LENGTH;
                if (i === 0) copyFlat(out, off, savedFlat);
                else fillMutated(out, off, savedFlat, mutateValue);
                srcPrior++;
            }
        } else {
            // Cold-random init (no ruvector seed, no localStorage bestBrain).
            // This is the ONLY place P2.C Conservative Init is applied — the
            // third argument opts into the bias. Skipped inside the ruvector
            // path (novel-car fillRandom calls above) and skipped when a
            // saved bestBrain is seeding the population.
            fillRandom(out, 0, true);
            srcRandom++;
            for (let i = 1; i < N; i++){
                const off = i * FLAT_LENGTH;
                fillRandom(out, off, true);
                srcRandom++;
            }
        }
    }
    // P3.F — publish the tally to the bridge *after* every slot is assigned.
    // Sum must equal N (= srcArchive + srcPrior + srcRandom). We pass the
    // current generation so the UI can use it as a memo key.
    if (window.__rvBridge && typeof window.__rvBridge.setLastSeedSources === 'function'){
        try {
            window.__rvBridge.setLastSeedSources({
                archive_recall: srcArchive,
                localStorage_prior: srcPrior,
                random_init: srcRandom,
                generation: (typeof generation === 'number') ? generation : -1,
            });
        } catch (e) { /* non-fatal */ }
    }
    return out;
}

// -----------------------------------------------------------------------------
// begin() / nextBatch() — lifecycle
// -----------------------------------------------------------------------------
function begin(){
    seconds = nextSeconds;
    // Page-load gate: while awaiting an explicit Start click, do NOT build
    // the 500-car population or touch the worker. That work used to run on
    // boot and blocked the main thread / delayed a responsive Start CTA for
    // multiple seconds. pauseGame() clears __awaitingStart then calls begin()
    // again to actually engage the worker.
    if (window.__awaitingStart) {
        pause = true;
        computeStartInfoInPlace(currentCheckpointList());
        // Lightweight placeholders so phase-3 tooling still has objects if the
        // user hops into Customize Track before starting. AI swarm is deferred.
        try {
            playerCar = new Car(startInfo.x, startInfo.y, 30, 50, "KEYS", maxSpeed, startInfo.heading);
            playerCar2 = new Car(startInfo.x, startInfo.y, 30, 50, "WASD", maxSpeed, startInfo.heading);
        } catch (_) {}
        frameCount = 0;
        wallStart = performance.now();
        _simStepAccum = 1;
        _lastTickWall = performance.now();
        bestCar = null;
        _bestProxyEpoch = -1;
        latestSnapshot = null;
        pendingBegin = null;
        return;
    }
    pause = false;
    computeStartInfoInPlace(currentCheckpointList());
    playerCar = new Car(startInfo.x, startInfo.y, 30, 50, "KEYS", maxSpeed, startInfo.heading);
    playerCar2 = new Car(startInfo.x, startInfo.y, 30, 50, "WASD", maxSpeed, startInfo.heading);
    frameCount = 0;
    wallStart = performance.now();
    _simStepAccum = 1;
    _lastTickWall = performance.now();
    bestCar = null;
    _bestProxyEpoch = -1;
    latestSnapshot = null;

    if (phase !== 4) return;  // worker only engages during phase-4 training

    if (!workerReady){
        pendingBegin = { N: batchSize };
        return;
    }
    performBegin(batchSize);
}

function performBegin(N){
    if (!workerInited){
        // Copy borders + checkpoints to plain {x,y} objects so postMessage can
        // structured-clone them. The live Road objects contain references to
        // the road editor's mutable point array — transferring raw refs would
        // break structured clone if those ever grow non-plain properties.
        const borders = road.borders.map(b => [{x:b[0].x,y:b[0].y},{x:b[1].x,y:b[1].y}]);
        const checkPointList = (road.checkPointList || []).map(c => [{x:c[0].x,y:c[0].y},{x:c[1].x,y:c[1].y}]);
        simWorker.postMessage({
            type: 'init',
            canvasW: canvas.width,
            canvasH: canvas.height,
            borders, checkPointList
        });
        workerInited = true;
    }
    const brains = buildBrainsBuffer(N);
    // Keep worker speed aligned with main defaults. setSimSpeed() only posts
    // when the user moves the dropdown — without this, a default simSpeed≠1
    // never reaches the worker until the first manual change.
    try {
        simWorker.postMessage({ type: 'setSimSpeed', v: simSpeed });
    } catch (_) {}
    simWorker.postMessage({
        type: 'begin',
        N, seconds, maxSpeed, traction,
        startInfo: { x: startInfo.x, y: startInfo.y, heading: startInfo.heading || 0 },
        poseJitter: Object.assign({ radiusPx: 0, angleDeg: 0, maxAttempts: 8 }, window.__poseJitter || {}),
        brains
    }, [brains.buffer]);
    // Worker handleBegin always sets pause=false and starts the step loop.
    // Re-assert the intended pause state AFTER begin so a pre-start page
    // load keeps the swarm frozen until the user opts in.
    try {
        simWorker.postMessage({ type: 'setPause', pause: !!pause });
    } catch (_) {}
    // Co-start the A/B baseline worker so both canvases begin each generation
    // on the same wall-clock tick. Without this, B auto-restarts on its own
    // genEnd (no archive/observe/seed delay) and drifts ahead of A.
    if (typeof window.__abOnPerformBegin === 'function') window.__abOnPerformBegin(N);
}

// Invalidate cached worker state when the track changes (phase 1→4 cycle
// reuses road.borders but with different geometry). Also forwards to the
// A/B baseline worker when it's running — without this, B stays pinned to
// whatever track it first saw and its cars "drive through" the new walls.
function invalidateWorkerInit(){
    workerInited = false;
    if (typeof window.__abInvalidateInit === 'function') window.__abInvalidateInit();
}

// In-memory track switch for benchmarking — preserves SONA patterns and other
// window-level state that page reload would wipe. Caller is responsible for
// ensuring the preset exists in window.TRACK_PRESETS.
window.__switchTrackInMemory = function(name){
    if (typeof loadTrackPreset !== 'function') return false;
    if (!loadTrackPreset(name)) return false;
    // road.getTrack() appends to road.borders, so reset to the canvas-edge
    // quad before rebuilding (mirrors the initial state in road.js:18-22).
    road.innerList = [];
    road.outerList = [];
    road.checkPointList = [];
    const w = canvas.width, h = canvas.height;
    road.borders = [
        [{x:0,y:0},{x:0,y:h}],
        [{x:w,y:0},{x:w,y:h}],
        [{x:0,y:0},{x:w,y:0}],
        [{x:0,y:h},{x:w,y:h}]
    ];
    try { road.getTrack(); } catch (_) {}
    computeStartInfoInPlace(currentCheckpointList());
    invalidateWorkerInit();
    try {
        if (window.DemoPresentation && window.DemoPresentation.invalidateRoad){
            window.DemoPresentation.invalidateRoad();
        }
    } catch (_) {}
    // loadTrackPreset already calls AdaptiveGates.onTrackChange; call again
    // after getTrack() so baseline matches fully rebuilt checkpoints.
    try {
        if (window.AdaptiveGates && typeof window.AdaptiveGates.onTrackChange === 'function') {
            window.AdaptiveGates.onTrackChange();
        }
    } catch (_) {}
    // Re-embed track vector for the new track so SONA patterns key correctly.
    try { if (typeof embedCurrentTrack === 'function') embedCurrentTrack(); } catch (_) {}
    return true;
};

// Called from the Reset Brain button — user-initiated restart, no archive.
function nextBatch(){ begin(); }

// Called from the worker's genEnd message — full archive + observe + begin.
function performNextBatch(genData){
    const _genT0 = performance.now();
    const _times = {};
    if (localStorage.getItem("trainCount")){
        localStorage.setItem("trainCount", JSON.stringify(JSON.parse(localStorage.getItem("trainCount"))+1));
    } else {
        localStorage.setItem("trainCount", JSON.stringify(1));
    }
    const _tSave = performance.now();
    if (bestBrainFlat){
        try { save(); } catch (e) { console.warn('save failed', e); }
    }
    _times.save = performance.now() - _tSave;
    if (genData.laps > 0 && genData.lapTimes && genData.lapTimes.length){
        const minLap = Math.min.apply(null, genData.lapTimes);
        // Phase A: lastLap is "the most recent completed lap", not the
        // batch's fastest. Multi-lap batches still update lastLap to the
        // last entry for an honest "what just happened?" signal.
        const lastEntry = genData.lapTimes[genData.lapTimes.length - 1];
        if (typeof lastEntry === 'number' && Number.isFinite(lastEntry)) {
            lastLap = lastEntry;
        }
        if (fastLap === '--' || minLap < fastLap){
            // Per-track write. _writeFastLapForCurrentTrack is a no-op if
            // currentTrackVec/hash aren't ready yet; the in-memory
            // `fastLap` cache still updates so the UI reflects the new
            // record even if the persist is deferred to the next sync.
            fastLap = minLap;
            _writeFastLapForCurrentTrack(minLap, generation);
            allTimeBest = _computeAllTimeBest();
        }
    }

    const _tArchive = performance.now();
    if (bridgeReady() && bestBrainFlat){
        try {
            const fitness = genData.fitness;
            const trackVec = window.currentTrackVec || null;
            const batchFastest = (genData.laps > 0 && genData.lapTimes && genData.lapTimes.length)
                ? Math.min.apply(null, genData.lapTimes) : undefined;
            let dynamicsVec = null;
            if (window.__rvDynamics){
                try { dynamicsVec = window.__rvDynamics.finalizeVector(); } catch (_) {}
            }
            const brainObj = window.__rvUnflatten(bestBrainFlat);
            window.__rvBridge.archiveBrain(
                brainObj, fitness, trackVec, generation, currentSeedIds.slice(), batchFastest, dynamicsVec
            );
            if (!window.__rvSessionBestFitness || fitness > window.__rvSessionBestFitness){
                window.__rvSessionBestFitness = fitness;
            }
            if (window.__rvDynamics){
                try { window.__rvDynamics.reset(); } catch (_) {}
            }
            if (currentSeedIds.length){
                window.__rvBridge.observe(currentSeedIds, fitness);
            }
            console.log('[ruvector] gen=' + generation + ' archived best fitness=' + fitness +
                (currentSeedIds.length ? ' (observed ' + currentSeedIds.length + ' seeds)' : ''));
        } catch (e){
            console.warn('[ruvector] archive/observe failed', e);
        }
    }
    _times.archive = performance.now() - _tArchive;
    generation += 1;

    const _tGraph = performance.now();
    if (typeof graphProgress === 'function'){
        try { graphProgress(); } catch (e) {}
    }
    _times.graph = performance.now() - _tGraph;

    const _tBegin = performance.now();
    begin();
    _times.begin = performance.now() - _tBegin;

    const totalMs = performance.now() - _genT0;
    if (hitchEnabled && totalMs > 30){
        const extra = 'save=' + _times.save.toFixed(0) +
            ' arch=' + _times.archive.toFixed(0) +
            ' graph=' + _times.graph.toFixed(0) +
            ' begin=' + _times.begin.toFixed(0);
        recordHitch('genEnd', totalMs, extra);
    }
}

begin();
// Page-load gate: keep the sim paused until the user clicks Start / Demo.
// Population build is deferred (see begin() early-return on __awaitingStart).
if (window.__awaitingStart){
    pause = true;
}
// Honor Start clicks that arrived while classic scripts were still loading.
if (window.__pendingStart){
    window.__pendingStart = false;
    try { pauseGame(); } catch (_) {}
} else {
    try { if (typeof syncStartOverlay === 'function') syncStartOverlay(); } catch (_) {}
}
animate();

// -----------------------------------------------------------------------------
// Main-thread rAF — renders road, snapshot-driven AI cars, and local player cars.
// -----------------------------------------------------------------------------
function animate(){
    var _perfFrameStart = perfEnabled ? performance.now() : 0;
    if (perfEnabled){
        if (_lastRafWall > 0){
            var _delta = _perfFrameStart - _lastRafWall;
            if (_delta > 0 && _delta < 1000) perfPush('frameDelta', _delta);
            if (hitchEnabled && _delta > HITCH_MS && _delta < 1500 && phase === 4 && !pause){
                recordHitch('rafGap', _delta);
            }
        }
        _lastRafWall = _perfFrameStart;
    }
    var _perfDraw = 0;
    var _perfT0 = perfEnabled ? performance.now() : 0;
    const DP = window.DemoPresentation;
    // Presentation layer (road cache / follow-cam / 3D) owns the phase-4
    // frame setup. Outside training, fall back to the classic full redraw.
    let _pres = null;
    if (phase === 4 && DP && typeof DP.beginFrame === 'function'){
        _pres = DP.beginFrame(ctx, bestCar, latestSnapshot);
    }
    if (!_pres || !_pres.drewRoad){
        road.draw(ctx);
    }
    if (perfEnabled) _perfDraw += performance.now() - _perfT0;

    if(phase==3){
        playerCar.update(road.borders, road.checkPointList);
        // Player car 1: crimson instead of pure "red" so (a) it is not the
        // same pigment as the start-flag triangle and (b) it separates from
        // the amber AI cars under deuteranopia/protanopia. Contrast ~5.6:1.
        playerCar.draw(ctx,"#E6194B",true);
        playerCar2.update(road.borders, road.checkPointList);
        // Player car 2: sky blue instead of CSS-named "blue" (#0000FF is
        // 2.5:1 — unreadable). #4FC3F7 sits around 7:1 and is CVD-safe
        // against the amber AI population.
        playerCar2.draw(ctx,"#4FC3F7",true);
    }
    if(phase==4){
        const timer = document.getElementById("timer");
        if (timer){
            const simSecs = (frameCount/60).toFixed(2);
            const wallSecs = ((performance.now() - wallStart)/1000).toFixed(2);
            timer.innerHTML = "<p>Sim Time: " + simSecs + "s " +
                "<span style='opacity:.65;font-size:.85em'>(wall " + wallSecs + "s &middot; " + simSpeed + "&times;)</span></p>";
            // Phase A: track-aware fast-lap render. Three lines:
            //   • Fast Lap: 12.34s (this track)
            //   • Last:     14.10s
            //   • all-time best: 9.10s
            // The "(this track)" tag is load-bearing — without it a returning
            // user could assume the displayed value is global. allTimeBest is
            // hidden when only one track has ever been raced (best === current).
            const _fastStr = (typeof fastLap === 'number' ? fastLap.toFixed(2) + 's' : fastLap);
            const _lastStr = (typeof lastLap === 'number' ? lastLap.toFixed(2) + 's' : '—');
            timer.innerHTML += "<p>Fast Lap: " + _fastStr +
                " <span style='opacity:.55;font-size:.85em'>(this track)</span></p>";
            timer.innerHTML += "<p style='opacity:.85'>Last: " + _lastStr + "</p>";
            if (typeof allTimeBest === 'number' &&
                (typeof fastLap !== 'number' || allTimeBest < fastLap)) {
                // Only show the subscript when a different track holds the
                // record — saves a row of noise for single-track users.
                timer.innerHTML += "<p style='opacity:.55;font-size:.82em;margin-top:-4px'>" +
                    "all-time best: " + allTimeBest.toFixed(2) + "s</p>";
            }
        }

        // Still render the last snapshot while paused so the track isn't empty
        // after the user hits Pause / before first Start.
        const shouldDrawCars = !pause || !!latestSnapshot;
        if(!pause){
            // Local player-car accumulator. Runs in parallel with the worker's;
            // exact lockstep isn't needed because player cars only matter when
            // the user is actually driving (usually simSpeed=1).
            const now = performance.now();
            let dt = (now - _lastTickWall) / 1000;
            _lastTickWall = now;
            if (dt > 0.25) dt = 0.25;
            _simStepAccum += simSpeed * dt * 60;
            let playerSteps = Math.floor(_simStepAccum);
            _simStepAccum -= playerSteps;
            if (playerSteps > MAX_STEPS_PER_RAF){ playerSteps = MAX_STEPS_PER_RAF; _simStepAccum = 0; }
            SENSOR_STRIDE = computeSensorStride();
            for (let s = 0; s < playerSteps; s++){
                playerCar.update(road.borders, road.checkPointList);
                playerCar2.update(road.borders, road.checkPointList);
            }
        }

        if (shouldDrawCars){
            const _perfDrawT0 = perfEnabled ? performance.now() : 0;
            const usePresSwarm = _pres && _pres.usePresentationSwarm && DP && typeof DP.drawSwarm === 'function';
            if (latestSnapshot){
                if (usePresSwarm) DP.drawSwarm(ctx, latestSnapshot);
                else drawFromSnapshot(latestSnapshot);
            }
            if (bestCar){
                // Pass the whole bestCar proxy — inputVisual still reads
                // .controls for the existing 4-box display, and now also
                // reads .brainInputs / .brainOutputActivations (Task 2.D) to
                // render the NN decision bars.
                inputVisual(bestCar);
                if (DP && typeof DP.drawChampion === 'function') DP.drawChampion(ctx, bestCar);
                else drawBestCar(bestCar);
            }
            // Player cars are 2D-world quads — skip in pure 3D projection so
            // they don't ghost in flat screen space over the perspective scene.
            const skipPlayers = DP && DP.state && DP.state.view3d;
            if (!skipPlayers){
                if (playerCar) playerCar.draw(ctx,"#E6194B",true);
                if (playerCar2) playerCar2.draw(ctx,"#4FC3F7",true);
            }
            if (perfEnabled) _perfDraw += performance.now() - _perfDrawT0;
        }
        if (_pres && DP && typeof DP.endFrame === 'function'){
            DP.endFrame(ctx, _pres.camApplied);
        }
        if (DP && typeof DP.tickHud === 'function'){
            DP.tickHud({
                generation: generation,
                bestCar: bestCar,
                snap: latestSnapshot,
                pause: pause,
                simSpeed: simSpeed,
                frameCount: frameCount,
            });
        }
    }
    if (perfEnabled){
        try {
            var simMs = latestSnapshot ? latestSnapshot.simMs : 0;
            var steps = latestSnapshot ? latestSnapshot.steps : 0;
            perfPush('sim', simMs);
            perfPush('draw', _perfDraw);
            perfPush('rAF', performance.now() - _perfFrameStart);
            perfPush('steps', steps);
            if ((++perfTick % 10) === 0) { perfRender(); metricsRender(); }
        } catch (e){
            console.error('[perf] HUD error — disabling instrumentation', e);
            perfEnabled = false;
        }
    }
    // P3.E — A/B side render hook. Bulk render cost is gated behind an
    // `abEnabled` check inside the hook; cost is a single property read per
    // frame when A/B is off, so this line is safe to leave in unconditionally.
    if (typeof window.__abRenderTick === 'function') window.__abRenderTick();
    requestAnimationFrame(animate);
}

// -----------------------------------------------------------------------------
// Snapshot rendering — reads Float32Array positions and issues minimal canvas
// calls. Top-K path sorts live cars by fitness (field 4 of the 5-wide stride)
// and draws the rest as a single batched dot fill.
// -----------------------------------------------------------------------------
function drawFromSnapshot(snap){
    const N = snap.N;
    const pos = snap.positions;

    if (FULL_RENDER){
        ctx.globalAlpha = 0.2;
        for (let i = 0; i < N; i++){
            const base = i * 5;
            ctx.fillStyle = pos[base + 3] !== 0 ? "gray" : "rgb(227, 138, 15)";
            drawCarQuad(pos[base], pos[base + 1], pos[base + 2]);
        }
        ctx.globalAlpha = 1;
        return;
    }

    const liveIdx = [];
    for (let i = 0; i < N; i++){
        if (pos[i * 5 + 3] === 0) liveIdx.push(i);
    }
    liveIdx.sort((a, b) => pos[b * 5 + 4] - pos[a * 5 + 4]);
    const kDraw = Math.min(RENDER_TOP_K, liveIdx.length);

    if (liveIdx.length > kDraw){
        ctx.fillStyle = "rgba(227, 138, 15, 0.55)";
        ctx.beginPath();
        for (let i = kDraw; i < liveIdx.length; i++){
            const idx = liveIdx[i];
            ctx.rect(pos[idx * 5] - 2, pos[idx * 5 + 1] - 2, 4, 4);
        }
        ctx.fill();
    }
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "rgb(227, 138, 15)";
    for (let i = 0; i < kDraw; i++){
        const idx = liveIdx[i];
        drawCarQuad(pos[idx * 5], pos[idx * 5 + 1], pos[idx * 5 + 2]);
    }
    ctx.globalAlpha = 1;
}

// Pre-computed quad geometry — cars are 30×50 so rad/alpha are constants.
const _CAR_RAD = Math.hypot(30, 50) / 2;
const _CAR_ALPHA = Math.atan2(30, 50);
function drawCarQuad(x, y, angle){
    ctx.beginPath();
    ctx.moveTo(x - Math.sin(angle - _CAR_ALPHA) * _CAR_RAD, y - Math.cos(angle - _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(angle + _CAR_ALPHA) * _CAR_RAD, y - Math.cos(angle + _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(Math.PI + angle + _CAR_ALPHA) * _CAR_RAD, y - Math.cos(Math.PI + angle + _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(Math.PI + angle - _CAR_ALPHA) * _CAR_RAD, y - Math.cos(Math.PI + angle - _CAR_ALPHA) * _CAR_RAD);
    ctx.fill();
}

function drawBestCar(bc){
    ctx.fillStyle = bc.damaged ? "gray" : "rgb(227, 138, 15)";
    drawCarQuad(bc.x, bc.y, bc.angle);
    // Honor DemoPresentation rays toggle when the presentation layer is
    // present but fell through to this legacy draw path.
    const raysOn = !(window.DemoPresentation && window.DemoPresentation.state
        && window.DemoPresentation.state.rays === false);
    if (raysOn && bc.sensor && bc.sensor.rays && bc.sensor.rays.length){
        for (let i = 0; i < bc.sensor.rays.length; i++){
            const ray = bc.sensor.rays[i];
            const reading = bc.sensor.readings[i];
            const end = reading ? reading : ray[1];
            ctx.beginPath();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "yellow";
            ctx.moveTo(ray[0].x, ray[0].y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.strokeStyle = "black";
            ctx.moveTo(ray[1].x, ray[1].y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
        }
    }
}

// -----------------------------------------------------------------------------
// Benchmark console helpers — __runBenchmark, __abTest, __clearArchive,
// __downloadCSV. Used to produce CSVs for the Phase 0 baseline captures and
// the ruvector A/B proof charts in docs/plan/generalization-fix.md.
// -----------------------------------------------------------------------------
function __rvToggleSnapshot(){
    const info = (window.__rvBridge && window.__rvBridge.info) ? window.__rvBridge.info() : null;
    const policy = info && info.policy ? info.policy : {};
    return {
        vectorMemory: !window.rvDisabled,
        reranker: policy.reranker || '',
        adapter: policy.adapter || '',
        index: policy.index || '',
        dynamics: !!policy.dynamics,
        archiveBrains: info ? (info.brains | 0) : 0,
        archiveTracks: info ? (info.tracks | 0) : 0,
        archiveObservations: info ? (info.observations | 0) : 0
    };
}

function __applyRvConfig(cfg){
    if (!cfg) return;
    if (typeof cfg.vectorMemory === 'boolean') window.rvDisabled = !cfg.vectorMemory;
    const b = window.__rvBridge;
    if (!b) return;
    if (cfg.reranker && b.setRerankerMode) b.setRerankerMode(cfg.reranker);
    if (cfg.adapter  && b.setAdapterMode)  b.setAdapterMode(cfg.adapter);
    if (cfg.index    && b.setIndexKind)    b.setIndexKind(cfg.index);
    if (typeof cfg.dynamics === 'boolean' && b.setUseDynamics) b.setUseDynamics(cfg.dynamics);
}

window.__clearArchive = async function(){
    if (!window.__rvBridge || !window.__rvBridge._debugReset){
        console.warn('[bench] __rvBridge._debugReset unavailable'); return;
    }
    await window.__rvBridge._debugReset();
    try { localStorage.removeItem('bestBrain'); localStorage.removeItem('progress'); } catch (_) {}
    console.log('[bench] archive cleared');
};

window.__runBenchmark = async function(gens, opts){
    opts = opts || {};
    const label = opts.label || 'run';
    if (phase !== 4) throw new Error('__runBenchmark requires phase 4 (training). Current phase=' + phase);
    if (__benchmarkCtx) throw new Error('__runBenchmark already active ("' + __benchmarkCtx.label + '"). Await it or cancel before starting another.');

    // Soft-warn on settings that produce thin or slow data.
    if (typeof batchSize !== 'undefined' && batchSize < 100){
        console.warn('[bench] batchSize=' + batchSize + ' is low — population-wide stats are noisy. Raise via the Training tuning slider (target: 500–1000).');
    }
    if (typeof simSpeed !== 'undefined' && simSpeed < 50){
        console.warn('[bench] simSpeed=' + simSpeed + ' is low — ' + gens + ' gens will take ' + Math.round(gens * (typeof nextSeconds !== 'undefined' ? nextSeconds : 15) / simSpeed) + 's wall time. Raise simSpeed to ~100 for fast benchmarks.');
    }

    if (opts.cold){
        await window.__clearArchive();
        generation = 0;
    }
    if (opts.config) __applyRvConfig(opts.config);

    const configSnapshot = { trackLabel: opts.track || '', cold: !!opts.cold };

    const ctx = { label, target: gens, done: 0, rows: [], config: configSnapshot };
    const promise = new Promise((resolve, reject) => { ctx.resolve = resolve; ctx.reject = reject; });
    __benchmarkCtx = ctx;

    // Watchdog: if no progress for (nextSeconds * 4) wall seconds per expected
    // gen, abort — the sim is probably paused or the tab was backgrounded.
    const secs = typeof nextSeconds !== 'undefined' ? nextSeconds : 15;
    const watchMs = Math.max(30000, (secs * 4) * gens * 1000);
    const watchdog = setTimeout(() => {
        if (__benchmarkCtx !== ctx || ctx.done_flag) return;
        ctx.done_flag = true;
        __benchmarkCtx = null;
        ctx.reject(new Error('[bench] watchdog fired after ' + (watchMs/1000) + 's — completed ' + ctx.done + '/' + gens + ' gens'));
    }, watchMs);

    if (opts.restart !== false){
        try { if (typeof nextBatch === 'function') nextBatch(); }
        catch (e){ console.warn('[bench] restart failed', e); }
    }

    console.log('[bench] "' + label + '" running ' + gens + ' gens (cold=' + !!opts.cold + ', batchSize=' + (typeof batchSize !== 'undefined' ? batchSize : '?') + ', simSpeed=' + (typeof simSpeed !== 'undefined' ? simSpeed : '?') + ')');
    try {
        const rows = await promise;
        clearTimeout(watchdog);
        __benchmarkCtx = null;
        // Close the SONA trajectory so patterns crystallize (endTrajectory calls
        // agent.forceLearn, which bumps patterns_stored). Re-open immediately so
        // subsequent benchmarks still record. endPhase4Trajectory no-ops cleanly
        // if no trajectory is open or if SONA isn't ready.
        try {
            const b = window.__rvBridge;
            if (!window.rvDisabled && b && b.info){
                const info = b.info();
                const trajOpen = info.sona && info.sona.trajectoryOpen;
                if (trajOpen && b.endPhase4Trajectory){
                    const finalFitness = rows.length ? (rows[rows.length - 1].bestFitness || 0) : 0;
                    b.endPhase4Trajectory(finalFitness);
                }
                if (b.beginPhase4Trajectory){
                    if (!window.currentTrackVec && typeof embedCurrentTrack === 'function'){
                        try { embedCurrentTrack(); } catch (_) {}
                    }
                    b.beginPhase4Trajectory(window.currentTrackVec || null);
                }
            }
        } catch (sonaErr){ console.warn('[sona] end/restart at bench boundary failed', sonaErr); }
        console.log('[bench] "' + label + '" complete, ' + rows.length + ' rows');
        if (opts.download !== false){
            try { window.__downloadCSV(label, rows); } catch (e){ console.warn('[bench] download failed', e); }
        }
        return rows;
    } catch (e){
        clearTimeout(watchdog);
        __benchmarkCtx = null;
        throw e;
    }
};

window.__abTest = async function(gens, configA, configB, opts){
    opts = opts || {};
    const labelA = (opts.label || 'ab') + '-A';
    const labelB = (opts.label || 'ab') + '-B';
    console.log('[abTest] running A then B, ' + gens + ' gens each');
    const rowsA = await window.__runBenchmark(gens, {
        label: labelA, config: configA, cold: opts.coldA !== false,
        track: opts.track, download: false
    });
    const rowsB = await window.__runBenchmark(gens, {
        label: labelB, config: configB, cold: opts.coldB !== false,
        track: opts.track, download: false
    });
    const diff = { A: _summariseRows(rowsA), B: _summariseRows(rowsB) };
    console.table(diff);
    window.__downloadCSV((opts.label || 'ab') + '-combined', rowsA.concat(rowsB));
    return { A: rowsA, B: rowsB, diff };
};

function _summariseRows(rows){
    if (!rows.length) return {};
    const last = rows[rows.length - 1];
    const first = rows[0];
    const avg = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) / rows.length;
    return {
        gens: rows.length,
        gen1_medCp: first.medCheckpoints,
        genN_medCp: last.medCheckpoints,
        gen1_survival5s: first.survival5s,
        genN_survival5s: last.survival5s,
        avg_wallBumps: +avg('wallBumps').toFixed(1),
        avg_maxCp: +avg('maxCheckpoints').toFixed(1),
        vectorMemory: first.vectorMemory,
        reranker: first.reranker,
        adapter: first.adapter
    };
}

window.__downloadCSV = function(label, rows){
    rows = rows || __metricsLog;
    if (!rows.length){ console.warn('[bench] no rows to export'); return; }
    const keys = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
    const esc = (v) => {
        if (v == null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [keys.join(',')].concat(rows.map(r => keys.map(k => esc(r[k])).join(','))).join('\n');
    const blob = new Blob([csv], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = label + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    console.log('[bench] downloaded CSV "' + a.download + '" (' + rows.length + ' rows)');
};

// =============================================================================
// P3.E — A/B comparison mode
// =============================================================================
// Runs a second sim-worker in parallel with the primary. The B worker uses the
// same code and same track/config but is deliberately starved of the three
// things that make the primary special: (1) no ruvector seed-from-archive
// (always cold random), (2) no localStorage bestBrain prior, (3) no
// conservative-init bias. This makes B a clean "what would this look like
// without the vector-memory layer?" baseline.
//
// Orchestration lives in main.js (not the worker) because rvDisabled is a
// main-thread concept — the worker has no knowledge of ruvector. See
// docs/plan/ruvector-proof/ab-mode/PROOF.md for architecture notes.
(function () {
    var canvasB = document.getElementById('myCanvasB');
    var ctxB = null;
    var abHud = document.getElementById('ab-hud');
    var abHudB = document.getElementById('ab-hud-b');
    var abHudDelta = document.getElementById('ab-hud-delta');

    var abEnabled = false;
    var simWorkerB = null;
    var bState = null;
    var _abLastForwardedPause = null;
    var _abLastForwardedSimSpeed = null;

    function makeBState(){
        return {
            latestSnapshot: null,
            frameCount: 0,
            generation: 0,
            metricsLog: [],
            workerReady: false,
            workerInited: false,
            lastRow: null,
            pendingBegin: null
        };
    }

    function ensureCtxB(){
        if (ctxB) return ctxB;
        if (!canvasB) return null;
        // Match primary's canvas bitmap size so road.draw() geometry lands
        // at the same world coordinates (all spawn / checkpoint math is in
        // 3200×1800 units; CSS shrinks the visible output).
        canvasB.width = 3200;
        canvasB.height = 1800;
        ctxB = canvasB.getContext('2d');
        return ctxB;
    }

    // Cold-random init for B, deliberately skipping the P2.C conservative-init
    // bias that the primary's fillRandom uses. The baseline's whole point is
    // "no help from the main-thread extras" — injecting the conservative bias
    // would muddy the delta.
    function buildBrainsBufferB(N){
        var out = new Float32Array(N * FLAT_LENGTH);
        for (var i = 0; i < N * FLAT_LENGTH; i++){
            out[i] = Math.random() * 2 - 1;
        }
        return out;
    }

    function postBeginB(N){
        if (!simWorkerB || !bState || !bState.workerReady) return;
        if (!bState.workerInited){
            var borders = road.borders.map(function(b){
                return [{x:b[0].x, y:b[0].y}, {x:b[1].x, y:b[1].y}];
            });
            var cpList = (road.checkPointList || []).map(function(c){
                return [{x:c[0].x, y:c[0].y}, {x:c[1].x, y:c[1].y}];
            });
            simWorkerB.postMessage({
                type: 'init',
                canvasW: canvas.width,
                canvasH: canvas.height,
                borders: borders,
                checkPointList: cpList
            });
            bState.workerInited = true;
        }
        var brains = buildBrainsBufferB(N);
        simWorkerB.postMessage({
            type: 'begin',
            N: N,
            seconds: seconds,
            maxSpeed: maxSpeed,
            traction: traction,
            startInfo: { x: startInfo.x, y: startInfo.y, heading: startInfo.heading || 0 },
            poseJitter: Object.assign({ radiusPx: 0, angleDeg: 0, maxAttempts: 8 }, window.__poseJitter || {}),
            brains: brains
        }, [brains.buffer]);
    }

    function handleSnapshotB(m){
        if (!bState) return;
        bState.latestSnapshot = m;
        bState.frameCount = m.frameCount;
    }

    // Inlined minimal version of metricsComputeRow — we only need the fields
    // the dual-HUD + delta indicator actually read. Deliberately does NOT push
    // to the primary __metricsLog (that would pollute benchmark captures).
    function computeRowB(m){
        var N = m.popN | 0;
        if (!N || !m.popCheckpoints) return null;
        var df = m.popDeathFrames;
        var FPS = 60;
        var aliveAt = function(frames){
            var c = 0;
            for (var i = 0; i < N; i++){
                if (df[i] === -1 || df[i] > frames) c++;
            }
            return c / N;
        };
        var cpSorted = Int16Array.from(m.popCheckpoints).sort();
        return {
            gen: bState.generation,
            popN: N,
            maxCheckpoints: cpSorted[N - 1],
            survival5s:  +aliveAt(5 * FPS).toFixed(4),
            survival10s: +aliveAt(10 * FPS).toFixed(4),
            survivalEnd: +((m.popStillAlive | 0) / N).toFixed(4),
            bestFitness: m.fitness,
            bestLaps: m.laps
        };
    }

    function handleGenEndB(m){
        if (!bState) return;
        try {
            var row = computeRowB(m);
            if (row){
                bState.metricsLog.push(row);
                if (bState.metricsLog.length > 500) bState.metricsLog.shift();
                bState.lastRow = row;
                bState.generation += 1;
                renderAbHud();
            }
        } catch (e) { console.warn('[ab] genEnd-B handler failed', e); }
        // No auto-restart. B's next gen is kicked by window.__abOnPerformBegin
        // (called from the primary's performBegin) so the two canvases stay
        // phase-locked. If B finishes before A, B idles until A begins;
        // if B is still running when A begins, posting `begin` safely
        // clobbers B's cars array — A's pace is authoritative.
    }

    function renderAbHud(){
        if (!abHudB || !abHudDelta) return;
        var aRow = (typeof __metricsLog !== 'undefined' && __metricsLog.length)
            ? __metricsLog[__metricsLog.length - 1] : null;
        var bRow = bState ? bState.lastRow : null;
        var pct = function(v){ return (v * 100).toFixed(0) + '%'; };
        if (bRow){
            abHudB.innerHTML =
                '<div style="color:#fff;margin-bottom:3px;"><b>baseline (no ruvector)</b></div>' +
                '<div style="opacity:.75;font-size:.9em;">gen ' + bRow.gen + ' · N=' + bRow.popN + '</div>' +
                '<div>max cp <b>' + bRow.maxCheckpoints + '</b></div>' +
                '<div>surv end <b>' + pct(bRow.survivalEnd) + '</b></div>';
        } else {
            abHudB.innerHTML = '<div style="opacity:.6;">(awaiting baseline gen 0)</div>';
        }
        if (aRow && bRow){
            var dSurv = aRow.survivalEnd - bRow.survivalEnd;
            var dMaxCp = (aRow.maxCheckpoints | 0) - (bRow.maxCheckpoints | 0);
            var signPct = function(n){ return (n >= 0 ? '+' : '') + (n * 100).toFixed(0) + '%'; };
            var sign = function(n){ return (n >= 0 ? '+' : '') + n; };
            abHudDelta.innerHTML =
                '<div><b>ruvector Δ (A − B)</b></div>' +
                '<div style="margin-top:3px;">surv end ' + signPct(dSurv) +
                ' · max cp ' + sign(dMaxCp) + '</div>';
        } else {
            abHudDelta.innerHTML = '<div style="opacity:.6;">(Δ ready after both sides post a gen)</div>';
        }
    }

    function spawnB(){
        if (simWorkerB) return;
        simWorkerB = new Worker('sim-worker.js');
        bState = makeBState();
        simWorkerB.onmessage = function(ev){
            var m = ev.data;
            if (!m) return;
            if (m.type === 'ready'){
                if (!bState) return;
                bState.workerReady = true;
                if (bState.pendingBegin){
                    var pb = bState.pendingBegin;
                    bState.pendingBegin = null;
                    postBeginB(pb.N);
                }
            } else if (m.type === 'snapshot'){
                handleSnapshotB(m);
            } else if (m.type === 'genEnd'){
                handleGenEndB(m);
            }
        };
        simWorkerB.onerror = function(err){
            console.error('[sim-worker-B] error', err.message || err, err.filename, err.lineno);
        };
    }

    function teardownB(){
        // worker.terminate() synchronously kills the worker thread and drops
        // all queued messages. This is the ONLY reliable way to stop B —
        // setPause would leave it pinned to memory and counted against the
        // browser's worker cap. Memory-leak-on-toggle-off is an explicit
        // revert condition for this task; terminate + null + clear is the
        // minimum.
        if (simWorkerB){
            try { simWorkerB.terminate(); } catch (_) {}
            simWorkerB = null;
        }
        bState = null;
        _abLastForwardedPause = null;
        _abLastForwardedSimSpeed = null;
        if (ctxB && canvasB){
            ctxB.clearRect(0, 0, canvasB.width, canvasB.height);
        }
        if (abHudB) abHudB.innerHTML = '';
        if (abHudDelta) abHudDelta.innerHTML = '';
    }

    function setEnabled(enabled){
        if (!!enabled === abEnabled) return;
        abEnabled = !!enabled;
        var cDiv = document.getElementById('canvasDiv');
        if (abEnabled){
            ensureCtxB();
            if (canvasB) canvasB.hidden = false;
            if (abHud) abHud.hidden = false;
            if (cDiv) cDiv.classList.add('ab-on');
            spawnB();
            // spawnB creates bState but workerReady lags the Worker's internal
            // 'ready' message. Queue the first begin and let the onmessage
            // handler dispatch it. If bState is somehow already ready (e.g. a
            // future re-spawn path), fire immediately.
            if (bState){
                if (bState.workerReady) postBeginB(batchSize);
                else bState.pendingBegin = { N: batchSize };
            }
        } else {
            teardownB();
            if (canvasB) canvasB.hidden = true;
            if (abHud) abHud.hidden = true;
            if (cDiv) cDiv.classList.remove('ab-on');
        }
    }

    // Pause-mirror: whenever the primary's `pause` flag changes, forward to B.
    // Polling via the render tick avoids touching buttonResponse.js setters.
    // sim-worker's setPause handler is idempotent; duplicate sends are safe.
    function broadcastPauseTick(){
        if (!simWorkerB) return;
        if (pause !== _abLastForwardedPause){
            try { simWorkerB.postMessage({ type: 'setPause', pause: !!pause }); } catch (_) {}
            _abLastForwardedPause = !!pause;
        }
    }

    // Sim-speed mirror: setSimSpeed lives in buttonResponse.js and only knows
    // about the primary simWorker. Poll simSpeed here and forward edges to B
    // so both halves of the A/B view advance at the same rate. Without this,
    // B defaults to its module-scoped simSpeed=1 and visibly lags whenever
    // the user cranks the primary above 1×.
    function broadcastSimSpeedTick(){
        if (!simWorkerB) return;
        if (simSpeed !== _abLastForwardedSimSpeed){
            try { simWorkerB.postMessage({ type: 'setSimSpeed', v: simSpeed }); } catch (_) {}
            _abLastForwardedSimSpeed = simSpeed;
        }
    }

    // Dual-ctx render. Deliberately lighter than primary's drawFromSnapshot:
    // no top-K culling, no bestCar highlight, no sensor overlay. B is a
    // population-level comparison view, not a debug panel. Slate palette
    // distinguishes B visually from A's amber.
    var _CAR_RAD_B = Math.hypot(30, 50) / 2;
    var _CAR_ALPHA_B = Math.atan2(30, 50);
    function drawCarQuadB(x, y, angle){
        ctxB.beginPath();
        ctxB.moveTo(x - Math.sin(angle - _CAR_ALPHA_B) * _CAR_RAD_B,
                    y - Math.cos(angle - _CAR_ALPHA_B) * _CAR_RAD_B);
        ctxB.lineTo(x - Math.sin(angle + _CAR_ALPHA_B) * _CAR_RAD_B,
                    y - Math.cos(angle + _CAR_ALPHA_B) * _CAR_RAD_B);
        ctxB.lineTo(x - Math.sin(Math.PI + angle + _CAR_ALPHA_B) * _CAR_RAD_B,
                    y - Math.cos(Math.PI + angle + _CAR_ALPHA_B) * _CAR_RAD_B);
        ctxB.lineTo(x - Math.sin(Math.PI + angle - _CAR_ALPHA_B) * _CAR_RAD_B,
                    y - Math.cos(Math.PI + angle - _CAR_ALPHA_B) * _CAR_RAD_B);
        ctxB.fill();
    }
    function drawSnapshotToCtxB(snap){
        var N = snap.N;
        var pos = snap.positions;
        ctxB.globalAlpha = 0.55;
        for (var i = 0; i < N; i++){
            var base = i * 5;
            // Damaged cars dim gray; live cars slate (distinct from primary amber).
            ctxB.fillStyle = pos[base + 3] !== 0 ? '#3f434a' : '#8d97a6';
            drawCarQuadB(pos[base], pos[base + 1], pos[base + 2]);
        }
        ctxB.globalAlpha = 1;
    }

    // road.draw(ctx) ignores its ctx argument — it delegates to
    // roadEditor.redraw() which paints only the primary canvas. For ctxB we
    // have to clear + repaint track geometry ourselves each frame. Matches
    // the A-canvas look closely enough that the comparison reads as "same
    // track, different population".
    function drawTrackOnCtxB(){
        // Solid background wipes last-frame cars — without this the canvas
        // accumulates brush-stroke trails.
        ctxB.fillStyle = '#15161a';
        ctxB.fillRect(0, 0, canvasB.width, canvasB.height);
        // Borders.
        if (road.borders && road.borders.length){
            ctxB.strokeStyle = '#ffffff';
            ctxB.lineWidth = 5;
            ctxB.beginPath();
            for (var i = 0; i < road.borders.length; i++){
                var b = road.borders[i];
                ctxB.moveTo(b[0].x, b[0].y);
                ctxB.lineTo(b[1].x, b[1].y);
            }
            ctxB.stroke();
        }
        // Checkpoints (green lines), same convention as the primary viz.
        var cps = road.checkPointList || [];
        if (cps.length){
            ctxB.strokeStyle = 'rgba(120, 220, 120, 0.55)';
            ctxB.lineWidth = 4;
            ctxB.beginPath();
            for (var j = 0; j < cps.length; j++){
                var c = cps[j];
                ctxB.moveTo(c[0].x, c[0].y);
                ctxB.lineTo(c[1].x, c[1].y);
            }
            ctxB.stroke();
        }
    }

    function renderTick(){
        if (!abEnabled || !ctxB || phase !== 4) return;
        try {
            drawTrackOnCtxB();
            if (bState && bState.latestSnapshot){
                drawSnapshotToCtxB(bState.latestSnapshot);
            }
        } catch (e) {
            console.warn('[ab] render tick failed', e);
        }
        broadcastPauseTick();
        broadcastSimSpeedTick();
    }

    window.__abSetEnabled = setEnabled;
    window.__abIsEnabled = function(){ return abEnabled; };
    // Called by invalidateWorkerInit() in main.js whenever the primary's
    // cached track geometry is thrown away (preset switch, in-memory track
    // reload, etc). Mirrors the effect on B so the next postBeginB will
    // re-post the 'init' message with fresh borders + checkpoints.
    window.__abInvalidateInit = function(){
        if (bState) bState.workerInited = false;
    };
    // Called from primary performBegin so every A-start triggers a matching
    // B-start. Guarded so it's a no-op when A/B mode is off, and queues the
    // begin if B's worker hasn't posted its 'ready' yet (covers the race
    // where the user toggles A/B on and the primary kicks off a gen before
    // B's worker thread has finished booting).
    window.__abOnPerformBegin = function(N){
        if (!abEnabled || !simWorkerB || !bState) return;
        if (!bState.workerReady){
            bState.pendingBegin = { N: N };
            return;
        }
        postBeginB(N);
    };
    window.__abGetState = function(){
        return bState ? {
            enabled: abEnabled,
            gen: bState.generation,
            lastRow: bState.lastRow,
            frameCount: bState.frameCount,
            workerReady: bState.workerReady,
            workerInited: bState.workerInited,
            metricsLogLength: bState.metricsLog.length
        } : { enabled: abEnabled };
    };
    window.__abRenderTick = renderTick;
})();
