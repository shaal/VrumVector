// adaptiveGates.js — opt-in curriculum for green checkpoint lines.
//
// When enabled:
//   1. Measure reach rates from popCheckpoints each generation.
//   2. Find the bottleneck gate (largest drop in reach rate).
//   3. Use crash positions (popDeathXY — same signal as Heat mode) to aim
//      nudges: pull the hard gate toward the approach side of the death
//      cluster so cars get credit / next-CP direction *before* the wall.
//   4. Occasionally ADD a gate (midway before a severe cliff) or REMOVE a
//      near-redundant intermediate.
//   5. Remember high-survival layouts + crash centroids per track.
//
// Relation to Heat / ruvector:
//   Heat mode — live viz of death deposits.
//   Worker popDeathXY — same events, authoritative end-of-gen positions.
//   Crash-map HNSW (ruvectorBridge) — encodes the death grid (16×9) into a
//     144-d vector, stores it with the gate layout + survival, retrieves
//     similar past crash problems so we can reuse layouts that worked.
//   Brains archive — still separate (who drives); crash maps are curriculum.
//
// Safety rails (from prior Triangle curriculum failures):
//   - Never reorder walls; never change gate *order*, only insert/delete slots
//   - Min 4 gates; max baseline.length + MAX_EXTRA
//   - Protect first & last gate from removal (spawn / lap seal)
//   - Topology changes at most every TOPO_EVERY adapt cycles
//   - Hard caps on nudge distance from baseline when lengths match
//
// Off by default. 🧪 Experiments → "Adaptive green gates" or `?adaptGates=1`.

(function (global) {
  'use strict';

  const MAX_STEP = 0.08;
  const MAX_DRIFT_PX = 55;
  const MAX_STEP_PX = 14;
  const MIN_GENS_BETWEEN = 1;
  const MIN_GATES = 4;
  const MAX_EXTRA = 2;           // may grow to baseline.length + MAX_EXTRA
  const TOPO_EVERY = 3;          // topology change cooldown (adapt cycles)
  const ADD_DROP = 0.32;         // cliff size that can trigger an insert
  const REMOVE_RATIO = 0.97;     // rates[k]/rates[k-1] above this → redundant
  const REMOVE_MIN_REACH = 0.20; // only prune if enough cars reach the pair
  const MEMORY_PREFIX = 'vv_adapt_gates_';
  const MEMORY_RING = 6;

  const state = {
    enabled: false,
    baseline: null,
    lastStatus: 'off',
    lastBottleneck: -1,
    lastSurvival: null,
    lastCrashCentroid: null, // {x,y,n} dominant death cluster this gen
    lastCrashHit: null,      // best HNSW crash-map retrieval this gen
    hnswHits: 0,
    hnswApplies: 0,
    badStreak: 0,
    nudgeCount: 0,
    addCount: 0,
    removeCount: 0,
    genSinceAdapt: 0,
    topoCooldown: 0,
    trackKey: null,
  };

  const CRASH_SIM_MIN = 0.55;      // min cosine sim to trust a retrieved layout
  const CRASH_SURV_LIFT = 0.03;    // retrieved survival must beat current by this

  try {
    if (new URLSearchParams(location.search).get('adaptGates') === '1') {
      state.enabled = true;
    }
  } catch (_) {}

  function cloneCps(cps) {
    if (!cps || !cps.length) return [];
    return cps.map(function (seg) {
      return [
        { x: +seg[0].x, y: +seg[0].y },
        { x: +seg[1].x, y: +seg[1].y },
      ];
    });
  }

  function mid(seg) {
    return {
      x: (seg[0].x + seg[1].x) * 0.5,
      y: (seg[0].y + seg[1].y) * 0.5,
    };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function nudgeToward(p, target, t) {
    return {
      x: p.x + (target.x - p.x) * t,
      y: p.y + (target.y - p.y) * t,
    };
  }

  function clampStep(from, to, maxPx) {
    const d = dist(from, to);
    if (d <= maxPx || d < 1e-6) return to;
    const s = maxPx / d;
    return { x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s };
  }

  function clampDrift(p, base, maxPx) {
    if (!base) return p;
    const d = dist(p, base);
    if (d <= maxPx || d < 1e-6) return p;
    const s = maxPx / d;
    return { x: base.x + (p.x - base.x) * s, y: base.y + (p.y - base.y) * s };
  }

  /** Linear blend of two gate segments (for inserting a midway gate). */
  function lerpGate(a, b, t) {
    return [
      {
        x: a[0].x + (b[0].x - a[0].x) * t,
        y: a[0].y + (b[0].y - a[0].y) * t,
      },
      {
        x: a[1].x + (b[1].x - a[1].x) * t,
        y: a[1].y + (b[1].y - a[1].y) * t,
      },
    ];
  }

  function currentCps() {
    try {
      if (typeof road !== 'undefined' && road && road.roadEditor &&
          road.roadEditor.checkPointListEditor &&
          road.roadEditor.checkPointListEditor.length) {
        return road.roadEditor.checkPointListEditor;
      }
    } catch (_) {}
    return null;
  }

  function maxGates() {
    const baseN = (state.baseline && state.baseline.length) || 0;
    return Math.max(MIN_GATES, baseN + MAX_EXTRA);
  }

  /**
   * Stable id for the *walls* (not the adaptive gate list). Used so Triangle
   * memory never re-applies onto Rectangle after a preset switch.
   */
  function geometrySignature() {
    try {
      const re = road.roadEditor;
      if (!re) return 'g0';
      const parts = [];
      const pushPts = function (arr) {
        if (!arr) return;
        for (let i = 0; i < arr.length; i++) {
          parts.push(Math.round(arr[i].x) + ',' + Math.round(arr[i].y));
        }
      };
      pushPts(re.points);
      parts.push('|');
      pushPts(re.points2);
      // Include *baseline* gate count when known; avoid live adaptive gate
      // count so adds/removes don't thrash the track key every gen.
      if (state.baseline && state.baseline.length) {
        parts.push('|b' + state.baseline.length);
      }
      let h = 2166136261;
      const s = parts.join(';');
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return 'g' + (h >>> 0).toString(16);
    } catch (_) {
      return 'g0';
    }
  }

  function trackKey() {
    return MEMORY_PREFIX + geometrySignature();
  }

  /** True when adaptive state still refers to a different wall geometry. */
  function trackStale() {
    if (!state.trackKey) return true;
    // Compare without the baseline-length suffix drift: recompute from walls only.
    try {
      const re = road.roadEditor;
      if (!re || !re.points || !re.points2) return true;
      // If baseline exists, check first wall point still matches baseline context
      // by seeing whether live walls match what we hashed into trackKey.
      return state.trackKey !== trackKey();
    } catch (_) {
      return true;
    }
  }

  function loadMemory(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  function saveMemory(key, mem) {
    try { localStorage.setItem(key, JSON.stringify(mem)); } catch (_) {}
  }

  function captureBaseline() {
    const cps = currentCps();
    if (!cps || !cps.length) return false;
    state.baseline = cloneCps(cps);
    // Hash walls *after* baseline length is known so trackKey is stable.
    state.trackKey = trackKey();
    state.nudgeCount = 0;
    state.addCount = 0;
    state.removeCount = 0;
    state.badStreak = 0;
    state.lastBottleneck = -1;
    state.lastSurvival = null;
    state.lastCrashCentroid = null;
    state.lastCrashHit = null;
    state.topoCooldown = 0;
    state.genSinceAdapt = 0;
    return true;
  }

  /**
   * Called when the user loads a different preset / redraws the track.
   * Drops Triangle baselines so Reset / HNSW / bad-streak restore cannot
   * paint the old green gates onto the new walls.
   */
  function onTrackChange() {
    // Drop stale adaptive state first so trackKey() doesn't include the old
    // baseline gate count in the geometry signature.
    state.baseline = null;
    state.trackKey = null;
    state.nudgeCount = 0;
    state.addCount = 0;
    state.removeCount = 0;
    state.badStreak = 0;
    state.lastBottleneck = -1;
    state.lastSurvival = null;
    state.lastCrashCentroid = null;
    state.lastCrashHit = null;
    state.topoCooldown = 0;
    state.genSinceAdapt = 0;
    state._hnswNote = null;

    const ok = captureBaseline();
    // Do NOT restoreBestIfAny() here — that re-applies an adapted layout and
    // is the wrong move right after an explicit preset load (preset CPs win).
    state.lastStatus = state.enabled
      ? (ok
        ? ('on · track changed · baseline = ' + state.baseline.length + ' gates (preset)')
        : 'on · track changed · no gates yet')
      : (ok ? 'off · track changed · baseline recaptured' : 'off');
    return ok;
  }

  function applyCps(cps) {
    if (!cps || !cps.length) return false;
    try {
      if (typeof road === 'undefined' || !road || !road.roadEditor) return false;
      road.roadEditor.checkPointListEditor = cloneCps(cps);
      road.checkPointList = cloneCps(cps);
      if (typeof road.rebuildGrids === 'function') road.rebuildGrids();
      try { localStorage.setItem('checkPointList', JSON.stringify(cps)); } catch (_) {}
      if (typeof invalidateWorkerInit === 'function') invalidateWorkerInit();
      if (window.DemoPresentation && window.DemoPresentation.invalidateRoad) {
        window.DemoPresentation.invalidateRoad();
      }
      try {
        if (typeof embedCurrentTrack === 'function') embedCurrentTrack();
      } catch (_) {}
      return true;
    } catch (e) {
      console.warn('[adaptiveGates] apply failed', e);
      return false;
    }
  }

  function reachRates(popCheckpoints, cpLen, N) {
    const rates = new Array(cpLen + 1);
    rates[0] = 1;
    for (let k = 1; k <= cpLen; k++) {
      let c = 0;
      for (let i = 0; i < N; i++) if ((popCheckpoints[i] | 0) >= k) c++;
      rates[k] = c / N;
    }
    return rates;
  }

  function findBottleneck(rates) {
    let bestK = 1;
    let bestDrop = -1;
    for (let k = 1; k < rates.length; k++) {
      const drop = rates[k - 1] - rates[k];
      if (drop > bestDrop) {
        bestDrop = drop;
        bestK = k;
      }
    }
    return { gate: bestK, drop: bestDrop };
  }

  /**
   * Mean death position for cars that died after clearing `afterCp` gates
   * but not more (failed trying for the next gate). Falls back to global
   * death mean. Coordinates come from the worker (same events Heat paints).
   */
  function crashCentroid(genData, afterCp) {
    const N = genData.popN | 0;
    const xy = genData.popDeathXY;
    const counts = genData.popCheckpoints;
    if (!xy || !N) return null;

    let sx = 0, sy = 0, n = 0;
    let gsx = 0, gsy = 0, gn = 0;
    for (let i = 0; i < N; i++) {
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      gsx += x; gsy += y; gn++;
      if (counts && (counts[i] | 0) === (afterCp | 0)) {
        sx += x; sy += y; n++;
      }
    }
    if (n >= 3) return { x: sx / n, y: sy / n, n: n, scoped: true };
    if (gn >= 5) return { x: gsx / gn, y: gsy / gn, n: gn, scoped: false };
    return null;
  }

  /**
   * Target for nudging gate b: blend previous-gate mid with crash centroid
   * so the gate moves into the approach corridor, not onto the wall.
   */
  function crashAwareTarget(next, b, crash) {
    let prevMid;
    if (b <= 0) {
      try {
        prevMid = (typeof startInfo !== 'undefined' && startInfo)
          ? { x: startInfo.x, y: startInfo.y }
          : mid(next[0]);
      } catch (_) {
        prevMid = mid(next[0]);
      }
    } else {
      prevMid = mid(next[b - 1]);
    }
    if (!crash) return prevMid;
    return {
      x: prevMid.x * 0.65 + crash.x * 0.35,
      y: prevMid.y * 0.65 + crash.y * 0.35,
    };
  }

  /** Index of most redundant intermediate gate (0-based), or -1. */
  function findRedundant(rates, cpLen) {
    // Prefer removing the *easiest* intermediate transition (highest pass ratio),
    // never first/last.
    let bestI = -1;
    let bestRatio = 0;
    for (let k = 2; k <= cpLen - 1; k++) {
      // k is 1-based gate; intermediate if not first/last
      if (rates[k - 1] < REMOVE_MIN_REACH) continue;
      const ratio = rates[k - 1] > 1e-6 ? rates[k] / rates[k - 1] : 0;
      if (ratio >= REMOVE_RATIO && ratio > bestRatio) {
        bestRatio = ratio;
        bestI = k - 1; // 0-based
      }
    }
    return bestI;
  }

  function tryInsert(next, b, rates, drop, crash) {
    // b = 0-based bottleneck index. Insert a gate *before* it (between b-1 and b)
    // so the cliff is split into two smaller steps. If we have a crash centroid,
    // bias the new gate toward the approach-to-crash locus.
    if (state.topoCooldown > 0) return null;
    if (drop < ADD_DROP) return null;
    if (next.length >= maxGates()) return null;
    if (b < 1) return null; // need a previous gate to interpolate from

    const prev = next[b - 1];
    const cur = next[b];
    // Avoid stacking inserts when gates are already very close.
    if (dist(mid(prev), mid(cur)) < 80) return null;

    let inserted = lerpGate(prev, cur, 0.5);
    if (crash) {
      // Slide the synthetic gate so its midpoint sits nearer the crash approach.
      const m = mid(inserted);
      const aim = {
        x: m.x * 0.45 + crash.x * 0.55,
        y: m.y * 0.45 + crash.y * 0.55,
      };
      const dx = aim.x - m.x, dy = aim.y - m.y;
      inserted = [
        { x: inserted[0].x + dx, y: inserted[0].y + dy },
        { x: inserted[1].x + dx, y: inserted[1].y + dy },
      ];
    }
    next.splice(b, 0, inserted);
    state.addCount++;
    state.topoCooldown = TOPO_EVERY;
    return {
      kind: 'add',
      msg: 'added gate before #' + (b + 1) +
        ' (cliff ' + (drop * 100).toFixed(0) + 'pp' +
        (crash ? ', crash-aimed' : '') +
        ') · now ' + next.length + ' gates',
    };
  }

  function tryRemove(next, rates) {
    if (state.topoCooldown > 0) return null;
    if (next.length <= MIN_GATES) return null;
    // Only prune when the population is doing OK overall — don't strip
    // structure while everything is still dying early.
    if (rates[1] < 0.15) return null;

    const idx = findRedundant(rates, next.length);
    if (idx < 0) return null;

    next.splice(idx, 1);
    state.removeCount++;
    state.topoCooldown = TOPO_EVERY;
    return {
      kind: 'remove',
      msg: 'removed redundant gate #' + (idx + 1) +
        ' · now ' + next.length + ' gates',
    };
  }

  function tryNudge(next, b, crash) {
    const target = crashAwareTarget(next, b, crash);
    const usedCrash = !!(crash && crash.n >= 3);

    const canClamp = state.baseline && state.baseline.length === next.length && b < state.baseline.length;
    for (let e = 0; e < 2; e++) {
      let p = nudgeToward(next[b][e], target, MAX_STEP);
      p = clampStep(next[b][e], p, MAX_STEP_PX);
      if (canClamp) p = clampDrift(p, state.baseline[b][e], MAX_DRIFT_PX);
      next[b][e] = p;
    }
    state.nudgeCount++;
    return {
      kind: 'nudge',
      msg: 'nudged gate #' + (b + 1) +
        (usedCrash
          ? ' toward crash heat (n=' + crash.n + (crash.scoped ? ', scoped' : '') + ')'
          : (' toward ' + (b <= 0 ? 'spawn' : ('#' + b)))),
    };
  }

  function encodeCrashVec(genData) {
    try {
      if (window.CrashMapCodec && window.CrashMapCodec.encodeDeathMap) {
        return window.CrashMapCodec.encodeDeathMap(
          genData.popDeathXY, genData.popN | 0,
          (typeof canvas !== 'undefined' && canvas && canvas.width) || 3200,
          (typeof canvas !== 'undefined' && canvas && canvas.height) || 1800
        );
      }
      const b = window.__rvBridge;
      if (b && typeof b.encodeCrashMap === 'function') {
        return b.encodeCrashMap(genData.popDeathXY, genData.popN | 0);
      }
    } catch (_) {}
    return null;
  }

  function causesOf(genData) {
    try {
      if (window.CrashMapCodec && window.CrashMapCodec.causeHistogram) {
        return window.CrashMapCodec.causeHistogram(genData.popDeathCauses, genData.popN | 0);
      }
    } catch (_) {}
    return null;
  }

  /**
   * Query HNSW for similar crash maps. If a hit carries a gate layout with
   * better survival, apply it (full replace). Returns status string or null.
   */
  function tryHnswLayout(crashVec, survival, genData) {
    const b = window.__rvBridge;
    if (!b || typeof b.recommendCrashLayouts !== 'function') return null;
    if (window.rvDisabled) return null;
    let hits;
    try { hits = b.recommendCrashLayouts(crashVec, 5); }
    catch (_) { return null; }
    if (!hits || !hits.length) return null;
    state.hnswHits++;
    state.lastCrashHit = hits[0];

    // Prefer highest survival among sufficiently similar maps on *this* wall geometry.
    const geo = geometrySignature();
    let best = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.cps || !h.cps.length) continue;
      // Reject layouts archived on a different track (Triangle ≠ Rectangle).
      // Require geometrySig: older untagged maps are never auto-applied
      // (avoids painting Triangle gates onto Rectangle after a preset switch).
      if (!h.geometrySig || h.geometrySig !== geo) continue;
      if ((h.similarity || 0) < CRASH_SIM_MIN) continue;
      if ((h.survival || 0) < survival + CRASH_SURV_LIFT) continue;
      if (!best || h.survival > best.survival ||
          (h.survival === best.survival && h.similarity > best.similarity)) {
        best = h;
      }
    }
    if (!best) {
      return 'hnsw: ' + hits.length + ' similar crash map(s), none beat survival';
    }
    if (!applyCps(best.cps)) return 'hnsw: apply failed';
    state.hnswApplies++;
    state.topoCooldown = TOPO_EVERY;
    return 'hnsw: applied layout from similar crash (sim ' +
      (best.similarity * 100).toFixed(0) + '%, surv ' +
      (best.survival * 100).toFixed(0) + '%, ' + best.cps.length + ' gates)';
  }

  function archiveCrashToBridge(crashVec, survival, fitness, cps, genData, bottleneck) {
    const b = window.__rvBridge;
    if (!b || typeof b.archiveCrashMap !== 'function') return;
    if (window.rvDisabled) return;
    let nDeaths = 0;
    const xy = genData.popDeathXY;
    const N = genData.popN | 0;
    if (xy) {
      for (let i = 0; i < N; i++) {
        if (Number.isFinite(xy[i * 2]) && Number.isFinite(xy[i * 2 + 1])) nDeaths++;
      }
    }
    try {
      b.archiveCrashMap(crashVec, {
        survival: survival,
        fitness: fitness || 0,
        generation: (typeof generation === 'number' ? generation : 0),
        nDeaths: nDeaths,
        nGates: cps.length,
        cps: cloneCps(cps),
        causes: causesOf(genData),
        bottleneck: bottleneck,
        geometrySig: geometrySignature(),
      });
    } catch (e) {
      console.warn('[adaptiveGates] archiveCrashMap failed', e);
    }
  }

  function adaptOnce(genData) {
    const cps = currentCps();
    if (!cps || cps.length < 2) {
      state.lastStatus = 'on · need ≥2 gates';
      return false;
    }
    // Track switch while adaptive is on: recapture baseline before any nudge/HNSW.
    if (!state.baseline || trackStale()) {
      onTrackChange();
    }

    const N = genData.popN | 0;
    const popCp = genData.popCheckpoints;
    if (!N || !popCp || popCp.length < N) {
      state.lastStatus = 'on · waiting for pop stats';
      return false;
    }

    const cpLen = cps.length;
    const rates = reachRates(popCp, cpLen, N);
    const survival = (genData.popStillAlive | 0) / N;
    const { gate: bot1, drop } = findBottleneck(rates);
    state.lastBottleneck = bot1;

    // Crash heat for cars that died with checkPointsCount === bot1-1
    // (failed trying to reach bottleneck gate). Same events Heat mode paints.
    const crash = crashCentroid(genData, bot1 - 1);
    state.lastCrashCentroid = crash;

    // Encode + HNSW retrieve similar crash problems (ruvector crash-map index).
    const crashVec = encodeCrashVec(genData);
    if (crashVec) {
      const hnswMsg = tryHnswLayout(crashVec, survival, genData);
      if (hnswMsg && hnswMsg.indexOf('applied') !== -1) {
        state.lastStatus = 'on · ' + hnswMsg;
        state.lastSurvival = survival;
        const nowCps = currentCps() || cps;
        maybeRemember(survival, genData.fitness || 0, nowCps, crash);
        archiveCrashToBridge(crashVec, survival, genData.fitness || 0, nowCps, genData, bot1);
        return true;
      }
      // Always archive this gen's crash map + layout for future retrieval.
      archiveCrashToBridge(crashVec, survival, genData.fitness || 0, cps, genData, bot1);
      if (hnswMsg) {
        // Fall through to local nudge/add/remove, but keep hnsw note.
        state._hnswNote = hnswMsg;
      } else {
        state._hnswNote = null;
      }
    } else {
      state._hnswNote = null;
    }

    if (state.topoCooldown > 0) state.topoCooldown--;

    // Healthy population clearing the course — prefer pruning fluff over fidgeting.
    if (rates[cpLen] > 0.55 && drop < 0.08) {
      const next = cloneCps(cps);
      const op = tryRemove(next, rates);
      if (op && applyCps(next)) {
        state.lastStatus = 'on · ' + op.msg;
        state.lastSurvival = survival;
        maybeRemember(survival, genData.fitness || 0, next, crash);
        return true;
      }
      state.lastStatus = 'on · no bottleneck (population clearing gates)' +
        (crash ? ' · heat n=' + crash.n : '');
      state.lastSurvival = survival;
      maybeRemember(survival, genData.fitness || 0, cps, crash);
      return false;
    }

    if (state.lastSurvival != null && survival < state.lastSurvival - 0.04) {
      state.badStreak++;
    } else {
      state.badStreak = 0;
    }
    state.lastSurvival = survival;

    const next = cloneCps(cps);
    const b = bot1 - 1;
    let op = null;

    if (state.badStreak >= 2 && state.baseline) {
      // Hard reset toward baseline geometry (handles length mismatch too).
      const restored = cloneCps(state.baseline);
      state.badStreak = 0;
      state.topoCooldown = TOPO_EVERY;
      if (applyCps(restored)) {
        state.lastStatus = 'on · survival dipped — restored baseline gates';
        maybeRemember(survival, genData.fitness || 0, restored, crash);
        return true;
      }
    }

    // Priority: severe cliff → try insert (crash-aimed); else crash-aware nudge.
    op = tryInsert(next, b, rates, drop, crash);
    if (!op) op = tryNudge(next, Math.min(b, next.length - 1), crash);
    // After a nudge on a mild cliff, also consider pruning elsewhere.
    if (op && op.kind === 'nudge' && drop < 0.12 && next.length > MIN_GATES) {
      const pruned = cloneCps(next);
      const rm = tryRemove(pruned, rates);
      if (rm) {
        op = rm;
        for (let i = next.length - 1; i >= 0; i--) next.pop();
        for (let i = 0; i < pruned.length; i++) next.push(pruned[i]);
      }
    }

    if (!op) {
      state.lastStatus = 'on · no action';
      return false;
    }

    if (!applyCps(next)) {
      state.lastStatus = 'on · apply failed';
      return false;
    }

    const pct = (rates[bot1] * 100).toFixed(0);
    const prevPct = (rates[bot1 - 1] * 100).toFixed(0);
    state.lastStatus =
      'on · bottleneck #' + bot1 +
      ' (' + prevPct + '%→' + pct + '%) · ' + op.msg +
      ' · n/a/r ' + state.nudgeCount + '/' + state.addCount + '/' + state.removeCount +
      (state._hnswNote ? ' · ' + state._hnswNote : '') +
      (crashVec ? ' · map archived' : '');
    maybeRemember(survival, genData.fitness || 0, next, crash);
    if (crashVec) {
      archiveCrashToBridge(crashVec, survival, genData.fitness || 0, next, genData, bot1);
    }
    return true;
  }

  function maybeRemember(survival, fitness, cps, crash) {
    const key = state.trackKey || trackKey();
    let mem = loadMemory(key) || { best: null, ring: [] };
    const entry = {
      survival: +survival.toFixed(4),
      fitness: +(+fitness || 0).toFixed(3),
      cps: cloneCps(cps),
      nGates: cps.length,
      geometrySig: geometrySignature(),
      crash: crash ? { x: +crash.x.toFixed(1), y: +crash.y.toFixed(1), n: crash.n | 0 } : null,
      t: Date.now(),
    };
    mem.ring.push(entry);
    if (mem.ring.length > MEMORY_RING) mem.ring.shift();
    if (!mem.best ||
        entry.survival > mem.best.survival + 0.01 ||
        (Math.abs(entry.survival - mem.best.survival) < 0.01 && entry.fitness > mem.best.fitness)) {
      mem.best = entry;
    }
    if (state.baseline) mem.baseline = cloneCps(state.baseline);
    saveMemory(key, mem);
  }

  function restoreBestIfAny() {
    const key = trackKey();
    const mem = loadMemory(key);
    if (!mem || !mem.best || !mem.best.cps || !mem.best.cps.length) return false;
    // Memory is geometry-keyed; still reject if wall sig diverged.
    if (mem.best.geometrySig && mem.best.geometrySig !== geometrySignature()) return false;
    if (applyCps(mem.best.cps)) {
      state.lastStatus =
        'on · restored best layout for this track (' +
        mem.best.cps.length + ' gates, survival ' +
        (mem.best.survival * 100).toFixed(0) + '%)';
      return true;
    }
    return false;
  }

  function setEnabled(on) {
    state.enabled = !!on;
    if (!state.enabled) {
      state.lastStatus = 'off';
      return state.enabled;
    }
    // Always align baseline with the *current* walls when enabling.
    if (!state.baseline || trackStale()) {
      onTrackChange();
    }
    // Optional: restore a *same-track* remembered layout (not another preset).
    if (!restoreBestIfAny()) {
      state.lastStatus = 'on · watching pass rates + crash HNSW (baseline ' +
        ((state.baseline && state.baseline.length) || 0) + ' gates)';
    }
    return state.enabled;
  }

  function resetToBaseline() {
    // If the user switched tracks, baseline may still be the old triangle —
    // refuse to paint it; recapture from whatever gates the preset installed.
    if (!state.baseline || trackStale()) {
      const ok = onTrackChange();
      state.lastStatus = state.enabled
        ? (ok
          ? ('on · baseline recaptured for current track (' + state.baseline.length + ' gates)')
          : 'on · cannot reset (no gates)')
        : 'off · baseline recaptured';
      return ok;
    }
    const ok = applyCps(state.baseline);
    state.nudgeCount = 0;
    state.addCount = 0;
    state.removeCount = 0;
    state.badStreak = 0;
    state.lastBottleneck = -1;
    state.topoCooldown = 0;
    state.lastStatus = state.enabled
      ? 'on · reset to baseline (' + state.baseline.length + ' gates)'
      : 'off · baseline restored';
    return ok;
  }

  function onGenEnd(genData) {
    if (!state.enabled) return;
    // Detect track switches that happened without onTrackChange (defensive).
    if (trackStale()) onTrackChange();
    state.genSinceAdapt++;
    if (state.genSinceAdapt < MIN_GENS_BETWEEN) return;
    state.genSinceAdapt = 0;
    try {
      adaptOnce(genData);
    } catch (e) {
      console.warn('[adaptiveGates] onGenEnd failed', e);
      state.lastStatus = 'on · error (see console)';
    }
  }

  function getStatus() {
    let crashMaps = 0;
    try {
      const b = window.__rvBridge;
      if (b && b.info) crashMaps = (b.info().crashMaps && b.info().crashMaps.count) | 0;
      else if (b && typeof b.crashMapCount === 'function') crashMaps = b.crashMapCount() | 0;
    } catch (_) {}
    return {
      enabled: state.enabled,
      status: state.lastStatus,
      bottleneck: state.lastBottleneck,
      nudgeCount: state.nudgeCount,
      addCount: state.addCount,
      removeCount: state.removeCount,
      hnswHits: state.hnswHits,
      hnswApplies: state.hnswApplies,
      crashMaps: crashMaps,
      survival: state.lastSurvival,
      crash: state.lastCrashCentroid,
      lastCrashHit: state.lastCrashHit,
      hasBaseline: !!state.baseline,
      baselineGates: state.baseline ? state.baseline.length : 0,
      trackKey: state.trackKey,
    };
  }

  global.AdaptiveGates = {
    setEnabled: setEnabled,
    isEnabled: function () { return !!state.enabled; },
    onGenEnd: onGenEnd,
    onTrackChange: onTrackChange,
    resetToBaseline: resetToBaseline,
    captureBaseline: captureBaseline,
    getStatus: getStatus,
    geometrySignature: geometrySignature,
    _state: state,
  };

  if (state.enabled) {
    const boot = function () {
      try {
        if (currentCps() && currentCps().length) setEnabled(true);
      } catch (_) {}
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 50); });
    } else {
      setTimeout(boot, 50);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
