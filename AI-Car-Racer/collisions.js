// Car collisions: the shared core (docs/plan/car-collisions.md).
//
// A classic script with no imports, so the live and A/B workers
// (sim-worker.js), the transfer-trial worker (learning/trial-worker.js), and
// the Node simulator (tests/helpers/simulation.mjs) can all load it and
// resolve contacts the same way. Load it after utils.js (polysIntersect,
// getIntersection) and car.js (Car.polygonAt).
//
// The rules:
//   - Heats. Cars collide only with cars of their own heat. Car i is in heat
//     i mod H, with H = ceil(N / K), so no heat has more than K cars. The
//     population lists the elite first and fresh cars last, so interleaving
//     spreads each kind over the heats (the elite itself is in heat 0).
//   - Start row. Each heat starts in one row across gate 0. Slot s of every
//     heat has the same pose. Slot 0 is the normal start pose, and car 0 (the
//     elite) always gets it. The other slots rotate by heat, so no kind of car
//     always gets the slot nearest a wall.
//   - Contact. Two car triangles touch or overlap at the end of the step, or
//     touched during it (straight-line motion relative to each other), so
//     fast cars cannot pass through each other between two steps.
//   - Striker. A car's nose is the side of its outline that faces its own
//     motion: the front edge when driving forward (the triangle's base; the
//     tip is the rear, see Car.polygonAt), the long sides when reversing. A
//     car crashes when its nose made the contact: noses are judged at the
//     moment the cars first touched during the step (or over the whole step
//     if they already touched at its start). If both noses did (a head-on
//     hit), both crash. A car slower than stallSpeed has no nose. A contact
//     that touches neither nose (a flank or tail glance) crashes nobody.
//   - Not solid: wrecks, cars parked for stallFrames steps, and ghosts. A car
//     that starts moving after being parked, that turns without moving, or
//     that had no room in the start row, is a ghost until it overlaps no live
//     heat-mate.
//
// resolveContacts runs once per step, after every car has moved and before
// any car senses. It marks every crash first and applies them after, so the
// result does not depend on the order of the pairs. It uses no random
// numbers (paired trials share random streams) and allocates nothing.
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    heatSize: 8,      // K: the most cars in one heat
    pitch: 45,        // px between start slots, along gate 0
    minPitch: 34,     // px; a second try for start gates too narrow for pitch
    clearance: 0.5,   // px; start slots (not slot 0) keep this far from walls
    laneGap: 3,       // px; extra sideways room between the lanes of two slots
    stallFrames: 120, // steps (2 s at 60 Hz) below stallSpeed before a car stops being solid
    stallSpeed: 0.1,  // px per step
    width: 30,        // car size used by every simulator
    height: 50,
  });
  const STRIKE = Object.freeze({NONE: 0, A: 1, B: 2, BOTH: 3});
  // Per-car status: not in play (a wreck, or a non-finite pose), in play but
  // not solid (parked, or a ghost), or solid.
  const STATUS = Object.freeze({GONE: 0, GHOST: 1, SOLID: 2});
  const GONE = STATUS.GONE, GHOST = STATUS.GHOST, SOLID = STATUS.SOLID;
  const STALL_CAP = 65535;                // Uint16Array counter
  // Bound once: global lookups in the hot path are slow in a Node vm context
  // (the test simulator), and these never change. The contact pass calls no
  // Math function: a call that is not inlined returns a boxed number, which
  // allocates (tests/collisions.test.mjs measures this).
  const INF = 1 / 0, isFinite = Number.isFinite;

  // --- heats ------------------------------------------------------------------

  // The effective heat size K for N cars. Infinity means "everyone in one
  // heat". A missing, non-numeric, or below-1 K uses the default.
  function heatSize(N, K) {
    const n = Math.max(0, Math.floor(N) || 0);
    let k = Number(K);
    if (!(k >= 1)) k = DEFAULTS.heatSize;
    k = k === Infinity ? Math.max(1, n) : Math.floor(k);
    return Math.max(1, Math.min(k, Math.max(1, n)));
  }
  // H: the number of heats. Heat sizes then differ by at most one car.
  function heatCount(N, K) {
    const n = Math.max(0, Math.floor(N) || 0);
    return n === 0 ? 0 : Math.ceil(n / heatSize(n, K));
  }
  function heatOf(i, heats) { return i % heats; }
  // The number of start slots a row needs: the size of the largest heat.
  function rowSize(N, K) {
    const n = Math.max(0, Math.floor(N) || 0);
    return n === 0 ? 0 : Math.ceil(n / heatCount(n, K));
  }
  // Car i's start slot in its heat. Heat h holds cars h, h+H, h+2H, ...; its
  // k-th car gets slot (k + h) mod (heat size). Car 0 gets slot 0 (the normal
  // start pose), and each kind of car (elite copies first, fresh cars last)
  // is spread over all slots instead of always getting the same one.
  function slotOf(i, N, heats) {
    const h = i % heats, k = Math.floor(i / heats);
    const size = Math.floor((N - 1 - h) / heats) + 1;
    return (k + h) % size;
  }

  // --- contact geometry (allocation-free) -----------------------------------
  //
  // Separating-axis tests. Only local variables: optimized code keeps them
  // unboxed, so nothing is allocated. A non-finite vertex makes every
  // comparison false, so such a shape never touches anything. Shapes must not
  // be degenerate (a car with zero width or length is not in play).

  // Is there a separating axis among the edge normals of p? p has pn
  // vertices: 2 (a segment, one edge) or 3 or more.
  function separatedAlongEdgesOf(p, pn, q, qn) {
    const edges = pn === 2 ? 1 : pn;
    for (let i = 0; i < edges; i++) {
      const a = p[i], b = p[i + 1 === pn ? 0 : i + 1];
      const nx = b.y - a.y, ny = a.x - b.x;
      if (nx === 0 && ny === 0) continue;   // zero-length edge: no axis
      let pLo = INF, pHi = -INF, qLo = INF, qHi = -INF;
      for (let k = 0; k < pn; k++) {
        const v = p[k].x * nx + p[k].y * ny;
        if (v < pLo) pLo = v;
        if (v > pHi) pHi = v;
      }
      for (let k = 0; k < qn; k++) {
        const v = q[k].x * nx + q[k].y * ny;
        if (v < qLo) qLo = v;
        if (v > qHi) qHi = v;
      }
      if (pHi < qLo || qHi < pLo) return true;
    }
    return false;
  }
  // Two convex shapes in 2D are disjoint only if an edge normal of one of
  // them separates them. Inclusive: shared edges or corners count as touching.
  function convexTouch(p, pn, q, qn) {
    return !separatedAlongEdgesOf(p, pn, q, qn) && !separatedAlongEdgesOf(q, qn, p, pn);
  }
  // True when triangles p and q (arrays of three {x, y}, e.g. car.polygon)
  // touch or overlap, including when one lies inside the other.
  function trianglesOverlap(p, q) {
    return convexTouch(p, 3, q, 3);
  }

  // Scratch, reused so the contact pass allocates nothing: typed arrays and
  // the fields of plain objects hold numbers without boxing them.
  // span: [first touch, last touch, normal x, normal y, normal known,
  //        second normal x, second normal y, second normal known]
  // nose: [cut, slowest nose speed squared, normal known, normal x,
  //        normal y, side (+1 for the first car, -1 for the second),
  //        second normal known, second normal x, second normal y]
  const span = new Float64Array(8);
  const nose = new Float64Array(9);
  const axisEnter = new Float64Array(6), axisNormal = new Float64Array(12);
  const motion = {x: 0, y: 0};
  const band = [{x: 0, y: 0}, {x: 0, y: 0}, {x: 0, y: 0}, {x: 0, y: 0}];
  const EARLY = 1e-3;   // noses are checked up to this far (of a step) past first touch
  const AT_START = 1e-9;  // a first touch this close to the step start counts as "already touching"
  const TIE = 1e-9;       // axes that open this close together open at the same moment

  // Triangle p moves straight by m = {x, y} during the step and ends where it
  // is now; triangle q stays put. Do they touch at some moment of the step?
  // If so, span[0] and span[1] get the first and last moment (0 = start,
  // 1 = now). If they first touch during the step (not at its start),
  // span[2..3] get the contact normal at that moment, pointing from p into q,
  // and span[4] is 1. Exact for two triangles: at each moment they touch
  // unless one of the six edge normals separates them, and on each normal the
  // moments of overlap form one interval; the normal that opens last is the
  // one they touch across. When two open at the same moment (a corner meets
  // a corner), both are contact normals: span[5..6] gets the second and
  // span[7] is 1, so rounding cannot pick one. No helper calls: numbers passed
  // to a call that is not inlined are boxed, which allocates.
  function contactSpan(p, m, q) {
    const mx = m.x, my = m.y;
    if (!(isFinite(mx) && isFinite(my))) return false;
    let tIn = 0, tOut = 1, axes = 0;
    for (let k = 0; k < 6; k++) {
      const t = k < 3 ? p : q, i = k % 3, j = i === 2 ? 0 : i + 1;
      const nx = t[j].y - t[i].y, ny = t[i].x - t[j].x;
      if (nx === 0 && ny === 0) continue;
      let pLo = INF, pHi = -INF, qLo = INF, qHi = -INF;
      for (let v = 0; v < 3; v++) {
        const a = p[v].x * nx + p[v].y * ny;
        if (a < pLo) pLo = a;
        if (a > pHi) pHi = a;
        const b = q[v].x * nx + q[v].y * ny;
        if (b < qLo) qLo = b;
        if (b > qHi) qHi = b;
      }
      if (!(pLo <= pHi && qLo <= qHi)) return false;   // a non-finite vertex
      axes++;
      axisEnter[k] = -INF;
      // At moment tau, p projects to [pLo, pHi] + (tau - 1) d.
      const d = mx * nx + my * ny;
      if (d === 0) {
        if (pHi < qLo || qHi < pLo) return false;
        continue;
      }
      let enter = 1 + (qLo - pHi) / d, leave = 1 + (qHi - pLo) / d;
      if (d < 0) { const e = enter; enter = leave; leave = e; }
      // Relative motion carries p toward q along this normal.
      axisEnter[k] = enter;
      axisNormal[2 * k] = d > 0 ? nx : -nx; axisNormal[2 * k + 1] = d > 0 ? ny : -ny;
      if (enter > tIn) tIn = enter;
      if (leave < tOut) tOut = leave;
      if (!(tIn <= tOut)) return false;
    }
    if (axes === 0) return false;
    const fresh = tIn > AT_START;
    span[0] = fresh ? tIn : 0; span[1] = tOut; span[4] = 0; span[7] = 0;
    if (fresh) {
      for (let k = 0; k < 6; k++) {
        if (!(axisEnter[k] >= tIn - TIE)) continue;
        if (span[4] === 0) { span[2] = axisNormal[2 * k]; span[3] = axisNormal[2 * k + 1]; span[4] = 1; }
        else if (span[7] === 0) { span[5] = axisNormal[2 * k]; span[6] = axisNormal[2 * k + 1]; span[7] = 1; }
      }
    }
    return true;
  }
  // Does triangle p, moving straight by m = {x, y} and ending where it is
  // now, touch triangle q at any moment of the step?
  function sweptTouch(p, m, q) {
    return contactSpan(p, m, q);
  }

  // Did car's nose enter the other car between the start of the step and the
  // moment nose[0] (0 = start, 1 = now)?
  //   - The nose is every side of car's outline whose outward normal faces
  //     car's own motion, the displacement -velocity (Car#move does
  //     x -= velocity.x). A car moving less than stallSpeed has none.
  //   - Each nose side sweeps a band along car's straight-line motion
  //     relative to the other car, and the band must touch the other car.
  //   - When the moment of first touch is known (nose[2]), the car must also
  //     be moving into the other car there: its own motion along the contact
  //     normal (nose[3..4], or the second one nose[7..8] after a tie, times
  //     the side nose[5]) is at least stallSpeed. A car reversing away from a
  //     car that rams its front does not strike.
  // Turning is not part of the motion: a front corner of a turning car moves
  // under 1 px per step because of it.
  function noseTouches(car, other) {
    const p = car.polygon, q = other.polygon, mx = -car.velocity.x, my = -car.velocity.y;
    const m2 = mx * mx + my * my, slow2 = nose[1];
    if (!(m2 > 0 && m2 >= slow2)) return false;
    if (nose[2]) {
      let nx = nose[5] * nose[3], ny = nose[5] * nose[4], into = mx * nx + my * ny;
      let entering = into > 0 && into * into >= slow2 * (nx * nx + ny * ny);
      if (!entering && nose[6]) {
        nx = nose[5] * nose[7]; ny = nose[5] * nose[8]; into = mx * nx + my * ny;
        entering = into > 0 && into * into >= slow2 * (nx * nx + ny * ny);
      }
      if (!entering) return false;
    }
    const rx = mx + other.velocity.x, ry = my + other.velocity.y;   // motion relative to other
    const back = 1 - nose[0];
    // Twice the signed area: its sign turns an edge into an outward normal.
    const turn = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[1].y - p[0].y) * (p[2].x - p[0].x);
    for (let i = 0; i < 3; i++) {
      const a = p[i], b = p[i === 2 ? 0 : i + 1];
      const ex = b.x - a.x, ey = b.y - a.y;
      // Outward normal is (ey, -ex) when turn > 0 and (-ey, ex) otherwise.
      if (turn * (ey * mx - ex * my) > 0) {
        // The side at the start of the step, then at the cut.
        band[0].x = a.x - rx; band[0].y = a.y - ry;
        band[1].x = b.x - rx; band[1].y = b.y - ry;
        band[2].x = b.x - back * rx; band[2].y = b.y - back * ry;
        band[3].x = a.x - back * rx; band[3].y = a.y - back * ry;
        if (convexTouch(band, 4, q, 3)) return true;
      }
    }
    return false;
  }
  function outcome(a, b) {
    nose[5] = 1;
    const first = noseTouches(a, b);
    nose[5] = -1;
    return (first ? STRIKE.A : 0) | (noseTouches(b, a) ? STRIKE.B : 0);
  }
  // Set the nose check from the last contactSpan(a, motion of a relative to
  // b, b). When the cars first touched during this step, noses are judged at
  // that moment and against its contact normal: whoever's nose made the
  // contact strikes, not a nose that reaches the other car later, through its
  // body. If they already touched at the start of the step (or no touch was
  // found), any moment of the step counts. With the entering check the cut
  // is a second guard: a car that moves into the other across one of its
  // sides has that side facing its motion, so its nose touches at first
  // touch; the cut keeps rounding from letting a later nose count.
  function judgeFrom(touched) {
    const fresh = touched && span[4] === 1;
    nose[0] = fresh ? (span[0] + EARLY < 1 ? span[0] + EARLY : 1) : 1;
    nose[2] = fresh ? 1 : 0;
    nose[3] = span[2]; nose[4] = span[3];
    nose[6] = fresh && span[7] === 1 ? 1 : 0;
    nose[7] = span[5]; nose[8] = span[6];
  }
  // Who crashes when cars a and b touch: STRIKE.A, STRIKE.B, STRIKE.BOTH
  // (head-on), or STRIKE.NONE (a glance). Symmetric in a and b. `state`
  // (optional) supplies stallSpeed, below which a car has no nose.
  function strikeOutcome(a, b, state) {
    const slow = state ? state.stallSpeed : DEFAULTS.stallSpeed;
    nose[1] = slow * slow;
    motion.x = b.velocity.x - a.velocity.x; motion.y = b.velocity.y - a.velocity.y;
    judgeFrom(contactSpan(a.polygon, motion, b.polygon));
    return outcome(a, b);
  }
  // Did car's nose touch the other car at any moment of this step?
  function leadingSideTouches(car, other) {
    nose[0] = 1; nose[1] = DEFAULTS.stallSpeed * DEFAULTS.stallSpeed; nose[2] = 0; nose[6] = 0;
    return noseTouches(car, other);
  }

  // --- start row ---------------------------------------------------------------

  // The wall check of sim-worker.js poseInCorridor: does a car at this pose
  // stay clear of every border? `road` has borders and an optional
  // borderGrid (SpatialGrid).
  function poseClear(road, x, y, angle, width = DEFAULTS.width, height = DEFAULTS.height) {
    const borders = road && road.borders;
    if (!borders) return true;
    const poly = Car.polygonAt(x, y, angle, width, height);
    const grid = road.borderGrid;
    if (grid) {
      const ids = grid.queryPolygon(poly);
      for (let k = 0; k < ids.length; k++) {
        const b = borders[ids[k]];
        if (b && polysIntersect(poly, b)) return false;
      }
      return true;
    }
    for (let i = 0; i < borders.length; i++) {
      if (polysIntersect(poly, borders[i])) return false;
    }
    return true;
  }
  // Can a car slide from a to b without crossing a border? Stops a slot from
  // jumping over a wall when a gate is longer than the corridor is wide.
  function pathClear(road, a, b) {
    const borders = road && road.borders;
    if (!borders) return true;
    const grid = road.borderGrid;
    if (grid) {
      const ids = grid.queryRay(a, b);
      for (let k = 0; k < ids.length; k++) {
        const w = borders[ids[k]];
        if (w && getIntersection(a, b, w[0], w[1])) return false;
      }
      return true;
    }
    for (let i = 0; i < borders.length; i++) {
      if (getIntersection(a, b, borders[i][0], borders[i][1])) return false;
    }
    return true;
  }

  const FIRST_TURN = 0.03;    // rad: the most one step turns a car (Car#move)
  // Would a car at this pose survive its first step? Its body, grown by
  // `clearance` px in width and in length and turned as far as one step can
  // turn it either way, must touch no border. A short border lying inside the
  // body counts as touching (polysIntersect, used by poseClear, only sees
  // crossings). The default 0.5 px covers a first step of up to 0.5 px, so
  // a top speed up to 25 (the slider stops at 15).
  function startClear(road, x, y, angle, width = DEFAULTS.width, height = DEFAULTS.height, clearance = DEFAULTS.clearance) {
    const borders = road && road.borders;
    if (!borders) return true;
    const grid = road.borderGrid;
    for (let t = -1; t <= 1; t++) {
      const body = Car.polygonAt(x, y, angle + t * FIRST_TURN, width + 2 * clearance, height + 2 * clearance);
      if (grid) {
        const ids = grid.queryPolygon(body);
        for (let k = 0; k < ids.length; k++) {
          const w = borders[ids[k]];
          if (w && convexTouch(w, 2, body, 3)) return false;
        }
      } else {
        for (let i = 0; i < borders.length; i++) {
          if (convexTouch(borders[i], 2, body, 3)) return false;
        }
      }
    }
    return true;
  }

  // Does the car still touch the gate after any first step? A first step
  // turns it by at most FIRST_TURN and moves it at most about
  // maxSpeed / 50 px (0.3 px at the slider's top speed of 15) along its new
  // heading; this checks the extremes up to 0.5 px.
  function touchesThroughFirstStep(x, y, angle, width, height, gate) {
    for (let t = -1; t <= 1; t++) {
      const a = angle + t * FIRST_TURN, fx = -Math.sin(a), fy = -Math.cos(a);
      for (let s = -1; s <= 1; s++) {
        if (!polysIntersect(Car.polygonAt(x + fx * 0.5 * s, y + fy * 0.5 * s, a, width, height), gate)) return false;
      }
    }
    return true;
  }

  // The poses of one heat's start row across gate 0. Slot 0 is the normal
  // start pose (x, y, heading). The other slots alternate sides along the
  // gate: +1, -1, +2, -2 ... pitches, all with the same heading, so every car
  // sits as far from the gate line as slot 0 does. On a gate that is not
  // square to the heading, the row is therefore staggered. A slot is used
  // only when the car:
  //   - touches the gate after any first step;
  //   - survives its first step (startClear: grown by `clearance` px and
  //     turned either way) and can reach slot 0 without crossing a wall;
  //   - has a lane of its own: its centre is at least width + laneGap to the
  //     side of every other slot, so no car starts behind another and
  //     neighbours do not touch when they turn on the first step.
  // If fewer than `count` slots fit, the row is tried again at minPitch.
  // Slots that still do not fit start at the normal pose as ghosts
  // (`ghost: true`).
  //   options: {x, y, heading, gate:[{x,y},{x,y}], count, road, fits,
  //             width, height, pitch, minPitch, clearance, laneGap}
  //   fits(x, y, angle, width, height) is an optional extra check, e.g.
  //   sim-worker.js poseInCorridor.
  //   Returns {poses, pitch, fitted}: poses has `count` entries {x, y,
  //   angle, ghost}; fitted counts the slots that are not ghosts. count may
  //   be 0 (no cars): the row is then empty.
  function startRow(options) {
    const {x, y, heading = 0, gate = null, road = null, fits = null,
      width = DEFAULTS.width, height = DEFAULTS.height,
      pitch = DEFAULTS.pitch, minPitch = DEFAULTS.minPitch, clearance = DEFAULTS.clearance,
      laneGap = DEFAULTS.laneGap} = options;
    const want = Math.floor(options.count);
    if (!(want >= 0 && want <= 65536)) throw new RangeError('CarCollisions.startRow: count must be 0..65536');
    if (want === 0) return {poses: [], pitch, fitted: 0};
    let ux = 0, uy = 0;
    if (gate && gate.length >= 2) {
      const gx = gate[1].x - gate[0].x, gy = gate[1].y - gate[0].y, len = Math.hypot(gx, gy);
      if (len > 0) { ux = gx / len; uy = gy / len; }
    }
    // The car's sideways axis (the base direction of Car.polygonAt).
    const sx = Math.cos(heading), sy = -Math.sin(heading);
    const lane = width + laneGap;
    const home = {x, y};
    const pitches = (minPitch > 0 && minPitch < pitch) ? [pitch, minPitch] : [pitch];
    let best = null;
    for (const step of pitches) {
      const poses = [{x, y, angle: heading, ghost: false}];
      for (let m = 1; (ux || uy) && m <= want && poses.length < want; m++) {
        for (let side = 1; side >= -1 && poses.length < want; side -= 2) {
          const px = x + ux * step * m * side, py = y + uy * step * m * side;
          if (!touchesThroughFirstStep(px, py, heading, width, height, gate)) continue;
          let crowded = false;
          for (let k = 0; k < poses.length && !crowded; k++) {
            crowded = Math.abs((px - poses[k].x) * sx + (py - poses[k].y) * sy) < lane;
          }
          if (crowded) continue;
          if (road && !(startClear(road, px, py, heading, width, height, clearance) && pathClear(road, home, {x: px, y: py}))) continue;
          if (fits && !fits(px, py, heading, width, height)) continue;
          poses.push({x: px, y: py, angle: heading, ghost: false});
        }
      }
      if (!best || poses.length > best.poses.length) best = {poses, pitch: step};
      if (poses.length >= want) break;
    }
    const fitted = best.poses.length;
    while (best.poses.length < want) best.poses.push({x, y, angle: heading, ghost: true});
    return {poses: best.poses, pitch: best.pitch, fitted};
  }
  // Car i's start pose from a startRow result (count: rowSize(N, K)).
  function spawnPose(row, i, state) {
    return row.poses[state.slot[i]];
  }

  // --- per-step contact pass ---------------------------------------------------

  // Per-generation state for N cars. options: {heatSize, stallFrames,
  // stallSpeed}. `row` (a startRow result with at least rowSize(N, K) poses)
  // marks the cars that start as ghosts. After resolveContacts, status[i]
  // (STATUS) and mark[i] (1 = crashed by a contact this step) describe car i
  // until the next physics pass.
  function createState(N, options = {}, row = null) {
    const n = Math.floor(N);
    if (!(n >= 0 && n <= 1e7)) throw new RangeError('CarCollisions.createState: N must be 0..1e7');
    const size = heatSize(n, options.heatSize);
    const heats = heatCount(n, size);
    let stallFrames = Number(options.stallFrames ?? DEFAULTS.stallFrames);
    stallFrames = stallFrames >= 1 ? Math.min(STALL_CAP, Math.floor(stallFrames)) : DEFAULTS.stallFrames;
    let stallSpeed = Number(options.stallSpeed ?? DEFAULTS.stallSpeed);
    if (!(stallSpeed >= 0 && stallSpeed < INF)) stallSpeed = DEFAULTS.stallSpeed;
    if (row && !(row.poses && row.poses.length >= rowSize(n, size))) {
      throw new RangeError('CarCollisions.createState: the start row needs rowSize(N, K) poses');
    }
    const state = {
      N: n, heatSize: size, heats, stallFrames, stallSpeed,
      slot: new Int32Array(n),        // start slot per car (slotOf)
      stall: new Uint16Array(n),      // consecutive steps below stallSpeed
      ghost: new Uint8Array(n),       // 1 = not solid until clear of live heat-mates
      angle: new Float64Array(n).fill(NaN),  // heading at the last pass
      status: new Uint8Array(n),      // STATUS after the last contact pass
      mark: new Uint8Array(n),        // 1 = crashed by a contact in the last pass
      live: new Uint8Array(n),        // scratch for step(): simulated this step
      blocked: new Uint8Array(n),     // scratch: ghost overlaps a live heat-mate
      reach2: new Float64Array(n),    // scratch: squared bounding radius per car
      stats: {steps: 0, pairTests: 0, narrowTests: 0, contacts: 0, sweptContacts: 0, crashes: 0},
    };
    for (let i = 0; i < n; i++) {
      state.slot[i] = slotOf(i, n, heats);
      if (row && row.poses[state.slot[i]].ghost) state.ghost[i] = 1;
      state.status[i] = state.ghost[i] ? GHOST : SOLID;   // at spawn, before any pass
    }
    return state;
  }

  // Resolve this step's contacts. Call it after every car's physics and
  // before any car's perception. A striker gets damaged = true and
  // contactCrash = true. Returns the number of cars it crashed. A car with a
  // non-finite pose or velocity is not in play.
  function resolveContacts(cars, state) {
    const n = state.N;
    if (!cars || cars.length !== n) throw new RangeError('CarCollisions: cars.length does not match the state');
    const H = state.heats, stall = state.stall, ghost = state.ghost, angle = state.angle, status = state.status;
    const mark = state.mark, blocked = state.blocked, reach2 = state.reach2;
    const limit = state.stallFrames, slow2 = state.stallSpeed * state.stallSpeed;

    // 1. Who is solid this step (from the state after every car moved).
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      mark[i] = 0; blocked[i] = 0;
      const vx = c.velocity.x, vy = c.velocity.y;
      if (c.damaged || !isFinite(c.x) || !isFinite(c.y) || !isFinite(c.angle) || !isFinite(vx) || !isFinite(vy) ||
          !(c.width > 0 && c.height > 0)) { status[i] = GONE; continue; }
      const v2 = vx * vx + vy * vy;
      const last = angle[i], turned = last === last && c.angle !== last;
      angle[i] = c.angle;
      if (v2 === 0 || v2 < slow2) {
        if (stall[i] < STALL_CAP) stall[i]++;
        // Turning in place sweeps the body around without any motion the
        // striker rule can see, so such a car is a ghost.
        if (turned) ghost[i] = 1;
      } else {
        if (stall[i] >= limit) ghost[i] = 1;   // leaving a stall: ghost until clear
        stall[i] = 0;
      }
      status[i] = (ghost[i] || stall[i] >= limit) ? GHOST : SOLID;
      reach2[i] = 0.25 * (c.width * c.width + c.height * c.height);
    }

    // 2. Mark: every pair inside a heat, tested against the same state.
    nose[1] = slow2;                    // slower than stallSpeed: no nose
    let pairTests = 0, narrowTests = 0, contacts = 0, sweptContacts = 0;
    for (let h = 0; h < H; h++) {
      for (let a = h; a < n; a += H) {
        const sa = status[a];
        if (sa === GONE) continue;
        const ca = cars[a], ghostA = ghost[a];
        for (let b = a + H; b < n; b += H) {
          const sb = status[b];
          if (sb === GONE) continue;
          const solidPair = sa === SOLID && sb === SOLID;
          if (!solidPair && !ghostA && !ghost[b]) continue;
          pairTests++;
          // Broad phase. Every vertex lies within its car's bounding radius r
          // of (x, y); ra + rb <= 2 max(r); and a pair that touched during the
          // step is within 2r + |m| now, where m is a's motion relative to b.
          // (2r + |m|)^2 <= 8r^2 + 2m^2, so this never skips a real contact.
          const cb = cars[b], dx = ca.x - cb.x, dy = ca.y - cb.y;
          const mx = cb.velocity.x - ca.velocity.x, my = cb.velocity.y - ca.velocity.y;
          const r2 = reach2[a] > reach2[b] ? reach2[a] : reach2[b], m2 = solidPair ? mx * mx + my * my : 0;
          if (dx * dx + dy * dy > (m2 > 0 ? 8 * r2 + 2 * m2 : 4 * r2)) continue;
          narrowTests++;
          const now = trianglesOverlap(ca.polygon, cb.polygon);
          if (now) {
            if (ghostA) blocked[a] = 1;
            if (ghost[b]) blocked[b] = 1;
          }
          if (!solidPair) continue;
          motion.x = mx; motion.y = my;
          const touched = contactSpan(ca.polygon, motion, cb.polygon);
          if (!now) {
            if (!touched) continue;
            sweptContacts++;
          }
          contacts++;
          judgeFrom(touched);
          const s = outcome(ca, cb);
          if (s & STRIKE.A) mark[a] = 1;
          if (s & STRIKE.B) mark[b] = 1;
        }
      }
    }

    // 3. Apply: crash the strikers, release ghosts that are clear, and leave
    // status describing the state after the pass.
    let crashes = 0;
    for (let i = 0; i < n; i++) {
      if (mark[i]) {
        const c = cars[i];
        c.damaged = true;
        c.contactCrash = true;
        status[i] = GONE;
        crashes++;
      } else if (ghost[i] && status[i] !== GONE && !blocked[i]) {
        ghost[i] = 0;
        status[i] = stall[i] >= limit ? GHOST : SOLID;
      }
    }
    const stats = state.stats;
    stats.steps++; stats.pairTests += pairTests; stats.narrowTests += narrowTests;
    stats.contacts += contacts; stats.sweptContacts += sweptContacts; stats.crashes += crashes;
    return crashes;
  }

  // Is car i solid after the last contact pass? (C3's rays and the display
  // read this.)
  function isSolid(state, i) {
    return state.status[i] === SOLID;
  }

  // One collision-mode step: every car moves, contacts resolve, then every
  // car that was simulated senses. Returns the number of contact crashes.
  // Collisions off keeps calling car.update(), which is the same without the
  // middle pass.
  function step(cars, state, borders, checkPointList) {
    const n = state.N, live = state.live;
    if (!cars || cars.length !== n) throw new RangeError('CarCollisions: cars.length does not match the state');
    for (let i = 0; i < n; i++) live[i] = cars[i].updatePhysics(borders, checkPointList) ? 1 : 0;
    const crashes = resolveContacts(cars, state);
    for (let i = 0; i < n; i++) if (live[i]) cars[i].updatePerception(borders, checkPointList);
    return crashes;
  }

  root.CarCollisions = Object.freeze({
    DEFAULTS, STRIKE, STATUS,
    heatSize, heatCount, heatOf, slotOf, rowSize,
    trianglesOverlap, sweptTouch, leadingSideTouches, strikeOutcome,
    poseClear, startClear, startRow, spawnPose,
    createState, resolveContacts, isSolid, step,
  });
})(globalThis);
