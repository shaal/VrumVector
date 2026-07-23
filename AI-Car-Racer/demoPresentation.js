// demoPresentation.js — cinematic presentation layer for VectorVroom.
// Classic script (no modules). Consumes the same Float32Array pose snapshots
// the worker already posts; never touches the sim loop.
//
// Features:
//   • Road cache blit (skip full road repaint every rAF during training)
//   • Rank-colored swarm + Top-K quads + pack dots
//   • Champion outline + sensor rays + motion trails
//   • Crash heatmap (where cars die)
//   • Follow-best camera
//   • Cinematic HUD (gen / alive / fitness / story line)
//   • Optional 3D perspective view of the same 2D world
//   • Demo mode: auto-start, follow, story beats
//
// URL flags: ?demo=1  ?follow=1  ?view=3d  ?trails=0  ?heatmap=0  ?rays=0
// Keyboard:  F follow · 3 3D · T trails · H heatmap · R rays · M demo · 0 reset cam
// Note: W/A/S/D are reserved for driving and never bind presentation toggles.

(function (global) {
  'use strict';

  const params = new URLSearchParams(location.search);
  const flag = (k, defTrue) => {
    const v = params.get(k);
    if (v === null) return !!defTrue;
    if (v === '0' || v === 'false') return false;
    return true;
  };

  const state = {
    ready: false,
    // feature toggles
    followBest: flag('follow', false) || flag('demo', false),
    view3d: params.get('view') === '3d',
    trails: flag('trails', true),
    heatmap: flag('heatmap', true),
    rays: flag('rays', true),
    rankColors: true,
    // camera
    camScale: 1,
    camX: 0,
    camY: 0,
    targetScale: 1,
    targetX: 0,
    targetY: 0,
    followZoom: 2.2,
    // road cache
    roadCache: null,
    roadCacheDirty: true,
    roadCacheKey: '',
    // trails: ring of {x,y} for champion
    trail: [],
    trailMax: 48,
    // heatmap grid
    heatW: 160,
    heatH: 90,
    heat: null,
    heatCanvas: null,
    prevDamaged: null,
    // HUD
    hudEl: null,
    storyEl: null,
    controlsEl: null,
    lastFitness: 0,
    lastGen: -1,
    peakFitness: 0,
    genStartAlive: 0,
    story: '',
    storyUntil: 0,
    // demo mode
    demoMode: flag('demo', false),
    demoStep: 0,
    demoStarted: false,
    // 3D orbital camera — high 3/4 angle so the track reads as a flat
    // loop with depth, not a thin edge-on strip.
    elev: 0.95,        // elevation from horizontal (~54°) — mostly top-down
    yaw: 0.55,         // orbit around vertical (~31°) — see both track axes
    baseDist: 2400,    // eye distance from look-at at zoom=1
    focal: 1700,       // mild perspective (higher = flatter / more isometric)
    wallHeight: 48,
    carHeight: 20,
    view3dFit: 1.08,   // slight zoom-in so the loop fills the frame
    followZoom3d: 1.55, // keep corridor context — avoid edge-on crop
  };

  // ------------------------------------------------------------------ setup
  function init() {
    if (state.ready) return;
    state.ready = true;
    state.heat = new Float32Array(state.heatW * state.heatH);
    ensureHud();
    ensureControls();
    bindKeys();
    if (state.demoMode) {
      // Defer so phase-4 layout + worker exist.
      setTimeout(startDemoMode, 80);
    }
    syncControlButtons();
    setStory(state.demoMode
      ? 'Demo mode — watch a swarm learn to drive.'
      : 'Train a neural net to race. Press M for demo mode (W/A/S/D drive).', 6000);
  }

  function ensureHud() {
    if (state.hudEl) return;
    const host = document.getElementById('canvasDiv') || document.body;
    const el = document.createElement('div');
    el.id = 'cinema-hud';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<div class="cinema-hud-row">' +
        '<span class="cinema-stat" data-c="gen">Gen <b>0</b></span>' +
        '<span class="cinema-stat" data-c="alive">Alive <b>—</b></span>' +
        '<span class="cinema-stat" data-c="fit">Best <b>—</b></span>' +
        '<span class="cinema-stat" data-c="laps">Laps <b>0</b></span>' +
        '<span class="cinema-stat" data-c="speed">Sim <b>1×</b></span>' +
      '</div>' +
      '<div class="cinema-story" data-c="story"></div>';
    host.appendChild(el);
    state.hudEl = el;
    state.storyEl = el.querySelector('[data-c="story"]');
  }

  function ensureControls() {
    if (state.controlsEl) return;
    const host = document.getElementById('canvasDiv') || document.body;
    const el = document.createElement('div');
    el.id = 'cinema-controls';
    el.innerHTML =
      '<button type="button" data-act="follow" title="Follow best car (F)">Follow</button>' +
      '<button type="button" data-act="view3d" title="3D perspective (3)">3D</button>' +
      '<button type="button" data-act="trails" title="Motion trails (T)">Trails</button>' +
      '<button type="button" data-act="heatmap" title="Crash heatmap (H)">Heat</button>' +
      '<button type="button" data-act="rays" title="Champion sensor rays (R)">Rays</button>' +
      '<button type="button" data-act="demo" title="Cinematic demo (M) — W/A/S/D reserved for driving" class="cinema-demo">Demo</button>';
    el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'follow') setFollow(!state.followBest);
      else if (act === 'view3d') setView3d(!state.view3d);
      else if (act === 'trails') { state.trails = !state.trails; if (!state.trails) state.trail.length = 0; }
      else if (act === 'heatmap') state.heatmap = !state.heatmap;
      else if (act === 'rays') setRays(!state.rays);
      else if (act === 'demo') startDemoMode();
      syncControlButtons();
    });
    host.appendChild(el);
    state.controlsEl = el;
  }

  function syncControlButtons() {
    if (!state.controlsEl) return;
    const map = {
      follow: state.followBest,
      view3d: state.view3d,
      trails: state.trails,
      heatmap: state.heatmap,
      rays: state.rays,
      demo: state.demoMode,
    };
    state.controlsEl.querySelectorAll('[data-act]').forEach((btn) => {
      const on = !!map[btn.getAttribute('data-act')];
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const k = e.key;
      // Never steal driving keys. WASD controls the player car (phase 3) and
      // must not toggle Demo / Follow / other presentation chrome. Demo used
      // to bind D, which flipped Follow on every right-turn press.
      if (k === 'w' || k === 'a' || k === 's' || k === 'd' ||
          k === 'W' || k === 'A' || k === 'S' || k === 'D') {
        return;
      }
      // While the user is actively driving (physics-tune phase), ignore all
      // presentation hotkeys so arrow keys and free driving stay clean.
      try {
        if (typeof phase !== 'undefined' && phase === 3) return;
      } catch (_) {}
      if (k === 'f' || k === 'F') { setFollow(!state.followBest); syncControlButtons(); }
      else if (k === '3') { setView3d(!state.view3d); syncControlButtons(); }
      else if (k === 't' || k === 'T') { state.trails = !state.trails; if (!state.trails) state.trail.length = 0; syncControlButtons(); }
      else if (k === 'h' || k === 'H') { state.heatmap = !state.heatmap; syncControlButtons(); }
      else if (k === 'r' || k === 'R') { setRays(!state.rays); syncControlButtons(); }
      else if (k === 'm' || k === 'M') { startDemoMode(); syncControlButtons(); }
      else if (k === '0') { resetCamera(); }
    });
  }

  function setRays(on) {
    state.rays = !!on;
  }

  // --------------------------------------------------------------- road cache
  function useRoadCache() {
    // Cache only during training when the editor is locked — during track
    // editing every drag needs a live redraw.
    try {
      if (typeof phase !== 'undefined' && phase !== 4) return false;
      if (typeof road !== 'undefined' && road && road.roadEditor && road.roadEditor.editMode) return false;
      return true;
    } catch (_) { return false; }
  }

  function invalidateRoad() {
    state.roadCacheDirty = true;
    state.roadCacheKey = '';
  }

  function roadKey() {
    try {
      const re = road.roadEditor;
      // Lengths + first/last points are enough to catch edits & preset loads.
      const p = re.points, q = re.points2, c = re.checkPointListEditor;
      const a = p && p[0] ? (p[0].x | 0) + ',' + (p[0].y | 0) : '';
      const b = q && q[0] ? (q[0].x | 0) + ',' + (q[0].y | 0) : '';
      return (p ? p.length : 0) + '|' + (q ? q.length : 0) + '|' + (c ? c.length : 0) + '|' + a + '|' + b + '|' + canvas.width + 'x' + canvas.height;
    } catch (_) { return String(Date.now()); }
  }

  function ensureRoadCache() {
    if (!useRoadCache()) return false;
    const key = roadKey();
    if (!state.roadCacheDirty && state.roadCache && state.roadCacheKey === key) return true;
    const w = canvas.width, h = canvas.height;
    if (!state.roadCache || state.roadCache.width !== w || state.roadCache.height !== h) {
      state.roadCache = document.createElement('canvas');
      state.roadCache.width = w;
      state.roadCache.height = h;
    }
    const rctx = state.roadCache.getContext('2d');
    rctx.fillStyle = '#15161a';
    rctx.fillRect(0, 0, w, h);
    // Paint road geometry into the cache without touching the live canvas.
    paintRoadTo(rctx);
    state.roadCacheDirty = false;
    state.roadCacheKey = key;
    return true;
  }

  function paintRoadTo(c) {
    // Prefer roadEditor's public paint path if present; else reimplement walls.
    try {
      if (road && road.roadEditor && typeof road.roadEditor.paintTo === 'function') {
        road.roadEditor.paintTo(c);
        return;
      }
    } catch (_) {}
    // Fallback: minimal walls + checkpoints (no edit handles).
    try {
      const re = road.roadEditor;
      const wallW = 12, checkW = 8;
      const strokeLoop = (pts) => {
        if (!pts || pts.length < 2) return;
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
        c.closePath();
        c.stroke();
      };
      c.strokeStyle = '#ffffff';
      c.lineWidth = wallW;
      c.lineJoin = 'round';
      strokeLoop(re.points);
      strokeLoop(re.points2);
      c.strokeStyle = '#58E05D';
      c.lineWidth = checkW;
      (re.checkPointListEditor || []).forEach((seg) => {
        if (!seg || !seg[0] || !seg[1]) return;
        c.beginPath();
        c.moveTo(seg[0].x, seg[0].y);
        c.lineTo(seg[1].x, seg[1].y);
        c.stroke();
      });
      if (typeof re.drawStartPos === 'function') re.drawStartPos(startInfo, c);
    } catch (e) {
      console.warn('[demo] paintRoadTo failed', e);
    }
  }

  function blitRoad(targetCtx) {
    if (!ensureRoadCache()) {
      // Fall back to live redraw.
      if (road && typeof road.draw === 'function') road.draw(targetCtx);
      return;
    }
    // Background is in the cache; just blit.
    targetCtx.drawImage(state.roadCache, 0, 0);
  }

  // --------------------------------------------------------------- camera
  function setFollow(on) {
    state.followBest = !!on;
    if (!on) {
      state.targetScale = 1;
      // Ease back toward full track.
    } else {
      state.targetScale = state.followZoom;
    }
  }

  function resetCamera() {
    state.followBest = false;
    state.targetScale = 1;
    state.targetX = canvas.width / 2;
    state.targetY = canvas.height / 2;
    state.camScale = 1;
    state.camX = canvas.width / 2;
    state.camY = canvas.height / 2;
    syncControlButtons();
  }

  function setView3d(on) {
    state.view3d = !!on;
    if (on && state.followBest) state.targetScale = state.followZoom3d;
    else if (on) state.targetScale = state.view3dFit;
  }

  function updateCamera(best) {
    const w = canvas.width, h = canvas.height;
    if (state.followBest && best && Number.isFinite(best.x) && Number.isFinite(best.y)) {
      state.targetX = best.x;
      state.targetY = best.y;
      state.targetScale = state.view3d ? state.followZoom3d : state.followZoom;
    } else {
      state.targetX = w / 2;
      state.targetY = h / 2;
      state.targetScale = state.view3d ? state.view3dFit : 1;
    }
    // Smooth follow (critically damped-ish lerp).
    const a = 0.12;
    state.camX += (state.targetX - state.camX) * a;
    state.camY += (state.targetY - state.camY) * a;
    state.camScale += (state.targetScale - state.camScale) * a;
  }

  /** Apply 2D pan/zoom (not used in pure 3D projection path). */
  function beginCamera(ctx) {
    if (state.view3d) return false; // 3D path does its own projection
    if (Math.abs(state.camScale - 1) < 0.01 &&
        Math.abs(state.camX - canvas.width / 2) < 2 &&
        Math.abs(state.camY - canvas.height / 2) < 2) {
      return false;
    }
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(state.camScale, state.camScale);
    ctx.translate(-state.camX, -state.camY);
    return true;
  }

  function endCamera(ctx, applied) {
    if (applied) ctx.restore();
  }

  // --------------------------------------------------------------- 3D project
  // Orbital camera around look-at (camX, camY) on the ground plane.
  // World: x right, y down (canvas), z up. Eye sits at (yaw, elev, dist)
  // and looks at the target — classic 3/4 racing angle, not a pure pitch.
  function project(wx, wy, wz) {
    wz = wz || 0;
    const elev = state.elev;
    const yaw = state.yaw;
    // Zoom = move the eye closer (higher camScale → smaller dist).
    const dist = state.baseDist / Math.max(0.35, state.camScale);
    const cosE = Math.cos(elev);
    const sinE = Math.sin(elev);
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);

    // Eye position relative to look-at (above and toward +Y / bottom of canvas).
    const eyeX = sinY * cosE * dist;
    const eyeY = cosY * cosE * dist;
    const eyeZ = sinE * dist;

    // Vector from eye to the world point.
    const px = (wx - state.camX) - eyeX;
    const py = (wy - state.camY) - eyeY;
    const pz = wz - eyeZ;

    // Orthonormal camera basis: forward (eye → look-at), right, up.
    // worldUp = (0,0,1). right = normalize(worldUp × forward) so +X world
    // maps to screen-right (the opposite cross product mirrored the scene).
    const fl = Math.hypot(eyeX, eyeY, eyeZ) || 1;
    const fwx = -eyeX / fl;
    const fwy = -eyeY / fl;
    const fwz = -eyeZ / fl;
    // cross(up, fw) = (-fwy, fwx, 0)
    let rgtX = -fwy, rgtY = fwx, rgtZ = 0;
    const rl = Math.hypot(rgtX, rgtY) || 1;
    rgtX /= rl; rgtY /= rl;
    // camUp = forward × right  (keeps a right-handed view basis)
    const upX = fwy * rgtZ - fwz * rgtY;
    const upY = fwz * rgtX - fwx * rgtZ;
    const upZ = fwx * rgtY - fwy * rgtX;

    // View space: +X right, +Y up, +Z into the scene (along forward).
    const viewX = px * rgtX + py * rgtY + pz * rgtZ;
    const viewY = px * upX + py * upY + pz * upZ;
    const viewZ = px * fwx + py * fwy + pz * fwz;
    if (viewZ < 40) return null;

    const f = state.focal / viewZ;
    return {
      x: canvas.width / 2 + viewX * f,
      y: canvas.height / 2 - viewY * f, // screen Y grows downward
      f: f,
    };
  }

  function drawProjectedRoad(ctx) {
    // Ground wash
    ctx.fillStyle = '#15161a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Soft ground quad (track bounding box)
    const pad = 40;
    const corners = [
      project(pad, pad, 0),
      project(canvas.width - pad, pad, 0),
      project(canvas.width - pad, canvas.height - pad, 0),
      project(pad, canvas.height - pad, 0),
    ];
    if (corners.every(Boolean)) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = '#1a1c22';
      ctx.fill();
    }

    try {
      const re = road.roadEditor;
      drawExtrudedLoop(ctx, re.points, state.wallHeight, '#e8e8ec');
      drawExtrudedLoop(ctx, re.points2, state.wallHeight, '#e8e8ec');
      // Checkpoints as flat green ribbons
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(88, 224, 93, 0.85)';
      (re.checkPointListEditor || []).forEach((seg) => {
        if (!seg || !seg[0] || !seg[1]) return;
        const a = project(seg[0].x, seg[0].y, 1);
        const b = project(seg[1].x, seg[1].y, 1);
        if (!a || !b) return;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      });
    } catch (_) {}
  }

  function drawExtrudedLoop(ctx, pts, h, color) {
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = 'rgba(200,200,210,0.12)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const a0 = project(a.x, a.y, 0);
      const a1 = project(a.x, a.y, h);
      const b0 = project(b.x, b.y, 0);
      const b1 = project(b.x, b.y, h);
      if (!a0 || !a1 || !b0 || !b1) continue;
      // Wall face
      ctx.beginPath();
      ctx.moveTo(a0.x, a0.y);
      ctx.lineTo(b0.x, b0.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.lineTo(a1.x, a1.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Top rim
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < pts.length; i++) {
      const p = project(pts[i].x, pts[i].y, h);
      if (!p) continue;
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    if (started) {
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawProjectedCar(ctx, x, y, angle, color, alpha, h) {
    const rad = Math.hypot(30, 50) / 2;
    const alphaA = Math.atan2(30, 50);
    const corners = [
      [angle - alphaA, rad],
      [angle + alphaA, rad],
      [Math.PI + angle + alphaA, rad],
      [Math.PI + angle - alphaA, rad],
    ];
    const top = [];
    const bot = [];
    for (let i = 0; i < 4; i++) {
      const wx = x - Math.sin(corners[i][0]) * corners[i][1];
      const wy = y - Math.cos(corners[i][0]) * corners[i][1];
      const p0 = project(wx, wy, 0);
      const p1 = project(wx, wy, h || state.carHeight);
      if (!p0 || !p1) return;
      bot.push(p0);
      top.push(p1);
    }
    ctx.globalAlpha = alpha;
    // Side faces (simple — back-to-front not sorted; fine at this scale)
    ctx.fillStyle = color;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      ctx.beginPath();
      ctx.moveTo(bot[i].x, bot[i].y);
      ctx.lineTo(bot[j].x, bot[j].y);
      ctx.lineTo(top[j].x, top[j].y);
      ctx.lineTo(top[i].x, top[i].y);
      ctx.closePath();
      ctx.fill();
    }
    // Roof
    ctx.beginPath();
    ctx.moveTo(top[0].x, top[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(top[i].x, top[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = Math.min(1, alpha + 0.15);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // --------------------------------------------------------------- colors
  /** Rank t in [0,1] (0=best) → amber→lime→cyan */
  function rankColor(t, alpha) {
    // t=0 best (lime-gold), t=1 pack (muted amber)
    const r = Math.round(227 + (80 - 227) * (1 - t) * 0.55);
    const g = Math.round(138 + (220 - 138) * (1 - t));
    const b = Math.round(15 + (120 - 15) * (1 - t) * 0.4);
    if (alpha == null) return 'rgb(' + r + ',' + g + ',' + b + ')';
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  const CHAMPION = '#FFE566';
  const DEAD = 'rgba(120,120,130,0.35)';

  // --------------------------------------------------------------- heatmap
  function heatIndex(x, y) {
    const gx = Math.max(0, Math.min(state.heatW - 1, (x / canvas.width * state.heatW) | 0));
    const gy = Math.max(0, Math.min(state.heatH - 1, (y / canvas.height * state.heatH) | 0));
    return gy * state.heatW + gx;
  }

  function depositHeat(x, y, amount) {
    const r = 2;
    const cx = (x / canvas.width * state.heatW);
    const cy = (y / canvas.height * state.heatH);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = (cx + dx) | 0;
        const gy = (cy + dy) | 0;
        if (gx < 0 || gy < 0 || gx >= state.heatW || gy >= state.heatH) continue;
        const w = 1 - Math.sqrt(dx * dx + dy * dy) / (r + 1);
        if (w > 0) state.heat[gy * state.heatW + gx] += amount * w;
      }
    }
  }

  function decayHeat() {
    const h = state.heat;
    for (let i = 0; i < h.length; i++) h[i] *= 0.992;
  }

  function observeDeaths(snap) {
    if (!state.heatmap || !snap || !snap.positions) return;
    const N = snap.N | 0;
    const pos = snap.positions;
    if (!state.prevDamaged || state.prevDamaged.length !== N) {
      state.prevDamaged = new Uint8Array(N);
      for (let i = 0; i < N; i++) state.prevDamaged[i] = pos[i * 5 + 3] ? 1 : 0;
      return;
    }
    for (let i = 0; i < N; i++) {
      const d = pos[i * 5 + 3] ? 1 : 0;
      if (d && !state.prevDamaged[i]) {
        depositHeat(pos[i * 5], pos[i * 5 + 1], 1.4);
      }
      state.prevDamaged[i] = d;
    }
    // Soft continuous decay so old crash zones fade over a generation.
    if ((snap.frameCount | 0) % 8 === 0) decayHeat();
  }

  function drawHeatmap(ctx) {
    if (!state.heatmap) return;
    let max = 0.001;
    const h = state.heat;
    for (let i = 0; i < h.length; i++) if (h[i] > max) max = h[i];
    if (max < 0.05) return;

    if (!state.heatCanvas) {
      state.heatCanvas = document.createElement('canvas');
      state.heatCanvas.width = state.heatW;
      state.heatCanvas.height = state.heatH;
    }
    const hc = state.heatCanvas;
    const hctx = hc.getContext('2d');
    const img = hctx.createImageData(state.heatW, state.heatH);
    const data = img.data;
    for (let i = 0; i < h.length; i++) {
      const t = Math.min(1, h[i] / max);
      if (t < 0.04) continue;
      const o = i * 4;
      // ember gradient
      data[o] = 255;
      data[o + 1] = Math.round(40 + 100 * (1 - t));
      data[o + 2] = 20;
      data[o + 3] = Math.round(30 + 150 * t);
    }
    hctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.imageSmoothingEnabled = true;
    if (state.view3d) {
      // Approximate: draw as ground-projected textured quad is hard without
      // WebGL — sample cells and draw soft dots in projected space instead.
      ctx.globalAlpha = 0.45;
      for (let gy = 0; gy < state.heatH; gy += 1) {
        for (let gx = 0; gx < state.heatW; gx += 1) {
          const v = h[gy * state.heatW + gx];
          if (v < max * 0.08) continue;
          const wx = (gx + 0.5) / state.heatW * canvas.width;
          const wy = (gy + 0.5) / state.heatH * canvas.height;
          const p = project(wx, wy, 0);
          if (!p) continue;
          const t = Math.min(1, v / max);
          const r = 4 * p.f * t + 1;
          ctx.fillStyle = 'rgba(255,' + Math.round(40 + 80 * (1 - t)) + ',20,' + (0.15 + 0.45 * t) + ')';
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      ctx.drawImage(hc, 0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
  }

  // --------------------------------------------------------------- trails
  function pushTrail(best) {
    if (!state.trails || !best || best.damaged) return;
    const last = state.trail[state.trail.length - 1];
    if (last && Math.hypot(best.x - last.x, best.y - last.y) < 3) return;
    state.trail.push({ x: best.x, y: best.y });
    if (state.trail.length > state.trailMax) state.trail.shift();
  }

  function clearTrail() { state.trail.length = 0; }

  function drawTrail(ctx) {
    if (!state.trails || state.trail.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < state.trail.length; i++) {
      const a = state.trail[i - 1];
      const b = state.trail[i];
      const t = i / state.trail.length;
      ctx.strokeStyle = 'rgba(255, 229, 102,' + (0.08 + 0.45 * t) + ')';
      ctx.lineWidth = 2 + 6 * t;
      if (state.view3d) {
        const pa = project(a.x, a.y, 2);
        const pb = project(b.x, b.y, 2);
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.lineWidth = (2 + 6 * t) * ((pa.f + pb.f) * 0.5);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // --------------------------------------------------------------- swarm
  const _CAR_RAD = Math.hypot(30, 50) / 2;
  const _CAR_ALPHA = Math.atan2(30, 50);

  function drawCarQuad2d(ctx, x, y, angle) {
    ctx.beginPath();
    ctx.moveTo(x - Math.sin(angle - _CAR_ALPHA) * _CAR_RAD, y - Math.cos(angle - _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(angle + _CAR_ALPHA) * _CAR_RAD, y - Math.cos(angle + _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(Math.PI + angle + _CAR_ALPHA) * _CAR_RAD, y - Math.cos(Math.PI + angle + _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(Math.PI + angle - _CAR_ALPHA) * _CAR_RAD, y - Math.cos(Math.PI + angle - _CAR_ALPHA) * _CAR_RAD);
    ctx.fill();
  }

  function drawSwarm(ctx, snap) {
    if (!snap || !snap.positions) return;
    const N = snap.N | 0;
    const pos = snap.positions;
    const topK = (typeof RENDER_TOP_K === 'number') ? RENDER_TOP_K : 32;
    const full = (typeof FULL_RENDER !== 'undefined') && FULL_RENDER;

    observeDeaths(snap);

    // 3D road/heat/trail already painted in beginFrame; 2D paints them here
    // so they sit under the cars and ride the follow-camera transform.
    if (!state.view3d) {
      drawHeatmap(ctx);
      drawTrail(ctx);
    } else {
      // Refresh trail/heat under the latest poses (road already drawn).
      drawHeatmap(ctx);
      drawTrail(ctx);
    }

    // Collect live indices sorted by fitness desc.
    const liveIdx = [];
    for (let i = 0; i < N; i++) {
      if (pos[i * 5 + 3] === 0) liveIdx.push(i);
    }
    liveIdx.sort((a, b) => pos[b * 5 + 4] - pos[a * 5 + 4]);

    if (full) {
      for (let i = 0; i < N; i++) {
        const base = i * 5;
        const dead = pos[base + 3] !== 0;
        const col = dead ? DEAD : rankColor(0.6, 0.35);
        if (state.view3d) {
          if (!dead) drawProjectedCar(ctx, pos[base], pos[base + 1], pos[base + 2], col, 0.35, state.carHeight * 0.7);
        } else {
          ctx.fillStyle = col;
          ctx.globalAlpha = dead ? 0.25 : 0.35;
          drawCarQuad2d(ctx, pos[base], pos[base + 1], pos[base + 2]);
          ctx.globalAlpha = 1;
        }
      }
      return;
    }

    const kDraw = Math.min(topK, liveIdx.length);

    // Pack as dots
    if (liveIdx.length > kDraw) {
      if (state.view3d) {
        for (let i = kDraw; i < liveIdx.length; i++) {
          const idx = liveIdx[i];
          const rankT = i / Math.max(1, liveIdx.length - 1);
          const p = project(pos[idx * 5], pos[idx * 5 + 1], 0);
          if (!p) continue;
          ctx.fillStyle = rankColor(rankT, 0.55);
          const r = Math.max(1.2, 2.2 * p.f);
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.beginPath();
        for (let i = kDraw; i < liveIdx.length; i++) {
          const idx = liveIdx[i];
          ctx.rect(pos[idx * 5] - 2, pos[idx * 5 + 1] - 2, 4, 4);
        }
        // single fill; color mid-rank
        ctx.fillStyle = rankColor(0.55, 0.55);
        ctx.fill();
      }
    }

    // Top-K quads with rank colors
    for (let i = 0; i < kDraw; i++) {
      const idx = liveIdx[i];
      const rankT = kDraw <= 1 ? 0 : i / (kDraw - 1);
      const col = rankColor(rankT, 0.7);
      const x = pos[idx * 5], y = pos[idx * 5 + 1], ang = pos[idx * 5 + 2];
      if (state.view3d) {
        drawProjectedCar(ctx, x, y, ang, col, 0.75, state.carHeight);
      } else {
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = col;
        drawCarQuad2d(ctx, x, y, ang);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawChampion(ctx, best) {
    if (!best) return;
    pushTrail(best);
    const x = best.x, y = best.y, ang = best.angle;
    if (state.view3d) {
      drawProjectedCar(ctx, x, y, ang, CHAMPION, 1, state.carHeight * 1.15);
      // Sensor rays (toggle via Rays chip / R)
      if (state.rays && best.sensor && best.sensor.rays && best.sensor.rays.length) {
        for (let i = 0; i < best.sensor.rays.length; i++) {
          const ray = best.sensor.rays[i];
          const reading = best.sensor.readings[i];
          const end = reading ? reading : ray[1];
          const a = project(ray[0].x, ray[0].y, state.carHeight * 0.5);
          const b = project(end.x, end.y, 2);
          if (!a || !b) continue;
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255,230,80,0.9)';
          ctx.lineWidth = 2 * a.f;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      // Halo
      const p = project(x, y, state.carHeight + 4);
      if (p) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,229,102,0.55)';
        ctx.lineWidth = 2;
        ctx.arc(p.x, p.y, 18 * p.f, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }
    // 2D champion
    ctx.save();
    ctx.shadowColor = 'rgba(255,229,102,0.85)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = CHAMPION;
    drawCarQuad2d(ctx, x, y, ang);
    ctx.shadowBlur = 0;
    // Outline
    ctx.strokeStyle = '#fff8c8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - Math.sin(ang - _CAR_ALPHA) * _CAR_RAD, y - Math.cos(ang - _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(ang + _CAR_ALPHA) * _CAR_RAD, y - Math.cos(ang + _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(Math.PI + ang + _CAR_ALPHA) * _CAR_RAD, y - Math.cos(Math.PI + ang + _CAR_ALPHA) * _CAR_RAD);
    ctx.lineTo(x - Math.sin(Math.PI + ang - _CAR_ALPHA) * _CAR_RAD, y - Math.cos(Math.PI + ang - _CAR_ALPHA) * _CAR_RAD);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    if (state.rays && best.sensor && best.sensor.rays && best.sensor.rays.length) {
      for (let i = 0; i < best.sensor.rays.length; i++) {
        const ray = best.sensor.rays[i];
        const reading = best.sensor.readings[i];
        const end = reading ? reading : ray[1];
        ctx.beginPath();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'yellow';
        ctx.moveTo(ray[0].x, ray[0].y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = 'black';
        ctx.moveTo(ray[1].x, ray[1].y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }
    }
  }

  // --------------------------------------------------------------- scene API
  /**
   * Called once per rAF from main.animate during phase 4.
   * Returns { camApplied, drewRoad, drewSwarm } so main can skip default work.
   */
  function beginFrame(ctx, best, snap) {
    init();
    updateCamera(best);

    // Clear / road
    if (state.view3d) {
      // Always paint the projected track so pause / pre-snapshot frames
      // aren't a blank canvas. drawSwarm will repaint on top when cars land.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawProjectedRoad(ctx);
      drawHeatmap(ctx);
      drawTrail(ctx);
      return { camApplied: false, drewRoad: true, usePresentationSwarm: true };
    }

    const camApplied = beginCamera(ctx);
    if (useRoadCache()) {
      blitRoad(ctx);
      return { camApplied, drewRoad: true, usePresentationSwarm: true };
    }
    // No cache: caller should road.draw, but we'll still own swarm.
    return { camApplied, drewRoad: false, usePresentationSwarm: true };
  }

  function endFrame(ctx, camApplied) {
    endCamera(ctx, camApplied);
  }

  // --------------------------------------------------------------- HUD
  function setStory(text, ms) {
    state.story = text || '';
    state.storyUntil = performance.now() + (ms || 4000);
  }

  function tickHud(info) {
    init();
    if (!state.hudEl) return;
    const gen = info.generation | 0;
    const snap = info.snap;
    const best = info.bestCar;
    let alive = '—', n = '—';
    if (snap && snap.N) {
      n = snap.N;
      let a = 0;
      const pos = snap.positions;
      for (let i = 0; i < snap.N; i++) if (!pos[i * 5 + 3]) a++;
      alive = a;
      if (gen !== state.lastGen) {
        state.genStartAlive = a;
        state.lastGen = gen;
        clearTrail();
      }
    }
    let fitStr = '—';
    let fit = 0;
    if (best && snap && snap.bestIdx >= 0 && snap.positions) {
      fit = snap.positions[snap.bestIdx * 5 + 4] || 0;
    } else if (typeof info.fitness === 'number') {
      fit = info.fitness;
    }
    if (fit > 0) {
      fitStr = fit.toFixed(2);
      if (fit > state.peakFitness + 0.05) {
        state.peakFitness = fit;
        if (gen > 0) setStory('New best fitness: ' + fitStr, 2500);
      }
      state.lastFitness = fit;
    }
    const laps = best && best.laps ? best.laps : 0;
    const speed = (typeof info.simSpeed === 'number') ? info.simSpeed : 1;

    const set = (key, html) => {
      const el = state.hudEl.querySelector('[data-c="' + key + '"]');
      if (el) el.innerHTML = html;
    };
    set('gen', 'Gen <b>' + gen + '</b>');
    set('alive', 'Alive <b>' + alive + '</b><span class="cinema-muted">/' + n + '</span>');
    set('fit', 'Best <b>' + fitStr + '</b>');
    set('laps', 'Laps <b>' + laps + '</b>');
    set('speed', 'Sim <b>' + speed + '×</b>');

    // Story line
    let story = '';
    if (performance.now() < state.storyUntil) story = state.story;
    else if (info.pause) story = 'Paused — press ▶ Start Training or space-friendly Pause button.';
    else if (gen === 0 && alive !== '—' && typeof alive === 'number' && alive < (snap.N * 0.3)) {
      story = 'Gen 0 chaos: most random brains crash. Survivors become parents.';
    } else if (gen >= 1 && gen < 4) {
      story = 'Breeding winners… watch the pack hug the corridor.';
    } else if (laps >= 1) {
      story = 'Champion completed a lap — the swarm is learning this track.';
    } else if (state.followBest) {
      story = 'Following champion · sensors are the yellow rays.';
    } else if (state.view3d) {
      story = '3D view of the same 2D sim · F follow · 0 reset camera.';
    }
    if (state.storyEl) {
      state.storyEl.textContent = story || '';
      state.storyEl.hidden = !story;
    }

    // Demo sequencer beats
    if (state.demoMode) tickDemo(info);
  }

  function onGenEnd(genData) {
    const gen = (typeof generation === 'number') ? generation : 0;
    const fit = genData && typeof genData.fitness === 'number' ? genData.fitness : 0;
    const alive = genData && genData.popStillAlive != null ? genData.popStillAlive : null;
    const N = genData && genData.popN != null ? genData.popN : null;
    let msg = 'Generation ' + gen + ' complete';
    if (fit) msg += ' · best ' + fit.toFixed(2);
    if (alive != null && N) msg += ' · ' + alive + '/' + N + ' survived';
    setStory(msg, 3500);
    // Soft-clear heatmap a bit at gen boundaries so it tracks current policy.
    if (state.heat) {
      for (let i = 0; i < state.heat.length; i++) state.heat[i] *= 0.55;
    }
    clearTrail();
  }

  // --------------------------------------------------------------- demo mode
  function startDemoMode() {
    state.demoMode = true;
    state.demoStep = 0;
    state.demoStarted = false;
    setFollow(true);
    state.trails = true;
    state.heatmap = true;
    setStory('Demo mode — starting training with a readable swarm.', 4000);

    // Align demo with product defaults (survival + ruvector-friendly), then
    // bump speed a bit so the swarm story is visible without thrashing fitness.
    try {
      if (typeof applyTrainingPreset === 'function') {
        applyTrainingPreset('fresh');
      }
      if (typeof setSimSpeed === 'function') setSimSpeed(5);
      if (typeof setN === 'function') setN(600);
      const bs = document.getElementById('batchSizeInput');
      if (bs) {
        bs.value = 600;
        const o = document.getElementById('batchSizeOutput');
        if (o) o.value = 'Batch Size: 600';
      }
      const ss = document.getElementById('simSpeedInput');
      if (ss) ss.value = '5';
    } catch (_) {}

    // Unpause / first-start: pauseGame() clears __awaitingStart and calls
    // begin() to build the swarm. A second begin() is only needed when the
    // sim was already past the Start gate (restart with demo knobs).
    try {
      if (window.__awaitingStart && typeof pauseGame === 'function') {
        pauseGame();
      } else if (typeof pause !== 'undefined' && pause && typeof pauseGame === 'function') {
        pauseGame();
        if (typeof begin === 'function') begin();
      } else if (typeof begin === 'function') {
        begin();
      }
    } catch (_) {}

    state.demoStarted = true;
    syncControlButtons();
  }

  function tickDemo(info) {
    if (!state.demoMode || !state.demoStarted) return;
    const gen = info.generation | 0;
    const best = info.bestCar;
    // Step machine by generation milestones.
    if (state.demoStep === 0 && gen >= 0) {
      state.demoStep = 1;
      setStory('Random brains flail. Yellow car is the current champion.', 5000);
    }
    if (state.demoStep === 1 && gen >= 2) {
      state.demoStep = 2;
      setStory('After a few gens the pack tightens — fitness-colored leaders pull ahead.', 5000);
    }
    if (state.demoStep === 2 && best && best.laps >= 1) {
      state.demoStep = 3;
      setStory('First lap! Brain is archived for warm-start on this or similar tracks.', 6000);
    }
    if (state.demoStep === 3 && gen >= 8) {
      state.demoStep = 4;
      // Optional: briefly show 3D for spectacle then leave user control.
      if (!state.view3d) {
        setView3d(true);
        syncControlButtons();
        setStory('3D perspective — same physics, new view. Press 3 to toggle.', 5000);
        setTimeout(() => {
          // Don't force-off; user may like it. Just advance step.
          state.demoStep = 5;
        }, 8000);
      } else {
        state.demoStep = 5;
      }
    }
  }

  // --------------------------------------------------------------- public
  global.DemoPresentation = {
    init,
    invalidateRoad,
    useRoadCache,
    blitRoad,
    beginFrame,
    endFrame,
    drawSwarm,
    drawChampion,
    tickHud,
    onGenEnd,
    setFollow,
    setView3d,
    setRays,
    resetCamera,
    startDemoMode,
    setStory,
    get state() { return state; },
  };

  // Boot on DOM ready — main.js may already be running.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Defer one tick so canvas/globals exist.
    setTimeout(init, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
