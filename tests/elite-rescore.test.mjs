// Elite re-score (issue #61, AI-Car-Racer/eliteRescore.js): off by default and
// then sim-worker.js is unchanged; on, endGen crowns the most robust of the
// top cars, and genEnd carries that car's brain and fitness.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {Simulation} from './helpers/simulation.mjs';
import {loadWorker, closeChannels, plain} from './helpers/workers.mjs';
import {LearningCoach, buildPopulation} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const SOURCE = readFileSync(new URL('../AI-Car-Racer/eliteRescore.js', import.meta.url), 'utf8');
function simulation(track) {
  const sim = new Simulation({track});
  vm.runInContext(SOURCE, sim.scope, {filename: 'eliteRescore.js'});
  return sim;
}
function brains(n, seed) {
  const r = seededRandom(seed), flat = new Float32Array(n * 244);
  for (let i = 0; i < flat.length; i++) flat[i] = r() * 2 - 1;
  return flat;
}
async function liveGeneration({track = 'Rectangle', N = 40, seconds = 2, eliteRescore, collisions, seed = 'rescore'} = {}) {
  const sim = new Simulation({track}), w = loadWorker('sim-worker.js', {random: seededRandom(seed + ':random')});
  try {
    w.send({type: 'init', canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
    w.send({type: 'setSimSpeed', v: 100});
    const flat = brains(N, seed);
    const begin = {type: 'begin', N, seconds, maxSpeed: 15, traction: .5, driverProfile: 'balanced', runSerial: 1,
      startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, brains: flat.slice()};
    if (eliteRescore !== undefined) begin.eliteRescore = eliteRescore;
    if (collisions !== undefined) begin.collisions = collisions;
    w.send(begin);
    const end = await w.waitFor(m => m.type === 'genEnd');
    const snaps = w.posted.filter(m => m.type === 'snapshot');
    return {end, last: snaps.at(-1), flat};
  } finally { closeChannels(); }
}
const outcome = ({end, last}) => { const {simMs, steps, ...snapshot} = last; return plain({end, snapshot}); };

test('config: off unless enabled, fields clamped, mode is mean or min', () => {
  const {EliteRescore: R} = simulation('Rectangle').scope;
  for (const off of [undefined, null, {}, {enabled: false, top: 8}]) assert.equal(R.config(off), null);
  assert.deepEqual(plain(R.config({enabled: true})), plain({...R.DEFAULTS, enabled: true}));
  for (const off of [{enabled: 'false'}, {enabled: 1}, {enabled: 'true'}]) assert.equal(R.config(off), null, 'only enabled: true turns it on');
  const c = R.config({enabled: true, top: 999, poses: -3, radiusPx: 1e6, angleDeg: 'x', mode: 'bogus', pool: 'bogus'});
  assert.deepEqual([c.top, c.poses, c.radiusPx, c.angleDeg, c.mode, c.pool], [32, 0, 60, R.DEFAULTS.angleDeg, 'mean', 'tied']);
  const d = R.config({enabled: true, top: null, poses: null, radiusPx: '', mode: 'min', pool: 'top'});
  assert.deepEqual([d.top, d.poses, d.radiusPx, d.mode, d.pool], [8, 3, 12, 'min', 'top'], 'null and empty fall back to the defaults');
});

test('jittered poses are clear of the walls on Triangle, canonical pose first, misses left out', () => {
  const sim = simulation('Triangle'), R = sim.scope.EliteRescore, polygonAt = sim.scope.CarClass.polygonAt, touches = sim.scope.polysIntersect;
  const start = {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle};
  const {poses, rejected} = R.poses(sim.road, start, {poses: 8, radiusPx: 60, angleDeg: 30, maxAttempts: 4}, seededRandom('tri-poses'));
  assert.deepEqual(plain(poses[0]), plain({x: start.x, y: start.y, angle: start.heading || 0}));
  assert.ok(poses.length >= 1 && poses.length <= 9);
  // Every pose that missed all its attempts left 4 rejections and no pose.
  assert.ok(rejected >= 4 * (9 - poses.length), 'a pose that misses every attempt is dropped, not padded');
  assert.ok(new Set(poses.map(p => p.x + ',' + p.y)).size === poses.length, 'no copies of the canonical pose');
  for (const p of poses) {
    const body = polygonAt(p.x, p.y, p.angle, 30, 50);
    assert.ok(!sim.road.borders.some(b => touches(body, b)), 'pose touches a wall');
  }
});

// A brain that makes progress on Rectangle: a few generations of the plain loop.
let trained = null;
function driver(sim) {
  if (trained) return trained;
  const coach = new LearningCoach(), random = seededRandom('crown-train');
  coach.setContext({profile: 'balanced', track: 'Rectangle', maxSpeed: 15, traction: .5, seconds: 8});
  for (let g = 0; g < 4; g++) {
    sim.begin(buildPopulation({N: 24, incumbent: coach.incumbent, plan: coach.plan(.22, false), random}).flat);
    const r = sim.run(8); coach.record(r, r.vector);
  }
  assert.ok(coach.incumbent.fitness >= 2, 'training found a driver');
  return (trained = coach.incumbent.vector);
}
// Cars 0..8 park (all-zero brains never move); car 9 is the trained driver.
function field(sim) {
  const flat = new Float32Array(10 * 244);
  flat.set(driver(sim), 9 * 244);
  sim.begin(flat);
}
const start = sim => ({x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle});

test('crown, pool top: a runner-up that really drives beats a leader whose canonical score does not repeat', () => {
  const sim = simulation('Rectangle'), R = sim.scope.EliteRescore, gates = sim.road.checkPointList.length;
  field(sim);
  // Pretend the generation ranked the parked car 0 first and the driver last
  // of the top 8 (stale sensors or a lucky start can do this).
  sim.cars.forEach((c, i) => { c.checkPointsCount = i === 0 ? 50 : i === 9 ? 3 : 0; });
  sim.cars.slice(1, 9).forEach((c, i) => { c.checkPointsCount = i < 6 ? 4 : 0; });
  sim.scope.frameCount = 1234;
  for (const mode of ['mean', 'min']) {
    const out = R.crown({cars: sim.cars, road: sim.road, startInfo: start(sim),
      maxSpeed: 15, seconds: 8, config: R.config({enabled: true, mode, pool: 'top'}), random: seededRandom('crown-poses')});
    assert.equal(sim.scope.frameCount, 1234, 'frameCount restored');
    assert.equal(out.ranked.length, 8);
    assert.equal(out.ranked[0].index, 0, 'the plain pick is the parked car');
    assert.ok(out.ranked.some(r => r.index === 9), 'the driver is in the top 8');
    assert.equal(out.index, 9, mode + ': the driver is crowned');
    assert.equal(out.changed, true);
    assert.equal(out.poses, 4, 'canonical + 3 jittered poses');
    const parked = out.ranked.find(r => r.index === 0), driver = out.ranked.find(r => r.index === 9);
    assert.ok(parked.mean < 2 && driver.min > parked.mean, 'driven again, the parked car stays near the start and the driver does not');
  }
  assert.ok(gates > 0);
});

test('crown, pool tied: only cars with the winner\'s progress compete, and a lone leader is not driven again', () => {
  const sim = simulation('Rectangle'), R = sim.scope.EliteRescore;
  field(sim);
  // Car 0 (parked) and car 9 (driver) tie on 5 checkpoints; cars 1..8 have 4.
  sim.cars.forEach((c, i) => { c.checkPointsCount = i === 0 || i === 9 ? 5 : 4; });
  const cfg = R.config({enabled: true});
  assert.equal(cfg.pool, 'tied', 'tied is the default pool');
  const out = R.crown({cars: sim.cars, road: sim.road, startInfo: start(sim), maxSpeed: 15, seconds: 8, config: cfg, random: seededRandom('tied')});
  assert.deepEqual(out.ranked.map(r => r.index), [0, 9], 'only the two tied cars');
  assert.equal(out.index, 9);
  assert.equal(out.changed, true);
  // The crowned car has the plain winner's progress, so genEnd.fitness is unchanged.
  assert.equal(sim.cars[9].checkPointsCount, sim.cars[0].checkPointsCount);
  sim.cars[0].checkPointsCount = 6;
  const lone = R.crown({cars: sim.cars, road: sim.road, startInfo: start(sim), maxSpeed: 15, seconds: 8, config: cfg, random: () => { throw Error('no pose draws'); }});
  assert.deepEqual([lone.index, lone.changed, lone.carFrames, lone.poses], [0, false, 0, 0]);
  // No progress at all: rank leaves style out, the coach does not, so no re-score.
  sim.cars.forEach(c => { c.checkPointsCount = 0; });
  const none = R.crown({cars: sim.cars, road: sim.road, startInfo: start(sim), maxSpeed: 15, seconds: 8, config: cfg, random: () => { throw Error('no pose draws'); }});
  assert.deepEqual([none.index, none.changed, none.carFrames], [0, false, 0]);
});

test('crown, pool tied: a car the coach ranks lower (time tie-break, #60) never competes', () => {
  const sim = simulation('Rectangle'), R = sim.scope.EliteRescore, settings = sim.scope.DriverProfiles.settings;
  field(sim);
  sim.cars.forEach((c, i) => { c.checkPointsCount = i === 0 || i === 9 ? 5 : 4; c.lastGateFrame = 100; });
  sim.cars[9].lastGateFrame = 200;          // same progress, but the driver reached gate 5 later
  settings.timeTieBreak = true;
  try {
    const cfg = R.config({enabled: true}), args = {cars: sim.cars, road: sim.road, startInfo: start(sim), maxSpeed: 15, seconds: 8, config: cfg};
    const later = R.crown({...args, random: () => { throw Error('no pose draws'); }});
    assert.deepEqual([later.index, later.changed, later.ranked.length], [0, false, 1], 'the coach would prefer car 0, so car 9 is out');
    sim.cars[9].lastGateFrame = 100;
    const same = R.crown({...args, random: seededRandom('tied-time')});
    assert.deepEqual(same.ranked.map(r => r.index), [0, 9], 'an exact tie competes');
  } finally { settings.timeTieBreak = false; }
});

test('sim-worker: off (no field, null, enabled:false) gives the same generation and no eliteRescore field', async () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const base = await liveGeneration({track, seed: 'off-' + track});
    assert.equal(base.end.eliteRescore, undefined);
    for (const eliteRescore of [null, {enabled: false, top: 8, mode: 'min'}]) {
      const other = await liveGeneration({track, seed: 'off-' + track, eliteRescore});
      assert.deepEqual(outcome(other), outcome(base), `${track}: ${JSON.stringify(eliteRescore)}`);
    }
  }
});

test('sim-worker: on, genEnd carries the crowned car brain and fitness, frameCount untouched', async () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const off = await liveGeneration({track, N: 60, seconds: 3, seed: 'on-' + track});
    const on = await liveGeneration({track, N: 60, seconds: 3, seed: 'on-' + track, eliteRescore: {enabled: true, mode: 'mean'}});
    const r = on.end.eliteRescore;
    assert.ok(r, track + ': summary present');
    assert.ok(r.ranked.length >= 1 && r.ranked.length <= 8);
    assert.equal(r.mode, 'mean');
    assert.equal(r.pool, 'tied');
    assert.equal(on.end.fitness, off.end.fitness, track + ': the tied pool never lowers fitness');
    assert.ok(r.poses <= 4 && (r.ranked.length > 1) === (r.poses >= 1), "poses drawn only when cars tie");
    const crowned = r.ranked.reduce((b, x) => (x.mean > b.mean + 1e-9 ? x : b), r.ranked[0]);
    assert.equal(r.changed, crowned.index !== r.ranked[0].index);
    assert.deepEqual(Array.from(on.end.bestBrain), Array.from(on.flat.subarray(crowned.index * 244, (crowned.index + 1) * 244)));
    assert.equal(on.end.fitness, Math.floor(crowned.rank + 1e-9), 'fitness is the crowned car\'s own generation progress');
    // Everything about the population is the same as with the re-score off.
    for (const k of ['popCheckpoints', 'popDeathFrames', 'popDeathCauses', 'frameCount', 'popStillAlive'])
      assert.deepEqual(plain(on.end[k]), plain(off.end[k]), `${track}: ${k}`);
    if (!r.changed) assert.deepEqual(Array.from(on.end.bestBrain), Array.from(off.end.bestBrain));
  }
});

test('sim-worker: collision mode skips the re-score', async () => {
  const {end} = await liveGeneration({N: 32, collisions: {heatSize: 8}, eliteRescore: {enabled: true}});
  assert.equal(end.eliteRescore, undefined);
  assert.ok(end.collisions);
});
