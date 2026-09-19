// sona/engine.js — P2.A SONA upgrade on top of the P1.B MicroLoRA adapter.
//
// What this module is:
//   A façade that bundles two independent learning surfaces behind one API:
//     1. the P1.B MicroLoRA `trackAdapter` (adapt / reward / drift sparkline),
//     2. a SONA `WasmEphemeralAgent` that collects trajectories and extracts
//        ReasoningBank patterns.
//
// Why they're wired side-by-side, not as one engine:
//   The upstream `ruvector-sona` WASM crate ships *two* wrapper classes —
//   `WasmSonaEngine` and `WasmEphemeralAgent` — over the same underlying
//   `SonaEngine`. `WasmSonaEngine.applyLora` is real but its trajectory
//   bindings (`recordStep`, `endTrajectory`) are console-logging stubs, so
//   its micro-LoRA B matrix never actually updates. `WasmEphemeralAgent`
//   is the opposite: `process_task(embedding, quality)` drives the real
//   learning loop (→ reasoning-bank pattern extraction, EWC++ consolidation)
//   but it doesn't expose `applyLora`. So we use the ephemeral agent for
//   the trajectory/pattern surface the plan calls for, and keep the existing
//   P1.B adapter for the query-side transform — the adapter is the part that
//   actually *shows* change to the user (drift sparkline, retrieval effect),
//   and the SONA agent adds the "similar circuits" panel + extra stats.
//
// Public surface (imported by ruvectorBridge):
//   loadEngine()                     — init both backends (idempotent)
//   isReady()                        — LoRA side is live (the minimum bar)
//   sonaReady()                      — SONA agent is live (for the new UI)
//   adapt(trackVec) / reward(f)      — P1.B pass-throughs (unchanged behaviour)
//   driftL2() / recentDrift() / serialize() / deserialize() / _debugReset()
//   beginTrajectory(trackVec)        — phase-4 entry
//   addStep(activations, attn, r)    — one per generation
//   endTrajectory(finalFitness)      — phase-4 exit / best-of-session flush
//   findPatterns(trackVec, k)        — top-k ReasoningBank clusters by cosine
//   info()                           — merged {lora: …, sona: …} snapshot

import initSona, { WasmEphemeralAgent } from '../../vendor/ruvector/sona/ruvector_sona.js';
import {qualityFromFitness} from '../learning/policy.js';
import {CircuitJournal} from './journal.js';
import {
  loadAdapter as loadLora,
  isReady as loraReady,
  adapt as loraAdapt,
  reward as loraReward,
  driftL2 as loraDrift,
  recentDrift as loraRecentDrift,
  info as loraInfo,
  serialize as loraSerialize,
  deserialize as loraDeserialize,
  _debugReset as loraDebugReset,
} from '../lora/trackAdapter.js';

// SONA agent config — ephemeral defaults trimmed for this browser demo:
//   hidden_dim=512          matches the CNN track embedding dim,
//   pattern_clusters=16     the UI only shows top-5; ≤16 keeps k-means fast,
//   trajectory_capacity=500 default for `for_ephemeral()`,
//   quality_threshold=0.15  lowered so early-training low-fitness tracks
//                           still feed the reasoning bank (default 0.3 was
//                           gating out almost every trajectory on phase-4
//                           launch, leaving patterns_stored = 0 indefinitely),
//   ewc_lambda=1000         ephemeral default.
const SONA_HIDDEN_DIM = 512;
const SONA_CONFIG = {
  hidden_dim: SONA_HIDDEN_DIM,
  embedding_dim: SONA_HIDDEN_DIM,
  micro_lora_rank: 2,
  base_lora_rank: 4,
  micro_lora_lr: 0.002,
  base_lora_lr: 0.0001,
  ewc_lambda: 1000,
  pattern_clusters: 16,
  trajectory_capacity: 500,
  background_interval_ms: 60000,
  quality_threshold: 0.15,
  enable_simd: true,
};

// How often we ask the agent to crystalize trajectories into patterns.
// force_learn() is cheap at this scale (<50 trajectories typical), so we
// call it after every endTrajectory — that way patterns_stored bumps up
// immediately when a new session closes, instead of waiting an hour for
// the default background tick.
let _ready = null;
let _agent = null;
let _agentId = 'car-racer';
let _microUpdates = 0;      // synthesised: one per endTrajectory/step flush
let _patternCount = 0;      // cached from last stats() call for UI stickiness
let _traj = null;           // in-flight JS-side trajectory buffer
const _journal = new CircuitJournal();
let _replayedExamples = 0;
let _savedLora = null;

export function loadEngine() {
  if (_ready) return _ready;
  _ready = (async () => {
    // Fire-and-forget both loads in parallel. LoRA is the minimum bar — if it
    // fails, callers get the identity transform; SONA failure only loses the
    // new panel, never the P1.B surface. `Promise.allSettled` so a SONA
    // failure doesn't reject the lora init.
    const [loraRes, sonaRes] = await Promise.allSettled([
      loadLora(),
      (async () => {
        await initSona();
        // `withConfig` takes a JSON-serialised string on the WASM binding
        // (see crates/sona/src/wasm.rs lines 700–718 — it defines its own
        // serde_wasm_bindgen shim that only accepts JsValue::from_str). Pass
        // a string or the deserialise call throws "Expected JSON string".
        return WasmEphemeralAgent.withConfig(_agentId, JSON.stringify(SONA_CONFIG));
      })(),
    ]);
    if (sonaRes.status === 'fulfilled') {
      _agent = sonaRes.value;
    } else {
      console.warn('[sona] load failed; SONA features disabled', sonaRes.reason);
      _agent = null;
    }
    return { lora: loraRes.status === 'fulfilled' ? loraRes.value : null, sona: _agent };
  })();
  return _ready;
}

export function isReady()   { return loraReady(); }
export function sonaReady() { return !!_agent; }

// ─── P1.B pass-throughs ────────────────────────────────────────────────────

export const adapt        = loraAdapt;
export const reward       = loraReward;
export const driftL2      = loraDrift;
export const recentDrift  = loraRecentDrift;
export function serialize() {
  // Keep the two independent engines independent on disk as well. Retain an
  // unavailable adapter's previous snapshot rather than overwriting its work.
  const lora = loraSerialize() || _savedLora;
  if (!lora && !_agent && !_journal.examples.length) return null;
  return { engineVersion: 1, lora, sonaJournal: _journal.serialize() };
}
export function deserialize(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.engineVersion != null && snapshot.engineVersion !== 1) return false;
  // Read legacy snapshots where the journal was attached to the LoRA object.
  const lora = snapshot.engineVersion === 1 ? snapshot.lora : snapshot;
  let restoredLora = false;
  try { restoredLora = loraDeserialize(lora); } catch (_) { /* journal can still recover */ }
  if (restoredLora || (!loraReady() && lora)) _savedLora = lora;
  const journal = snapshot.sonaJournal;
  const hasJournal = journal?.version === 1 && Array.isArray(journal.examples);
  if (!hasJournal) return restoredLora;
  _journal.restore(journal);_replayedExamples=0;
  if(_agent){
    try{
      _agent.clear();_traj=null;_microUpdates=0;
      for(const example of _journal.examples){
        _agent.processTask(new Float32Array(example.vector),example.quality);_replayedExamples++;
      }
      if(_replayedExamples)_agent.forceLearn();
      _patternCount=readPatternCount(_agent);
    }catch(error){console.warn('[sona] circuit example replay failed',error);}
  }
  return restoredLora || hasJournal;
}

export function _debugReset() {
  loraDebugReset();
  _traj = null;
  _microUpdates = 0;
  _patternCount = 0;
  _journal.clear();_replayedExamples=0;
  _savedLora = null;
  // We don't reconstruct the SONA agent here — the wasm engines are cheap to
  // keep around, and tests that need a clean agent state can drop the
  // module's _agent reference manually. In the game we never hit debugReset
  // except via the dev console.
  if (_agent) {
    try { _agent.clear(); } catch (_) { /* best-effort */ }
  }
}

// ─── SONA trajectory API ───────────────────────────────────────────────────

// Begin a new trajectory for a track. Steps are buffered JS-side; nothing
// flows to the agent until endTrajectory(). This matches the plan's
// phase-4 lifecycle — "`beginTrajectory(trackVec)` at phase-4 entry" — where
// a trajectory frames a whole training session, not a single generation.
export function beginTrajectory(trackVec) {
  if (!sonaReady()) return null;
  const query = coerceSonaVec(trackVec);
  if (!query) return null;
  _traj = {
    trackVec: query,
    steps: [], // [{activations: Float32Array(512), reward: number}]
    startedAt: Date.now(),
  };
  return _traj;
}

// Record one step. The plan's signature is (activations, attention, reward);
// we only use `activations` + `reward` because `attention` isn't a meaningful
// concept for the 6→8→4 racer net. We resize activations to the SONA hidden
// dim so the agent's k-means clustering has a consistent embedding shape.
export function addStep(activations, _attention, stepReward) {
  if (!_traj || !sonaReady()) return;
  const acts = coerceSonaVec(activations);
  if (!acts) return;
  _traj.steps.push({ activations: acts, reward: Number(stepReward) || 0 });
  // Long unattended sessions remain bounded even when a caller forgets to
  // close a trajectory. The normal game reviews every eight generations.
  if(_traj.steps.length>128)_traj.steps.shift();
}

// Close the trajectory and crystallize patterns. We emit one processTask
// per recorded step (activations as the embedding, step reward as quality),
// then one final processTask on the trackVec itself keyed by the session's
// normalised final fitness — so the reasoning bank ends up clustering over
// BOTH the within-session dynamics (activations × reward) AND the
// across-session identity (trackVec × finalFitness). Finally we force_learn
// to run k-means + EWC++ immediately, so patterns_stored bumps as soon as
// the session closes rather than waiting on the 60-second background tick.
export function endTrajectory(finalFitness) {
  if (!_traj || !sonaReady()) { _traj = null; return null; }
  const agent = _agent;
  const tj = _traj;
  _traj = null;
  const normFinal = normaliseQuality(finalFitness);
  try {
    for (const step of tj.steps) {
      agent.processTask(step.activations, normaliseQuality(step.reward));
      _microUpdates += 1;
    }
    agent.processTask(tj.trackVec, normFinal);
    _journal.remember(tj.trackVec,normFinal);
    _microUpdates += 1;
    // force_learn returns a string ("Forced learning: N trajectories -> M patterns…");
    // we discard it but the side-effect is the point.
    agent.forceLearn();
    // Refresh cached pattern count. getStats returns a plain object via
    // serde_wasm_bindgen; we parse defensively because the shape depends on
    // the WASM build.
    _patternCount = readPatternCount(agent);
  } catch (e) {
    console.warn('[sona] endTrajectory failed', e);
  }
  return { finalFitness: normFinal, steps: tj.steps.length };
}

// Find top-k patterns by cosine against the query trackVec. Prefers the
// native `WasmEphemeralAgent.findPatterns(query, k)` binding (cosine-ranked
// inside the wasm reasoning bank); falls back to `getPatterns()` + a JS
// cosine rerank if the binding is missing (older vendored builds).
// k is capped at 16 because `pattern_clusters` is 16 — asking for more
// wouldn't return more rows.
export function findPatterns(trackVec, k = 5) {
  if (!sonaReady()) return [];
  const query = coerceSonaVec(trackVec);
  if (!query) return [];
  const cap = Math.max(1, Math.min(16, k | 0));
  let patterns = [];
  const parseRaw = (raw) => {
    // The crate's custom serde_wasm_bindgen shim returns a JSON string; we
    // also accept real arrays for future upstream rebuilds that switch back.
    if (typeof raw === 'string') return JSON.parse(raw);
    if (Array.isArray(raw)) return raw;
    if (raw && raw.length != null) return Array.from(raw);
    return [];
  };
  try {
    if (typeof _agent.findPatterns === 'function') {
      const raw = _agent.findPatterns(query, cap);
      patterns = parseRaw(raw);
    } else {
      const raw = _agent.getPatterns();
      patterns = parseRaw(raw);
    }
  } catch (e) {
    console.warn('[sona] findPatterns failed', e);
    return [];
  }
  const scored = [];
  for (const p of patterns) {
    const centroid = toFloat32(p.centroid);
    if (centroid.length !== query.length) continue;
    scored.push({
      id: String(p.id != null ? p.id : ''),
      sim: cosineSim(query, centroid),
      clusterSize: p.cluster_size | 0,
      avgQuality: Number(p.avg_quality) || 0,
      patternType: p.pattern_type || 'General',
      accessCount: p.access_count | 0,
    });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, cap);
}

// ─── info() — merged snapshot for the UI ───────────────────────────────────

export function info() {
  const lora = loraInfo();
  lora.driftRecent = loraRecentDrift();
  let sona;
  if (sonaReady()) {
    // getStats() → { total_trajectories, avg_quality, patterns_learned }
    // (see crates/sona/src/training/federated.rs::stats). trajectory_count
    // is a convenience duplicate we trust more than parsing getStats.
    let tcount = 0;
    try { tcount = _agent.trajectoryCount() | 0; } catch (_) { tcount = 0; }
    const pcount = readPatternCount(_agent) || _patternCount;
    _patternCount = pcount;
    sona = {
      ready: true,
      trajectories: tcount,
      patterns: pcount,
      microUpdates: _microUpdates,
      ewcLambda: SONA_CONFIG.ewc_lambda,
      trajectoryOpen: !!_traj,
      trajectorySteps: _traj ? _traj.steps.length : 0,
      savedExamples: _journal.examples.length,
      replayedExamples: _replayedExamples,
    };
  } else {
    sona = {
      ready: false,
      trajectories: 0,
      patterns: 0,
      microUpdates: 0,
      ewcLambda: SONA_CONFIG.ewc_lambda,
      trajectoryOpen: false,
      trajectorySteps: 0,
      savedExamples: _journal.examples.length,
      replayedExamples: 0,
    };
  }
  return { lora, sona };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function coerceSonaVec(vec) {
  if (!vec) return null;
  const f32 = toFloat32(vec);
  if (f32.length === 0) return null;
  // SONA's hidden_dim is fixed at construction. Pad with zeros or truncate so
  // arbitrary-sized activation vectors (e.g. the 8-unit hidden layer) still
  // embed into the agent's 512-dim space. Pad rather than re-project because
  // k-means only uses these as a similarity key — the exact shape only
  // matters relative to itself.
  if (f32.length === SONA_HIDDEN_DIM) return f32;
  const out = new Float32Array(SONA_HIDDEN_DIM);
  const n = Math.min(f32.length, SONA_HIDDEN_DIM);
  out.set(f32.subarray(0, n));
  return out;
}

function toFloat32(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return new Float32Array(v);
  if (v && v.buffer) return new Float32Array(v.buffer, v.byteOffset || 0, v.byteLength / 4);
  if (v && typeof v.length === 'number') return Float32Array.from(v);
  return new Float32Array(0);
}

// No progress must have zero quality. The previous shifted sigmoid gave a
// stationary, zero-checkpoint driver 0.5 quality and admitted it as a success.
function normaliseQuality(fitness) {
  return qualityFromFitness(Number(fitness));
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function readPatternCount(agent) {
  try {
    const stats = agent.getStats();
    if (!stats) return 0;
    // serde_wasm_bindgen in this crate falls back to a JSON string when the
    // object crosses the wasm boundary; callers have seen both shapes.
    const obj = (typeof stats === 'string') ? JSON.parse(stats) : stats;
    return (obj && (obj.patterns_learned | 0)) || (obj && (obj.patternsLearned | 0)) || 0;
  } catch (_) {
    return 0;
  }
}
