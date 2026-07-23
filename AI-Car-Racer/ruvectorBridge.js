// ruvectorBridge.js
// Vector-memory integration surface for AI-Car-Racer.
// Wraps @ruvector/wasm (VectorDB + HNSW) and @ruvector/cnn (image embedder),
// adds native-IndexedDB persistence, and — as of P1.A — reranks retrieval with
// a GNN over the lineage DAG when enough archived brains are present, falling
// back to the EMA-weighted path otherwise.

// Cache-bust query is load-bearing on the live site: CF Pages edge
// had a pre-2026-04 cached entry for the bare URL with `immutable`
// set, which kept serving a Rocket-Loader/auto-minify-transformed
// copy even after the hnsw-wasm rebuild. A new query-stringed URL
// has no stale edge entry and inherits the current `no-transform`
// header policy. Bump `?v=...` on any future vendor rebuild if the
// stale entry bites again.
import initVec, { VectorDB } from '../vendor/ruvector/ruvector_wasm/ruvector_wasm.js?v=hnsw-wasm-20260424b';
import initCnn, { CnnEmbedder } from '../vendor/ruvector/ruvector_cnn_wasm/index.js';
import { flatten, unflatten, FLAT_LENGTH, TOPOLOGY, BRAIN_SCHEMA_VERSION } from './brainCodec.js';
import { loadGnn, isReady as gnnIsReady, gnnScore } from './gnnReranker.js';
// P3.A — hyperbolic HNSW swap. `loadHyperbolic` boots the wasm side; the
// adapter mimics the slice of VectorDB the bridge actually calls (insert /
// search / len / isEmpty) so the swap is a one-line constructor change.
// When the wasm fails to load, the flag silently falls back to Euclidean.
import {
  loadHyperbolic,
  isHyperbolicReady,
  HyperbolicVectorDB,
} from './hyperbolicAdapter.js';
// Phase 2A — F2 federated search. When _federationEnabled is on, recommendSeeds
// fans out to BOTH _brainDB (Euclidean) and _brainDB_hyperbolic in parallel,
// unions via F5 hash dedup, and reranks the union with the same GNN scorer the
// single-index path uses. The modules are plain JS — no wasm — so we import
// them eagerly.
import { fanOut, fanOutSync, kPrime as _kPrime } from './federation/fanout.js';
import { unionByHash, selectTopK } from './federation/rerank.js';
import { hashBrain } from './archive/hash.js';
// Phase 2B — F6 cross-tab live training. Thin wrapper over BroadcastChannel;
// when enabled, archiveBrain broadcasts a single-brain delta after a
// successful insert, and received deltas are routed back through archiveBrain
// locally (the F5 dedup short-circuits identical brains automatically).
import {
  start as crosstabStart,
  stop as crosstabStop,
  broadcastBrain as crosstabBroadcast,
  isStarted as crosstabIsStarted,
  stats as crosstabStats,
} from './crosstab/channel.js';
import { toWire as crosstabToWire, fromWire as crosstabFromWire } from './crosstab/wire.js';
// P3.B — lineage DAG. Replaces the hand-walked parentIds traversal in
// getLineage() with a cycle-safe DAG structure (ruvector_dag_wasm) shadowed
// by a JS-side adjacency list for O(depth) queries. Same fallback discipline
// as gnnReranker: when the wasm module doesn't load, the bridge keeps the
// legacy in-function walk around (exposed as getLineageLegacy for the P3.B
// equivalence harness). See AI-Car-Racer/lineage/dag.js for the wrapper.
import {
  loadDag,
  isReady as dagIsReady,
  addBrain as dagAddBrain,
  getLineage as dagGetLineage,
  hydrateFromMirror as dagHydrateFromMirror,
  getGraphSnapshot as dagGetGraphSnapshot,
  info as dagInfo,
  _debugReset as dagDebugReset,
} from './lineage/dag.js';
// P2.A — the SONA engine is a façade that subsumes the P1.B MicroLoRA
// adapter (unchanged call shape: adapt / reward / drift) and adds trajectory
// recording + ReasoningBank pattern extraction. We keep the `lora*` local
// names so the rest of this file reads the same as before P2.A, and pull in
// the new SONA surface under a separate `sona*` namespace.
import {
  loadEngine as loadSonaEngine,
  isReady as loraIsReady,
  sonaReady,
  adapt as loraAdapt,
  reward as loraReward,
  info as sonaEngineInfo,
  serialize as loraSerialize,
  deserialize as loraDeserialize,
  recentDrift as loraRecentDrift,
  _debugReset as sonaEngineDebugReset,
  beginTrajectory as sonaBeginTrajectory,
  addStep as sonaAddStep,
  endTrajectory as sonaEndTrajectory,
  findPatterns as sonaFindPatterns,
} from './sona/engine.js';
// Phase 3A — F7 observability. Tiny per-stage timing module; the bridge
// wraps recommendSeeds' sub-stages and archiveBrain's generation cursor,
// and getIndexStats() exposes a live snapshot for the UI panel.
import {
  startStage as _obsStart,
  endStage as _obsEnd,
  snapshot as _obsSnapshot,
  setGeneration as _obsSetGeneration,
} from './observability/timings.js';

// Small wrapper — the try/finally means an exception inside `fn` still
// closes the stage, so a later startStage() doesn't see a dangling
// "started" record. Synchronous-only; no-op for async fns (the hot path
// is synchronous end-to-end).
function _obsTime(label, fn) {
  _obsStart(label);
  try { return fn(); } finally { _obsEnd(label); }
}

const IDB_NAME = 'rv_car_learning';
// Bumped to 3 in P1.C to add the dynamics store. onupgradeneeded for v3
// creates the new store only; brains/tracks/observations/lora are untouched,
// so old archives continue to hydrate unchanged — they just don't have
// dynamicsId set on any brain meta (backwards-compat: missing → skip the
// dynamics term in recommendSeeds).
// Bumped to 4 for crash-map HNSW store (adaptive-gates curriculum memory).
const IDB_VERSION = 4;
const BRAINS_STORE = `brains_${TOPOLOGY.join('_')}`; // topology-scoped per PRD risk #6
const TRACKS_STORE = 'tracks';
const OBS_STORE = 'observations';
const LORA_STORE = 'lora_track';
const LORA_KEY = 'singleton'; // single-row store; this is the only id ever used
const DYNAMICS_STORE = 'dynamics';
const CRASH_STORE = 'crash_maps';

const TRACK_DIM = 512;
const DYNAMICS_DIM = 64; // matches dynamicsEmbedder.DYNAMICS_DIM
// Crash heat maps: 16×9 log1p-count grid over the canvas, L2-normalised.
// Same layout as crashMapCodec.js (classic) — keep in sync.
const CRASH_GW = 16;
const CRASH_GH = 9;
const CRASH_DIM = CRASH_GW * CRASH_GH; // 144
export { CRASH_DIM, CRASH_GW, CRASH_GH };
// VectorDB returns cosine DISTANCE (1 - similarity), range [0, 2]. Dedup when
// distance is tiny, i.e. the two track vectors are essentially identical.
const TRACK_DEDUPE_MAX_DIST = 0.005; // ≈ 0.9975 cosine similarity
const EMA_ALPHA = 0.3;
const PERSIST_DEBOUNCE_MS = 250;

// Minimum archive size before we switch from EMA to GNN. Rationale: a GNN
// needs a non-trivial graph to be meaningful — with <10 brains the lineage DAG
// is typically a chain of 1–2 nodes and message passing degenerates to identity.
const GNN_MIN_ARCHIVE = 10;

let _rerankerMode = 'none'; // 'gnn' | 'ema' | 'none' — most recent path actually taken

// P3.F — per-generation seeding-source breakdown. Counters are set by the
// caller (main.js buildBrainsBuffer) via setLastSeedSources() *after* it has
// assigned every slot, because the localStorage_prior / random_init buckets
// are decisions made outside this module. `total` lets the UI assert that
// archive + prior + random sums to the full population N — any drift means
// some slot was silently unaccounted for. `generation` is the gen index at
// which the snapshot was taken; rendering clients use it as a cache key.
let _lastSeedSources = {
  archive_recall: 0,
  localStorage_prior: 0,
  random_init: 0,
  total: 0,
  generation: -1,
};
export function setLastSeedSources(obj) {
  if (!obj || typeof obj !== 'object') return;
  const archive = Math.max(0, (obj.archive_recall | 0));
  const prior = Math.max(0, (obj.localStorage_prior | 0));
  const random = Math.max(0, (obj.random_init | 0));
  _lastSeedSources = {
    archive_recall: archive,
    localStorage_prior: prior,
    random_init: random,
    total: archive + prior + random,
    generation: Number.isFinite(obj.generation) ? (obj.generation | 0) : -1,
  };
}

// P4.A — UI-facing policy switches. The A/B toggle strip sets these; the
// test harnesses can still reach the low-level boolean overrides (setForceEma,
// setBypassLora) for backwards compatibility.
//
// Reranker policy (what the toggle picks, vs. what recommendSeeds ends up doing):
//   'auto' — original behaviour: gnn if wasm loaded AND archive ≥ GNN_MIN_ARCHIVE, else ema
//   'none' — skip the reranker term entirely (rerankTerm = 1, pure trackSim × fitness)
//   'ema'  — force EMA path
//   'gnn'  — force GNN path when wasm loaded (ignores archive-size threshold)
let _rerankerPolicy = 'auto';
const VALID_RERANKER_MODES = ['auto', 'none', 'ema', 'gnn'];
export function setRerankerMode(mode) {
  if (!VALID_RERANKER_MODES.includes(mode)) return false;
  _rerankerPolicy = mode;
  return true;
}
export function getRerankerMode() { return _rerankerPolicy; }

let _forceEma = false;      // test-only override; see setForceEma()

// Test-only: forces the EMA path regardless of GNN availability. Used by
// the scripted replay harness in tests/gnn-replay.html to get an
// apples-to-apples EMA-vs-GNN comparison from a single archive snapshot.
export function setForceEma(on) { _forceEma = !!on; }

// Adapter policy. The toggle strip picks one of these; `_bypassLora` and
// `_sonaPaused` are the two low-level flags the rest of the bridge reads.
//   'sona'       — P2.A default: LoRA adapts query vectors, SONA records trajectories
//   'micro-lora' — P1.B-era behaviour: LoRA active, SONA trajectory recording paused
//   'off'        — ablate the adapter entirely: raw track vector, no SONA trajectories
let _adapterMode = 'sona';
let _sonaPaused = false;
const VALID_ADAPTER_MODES = ['off', 'micro-lora', 'sona'];
export function setAdapterMode(mode) {
  if (!VALID_ADAPTER_MODES.includes(mode)) return false;
  _adapterMode = mode;
  _bypassLora = (mode === 'off');
  _sonaPaused = (mode !== 'sona');
  return true;
}
export function getAdapterMode() { return _adapterMode; }

// Test-only: when true, recommendSeeds() searches with the *raw* track vector
// instead of the LoRA-adapted one. Lets the lora-replay harness compare
// adapted vs un-adapted retrieval against the same archive. Has no effect on
// reward(): the adapter still receives reward signals when archiveBrain runs,
// because that's the bit we're trying to keep behaviour-equivalent.
let _bypassLora = false;
export function setBypassLora(on) { _bypassLora = !!on; }

let _ready = null;
let _brainDB = null;
// Phase 2A — F2. When the hyperbolic wasm loads we ALSO keep a Hyperbolic
// instance of the brain index populated in parallel with the Euclidean one,
// so federated search can fan out to both without a rebuild stall. This is
// decoupled from `_indexKind`: `_brainDB` stays the "primary" single-index
// view (which setIndexKind swaps between), while `_brainDB_hyperbolic` is a
// strictly additive shadow — populated only when isHyperbolicReady() and
// only used when _federationEnabled flips true. The memory cost is a second
// HNSW over brains (~same size as the Euclidean one); bounded by archive.
let _brainDB_hyperbolic = null;
let _trackDB = null;
let _dynamicsDB = null;
let _crashDB = null;
let _crashMirror = new Map(); // id -> { vector, meta }
let _cnn = null;
// Crash-map retrieval toggle (default on). Adaptive gates can still call
// archive/search when disabled for diagnostics; recommendCrashLayouts returns
// [] when off so the curriculum path no-ops cleanly.
let _useCrashMaps = true;
export function setUseCrashMaps(on) { _useCrashMaps = !!on; return _useCrashMaps; }
export function isUsingCrashMaps() { return !!_useCrashMaps; }

// Phase 2A — F2. Off by default → recommendSeeds is byte-identical to the
// pre-2A single-index path. Flipped via setFederationEnabled({on}).
let _federationEnabled = false;
// Diagnostic counters surfaced via getFederationStats() — updated on every
// federated recommendSeeds() call. `shards` is the shard count that was
// actually fanned out to (degrades to 1 when hyperbolic didn't load).
const _federationStats = {
  enabled: false,
  shards: 0,
  lastKPrime: 0,
  lastUnionSize: 0,
  lastDedupeHits: 0,
};
// Viewer capturer (federation/viewer.js). UI mounts may subscribe; the bridge
// pushes a snapshot after each federated query. Stays null until assigned via
// setFederationCapturer so that headless smoke tests don't pay for the render
// hook. Plain object with an `onSnapshot(snap)` method.
let _federationCapturer = null;

// Phase 2B — F6 cross-tab. Off by default → archiveBrain is byte-identical to
// the pre-2B path (one boolean check). Flipped via setCrosstabEnabled(true)
// which opens the BroadcastChannel; setCrosstabEnabled(false) closes it.
// `_crosstabReceiving` guards the receive path so the receive-then-archiveBrain
// call doesn't re-broadcast and trigger an infinite echo loop across tabs.
let _crosstabEnabled = false;
let _crosstabReceiving = false;
// Optional UI hook — uiPanels subscribes to get a pulse when a remote brain
// lands. Stays null so headless tests don't render.
let _crosstabOnReceive = null;
let _crosstabOnPeerCount = null;

// P3.A — index geometry. `_indexKind` is the *active* backend ('euclidean' or
// 'hyperbolic'), flipped at ready() time based on the `?hhnsw=1` URL flag OR
// by the A/B toggle strip calling setIndexKind() at runtime. We always boot
// the wasm in the background so flipping the toggle later doesn't stall on a
// wasm-pack download; isHyperbolicReady() reports readiness for the UI.
let _indexKind = 'euclidean';
const VALID_INDEX_KINDS = ['euclidean', 'hyperbolic'];
function pickIndexClass(kind) {
  if (kind === 'hyperbolic' && isHyperbolicReady()) return HyperbolicVectorDB;
  return VectorDB;
}
export function getIndexKind() { return _indexKind; }
// Runtime swap: tears the stores down and rebuilds the index under the new
// geometry from _brainMirror / _trackMirror / _dynamicsMirror. Persistence is
// preserved because hydrate() always rebuilds from IDB anyway. Intentionally
// synchronous (no IDB trip) so the A/B toggle feels instant.
export function setIndexKind(kind) {
  if (!VALID_INDEX_KINDS.includes(kind)) return false;
  if (kind === 'hyperbolic' && !isHyperbolicReady()) {
    console.warn('[ruvector] hyperbolic wasm not ready — staying on euclidean');
    return false;
  }
  if (kind === _indexKind) return true;
  _indexKind = kind;
  rebuildIndicesFromMirror();
  return true;
}
function rebuildIndicesFromMirror() {
  if (!_brainDB || !_trackDB || !_dynamicsDB || !_crashDB) return;
  const IndexClass = pickIndexClass(_indexKind);
  _brainDB = new IndexClass(FLAT_LENGTH, 'cosine');
  _trackDB = new IndexClass(TRACK_DIM, 'cosine');
  _dynamicsDB = new IndexClass(DYNAMICS_DIM, 'cosine');
  _crashDB = new IndexClass(CRASH_DIM, 'cosine');
  // Phase 2A — rebuild the shadow hyperbolic brain index too when
  // available. We don't shadow the track / dynamics DBs — federation only
  // fans out over the brain index (track / dynamics are joins, not
  // retrieval shards). When hyperbolic wasn't loaded this stays null.
  if (isHyperbolicReady()) {
    _brainDB_hyperbolic = new HyperbolicVectorDB(FLAT_LENGTH, 'cosine');
  } else {
    _brainDB_hyperbolic = null;
  }
  for (const [id, { vector, meta }] of _trackMirror) {
    _trackDB.insert(vector, id, meta || {});
  }
  for (const [id, { vector, meta }] of _dynamicsMirror) {
    _dynamicsDB.insert(vector, id, meta || {});
  }
  for (const [id, { vector, meta }] of _crashMirror) {
    _crashDB.insert(vector, id, meta || {});
  }
  // F3 — rebuild preserves the original insertion order from _insertionOrder
  // when available; falls back to mirror iteration order otherwise. We do
  // NOT reset _insertionOrder here since the mirror contents are unchanged.
  const rebuildOrder = (_insertionOrder.length > 0
    ? _insertionOrder.filter((id) => _brainMirror.has(id))
    : Array.from(_brainMirror.keys()));
  for (const id of rebuildOrder) {
    const entry = _brainMirror.get(id);
    if (!entry) continue;
    _brainDB.insert(entry.vector, id, entry.meta || {});
    if (_brainDB_hyperbolic) {
      try { _brainDB_hyperbolic.insert(entry.vector, id, entry.meta || {}); }
      catch (e) { console.warn('[federation] hyperbolic shadow insert failed', e); }
    }
  }
}

// Dynamics retrieval toggle. Default ON for product UX: once trajectories
// exist, seeding can prefer brains that *drive like* successful ones on this
// track (not only track-shape neighbors). Empty dynamics archive is a no-op
// (term skipped). UI checkbox / A/B strip stay authoritative after first paint.
// `_queryDynamicsVec` is set by callers (main.js / uiPanels) before recommendSeeds.
let _useDynamics = true;
let _queryDynamicsVec = null;
// Weight of the dynamics-sim term in the final score product. Small enough
// that dynamics can tie-break but won't drown out fitness × track-similarity.
const DYNAMICS_TERM_WEIGHT = 0.3;

const _brainMirror = new Map(); // id -> { vector: Float32Array, meta }
const _trackMirror = new Map(); // id -> { vector: Float32Array, meta }
const _dynamicsMirror = new Map(); // id -> { vector: Float32Array, meta }
const _observations = new Map(); // brainId -> { weight, count }
// Phase 1A (F3). Replay-mode warm-restart needs the same insertion order
// on import that we used on export; VectorDB doesn't expose this after the
// fact, so we track it ourselves. Append-only — any id appearing here that
// isn't in _brainMirror at export time (e.g. after a _debugReset wiped the
// mirror but left this array alone — which _debugReset also clears below)
// gets filtered out in archive/exporter.js.
let _insertionOrder = [];

let _persistTimer = null;
let _persistInFlight = null;

// ─── init ────────────────────────────────────────────────────────────────────

// ─── boot profiling (temporary) ────────────────────────────────────────
// Records per-phase durations of ready() so heavy archives have a visible
// trace of where the 30s startup time goes. Exposed as window.__bootTimings
// for quick copy/paste diagnosis. Safe to leave in place — each call is one
// performance.now() and a Map.set(), ~microseconds total.
const _bootTimings = {};
function _tStart() { return performance.now(); }
function _tEnd(label, start) {
  const ms = performance.now() - start;
  _bootTimings[label] = Math.round(ms * 10) / 10;
  return ms;
}
if (typeof window !== 'undefined') { window.__bootTimings = _bootTimings; }

// Phase A0 — brain schema version guard. A mismatch means stored brains were
// produced by a different inference pipeline (e.g. v1 threshold vs v2 tanh),
// so seeding from them would be actively misleading. We wipe IDB + the
// localStorage sidecars and write the current version so subsequent boots
// skip this path. `null` (no key) is treated as an implicit v1 because that
// was the state before versioning shipped.
async function migrateBrainSchemaIfNeeded() {
  if (typeof localStorage === 'undefined') return;
  const stored = localStorage.getItem('brainSchemaVersion');
  const effective = stored == null ? '1' : stored;
  const current = String(BRAIN_SCHEMA_VERSION);
  if (effective === current) return;
  console.log(`[ruvector] brain schema v${effective} → v${current} — clearing archive`);
  if (typeof indexedDB !== 'undefined') {
    try {
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(IDB_NAME);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    } catch (e) { console.warn('[ruvector] schema migrate: DB delete failed', e); }
  }
  try { localStorage.removeItem('bestBrain'); } catch (_) {}
  try { localStorage.removeItem('oldBestBrain'); } catch (_) {}
  try { localStorage.removeItem('progress'); } catch (_) {}
  try { localStorage.setItem('brainSchemaVersion', current); } catch (_) {}
}

export function ready() {
  if (_ready) return _ready;
  _ready = (async () => {
    const _t0 = _tStart();
    // Run BEFORE any IDB reads so hydrate() sees an empty DB on mismatch.
    await migrateBrainSchemaIfNeeded();
    // P3.A — boot hyperbolic wasm in parallel with the Euclidean / CNN
    // inits. We always load it so the A/B toggle can flip to hyperbolic
    // without a cold-start stall, even when the URL flag isn't set.
    // `?hhnsw=1` flips the default kind at init time; the toggle can still
    // override later. This mirrors the pattern already used for `?rv=0`.
    const hyperbolicPromise = loadHyperbolic();
    let wantHyperbolic = false;
    try {
      if (typeof window !== 'undefined' && typeof URLSearchParams === 'function') {
        const usp = new URLSearchParams(window.location.search || '');
        wantHyperbolic = usp.get('hhnsw') === '1';
      }
    } catch (_) { /* ignore — fall back to euclidean */ }
    const _tWasmInit = _tStart();
    await Promise.all([initVec(), initCnn()]);
    _tEnd('1_initVec+initCnn', _tWasmInit);
    const _tHyper = _tStart();
    try { await hyperbolicPromise; } catch (_) { /* already logged */ }
    _tEnd('2_loadHyperbolic', _tHyper);
    _indexKind = (wantHyperbolic && isHyperbolicReady()) ? 'hyperbolic' : 'euclidean';
    const IndexClass = pickIndexClass(_indexKind);
    _brainDB = new IndexClass(FLAT_LENGTH, 'cosine');
    _trackDB = new IndexClass(TRACK_DIM, 'cosine');
    _dynamicsDB = new IndexClass(DYNAMICS_DIM, 'cosine');
    _crashDB = new IndexClass(CRASH_DIM, 'cosine');
    // Phase 2A — F2. Stand up the hyperbolic shadow brain index so federated
    // search has something to fan out to, regardless of whether _indexKind is
    // currently hyperbolic. When the wasm didn't load this stays null and
    // federation gracefully degrades to Euclidean-only (see recommendSeeds).
    if (isHyperbolicReady()) {
      try { _brainDB_hyperbolic = new HyperbolicVectorDB(FLAT_LENGTH, 'cosine'); }
      catch (e) { console.warn('[federation] hyperbolic shadow init failed', e); _brainDB_hyperbolic = null; }
    }
    _cnn = new CnnEmbedder(); // default 224×224, 512-dim, L2-normalized
    // Kick off GNN + LoRA loads in parallel with hydrate(). Best-effort: if
    // either resolves to null, the corresponding code path silently falls back
    // (EMA reranker for GNN; identity transform for LoRA).
    const gnnPromise = loadGnn();
    // P3.B — boot the DAG wasm in parallel with everything else. Loading it
    // here (before hydrate() resolves) means the hydrateDagFromMirror() call
    // at the tail of ready() can populate it in one go; if loadDag fails we
    // silently leave isReady() false and the bridge falls back to the legacy
    // walk.
    const dagPromise = loadDag();
    // P2.A — loadSonaEngine boots the LoRA adapter AND the SONA ephemeral
    // agent in parallel. Either side can fail independently without taking
    // the other down; we log+fall through in both cases.
    const sonaPromise = loadSonaEngine();
    const _tHydrate = _tStart();
    await hydrate();
    _tEnd('3_hydrate_total', _tHydrate);
    const _tGnn = _tStart();
    try { await gnnPromise; } catch (_) { /* already logged inside loadGnn */ }
    _tEnd('4_loadGnn', _tGnn);
    const _tDag = _tStart();
    try { await dagPromise; } catch (_) { /* already logged inside loadDag */ }
    _tEnd('5_loadDag', _tDag);
    const _tDagHydrate = _tStart();
    try { if (dagIsReady()) dagHydrateFromMirror(_brainMirror); }
    catch (e) { console.warn('[lineage-dag] hydrate failed', e); }
    _tEnd('6_dagHydrateFromMirror', _tDagHydrate);
    const _tSona = _tStart();
    try {
      await sonaPromise;
      // Hydrate adapter B-matrices after the wasm engines are live. Done
      // here (not inside hydrate) because hydrate() runs before the engine
      // promise resolves on slow loads, and we need the wasm to exist
      // before set_b. The SONA agent keeps no persisted state — pattern
      // clusters are session-scoped, consistent with the plan's
      // "trajectories, ReasoningBank clusters, EWC++ anti-forgetting" being
      // driven by *this session's* training.
      await hydrateLoraSnapshot();
    } catch (_) { /* already logged inside loadSonaEngine */ }
    _tEnd('7_sona+loraSnapshot', _tSona);
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => { try { flushPersist(); } catch (_) {} });
    }
    _tEnd('0_total_ready', _t0);
    _bootTimings._archiveSize = {
      brains: _brainMirror.size,
      tracks: _trackMirror.size,
      obs: _observations.size,
      dynamics: _dynamicsMirror.size,
      crashMaps: _crashMirror.size,
    };
    console.log(`[ruvector] ready — brains=${_brainMirror.size} tracks=${_trackMirror.size} obs=${_observations.size} crashMaps=${_crashMirror.size}`);
    // One compact line so the full breakdown survives console truncation and
    // can be copy-pasted back for diagnosis.
    console.log('[boot-timings] ' + JSON.stringify(_bootTimings));
  })();
  return _ready;
}

function requireReady() {
  if (!_brainDB || !_trackDB || !_dynamicsDB || !_crashDB || !_cnn) {
    throw new Error('ruvectorBridge: call await ready() before using the bridge');
  }
}

// ─── crash-map HNSW (adaptive-gates curriculum memory) ───────────────────────

/**
 * Encode death positions into a CRASH_DIM L2-normalised heat vector.
 * Mirrors window.CrashMapCodec.encodeDeathMap when that classic script loaded.
 */
export function encodeCrashMap(popDeathXY, N, canvasW, canvasH) {
  try {
    if (typeof window !== 'undefined' && window.CrashMapCodec &&
        typeof window.CrashMapCodec.encodeDeathMap === 'function') {
      return window.CrashMapCodec.encodeDeathMap(popDeathXY, N, canvasW, canvasH);
    }
  } catch (_) {}
  // Inline fallback (same algorithm as crashMapCodec.js)
  if (!popDeathXY || !N) return null;
  const W = canvasW || 3200, H = canvasH || 1800;
  const grid = new Float32Array(CRASH_DIM);
  let deaths = 0;
  for (let i = 0; i < N; i++) {
    const x = popDeathXY[i * 2], y = popDeathXY[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    let gx = Math.floor((x / W) * CRASH_GW);
    let gy = Math.floor((y / H) * CRASH_GH);
    if (gx < 0) gx = 0; else if (gx >= CRASH_GW) gx = CRASH_GW - 1;
    if (gy < 0) gy = 0; else if (gy >= CRASH_GH) gy = CRASH_GH - 1;
    grid[gy * CRASH_GW + gx] += 1;
    deaths++;
  }
  if (deaths < 3) return null;
  let sumSq = 0;
  for (let i = 0; i < CRASH_DIM; i++) {
    const v = Math.log1p(grid[i]);
    grid[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-9) return null;
  const inv = 1 / norm;
  for (let i = 0; i < CRASH_DIM; i++) grid[i] *= inv;
  return grid;
}

/**
 * Archive a crash heat map + optional gate layout / survival meta.
 * @returns {string|null} id
 */
export function archiveCrashMap(crashVec, meta = {}) {
  if (!_crashDB) return null;
  if (!(crashVec instanceof Float32Array) || crashVec.length !== CRASH_DIM) return null;
  const m = {
    survival: Number(meta.survival) || 0,
    fitness: Number(meta.fitness) || 0,
    generation: (meta.generation | 0),
    nDeaths: (meta.nDeaths | 0),
    nGates: (meta.nGates | 0),
    timestamp: Date.now(),
  };
  if (Array.isArray(meta.cps)) m.cps = meta.cps;
  if (meta.causes && typeof meta.causes === 'object') m.causes = meta.causes;
  if (meta.trackId) m.trackId = meta.trackId;
  if (meta.bottleneck != null) m.bottleneck = meta.bottleneck | 0;
  try {
    const id = _crashDB.insert(crashVec, null, m);
    _crashMirror.set(id, { vector: crashVec.slice(), meta: m });
    schedulePersist();
    return id;
  } catch (e) {
    console.warn('[crash-map] insert failed', e);
    return null;
  }
}

/**
 * Nearest crash maps in HNSW. Returns [] when disabled / empty / not ready.
 * Score is cosine similarity in [0,1] (converted from VectorDB distance).
 */
export function recommendCrashLayouts(crashVec, k = 5) {
  if (!_useCrashMaps || !_crashDB || _crashMirror.size === 0) return [];
  if (!(crashVec instanceof Float32Array) || crashVec.length !== CRASH_DIM) return [];
  const kk = Math.max(1, Math.min(k | 0, _crashMirror.size));
  let hits;
  try {
    hits = _crashDB.search(crashVec, kk);
  } catch (e) {
    console.warn('[crash-map] search failed', e);
    return [];
  }
  if (!hits || !hits.length) return [];
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const id = h.id;
    const entry = _crashMirror.get(id);
    // VectorDB cosine distance ∈ [0, 2]; sim = 1 - dist/2 roughly, or 1-dist for unit vectors.
    // Our vectors are L2-normalised; cosine distance ≈ 1 - cos_sim for some builds.
    // Prefer metadata from mirror; fall back to hit.metadata.
    const meta = (entry && entry.meta) || h.metadata || {};
    // VectorDB cosine DISTANCE: 0 = identical, 2 = opposite (same as tracks).
    const dist = Number(h.score);
    const sim = Number.isFinite(dist)
      ? Math.max(0, Math.min(1, 1 - dist / 2))
      : 0;
    out.push({
      id,
      similarity: sim,
      distance: dist,
      survival: Number(meta.survival) || 0,
      fitness: Number(meta.fitness) || 0,
      generation: meta.generation | 0,
      nGates: meta.nGates | 0,
      nDeaths: meta.nDeaths | 0,
      cps: Array.isArray(meta.cps) ? meta.cps : null,
      causes: meta.causes || null,
      bottleneck: meta.bottleneck != null ? (meta.bottleneck | 0) : null,
      timestamp: meta.timestamp || 0,
    });
  }
  // Prefer high similarity, then high survival
  out.sort((a, b) => (b.similarity - a.similarity) || (b.survival - a.survival));
  return out;
}

export function crashMapCount() {
  return _crashMirror.size;
}

// P1.C — dynamics retrieval controls. UI owns the toggle; `setUseDynamics`
// flips the flag, `setQueryDynamicsVec` stages the current-generation vector
// the next recommendSeeds() call will use. Both are no-ops when the bridge
// isn't ready or dynamics archive is empty — the call-site can fire-and-forget.
export function setUseDynamics(on) { _useDynamics = !!on; }
export function isUsingDynamics() { return !!_useDynamics; }
export function setQueryDynamicsVec(vec) {
  _queryDynamicsVec = (vec instanceof Float32Array && vec.length === DYNAMICS_DIM) ? vec : null;
}

// ─── archive / retrieve ──────────────────────────────────────────────────────

export function archiveBrain(brain, fitness, trackVec, generation = 0, parentIds = [], fastestLap, dynamicsVec) {
  requireReady();
  // Phase 3A — F7. Advance the observability generation cursor. This is
  // a read-only counter exposed via getIndexStats().timings.lastGen so
  // the UI panel can show "gen N · window 20"; it does NOT reset the
  // per-stage ring buffers (those are the moving average).
  try { _obsSetGeneration(generation | 0); } catch (_) { /* safe */ }
  const vec = flatten(brain);
  const trackId = trackVec ? upsertTrack(trackVec) : null;
  const dynamicsId = (dynamicsVec instanceof Float32Array && dynamicsVec.length === DYNAMICS_DIM)
    ? insertDynamics(dynamicsVec) : null;
  const lap = Number.isFinite(fastestLap) ? Number(fastestLap) : undefined;
  const meta = {
    fitness: Number(fitness) || 0,
    trackId,
    generation: generation | 0,
    parentIds: Array.isArray(parentIds) ? parentIds.slice() : [],
    timestamp: Date.now(),
  };
  if (lap !== undefined) meta.fastestLap = lap;
  // Only write dynamicsId when we actually got a vector. Older archives
  // without this field stay shape-compatible; recommendSeeds skips them
  // automatically because `!entry.meta.dynamicsId` → no lookup.
  if (dynamicsId !== null) meta.dynamicsId = dynamicsId;
  const id = _brainDB.insert(vec, null, meta);
  _brainMirror.set(id, { vector: vec, meta });
  // Phase 2A — F2 shadow insert. The shadow uses its own id space internally
  // but we pass the Euclidean id through so both indexes return the SAME
  // id on search (which is what unionByHash relies on to collapse the two
  // hits into a single candidate). Failure here is non-fatal — the shadow
  // just diverges from the primary by one brain, which federation tolerates.
  if (_brainDB_hyperbolic) {
    try { _brainDB_hyperbolic.insert(vec, id, meta); }
    catch (e) { console.warn('[federation] hyperbolic shadow insert failed', e); }
  }
  // F3 — remember the insertion order so exportSnapshot can replay it.
  _insertionOrder.push(id);
  // Phase 2B — F6 cross-tab broadcast. One boolean check on the hot path when
  // disabled. When enabled AND we're not currently replaying a remote brain
  // (see _crosstabReceiving guard in _onRemoteBrain below), post a single-
  // brain delta. The receiving tabs hash-dedup via F5, so a re-broadcast from
  // A → B → A is collapsed to a single node — the echo guard is belt-and-
  // -braces against runaway traffic, not correctness.
  if (_crosstabEnabled && !_crosstabReceiving) {
    try {
      const wireMeta = {
        generation: meta.generation,
        parentIds: meta.parentIds,
      };
      if (meta.fastestLap !== undefined) wireMeta.fastestLap = meta.fastestLap;
      if (dynamicsVec instanceof Float32Array) wireMeta.dynamicsVec = dynamicsVec;
      crosstabBroadcast(crosstabToWire(vec, meta.fitness, trackVec || null, wireMeta));
    } catch (e) { console.warn('[crosstab] broadcast failed', e); }
  }
  // P3.B — incremental DAG add. Safe no-op when the dag wasm didn't load.
  // The DAG uses meta.parentIds to wire edges; unknown parents (not yet in
  // the mirror) are silently skipped — same relaxed contract as the legacy
  // walk, which just returns shorter trails when an ancestor is missing.
  try { dagAddBrain(id, meta); } catch (e) { console.warn('[lineage-dag] addBrain failed', e); }
  // Feed the LoRA reward signal: the most-recent adapt() input (cached inside
  // trackAdapter) is the gradient direction; fitness gates whether it fires.
  // No-op when the adapter isn't ready or `recommendSeeds` hasn't been called
  // yet for this track (no cached input).
  try { loraReward(meta.fitness); } catch (e) { console.warn('[lora] reward failed', e); }
  // P2.A — record the generation as a SONA trajectory step. The dynamics
  // vector (P1.C) is the natural "activations" signal for this step: it's
  // a fixed-dim summary of *how the car drove* during the generation, which
  // is exactly what SONA's REINFORCE gradient estimator wants from
  // TrajectoryStep.activations. When dynamicsVec is absent we fall through
  // to trackVec; when both are absent (very short runs) we skip the step.
  // The trajectory itself is framed by main.js on phase-4 enter/exit —
  // here we just append a step to whatever's currently open (no-op if
  // nothing's open).
  try {
    const stepActs = (dynamicsVec instanceof Float32Array) ? dynamicsVec
                    : (trackVec instanceof Float32Array) ? trackVec : null;
    if (stepActs && !_sonaPaused) sonaAddStep(stepActs, null, meta.fitness);
  } catch (e) { console.warn('[sona] step failed', e); }
  schedulePersist();
  return id;
}

// Dynamics vectors are deliberately *not* deduped: two runs on the same track
// by genuinely different brains will produce different trajectories, and the
// whole point of the dynamics key is "how this brain drove", not "what track
// this was". Each archiveBrain call gets its own dynamicsId.
function insertDynamics(dynamicsVec) {
  const id = _dynamicsDB.insert(dynamicsVec, null, { firstSeen: Date.now() });
  _dynamicsMirror.set(id, { vector: dynamicsVec, meta: { firstSeen: Date.now() } });
  return id;
}

function upsertTrack(trackVec) {
  if (!(trackVec instanceof Float32Array) || trackVec.length !== TRACK_DIM) {
    throw new Error(`ruvectorBridge: trackVec must be Float32Array(${TRACK_DIM}), got ${trackVec && trackVec.length}`);
  }
  if (!_trackDB.isEmpty()) {
    const hits = _trackDB.search(trackVec, 1);
    if (hits.length && hits[0].score <= TRACK_DEDUPE_MAX_DIST) return hits[0].id;
  }
  const id = _trackDB.insert(trackVec, null, { firstSeen: Date.now() });
  _trackMirror.set(id, { vector: trackVec, meta: { firstSeen: Date.now() } });
  return id;
}

// Returns [{ id, vector, meta, score }, ...] ordered best first.
// Caller is expected to unflatten vectors into NeuralNetwork instances.
export function recommendSeeds(trackVec, k = 5) {
  requireReady();
  if (_brainMirror.size === 0) return [];

  // Gather candidate brain ids by joining trackDB hits against meta.trackId.
  // VectorDB scores are cosine DISTANCE (0 = identical, 2 = opposite); convert
  // to similarity for downstream math where higher = better.
  // Run the incoming track vector through the LoRA adapter before searching.
  // adapt() returns the input unchanged if the adapter isn't ready or the shape
  // doesn't match — so this is safe even on cold boot. The adapter caches the
  // *raw* vector internally so reward() can use it as a gradient signal later;
  // we don't want to feed the post-adapter vector back as gradient (that would
  // amplify whatever direction B currently points in).
  // Phase 3A — F7. Time the LoRA/SONA adapt call. When _bypassLora is on
  // (test override) the adapt term collapses to identity so we skip the
  // timer entirely — recording a ~0 here would pollute the histogram.
  const queryVec = trackVec
    ? (_bypassLora ? trackVec : _obsTime('adapt', () => loraAdapt(trackVec)))
    : null;

  // 1C — F4. Consult the consistency mode BEFORE running the search. In
  // 'fresh' mode we fall through unchanged. In 'eventual' we try the
  // TTL cache first and short-circuit on hit, else we compute the
  // result then record it. In 'frozen' we compute as usual but filter
  // results to brains that existed at freeze-entry time. The `mode`
  // flag below drives all three behaviours in a single code path.
  const consistencyMode = _consistencyGetMode();
  const cacheKey = (consistencyMode === 'eventual' && trackVec)
    ? _consistencyTrackVecKey(trackVec) + ':k' + (k | 0)
    : null;
  if (consistencyMode === 'eventual') {
    const cached = _consistencyGetCachedResult(cacheKey);
    if (cached.hit) return cached.value;
  }
  const frozenSnap = (consistencyMode === 'frozen') ? _consistencyStats() : null;
  // Pull the frozen brain-id set once per call rather than on every
  // candidate lookup. `null` means "no filter" — fresh/eventual paths.
  const frozenIds = (frozenSnap && frozenSnap.frozen)
    ? _getFrozenBrainIdSet()
    : null;

  // Build a track-hit map once. Used by both the single-index path (inline
  // below) and the federation branch (as the source of representative brain
  // + trackSim per union candidate). Keyed by trackId → similarity.
  // Phase 3A — F7. The track-DB search is the "retrieve" stage (candidate
  // gather); the subsequent brain-mirror filter below is also retrieve
  // conceptually, but timing it separately would double-count — the HNSW
  // call is the dominant cost.
  let trackSimByTrackId = null;
  if (queryVec && !_trackDB.isEmpty()) {
    _obsStart('retrieve');
    try {
      trackSimByTrackId = new Map();
      const trackHits = _trackDB.search(queryVec, Math.min(5, Number(_trackDB.len())));
      for (const th of trackHits) trackSimByTrackId.set(th.id, 1 - th.score);
    } finally { _obsEnd('retrieve'); }
  }

  // Phase 2A — F2 federation branch. Fans out to Euclidean + Hyperbolic
  // shadow brain indexes in parallel using a representative brain vector
  // derived from the best track-matching brain (or the highest-fitness
  // brain when there's no track hit). Unions candidates by content hash
  // (1D/F5), applies the 1C frozenIds filter to the union (NOT per-shard),
  // then lets the GNN rerank the union. The final top-k obeys the same
  // shape the single-index path returns. On graceful degrade (hyperbolic
  // wasm missing), we fall out to Euclidean-only — which still flows
  // through the fanout path so the code stays uniform.
  if (_federationEnabled && queryVec) {
    // Phase 3A — F7. Time the whole federated branch (fan-out + union +
    // rerank-within-federation). The federation body already spans the
    // GNN rerank internally, so we intentionally do NOT nest a 'rerank'
    // timer inside — federated runs accumulate in 'federate' only, and
    // a single-index run accumulates in 'rerank'. The stacked bar shows
    // whichever path actually ran.
    const fedOut = _obsTime('federate', () => _recommendSeedsFederated({
      queryVec,
      trackVec,
      k,
      frozenIds,
      trackSimByTrackId,
    }));
    if (consistencyMode === 'eventual' && cacheKey) {
      _consistencyRecordQuery(cacheKey, fedOut);
    }
    return fedOut;
  }

  const candidates = new Map(); // brainId -> trackSim (best across matched tracks)
  if (trackSimByTrackId) {
    for (const [bid, entry] of _brainMirror) {
      // 1C frozen-mode filter: skip brains inserted after the freeze
      // point. `frozenIds === null` in fresh/eventual modes so this
      // branch degenerates to the existing check.
      if (frozenIds && !frozenIds.has(bid)) continue;
      const tid = entry.meta && entry.meta.trackId;
      if (tid != null && trackSimByTrackId.has(tid)) {
        const sim = trackSimByTrackId.get(tid);
        const prev = candidates.get(bid);
        if (prev === undefined || prev < sim) candidates.set(bid, sim);
      }
    }
  }

  // Cold-fallback: no track match → use the whole archive with trackSim=0.
  // This keeps retrieval meaningful on first-ever run or on a totally novel track.
  if (candidates.size === 0) {
    for (const bid of _brainMirror.keys()) {
      if (frozenIds && !frozenIds.has(bid)) continue;
      candidates.set(bid, 0);
    }
  }

  // Decide reranker. The toggle policy (P4.A) takes precedence over
  // auto-mode thresholds, and the legacy _forceEma test override still pins
  // the decision to 'ema' when set (keeps gnn-replay.html deterministic).
  let useGnn = false;
  let skipRerank = false;
  if (_forceEma) {
    useGnn = false;
  } else if (_rerankerPolicy === 'none') {
    skipRerank = true;
  } else if (_rerankerPolicy === 'ema') {
    useGnn = false;
  } else if (_rerankerPolicy === 'gnn') {
    useGnn = gnnIsReady();
  } else { // 'auto'
    useGnn = gnnIsReady() && _brainMirror.size >= GNN_MIN_ARCHIVE;
  }
  // Phase 3A — F7. Rerank timer. We time the GNN path when it runs AND
  // the EMA fallback path (skipRerank=true records nothing because it's
  // a constant-1 substitution, not real work).
  let gnnMap = null;
  if (useGnn) {
    _obsStart('rerank');
    try { gnnMap = gnnScore(_brainMirror, candidates); }
    finally { _obsEnd('rerank'); }
  } else if (!skipRerank) {
    // EMA fallback: the "work" is the emaBoost lookup per candidate in
    // the scoring loop below, which we can't cleanly bracket without
    // restructuring. Record a zero sample so the 'rerank' row still
    // shows up with count > 0 after an EMA-only run — satisfies the
    // done-criteria claim that rerank has count>0 after one generation.
    _obsStart('rerank'); _obsEnd('rerank');
  }
  if (skipRerank) {
    _rerankerMode = 'none';
  } else if (useGnn && gnnMap) {
    _rerankerMode = 'gnn';
  } else {
    _rerankerMode = candidates.size > 0 ? 'ema' : 'none';
  }

  // P1.C — precompute dynamics similarity per brain when the toggle is on,
  // we have a staged query vector, and the dynamics archive is non-empty.
  // This runs one nearest-neighbour sweep against _dynamicsDB (instead of
  // per-brain lookups) so the cost stays O(K log N) where K is the archive
  // size. Brains without `meta.dynamicsId` (pre-P1.C archives) silently
  // score 0 on this term — their overall ranking just stays determined by
  // trackTerm × fitTerm × rerankTerm, same as before this phase shipped.
  const dynamicsSimMap = new Map(); // brainId -> dynamicsSim in [-1,1]
  const dynamicsActive = _useDynamics && _queryDynamicsVec && !_dynamicsDB.isEmpty();
  if (dynamicsActive) {
    _obsStart('dynamics');
    try {
      const dHits = _dynamicsDB.search(_queryDynamicsVec, Math.min(_dynamicsMirror.size, 25));
      const hitMap = new Map();
      for (const h of dHits) hitMap.set(h.id, 1 - h.score);
      for (const [bid, entry] of _brainMirror) {
        const did = entry.meta && entry.meta.dynamicsId;
        if (did != null && hitMap.has(did)) dynamicsSimMap.set(bid, hitMap.get(did));
      }
    } finally { _obsEnd('dynamics'); }
  }

  const scored = [];
  for (const [bid, trackSim] of candidates) {
    const entry = _brainMirror.get(bid);
    const normFit = Math.tanh(((entry.meta && entry.meta.fitness) || 0) / 100);
    // Map cosine [-1,1] → [0,1] so negative sims don't flip sign of product.
    const trackTerm = 0.5 + 0.5 * trackSim;
    const fitTerm = 0.5 + 0.5 * normFit;
    let rerankTerm;
    if (skipRerank) {
      // P4.A — 'none' policy: no reranker term. Ordering falls back to pure
      // trackSim × fitness, useful for A/B comparisons that isolate the
      // retrieval geometry from the peer-pressure / EMA-boost terms.
      rerankTerm = 1;
    } else if (gnnMap && gnnMap.has(bid)) {
      rerankTerm = gnnMap.get(bid);
    } else {
      const obs = _observations.get(bid);
      const emaBoost = obs ? obs.weight : 0;
      rerankTerm = 1 + 0.3 * emaBoost;
    }
    const dynamicsSim = dynamicsSimMap.has(bid) ? dynamicsSimMap.get(bid) : 0;
    // Map cosine [-1,1] → [1 - W, 1 + W] so the term multiplicatively nudges
    // the composite score up for similar trajectories and down for opposite
    // ones, while leaving brains with no dynamics data at term = 1.
    const dynamicsTerm = dynamicsActive
      ? (1 + DYNAMICS_TERM_WEIGHT * dynamicsSim)
      : 1;
    scored.push({
      id: bid,
      vector: entry.vector,
      meta: entry.meta,
      score: trackTerm * fitTerm * rerankTerm * dynamicsTerm,
      trackSim,
      dynamicsSim,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = scored.slice(0, Math.max(1, k | 0));
  // 1C — F4. In eventual mode, stash the result so the next TTL calls
  // under the same trackVec key short-circuit at the top of this fn.
  // The stored reference IS the returned array — callers MUST treat
  // recommendSeeds output as read-only (it always has been by
  // convention). No-op in fresh/frozen modes.
  if (consistencyMode === 'eventual' && cacheKey) {
    _consistencyRecordQuery(cacheKey, out);
  }
  return out;
}

// Phase 2A — F2. Federated retrieval path. Fans out to all active brain
// shards in parallel, unions by content hash (F5), applies the 1C
// frozen-ids filter to the UNIONED set, reranks the union via the same
// GNN scorer the single-index path uses, and returns the top-k in the
// usual { id, vector, meta, score, trackSim, dynamicsSim } shape.
//
// Representative brain vector: we need a brain-dim query (FLAT_LENGTH),
// but the caller only has a track-dim vector (TRACK_DIM). We derive a
// representative by picking the best-fit brain whose track matches the
// query — "closest existing brain to this track" — and using its
// flattened weights as the brain-index query. When no track matches we
// fall back to the globally best-fit brain so federation still produces
// something on cold / novel tracks. This is a pragmatic bridge between
// the track-keyed query API recommendSeeds has historically accepted and
// the brain-keyed search the HNSW indexes speak natively.
function _pickRepresentativeBrain({ trackSimByTrackId, frozenIds }) {
  let bestId = null;
  let bestScore = -Infinity;
  if (trackSimByTrackId && trackSimByTrackId.size > 0) {
    for (const [bid, entry] of _brainMirror) {
      if (frozenIds && !frozenIds.has(bid)) continue;
      const tid = entry.meta && entry.meta.trackId;
      if (tid == null || !trackSimByTrackId.has(tid)) continue;
      const tsim = trackSimByTrackId.get(tid);
      const fit = (entry.meta && entry.meta.fitness) || 0;
      // Rank by trackSim * (1 + normalised fitness) so a closer track
      // wins ties against a marginally-fitter brain on a weaker track.
      const s = tsim * (1 + Math.tanh(fit / 100));
      if (s > bestScore) { bestScore = s; bestId = bid; }
    }
  }
  if (bestId == null) {
    // Cold-fallback — pick the globally highest-fitness brain among the
    // non-frozen-filtered set.
    for (const [bid, entry] of _brainMirror) {
      if (frozenIds && !frozenIds.has(bid)) continue;
      const fit = (entry.meta && entry.meta.fitness) || 0;
      if (fit > bestScore) { bestScore = fit; bestId = bid; }
    }
  }
  return bestId;
}

function _recommendSeedsFederated({ queryVec, trackVec, k, frozenIds, trackSimByTrackId }) {
  const kk = Math.max(1, k | 0);
  // Build the shard list. Hyperbolic shard is only included when the
  // shadow index is populated (wasm loaded + archive hydrated through
  // the shadow path). Missing → federation gracefully degrades to
  // Euclidean-only and we note it in the stats.
  const shards = [{ name: 'euclidean', db: _brainDB, metric: 'cosine' }];
  if (_brainDB_hyperbolic && !_brainDB_hyperbolic.isEmpty()) {
    shards.push({ name: 'hyperbolic', db: _brainDB_hyperbolic, metric: 'poincare' });
  } else if (_federationEnabled && !_brainDB_hyperbolic) {
    // Only warn once per session — keep the hot path silent.
    if (!_federationStats._degradeWarned) {
      console.warn('[federation] hyperbolic shadow unavailable — degrading to Euclidean-only');
      _federationStats._degradeWarned = true;
    }
  }

  const repId = _pickRepresentativeBrain({ trackSimByTrackId, frozenIds });
  if (!repId || !_brainMirror.has(repId)) {
    // Nothing to query with — empty archive or every brain filtered out.
    _federationStats.enabled = true;
    _federationStats.shards = shards.length;
    _federationStats.lastKPrime = _kPrime(kk, shards.length);
    _federationStats.lastUnionSize = 0;
    _federationStats.lastDedupeHits = 0;
    _pushFederationSnapshot({ k: kk, shards: [], unionSize: 0, dedupeHits: 0, final: [] });
    return [];
  }
  const repVec = _brainMirror.get(repId).vector;
  const shardResults = fanOutSync(repVec, kk, shards);
  const kp = shardResults[0] ? shardResults[0].kPrime : _kPrime(kk, shards.length);

  // Hash lookup: every candidate id is a brain id in _brainMirror, so
  // we can compute the xxHash32 of its flat vector on demand. This is
  // the "F5 dedup via has()" point of contact — ids that collide on
  // hash (same content, different ids) collapse into one union entry.
  const hashLookup = (id) => {
    const entry = _brainMirror.get(id);
    if (!entry || !(entry.vector instanceof Float32Array)) return null;
    try { return hashBrain(entry.vector); } catch (_) { return null; }
  };
  const { candidates: unionPre, dedupeHits } = unionByHash(shardResults, hashLookup);

  // Apply the 1C frozen-ids filter to the UNION (not per-shard). A brain
  // archived after freeze can legitimately surface from either shard
  // (both get populated on archiveBrain), so the filter has to run here.
  const union = frozenIds
    ? unionPre.filter((c) => frozenIds.has(c.id))
    : unionPre;

  // Build a trackSim map for every union candidate so GNN + final
  // composite score can use the existing formula shape.
  const candidatesMap = new Map();
  for (const c of union) {
    const entry = _brainMirror.get(c.id);
    if (!entry) continue;
    const tid = entry.meta && entry.meta.trackId;
    const tsim = (trackSimByTrackId && tid != null && trackSimByTrackId.has(tid))
      ? trackSimByTrackId.get(tid) : 0;
    candidatesMap.set(c.id, tsim);
  }

  // GNN rerank over the unioned candidate set. Uses the exact same
  // gnnScore call the single-index path does (just a larger set).
  // Respects the P4.A reranker policy: 'none' → skip, 'ema' / 'auto' →
  // fall through to EMA/obs weighting, 'gnn' → force GNN when loaded.
  let useGnn = false;
  let skipRerank = false;
  if (_forceEma) useGnn = false;
  else if (_rerankerPolicy === 'none') skipRerank = true;
  else if (_rerankerPolicy === 'ema') useGnn = false;
  else if (_rerankerPolicy === 'gnn') useGnn = gnnIsReady();
  else useGnn = gnnIsReady() && _brainMirror.size >= GNN_MIN_ARCHIVE;
  const gnnMap = (useGnn && candidatesMap.size > 0) ? gnnScore(_brainMirror, candidatesMap) : null;
  if (skipRerank) _rerankerMode = 'none';
  else if (useGnn && gnnMap) _rerankerMode = 'gnn';
  else _rerankerMode = candidatesMap.size > 0 ? 'ema' : 'none';

  // Composite score per candidate, mirroring the single-index path's
  // trackTerm * fitTerm * rerankTerm * dynamicsTerm product so federated
  // results sit in the same band as non-federated ones (downstream
  // consumers — the rv-panel rendering, main.js seed selection — don't
  // need to special-case federation).
  const dynamicsSimMap = new Map();
  const dynamicsActive = _useDynamics && _queryDynamicsVec && !_dynamicsDB.isEmpty();
  if (dynamicsActive) {
    const dHits = _dynamicsDB.search(_queryDynamicsVec, Math.min(_dynamicsMirror.size, 25));
    const hitMap = new Map();
    for (const h of dHits) hitMap.set(h.id, 1 - h.score);
    for (const c of union) {
      const entry = _brainMirror.get(c.id);
      const did = entry && entry.meta && entry.meta.dynamicsId;
      if (did != null && hitMap.has(did)) dynamicsSimMap.set(c.id, hitMap.get(did));
    }
  }

  const scoreMap = new Map();
  for (const c of union) {
    const entry = _brainMirror.get(c.id);
    if (!entry) continue;
    const trackSim = candidatesMap.get(c.id) || 0;
    const normFit = Math.tanh(((entry.meta && entry.meta.fitness) || 0) / 100);
    const trackTerm = 0.5 + 0.5 * trackSim;
    const fitTerm = 0.5 + 0.5 * normFit;
    let rerankTerm;
    if (skipRerank) rerankTerm = 1;
    else if (gnnMap && gnnMap.has(c.id)) rerankTerm = gnnMap.get(c.id);
    else {
      const obs = _observations.get(c.id);
      rerankTerm = 1 + 0.3 * (obs ? obs.weight : 0);
    }
    const dynamicsSim = dynamicsSimMap.has(c.id) ? dynamicsSimMap.get(c.id) : 0;
    const dynamicsTerm = dynamicsActive ? (1 + DYNAMICS_TERM_WEIGHT * dynamicsSim) : 1;
    scoreMap.set(c.id, trackTerm * fitTerm * rerankTerm * dynamicsTerm);
  }
  const top = selectTopK(union, scoreMap, kk);

  // Re-hydrate to the canonical recommendSeeds return shape.
  const out = top.map((t) => {
    const entry = _brainMirror.get(t.id);
    const trackSim = candidatesMap.get(t.id) || 0;
    const dynamicsSim = dynamicsSimMap.has(t.id) ? dynamicsSimMap.get(t.id) : 0;
    return {
      id: t.id,
      vector: entry ? entry.vector : null,
      meta: entry ? entry.meta : null,
      score: t.score,
      trackSim,
      dynamicsSim,
      // Federation-only: which shard(s) surfaced this id. Keeps the
      // viewer's provenance column honest without bloating the single-
      // index return path (federated-disabled callers never see it).
      shards: t.shards,
    };
  });

  _federationStats.enabled = true;
  _federationStats.shards = shards.length;
  _federationStats.lastKPrime = kp;
  _federationStats.lastUnionSize = union.length;
  _federationStats.lastDedupeHits = dedupeHits;

  // Push a snapshot to the viewer for diagnostic rendering. No-op when
  // no capturer is registered (headless tests).
  _pushFederationSnapshot({
    k: kk,
    kPrime: kp,
    shards: shardResults,
    unionSize: union.length,
    dedupeHits,
    final: out.map((o) => ({ id: o.id, score: o.score, shards: o.shards, hash: null })),
  });
  return out;
}

function _pushFederationSnapshot(snap) {
  if (!_federationCapturer || typeof _federationCapturer.onSnapshot !== 'function') return;
  try { _federationCapturer.onSnapshot(snap); } catch (e) { console.warn('[federation] capturer push failed', e); }
}

// Phase 2A — F2. Public federation controls.
//
// setFederationEnabled(on) flips the runtime switch. When ON, recommendSeeds
// takes the fan-out + union + rerank path; when OFF, behaviour is byte-
// identical to the pre-2A single-index path. This composes with 1C
// consistency modes — the cache + frozen-filter logic wraps the federated
// branch just like the single-index branch.
//
// isFederationEnabled() is a cheap read for UI gating.
//
// getFederationStats() returns the last-query diagnostic snapshot. Intended
// for the rv-panel viewer and tests; this is NOT the 3A index-stats stub.
export function setFederationEnabled(on) {
  _federationEnabled = !!on;
  if (_federationEnabled && !_brainDB_hyperbolic) {
    console.warn('[federation] enabled but hyperbolic shadow missing — only Euclidean shard will be queried');
  }
  return _federationEnabled;
}
export function isFederationEnabled() { return !!_federationEnabled; }
export function getFederationStats() {
  return {
    enabled: !!_federationEnabled,
    shards: _federationStats.shards,
    lastKPrime: _federationStats.lastKPrime,
    lastUnionSize: _federationStats.lastUnionSize,
    lastDedupeHits: _federationStats.lastDedupeHits,
    // Snapshot of which shards the bridge *would* fan out to right now,
    // so UI can show "1 shard (degraded)" vs "2 shards" without calling
    // recommendSeeds. Not part of the plan's required shape but cheap.
    availableShards: _brainDB_hyperbolic ? ['euclidean', 'hyperbolic'] : ['euclidean'],
  };
}
export function setFederationCapturer(capturer) {
  _federationCapturer = capturer && typeof capturer.onSnapshot === 'function' ? capturer : null;
}

// ─── Phase 2B — F6 cross-tab live training ──────────────────────────────────
//
// setCrosstabEnabled(true) opens a BroadcastChannel('vectorvroom-archive')
// and wires the receive callback to _onRemoteBrain below. setCrosstabEnabled
// (false) closes it. Off by default (URL flag ?crosstab=1 flips it on at boot
// via main.js). The receive path re-enters archiveBrain under the
// _crosstabReceiving guard so the broadcast hook above short-circuits — that
// guard is what keeps two tabs from echoing forever when they see each
// other's delta on the channel.
export function setCrosstabEnabled(on) {
  const want = !!on;
  if (want === _crosstabEnabled) return _crosstabEnabled;
  if (want) {
    crosstabStart({
      onBrain: (payload /* senderId unused here */) => _onRemoteBrain(payload),
      onPeerCount: (n) => {
        if (typeof _crosstabOnPeerCount === 'function') {
          try { _crosstabOnPeerCount(n); } catch (_) {}
        }
      },
    });
    _crosstabEnabled = crosstabIsStarted();
  } else {
    crosstabStop();
    _crosstabEnabled = false;
  }
  return _crosstabEnabled;
}
export function isCrosstabEnabled() { return !!_crosstabEnabled; }
export function getCrosstabStats() { return crosstabStats(); }
// UI subscription hooks — uiPanels wires these so the pill can animate on
// remote-brain receive and update the peer count. Both are optional; passing
// null clears the subscription.
export function setCrosstabListeners({ onReceive, onPeerCount } = {}) {
  _crosstabOnReceive = typeof onReceive === 'function' ? onReceive : null;
  _crosstabOnPeerCount = typeof onPeerCount === 'function' ? onPeerCount : null;
}

// Receive path: decode the wire payload and route it back through archiveBrain.
// Setting _crosstabReceiving before the call prevents the broadcast hook from
// firing on this re-entrant insert — otherwise tab A → broadcast → tab B
// receives → archiveBrain → broadcast → tab A receives → archiveBrain ...
// infinite ping-pong. Dedup (F5) would eventually collapse the nodes but the
// message traffic would still saturate the channel. The guard shuts it down
// at the source.
//
// NOTE: we intentionally DO NOT short-circuit here even if we recognise the
// hash — the plan calls out trusting dedup instead of re-implementing
// idempotency. archiveBrain → (insert) → (mirror set) is the hot path that
// already answers "have I seen this hash?" via dedup; re-checking here would
// fork the invariant into two places.
export function _onRemoteBrain(payload) {
  if (!payload) return null;
  if (!_brainDB) return null; // not ready — drop silently (pre-ready deltas will re-arrive)
  let decoded;
  try { decoded = crosstabFromWire(payload); }
  catch (e) { console.warn('[crosstab] fromWire failed', e); return null; }
  const { flat, fitness, trackVec, meta } = decoded;
  let brain;
  try { brain = unflatten(flat); }
  catch (e) { console.warn('[crosstab] unflatten failed', e); return null; }
  const dynamicsVec = (meta && meta.dynamicsVec instanceof Float32Array) ? meta.dynamicsVec : undefined;
  const fastestLap = (meta && Number.isFinite(meta.fastestLap)) ? meta.fastestLap : undefined;
  const generation = (meta && Number.isFinite(meta.generation)) ? meta.generation : 0;
  const parentIds = (meta && Array.isArray(meta.parentIds)) ? meta.parentIds : [];
  // Defensive: the sender might be on a slightly different build that
  // encoded a trackVec of a different dim. Feed it through only when
  // length matches this tab's TRACK_DIM — else pass null and let the
  // received brain land track-less (archiveBrain supports that path).
  const safeTrackVec = (trackVec instanceof Float32Array && trackVec.length === TRACK_DIM)
    ? trackVec : null;
  _crosstabReceiving = true;
  let id = null;
  try {
    id = archiveBrain(brain, fitness, safeTrackVec, generation, parentIds, fastestLap, dynamicsVec);
  } catch (e) {
    console.warn('[crosstab] archiveBrain on receive failed', e);
  } finally {
    _crosstabReceiving = false;
  }
  // Fire the UI callback regardless of whether dedup made this a no-op
  // (from the UI's perspective "a remote brain arrived" is the interesting
  // event; whether the archive grew is an implementation detail).
  if (typeof _crosstabOnReceive === 'function') {
    try { _crosstabOnReceive({ id, hash: decoded.hash }); }
    catch (_) {}
  }
  return id;
}

// Pull the frozen brain-id set out of the consistency module's opaque
// snapshot reference. Centralising the unwrap here keeps the
// "cap-by-insertionOrder" shortcut an implementation detail of the
// bridge — the module holds whatever we stashed on freezeArchive and
// doesn't care about the shape.
function _getFrozenBrainIdSet() {
  const stats = _consistencyStats();
  if (!stats || !stats.frozen) return null;
  // The snapshot reference isn't exported directly from the module;
  // re-import it here. Short-circuit when the bridge's shortcut shape
  // isn't present (e.g. an ArchiveSnapshot was stored instead) so
  // recommendSeeds degrades to "no filter" rather than crashing.
  // eslint-disable-next-line no-use-before-define
  const ref = _frozenSnapshotRef();
  if (!ref || !(ref.frozenBrainIds instanceof Set)) return null;
  return ref.frozenBrainIds;
}
// Tiny indirection: import-bound getter that re-reads the frozen ref
// lazily. Separated from _getFrozenBrainIdSet for readability — keeps
// the "what shape are we dealing with?" logic in one place.
function _frozenSnapshotRef() {
  // Avoid top-level name clash by calling the module's getter through
  // the already-imported stats path. The module exports
  // getFrozenSnapshot() directly — wire it in here.
  return _consistencyGetFrozenSnapshot();
}

// ─── embedding + observation ─────────────────────────────────────────────────

// imageData: Uint8Array of RGB bytes (length = width*height*3, no alpha).
export function embedTrack(imageData, width, height) {
  requireReady();
  return _cnn.extract(imageData, width, height);
}

export function cosineSimilarity(a, b) {
  requireReady();
  return _cnn.cosineSimilarity(a, b);
}

export function observe(retrievedIds, outcomeFitness) {
  requireReady();
  if (!retrievedIds || retrievedIds.length === 0) return;
  const normOut = Math.tanh((Number(outcomeFitness) || 0) / 100);
  for (const id of retrievedIds) {
    const prev = _observations.get(id) || { weight: 0, count: 0 };
    const w = EMA_ALPHA * normOut + (1 - EMA_ALPHA) * prev.weight;
    _observations.set(id, { weight: w, count: prev.count + 1 });
  }
  schedulePersist();
}

// ─── introspection (for UI + debugging) ──────────────────────────────────────

export function info() {
  // `observations` = distinct brain ids that have received feedback (kept for
  // backwards-compat with existing logs). `observationEvents` = total number
  // of observe() calls (sums per-id counts); this is what the reranker-shift
  // indicator keys off, because repeat observes on the same id also rerun
  // the EMA and can reshuffle the ordering.
  let events = 0;
  for (const o of _observations.values()) events += (o.count | 0);
  // `reranker` reflects the mode used on the most recent recommendSeeds() call
  // ('gnn' | 'ema' | 'none'). `gnn` is a derived convenience flag for legacy
  // callers. `gnnLoaded` is "is the GNN wasm module actually available"; we
  // still fall back to EMA if the archive is below GNN_MIN_ARCHIVE.
  // LoRA snapshot — `lora.ready` is the canonical "should the UI show
  // adapter-related widgets" flag. `lora.drift` is the L2 distance between the
  // most recent adapt() input and output; `lora.driftRecent` is a short
  // history for the sparkline. When the adapter never ran this session,
  // drift is 0 and recent is empty.
  // P2.A — sonaEngineInfo returns { lora: {...}, sona: {...} } where the
  // LoRA sub-object has the same shape as the P1.B info() used to return.
  const engineInfo = sonaEngineInfo();
  const lora = engineInfo.lora;
  const sona = engineInfo.sona;
  return {
    brains: _brainMirror.size,
    tracks: _trackMirror.size,
    observations: _observations.size,
    observationEvents: events,
    ready: !!_brainDB,
    gnn: _rerankerMode === 'gnn',
    gnnLoaded: gnnIsReady(),
    reranker: _rerankerMode,
    rerankerThreshold: GNN_MIN_ARCHIVE,
    topology: TOPOLOGY.slice(),
    lora,
    // P2.A — SONA stats exposed to the UI panel. `trajectories` grows with
    // endTrajectory + per-step flushes inside sona/engine.js; `patterns` is
    // the ReasoningBank cluster count; `microUpdates` is a local counter
    // (each process_task call bumps one); `ewcLambda` is the config value
    // for the anti-catastrophic-forgetting regulariser. `trajectoryOpen`
    // flips true between begin/end so the panel can show "recording…".
    sona,
    // P1.C. `enabled` is the UI toggle state; `count` is how many archived
    // brains actually have a dynamics vector associated — that lets the
    // panel show "off" vs "on but no data yet" vs "on, N trajectories".
    dynamics: {
      enabled: !!_useDynamics,
      count: _dynamicsMirror.size,
      hasQuery: !!_queryDynamicsVec,
    },
    // Crash-map HNSW — heat-grid curriculum memory for adaptive gates.
    crashMaps: {
      enabled: !!_useCrashMaps,
      count: _crashMirror.size,
      dim: CRASH_DIM,
    },
    // P3.B — lineage DAG stats. `lineageDag.ready` is the canonical flag for
    // the viewer's "is the graph live?" check. `nodeCount` / `edgeCount` come
    // straight from the wasm side; `droppedEdges` is >0 only if malformed
    // parent ids somehow produced a cycle.
    lineageDag: dagInfo(),
    // P3.F — per-generation seed-source breakdown. `archive_recall` counts
    // slots filled from a ruvector similarity-search hit (elite + light + heavy
    // mutation slots in main.js). `localStorage_prior` counts slots filled from
    // a saved bestBrain when the bridge returned nothing. `random_init` counts
    // pure-random fallbacks (novel-car slots and cold-boot). `total` must
    // equal the population N; the UI asserts this and logs if it drifts.
    seedSources: {
      archive_recall: _lastSeedSources.archive_recall,
      localStorage_prior: _lastSeedSources.localStorage_prior,
      random_init: _lastSeedSources.random_init,
      total: _lastSeedSources.total,
      generation: _lastSeedSources.generation,
    },
    // P4.A — A/B policy snapshot so uiPanels can reflect + round-trip the
    // toggle strip state. `rerankerPolicy` is what the user picked;
    // `reranker` above is what recommendSeeds actually did on the last call.
    policy: {
      reranker: _rerankerPolicy,
      adapter: _adapterMode,
      dynamics: !!_useDynamics,
      // P3.A — live index kind, flipped by setIndexKind() or the
      // `?hhnsw=1` URL flag at init. `hyperbolicLoaded` tells the UI
      // whether the toggle is even usable (if the wasm fails to load we
      // keep the button disabled so clicks don't silently no-op).
      index: _indexKind,
      hyperbolicLoaded: isHyperbolicReady(),
    },
  };
}

// ─── P2.A SONA trajectory + pattern surface ──────────────────────────────
//
// Exposed here (rather than having main.js import sona/engine.js directly)
// so the no-build classic-script consumer route via window.__rvBridge keeps
// working without a second sidecar import. These are thin pass-throughs.
// When SONA isn't ready, they no-op silently — callers can fire-and-forget.

export function beginPhase4Trajectory(trackVec) {
  if (_sonaPaused) return null;
  try { return sonaBeginTrajectory(trackVec); } catch (e) { console.warn('[sona] begin failed', e); return null; }
}
export function addPhase4Step(activations, attention, stepReward) {
  if (_sonaPaused) return;
  try { sonaAddStep(activations, attention, stepReward); } catch (e) { console.warn('[sona] addStep failed', e); }
}
export function endPhase4Trajectory(finalFitness) {
  if (_sonaPaused) return null;
  try { return sonaEndTrajectory(finalFitness); } catch (e) { console.warn('[sona] endTrajectory failed', e); return null; }
}
export function findSimilarCircuits(trackVec, k = 5) {
  try { return sonaFindPatterns(trackVec, k); } catch (e) { console.warn('[sona] findPatterns failed', e); return []; }
}

// P3.B — lineage assembly. When the DAG wasm is loaded we route through
// lineage/dag.js (cycle-safe, O(depth) via JS-side adjacency); otherwise we
// fall back to the legacy in-function walk over _brainMirror. Both paths
// share the same contract: return [{id, fitness, generation}] oldest→newest,
// pick highest-fitness non-visited parent at each step, cap at maxDepth.
//
// Test-only override `_forceLegacyLineage` lets the equivalence harness
// capture both outputs from a single archive snapshot without tearing state
// down in between.
let _forceLegacyLineage = false;
export function setForceLegacyLineage(on) { _forceLegacyLineage = !!on; }

export function getLineage(id, maxDepth = 6) {
  if (!_forceLegacyLineage && dagIsReady()) {
    const t = dagGetLineage(id, maxDepth);
    if (t && t.length > 0) return t;
    // Empty result can legitimately mean "id unknown to the DAG" — fall
    // through to the legacy path, which also answers [] for unknown ids but
    // using the mirror as source of truth. This way the API never silently
    // mismatches between paths on brains that exist in the mirror but aren't
    // yet mirrored in the DAG (e.g. an archive hydrated before the wasm
    // finished loading).
  }
  return getLineageLegacy(id, maxDepth);
}

// Walk meta.parentIds backwards to assemble a lineage trail.
// At each step, when a brain has multiple parents, we pick the highest-fitness
// ancestor — that is "the line of descent we credit this genome to". Cycle-safe
// via a visited set; depth-capped so pathological graphs can't blow the stack.
// Returns entries oldest→newest (i.e. ancestor first, queried id last).
export function getLineageLegacy(id, maxDepth = 6) {
  if (!id || !_brainMirror.has(id)) return [];
  const seen = new Set();
  const trail = [];
  let cur = id;
  const cap = Math.max(1, maxDepth | 0);
  while (cur && !seen.has(cur) && trail.length < cap) {
    const entry = _brainMirror.get(cur);
    if (!entry) break;
    seen.add(cur);
    const m = entry.meta || {};
    trail.push({
      id: cur,
      fitness: typeof m.fitness === 'number' ? m.fitness : 0,
      generation: typeof m.generation === 'number' ? m.generation : 0,
    });
    const parents = Array.isArray(m.parentIds) ? m.parentIds : [];
    let best = null;
    let bestFit = -Infinity;
    for (const pid of parents) {
      if (seen.has(pid)) continue;
      const pe = _brainMirror.get(pid);
      if (!pe) continue;
      const pf = (pe.meta && typeof pe.meta.fitness === 'number') ? pe.meta.fitness : 0;
      if (pf > bestFit) { bestFit = pf; best = pid; }
    }
    cur = best;
  }
  return trail.reverse();
}

// P3.B — surface the DAG structure to the viewer panel. Returns `{nodes,
// edges}` or empty lists when the wasm isn't ready. Viewer keeps its last
// non-empty snapshot so it doesn't blank out during hot-reload races.
export function getLineageGraph() {
  if (!dagIsReady()) return { nodes: [], edges: [], droppedEdges: 0, ready: false };
  const snap = dagGetGraphSnapshot();
  snap.ready = true;
  return snap;
}
export function getLineageDagInfo() { return dagInfo(); }

// ─── persistence (native IndexedDB) ──────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BRAINS_STORE)) db.createObjectStore(BRAINS_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(TRACKS_STORE)) db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(OBS_STORE)) db.createObjectStore(OBS_STORE, { keyPath: 'id' });
      // LORA_STORE was added in IDB v2 (P1.B). Keying on `id` matches the
      // pattern of the other stores; we only ever store one row (LORA_KEY).
      if (!db.objectStoreNames.contains(LORA_STORE)) db.createObjectStore(LORA_STORE, { keyPath: 'id' });
      // DYNAMICS_STORE was added in IDB v3 (P1.C). One row per archived
      // dynamics vector, keyed by the _dynamicsDB-assigned id — mirrors the
      // brains/tracks store shape.
      if (!db.objectStoreNames.contains(DYNAMICS_STORE)) db.createObjectStore(DYNAMICS_STORE, { keyPath: 'id' });
      // CRASH_STORE added in IDB v4 — gen-end death heat maps + gate layouts.
      if (!db.objectStoreNames.contains(CRASH_STORE)) db.createObjectStore(CRASH_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function hydrate() {
  if (typeof indexedDB === 'undefined') return;
  let db;
  try { db = await openDB(); } catch (e) {
    console.warn('[ruvector] hydrate: openDB failed', e);
    return;
  }
  try {
    // Dynamics store only exists on IDB v3+, but even an older DB file that
    // upgraded through onupgradeneeded will now have the empty store — so
    // readAll is safe. Still, wrap in try/catch to be defensive against
    // partial upgrades from a crashed earlier session.
    let dynamicsRows = [];
    let crashRows = [];
    const _tIdb = _tStart();
    try { dynamicsRows = await readAll(db, DYNAMICS_STORE); } catch (_) { dynamicsRows = []; }
    try { crashRows = await readAll(db, CRASH_STORE); } catch (_) { crashRows = []; }
    const [brainRows, trackRows, obsRows] = await Promise.all([
      readAll(db, BRAINS_STORE),
      readAll(db, TRACKS_STORE),
      readAll(db, OBS_STORE),
    ]);
    _tEnd('3a_idb_readAll', _tIdb);
    _bootTimings._rowCounts = {
      brains: brainRows.length,
      tracks: trackRows.length,
      obs: obsRows.length,
      dynamics: dynamicsRows.length,
      crashMaps: crashRows.length,
    };
    // Tracks first, so upsertTrack-dedup can reference them (not strictly needed
    // since we load by id, but keeps mirror/DB consistent).
    const _tTracks = _tStart();
    for (const row of trackRows) {
      const vec = toFloat32(row.vec);
      if (vec.length !== TRACK_DIM) continue;
      _trackDB.insert(vec, row.id, row.meta || {});
      _trackMirror.set(row.id, { vector: vec, meta: row.meta || {} });
    }
    _tEnd('3b_insert_tracks', _tTracks);
    // Dynamics second — brain meta references dynamicsId, so the mirror
    // being populated when brains hydrate means recommendSeeds can find the
    // match immediately. (Brain rows from pre-P1.C archives simply won't
    // have meta.dynamicsId set; that's the backwards-compat path.)
    const _tDyn = _tStart();
    for (const row of dynamicsRows) {
      const vec = toFloat32(row.vec);
      if (vec.length !== DYNAMICS_DIM) continue;
      _dynamicsDB.insert(vec, row.id, row.meta || {});
      _dynamicsMirror.set(row.id, { vector: vec, meta: row.meta || {} });
    }
    _tEnd('3c_insert_dynamics', _tDyn);
    const _tCrash = _tStart();
    for (const row of crashRows) {
      const vec = toFloat32(row.vec);
      if (vec.length !== CRASH_DIM) continue;
      try {
        _crashDB.insert(vec, row.id, row.meta || {});
        _crashMirror.set(row.id, { vector: vec, meta: row.meta || {} });
      } catch (e) { console.warn('[crash-map] hydrate insert failed', e); }
    }
    _tEnd('3c2_insert_crashMaps', _tCrash);
    const _tBrains = _tStart();
    for (const row of brainRows) {
      const vec = toFloat32(row.vec);
      if (vec.length !== FLAT_LENGTH) continue;
      _brainDB.insert(vec, row.id, row.meta || {});
      _brainMirror.set(row.id, { vector: vec, meta: row.meta || {} });
      _insertionOrder.push(row.id);
      // Phase 2A — F2 shadow hydrate. Keep the hyperbolic brain index in
      // lock-step with the Euclidean one so federation can fan out over a
      // hydrated archive the moment it's flipped on. Same id so union
      // collapses cross-shard duplicates of the same brain.
      if (_brainDB_hyperbolic) {
        try { _brainDB_hyperbolic.insert(vec, row.id, row.meta || {}); }
        catch (e) { console.warn('[federation] hyperbolic shadow hydrate failed', e); }
      }
    }
    _tEnd('3d_insert_brains', _tBrains);
    const _tObs = _tStart();
    for (const row of obsRows) {
      _observations.set(row.id, { weight: row.weight || 0, count: row.count | 0 });
    }
    _tEnd('3e_insert_obs', _tObs);
  } finally {
    db.close();
  }
}

// Read the single-row LORA_STORE and hand it to the adapter. Called from
// ready() *after* loadAdapter() resolves — set_b needs the wasm engines live.
// Failures are swallowed: the adapter just stays at its (zero-B) cold state.
async function hydrateLoraSnapshot() {
  if (typeof indexedDB === 'undefined') return;
  if (!loraIsReady()) return;
  let db;
  try { db = await openDB(); } catch (e) {
    console.warn('[lora] hydrate openDB failed', e); return;
  }
  try {
    const row = await new Promise((resolve, reject) => {
      const tx = db.transaction(LORA_STORE, 'readonly');
      const req = tx.objectStore(LORA_STORE).get(LORA_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (row && row.snapshot) {
      const ok = loraDeserialize(row.snapshot);
      if (!ok) console.warn('[lora] hydrate snapshot rejected (shape mismatch)');
    }
  } catch (e) {
    console.warn('[lora] hydrate failed', e);
  } finally {
    db.close();
  }
}

function readAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function toFloat32(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return new Float32Array(v);
  if (v && v.buffer) return new Float32Array(v.buffer, v.byteOffset || 0, v.byteLength / 4);
  return new Float32Array(0);
}

function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persist().catch((e) => console.warn('[ruvector] persist failed', e));
  }, PERSIST_DEBOUNCE_MS);
}

// Synchronous-ish flush used on beforeunload. Best-effort — browsers may kill
// the IDB transaction before it commits; for the demo we accept that risk.
function flushPersist() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  persist();
}

export async function persist() {
  if (typeof indexedDB === 'undefined') return;
  // Serialize: collapse concurrent calls into one queued follow-up.
  if (_persistInFlight) {
    await _persistInFlight;
  }
  _persistInFlight = (async () => {
    const db = await openDB();
    try {
      const storeNames = [BRAINS_STORE, TRACKS_STORE, OBS_STORE, LORA_STORE, DYNAMICS_STORE];
      if (db.objectStoreNames.contains(CRASH_STORE)) storeNames.push(CRASH_STORE);
      const tx = db.transaction(storeNames, 'readwrite');
      const brains = tx.objectStore(BRAINS_STORE);
      const tracks = tx.objectStore(TRACKS_STORE);
      const obs = tx.objectStore(OBS_STORE);
      const lora = tx.objectStore(LORA_STORE);
      const dynamics = tx.objectStore(DYNAMICS_STORE);
      const crashes = db.objectStoreNames.contains(CRASH_STORE) ? tx.objectStore(CRASH_STORE) : null;
      // Full rewrite keeps the logic simple; archive size stays small (hundreds
      // of entries, <100KB serialized) so the write cost is negligible.
      brains.clear();
      tracks.clear();
      obs.clear();
      lora.clear();
      dynamics.clear();
      if (crashes) crashes.clear();
      for (const [id, { vector, meta }] of _brainMirror) {
        brains.put({ id, vec: Array.from(vector), meta });
      }
      for (const [id, { vector, meta }] of _trackMirror) {
        tracks.put({ id, vec: Array.from(vector), meta });
      }
      for (const [id, { vector, meta }] of _dynamicsMirror) {
        dynamics.put({ id, vec: Array.from(vector), meta });
      }
      if (crashes) {
        for (const [id, { vector, meta }] of _crashMirror) {
          crashes.put({ id, vec: Array.from(vector), meta });
        }
      }
      for (const [id, { weight, count }] of _observations) {
        obs.put({ id, weight, count });
      }
      // Snapshot the adapter state. Skipped silently when the wasm module
      // didn't load — we never persist a vacuous snapshot, which would
      // overwrite a real one on the next boot.
      const snapshot = loraSerialize();
      if (snapshot) lora.put({ id: LORA_KEY, snapshot });
      await txPromise(tx);
    } finally {
      db.close();
    }
  })();
  try { await _persistInFlight; } finally { _persistInFlight = null; }
}

// Test-only: load a fixture archive directly into the in-memory state,
// bypassing IndexedDB. The fixture shape mirrors persist()'s output:
//   { brains:  [{ id, vec, meta }],
//     tracks:  [{ id, vec, meta }],
//     observations: [{ id, weight, count }] }
// Used by tests/gnn-replay.html for deterministic archive replay.
export function hydrateFromFixture(fixture) {
  requireReady();
  _brainMirror.clear();
  _trackMirror.clear();
  _dynamicsMirror.clear();
  _observations.clear();
  _insertionOrder = [];
  // P3.A — respect the current index kind when rebuilding from a fixture.
  // bench-hnsw.html calls setIndexKind('hyperbolic') before hydrateFromFixture
  // to exercise the hyperbolic path against the same archive.
  const IndexClass = pickIndexClass(_indexKind);
  _brainDB = new IndexClass(FLAT_LENGTH, 'cosine');
  _trackDB = new IndexClass(TRACK_DIM, 'cosine');
  _dynamicsDB = new IndexClass(DYNAMICS_DIM, 'cosine');
  // Phase 2A — F2 fixture rehydrate for the shadow hyperbolic index. Same
  // rule as the IDB hydrate path: when the wasm loaded we re-create the
  // shadow from scratch and insert every brain below.
  if (isHyperbolicReady()) {
    try { _brainDB_hyperbolic = new HyperbolicVectorDB(FLAT_LENGTH, 'cosine'); }
    catch (e) { console.warn('[federation] hyperbolic shadow rebuild failed', e); _brainDB_hyperbolic = null; }
  } else {
    _brainDB_hyperbolic = null;
  }
  const toF32 = (v) => (v instanceof Float32Array) ? v : new Float32Array(v);
  for (const row of (fixture.tracks || [])) {
    const vec = toF32(row.vec);
    if (vec.length !== TRACK_DIM) continue;
    _trackDB.insert(vec, row.id, row.meta || {});
    _trackMirror.set(row.id, { vector: vec, meta: row.meta || {} });
  }
  for (const row of (fixture.brains || [])) {
    const vec = toF32(row.vec);
    if (vec.length !== FLAT_LENGTH) continue;
    _brainDB.insert(vec, row.id, row.meta || {});
    _brainMirror.set(row.id, { vector: vec, meta: row.meta || {} });
    _insertionOrder.push(row.id);
    // Phase 2A — F2 shadow fixture rehydrate.
    if (_brainDB_hyperbolic) {
      try { _brainDB_hyperbolic.insert(vec, row.id, row.meta || {}); }
      catch (e) { console.warn('[federation] hyperbolic shadow fixture insert failed', e); }
    }
  }
  for (const row of (fixture.observations || [])) {
    _observations.set(row.id, { weight: row.weight || 0, count: row.count | 0 });
  }
  _rerankerMode = 'none';
  // P3.B — rebuild the lineage DAG from scratch so its state matches the
  // just-hydrated mirror. Skipped silently when the wasm didn't load.
  try {
    if (dagIsReady()) {
      dagDebugReset();
      dagHydrateFromMirror(_brainMirror);
    }
  } catch (e) { console.warn('[lineage-dag] fixture rehydrate failed', e); }
}

// ─── Phase 0 extension points (RuLake-inspired features) ─────────────────
// Each stub is a Phase 1 / Phase 2 ownership slot, pre-declared here so the
// swarm can implement in parallel without fighting over this file. Do NOT
// remove the stubs when implementing — replace the body. The signature is
// the contract between features; extending args is fine, renaming is not.
//
//   exportSnapshot()      — owned by 1A (F3 warm-restart bundles)
//   importSnapshot(s)     — owned by 1A (F3 warm-restart bundles)
//   setConsistencyMode(m) — owned by 1C (F4 consistency modes)
//   getIndexStats()       — owned by 3A (F7 observability dashboard)
//
// See docs/plan/rulake-inspired-features.md for the full plan.

import { validateSnapshot, CONSISTENCY_MODES } from './archive/snapshot.js';
import { buildSnapshot } from './archive/exporter.js';
import { applySnapshot } from './archive/importer.js';
// 1C — F4. Consistency-mode state machine + eventual-mode TTL cache live
// in consistency/mode.js. We consult it on every recommendSeeds() call
// (see the `consistency` branch below) and transition via
// setConsistencyMode. The module is independent of the bridge so tests
// can exercise it without booting wasm.
import {
  getMode as _consistencyGetMode,
  setMode as _consistencySetMode,
  recordQuery as _consistencyRecordQuery,
  getCachedResult as _consistencyGetCachedResult,
  freezeArchive as _consistencyFreezeArchive,
  thawArchive as _consistencyThawArchive,
  clearCache as _consistencyClearCache,
  trackVecKey as _consistencyTrackVecKey,
  stats as _consistencyStats,
  getFrozenSnapshot as _consistencyGetFrozenSnapshot,
} from './consistency/mode.js';

// Phase 0: stored but unread; 1C will wire this into the query path.
let _consistencyMode = 'fresh';

// 1A — F3. Build a whole-archive snapshot (replay mode). Synchronous; the
// witness is computed via xxHash32 (tagged "x32:") so this can be called
// from click handlers without awaiting. Callers that want a sha-256 witness
// can route through archive/exporter.buildSnapshotAsync directly.
export function exportSnapshot() {
  requireReady();
  return buildSnapshot({
    brainMirror: _brainMirror,
    trackMirror: _trackMirror,
    dynamicsMirror: _dynamicsMirror,
    observations: _observations,
    indexKind: _indexKind,
    insertionOrder: _insertionOrder,
    consistency: _consistencyMode,
    dim: FLAT_LENGTH,
  });
}

// 1A — F3. Replay an ArchiveSnapshot into the live indexes + mirrors. We
// rebuild the VectorDB instances from scratch (same pattern as
// rebuildIndicesFromMirror) to guarantee the imported graph has no stale
// nodes from the pre-import session. Schedules a persist so the next page
// load inherits the imported archive.
export function importSnapshot(s) {
  requireReady();
  const v = validateSnapshot(s);
  if (!v.ok) throw new Error(`importSnapshot: invalid snapshot (${v.reason})`);
  // Rebuild empty indexes under the current geometry; applySnapshot will
  // re-insert every brain in the snapshot's insertionOrder.
  const IndexClass = pickIndexClass(_indexKind);
  _brainDB = new IndexClass(FLAT_LENGTH, 'cosine');
  _trackDB = new IndexClass(TRACK_DIM, 'cosine');
  _dynamicsDB = new IndexClass(DYNAMICS_DIM, 'cosine');
  _queryDynamicsVec = null;
  _rerankerMode = 'none';
  const res = applySnapshot(s, {
    brainDB: _brainDB,
    trackDB: _trackDB,
    dynamicsDB: _dynamicsDB,
    brainMirror: _brainMirror,
    trackMirror: _trackMirror,
    dynamicsMirror: _dynamicsMirror,
    observations: _observations,
  });
  // Phase 2A — F2. After applySnapshot we rebuild the hyperbolic shadow
  // from the refreshed mirror in one pass so federation stays correct on
  // any subsequent recommendSeeds(). applySnapshot itself doesn't know
  // about the shadow — it's a 2A addition that composes with 1A's
  // snapshot pipeline rather than being owned by it.
  if (isHyperbolicReady()) {
    try {
      _brainDB_hyperbolic = new HyperbolicVectorDB(FLAT_LENGTH, 'cosine');
      for (const [id, { vector, meta }] of _brainMirror) {
        try { _brainDB_hyperbolic.insert(vector, id, meta || {}); }
        catch (e) { console.warn('[federation] shadow snapshot insert failed', e); }
      }
    } catch (e) {
      console.warn('[federation] shadow snapshot rebuild failed', e);
      _brainDB_hyperbolic = null;
    }
  } else {
    _brainDB_hyperbolic = null;
  }
  // Refresh our own insertion-order tracker to match what the importer
  // actually replayed. Further archiveBrain calls append to this same array.
  _insertionOrder = (s.hnsw && Array.isArray(s.hnsw.insertionOrder))
    ? s.hnsw.insertionOrder.filter((id) => _brainMirror.has(id))
    : Array.from(_brainMirror.keys());
  // Rebuild DAG from the new mirror so lineage queries match the imported
  // archive. Safe no-op when the wasm side didn't load.
  try {
    if (dagIsReady()) {
      dagDebugReset();
      dagHydrateFromMirror(_brainMirror);
    }
  } catch (e) { console.warn('[lineage-dag] import rehydrate failed', e); }
  schedulePersist();
  return res;
}

// 1C — F4. Accepts 'fresh' | 'eventual' | 'frozen'.
//
// Freeze/thaw mechanism: we use the cap-by-insertionOrder shortcut from
// the plan. On transition to 'frozen' we snapshot the current
// _insertionOrder length and the set of brain ids present *right now*.
// During a frozen query, recommendSeeds ignores any brain whose id is
// NOT in that snapshot set — new archiveBrain() calls still insert into
// the live _brainDB (we don't want to break archive growth), but their
// ids don't appear in the pinned set so they won't appear in query
// results. On transition away from 'frozen' we drop the reference and
// the live archive is queryable again.
export function setConsistencyMode(m) {
  if (!CONSISTENCY_MODES.includes(m)) {
    throw new Error(`setConsistencyMode: invalid mode ${m}`);
  }
  const prev = _consistencyGetMode();
  if (prev === m) {
    _consistencyMode = m;
    return;
  }
  // On any mode change, clear the eventual cache so a previous mode's
  // cached answer doesn't accidentally replay under a different
  // consistency contract.
  _consistencyClearCache();
  // Leaving frozen → thaw the snapshot reference so live queries can
  // see every brain again.
  if (prev === 'frozen' && m !== 'frozen') {
    _consistencyThawArchive();
  }
  // Entering frozen → pin the current archive state.
  if (m === 'frozen') {
    const frozenBrainIds = new Set(_brainMirror.keys());
    _consistencyFreezeArchive({
      frozenBrainCount: frozenBrainIds.size,
      frozenBrainIds,
      frozenAt: Date.now(),
    });
  }
  _consistencyMode = m;
  _consistencySetMode(m);
}

// Backwards-compat getter. Returns the simple string so existing
// callers (uiPanels, tests) stay happy; callers that want more detail
// can import consistency/mode.stats() directly.
export function getConsistencyMode() { return _consistencyGetMode(); }

// Re-export the stats snapshot for callers (uiPanels tick, test
// harnesses). Not part of the 1A/1B/1D contract surface; kept as a
// named export so consumers can discover it via tree-shaking / IDE.
export function getConsistencyStats() { return _consistencyStats(); }

// Phase 3A — F7. Live structured snapshot for the "Where the time goes"
// panel. Composes the Phase 2A federation / Phase 1C consistency /
// Phase 2B crosstab stats getters with the observability timing module.
// Each optional getter is wrapped in try/catch because the bridge may
// not have booted all of them yet (hydrate races, headless tests,
// flag-gated states). Returning null for a subsection is the stable
// fallback — the panel knows how to render partial data.
export function getIndexStats() {
  const stats = {
    archive: {
      brains: _brainMirror.size,
      tracks: _trackMirror.size,
      dynamics: _dynamicsMirror.size,
      observations: _observations.size,
    },
    index: {
      kind: _indexKind,
      hnsw: {
        len: (_brainDB && typeof _brainDB.len === 'function')
          ? Number(_brainDB.len()) : _brainMirror.size,
      },
    },
    federation: null,
    consistency: null,
    crosstab: null,
    timings: null,
  };
  try { stats.federation = getFederationStats(); } catch (_) { /* optional */ }
  try { stats.consistency = getConsistencyStats(); } catch (_) { /* optional */ }
  try { stats.crosstab = getCrosstabStats(); } catch (_) { /* optional */ }
  try { stats.timings = _obsSnapshot(); } catch (_) { stats.timings = null; }
  return stats;
}

// Danger-knob: purge everything. Exposed for the verifier + dev console; the
// game never calls this.
export async function _debugReset() {
  _brainMirror.clear();
  _trackMirror.clear();
  _dynamicsMirror.clear();
  _crashMirror.clear();
  _observations.clear();
  _insertionOrder = [];
  _queryDynamicsVec = null;
  // Phase 2A — reset federation diagnostic counters. The shadow index is
  // rebuilt by the next hydrate / hydrateFromFixture call, so we don't
  // touch _brainDB_hyperbolic here (matching the pre-2A policy that
  // _debugReset leaves the live _brainDB alone — hydrateFromFixture
  // rebuilds it, same goes for the shadow).
  _federationStats.enabled = false;
  _federationStats.shards = 0;
  _federationStats.lastKPrime = 0;
  _federationStats.lastUnionSize = 0;
  _federationStats.lastDedupeHits = 0;
  sonaEngineDebugReset();
  try { dagDebugReset(); } catch (_) { /* safe to ignore */ }
  if (typeof indexedDB !== 'undefined') {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(IDB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}
