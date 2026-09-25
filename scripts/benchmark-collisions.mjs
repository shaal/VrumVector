// Cost of the car-collision contact pass (AI-Car-Racer/collisions.js) at a
// large population. Physics and perception run in the Node simulator
// (tests/helpers/simulation.mjs); the contact pass runs natively, the way a
// browser worker runs it (a Node vm context slows down every global lookup,
// which would overstate its cost). Writes a JSON report.
//
// It also counts who crashed: pairs where one car crashed or both did, and
// two "cut-in" splits of the single-car crashes. The C1 review's: the crashed
// car had not turned for 5 steps while the other car turned in this step (and
// of those, the ones where the turning car was ahead). A car that turned
// earlier and now drives straight across the road counts as "not turning"
// there, so the second split uses the road (the nearest wall): the crashed
// car moved along it (sideways under 10% of its speed) and the other car
// moved across it (sideways 10% or more). --core
// runs another copy of the core instead, e.g. C1's from git:
//   git show 79e59c9:AI-Car-Racer/collisions.js > /tmp/c1-core.js
//
//   node scripts/benchmark-collisions.mjs [output.json] [--core file.js] [--seeds 1,2]
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const args = process.argv.slice(2), coreAt = args.indexOf('--core'), coreFile = coreAt >= 0 ? args.splice(coreAt, 2)[1] : null;
const seedsAt = args.indexOf('--seeds'), seeds = seedsAt >= 0 ? args.splice(seedsAt, 2)[1].split(',') : ['1', '2'];
for (const file of ['utils.js', 'car.js', 'collisions.js']) {
  const source = file === 'collisions.js' && coreFile ? readFileSync(coreFile, 'utf8') : readFileSync(new URL('../AI-Car-Racer/' + file, import.meta.url), 'utf8');
  vm.runInThisContext(source, {filename: file});
}
const C = globalThis.CarCollisions;
const output = args[0] || 'test-results/car-collisions.json';
const N = 500, K = 8, STEPS = 900, FLAT = 244;

// One third of the cars follow their own rays at different top speeds, so
// fast cars catch slow ones; the rest have random brains. This gives a
// realistic mix of crowded and empty heats.
function autopilot(c, top) {
  const r = c.sensor.readings, o = i => (r[i] ? r[i].offset : 1);
  const L = (o(0) + o(1) + o(2)) / 3, R = (o(4) + o(5) + o(6)) / 3, F = o(3);
  c.controls.left = L > R + .03; c.controls.right = R > L + .03;
  c.controls.forward = c.speed < top && F > .25; c.controls.reverse = F < .12 && c.speed > 2;
}
const percentile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const round = x => Math.round(x * 1000) / 1000;

function run(track, seed) {
  const sim = new Simulation({track, seed}), s = sim.spawn, gate = sim.road.checkPointList[0];
  const random = seededRandom(seed + ':brains'), flat = new Float32Array(N * FLAT);
  for (let i = 0; i < flat.length; i++) flat[i] = random() * 2 - 1;
  const row = C.startRow({x: s.x, y: s.y, heading: s.angle, gate, count: C.rowSize(N, K), road: sim.road});
  const state = C.createState(N, {heatSize: K}, row), H = state.heats;
  sim.begin(flat);
  const cars = sim.cars, tops = new Float64Array(N), live = new Uint8Array(N);
  cars.forEach((c, i) => {
    const p = C.spawnPose(row, i, state);
    c.x = p.x; c.y = p.y; c.angle = p.angle; c.polygon = Car.polygonAt(p.x, p.y, p.angle, 30, 50);
    if (i % 3 === 1) { c.useBrain = false; tops[i] = 4 + 5 * random(); }
  });
  const b = sim.road.borders, g = sim.road.checkPointList, contactMs = [], carMs = [], alive = [];
  const heading = new Float64Array(N), sinceTurn = new Int32Array(N).fill(1 << 20), wasLive = new Uint8Array(N);
  const who = {single: 0, both: 0, straightCrashedByTurner: 0, turnerAhead: 0, alongCrashedByAcross: 0};
  for (let f = 1; f <= STEPS; f++) {
    sim.scope.frameCount = f;
    for (let i = 0; i < N; i++) if (tops[i] && !cars[i].damaged) autopilot(cars[i], tops[i]);
    for (let i = 0; i < N; i++) heading[i] = cars[i].angle;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) live[i] = cars[i].updatePhysics(b, g) ? 1 : 0;
    const t1 = performance.now();
    for (let i = 0; i < N; i++) wasLive[i] = cars[i].damaged ? 0 : 1;
    C.resolveContacts(cars, state, b);
    const t2 = performance.now();
    for (let i = 0; i < N; i++) if (live[i]) cars[i].updatePerception(b, g);
    const t3 = performance.now();
    contactMs.push(t2 - t1); carMs.push((t1 - t0) + (t3 - t2));
    if (f % 60 === 0) alive.push(cars.filter(c => !c.damaged).length);
    for (let i = 0; i < N; i++) sinceTurn[i] = cars[i].angle !== heading[i] ? 0 : sinceTurn[i] + 1;
    tally(cars, state, wasLive, sinceTurn, who, b);
  }
  const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length, st = state.stats;
  return {track, seed, N, K, heats: H, steps: STEPS, rowFitted: row.fitted,
    contactMsPerStep: {mean: round(mean(contactMs)), p95: round(percentile(contactMs, .95)), max: round(Math.max(...contactMs))},
    firstSecondContactMsPerStep: round(mean(contactMs.slice(0, 60))),
    carsMsPerStep: round(mean(carMs)),
    pairTestsPerStep: round(st.pairTests / st.steps), narrowTestsPerStep: round(st.narrowTests / st.steps),
    contacts: st.contacts, sweptContacts: st.sweptContacts, deepContacts: st.deepContacts ?? null, contactCrashes: cars.filter(c => c.contactCrash).length,
    whoCrashed: {...who, cutInShare: round(who.straightCrashedByTurner / Math.max(1, who.single)), turnerAheadShare: round(who.turnerAhead / Math.max(1, who.single)),
      acrossShare: round(who.alongCrashedByAcross / Math.max(1, who.single))},
    aliveEverySecond: alive};
}
// Who crashed in this pass. A car crashed by a contact (state.mark) and the
// heat-mates it touched, among the cars in play before the pass: a pair
// where only one crashed is a single-car crash, and it counts toward the
// cut-in split when the crashed car had not turned for 5 steps while the
// other turned in this step (and "ahead" when that car was in front of it).
// The unit direction of the wall nearest (x, y).
function wallAxis(walls, x, y) {
  let best = Infinity, ux = 0, uy = 0;
  for (const [a, b] of walls) {
    const ex = b.x - a.x, ey = b.y - a.y, len2 = ex * ex + ey * ey;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / len2));
    const d = Math.hypot(x - a.x - t * ex, y - a.y - t * ey);
    if (d < best) { best = d; ux = ex / Math.sqrt(len2); uy = ey / Math.sqrt(len2); }
  }
  return {x: ux, y: uy};
}
const sideways = (c, e) => Math.abs(c.velocity.x * -e.y + c.velocity.y * e.x) / Math.max(1e-9, Math.hypot(c.velocity.x, c.velocity.y));
function tally(cars, state, wasLive, sinceTurn, who, walls) {
  const H = state.heats, n = cars.length;
  for (let i = 0; i < n; i++) {
    if (state.mark[i] !== 1) continue;   // 1: crashed by a contact (2: made a ghost)
    const a = cars[i];
    for (let j = i % H; j < n; j += H) {
      if (j === i || !wasLive[j]) continue;
      const o = cars[j], m = {x: o.velocity.x - a.velocity.x, y: o.velocity.y - a.velocity.y};
      if (!(C.trianglesOverlap(a.polygon, o.polygon) || C.sweptTouch(a.polygon, m, o.polygon))) continue;
      if (state.mark[j] === 1) { if (j > i) who.both++; continue; }
      who.single++;
      const e = wallAxis(walls, (a.x + o.x) / 2, (a.y + o.y) / 2);
      if (sideways(a, e) < 0.1 && sideways(o, e) >= 0.1) who.alongCrashedByAcross++;
      if (sinceTurn[i] >= 5 && sinceTurn[j] === 0) {
        who.straightCrashedByTurner++;
        // Ahead: the other car's centre lies in front of the crashed car (angle 0 drives toward -y).
        if ((o.x - a.x) * -Math.sin(a.angle) + (o.y - a.y) * -Math.cos(a.angle) > 0) who.turnerAhead++;
      }
    }
  }
}

// Worst case: every pair in every heat touches (all cars on one spot), and
// heat-mates move at different speeds, so every pair presses and looks up
// the road among Suzuka's 40 walls (the preset with the most).
function pile() {
  const cars = [];
  for (let i = 0; i < N; i++) {
    cars.push({x: 0, y: 0, angle: 0, width: 30, height: 50, damaged: false, velocity: {x: 0, y: 3 + Math.floor(i / C.heatCount(N, K))}, polygon: Car.polygonAt(0, 0, 0, 30, 50)});
  }
  const walls = new Simulation({track: 'Suzuka'}).road.borders;
  const state = C.createState(N, {heatSize: K}), times = [];
  for (let k = 0; k < 600; k++) {
    for (const c of cars) c.damaged = false;
    const t0 = performance.now(); C.resolveContacts(cars, state, walls); times.push(performance.now() - t0);
  }
  const rest = times.slice(100);
  return {N, K, walls: walls.length, pairsPerStep: state.stats.pairTests / state.stats.steps, msPerStep: round(rest.reduce((a, x) => a + x, 0) / rest.length)};
}
function contactTest() {
  const a = Car.polygonAt(0, 0, 0, 30, 50), b = Car.polygonAt(10, 10, .5, 30, 50);
  let hits = 0;
  for (let k = 0; k < 1e6; k++) if (C.trianglesOverlap(a, b)) hits++;
  const t0 = performance.now();
  for (let k = 0; k < 1e7; k++) if (C.trianglesOverlap(a, b)) hits++;
  return {nsPerCall: round((performance.now() - t0) * 1e6 / 1e7), hits};
}

const report = {node: process.version, date: new Date().toISOString().slice(0, 10), core: coreFile || 'AI-Car-Racer/collisions.js',
  runs: seeds.flatMap(seed => ['Rectangle', 'Triangle'].map(track => run(track, 'collisions-bench-' + seed))),
  worstCasePile: pile(), trianglesOverlap: contactTest()};
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.table(report.runs.map(r => ({track: r.track, seed: r.seed, contactMs: r.contactMsPerStep.mean, p95: r.contactMsPerStep.p95,
  max: r.contactMsPerStep.max, carsMs: r.carsMsPerStep, pairs: r.pairTestsPerStep, narrow: r.narrowTestsPerStep, contacts: r.contacts, swept: r.sweptContacts, deep: r.deepContacts, crashes: r.contactCrashes})));
console.table(report.runs.map(r => ({track: r.track, seed: r.seed, ...r.whoCrashed})));
console.log('worst case (every heat-mate pair touching):', report.worstCasePile);
console.log('trianglesOverlap:', report.trianglesOverlap);
console.log('report:', output);
