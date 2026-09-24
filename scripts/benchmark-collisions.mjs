// Cost of the car-collision contact pass (AI-Car-Racer/collisions.js) at a
// large population. Physics and perception run in the Node simulator
// (tests/helpers/simulation.mjs); the contact pass runs natively, the way a
// browser worker runs it (a Node vm context slows down every global lookup,
// which would overstate its cost). Writes a JSON report.
//
//   node scripts/benchmark-collisions.mjs [output.json]
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

for (const file of ['utils.js', 'car.js', 'collisions.js']) {
  vm.runInThisContext(readFileSync(new URL('../AI-Car-Racer/' + file, import.meta.url), 'utf8'), {filename: file});
}
const C = globalThis.CarCollisions;
const output = process.argv[2] || 'test-results/car-collisions.json';
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
  for (let f = 1; f <= STEPS; f++) {
    sim.scope.frameCount = f;
    for (let i = 0; i < N; i++) if (tops[i] && !cars[i].damaged) autopilot(cars[i], tops[i]);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) live[i] = cars[i].updatePhysics(b, g) ? 1 : 0;
    const t1 = performance.now();
    C.resolveContacts(cars, state);
    const t2 = performance.now();
    for (let i = 0; i < N; i++) if (live[i]) cars[i].updatePerception(b, g);
    const t3 = performance.now();
    contactMs.push(t2 - t1); carMs.push((t1 - t0) + (t3 - t2));
    if (f % 60 === 0) alive.push(cars.filter(c => !c.damaged).length);
  }
  const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length, st = state.stats;
  return {track, seed, N, K, heats: H, steps: STEPS, rowFitted: row.fitted,
    contactMsPerStep: {mean: round(mean(contactMs)), p95: round(percentile(contactMs, .95)), max: round(Math.max(...contactMs))},
    firstSecondContactMsPerStep: round(mean(contactMs.slice(0, 60))),
    carsMsPerStep: round(mean(carMs)),
    pairTestsPerStep: round(st.pairTests / st.steps), narrowTestsPerStep: round(st.narrowTests / st.steps),
    contacts: st.contacts, sweptContacts: st.sweptContacts, contactCrashes: cars.filter(c => c.contactCrash).length,
    aliveEverySecond: alive};
}

// Worst case: every pair in every heat touches (all cars on one spot).
function pile() {
  const cars = [];
  for (let i = 0; i < N; i++) {
    cars.push({x: 0, y: 0, angle: 0, width: 30, height: 50, damaged: false, velocity: {x: 0, y: 5}, polygon: Car.polygonAt(0, 0, 0, 30, 50)});
  }
  const state = C.createState(N, {heatSize: K}), times = [];
  for (let k = 0; k < 600; k++) {
    for (const c of cars) c.damaged = false;
    const t0 = performance.now(); C.resolveContacts(cars, state); times.push(performance.now() - t0);
  }
  const rest = times.slice(100);
  return {N, K, pairsPerStep: state.stats.pairTests / state.stats.steps, msPerStep: round(rest.reduce((a, x) => a + x, 0) / rest.length)};
}
function contactTest() {
  const a = Car.polygonAt(0, 0, 0, 30, 50), b = Car.polygonAt(10, 10, .5, 30, 50);
  let hits = 0;
  for (let k = 0; k < 1e6; k++) if (C.trianglesOverlap(a, b)) hits++;
  const t0 = performance.now();
  for (let k = 0; k < 1e7; k++) if (C.trianglesOverlap(a, b)) hits++;
  return {nsPerCall: round((performance.now() - t0) * 1e6 / 1e7), hits};
}

const report = {node: process.version, date: new Date().toISOString().slice(0, 10),
  runs: [run('Rectangle', 'collisions-bench-1'), run('Triangle', 'collisions-bench-1'),
    run('Rectangle', 'collisions-bench-2'), run('Triangle', 'collisions-bench-2')],
  worstCasePile: pile(), trianglesOverlap: contactTest()};
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.table(report.runs.map(r => ({track: r.track, seed: r.seed, contactMs: r.contactMsPerStep.mean, p95: r.contactMsPerStep.p95,
  max: r.contactMsPerStep.max, carsMs: r.carsMsPerStep, pairs: r.pairTestsPerStep, narrow: r.narrowTestsPerStep, contacts: r.contacts, swept: r.sweptContacts, crashes: r.contactCrashes})));
console.log('worst case (every heat-mate pair touching):', report.worstCasePile);
console.log('trianglesOverlap:', report.trianglesOverlap);
console.log('report:', output);
