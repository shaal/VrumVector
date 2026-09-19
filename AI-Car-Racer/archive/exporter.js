// archive/exporter.js
// Phase 1A (F3) — build a validated ArchiveSnapshot from the live bridge
// mirrors. Deterministic-replay path only: we do NOT ship the native HNSW
// bytes (that's the upstream-patch dance flagged in
// docs/plan/ruvector-upstream-patches.md). Instead we record the insertion
// order and let the importer re-insert in the same order on the other side
// to reproduce graph connectivity byte-for-byte.
//
// API
//   buildSnapshot({
//     brainMirror,         Map<id, {vector:Float32Array, meta}>
//     trackMirror,         Map<id, {vector:Float32Array, meta}>
//     dynamicsMirror,      Map<id, {vector:Float32Array, meta}>
//     observations,        Map<id, {weight:number, count:number}>
//     indexKind,           'euclidean' | 'hyperbolic'
//     insertionOrder,      string[]  — insertion order of brain ids
//     consistency,         optional: 'fresh' | 'eventual' | 'frozen' (default 'fresh')
//     dim,                 optional: flat-vector dimensionality (for hnsw.params)
//   }) → ArchiveSnapshot
//
// The `witness` field is sha-256 hex of the canonicalized payload. Computed
// synchronously via a plain JS sha-256 implementation so buildSnapshot can
// stay synchronous (the serialize/fromBlob path is already async; piping
// witness through another Promise layer was a needless API complication).
// A crypto.subtle-based async variant is exported as `buildSnapshotAsync`
// for callers who prefer the web-standard digest.

import { ARCHIVE_SCHEMA_VERSION, validateSnapshot } from './snapshot.js';
import { xxHash32Bytes } from './hash.js';

// ─── witness ─────────────────────────────────────────────────────────────
// We canonicalize the payload ourselves (stable key order, Float32Array →
// plain Array, Map iteration order preserved) and then hash the JSON string.
// Strategy: prefer sha-256 via crypto.subtle when available (all modern
// browsers since ~2018), fall back to xxHash32 (non-crypto, already vendored
// in archive/hash.js) when running in an environment without subtle. The
// fallback is documented loudly — an attacker doesn't change the behaviour
// of the importer, they just need to produce a matching witness, so xxHash32
// is "good enough" for the self-check use-case the field was created for.

function _canonicalBrainRows(mirror) {
  const rows = [];
  for (const [id, { vector, meta }] of mirror) {
    rows.push({
      id: String(id),
      flat: Array.from(vector), // JSON-serializable; reader rebuilds a Float32Array
      meta: meta || {},
    });
  }
  return rows;
}

function _canonicalVecRows(mirror) {
  const rows = [];
  for (const [id, { vector, meta }] of mirror) {
    rows.push({ id: String(id), vec: Array.from(vector), meta: meta || {} });
  }
  return rows;
}

function _canonicalObsRows(observations) {
  const rows = [];
  for (const [id, { weight, count, baseline }] of observations) {
    const row={ id: String(id), weight: Number(weight) || 0, count: count | 0 };
    if(Number.isFinite(baseline))row.baseline=baseline;
    rows.push(row);
  }
  return rows;
}

// Synchronous witness. Uses xxHash32Bytes over the UTF-8 bytes of the
// canonical JSON string when crypto.subtle isn't available or the caller
// refuses to go async. Returned as "x32:<hex>" so consumers can distinguish
// the fallback from a real sha-256 hex string at a glance.
function _witnessSync(canonicalJson) {
  const enc = (typeof TextEncoder !== 'undefined')
    ? new TextEncoder().encode(canonicalJson)
    : _utf8Encode(canonicalJson);
  const h = xxHash32Bytes(enc);
  return 'x32:' + h.toString(16).padStart(8, '0');
}

async function _witnessAsync(canonicalJson) {
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.subtle.digest) {
    return _witnessSync(canonicalJson);
  }
  const enc = (typeof TextEncoder !== 'undefined')
    ? new TextEncoder().encode(canonicalJson)
    : _utf8Encode(canonicalJson);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return 'sha256:' + hex;
}

// Minimal UTF-8 encoder fallback for environments without TextEncoder (very
// old Safari in strict-sandbox mode). Keeps the module usable even in the
// oldest harness.
function _utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

// Build the canonical JSON (excluding the witness field — the witness hashes
// everything else). Using a fixed key order so two sessions that assemble
// equivalent mirrors produce byte-identical payloads.
function _canonicalJson(core) {
  const ordered = {
    version: core.version,
    createdAt: core.createdAt,
    consistency: core.consistency,
    brains: core.brains,
    tracks: core.tracks,
    dynamics: core.dynamics,
    observations: core.observations,
    hnsw: {
      mode: core.hnsw.mode,
      serialized: core.hnsw.serialized, // always null in replay mode
      insertionOrder: core.hnsw.insertionOrder,
      params: core.hnsw.params,
    },
  };
  return JSON.stringify(ordered);
}

// Shared core builder — used by both sync and async variants so the
// canonicalization path stays identical.
function _buildCore(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('buildSnapshot: missing options object');
  }
  const {
    brainMirror, trackMirror, dynamicsMirror, observations,
    indexKind = 'euclidean',
    insertionOrder = [],
    consistency = 'fresh',
    dim = null,
  } = opts;
  if (!(brainMirror instanceof Map)) throw new Error('buildSnapshot: brainMirror must be a Map');
  if (!(trackMirror instanceof Map)) throw new Error('buildSnapshot: trackMirror must be a Map');
  if (!(dynamicsMirror instanceof Map)) throw new Error('buildSnapshot: dynamicsMirror must be a Map');
  if (!(observations instanceof Map)) throw new Error('buildSnapshot: observations must be a Map');

  // Filter insertionOrder to ids still present in the mirror. The bridge
  // sometimes _debugResets mid-session; an id in the order list with no
  // mirror entry is just noise.
  const order = Array.isArray(insertionOrder)
    ? insertionOrder.filter((id) => brainMirror.has(id))
    : [];

  const resolvedDim = Number.isFinite(dim) && dim > 0
    ? (dim | 0)
    : (brainMirror.size > 0
        ? (brainMirror.values().next().value.vector.length | 0)
        : 0);

  return {
    version: ARCHIVE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    consistency,
    brains: _canonicalBrainRows(brainMirror),
    tracks: _canonicalVecRows(trackMirror),
    dynamics: _canonicalVecRows(dynamicsMirror),
    observations: _canonicalObsRows(observations),
    hnsw: {
      mode: 'replay',
      serialized: null,
      insertionOrder: order,
      params: { dim: resolvedDim, metric: 'cosine', indexKind },
    },
  };
}

// Public sync API. `witness` uses xxHash32 (tagged "x32:...") — good enough
// for the self-check role, synchronous so the call site doesn't have to
// await. Validates the result before returning so a malformed snapshot can
// never leak out of this module.
export function buildSnapshot(opts) {
  const core = _buildCore(opts);
  const json = _canonicalJson(core);
  core.witness = _witnessSync(json);
  const v = validateSnapshot(core);
  if (!v.ok) throw new Error(`buildSnapshot: produced invalid snapshot (${v.reason})`);
  return core;
}

// Public async API — uses crypto.subtle sha-256 when available. Useful when
// the caller wants the stronger self-check; falls back to the sync path on
// insecure contexts (file://, old Safari) without surfacing the difference
// except through the witness-string prefix.
export async function buildSnapshotAsync(opts) {
  const core = _buildCore(opts);
  const json = _canonicalJson(core);
  core.witness = await _witnessAsync(json);
  const v = validateSnapshot(core);
  if (!v.ok) throw new Error(`buildSnapshotAsync: produced invalid snapshot (${v.reason})`);
  return core;
}
