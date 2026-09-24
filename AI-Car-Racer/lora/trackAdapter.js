// trackAdapter.js
// MicroLoRA adapter on track embeddings (P1.B).
//
// Wraps two WasmMicroLoRA(256) instances — one for the lower 256 dims of the
// 512-dim track vector, one for the upper. The upstream MicroLoRA is
// hard-capped at dim=256 (B matrix is `[[f32; 256]; 2]`), so we run the rank-2
// LoRA as two block-diagonal halves. From the caller's perspective the adapter
// is a single 512-in / 512-out function.
//
// Public surface:
//   await loadAdapter()                  init the two wasm engines (idempotent)
//   isReady()                            sync availability check
//   adapt(trackVec)        -> Float32Array(512)  forward pass + L2 renormalise
//   reward(fitness)                      update both halves using the last
//                                        adapted vector's raw input as gradient
//   driftL2()              -> number     L2 distance between last raw + adapted
//   recentDrift()          -> number[]   short history for the UI sparkline
//   info()                 -> object     stats for the bridge's info() surface
//   serialize()            -> {b0,b1,baseline,adaptCount,adaptRecent}
//   deserialize(snapshot)  -> bool       restore state, false if shape mismatch
//
// The adapter only learns when training improves on the running baseline. We
// keep a simple EMA baseline of the normalised fitness (tanh(fit/100)); the
// reward signal handed to WasmMicroLoRA is `improvement = max(0, current -
// baseline)`. The Rust side ignores non-positive improvements (see lora.rs
// `adapt_with_reward`), so the baseline gate keeps adaptation noise-free until
// the GA actually gets better.

import initLora, { WasmMicroLoRA } from '../../vendor/ruvector/ruvector_learning_wasm/ruvector_learning_wasm.js';

const HALF_DIM = 256;
const FULL_DIM = HALF_DIM * 2; // 512
const ALPHA = 0.1;
const LR = 0.01;
const BASELINE_EMA = 0.3;
const DRIFT_HISTORY = 32; // sparkline width

let _ready = null;
let _loraLo = null;
let _loraHi = null;

let _lastRaw = null;     // Float32Array(512) — most recent input to adapt()
let _lastAdapted = null; // Float32Array(512) — most recent output of adapt()
let _baseline = 0;       // EMA of tanh(fitness/100)
let _baselineHasValue = false;
let _adaptCount = 0;     // total reward() calls that actually triggered an update
let _rewardCount = 0;    // total reward() calls (including no-op below baseline)
const _driftHistory = [];

export function loadAdapter() {
  if (_ready) return _ready;
  _ready = (async () => {
    try {
      await initLora();
      _loraLo = new WasmMicroLoRA(HALF_DIM, ALPHA, LR);
      _loraHi = new WasmMicroLoRA(HALF_DIM, ALPHA, LR);
      return { lo: _loraLo, hi: _loraHi };
    } catch (e) {
      console.warn('[track-adapter] load failed; LoRA path disabled', e);
      _loraLo = null;
      _loraHi = null;
      return null;
    }
  })();
  return _ready;
}

export function isReady() {
  return !!(_loraLo && _loraHi);
}

// Returns the adapted vector. If the adapter isn't ready or the input is the
// wrong shape, returns the input unchanged so callers can compose blindly.
export function adapt(trackVec) {
  if (!isReady() || !(trackVec instanceof Float32Array) || trackVec.length !== FULL_DIM) {
    return trackVec;
  }
  // Cache raw — needed both for drift measurement and as the gradient signal
  // we hand to adapt_with_reward() at reward() time. We copy because the caller
  // may mutate or the underlying buffer may be a view into a transient image.
  _lastRaw = new Float32Array(trackVec);
  const out = forward(trackVec);
  _lastAdapted = out;
  recordDrift();
  return out;
}

// The same transform for a read-only preview: caches nothing, so reward()
// and the drift history still refer to the last real adapt() call.
export function preview(trackVec) {
  if (!isReady() || !(trackVec instanceof Float32Array) || trackVec.length !== FULL_DIM) {
    return trackVec;
  }
  return forward(trackVec);
}

function forward(trackVec) {
  const lo = trackVec.subarray(0, HALF_DIM);
  const hi = trackVec.subarray(HALF_DIM, FULL_DIM);
  const outLo = _loraLo.forward_array(lo);
  const outHi = _loraHi.forward_array(hi);
  const out = new Float32Array(FULL_DIM);
  out.set(outLo, 0);
  out.set(outHi, HALF_DIM);
  // Track vectors come in L2-normalised (CnnEmbedder.extract guarantees it),
  // so re-normalise post-adaptation to stay on the unit sphere. This also
  // keeps cosine distance well-behaved when the LoRA delta is large.
  l2NormaliseInPlace(out);
  return out;
}

// Update the adapter using the most recently `adapt()`-ed vector as the
// gradient signal. Caller passes raw fitness; we EMA-smooth it into a baseline
// and use the positive part of (current - baseline) as the improvement scalar.
// No-op if there's no cached input or the adapter isn't ready.
export function reward(fitness) {
  if (!isReady() || !_lastRaw) return;
  _rewardCount += 1;
  const cur = Math.tanh((Number(fitness) || 0) / 100);
  let improvement;
  if (!_baselineHasValue) {
    // First reward — establish the baseline but don't update; we have nothing
    // to compare against, and updating on a vacuous "improvement" would just
    // bias B in the direction of the very first track regardless of quality.
    _baseline = cur;
    _baselineHasValue = true;
    return;
  }
  improvement = cur - _baseline;
  _baseline = BASELINE_EMA * cur + (1 - BASELINE_EMA) * _baseline;
  if (improvement <= 0) return; // Rust side would skip too; bail before the wasm call

  // Use the raw track-vector half as the gradient direction. lora.rs
  // L2-normalises the gradient internally before applying the rank-1 outer
  // product to B, so any pre-scaling on the JS side would be cancelled —
  // we just hand it the slice. The improvement scalar gates *whether* we
  // adapt (above) but does not modulate magnitude.
  _loraLo.adapt_array(_lastRaw.subarray(0, HALF_DIM));
  _loraHi.adapt_array(_lastRaw.subarray(HALF_DIM, FULL_DIM));
  _adaptCount += 1;
}

export function driftL2() {
  if (!_lastRaw || !_lastAdapted) return 0;
  let s = 0;
  for (let i = 0; i < FULL_DIM; i++) {
    const d = _lastAdapted[i] - _lastRaw[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

export function recentDrift() {
  return _driftHistory.slice();
}

function recordDrift() {
  const d = driftL2();
  _driftHistory.push(d);
  if (_driftHistory.length > DRIFT_HISTORY) _driftHistory.shift();
}

export function info() {
  return {
    ready: isReady(),
    drift: driftL2(),
    adaptCount: _adaptCount,
    rewardCount: _rewardCount,
    baseline: _baseline,
    baselineHasValue: _baselineHasValue,
    deltaNormLo: isReady() ? _loraLo.delta_norm() : 0,
    deltaNormHi: isReady() ? _loraHi.delta_norm() : 0,
  };
}

// State shape for IndexedDB. The A matrices are deterministic (pseudo_random
// from a fixed seed inside lora.rs::LoRAPair::new) so we don't need to
// persist them — the same constructor produces the same A every time.
export function serialize() {
  if (!isReady()) return null;
  return {
    v: 1,
    halfDim: HALF_DIM,
    b0: Array.from(_loraLo.get_b()),
    b1: Array.from(_loraHi.get_b()),
    baseline: _baseline,
    baselineHasValue: _baselineHasValue,
    adaptCount: _adaptCount,
    rewardCount: _rewardCount,
    driftRecent: _driftHistory.slice(),
  };
}

export function deserialize(snap) {
  if (!isReady() || !snap || snap.halfDim !== HALF_DIM) return false;
  const validRaw = value => (Array.isArray(value) || value instanceof Float32Array)
    && value.length === 2 * HALF_DIM && value.every(Number.isFinite);
  if (!validRaw(snap.b0) || !validRaw(snap.b1)) return false;
  const b0 = toF32(snap.b0);
  const b1 = toF32(snap.b1);
  if (b0.length !== 2 * HALF_DIM || b1.length !== 2 * HALF_DIM
      || !b0.every(Number.isFinite) || !b1.every(Number.isFinite)) return false;
  _loraLo.set_b(b0);
  _loraHi.set_b(b1);
  _baseline = Number.isFinite(snap.baseline) ? snap.baseline : 0;
  _baselineHasValue = !!snap.baselineHasValue;
  _adaptCount = snap.adaptCount | 0;
  _rewardCount = snap.rewardCount | 0;
  _driftHistory.length = 0;
  if (Array.isArray(snap.driftRecent)) {
    for (const v of snap.driftRecent.slice(-DRIFT_HISTORY)) _driftHistory.push(Number(v) || 0);
  }
  return true;
}

// Test-only — clears in-memory state without re-initialising the wasm engines.
// The B matrices are zeroed via `reset()`; A is left as-is (deterministic).
export function _debugReset() {
  if (_loraLo) _loraLo.reset();
  if (_loraHi) _loraHi.reset();
  _lastRaw = null;
  _lastAdapted = null;
  _baseline = 0;
  _baselineHasValue = false;
  _adaptCount = 0;
  _rewardCount = 0;
  _driftHistory.length = 0;
}

function l2NormaliseInPlace(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  if (s <= 0) return;
  const inv = 1 / Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
}

function toF32(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return new Float32Array(v);
  return new Float32Array(0);
}
