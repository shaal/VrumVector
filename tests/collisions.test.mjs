// The car-collision core (AI-Car-Racer/collisions.js) and the Car.update()
// split into updatePhysics() + updatePerception(). See
// docs/plan/car-collisions.md (task C1).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PerformanceObserver} from 'node:perf_hooks';
import v8 from 'node:v8';
import {Simulation, presets} from './helpers/simulation.mjs';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';

// car.js exactly as it was before the split, for the before/after checks.
const carBeforeSplit = readFileSync(new URL('./fixtures/car-before-split.js', import.meta.url), 'utf8');
const FLAT = 244;
const plain = new Simulation();
const C = plain.scope.CarCollisions;
const polygonAt = (x, y, angle) => plain.scope.CarClass.polygonAt(x, y, angle, 30, 50);
const polysIntersect = plain.scope.polysIntersect;

// A car-like object for geometry tests. `forward` is the speed along the
// car's direction of travel (-sin, -cos); side is a sideways speed.
function body(x, y, angle, forward = 0, side = 0) {
  const fx = -Math.sin(angle), fy = -Math.cos(angle), rx = Math.cos(angle), ry = -Math.sin(angle);
  const dx = fx * forward + rx * side, dy = fy * forward + ry * side;
  return {x, y, angle, width: 30, height: 50, speed: forward, damaged: false,
    velocity: {x: -dx, y: -dy}, polygon: polygonAt(x, y, angle)};
}
function moveTo(c, x, y) { c.x = x; c.y = y; c.polygon = polygonAt(x, y, c.angle); }
const swap = s => ((s & 1) << 1) | ((s & 2) >> 1);
// a's motion this step relative to b (Car#move does x -= velocity.x).
const relative = (a, b) => ({x: b.velocity.x - a.velocity.x, y: b.velocity.y - a.velocity.y});
function brains(n, seed) {
  const r = seededRandom(seed), flat = new Float32Array(n * FLAT);
  for (let i = 0; i < flat.length; i++) flat[i] = r() * 2 - 1;
  return flat;
}
function spawnOn(sim, index) {
  const gates = sim.road.checkPointList, center = g => ({x: (g[0].x + g[1].x) / 2, y: (g[0].y + g[1].y) / 2});
  const a = center(gates[index]), b = center(gates[(index + 1) % gates.length]);
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy), offset = Math.min(20, length * .05);
  return {x: a.x - dx / length * offset, y: a.y - dy / length * offset, angle: Math.atan2(-dx, -dy)};
}
// Is a point between the two walls of a preset (inside exactly one loop)?
function inside(point, loop) {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
const onRoad = (preset, p) => inside(p, preset.points) !== inside(p, preset.points2);

// --- loading -------------------------------------------------------------------

test('the core loads through each worker\'s own importScripts list, before any random number is drawn', () => {
  const lists = {};
  for (const [worker, core] of [['sim-worker.js', 'collisions.js'], ['learning/trial-worker.js', '../collisions.js']]) {
    const source = readFileSync(new URL('../AI-Car-Racer/' + worker, import.meta.url), 'utf8');
    const files = [...source.match(/importScripts\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.ok(files.includes(worker.startsWith('learning/') ? '../car.js' : 'car.js'), worker + ' imports car.js');
    const base = new URL('../AI-Car-Racer/' + worker, import.meta.url);
    const scope = {console, performance, postMessage() {}, Math: Object.create(Math)};
    scope.Math.random = () => { throw Error('random number drawn while loading'); };
    scope.self = scope; scope.globalThis = scope;
    const context = vm.createContext(scope);
    for (const f of [...files, core]) vm.runInContext(readFileSync(new URL(f, base), 'utf8'), context, {filename: f});
    const cc = scope.CarCollisions;
    assert.ok(Object.isFrozen(cc) && Object.isFrozen(cc.DEFAULTS), worker);
    assert.equal(cc.heatCount(500, 8), 63);
    // `class Car` is a script-scope binding, not a property of the global.
    assert.equal(vm.runInContext('CarCollisions.trianglesOverlap(Car.polygonAt(0, 0, 0, 30, 50), Car.polygonAt(10, 10, 1, 30, 50))', context), true);
    assert.equal(vm.runInContext('CarCollisions.poseClear({borders: [[{x: -100, y: 0}, {x: 100, y: 0}]]}, 0, 0, 0)', context), false);
    lists[worker] = files.length;
  }
  assert.ok(lists['sim-worker.js'] >= 7 && lists['learning/trial-worker.js'] >= 7);
});

// --- heats ---------------------------------------------------------------------

test('heats: car i is in heat i mod ceil(N/K), no heat exceeds K, sizes differ by at most one', () => {
  for (const N of [1, 2, 3, 7, 8, 9, 15, 16, 17, 48, 63, 64, 65, 500, 501, 1000]) {
    for (const K of [1, 2, 3, 8, N, Infinity]) {
      const H = C.heatCount(N, K), k = C.heatSize(N, K), sizes = new Array(H).fill(0), seen = new Set();
      assert.equal(H, Math.ceil(N / k));
      for (let i = 0; i < N; i++) sizes[C.heatOf(i, H)]++;
      for (let i = 0; i < N; i++) {
        const h = C.heatOf(i, H), s = C.slotOf(i, N, H);
        assert.ok(s >= 0 && s < sizes[h], `N=${N} K=${K} car ${i}: slot ${s} of ${sizes[h]}`);
        assert.ok(!seen.has(h + ':' + s), 'two cars share a slot');
        seen.add(h + ':' + s);
      }
      assert.ok(Math.max(...sizes) <= k, `N=${N} K=${K}`);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `N=${N} K=${K}`);
      assert.equal(C.rowSize(N, K), Math.max(...sizes));
      assert.equal(C.slotOf(0, N, H), 0, 'car 0 (the elite) keeps slot 0');
    }
  }
  assert.equal(C.heatCount(500, 8), 63);                         // 59 heats of 8 and 4 of 7
  assert.equal(C.heatCount(12, Infinity), 1);                    // K = N: everyone together
  assert.equal(C.heatCount(0, 8), 0);
  assert.equal(C.rowSize(0, 8), 0);
  for (const bad of [undefined, NaN, 0, 0.5, -3, '']) assert.equal(C.heatSize(500, bad), 8);
  assert.equal(C.heatSize(5, 8), 5);
  assert.equal(C.heatSize(500, 8.9), 8);
});

test('start slots do not depend on where a kind of car sits in the population', () => {
  // The population lists the elite and its copies first and fresh cars last
  // (learning/policy.js buildPopulation). Every slot must get a fair share
  // of the first tenth and of the last tenth of the cars.
  for (const [N, K] of [[500, 8], [96, 8], [48, 8], [200, 5]]) {
    const H = C.heatCount(N, K), size = C.rowSize(N, K), tenth = Math.ceil(N / 10);
    for (const range of [[0, tenth], [N - tenth, N]]) {
      const counts = new Array(size).fill(0);
      for (let i = range[0]; i < range[1]; i++) counts[C.slotOf(i, N, H)]++;
      const fair = (range[1] - range[0]) / size;
      assert.ok(Math.max(...counts) <= Math.ceil(fair) + 1 && Math.min(...counts) >= Math.floor(fair) - 1,
        `N=${N} K=${K} cars ${range}: ${counts}`);
    }
  }
});

// --- contact test ----------------------------------------------------------------

test('triangle contact: overlap, touching, containment, near misses', () => {
  const a = polygonAt(100, 100, 0);
  assert.equal(C.trianglesOverlap(a, a), true, 'identical');
  assert.equal(C.trianglesOverlap(a, polygonAt(400, 100, 0)), false, 'far apart');
  // Shared vertex and shared edge count as contact.
  const tri = (...v) => v.map(([x, y]) => ({x, y}));
  const base = tri([0, 0], [10, 0], [0, 10]);
  assert.equal(C.trianglesOverlap(base, tri([10, 0], [20, 0], [20, 10])), true, 'vertex');
  assert.equal(C.trianglesOverlap(base, tri([10, 0], [0, 10], [10, 10])), true, 'edge');
  assert.equal(C.trianglesOverlap(base, tri([10 + 1e-9, 0], [20, 0], [20, 10])), false, 'near miss');
  // Containment: no edges cross, which polysIntersect (edge crossings) misses.
  const big = tri([-100, -100], [100, -100], [0, 100]), small = tri([-1, 0], [1, 0], [0, 1]);
  assert.equal(polysIntersect(big, small), false);
  assert.equal(C.trianglesOverlap(big, small), true);
  assert.equal(C.trianglesOverlap(small, big), true);
  // Tip to tip.
  assert.equal(C.trianglesOverlap(polygonAt(0, 0, 0), polygonAt(0, 49.999, Math.PI)), true, 'tips overlap');
  assert.equal(C.trianglesOverlap(polygonAt(0, 0, 0), polygonAt(0, 50.001, Math.PI)), false, 'tips apart');
});

test('triangle contact agrees with edge crossing or containment on 20 000 random car pairs', () => {
  const random = seededRandom('contact-fuzz'), cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const within = (p, t) => {
    const d1 = cross(t[0], t[1], p), d2 = cross(t[1], t[2], p), d3 = cross(t[2], t[0], p);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let hits = 0;
  for (let n = 0; n < 20000; n++) {
    const a = polygonAt(random() * 120, random() * 120, random() * 7 - 3.5);
    const b = polygonAt(random() * 120, random() * 120, random() * 7 - 3.5);
    const expected = polysIntersect(a, b) || within(a[0], b) || within(b[0], a);
    const got = C.trianglesOverlap(a, b);
    assert.equal(got, expected, JSON.stringify({a, b}));
    assert.equal(C.trianglesOverlap(b, a), got);
    if (got) hits++;
  }
  assert.ok(hits > 3000 && hits < 17000, `hits ${hits}`);        // both outcomes well covered
});

test('swept contact agrees with 300 sub-steps on 6 000 random moving pairs', () => {
  // Touching at some moment of straight motion is exact in the core; dense
  // sampling may only miss a graze between two samples.
  const random = seededRandom('swept-fuzz'), shift = (p, dx, dy) => p.map(v => ({x: v.x + dx, y: v.y + dy}));
  let sampledHits = 0, grazes = 0, sweptOnly = 0;
  for (let n = 0; n < 6000; n++) {
    const p = polygonAt(random() * 140, random() * 140, random() * 7 - 3.5), q = polygonAt(random() * 140, random() * 140, random() * 7 - 3.5);
    const mx = random() * 60 - 30, my = random() * 60 - 30;
    let sampled = false;
    for (let s = 0; s <= 300 && !sampled; s++) sampled = C.trianglesOverlap(shift(p, -mx * (1 - s / 300), -my * (1 - s / 300)), q);
    const swept = C.sweptTouch(p, {x: mx, y: my}, q);
    if (sampled) { sampledHits++; assert.equal(swept, true, 'a sampled touch was missed: ' + JSON.stringify({p, q, mx, my})); }
    else if (swept) {
      sweptOnly++;
      let fine = false;                                           // look closer before calling it a graze
      for (let s = 0; s <= 10000 && !fine; s++) fine = C.trianglesOverlap(shift(p, -mx * (1 - s / 10000), -my * (1 - s / 10000)), q);
      if (!fine) grazes++;
    }
    if (C.trianglesOverlap(p, q)) assert.equal(swept, true, 'touching now is touching during the step');
  }
  assert.ok(sampledHits > 1000, `sampled ${sampledHits}`);
  assert.ok(grazes < 10, `grazes ${grazes} of ${sweptOnly}`);
});

// --- striker rule --------------------------------------------------------------

test('striker rule: rear-end, head-on, T-bone, parked, reversing, sliding, glance', () => {
  const {A, B, BOTH, NONE} = C.STRIKE;
  const check = (a, b, expected, label) => {
    assert.equal(C.trianglesOverlap(a.polygon, b.polygon), true, label + ': cars must touch');
    assert.equal(C.strikeOutcome(a, b), expected, label);
    assert.equal(C.strikeOutcome(b, a), swap(expected), label + ' (swapped)');
  };
  // Angle 0 drives toward -y. The tip (vertex 0) is the rear.
  const front = body(0, 0, 0, 5);
  assert.ok(front.polygon[0].y > front.y && front.polygon[1].y < front.y, 'tip is the rear');
  check(body(0, 48, 0, 10), body(0, 0, 0, 5), A, 'rear-end: the car behind');
  check(body(0, 48, 0, 5), body(0, 0, 0, 10), A, 'rear-end: slower car behind still strikes');
  check(body(0, 0, 0, 5), body(0, -48, Math.PI, 5), BOTH, 'head-on');
  check(body(0, 0, 0, 5), body(12, -46, Math.PI, 3), BOTH, 'offset head-on');
  check(body(32, 0, Math.PI / 2, 6), body(0, 0, 0, 5), A, 'T-bone: into the flank of a moving car');
  check(body(32, 0, Math.PI / 2, 6), body(0, 0, 0, 0), A, 'T-bone: into a parked car');
  check(body(32, 0, Math.PI / 2, 0), body(0, 0, 0, 0), NONE, 'two parked cars never strike');
  check(body(0, 0, 0, -3), body(0, 48, 0, 0), A, 'reversing into a parked car');
  check(body(0, 0, 0, 1, 4), body(17, 20, 0, 0), A, 'sliding sideways into a parked car');
  check(body(0, 0, 0, 5), body(10, 34, Math.PI / 2, 5), NONE, 'tail glance: no nose touches');
  check(body(20, 5, 0, 10), body(0, 0, 0, 10), A, 'side by side at one speed: only the car whose corner is in the other');
  // A car moving straight leads with its front edge only: a hit on its tail
  // or flank is never its fault.
  assert.equal(C.leadingSideTouches(body(0, 0, 0, 5), body(0, 48, 0, 0)), false);
  assert.equal(C.leadingSideTouches(body(0, 0, 0, 5), body(0, -48, 0, 0)), true);
});

test('striker rule: fast cars cannot pass through each other between two steps', () => {
  // The front edge jumps over a thin tail in one 15 px step: the cars overlap
  // but neither front edge touches now. The band the nose swept catches it.
  const fast = body(0, -45, 0, 15), parked = body(20, -63, -Math.PI / 2, 0);
  assert.equal(C.trianglesOverlap(fast.polygon, parked.polygon), true);
  assert.equal(C.strikeOutcome(fast, parked), C.STRIKE.A);
  assert.equal(C.strikeOutcome(body(0, -45, 0, 0.5), parked), C.STRIKE.NONE, 'the same pose at a crawl is a glance');
  // A head-on pass with a 28 px offset at 15 + 15 px per step: the cars never
  // overlap at the end of a step, but they touched during it. Both crash.
  const a = body(0, 0, 0, 15), b = body(28, -35, Math.PI, 15), m = relative(a, b);
  assert.equal(C.trianglesOverlap(a.polygon, b.polygon), false);
  assert.equal(C.sweptTouch(a.polygon, m, b.polygon), true);
  const state = C.createState(2, {heatSize: 2});
  assert.equal(C.resolveContacts([a, b], state), 2);
  assert.equal(state.stats.sweptContacts, 1);
  // One step later they have passed each other, and nothing touched during
  // that step.
  const later = [body(0, -15, 0, 15), body(28, -20, Math.PI, 15)];
  assert.equal(C.resolveContacts(later, C.createState(2, {heatSize: 2})), 0, 'already past each other: nothing new touched');
});

// Did a and b first touch during this step (apart at its start, touching now)?
const freshContact = (a, b) => !C.trianglesOverlap(polygonAt(a.x + a.velocity.x - b.velocity.x, a.y + a.velocity.y - b.velocity.y, a.angle), b.polygon) &&
  C.trianglesOverlap(a.polygon, b.polygon);

test('striker rule: noses are judged at the moment of first touch', () => {
  // A crossing from a mixed run: A's nose touches B first; B's nose reaches
  // A only later in the same step, through A's body. Only A crashes.
  const a = {x: 8.527623737782541, y: 26.912900206727876, angle: -0.30645920539274807, width: 30, height: 50,
    velocity: {x: -1.6903859405173671, y: 5.342090532454542}};
  const b = {x: -18.7197684491669, y: -7.289981816648057, angle: -1.324078259859469, width: 30, height: 50,
    velocity: {x: -5.401609836586128, y: 1.3603896166608875}};
  a.polygon = polygonAt(a.x, a.y, a.angle); b.polygon = polygonAt(b.x, b.y, b.angle);
  assert.equal(freshContact(a, b), true);
  assert.equal(C.leadingSideTouches(a, b) && C.leadingSideTouches(b, a), true, 'both noses touch at some moment of the step');
  assert.equal(C.strikeOutcome(a, b), C.STRIKE.A);
  assert.equal(C.resolveContacts([a, b], C.createState(2, {heatSize: 2})), 1);
  assert.deepEqual([a.damaged, !!b.damaged], [true, false]);
  // A car creeping slower than stallSpeed has no nose: when it is T-boned,
  // only the car that hit it crashes.
  for (const creep of [-1e-15, -0.05, 0.05]) {
    assert.equal(C.strikeOutcome(body(32, 0, Math.PI / 2, 6), body(0, 0, 0, creep)), C.STRIKE.A, 'creeping at ' + creep);
  }
});

test('striker rule, known outcomes: a cut-in crashes the car behind; a car rammed while reversing away does not', () => {
  // A cuts in front of B (A ahead-right, turned into B's lane). B's nose
  // touches A, so B crashes. This is the plan's literal rule: see the limits
  // in docs/validation/car-collisions.md.
  const b = body(0, 0, 0, 10), a = body(10, -45, 0.3, 10);
  assert.equal(C.trianglesOverlap(a.polygon, b.polygon), true);
  assert.equal(C.strikeOutcome(b, a), C.STRIKE.A, 'the car behind strikes');
  // A car reversing away is rammed in its front. Its long sides are its nose
  // and their ends are its front corners, but it moves away from the
  // contact, so only the rammer crashes (at any sideways offset).
  for (const offset of [0, 8, 16]) {
    const reverser = body(0, 0, 0, -2), rammer = body(offset, -48, Math.PI, 8);
    assert.equal(freshContact(rammer, reverser), true);
    assert.equal(C.strikeOutcome(reverser, rammer), C.STRIKE.B, 'offset ' + offset);
  }
  // A car that noses into another's flank behind its front corner: only it.
  const side = body(36, 0, Math.PI / 2, 8), driven = body(0, 0, 0, 4);
  assert.equal(freshContact(side, driven), true);
  assert.equal(C.strikeOutcome(side, driven), C.STRIKE.A);
  // A fast car's front edge runs onto the front corner of a car merging
  // slowly across its path: the fast car moved into it; the merging car
  // moved along the fast car's front edge.
  const fast = body(0, 0, 0, 12), merging = body(37, -34, Math.PI / 2, 3);
  assert.equal(freshContact(fast, merging), true);
  assert.equal(C.strikeOutcome(fast, merging), C.STRIKE.A);
  // A slower-than-stallSpeed nose never strikes; the state sets the speed.
  const slowBehind = body(0, 48, 0, 0.5), ahead = body(0, 0, 0, 0);
  assert.equal(C.strikeOutcome(slowBehind, ahead), C.STRIKE.A);
  assert.equal(C.strikeOutcome(slowBehind, ahead, C.createState(2, {stallSpeed: 1})), C.STRIKE.NONE);
});

test('striker rule: cars already touching at the start of the step are judged over the whole step', () => {
  // Found by search: these two overlap at the start of the step (an old
  // glance). Car a's nose sweeps into b only halfway through the step, and
  // that still counts.
  const a = {x: 37.3729, y: 23.7856, angle: 1.8472, width: 30, height: 50, velocity: {x: 3.81636349454101, y: -0.10111442792565706}};
  const b = {x: 40.9862, y: 34.016, angle: 0.9003, width: 30, height: 50, velocity: {x: 10.200781564866496, y: 8.288958949462824}};
  a.polygon = polygonAt(a.x, a.y, a.angle); b.polygon = polygonAt(b.x, b.y, b.angle);
  assert.equal(C.trianglesOverlap(polygonAt(a.x + a.velocity.x - b.velocity.x, a.y + a.velocity.y - b.velocity.y, a.angle), b.polygon), true, 'touching at the start');
  assert.equal(C.strikeOutcome(a, b) & C.STRIKE.A, C.STRIKE.A);
  // Here b's nose sweeps through a during the step and is clear of it again
  // at the end: it still counts.
  const c = {x: 44.6322, y: 62.4434, angle: 2.2796, width: 30, height: 50, velocity: {x: 5.721599461254375, y: -2.8493228204213112}};
  const d = {x: 64.4769, y: 65.439, angle: 5.6708, width: 30, height: 50, velocity: {x: -5.796025043740025, y: 11.000063528104665}};
  c.polygon = polygonAt(c.x, c.y, c.angle); d.polygon = polygonAt(d.x, d.y, d.angle);
  assert.equal(C.trianglesOverlap(polygonAt(c.x + c.velocity.x - d.velocity.x, c.y + c.velocity.y - d.velocity.y, c.angle), d.polygon), true, 'touching at the start');
  assert.equal(C.strikeOutcome(c, d), C.STRIKE.B);
});

test('striker rule: the entering speed is measured along the contact, at least stallSpeed', () => {
  // Car a slides sideways at 5 px per step and creeps f px per step toward
  // b's tail, which its front edge meets halfway through the step. The
  // contact normal is a's front edge, so a enters b at f px per step.
  const slide = f => {
    const a = body(0, 48, 0, f, 5), b = body(0, -2 + f / 2, 0, 0);
    assert.equal(freshContact(a, b), true, 'f = ' + f);
    return C.strikeOutcome(a, b);
  };
  assert.equal(slide(0.07), C.STRIKE.NONE, 'into b at 0.07 px per step: below stallSpeed');
  assert.equal(slide(0.15), C.STRIKE.A, 'into b at 0.15 px per step');
  assert.equal(slide(3), C.STRIKE.A);
});

test('striker rule: two mirror-image cars that meet corner to corner both crash, wherever they meet', () => {
  // From a traffic run: both front corners reach the other car at the same
  // moment, so two axes open together. Rounding must not pick a winner.
  const R = {x: 24.2755446641336, y: 1191.2463720813582, angle: 0.6000000000000003, vx: 2.664427805463006, vy: 3.894583324527475};
  const make = (x, y, angle, vx, vy) => ({x, y, angle, width: 30, height: 50, damaged: false, velocity: {x: vx, y: vy}, polygon: polygonAt(x, y, angle)});
  for (let k = 0; k < 300; k++) {
    const cx = (k * 37.3) % 3000 + 50, cy = (k * 71.9) % 1600 + 50 - R.y;
    const right = make(cx + R.x, cy + R.y, R.angle, R.vx, R.vy), left = make(cx - R.x, cy + R.y, -R.angle, -R.vx, R.vy);
    assert.equal(C.strikeOutcome(right, left), C.STRIKE.BOTH, `placement ${k}`);
    assert.equal(C.resolveContacts([left, right], C.createState(2, {heatSize: 2})), 2, `placement ${k}`);
  }
});

test('striker rule is symmetric on 20 000 random touching pairs', () => {
  const random = seededRandom('striker-fuzz');
  let touching = 0, both = 0, none = 0;
  for (let n = 0; n < 20000; n++) {
    const a = body(random() * 60, random() * 60, random() * 7 - 3.5, random() * 16 - 4, random() * 4 - 2);
    const b = body(random() * 60, random() * 60, random() * 7 - 3.5, random() * 16 - 4, random() * 4 - 2);
    if (!C.trianglesOverlap(a.polygon, b.polygon)) continue;
    touching++;
    const s = C.strikeOutcome(a, b);
    assert.equal(C.strikeOutcome(b, a), swap(s));
    if (s === 3) both++; if (s === 0) none++;
  }
  assert.ok(touching > 5000 && both > 0 && none > 0, `touching ${touching}, both ${both}, none ${none}`);
});

// --- the contact pass ------------------------------------------------------------

test('contacts are marked first and applied after: a chain crashes the same cars in any order', () => {
  // rear hits middle, middle hits front, in one step.
  const layout = () => ({rear: body(0, 96, 0, 12), middle: body(0, 48, 0, 8), front: body(0, 0, 0, 4)});
  const orders = [['rear', 'middle', 'front'], ['front', 'middle', 'rear'], ['middle', 'rear', 'front'],
    ['middle', 'front', 'rear'], ['rear', 'front', 'middle'], ['front', 'rear', 'middle']];
  for (const order of orders) {
    const cars = layout(), list = order.map(k => cars[k]), state = C.createState(3, {heatSize: 3});
    assert.equal(C.resolveContacts(list, state), 2);
    assert.equal(cars.rear.damaged && cars.rear.contactCrash, true, order.join());
    assert.equal(cars.middle.damaged && cars.middle.contactCrash, true, order.join());
    assert.equal(cars.front.damaged, false, order.join());
    assert.equal(cars.front.contactCrash, undefined);
    assert.deepEqual({...state.stats}, {steps: 1, pairTests: 3, narrowTests: 2, contacts: 2, sweptContacts: 0, crashes: 2});
    // After the pass, status and mark describe the result.
    const at = k => list.indexOf(cars[k]);
    assert.deepEqual([at('rear'), at('middle'), at('front')].map(i => [state.status[i], state.mark[i], C.isSolid(state, i)]),
      [[C.STATUS.GONE, 1, false], [C.STATUS.GONE, 1, false], [C.STATUS.SOLID, 0, true]]);
  }
});

test('only cars of the same heat collide', () => {
  // N = 4, K = 2: heats {0, 2} and {1, 3}.
  const run = (i, j) => {
    const cars = [0, 1, 2, 3].map(k => body(1000 * (k + 1), 5000, 0, 0));
    cars[i] = body(0, 48, 0, 10); cars[j] = body(0, 0, 0, 5);
    const state = C.createState(4, {heatSize: 2});
    C.resolveContacts(cars, state);
    return cars[i].damaged;
  };
  assert.equal(run(0, 2), true);
  assert.equal(run(1, 3), true);
  assert.equal(run(0, 1), false);
  assert.equal(run(2, 3), false);
  assert.equal(C.createState(4, {heatSize: 1}).heats, 4);
});

test('wrecks, and cars parked for 2 s, are not solid; a car that drives off again is a ghost until clear', () => {
  // A wreck in the way.
  const cars = [body(0, 48, 0, 10), body(0, 0, 0, 0)];
  cars[1].damaged = true;
  assert.equal(C.resolveContacts(cars, C.createState(2, {heatSize: 2})), 0);
  assert.equal(cars[0].damaged, false);

  // A parked car is solid for 119 steps and not solid from step 120.
  const parkedFor = steps => {
    const striker = body(0, 200, 0, 10), parked = body(0, 0, 0, 0), list = [striker, parked];
    const s = C.createState(2, {heatSize: 2});
    for (let i = 1; i < steps; i++) C.resolveContacts(list, s);   // striker far away
    moveTo(striker, 0, 48);
    C.resolveContacts(list, s);
    return {striker, parked, list, s};
  };
  assert.equal(parkedFor(119).striker.damaged, true, 'parked 119 steps: still solid');
  const late = parkedFor(120);
  assert.equal(late.striker.damaged, false, 'parked 120 steps: not solid');
  assert.equal(late.s.status[1], C.STATUS.GHOST);
  assert.equal(C.DEFAULTS.stallFrames, 120);

  // The parked car drives off while overlapping: it is a ghost, so nobody
  // crashes, and it stays one while the cars overlap.
  const {striker, parked, list, s} = late;
  parked.velocity = {x: 0, y: 5};                                  // moving toward -y
  for (let i = 0; i < 3; i++) assert.equal(C.resolveContacts(list, s), 0);
  assert.equal(s.ghost[1], 1);
  // Once clear, it is solid again, and its nose counts.
  moveTo(striker, 0, 300);
  C.resolveContacts(list, s);
  assert.equal(s.ghost[1], 0);
  assert.equal(C.isSolid(s, 1), true, 'released this pass: solid in the status');
  moveTo(striker, 0, -48); striker.velocity = {x: 0, y: 0}; striker.speed = 0;   // parked ahead of it
  assert.equal(C.resolveContacts(list, s), 1);
  assert.equal(parked.damaged, true);
  assert.equal(striker.damaged, false);
});

test('a car that turns without moving is a ghost, so its spinning body hits nobody', () => {
  // Holding forward, reverse and a turn spins a car in place with velocity
  // exactly (0, 0). It is parked (never strikes), but its body sweeps around.
  const spinner = body(0, 0, 0, 0), driver = body(0, 48, 0, 10), list = [driver, spinner];
  const state = C.createState(2, {heatSize: 2});
  moveTo(driver, 200, 48);
  C.resolveContacts(list, state);                                 // first pass: no previous heading yet
  assert.equal(state.ghost[1], 0);
  spinner.angle += 0.03; spinner.polygon = polygonAt(0, 0, spinner.angle);
  moveTo(driver, 0, 48);                                          // the driver's nose now touches the spinner
  assert.equal(C.resolveContacts(list, state), 0);
  assert.equal(driver.damaged, false);
  assert.equal(state.ghost[1], 1);
  // It stops turning and the driver leaves: it is solid again.
  moveTo(driver, 200, 48);
  C.resolveContacts(list, state);
  assert.equal(C.isSolid(state, 1), true);
});

test('cars without room in the start row start as ghosts, and become solid once clear', () => {
  const row = {poses: [{x: 0, y: 0, angle: 0, ghost: false}, {x: 0, y: 0, angle: 0, ghost: true}]};
  const cars = [body(0, 0, 0, 3), body(0, 0, 0, 3)];               // same pose, both moving
  const state = C.createState(2, {heatSize: 2}, row);
  assert.deepEqual(Array.from(state.ghost), [0, 1]);
  assert.equal(C.resolveContacts(cars, state), 0);
  assert.equal(state.ghost[1], 1, 'still overlapping: still a ghost');
  moveTo(cars[1], 100, 0);
  C.resolveContacts(cars, state);
  assert.equal(state.ghost[1], 0);
  // A ghost that overlaps another ghost stays a ghost, so two cars cannot
  // turn solid on top of each other.
  const pair = [body(0, 0, 0, 3), body(0, 0, 0, 3)], s2 = C.createState(2, {heatSize: 2});
  s2.ghost.fill(1);
  C.resolveContacts(pair, s2);
  assert.deepEqual(Array.from(s2.ghost), [1, 1]);
  // A row shorter than the largest heat is refused.
  assert.throws(() => C.createState(3, {heatSize: 3}, row), {name: 'RangeError'});
});

test('the broad phase never drops a real contact, for cars of any size and speed (20 000 random pairs)', () => {
  const random = seededRandom('broad-phase-fuzz'), at = plain.scope.CarClass.polygonAt;
  let touching = 0, swept = 0;
  for (let n = 0; n < 20000; n++) {
    const make = () => {
      const w = 10 + random() * 40, h = 20 + random() * 70;
      const c = body(random() * 160, random() * 160, random() * 7 - 3.5, random() * 17 - 2, random() * 2 - 1);
      c.width = w; c.height = h; c.polygon = at(c.x, c.y, c.angle, w, h);
      return c;
    };
    const a = make(), b = make(), m = relative(a, b), s = C.strikeOutcome(a, b);
    const now = C.trianglesOverlap(a.polygon, b.polygon), contact = now || C.sweptTouch(a.polygon, m, b.polygon);
    const crashes = C.resolveContacts([a, b], C.createState(2, {heatSize: 2}));
    assert.equal(crashes, contact ? (s & 1) + (s >> 1) : 0);
    assert.equal(a.damaged, contact && (s & 1) === 1);
    if (now) touching++; else if (contact) swept++;
  }
  assert.ok(touching > 1000 && swept > 200, `touching ${touching}, swept only ${swept}`);
  // Found by search: pairs that touched early in the step and are now just
  // over two bounding radii apart (58.3 px). A broad phase that ignored the
  // motion would drop them.
  for (const [pa, pb] of [
    [[84.087, 5.6206, 2.5872, 4.8946733530120605, -10.894484021160142], [25.3434, 10.5965, 1.5583, 14.318270070500295, -1.2765785476089804]],
    [[90.1255, 83.4755, 5.1759, -5.581694069890128, 0.8095439210774065], [92.0532, 24.7811, 0.2279, 4.136717716996685, 13.332110121428105]]]) {
    const make = ([x, y, angle, vx, vy]) => ({x, y, angle, width: 30, height: 50, damaged: false, velocity: {x: vx, y: vy}, polygon: polygonAt(x, y, angle)});
    const a = make(pa), b = make(pb), state = C.createState(2, {heatSize: 2});
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 58.31);
    assert.equal(C.trianglesOverlap(a.polygon, b.polygon), false);
    assert.equal(C.resolveContacts([a, b], state), 1);
    assert.equal(state.stats.sweptContacts, 1);
  }
});

test('the contact pass is robust to odd input and draws no random numbers', () => {
  const nan = body(0, 0, 0, 5); nan.x = NaN;
  const flat = body(0, 0, 0, 5); flat.width = 0;
  const turned = body(0, 0, 0, 5); turned.angle = NaN; turned.polygon = polygonAt(0, 0, NaN);
  const drifting = body(0, 0, 0, 5); drifting.velocity = {x: NaN, y: 1};
  const cars = [nan, body(0, 48, 0, 10), body(0, 0, 0, 5), flat, turned, drifting];
  const state = C.createState(6, {heatSize: 6});
  const saved = plain.scope.Math.random;
  plain.scope.Math.random = () => { throw Error('random number drawn'); };
  try { assert.equal(C.resolveContacts(cars, state), 1); }
  finally { plain.scope.Math.random = saved; }
  assert.equal(cars[0].damaged, false);                           // a NaN car is simply not in play
  assert.equal(cars[1].damaged, true);
  assert.equal(state.status[3], C.STATUS.GONE, 'a car with no width is not in play');
  assert.deepEqual([state.status[4], state.status[5]], [C.STATUS.GONE, C.STATUS.GONE], 'non-finite heading or velocity');
  assert.equal(C.sweptTouch(polygonAt(0, 0, 0), {x: NaN, y: 0}, polygonAt(0, 0, 0)), false);
  assert.equal(C.sweptTouch(polygonAt(0, 0, 0), {x: Infinity, y: 0}, polygonAt(500, 0, 0)), false);
  assert.equal(C.sweptTouch(polygonAt(0, 0, NaN), {x: 1, y: 0}, polygonAt(0, 0, NaN)), false, 'non-finite bodies never touch');
  const dot = [{x: 3, y: 3}, {x: 3, y: 3}, {x: 3, y: 3}];
  assert.equal(C.sweptTouch(dot, {x: 1, y: 0}, [{x: 90, y: 90}, {x: 90, y: 90}, {x: 90, y: 90}]), false, 'two points have no axis to test');
  // Motion along an edge: that edge's normal sees no motion at all.
  const tri = [{x: 0, y: 0}, {x: 10, y: 0}, {x: 0, y: 10}];
  assert.equal(C.sweptTouch(tri, {x: 50, y: 0}, [{x: -30, y: -20}, {x: -20, y: -20}, {x: -30, y: -10}]), false, 'below its path');
  assert.equal(C.sweptTouch(tri, {x: 50, y: 0}, [{x: -30, y: 2}, {x: -20, y: 2}, {x: -30, y: 8}]), true, 'on its path');
  // A non-finite body touches nothing, from either side.
  const bad = polygonAt(0, 0, NaN), good = polygonAt(0, 0, 0);
  assert.equal(C.trianglesOverlap(bad, good), false);
  assert.equal(C.trianglesOverlap(good, bad), false);
  assert.equal(C.trianglesOverlap(bad, bad), false);
  assert.throws(() => C.resolveContacts(cars.slice(0, 2), state), {name: 'RangeError'});
  assert.equal(C.createState(0).heats, 0);
  assert.equal(C.resolveContacts([], C.createState(0)), 0);
  const empty = C.startRow({x: 0, y: 0, count: 0});
  assert.deepEqual([empty.poses.length, empty.fitted], [0, 0]);
  assert.equal(C.createState(0, {}, empty).N, 0);
  // Before the first pass, every car that is not a ghost reads as solid.
  const fresh = C.createState(3, {heatSize: 3}, {poses: [{ghost: false}, {ghost: false}, {ghost: true}]});
  assert.deepEqual([0, 1, 2].map(i => C.isSolid(fresh, i)), [true, true, false]);
  for (const N of [Infinity, NaN, -1]) assert.throws(() => C.createState(N), {name: 'RangeError'});
  // Options: anything below 1 step, or not a number, uses the default.
  for (const bad of [0, 0.5, -5, NaN, 'x']) assert.equal(C.createState(1, {stallFrames: bad}).stallFrames, 120);
  assert.equal(C.createState(1, {stallFrames: 1.5}).stallFrames, 1);
  for (const bad of [-1, Infinity, NaN]) assert.equal(C.createState(1, {stallSpeed: bad}).stallSpeed, 0.1);
});

test('the contact pass allocates nothing, on every path it has', async () => {
  // 63 heats of 8. In each heat, slot k plays one part: 0-1 a head-on pass
  // that only the swept test sees (both crash), 2-3 a pile that touches now
  // (both crash), 4 a car turning in place (a ghost) with 5 driving off
  // after a stall on top of it (a ghost, blocked), 6 a start-row ghost in
  // the clear (released), 7 a parked solid car.
  const N = 504, H = 63, cars = [];
  const part = i => Math.floor(i / H), x0 = i => 5000 * (i % H);
  for (let i = 0; i < N; i++) {
    const k = part(i), x = x0(i);
    cars.push([body(x, 0, 0, 15), body(x + 28, -35, Math.PI, 15), body(x + 500, 0, 0, 5), body(x + 500, 0, 0, 5),
      body(x + 1000, 0, 0, 0), body(x + 1000, 0, 0, 5), body(x + 1500, 0, 0, 5), body(x + 2000, 0, 0, 0)][k]);
  }
  const state = C.createState(N, {heatSize: 8});
  const reset = () => {
    for (let i = 0; i < N; i++) {
      const k = part(i);
      cars[i].damaged = false;
      state.ghost[i] = k === 6 ? 1 : 0;
      state.stall[i] = k === 5 ? 500 : 0;
      state.angle[i] = k === 4 ? cars[i].angle - 0.03 : cars[i].angle;
    }
  };
  // Young-generation bytes, and garbage collections, during a window of work.
  const young = () => { let n = 0; for (const s of v8.getHeapSpaceStatistics()) if (s.space_name === 'new_space') n += s.space_used_size; return n; };
  const gcs = [], observer = new PerformanceObserver(list => gcs.push(...list.getEntries()));
  observer.observe({entryTypes: ['gc']});
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  const during = async work => {
    await settle(); gcs.length = 0;
    const t0 = performance.now(), y0 = young(); work(); const y1 = young(), t1 = performance.now();
    await settle();
    return {gcs: gcs.filter(e => e.startTime >= t0 && e.startTime <= t1).length, bytes: y1 - y0};
  };
  const steps = 50;
  try {
    // The probe works: 16 bytes for each of the 1 764 pairs of a step would
    // show as about 1.4 MB per window.
    const sink = [];
    const control = await during(() => { for (let i = 0; i < steps * H * 28; i++) sink.push({x: i}); sink.length = 0; });
    assert.ok(control.gcs > 0 || control.bytes > 1e6, 'the probe missed an allocating loop: ' + JSON.stringify(control));
    // The parts do what they should, and code that is not optimized yet
    // (which boxes numbers) warms up.
    reset(); assert.equal(C.resolveContacts(cars, state), 4 * H);
    const partOf = k => Array.from({length: H}, (_, h) => h + k * H);
    assert.ok(partOf(4).every(i => state.ghost[i] === 1) && partOf(5).every(i => state.ghost[i] === 1), 'spinner and stall ghosts');
    assert.ok(partOf(6).every(i => state.ghost[i] === 0 && C.isSolid(state, i)), 'start-row ghost released');
    assert.equal(state.stats.sweptContacts, H);
    for (let k = 0; k < 300; k++) { reset(); C.resolveContacts(cars, state); }
    // A loaded machine can delay optimization, so keep trying for a while;
    // code that allocates in its steady state fails every window.
    const counts = new Int32Array(steps), windows = [], started = Date.now();
    while (windows.length < 40 && Date.now() - started < 8000) {
      const w = await during(() => { for (let k = 0; k < steps; k++) { reset(); counts[k] = C.resolveContacts(cars, state); } });
      windows.push(w);
      if (w.gcs === 0 && w.bytes < 16384) break;
    }
    const last = windows[windows.length - 1];
    assert.ok(last.gcs === 0 && last.bytes < 16384, 'the contact pass allocated: ' + JSON.stringify(windows));
    assert.ok(counts.every(n => n === 4 * H));
  } finally { observer.disconnect(); }
});

// --- start row -------------------------------------------------------------------

function rowInvariants(sim, preset, row, gate, label) {
  const fitted = row.poses.filter(p => !p.ghost);
  for (const p of fitted) {
    const poly = polygonAt(p.x, p.y, p.angle);
    assert.ok(C.poseClear(sim.road, p.x, p.y, p.angle), label + ': clear of walls');
    assert.ok(polysIntersect(poly, gate), label + ': touches the start gate');
    assert.ok(onRoad(preset, p), label + ': on the road');
  }
  const sx = Math.cos(row.poses[0].angle), sy = -Math.sin(row.poses[0].angle);
  for (let i = 0; i < fitted.length; i++) for (let j = i + 1; j < fitted.length; j++) {
    const side = Math.abs((fitted[i].x - fitted[j].x) * sx + (fitted[i].y - fitted[j].y) * sy);
    assert.ok(side >= 30 + C.DEFAULTS.laneGap, label + ': two slots share a lane');
  }
}
// One real step for a row of cars (fresh brains, forced controls): every car
// must register the start gate and survive.
const CONTROLS = {forward: {forward: true}, reverse: {reverse: true}, idle: {}, left: {forward: true, left: true},
  right: {forward: true, right: true}, backLeft: {reverse: true, left: true}, backRight: {reverse: true, right: true}};
function firstStep(sim, row, gateIndex, controls, label) {
  sim.begin(brains(row.poses.length, 'row-' + label));
  sim.cars.forEach((c, i) => {
    const p = row.poses[i];
    c.x = p.x; c.y = p.y; c.angle = p.angle; c.polygon = polygonAt(p.x, p.y, p.angle);
    c.useBrain = false; Object.assign(c.controls, controls);
  });
  sim.scope.frameCount = 1;
  for (const c of sim.cars) c.update(sim.road.borders, sim.road.checkPointList);
  const state = C.createState(sim.cars.length, {heatSize: sim.cars.length}, row);
  assert.equal(C.resolveContacts(sim.cars, state), 0, label + ': contact in the start row');
  sim.cars.forEach((c, i) => {
    if (row.poses[i].ghost) return;
    assert.equal(c.damaged, false, label + ': crashed on frame 1');
    assert.equal(c.checkPointsCount, 1, label + ': start gate not registered on frame 1');
    assert.equal(c.checkPointsPassed[0], gateIndex);
  });
}

test('start row: 8 cars fit across gate 0 of every preset, and all register gate 0 on frame 1', () => {
  for (const preset of presets) {
    const sim = new Simulation({track: preset.name}), gate = sim.road.checkPointList[0], s = sim.spawn;
    const row = C.startRow({x: s.x, y: s.y, heading: s.angle, gate, count: 8, road: sim.road});
    assert.equal(row.fitted, 8, preset.name);
    assert.equal(row.pitch, 45, preset.name);
    assert.deepEqual({...row.poses[0]}, {x: s.x, y: s.y, angle: s.angle, ghost: false}, preset.name + ': the elite keeps the start pose');
    rowInvariants(sim, preset, row, gate, preset.name);
    for (const [name, controls] of Object.entries(CONTROLS)) firstStep(sim, row, 0, controls, preset.name + ' ' + name);
    // Car i starts at its slot; car 0 at the start pose.
    const state = C.createState(500, {heatSize: 8}, row);
    assert.equal(C.spawnPose(row, 0, state), row.poses[0]);
    assert.equal(C.spawnPose(row, 7 * 63 + 3, state), row.poses[C.slotOf(7 * 63 + 3, 500, 63)]);
  }
});

test('start row on narrow gates: a tighter pitch first, then ghosts at the start pose', () => {
  // Hexagon's 130 px gate (gate 2) and Triangle's 198 px apex gate (gate 3)
  // as start gates; Triangle gate 2 needs the tighter pitch.
  const cases = [['Hexagon', 2, 3, 45], ['Triangle', 3, 3, 45], ['Triangle', 2, 5, 34]];
  for (const [name, index, fitted, pitch] of cases) {
    const preset = presets.find(p => p.name === name), sim = new Simulation({track: name});
    const gate = sim.road.checkPointList[index], s = spawnOn(sim, index);
    const row = C.startRow({x: s.x, y: s.y, heading: s.angle, gate, count: 8, road: sim.road});
    const label = `${name} gate ${index} (${Math.round(Math.hypot(gate[1].x - gate[0].x, gate[1].y - gate[0].y))} px)`;
    assert.equal(row.fitted, fitted, label);
    assert.equal(row.pitch, pitch, label);
    assert.equal(row.poses.length, 8);
    row.poses.forEach((p, i) => assert.equal(p.ghost, i >= fitted, label));
    for (const p of row.poses.slice(fitted)) assert.deepEqual({x: p.x, y: p.y, angle: p.angle}, {x: s.x, y: s.y, angle: s.angle});
    rowInvariants(sim, preset, row, gate, label);
    for (const [name, controls] of Object.entries(CONTROLS)) firstStep(sim, row, index, controls, label + ' ' + name);
    if (pitch === 34) {
      const strict = C.startRow({x: s.x, y: s.y, heading: s.angle, gate, count: 8, road: sim.road, minPitch: 45});
      assert.ok(strict.fitted < fitted, label + ': the tighter pitch fits more cars');
    }
  }
  // No gate at all: everyone but slot 0 is a ghost.
  const lone = C.startRow({x: 5, y: 5, heading: 0, gate: null, count: 3});
  assert.deepEqual([...lone.poses.map(p => p.ghost)], [false, true, true]);
  for (const bad of [-1, NaN, Infinity, 1e9]) assert.throws(() => C.startRow({x: 0, y: 0, count: bad}), {name: 'RangeError'});
});

test('start row: every car gets its own lane, even on a gate nearly parallel to the heading', () => {
  // Heading 0 drives toward -y; its lanes run along x. A gate tilted 70 deg
  // from the x axis puts neighbouring slots mostly ahead of each other.
  const t = 70 * Math.PI / 180, gate = [{x: -300 * Math.cos(t), y: -300 * Math.sin(t)}, {x: 300 * Math.cos(t), y: 300 * Math.sin(t)}];
  const row = C.startRow({x: 0, y: 0, heading: 0, gate, count: 5});
  const fitted = row.poses.filter(p => !p.ghost);
  assert.ok(fitted.length >= 3, 'some slots fit');
  for (let i = 0; i < fitted.length; i++) for (let j = i + 1; j < fitted.length; j++) {
    assert.ok(Math.abs(fitted[i].x - fitted[j].x) >= 33, `slots ${i} and ${j} share a lane`);
  }
  assert.ok(Math.abs(fitted[1].x) > 45 * Math.cos(t) + 1, 'the first neighbour (one pitch away, same lane) was skipped');
  // Exactly parallel: no other slot can have a lane of its own.
  const column = C.startRow({x: 0, y: 0, heading: 0, gate: [{x: 0, y: -300}, {x: 0, y: 300}], count: 4});
  assert.equal(column.fitted, 1);
  // The optional extra check gets the car's size too, so sim-worker.js
  // poseInCorridor(x, y, angle, width, height) can be passed as it is.
  const seen = [];
  C.startRow({x: 0, y: 0, heading: 0, gate: [{x: -300, y: 0}, {x: 300, y: 0}], count: 3, fits: (...args) => { seen.push(args.length === 5 && args[3] === 30 && args[4] === 50); return true; }});
  assert.ok(seen.length > 0 && seen.every(Boolean));
});

test('a start slot that passes startClear survives its first step, even next to short walls', () => {
  // Short walls placed just outside the car's outline, where a first-step
  // turn or move could reach them. startClear is stricter than the car's own
  // crash check (it sees a short wall inside the body too), so every pose it
  // accepts must survive one real step with any controls.
  const sim = new Simulation({track: 'Rectangle', seed: 'short-walls'}), random = seededRandom('short-walls');
  const gates = [[{x: -400, y: 0}, {x: 400, y: 0}]];
  let accepted = 0, rejected = 0;
  for (let n = 0; n < 1500; n++) {
    const angle = random() * 0.4 - 0.2, body0 = polygonAt(0, 0, angle), walls = [];
    for (let w = 0; w < 2; w++) {
      // A point on the outline, pushed 0.2 to 3 px outward from the centre,
      // and a wall roughly along the outline there.
      const i = Math.floor(random() * 3), t = random(), a = body0[i], b = body0[(i + 1) % 3];
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t, len = Math.hypot(px, py), push = 0.2 + random() * 2.8;
      const cx = px + px / len * push, cy = py + py / len * push, half = 1 + random() * 5;
      const dir = Math.atan2(b.y - a.y, b.x - a.x) + (random() - .5) * 0.6;
      walls.push([{x: cx - Math.cos(dir) * half, y: cy - Math.sin(dir) * half}, {x: cx + Math.cos(dir) * half, y: cy + Math.sin(dir) * half}]);
    }
    // Every other road has a spatial grid, as the simulators build one.
    const grid = n % 2 ? new sim.scope.GridClass(3200, 1800, 200) : null;
    if (grid) grid.addSegments(walls);
    const road = {borders: walls, checkPointList: gates, borderGrid: grid, cpGrid: null, left: 0, right: 3200, top: 0, bottom: 1800};
    if (!C.startClear(road, 0, 0, angle)) { rejected++; continue; }
    accepted++;
    sim.scope.road = road;
    for (const controls of Object.values(CONTROLS)) {
      sim.begin(brains(1, 'wall-' + n));
      const c = sim.cars[0];
      c.x = 0; c.y = 0; c.angle = angle; c.polygon = polygonAt(0, 0, angle); c.useBrain = false; Object.assign(c.controls, controls);
      sim.scope.frameCount = 1;
      c.update(walls, gates);
      assert.equal(c.damaged, false, `walls ${JSON.stringify(walls)} angle ${angle} controls ${JSON.stringify(controls)}`);
    }
  }
  assert.ok(accepted > 200 && rejected > 200, `accepted ${accepted}, rejected ${rejected}`);
});

test('start row: a gate that ends near a slot only keeps the slot if the car still touches it after any first step', () => {
  // Heading -pi/2 drives toward +x; the gate line x = 0 crosses the car's
  // thin tail, 5 px from its tip, so a slot's contact with the gate is only
  // about 1.5 px wide there. Sweep the gate's end across that edge.
  // The gate starts at y = -40, so only the slot one pitch toward +y (at
  // y = 45, touching the gate line from 43.5 to 46.5) can fit.
  const sim = new Simulation({track: 'Rectangle', seed: 'gate-end'}), home = {x: 20, y: 0, angle: -Math.PI / 2};
  const far = [[{x: -2000, y: -900}, {x: 2000, y: -900}], [{x: -2000, y: 900}, {x: 2000, y: 900}]];
  let kept = 0, dropped = 0;
  for (let e = 43.3; e <= 44.8; e += 0.01) {
    const gate = [{x: 0, y: -40}, {x: 0, y: e}], gates = [gate, [{x: -1500, y: -900}, {x: -1500, y: 900}]];
    const road = {borders: far, checkPointList: gates, borderGrid: null, cpGrid: null, left: 0, right: 3200, top: 0, bottom: 1800};
    sim.scope.road = road;
    const row = C.startRow({x: home.x, y: home.y, heading: home.angle, gate, count: 2, road, minPitch: 45});
    if (row.fitted < 2) { dropped++; continue; }
    kept++;
    const p = row.poses[1];
    assert.ok(Math.abs(p.y - 45) < 1e-9, 'the slot at y = 45');
    for (const controls of Object.values(CONTROLS)) {
      sim.begin(brains(1, 'gate-end'));
      const c = sim.cars[0];
      c.x = p.x; c.y = p.y; c.angle = p.angle; c.polygon = polygonAt(p.x, p.y, p.angle); c.useBrain = false; Object.assign(c.controls, controls);
      sim.scope.frameCount = 1;
      c.update(far, gates);
      assert.equal(c.checkPointsCount, 1, `gate end ${e}: ${JSON.stringify(controls)} missed the gate`);
    }
  }
  assert.ok(kept > 5 && dropped > 5, `kept ${kept}, dropped ${dropped}`);
});

test('start row: a slot just past the gate line is kept only if a reverse first step still touches the gate', () => {
  // Heading 0 drives toward -y; the gate runs along y = 0. Slot 0 (and so
  // every slot) has its front edge d px past the gate line. A first step in
  // reverse moves the car back about 0.25 px.
  const sim = new Simulation({track: 'Rectangle', seed: 'front-edge'});
  const far = [[{x: -2000, y: -900}, {x: 2000, y: -900}], [{x: -2000, y: 900}, {x: 2000, y: 900}]];
  const gate = [{x: -300, y: 0}, {x: 300, y: 0}], gates = [gate, [{x: -1500, y: -900}, {x: -1500, y: 900}]];
  const road = {borders: far, checkPointList: gates, borderGrid: null, cpGrid: null, left: 0, right: 3200, top: 0, bottom: 1800};
  sim.scope.road = road;
  let kept = 0, dropped = 0;
  for (let d = 0.05; d <= 0.9; d += 0.05) {
    const row = C.startRow({x: 0, y: 25 - d, heading: 0, gate, count: 3, road, minPitch: 45});
    if (row.fitted < 3) { dropped++; continue; }
    kept++;
    for (const p of row.poses.slice(1)) {
      for (const controls of Object.values(CONTROLS)) {
        sim.begin(brains(1, 'front-edge'));
        const c = sim.cars[0];
        c.x = p.x; c.y = p.y; c.angle = p.angle; c.polygon = polygonAt(p.x, p.y, p.angle); c.useBrain = false; Object.assign(c.controls, controls);
        sim.scope.frameCount = 1;
        c.update(far, gates);
        assert.equal(c.checkPointsCount, 1, `d = ${d.toFixed(2)}: ${JSON.stringify(controls)} missed the gate`);
      }
    }
  }
  assert.ok(kept > 3 && dropped > 3, `kept ${kept}, dropped ${dropped}`);
});

test('start row: slots near short wall spikes, beyond a wall, and near a gate end still start cleanly', () => {
  // A straight corridor 300 px wide with random short spikes on its walls,
  // and a second corridor on the other side of the top wall. The gate spans
  // both corridors and sometimes ends inside the first. Every fitted slot
  // must be in the first corridor, register the gate on frame 1, and survive
  // it with every control set.
  const sim = new Simulation({track: 'Rectangle', seed: 'spikes'}), random = seededRandom('spikes');
  let fitted = 0;
  for (let n = 0; n < 150; n++) {
    const walls = [[{x: -2000, y: -150}, {x: 2000, y: -150}], [{x: -2000, y: 150}, {x: 2000, y: 150}], [{x: -2000, y: 450}, {x: 2000, y: 450}]];
    for (let k = 0; k < 14; k++) {
      const x = random() * 70 - 15, top = random() < .5, len = 5 + random() * 60, lean = random() * 20 - 10;
      walls.push(top ? [{x, y: -150}, {x: x + lean, y: -150 + len}] : [{x, y: 150}, {x: x + lean, y: 150 - len}]);
    }
    const end = random() < .5 ? 440 : 30 + random() * 120;          // gate ends beyond the wall, or mid-road
    const gate = [{x: 0, y: -150}, {x: 0, y: end}], gates = [gate, [{x: -1500, y: -150}, {x: -1500, y: 150}]];
    const grid = n % 2 ? new sim.scope.GridClass(3200, 1800, 200) : null;
    if (grid) grid.addSegments(walls);
    const road = {borders: walls, checkPointList: gates, borderGrid: grid, cpGrid: null, left: 0, right: 3200, top: 0, bottom: 1800};
    sim.scope.road = road;
    // Heading -pi/2 drives toward +x; the car straddles the gate at x = 0.
    const home = {x: 20, y: random() * 60 - 30, angle: -Math.PI / 2};
    const row = C.startRow({x: home.x, y: home.y, heading: home.angle, gate, count: 8, road});
    for (const p of row.poses.slice(1).filter(q => !q.ghost)) {
      fitted++;
      assert.ok(p.y > -150 && p.y < 150, 'a slot beyond the wall: ' + JSON.stringify(p));
      for (const controls of Object.values(CONTROLS)) {
        sim.begin(brains(1, 'spike-' + n));
        const c = sim.cars[0];
        c.x = p.x; c.y = p.y; c.angle = p.angle; c.polygon = polygonAt(p.x, p.y, p.angle); c.useBrain = false; Object.assign(c.controls, controls);
        sim.scope.frameCount = 1;
        c.update(walls, gates);
        assert.equal(c.damaged, false, `layout ${n}, slot ${JSON.stringify(p)}, ${JSON.stringify(controls)}`);
        assert.equal(c.checkPointsCount, 1, `layout ${n}, slot ${JSON.stringify(p)}, ${JSON.stringify(controls)}: gate missed`);
      }
    }
  }
  assert.ok(fitted > 300, `fitted ${fitted}`);
});

// --- Car.update split: bit-identical to the code before the split ---------------

// Everything a step can change, per car.
function snapshot(cars) {
  const out = [];
  for (const c of cars) {
    out.push(c.x, c.y, c.angle, c.speed, c.velocity.x, c.velocity.y, +c.damaged, +c.slide, c.checkPointsCount, c.laps,
      +c.controls.forward, +c.controls.left, +c.controls.right, +c.controls.reverse, c.driveFrames, c.delayCounter);
    for (const p of c.polygon) out.push(p.x, p.y);
    if (c.sensor) for (const r of c.sensor.readings) out.push(r ? r.offset : -1, r ? r.x : 0, r ? r.y : 0);
  }
  return out;
}
function finals(cars) {
  return cars.map(c => ({lapTimes: c.lapTimes, passed: [...c.checkPointsPassed], stats: c.drivingStats ? {...c.drivingStats} : null,
    rays: c.sensor ? c.sensor.rays.map(r => [r[0].x, r[0].y, r[1].x, r[1].y]) : null,
    levels: c.brain ? c.brain.levels.map(l => [Array.from(l.inputs), Array.from(l.outputs), Array.from(l.preThreshold)]) : null}));
}
// Objects from the simulator's vm realm have other prototypes, so compare
// their JSON (exact for finite doubles).
const sameJSON = (a, b, where) => assert.equal(JSON.stringify(a), JSON.stringify(b), where);
function sameNumbers(a, b, where) {
  assert.equal(a.length, b.length, where);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(`${where}: value ${i} differs (${a[i]} vs ${b[i]})`);
}
// A scripted driver that uses the car's own rays, so some cars finish laps.
function autopilot(c, top) {
  const r = c.sensor.readings, o = i => (r[i] ? r[i].offset : 1);
  const L = (o(0) + o(1) + o(2)) / 3, R = (o(4) + o(5) + o(6)) / 3, F = o(3);
  c.controls.left = L > R + .03; c.controls.right = R > L + .03;
  c.controls.forward = c.speed < top && F > .25; c.controls.reverse = F < .12 && c.speed > 2;
}
const steppers = {
  combined: () => (cars, b, g) => { for (const c of cars) c.update(b, g); },
  // Collision mode's order: every car moves, then every car senses.
  threePass: () => (cars, b, g) => {
    const live = cars.map(c => c.updatePhysics(b, g));
    for (let i = 0; i < cars.length; i++) if (live[i]) cars[i].updatePerception(b, g);
  },
  // The core's own step() with heats of one car: no pair can touch.
  coreStep: sim => {
    const state = sim.scope.CarCollisions.createState(sim.cars.length, {heatSize: 1});
    return (cars, b, g) => sim.scope.CarCollisions.step(cars, state, b, g);
  },
};
function lockstep({track, seed, profile = 'balanced', N = 40, pilots = 8, top = 6, frames = 900, stride = 1, stepper}) {
  const before = new Simulation({track, seed, profile, carScript: carBeforeSplit}), after = new Simulation({track, seed, profile});
  const flat = brains(N, seed + ':brains');
  let laps = 0, crashes = 0;
  for (const sim of [before, after]) {
    sim.begin(flat);
    for (let i = 0; i < pilots; i++) sim.cars[i].useBrain = false;
    sim.scope.SENSOR_STRIDE = stride;
    sim.scope.bestCar = stride > 1 ? sim.cars[pilots] : null;
  }
  assert.equal(typeof before.cars[0].updatePhysics, 'undefined', 'the fixture is the old car.js');
  const steps = [[before, steppers.combined()], [after, stepper(after)]];
  for (let f = 1; f <= frames; f++) {
    for (const [sim, step] of steps) {
      sim.scope.frameCount = f;
      for (let i = 0; i < pilots; i++) if (!sim.cars[i].damaged) autopilot(sim.cars[i], top);
      step(sim.cars, sim.road.borders, sim.road.checkPointList);
    }
    sameNumbers(snapshot(before.cars), snapshot(after.cars), `${track} frame ${f}`);
  }
  sameJSON(finals(after.cars), finals(before.cars), track + ' final state');
  const [x, y] = [after.run(0), before.run(0)];
  sameJSON({...x, vector: [...x.vector]}, {...y, vector: [...y.vector]}, track + ' run result');
  for (const c of after.cars) { laps = Math.max(laps, c.laps); if (c.damaged) crashes++; }
  return {laps, crashes};
}

test('collisions off: the split update() is bit-identical to car.js before the split (Rectangle, Triangle)', () => {
  for (const track of ['Rectangle', 'Triangle']) for (const seed of ['split-a', 'split-b']) {
    const {crashes} = lockstep({track, seed, stepper: steppers.combined});
    assert.ok(crashes > 0 && crashes < 40, `${track}: a mix of crashed and surviving cars (${crashes})`);
  }
});

test('collisions off: moving every car and then sensing every car gives the same results', () => {
  for (const track of ['Rectangle', 'Triangle']) lockstep({track, seed: 'three-pass', stepper: steppers.threePass});
  for (const track of ['Rectangle', 'Triangle']) lockstep({track, seed: 'core-step', stepper: steppers.coreStep});
});

test('collisions off: identical with laps, the sensor stride, and a driving style', () => {
  // Oval: the scripted drivers finish two laps, covering the lap-time code.
  assert.ok(lockstep({track: 'Oval', seed: 'laps', N: 12, pilots: 6, top: 8, frames: 1500, stepper: steppers.threePass}).laps >= 2);
  lockstep({track: 'Rectangle', seed: 'stride', stride: 4, stepper: steppers.threePass});
  lockstep({track: 'Triangle', seed: 'careful', profile: 'careful', stepper: steppers.combined});
});

test('collisions off: identical for a player car that crashes, respawns, and is then driven by the AI', () => {
  const [before, after] = [carBeforeSplit, null].map(carScript => {
    const sim = new Simulation({track: 'Rectangle', seed: 'player', carScript});
    Object.assign(sim.scope, {document: new EventTarget(), window: new EventTarget(), AbortController});
    const s = sim.spawn, car = new sim.scope.CarClass(s.x, s.y, 30, 50, 'KEYS', 15, s.angle);
    return {sim, car};
  });
  let respawned = 0;
  for (let f = 1; f <= 600; f++) {
    for (const {sim, car} of [before, after]) {
      sim.scope.frameCount = f;
      car.controls.manual.forward = f < 250; car.controls.manual.left = f > 60 && f < 70;
      car.controls.resolve();
      if (f === 250) car.aiDriving = true;
      car.update(sim.road.borders, sim.road.checkPointList);
    }
    if (before.car.delayCounter === 0 && f > 1 && before.car.x === before.sim.spawn.x) respawned++;
    sameNumbers(snapshot([before.car]), snapshot([after.car]), `player frame ${f}`);
  }
  sameJSON(finals([after.car]), finals([before.car]), 'player final state');
  assert.ok(respawned > 0, 'the player car crashed and respawned');
  before.car.controls.dispose?.(); after.car.controls.dispose?.();
});

test('a wreck skips sensing and its network: updatePhysics() returns false and update() stops there', () => {
  const sim = new Simulation({track: 'Rectangle', seed: 'wreck'});
  sim.begin(brains(2, 'wreck'));
  const [wreck, live] = sim.cars, b = sim.road.borders, g = sim.road.checkPointList;
  wreck.damaged = true;
  wreck.sensor.update = () => assert.fail('a wreck sensed');
  const NN = vm.runInContext('NeuralNetwork', sim.scope), feedForward = NN.feedForward;
  let thinks = 0;
  NN.feedForward = (...args) => { thinks++; return feedForward(...args); };
  try {
    assert.equal(wreck.updatePhysics(b, g), false);
    wreck.update(b, g);
    assert.equal(thinks, 0);
    assert.equal(live.updatePhysics(b, g), true);
    live.updatePerception(b, g);
    assert.equal(thinks, 1);
  } finally { NN.feedForward = feedForward; }
});

test('collisions off: a short genetic run is identical before and after the split', () => {
  const context = {profile: 'balanced', track: 'split', maxSpeed: 15, traction: .5, seconds: 8};
  for (const track of ['Rectangle', 'Triangle']) {
    const arm = carScript => {
      const sim = new Simulation({track, seed: 'ga-' + track, carScript}), ends = [];
      const result = runTrialArm({simulate: flat => { sim.begin(flat); const out = sim.run(8); ends.push(snapshot(sim.cars)); return out; },
        context, seeds: [], random: seededRandom('ga-pop-' + track), generations: 4, population: 24});
      return {result, ends};
    };
    const before = arm(carBeforeSplit), after = arm(null);
    sameJSON(after.result, before.result, track + ' genetic run');
    before.ends.forEach((end, g) => sameNumbers(after.ends[g], end, `${track} generation ${g}`));
  }
});

// --- collisions on: deterministic, and the invariants hold ------------------------

function collisionRun(track, seed, N = 64) {
  const sim = new Simulation({track, seed}), core = sim.scope.CarCollisions, s = sim.spawn, gate = sim.road.checkPointList[0];
  const row = core.startRow({x: s.x, y: s.y, heading: s.angle, gate, count: core.rowSize(N, 8), road: sim.road});
  const state = core.createState(N, {heatSize: 8}, row), H = state.heats;
  sim.begin(brains(N, seed + ':brains'));
  sim.cars.forEach((c, i) => { const p = core.spawnPose(row, i, state); c.x = p.x; c.y = p.y; c.angle = p.angle; c.polygon = polygonAt(p.x, p.y, p.angle); });
  const trace = [], math = sim.scope.Math, random = math.random, b = sim.road.borders, g = sim.road.checkPointList;
  const ghostBefore = Uint8Array.from(state.ghost);
  for (let f = 1; f <= 600; f++) {
    sim.scope.frameCount = f;
    const cars = sim.cars;
    math.random = () => { throw Error('random number drawn during a collision step'); };
    try { core.step(cars, state, b, g); } finally { math.random = random; }
    // Checks that do not reuse the striker rule: a car crashed this pass is
    // a wreck and not solid; a solid car is not a wreck; and a ghost released
    // this pass overlaps no live heat-mate.
    for (let i = 0; i < N; i++) {
      if (state.mark[i]) assert.ok(cars[i].damaged && cars[i].contactCrash && !core.isSolid(state, i), `${track} frame ${f} car ${i}`);
      if (core.isSolid(state, i)) assert.equal(cars[i].damaged, false);
      if (ghostBefore[i] && !state.ghost[i] && !cars[i].damaged) {
        for (let j = i % H; j < N; j += H) if (j !== i && !cars[j].damaged) assert.equal(core.trianglesOverlap(cars[i].polygon, cars[j].polygon), false);
      }
    }
    ghostBefore.set(state.ghost);
    trace.push(...snapshot(cars));
  }
  const contactCrashes = sim.cars.filter(c => c.contactCrash).length;
  assert.equal(contactCrashes, state.stats.crashes);
  return {trace, stats: {...state.stats}, contactCrashes};
}

test('collisions on: runs are deterministic on Rectangle and Triangle, with real contacts', () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const first = collisionRun(track, 'on-' + track), again = collisionRun(track, 'on-' + track);
    sameNumbers(again.trace, first.trace, track);
    sameJSON(again.stats, first.stats, track);
    assert.ok(first.stats.contacts > 0 && first.contactCrashes > 0, `${track}: ${JSON.stringify(first.stats)}`);
  }
});
