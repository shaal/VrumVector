// consistency/mode.js
// Phase 1C (F4) — consistency-mode state machine + query-path cache.
//
// This module is a *stateful singleton*: the bridge consults it on every
// recommendSeeds() call, and the UI radio-row flips it via setMode().
//
// Three modes (taxonomy mirrored from archive/snapshot.js CONSISTENCY_MODES):
//   - fresh    — every call hits the live archive. Current behaviour.
//   - eventual — cache the last recommendSeeds result, keyed by trackVec;
//                reuse for the next TTL_GENERATIONS calls.
//   - frozen   — pin an archive snapshot at mode-entry; queries only see
//                brains that existed at freeze time.
//
// The module itself is deliberately ignorant of *how* the bridge reads
// the live archive. It tracks: current mode, TTL cache, frozen-snapshot
// reference, and counters. The bridge's recommendSeeds decides what to
// do with each signal (see the `fresh | eventual | frozen` branch there).

import { CONSISTENCY_MODES } from '../archive/snapshot.js';

// Default TTL: how many calls a cached eventual-mode result stays valid
// for. Matches the plan's "default 10 generations" under the assumption
// that recommendSeeds fires roughly once per generation.
export const DEFAULT_TTL_GENERATIONS = 10;

let _mode = 'fresh';
let _ttl = DEFAULT_TTL_GENERATIONS;

// Eventual-mode cache. Keyed by trackVecKey (a short fingerprint the
// bridge computes from the query vector — see `trackVecKey()` below for
// the shared helper). Cached entries know when they were stored and how
// many hits they have left.
//   Map<string, { value, insertedAtCall, expiresAtCall }>
const _cache = new Map();

// Frozen-mode snapshot reference. The bridge stores a pragmatic anchor
// (e.g. the brain insertion count at freeze time) here; the module just
// holds and returns whatever is handed to it. `_frozenAt` is the ISO
// timestamp the freeze was entered at, exposed via stats().
let _frozenSnapshot = null;
let _frozenAt = null;

// Monotonic counter of recommendSeeds() calls. Incremented on every
// getCachedResult call (hit or miss). TTL is expressed in "calls from
// now"; storing `expiresAtCall` up front keeps expiry O(1) on lookup.
let _callCount = 0;
let _cacheHits = 0;
let _cacheMisses = 0;

// ─── mode ────────────────────────────────────────────────────────────────

export function getMode() { return _mode; }

// Validated setter. Does NOT run the bridge-side transition side effects
// (that's setConsistencyMode()'s job in ruvectorBridge.js); this just
// updates local state + clears the cache on mode change so stale
// eventual-mode entries can't leak into a fresh-mode query.
export function setMode(m) {
  if (!CONSISTENCY_MODES.includes(m)) {
    throw new Error(`consistency/mode: invalid mode ${m}`);
  }
  if (m === _mode) return;
  _mode = m;
  // Any mode change invalidates the eventual cache — the semantics of
  // "cache" change between modes, so keeping stale entries around would
  // be a footgun.
  _cache.clear();
}

export function getTtl() { return _ttl; }
export function setTtl(n) {
  const v = Math.max(1, (n | 0));
  _ttl = v;
}

// ─── trackVec fingerprint ────────────────────────────────────────────────
//
// The eventual cache keys on the *query vector identity*, not object
// identity. Two subsequent recommendSeeds calls with the same underlying
// float data (but different Float32Array wrappers) should hit the same
// cache entry. A short FNV-1a-ish digest over the first 32 floats is
// fingerprint enough for this use case — collisions across truly
// distinct track embeddings are vanishingly unlikely at that resolution.
export function trackVecKey(vec) {
  if (!vec) return '_null';
  if (typeof vec === 'string') return vec; // allow pre-computed keys
  if (!(vec instanceof Float32Array)) {
    try { vec = new Float32Array(vec); } catch (_) { return '_invalid'; }
  }
  // Simple cheap rolling mix of the first 32 components + length; no
  // cryptographic guarantees needed, just uniqueness across the
  // ~dozens of distinct track vectors a session ever sees.
  let h = 2166136261 >>> 0;
  const n = Math.min(32, vec.length | 0);
  for (let i = 0; i < n; i++) {
    // Pack the float's bitwise representation into the mix so tiny
    // numerical wobble still hashes identically when values round-trip.
    const b = Math.fround(vec[i]);
    const u = new Uint32Array(new Float32Array([b]).buffer)[0];
    h ^= u;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 'v' + vec.length + ':' + h.toString(16).padStart(8, '0');
}

// ─── eventual-mode cache ─────────────────────────────────────────────────

// Record a fresh query result under this track key. Only called by the
// bridge when _mode === 'eventual' and the previous lookup was a miss.
export function recordQuery(key, result) {
  if (!key) return;
  _cache.set(key, {
    value: result,
    insertedAtCall: _callCount,
    expiresAtCall: _callCount + _ttl,
  });
}

// Look up the cache. Always increments _callCount so the caller's
// behaviour stays consistent whether or not there's a hit — TTL is
// counted in "recommendSeeds calls since insert". Returns a
// discriminated union so the caller can branch on `hit`.
export function getCachedResult(key) {
  _callCount++;
  if (!key) {
    _cacheMisses++;
    return { hit: false, reason: 'no-key' };
  }
  const entry = _cache.get(key);
  if (!entry) {
    _cacheMisses++;
    return { hit: false, reason: 'miss' };
  }
  if (_callCount > entry.expiresAtCall) {
    _cache.delete(key);
    _cacheMisses++;
    return { hit: false, reason: 'expired' };
  }
  _cacheHits++;
  return { hit: true, value: entry.value };
}

// What the next getCachedResult(key) would return, without counting a call,
// counting a hit or miss, or evicting. For read-only previews.
export function peekCachedResult(key) {
  const entry = key ? _cache.get(key) : null;
  return entry && _callCount + 1 <= entry.expiresAtCall ? { hit: true, value: entry.value } : { hit: false };
}

export function clearCache() { _cache.clear(); }

// ─── frozen-mode snapshot ref ────────────────────────────────────────────

// The bridge passes a "snapshot-like" object here — in practice, either
// an ArchiveSnapshot produced by exportSnapshot() or (for the bridge's
// cap-by-insertionOrder shortcut) a lightweight descriptor
// { frozenBrainCount: number, frozenBrainIds: Set<string> }. The module
// treats the reference as opaque; the bridge knows how to interpret it.
export function freezeArchive(snapshot) {
  _frozenSnapshot = snapshot || null;
  _frozenAt = new Date().toISOString();
}

export function thawArchive() {
  _frozenSnapshot = null;
  _frozenAt = null;
}

export function getFrozenSnapshot() { return _frozenSnapshot; }

// ─── introspection ───────────────────────────────────────────────────────

export function stats() {
  return {
    mode: _mode,
    ttl: _ttl,
    cacheHits: _cacheHits,
    cacheMisses: _cacheMisses,
    cacheSize: _cache.size,
    callCount: _callCount,
    frozenSince: _frozenAt,
    frozen: _frozenSnapshot != null,
  };
}

// ─── test hook ───────────────────────────────────────────────────────────

export function _debugReset() {
  _mode = 'fresh';
  _ttl = DEFAULT_TTL_GENERATIONS;
  _cache.clear();
  _frozenSnapshot = null;
  _frozenAt = null;
  _callCount = 0;
  _cacheHits = 0;
  _cacheMisses = 0;
}
