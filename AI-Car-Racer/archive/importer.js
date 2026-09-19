// archive/importer.js
// Phase 1A (F3) — replay-mode warm-restart importer. Takes an
// ArchiveSnapshot produced by archive/exporter.js, validates it, clears the
// caller-provided indexes + mirrors, and re-inserts every brain in the
// recorded insertion order so the HNSW graph rebuilds to a byte-identical
// shape. Tracks, dynamics, and observations are loaded in their own stable
// orders (sorted by id) — those indexes aren't queried by the reranker in
// ways that depend on graph connectivity, so the recorded order isn't
// captured for them.
//
// API
//   applySnapshot(snapshot, {
//     brainDB, trackDB, dynamicsDB,       live VectorDB instances (bridge owns)
//     brainMirror, trackMirror, dynamicsMirror, observations,  live Maps
//   }) → { ok: true, counts: { brains, tracks, dynamics, observations } }
//
// Throws on validation failure. Does NOT touch IndexedDB — the bridge's
// schedulePersist() will pick up the new state on its own timer.

import { validateSnapshot } from './snapshot.js';

function _toFloat32(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return new Float32Array(v);
  if (v && typeof v.buffer !== 'undefined') {
    return new Float32Array(v.buffer, v.byteOffset || 0, (v.byteLength || 0) / 4);
  }
  return new Float32Array(0);
}

export function applySnapshot(snapshot, targets) {
  const v = validateSnapshot(snapshot);
  if (!v.ok) throw new Error(`applySnapshot: invalid snapshot (${v.reason})`);
  if (!targets) throw new Error('applySnapshot: missing targets');
  const {
    brainDB, trackDB, dynamicsDB,
    brainMirror, trackMirror, dynamicsMirror, observations,
  } = targets;
  for (const [name, obj] of [
    ['brainDB', brainDB], ['trackDB', trackDB], ['dynamicsDB', dynamicsDB],
  ]) {
    if (!obj) throw new Error(`applySnapshot: missing target ${name}`);
  }
  for (const [name, obj] of [
    ['brainMirror', brainMirror], ['trackMirror', trackMirror],
    ['dynamicsMirror', dynamicsMirror], ['observations', observations],
  ]) {
    if (!(obj instanceof Map)) throw new Error(`applySnapshot: target ${name} must be a Map`);
  }

  // Wipe mirrors first. We do NOT recreate the VectorDB instances here —
  // the caller (ruvectorBridge) rebuilds them ahead of time when the index
  // kind might change. For the pure replay path the VectorDBs passed in
  // are assumed to be freshly constructed and empty. The bridge's wrapper
  // in exportSnapshot/importSnapshot handles that invariant.
  brainMirror.clear();
  trackMirror.clear();
  dynamicsMirror.clear();
  observations.clear();

  // Tracks first — brain meta references trackId, dynamics mirrors pop next
  // because brain meta may reference dynamicsId; identical ordering to
  // ruvectorBridge.hydrate() for consistency.
  const trackRows = Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
  for (const row of trackRows) {
    const vec = _toFloat32(row.vec || row.flat);
    if (vec.length === 0) continue;
    trackDB.insert(vec, row.id, row.meta || {});
    trackMirror.set(row.id, { vector: vec, meta: row.meta || {} });
  }

  const dynRows = Array.isArray(snapshot.dynamics) ? snapshot.dynamics : [];
  for (const row of dynRows) {
    const vec = _toFloat32(row.vec || row.flat);
    if (vec.length === 0) continue;
    dynamicsDB.insert(vec, row.id, row.meta || {});
    dynamicsMirror.set(row.id, { vector: vec, meta: row.meta || {} });
  }

  // Brains: walk insertionOrder so the HNSW graph rebuilds byte-for-byte;
  // fall back to the row order when the snapshot was hand-crafted without a
  // captured order (older fixtures / unit tests).
  const byId = new Map();
  const rowBrains = Array.isArray(snapshot.brains) ? snapshot.brains : [];
  for (const row of rowBrains) byId.set(row.id, row);

  const order = (snapshot.hnsw && Array.isArray(snapshot.hnsw.insertionOrder))
    ? snapshot.hnsw.insertionOrder.filter((id) => byId.has(id))
    : [];

  // If insertionOrder is empty but we have brain rows, fall back to the row
  // iteration order. Better than dropping the brains on the floor.
  const walk = order.length > 0 ? order : rowBrains.map((r) => r.id);

  // Seen guard so duplicated ids in insertionOrder don't cause double
  // inserts (which would blow up the mirror size counter).
  const seen = new Set();
  for (const id of walk) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (!row) continue;
    const vec = _toFloat32(row.flat || row.vec);
    if (vec.length === 0) continue;
    brainDB.insert(vec, row.id, row.meta || {});
    brainMirror.set(row.id, { vector: vec, meta: row.meta || {} });
  }

  const obsRows = Array.isArray(snapshot.observations) ? snapshot.observations : [];
  for (const row of obsRows) {
    observations.set(row.id, {
      weight: Number(row.weight) || 0,
      count: (row.count | 0),
      baseline: Number.isFinite(row.baseline)?row.baseline:undefined,
    });
  }

  return {
    ok: true,
    counts: {
      brains: brainMirror.size,
      tracks: trackMirror.size,
      dynamics: dynamicsMirror.size,
      observations: observations.size,
    },
  };
}
