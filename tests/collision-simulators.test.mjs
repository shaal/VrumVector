// Car collisions in the four simulators (docs/plan/car-collisions.md, task
// C2): the live worker and the A/B baseline worker (sim-worker.js, one file
// run twice by main.js), the transfer-trial worker (learning/trial-worker.js),
// and the Node simulator (tests/helpers/simulation.mjs). With collisions off,
// each must stay bit-identical to its code before C2; with collisions on, they
// must agree with each other and be deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Simulation} from './helpers/simulation.mjs';
import {loadWorker, closeChannels, plain} from './helpers/workers.mjs';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const store = new Map();
globalThis.localStorage = {getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};
const {runTransferCheck} = await import('../AI-Car-Racer/learning/transferCheck.js');
const {cleanContext} = await import('../AI-Car-Racer/learning/policy.js');
const plainSettings = s => (s ? {heatSize: s.heatSize} : s);

const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const SIM_BEFORE = fixture('sim-worker-before-c2.js'), TRIAL_BEFORE = fixture('trial-worker-before-c2.js');
const ON = {heatSize: 8};
function brains(n, seed) {
  const r = seededRandom(seed), flat = new Float32Array(n * 244);
  for (let i = 0; i < flat.length; i++) flat[i] = r() * 2 - 1;
  return flat;
}

// One generation in sim-worker.js (or its copy from before C2). Returns the
// genEnd message, the last snapshot, and the worker.
async function liveGeneration({source = null, track = 'Rectangle', N = 40, seconds = 2, simSpeed = 100, collisions, jitter, seed = 'live'} = {}) {
  const sim = new Simulation({track}), w = loadWorker('sim-worker.js', {source, random: seededRandom(seed + ':random')});
  try {
    w.send({type: 'init', canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
    w.send({type: 'setSimSpeed', v: simSpeed});
    const begin = {type: 'begin', N, seconds, maxSpeed: 15, traction: .5, driverProfile: 'balanced', runSerial: 1,
      startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, brains: brains(N, seed)};
    if (jitter) begin.poseJitter = jitter;
    if (collisions !== undefined) begin.collisions = collisions;
    w.send(begin);
    const end = await w.waitFor(m => m.type === 'genEnd');
    const snaps = w.posted.filter(m => m.type === 'snapshot');
    return {end, last: snaps.at(-1), first: snaps[0], snaps, worker: w, sim};
  } finally { closeChannels(); }
}
// Everything a generation produced that does not depend on wall-clock time.
const outcome = ({end, last}) => {
  const {simMs, steps, ...snapshot} = last;
  return plain({end, snapshot});
};

test('collisions off: sim-worker.js is bit-identical to the worker before C2 (Rectangle, Triangle)', async () => {
  for (const track of ['Rectangle', 'Triangle']) {
    for (const [label, options] of [['no field', {}], ['null', {collisions: null}], ['enabled: false', {collisions: {enabled: false, heatSize: 8}}],
      ['pose jitter', {collisions: null, jitter: {radiusPx: 400, angleDeg: 30, maxAttempts: 8}}], ['stride 1', {simSpeed: 2, seconds: 1}]]) {
      const before = await liveGeneration({...options, track, source: SIM_BEFORE, seed: 'off-' + track});
      const after = await liveGeneration({...options, track, seed: 'off-' + track});
      assert.deepEqual(outcome(after), outcome(before), `${track}, ${label}`);
      assert.equal(after.end.collisions, undefined, 'no collision summary when off');
      assert.equal(after.last.carFlags, undefined, 'no car flags when off');
      if (label === 'pose jitter') {
        const jitter = m => plain(m.worker.posted.find(p => p.event === 'poseJitter'));
        assert.deepEqual(jitter(after), jitter(before), 'the same jitter draws and wall checks');
        assert.ok(jitter(after).rejected > 0, 'some jittered poses hit a wall');
      }
    }
  }
});

test('collisions on in sim-worker.js: contact deaths are cause 5, snapshots carry heats and flags, the stride is capped, runs repeat', async () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const run = () => liveGeneration({track, N: 64, seconds: 4, collisions: ON, seed: 'on-' + track});
    const first = await run(), again = await run();
    assert.deepEqual(outcome(again), outcome(first), track + ': deterministic');
    const {end, last} = first, causes = Array.from(end.popDeathCauses);
    const contact = causes.filter(c => c === 5).length;
    assert.ok(contact > 0, `${track}: some cars crashed into heat-mates`);
    assert.equal(end.collisions.contactDeaths, contact, 'every contact death is cause 5');
    assert.equal(end.collisions.heatSize, 8);
    assert.equal(end.collisions.heats, 8, '64 cars in heats of 8');
    assert.equal(end.collisions.rowFitted, 8, 'all 8 start slots fit on gate 0');
    // Causes still sum to N, and a contact death has a death record.
    assert.equal(causes.length, 64);
    causes.forEach((c, i) => {
      if (c !== 5) return;
      assert.ok(end.popDeathFrames[i] > 0 && Number.isFinite(end.popDeathXY[2 * i]), `car ${i}: death record`);
    });
    assert.deepEqual(plain(last.collisions), {heatSize: 8, heats: 8});
    assert.equal(last.carFlags.length, 64);
    for (let i = 0; i < 64; i++) {
      const f = last.carFlags[i], damaged = last.positions[i * 5 + 3] === 1;
      assert.equal(!!(f & 4), causes[i] === 5, `car ${i}: contact flag`);
      if (damaged) assert.equal(f & 3, 0, `car ${i}: a wreck is neither solid nor a ghost`);
      else assert.ok((f & 3) === 1 || (f & 3) === 2, `car ${i}: in play`);
    }
    // At spawn every car sits in its start slot: the elite at the start pose.
    const s = first.sim.spawn, p0 = first.first.positions;
    assert.deepEqual([p0[0], p0[1], p0[2]], [Math.fround(s.x), Math.fround(s.y), Math.fround(s.angle || 0)]);
    const starts = new Set();
    for (let i = 0; i < 64; i++) starts.add(p0[i * 5] + ',' + p0[i * 5 + 1]);
    assert.equal(starts.size, 8, 'eight start slots, shared by the heats');
    assert.equal(first.worker.scope.SENSOR_STRIDE, 4, 'at 100x the stride is capped at 4 (16 without collisions)');
  }
  const off = await liveGeneration({N: 8, seconds: 0.1, simSpeed: 100});
  assert.equal(off.worker.scope.SENSOR_STRIDE, 16);
});

test('collisions on: the live worker and the Node simulator agree car by car', async () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const N = 48, seconds = 3, seed = 'agree-' + track;
    // simSpeed 2 keeps the stride at 1, as in the Node simulator.
    const live = await liveGeneration({track, N, seconds, simSpeed: 2, collisions: ON, seed});
    const sim = new Simulation({track, collisions: ON});
    sim.begin(brains(N, seed));
    const result = sim.run(seconds);
    let contact = 0;
    sim.cars.forEach((c, i) => {
      const p = live.last.positions;
      assert.deepEqual([p[i * 5], p[i * 5 + 1], p[i * 5 + 2], p[i * 5 + 3]], [Math.fround(c.x), Math.fround(c.y), Math.fround(c.angle), c.damaged ? 1 : 0], `${track} car ${i}`);
      assert.equal(live.end.popCheckpoints[i], c.checkPointsCount, `${track} car ${i}: checkpoints`);
      assert.equal(live.end.popDeathCauses[i] === 5, !!c.contactCrash, `${track} car ${i}: contact`);
      if (c.contactCrash) contact++;
    });
    assert.ok(contact > 0, track + ': real contacts');
    assert.equal(result.contactDeaths, contact);
    assert.equal(live.end.fitness, result.fitness);
  }
});

// The trial worker, driven through its own onmessage.
async function trial({source = null, collisions, track = 'Rectangle', seed = 'trial'} = {}) {
  const sim = new Simulation({track}), w = loadWorker('learning/trial-worker.js', {source});
  const message = {type: 'trial', id: 1, key: 'collision-trial:' + seed, arm: 'memory', profile: 'balanced', maxSpeed: 15, traction: .5, seconds: 3, exploration: 1,
    track: {canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList,
      startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}},
    context: cleanContext({profile: 'balanced', track: 'collision-trial', maxSpeed: 15, traction: .5, seconds: 3, collisions}),
    seeds: [brains(1, seed + ':seed')], options: {generations: 2, population: 16}};
  if (collisions !== undefined) message.collisions = collisions;
  await w.send(message);
  return (await w.waitFor(m => m.type === 'result' || m.type === 'error')).valueOf();
}

test('collisions off: the trial worker is bit-identical to the one before C2; on, it repeats and differs', async () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const before = await trial({source: TRIAL_BEFORE, track}), after = await trial({track}), nulled = await trial({track, collisions: null});
    assert.equal(after.type, 'result', after.message);
    assert.deepEqual(plain(after), plain(before), track);
    assert.deepEqual(plain(nulled), plain(before), track + ': collisions null');
    const on = await trial({track, collisions: ON}), onAgain = await trial({track, collisions: ON});
    assert.equal(on.type, 'result', on.message);
    assert.deepEqual(plain(onAgain), plain(on), track + ': collision trials repeat');
    assert.notDeepEqual(plain(on), plain(after), track + ': collision mode changes the trial');
  }
});

test('collisions on: the trial worker\'s simulator and the Node simulator agree', async () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const sim = new Simulation({track, collisions: ON}), w = loadWorker('learning/trial-worker.js'), flat = brains(40, 'trial-agree-' + track);
    w.scope.road = w.scope.buildRoad({canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
    const run = w.scope.simulator({startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, maxSpeed: 15, seconds: 3, profile: 'balanced', collisions: ON});
    const worker = run(flat);
    sim.begin(flat);
    const node = sim.run(3);
    assert.ok(node.contactDeaths > 0, track + ': real contacts');
    for (const key of ['fitness', 'popN', 'popStillAlive', 'contactDeaths', 'styleScore']) assert.equal(worker[key], node[key], `${track}: ${key}`);
    assert.deepEqual(Array.from(worker.vector), Array.from(node.vector), track + ': the same elite');
    const gates = sim.road.checkPointList.length;
    assert.equal(worker.meanProgress, sim.cars.reduce((sum, c) => sum + c.checkPointsCount + c.laps * gates, 0) / sim.cars.length);
  }
});

test('the transfer check runs its trials in the context\'s collision mode', async () => {
  const posted = [];
  const spawn = () => {
    const worker = {postMessage(m) { posted.push(m); setTimeout(() => worker.onmessage({data: {type: 'result', id: m.id, arm: m.arm, best: 1, area: 1, lastMean: 0, history: []}}), 0); },
      terminate() {}};
    return worker;
  };
  const context = cleanContext({profile: 'balanced', track: 'transfer-collide', maxSpeed: 15, traction: .5, seconds: 4, collisions: ON});
  assert.equal(context.collisions, 'solid/k8');
  const base = {context, track: {}, profile: 'balanced', maxSpeed: 15, traction: .5, seconds: 4, seeds: [new Float32Array(244).fill(.2)], spawn, trialsPerRun: 1};
  store.clear();
  await runTransferCheck(base);
  assert.deepEqual(posted.map(m => plainSettings(m.collisions)), [ON, ON], 'the mode comes from the context');
  assert.ok(posted.every(m => m.key.includes('solid/k8')), 'the trial key includes the mode');
  posted.length = 0; store.clear();
  await runTransferCheck({...base, context: cleanContext({...context, collisions: 'off'})});
  assert.ok(posted.length === 2 && posted.every(m => !('collisions' in m)), 'normal mode posts no collision field');
  // A mode this build cannot run is refused, never tested as normal driving.
  posted.length = 0; store.clear();
  await assert.rejects(runTransferCheck({...base, context: {...context, collisions: 'solid/k8/rays'}}), /cannot run transfer trials in collision mode solid\/k8\/rays/);
  assert.equal(posted.length, 0);
});

test('collisions off: the Node simulator matches the trial worker\'s simulator from before C2', () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const sim = new Simulation({track}), w = loadWorker('learning/trial-worker.js', {source: TRIAL_BEFORE}), flat = brains(40, 'node-off-' + track);
    w.scope.road = w.scope.buildRoad({canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
    const before = w.scope.simulator({startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, maxSpeed: 15, seconds: 3, profile: 'balanced'})(flat);
    sim.begin(flat);
    const node = sim.run(3), gates = sim.road.checkPointList.length;
    for (const key of ['fitness', 'popN', 'popStillAlive', 'styleScore']) assert.equal(node[key], before[key], `${track}: ${key}`);
    assert.deepEqual(Array.from(node.vector), Array.from(before.vector), track + ': the same elite');
    assert.equal(sim.cars.reduce((sum, c) => sum + c.checkPointsCount + c.laps * gates, 0) / sim.cars.length, before.meanProgress);
  }
});

test('collisions in the Node simulator: deterministic with real contacts; off, null, and enabled: false are the same as before', () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const flat = brains(48, 'node-' + track);
    const run = collisions => { const sim = new Simulation({track, seed: 'node', collisions}); sim.begin(flat); const r = sim.run(4); return {r: plain(r), cars: sim.cars.map(c => [c.x, c.y, c.angle, c.damaged, !!c.contactCrash])}; };
    const on = run(ON);
    assert.deepEqual(run(ON), on, track);
    assert.ok(on.r.contactDeaths > 0, track);
    const off = run(undefined);
    for (const collisions of [null, {enabled: false}, false]) assert.deepEqual(run(collisions), off, `${track}: ${JSON.stringify(collisions)}`);
    assert.equal(off.r.contactDeaths, undefined);
    assert.ok(off.cars.every(c => c[4] === false));
  }
});
