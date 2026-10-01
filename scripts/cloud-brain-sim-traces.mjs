// X1 (docs/plan/cloud-brain.md): golden traces of the game's own
// simulation, for the Rust port (cloud-brain/sim) to be checked against.
// The browser's classic scripts (utils.js, spatialGrid.js, network.js,
// controls.js, sensor.js, driver/profiles.js, car.js) run in a Node vm as the
// trial worker runs them: one car alone, sensors every frame, the start pose
// of main.js's computeStartInfoInPlace. Brains: random ones, and ones the
// game's own learning loop evolves on the track, seeded (the longest
// evolved ones drive laps).
//
//   node scripts/cloud-brain-sim-traces.mjs [--out tests/fixtures/cloud-brain-sim/traces.json] [--extra N]
//   node scripts/cloud-brain-sim-traces.mjs --presets
//
// Both write tests/fixtures/cloud-brain-sim/presets.json: the ten presets'
// walls and gates, with the page's key and the SHA-256 of the text it
// hashes (the service pins the presets' keys to them); --presets only that.
//
// Each case records every frame's controls, the state every 30 frames (and
// at the end), each frame where an output was within 1e-9 of flipping, and
// the outcome. --extra N adds N more random cases on all ten presets (not
// for the fixture: write them elsewhere with --out, and run
// `SIM_TRACES=<file> cargo test --release -p vectorvroom-sim --test traces`).
import vm from 'node:vm';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {seededRandom, geometryKey, trackKey} from '../AI-Car-Racer/graphics/state.js';
import {evolveTeacher} from '../tests/helpers/teacher.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const OUT = arg('out', 'tests/fixtures/cloud-brain-sim/traces.json');
const EXTRA = Number(arg('extra', 0));
const FILES = ['utils.js', 'spatialGrid.js', 'network.js', 'controls.js', 'sensor.js', 'driver/profiles.js', 'car.js'];
const sources = await Promise.all(FILES.map(f => readFile(path.join(root, 'AI-Car-Racer', f), 'utf8')));
const presetSource = await readFile(path.join(root, 'AI-Car-Racer/trackPresets.js'), 'utf8');
const presetScope = vm.createContext({window: {}});
vm.runInContext(presetSource.slice(0, presetSource.indexOf('\n];') + 3), presetScope);
const PRESETS = presetScope.window.TRACK_PRESETS;
const W = 3200, H = 1800;

// The presets as a verification sends them, their keys and digests.
const presetRoad = p => ({innerList: p.points, outerList: p.points2, checkPointList: p.checkPointListEditor});
const presetsOut = path.join(root, 'tests/fixtures/cloud-brain-sim/presets.json');
await mkdir(path.dirname(presetsOut), {recursive: true});
await writeFile(presetsOut, JSON.stringify(Object.fromEntries(PRESETS.map(p => [p.name, {
  width: W, height: H, inner: p.points.map(q => [q.x, q.y]), outer: p.points2.map(q => [q.x, q.y]),
  checkpoints: p.checkPointListEditor.map(g => [[g[0].x, g[0].y], [g[1].x, g[1].y]]),
  key: geometryKey(presetRoad(p)), digest: createHash('sha256').update(trackKey(presetRoad(p))).digest('hex'),
}])), null, 1) + '\n');
if (process.argv.includes('--presets')) process.exit(0);

/** The game's scripts in a fresh context, with seeded Math.random. */
function game(seed) {
  const math = Object.create(Math);
  math.random = seededRandom(seed);
  const scope = vm.createContext({Math: math, frameCount: 0, bestCar: null, traction: 0.5, invincible: false, SENSOR_STRIDE: 1, maxSpeed: 15});
  sources.forEach((s, i) => vm.runInContext(s, scope, {filename: FILES[i]}));
  vm.runInContext('globalThis.CarClass=Car;globalThis.GridClass=SpatialGrid;globalThis.NN=NeuralNetwork;', scope);
  return scope;
}

/** road.js's borders and grids, and main.js's start pose. */
function road(scope, preset) {
  const borders = [[{x: 0, y: 0}, {x: 0, y: H}], [{x: W, y: 0}, {x: W, y: H}], [{x: 0, y: 0}, {x: W, y: 0}], [{x: 0, y: H}, {x: W, y: H}]];
  for (const loop of [preset.points, preset.points2]) for (let i = 0; i < loop.length; i++) borders.push([loop[i], loop[(i + 1) % loop.length]]);
  const gates = preset.checkPointListEditor;
  const r = {left: 0, right: W, top: 0, bottom: H, borders, checkPointList: gates, borderGrid: new scope.GridClass(W, H, 200), cpGrid: new scope.GridClass(W, H, 200)};
  r.borderGrid.addSegments(borders); r.cpGrid.addSegments(gates);
  // computeStartInfoInPlace (main.js).
  const g0 = gates[0], mx = (g0[0].x + g0[1].x) / 2, my = (g0[0].y + g0[1].y) / 2;
  let hx, hy;
  if (gates.length >= 2) { const g1 = gates[1]; hx = (g1[0].x + g1[1].x) / 2 - mx; hy = (g1[0].y + g1[1].y) / 2 - my; }
  else { hx = -(g0[1].y - g0[0].y); hy = (g0[1].x - g0[0].x); }
  const heading = Math.atan2(-hx, -hy), len = Math.sqrt(hx * hx + hy * hy), offset = Math.min(20, len * 0.05);
  const start = {x: mx - (len > 0 ? hx / len * offset : 0), y: my - (len > 0 ? hy / len * offset : 0), angle: heading};
  return {road: r, start};
}

function load(car, flat, at = 0) {
  for (const level of car.brain.levels) {
    for (let j = 0; j < level.biases.length; j++) level.biases[j] = flat[at++];
    for (let j = 0; j < level.weights.length; j++) level.weights[j] = flat[at++];
  }
}
function flatten(car) {
  const out = new Float32Array(244); let at = 0;
  for (const level of car.brain.levels) { for (const v of level.biases) out[at++] = v; for (const v of level.weights) out[at++] = v; }
  return out;
}

/** One car alone, as the trial worker runs it; the trace of each frame. */
function trace(scope, preset, flat, {maxSpeed, traction, profile, seconds}) {
  const {road: r, start} = road(scope, preset);
  scope.road = r; scope.traction = traction; scope.maxSpeed = maxSpeed; scope.frameCount = 0;
  const car = new scope.CarClass(start.x, start.y, 30, 50, 'AI', maxSpeed, start.angle);
  car.driverProfile = profile;
  load(car, flat);
  const controls = [], states = [], near = [];
  const gates = r.checkPointList.length, laps = [];
  let crashedAt = null, frames = 0;
  const state = f => ({frame: f, x: car.x, y: car.y, angle: car.angle, speed: car.speed, vx: car.velocity.x, vy: car.velocity.y,
    slide: car.slide, checkpoints: car.checkPointsCount, laps: car.laps});
  for (let f = 1; f <= seconds * 60; f++) {
    scope.frameCount = f;
    const lapsBefore = car.laps;
    car.update(r.borders, r.checkPointList);
    if (car.laps > lapsBefore) laps.push(f);
    const c = car.controls, bits = (c.forward ? 1 : 0) | (c.left ? 2 : 0) | (c.right ? 4 : 0) | (c.reverse ? 8 : 0);
    controls.push(bits.toString(16));
    const margins = Array.from(car.brain.levels[1].preThreshold);
    if (margins.some(m => Math.abs(m) < 1e-9)) near.push({frame: f, margins});
    frames = f;
    if (f % 30 === 0) states.push(state(f));
    if (car.damaged) { crashedAt = f; states.push(state(f)); break; }
  }
  if (!crashedAt && frames % 30) states.push(state(frames));
  return {start, controls: controls.join(''), states, near,
    outcome: {fitness: car.checkPointsCount + car.laps * gates, laps: car.laps, lapFrames: laps, crashedAt, frames}};
}

/** Brains the game's own learning loop evolves on the track
 *  (tests/helpers/teacher.mjs: LearningCoach and buildPopulation, seeded):
 *  briefly, longer, and long on 40 s runs (time for a lap on every track). */
function evolve(preset, seed) {
  return [[12, 24, 20], [40, 24, 20], [80, 32, 40]].map(([generations, population, seconds]) => {
    const t = evolveTeacher({track: preset.name, seed: `${seed}:${generations}`, generations, population, seconds});
    return {vector: t.vector, generation: generations, fitness: t.fitness};
  });
}

const b64 = v => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const SETTINGS = [
  {maxSpeed: 15, traction: 0.5, profile: 'balanced', seconds: 20},
  {maxSpeed: 15, traction: 0.5, profile: 'careful', seconds: 20},
  {maxSpeed: 12, traction: 0.3, profile: 'wild', seconds: 20},
  {maxSpeed: 10, traction: 0.8, profile: 'calm', seconds: 20},
  {maxSpeed: 15, traction: 1, profile: 'reckless', seconds: 20},
  {maxSpeed: 15, traction: 0.5, profile: 'balanced', seconds: 40},
  {maxSpeed: 15, traction: 0.5, profile: 'wild', seconds: 40},
];
const cases = [];
const t0 = Date.now();
for (const name of ['Rectangle', 'Oval', 'Triangle', 'Monza', 'Monaco']) {
  const preset = PRESETS.find(p => p.name === name);
  const random = seededRandom('brains:' + name);
  const brains = [0, 1].map(i => ({vector: Float32Array.from({length: 244}, () => random() * 2 - 1), kind: 'random ' + i}));
  for (const e of evolve(preset, 'evolve:' + name)) brains.push({vector: e.vector, kind: `evolved (generation ${e.generation}, fitness ${e.fitness})`});
  brains.forEach((brain, i) => {
    for (const settings of (i >= 2 ? SETTINGS : SETTINGS.slice(0, 2))) {
      const scope = game('trace');
      cases.push({track: name, brain: brain.kind, settings, vector: b64(brain.vector), ...trace(scope, preset, brain.vector, settings)});
    }
  });
  process.stderr.write(`${name}: ${cases.length} cases, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
}
const extraRandom = seededRandom('extra');
for (let i = 0; i < EXTRA; i++) {
  const preset = PRESETS[Math.floor(extraRandom() * PRESETS.length)];
  const vector = Float32Array.from({length: 244}, () => (extraRandom() * 2 - 1) * (extraRandom() < 0.5 ? 1 : 3));
  const settings = {maxSpeed: 5 + Math.floor(extraRandom() * 21), traction: Math.round(extraRandom() * 100) / 100,
    profile: ['balanced', 'calm', 'careful', 'wild', 'reckless'][Math.floor(extraRandom() * 5)], seconds: 20};
  cases.push({track: preset.name, brain: 'extra ' + i, settings, vector: b64(vector), ...trace(game('trace'), preset, vector, settings)});
}
const tracks = Object.fromEntries([...new Set(cases.map(c => c.track))].map(name => {
  const p = PRESETS.find(q => q.name === name);
  return [name, {width: W, height: H, inner: p.points.map(q => [q.x, q.y]), outer: p.points2.map(q => [q.x, q.y]),
    checkpoints: p.checkPointListEditor.map(g => [[g[0].x, g[0].y], [g[1].x, g[1].y]]),
    // The page's own key for it (the learning context's `track`).
    key: geometryKey({innerList: p.points, outerList: p.points2, checkPointList: p.checkPointListEditor})}];
}));
// Numbers as JSON.stringify writes them (the track key hashes that text):
// coordinates a page may hold, and the edges of the number format.
const nr = seededRandom('numbers');
const numbers = [0, -0, 1, -1, 0.1, 0.1 + 0.2, 1 / 3, 2 / 3, 1e-6, 9.99e-7, 1e-7, 1.5e-7, -2.5e-8, 123456.789, 3199.9999999999995, 1e20, 1e21,
  1.7976931348623157e308, 5e-324, 99999.99999, 0.000001, 1234.5678e-3, 2 ** 53, 2 ** 53 + 2, -1600.25,
  // Ties: two shortest forms equally near, JavaScript takes the even one.
  97.715728759765625, 2.5e-7, 1.0000000000000002,
  ...Array.from({length: 300}, () => Math.fround(nr() * 3200)), ...Array.from({length: 100}, () => Math.fround((nr() - 0.5) * 2e5)),
  ...Array.from({length: 400}, () => (nr() - 0.5) * 2 * 10 ** Math.floor(nr() * 12 - 6)),
  ...Array.from({length: 200}, () => Math.round((nr() * 3200) * 100) / 100),
  ...Array.from({length: 100}, () => nr() * 3200)].map(x => [x, JSON.stringify(x)]);
await mkdir(path.dirname(path.resolve(root, OUT)), {recursive: true});
await writeFile(path.resolve(root, OUT), JSON.stringify({node: process.version, tracks, numbers, cases}) + '\n');
const laps = cases.filter(c => c.outcome.laps > 0).length;
process.stderr.write(`${cases.length} cases (${laps} with a lap) → ${OUT}\n`);
