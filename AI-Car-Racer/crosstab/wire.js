// crosstab/wire.js
// Phase 2B — F6 wire format for a single-brain delta broadcast between tabs.
//
// The payload is a FRAGMENT of the Phase 0 ArchiveSnapshot shape — one brain +
// its track vec + a small meta bag — NOT a whole snapshot. The receiving tab
// calls archiveBrain() with the decoded parts, so dedup (F5) is what collapses
// identical brains across tabs: two tabs archiving the same weights produce
// the same hash and only one node is created. That invariant is load-bearing —
// without it the receive path would grow the archive unbounded under replay.
//
// Why plain Array<number> instead of Float32Array on the wire:
//   BroadcastChannel uses structured clone, which DOES preserve Float32Array.
//   But two tabs can be running slightly different builds of the app (one
//   refreshed mid-session, one stale), and a future release might re-encode
//   vectors. Plain JSON-ish Arrays are the lowest-common-denominator wire
//   representation that stays cloneable across any version skew and round-
//   trips through e.g. JSON.stringify for debugging. Cost is ~2x on the wire,
//   which for a 244-float brain is ~3kB — well under the ~10MB/message cap
//   browsers give BroadcastChannel.
//
// toWire(brain, fitness, trackVec, meta) → wire object
//   brain     : Float32Array of FLAT_LENGTH (the already-flattened weights)
//   fitness   : number (meta.fitness, optional — 0 if missing)
//   trackVec  : Float32Array(TRACK_DIM) | null
//   meta      : { generation?, parentIds?, fastestLap?, dynamicsVec?, ... }
//
// fromWire(msg) → { flat, hash, fitness, trackVec, meta }
//   flat      : Float32Array (rebuilt from Array)
//   hash      : string (the sender's hash; we re-verify on the receive path
//               implicitly because archiveBrain recomputes via dedup)
//   trackVec  : Float32Array | null
//   meta      : passthrough object; `dynamicsVec` (if present) is lifted back
//               into a Float32Array too.

import { FLAT_LENGTH } from '../brainCodec.js';
import { hashBrain } from '../archive/hash.js';
import {cleanContext,clamp} from '../learning/policy.js';

function cleanLearning(value) {
  if (!value?.context) return undefined;
  const learning = {context:cleanContext(value.context),styleScore:clamp(value.styleScore,0,1)};
  if (value.driving && typeof value.driving === 'object') {
    learning.driving = {};
    for (const key of ['averageSpeed','nearWallRate','slideRate','smoothness']) {
      if (Number.isFinite(value.driving[key])) learning.driving[key] = clamp(value.driving[key],0,1);
    }
    for (const key of ['steeringChanges','aliveSeconds']) {
      if (Number.isFinite(value.driving[key])) learning.driving[key] = clamp(value.driving[key],0,1e9);
    }
    if (typeof value.driving.crashed === 'boolean') learning.driving.crashed = value.driving.crashed;
  }
  return learning;
}

function f32ToArray(v) {
  if (!v) return null;
  // Array.from is the clearest read; for a 244-float brain the cost is
  // immaterial (<0.1ms).
  return Array.from(v);
}

function arrayToF32(arr, expectedLen) {
  if (!Array.isArray(arr)) return null;
  if (expectedLen != null && arr.length !== expectedLen) return null;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]) || 0;
  return out;
}

export function toWire(flat, fitness, trackVec, meta) {
  if (!(flat instanceof Float32Array) || flat.length !== FLAT_LENGTH) {
    throw new Error(`crosstab/wire.toWire: flat must be Float32Array(${FLAT_LENGTH})`);
  }
  const hash = hashBrain(flat);
  const outMeta = {};
  if (meta && typeof meta === 'object') {
    if (Number.isFinite(meta.generation)) outMeta.generation = meta.generation | 0;
    if (Array.isArray(meta.parentIds)) outMeta.parentIds = meta.parentIds.slice();
    if (Number.isFinite(meta.fastestLap)) outMeta.fastestLap = Number(meta.fastestLap);
    if(meta.learning?.context)outMeta.learning=cleanLearning(meta.learning);
    if (meta.dynamicsVec instanceof Float32Array) {
      outMeta.dynamicsVec = f32ToArray(meta.dynamicsVec);
    }
  }
  return {
    flat: f32ToArray(flat),
    hash,
    fitness: Number.isFinite(fitness) ? Number(fitness) : 0,
    trackVec: (trackVec instanceof Float32Array) ? f32ToArray(trackVec) : null,
    meta: outMeta,
  };
}

export function fromWire(msg) {
  if (!msg || typeof msg !== 'object') {
    throw new Error('crosstab/wire.fromWire: payload missing');
  }
  const flat = arrayToF32(msg.flat, FLAT_LENGTH);
  if (!flat) {
    throw new Error('crosstab/wire.fromWire: flat has wrong length');
  }
  const trackVec = Array.isArray(msg.trackVec) ? arrayToF32(msg.trackVec) : null;
  const metaIn = (msg.meta && typeof msg.meta === 'object') ? msg.meta : {};
  const meta = {
    generation: Number.isFinite(metaIn.generation) ? (metaIn.generation | 0) : 0,
    parentIds: Array.isArray(metaIn.parentIds) ? metaIn.parentIds.slice() : [],
  };
  if (Number.isFinite(metaIn.fastestLap)) meta.fastestLap = Number(metaIn.fastestLap);
  if(metaIn.learning?.context)meta.learning=cleanLearning(metaIn.learning);
  if (Array.isArray(metaIn.dynamicsVec)) {
    const dyn = arrayToF32(metaIn.dynamicsVec);
    if (dyn) meta.dynamicsVec = dyn;
  }
  return {
    flat,
    hash: typeof msg.hash === 'string' ? msg.hash : hashBrain(flat),
    fitness: Number.isFinite(msg.fitness) ? Number(msg.fitness) : 0,
    trackVec,
    meta,
  };
}
