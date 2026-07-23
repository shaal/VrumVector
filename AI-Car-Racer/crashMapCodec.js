// crashMapCodec.js — encode gen-end death positions into a fixed grid vector
// for HNSW / cosine search. Classic script + ES-module friendly (no deps).
//
// Grid is 16×9 over the 3200×1800 canvas (CRASH_DIM = 144). Cell values are
// log1p(count) then L2-normalised so cosine distance is well-behaved.
//
// Surface: window.CrashMapCodec (classic) and named exports when imported.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') root.CrashMapCodec = api;
  // ES module re-export surface when this file is imported as a module via
  // dynamic import of a thin wrapper — bridge inlines the same constants
  // for no-build static import simplicity; keep this file as the source of
  // truth for adaptiveGates (classic).
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CRASH_GW = 16;
  const CRASH_GH = 9;
  const CRASH_DIM = CRASH_GW * CRASH_GH;
  const DEFAULT_W = 3200;
  const DEFAULT_H = 1800;

  /**
   * @param {Float32Array|null} popDeathXY  length 2N, NaN for alive
   * @param {number} N
   * @param {number} [canvasW]
   * @param {number} [canvasH]
   * @returns {Float32Array|null} L2-normalised CRASH_DIM vector, or null if no deaths
   */
  function encodeDeathMap(popDeathXY, N, canvasW, canvasH) {
    if (!popDeathXY || !N) return null;
    const W = canvasW || (typeof canvas !== 'undefined' && canvas && canvas.width) || DEFAULT_W;
    const H = canvasH || (typeof canvas !== 'undefined' && canvas && canvas.height) || DEFAULT_H;
    const grid = new Float32Array(CRASH_DIM);
    let deaths = 0;
    for (let i = 0; i < N; i++) {
      const x = popDeathXY[i * 2];
      const y = popDeathXY[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      let gx = Math.floor((x / W) * CRASH_GW);
      let gy = Math.floor((y / H) * CRASH_GH);
      if (gx < 0) gx = 0; else if (gx >= CRASH_GW) gx = CRASH_GW - 1;
      if (gy < 0) gy = 0; else if (gy >= CRASH_GH) gy = CRASH_GH - 1;
      grid[gy * CRASH_GW + gx] += 1;
      deaths++;
    }
    if (deaths < 3) return null;
    // log1p compresses hot cells so one pile-up doesn't dominate the embedding
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

  /** Decode a (possibly unnormalised) map back to a dense GH×GW count-ish grid for viz. */
  function decodeToGrid(vec) {
    const out = new Float32Array(CRASH_DIM);
    if (!vec || vec.length !== CRASH_DIM) return out;
    for (let i = 0; i < CRASH_DIM; i++) out[i] = Math.max(0, vec[i]);
    return out;
  }

  function causeHistogram(popDeathCauses, N) {
    const h = { headOn: 0, side: 0, slide: 0, stalled: 0, alive: 0 };
    if (!popDeathCauses || !N) return h;
    for (let i = 0; i < N; i++) {
      const c = popDeathCauses[i] | 0;
      if (c === 0) h.headOn++;
      else if (c === 1) h.side++;
      else if (c === 2) h.slide++;
      else if (c === 3) h.stalled++;
      else h.alive++;
    }
    return h;
  }

  return {
    CRASH_GW: CRASH_GW,
    CRASH_GH: CRASH_GH,
    CRASH_DIM: CRASH_DIM,
    encodeDeathMap: encodeDeathMap,
    decodeToGrid: decodeToGrid,
    causeHistogram: causeHistogram,
  };
});
