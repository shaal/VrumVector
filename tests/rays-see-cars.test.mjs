// Rays see cars (docs/plan/car-collisions.md, task C3). In collision mode a
// car's 7 rays also hit the solid cars of its heat: the nearest hit, wall or
// car, is the reading, and the network still reads 1 - offset. Ghosts,
// parked cars, wrecks, cars of other heats, and the car's own body are never
// hit. All four simulators sense the same way; with collisions off, or with
// the rays' car sight switched off, nothing changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Simulation} from './helpers/simulation.mjs';
import {loadWorker, closeChannels, plain} from './helpers/workers.mjs';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
// The code from before C3 (the C2 simulators): collisions on, rays see walls only.
const C2 = {'sensor.js': fixture('sensor-before-c3.js'), 'driver/profiles.js': fixture('profiles-before-c3.js'), 'collisions.js': fixture('collisions-before-c3.js')};
const SIM_C2 = fixture('sim-worker-before-c3.js');
const ON = {heatSize: 8};
const FLAT = 244;
function brains(n, seed) {
  const r = seededRandom(seed), flat = new Float32Array(n * FLAT);
  for (let i = 0; i < flat.length; i++) flat[i] = r() * 2 - 1;
  return flat;
}

// --- a scene of cars without a track ---------------------------------------------

const base = new Simulation({track: 'Rectangle', seed: 'rays'});
base.scope.road = null;   // no grid: the sensor scans the walls it is given
const C = base.scope.CarCollisions, Car = base.scope.CarClass, getIntersection = base.scope.getIntersection;
const {GONE, GHOST, SOLID} = C.STATUS;
// Car 0 at (0, 0) facing -y (angle 0 drives toward -y); rays fan out +-60
// degrees, ray 3 straight ahead. poses: [x, y, angle] per car.
function scene(poses, options = {}) {
  const cars = poses.map(([x, y, angle = 0, width = 30, height = 50]) => new Car(x, y, width, height, 'AI', 15, angle));
  const state = C.createState(cars.length, {heatSize: cars.length, ...options});
  C.attachRays(cars, state);
  // look(): car i senses; its readings, in an array of this realm.
  return {cars, state, look: (i = 0, walls = []) => { cars[i].sensor.update(walls); return Array.from(cars[i].sensor.readings); }};
}
const ahead = r => r[3];

test('a car ahead is hit where the ray meets its outline; the reading has kind car', () => {
  const {look} = scene([[0, 0], [0, -200]]);
  const r = ahead(look());
  // Car 1's tip (its rear) is at y = -175: 175 px of a 400 px ray.
  assert.deepEqual([r.kind, r.offset, r.x, r.y], ['car', 175 / 400, 0, -175]);
  // The rays beside it miss the narrow car.
  const readings = look();
  assert.deepEqual(readings.map(x => x && x.kind), [null, null, null, 'car', null, null, null]);
  // The network reads 1 - offset, as for a wall.
  const {cars} = scene([[0, 0], [0, -200]]);
  base.scope.frameCount = 1;
  cars[0].updatePerception([], []);
  assert.equal(cars[0].lastInputs[3], Math.fround(1 - 175 / 400));
  assert.equal(cars[0].lastInputs[0], 0);
});

test('out of reach, behind the car, other heats, the car\'s own body: nothing', () => {
  assert.deepEqual(scene([[0, 0], [0, -460]]).look().map(Boolean), Array(7).fill(false), 'beyond the ray length');
  assert.equal(ahead(scene([[0, 0], [0, -424]]).look()).offset, 399 / 400, 'the tip just inside');
  assert.deepEqual(scene([[0, 0], [0, 200]]).look().map(Boolean), Array(7).fill(false), 'behind');
  // Heats of 1: car 1 is in another heat.
  const other = scene([[0, 0], [0, -200]], {heatSize: 1});
  assert.equal(other.state.heats, 2);
  assert.deepEqual(other.look().map(Boolean), Array(7).fill(false));
  // Every ray starts inside the car's own body and never reads it.
  const alone = scene([[0, 0], [5000, 5000]]);
  assert.deepEqual(alone.look().map(Boolean), Array(7).fill(false));
});

test('only solid cars are seen: not ghosts, parked cars, wrecks, or cars with a non-finite pose', () => {
  for (const status of [GHOST, GONE]) {
    const {state, look} = scene([[0, 0], [0, -200]]);
    state.status[1] = status;
    assert.equal(ahead(look()), null, 'status ' + status);
  }
  // Through the contact pass: a car parked for 2 s is not solid, so not seen.
  const {cars, state, look} = scene([[0, 0], [0, -200]]);
  for (let k = 0; k < state.stallFrames; k++) C.resolveContacts(cars, state, null);
  assert.equal(state.status[1], GHOST);
  assert.equal(ahead(look()), null, 'parked');
  // A wreck.
  const wreck = scene([[0, 0], [0, -200]]);
  wreck.cars[1].damaged = true;
  C.resolveContacts(wreck.cars, wreck.state, null);
  assert.equal(ahead(wreck.look()), null, 'wreck');
  // A ghost from the start row, and one released once clear.
  const row = {poses: [{x: 0, y: 0, angle: 0, ghost: false}, {x: 0, y: -200, angle: 0, ghost: true}]};
  const g = C.createState(2, {heatSize: 2}, row), cars2 = [new Car(0, 0, 30, 50, 'AI', 15, 0), new Car(0, -200, 30, 50, 'AI', 15, 0)];
  C.attachRays(cars2, g);
  cars2[0].sensor.update([]);
  assert.equal(ahead(cars2[0].sensor.readings), null, 'ghost at spawn');
  C.resolveContacts(cars2, g, null);
  assert.equal(g.status[1], SOLID);
  cars2[0].sensor.update([]);
  assert.equal(ahead(cars2[0].sensor.readings).kind, 'car', 'released');
  // A car with a non-finite pose is never hit, and never breaks the sensor.
  const odd = scene([[0, 0], [0, -200]]);
  odd.cars[1].x = NaN; odd.cars[1].polygon = Car.polygonAt(NaN, -200, 0, 30, 50);
  assert.equal(ahead(odd.look()), null);
});

test('the nearest hit wins, wall or car; a tie keeps the wall', () => {
  const wall = y => [[{x: -500, y}, {x: 500, y}]];
  let r = ahead(scene([[0, 0], [0, -200]]).look(0, wall(-300)));
  assert.deepEqual([r.kind, r.offset], ['car', 175 / 400], 'the car before the wall');
  r = ahead(scene([[0, 0], [0, -350]]).look(0, wall(-300)));
  assert.deepEqual([r.kind, r.offset], ['wall', 300 / 400], 'the car behind the wall');
  r = ahead(scene([[0, 0], [0, -200]]).look(0, wall(-175)));
  assert.deepEqual([r.kind, r.offset], ['wall', 175 / 400], 'a tie at the car\'s tip keeps the wall');
  // Two cars on one ray: the nearer one, whatever their order.
  for (const poses of [[[0, 0], [0, -300], [0, -120]], [[0, 0], [0, -120], [0, -300]]]) {
    r = ahead(scene(poses).look());
    assert.deepEqual([r.kind, r.offset], ['car', 95 / 400]);
  }
  // Walls still carry kind wall.
  assert.equal(ahead(scene([[0, 0]]).look(0, wall(-100))).kind, 'wall');
});

test('grazing: a corner exactly on a ray is hit, a hair beside it is not; a ray along an edge hits its corner', () => {
  // Car 1 at angle 0 with its base corner at (0, -225), on ray 3's line.
  let r = ahead(scene([[0, 0], [-15, -200]]).look());
  assert.deepEqual([r.kind, r.offset, r.x, r.y], ['car', 225 / 400, 0, -225]);
  r = ahead(scene([[0, 0], [-15 - 1e-9, -200]]).look());
  assert.equal(r, null, 'a hair beside the corner');
  r = ahead(scene([[0, 0], [-15 + 1e-9, -200]]).look());
  assert.equal(r.kind, 'car', 'a hair inside');
  // An outline with one edge along ray 3: the ray hits the corner nearest to it.
  const {cars, look} = scene([[0, 0], [7, -125]]);
  cars[1].polygon = [{x: 0, y: -100}, {x: 0, y: -150}, {x: 20, y: -125}];
  r = ahead(look());
  assert.deepEqual([r.kind, r.offset, r.x, r.y], ['car', 100 / 400, 0, -100]);
});

test('a ray that starts inside another car (a ghost on a solid car) reads the edge where it leaves', () => {
  const {state, look} = scene([[0, 0], [0, 0]]);
  state.status[0] = GHOST;   // the sensing car's own status does not matter
  const r = ahead(look());
  assert.deepEqual([r.kind, r.offset, r.y], ['car', 25 / 400, -25]);
  assert.equal(look().filter(x => x && x.kind === 'car').length, 7, 'every ray leaves through the outline');
});

test('lesion switches: seeCars: false connects no ray; blind hides cars from those cars\' rays only', () => {
  const off = scene([[0, 0], [0, -200]], {seeCars: false});
  assert.equal(off.cars[0].sensor.sight, null, 'no ray is connected');
  assert.equal(ahead(off.look()), null);
  const blind = scene([[0, 0], [0, -200]], {blind: [0]});
  assert.equal(ahead(blind.look()), null, 'car 0 is blind');
  blind.cars[1].angle = Math.PI; blind.cars[1].polygon = Car.polygonAt(0, -200, Math.PI, 30, 50);
  assert.equal(ahead(blind.look(1)).kind, 'car', 'car 1 still sees car 0');
  // config() carries the switches only when set, cleaned and frozen.
  assert.deepEqual({...C.config(ON)}, {heatSize: 8});
  assert.deepEqual({...C.config({heatSize: 8, seeCars: true, blind: []})}, {heatSize: 8});
  const cfg = C.config({heatSize: 8, seeCars: false, blind: [3, 0, 3, -1, 1.5, 'x', 7]});
  assert.deepEqual({...cfg, blind: [...cfg.blind]}, {heatSize: 8, seeCars: false, blind: [0, 3, 7]});
  assert.ok(Object.isFrozen(cfg) && Object.isFrozen(cfg.blind));
  const state = C.createState(4, {blind: [0, 3, 9]});
  assert.deepEqual([...state.blind], [1, 0, 0, 1]);
  assert.equal(state.seeCars, true);
});

// An independent reading: every wall and every solid heat-mate's three edges
// through utils.js getIntersection, nearest first (strictly nearer wins, walls
// first, then cars in heat order).
function oracle(cars, state, i, walls) {
  const car = cars[i], out = [];
  for (const ray of car.sensor.rays) {
    let best = null;
    for (const w of walls) {
      const t = getIntersection(ray[0], ray[1], w[0], w[1]);
      if (t && (!best || t.offset < best.offset)) best = {...t, kind: 'wall'};
    }
    if (state.seeCars && !state.blind[i]) {
      for (let j = i % state.heats; j < cars.length; j += state.heats) {
        if (j === i || state.status[j] !== SOLID) continue;
        const p = cars[j].polygon;
        for (let e = 0; e < 3; e++) {
          const t = getIntersection(ray[0], ray[1], p[e], p[(e + 1) % 3]);
          if (t && (!best || t.offset < best.offset)) best = {...t, kind: 'car'};
        }
      }
    }
    out.push(best);
  }
  return out;
}
const reading = r => (r ? [r.kind, r.offset, r.x, r.y] : null);

test('rays agree with an independent reading on 20 000 random scenes (any car size, any status)', () => {
  const random = seededRandom('ray-oracle');
  const u = (a, b) => a + (b - a) * random();
  let carHits = 0, wallHits = 0, near = 0;
  for (let n = 0; n < 20000; n++) {
    const count = 2 + Math.floor(random() * 8), poses = [];
    for (let k = 0; k < count; k++) {
      // Heat-mates anywhere within 480 px, many near the rays' ends and edges.
      const a = u(0, 2 * Math.PI), d = k === 0 ? 0 : u(0, 480);
      poses.push([d * Math.cos(a), d * Math.sin(a), u(-Math.PI, Math.PI), u(8, 80), u(8, 120)]);
    }
    const heatSize = random() < .8 ? count : 1 + Math.floor(random() * count);
    const {cars, state} = scene(poses, {heatSize});
    for (let k = 0; k < count; k++) state.status[k] = random() < .7 ? SOLID : random() < .5 ? GHOST : GONE;
    const walls = [];
    for (let w = random() * 3; w > 1; w--) walls.push([{x: u(-450, 450), y: u(-450, 450)}, {x: u(-450, 450), y: u(-450, 450)}]);
    const i = Math.floor(random() * count);
    cars[i].sensor.update(walls);
    const got = Array.from(cars[i].sensor.readings, reading), want = oracle(cars, state, i, walls).map(reading);
    assert.deepEqual(got, want, 'scene ' + n);
    for (const r of want) if (r) { if (r[0] === 'car') carHits++; else wallHits++; }
    // Heat-mates whose outline comes within 1 px of a ray's end: the broad phase is tested at its edge.
    for (let k = 0; k < count; k++) if (k !== i && Math.abs(Math.hypot(poses[k][0] - poses[i][0], poses[k][1] - poses[i][1]) - 400) < Math.hypot(poses[k][3], poses[k][4]) / 2) near++;
  }
  assert.ok(carHits > 15000 && wallHits > 15000 && near > 10000, JSON.stringify({carHits, wallHits, near}));
});

test('grazing at random: a corner put on a ray, or a hair beside it, reads as an independent reading does (8 000 scenes)', () => {
  // The bounding-circle and box tests must never drop a hit the edge test
  // would find, however close to a corner or to a ray's end the car sits.
  const random = seededRandom('ray-graze');
  const u = (a, b) => a + (b - a) * random();
  let hits = 0, misses = 0;
  for (let n = 0; n < 8000; n++) {
    const probe = scene([[u(-500, 500), u(-500, 500), u(-Math.PI, Math.PI)]]);
    probe.look();
    const rays = probe.cars[0].sensor.rays, ray = rays[Math.floor(random() * 7)], A = ray[0], B = ray[1];
    // A point on the ray, often right at its end, then a hair to one side.
    const t = random() < .3 ? 1 : random(), len = Math.hypot(B.x - A.x, B.y - A.y);
    const eps = [0, 1e-12, 1e-9, 1e-6, 1e-3][Math.floor(random() * 5)] * (random() < .5 ? -1 : 1);
    const px = A.x + (B.x - A.x) * t - (B.y - A.y) / len * eps, py = A.y + (B.y - A.y) * t + (B.x - A.x) / len * eps;
    const angle = u(-Math.PI, Math.PI), width = u(8, 80), height = u(8, 120), v = Math.floor(random() * 3);
    const shape = Car.polygonAt(0, 0, angle, width, height);
    const {cars, state} = scene([[A.x, A.y, probe.cars[0].angle], [px - shape[v].x, py - shape[v].y, angle, width, height]]);
    cars[0].sensor.update([]);
    const got = Array.from(cars[0].sensor.readings, reading), want = oracle(cars, state, 0, []).map(reading);
    assert.deepEqual(got, want, 'scene ' + n);
    if (want.some(r => r)) hits++; else misses++;
  }
  assert.ok(hits > 2000 && misses > 500, JSON.stringify({hits, misses}));
});

test('near-car statistics: near walls counts walls only; summaries add car statistics only when rays can see cars', () => {
  const P = base.scope.DriverProfiles;
  const {cars, look} = scene([[0, 0], [0, -70]]);   // tip at 45 px: offset .1125
  look();
  P.record(cars[0]);
  assert.deepEqual({...cars[0].drivingStats}, {frames: 1, speed: 0, nearWalls: 0, slides: 0, turnChanges: 0, lastTurn: 0, nearCars: 1, carSight: 1});
  cars[0].sensor.update([[{x: -500, y: -40}, {x: 500, y: -40}]]);   // now a wall nearer than the car
  P.record(cars[0]);
  cars[0].sensor.update([]);
  cars[0].sensor.readings[3] = null;   // nothing
  P.record(cars[0]);
  const s = P.summarize(cars[0]);
  assert.deepEqual([s.nearWallRate, s.nearCarRate, s.carSightRate, s.carContact], [1 / 3, 1 / 3, 1 / 3, false]);
  cars[0].contactCrash = true;
  assert.equal(P.summarize(cars[0]).carContact, true);
  // A car seen far away counts as seen, not near.
  const far = scene([[0, 0], [0, -300]]);
  far.look(); P.record(far.cars[0]);
  assert.deepEqual([far.cars[0].drivingStats.nearCars, far.cars[0].drivingStats.carSight], [0, 1]);
  // "Near" is under .15 of the ray's length (400 px), as for walls: tips at 56 px and 64 px.
  for (const [y, near] of [[-81, 1], [-89, 0]]) {
    const one = scene([[0, 0], [0, y]]);
    assert.equal(ahead(one.look()).kind, 'car');
    P.record(one.cars[0]);
    assert.equal(one.cars[0].drivingStats.nearCars, near, 'offset ' + ahead(one.cars[0].sensor.readings).offset);
  }
  // Without sight (collisions off, or seeCars: false): the old statistics
  // exactly; collision mode without sight adds only carContact.
  const OLD = ['averageSpeed', 'nearWallRate', 'slideRate', 'steeringChanges', 'smoothness', 'aliveSeconds', 'crashed'];
  for (const [c, keys] of [[new Car(0, 0, 30, 50, 'AI', 15, 0), OLD], [scene([[0, 0], [0, -70]], {seeCars: false}).cars[0], [...OLD, 'carContact']]]) {
    c.sensor.update([[{x: -500, y: -40}, {x: 500, y: -40}]]);
    P.record(c);
    assert.deepEqual(Object.keys(c.drivingStats), ['frames', 'speed', 'nearWalls', 'slides', 'turnChanges', 'lastTurn']);
    assert.deepEqual(Object.keys(P.summarize(c)), keys);
    assert.equal(c.drivingStats.nearWalls, 1);
    c.contactCrash = true;
    assert.equal(P.summarize(c).carContact, keys === OLD ? undefined : true);
  }
});

// --- real physics ------------------------------------------------------------------

// A collision-mode run in the Node simulator that checks, at every step, each
// reading of every car that sensed against the independent reading from the
// positions and solid status after the step, and the network's inputs.
function checkedRun(track, {seconds = 4, N = 64, collisions = ON, seed = 'rays-' + track} = {}) {
  const sim = new Simulation({track, seed, collisions});
  sim.begin(brains(N, seed + ':brains'));
  const {state} = sim.collision, cars = sim.cars, b = sim.road.borders, g = sim.road.checkPointList, Csim = sim.scope.CarCollisions;
  let carReadings = 0, checked = 0, hiddenWrecks = 0;
  const trace = [];
  for (let f = 1; f <= seconds * 60; f++) {
    sim.scope.frameCount = f;
    Csim.step(cars, state, b, g);
    for (let i = 0; i < N; i++) {
      if (!state.live[i]) continue;
      const want = oracle(cars, state, i, b), got = cars[i].sensor.readings;
      for (let r = 0; r < 7; r++) {
        assert.deepEqual(reading(got[r]), reading(want[r]), `${track} step ${f} car ${i} ray ${r}`);
        assert.equal(cars[i].lastInputs[r], Math.fround(want[r] ? 1 - want[r].offset : 0), `${track} step ${f} car ${i} input ${r}`);
        if (want[r] && want[r].kind === 'car') carReadings++;
        checked++;
      }
      // A heat-mate crashed by a contact in this very step is already a
      // wreck: count the times a ray would have read it had it been solid.
      for (let j = i % state.heats; j < N; j += state.heats) {
        if (j === i || state.mark[j] !== 1) continue;
        state.status[j] = SOLID;
        if (JSON.stringify(oracle(cars, state, i, b).map(reading)) !== JSON.stringify(want.map(reading))) hiddenWrecks++;
        state.status[j] = GONE;
      }
    }
    trace.push(...cars.flatMap(c => [c.x, c.y, c.angle, +c.damaged, ...c.sensor.readings.map(x => (x ? x.offset : -1))]));
  }
  return {sim, state, trace, carReadings, checked, hiddenWrecks, result: sim.run(0)};
}

test('real physics on Rectangle and Triangle: every reading is the nearest wall or solid heat-mate after the step, and the network reads it', () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const run = checkedRun(track);
    const {stats} = run.state;
    assert.ok(run.carReadings > 500, `${track}: rays read cars ${run.carReadings} times of ${run.checked}`);
    assert.equal(stats.carReadings, run.carReadings, 'the counter matches');
    assert.ok(stats.sensed > 0 && stats.carTests >= stats.carReadings);
    assert.ok(run.hiddenWrecks > 0, `${track}: a car crashed by a contact is not seen in the same step (${run.hiddenWrecks})`);
    assert.ok(run.result.contactDeaths > 0);
    // The elite's summary has the car statistics.
    const d = run.result.driving;
    assert.ok(typeof d.carContact === 'boolean' && d.nearCarRate >= 0 && d.carSightRate >= d.nearCarRate && d.carSightRate <= 1, JSON.stringify(d));
    // Deterministic, and seeing cars changes the driving.
    const again = checkedRun(track);
    assert.deepEqual(again.trace, run.trace, track + ': deterministic');
    assert.deepEqual(plain(again.result), plain(run.result));
    const walls = checkedRun(track, {collisions: {heatSize: 8, seeCars: false}});
    assert.equal(walls.carReadings, 0);
    assert.notDeepEqual(walls.trace, run.trace, track + ': rays that see cars change the driving');
  }
});

test('the lesion: a blind elite reads no car while its heat-mates do; the run is deterministic', () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const run = checkedRun(track, {collisions: {heatSize: 8, blind: [0]}, seconds: 3});
    const seen = checkedRun(track, {seconds: 3});
    assert.ok(run.carReadings > 0);
    const elite = run.sim.cars[0];
    assert.equal(elite.drivingStats.carSight, 0, 'the elite never read a car');
    assert.ok(seen.sim.cars[0].drivingStats.carSight > 0, 'with sight it did');
    assert.deepEqual(checkedRun(track, {collisions: {heatSize: 8, blind: [0]}, seconds: 3}).trace, run.trace);
  }
});

// --- rays blind to cars is C2, exactly ------------------------------------------

const ANY_C3 = new Set(['seeCars', 'sensed', 'carTests', 'carReadings', 'bestReadingKinds', 'carContact']);
// C3 adds carContact to the elite's driving summary in collision mode.
const contactOf = r => { assert.equal(typeof r.driving.carContact, 'boolean', JSON.stringify(r.driving)); return withoutC3(r); };
const withoutC3 = value => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([k]) => !ANY_C3.has(k)).map(([k, v]) => [k, withoutC3(v)])) : value);

test('seeCars: false is the C2 simulator exactly: Node simulator, trial worker, live worker (Rectangle, Triangle)', async () => {
  const BLIND = {heatSize: 8, seeCars: false};
  for (const track of ['Rectangle', 'Triangle']) {
    // Node simulator.
    const flat = brains(48, 'blind-' + track);
    const node = (scripts, collisions) => {
      const sim = new Simulation({track, seed: 'blind', scripts, collisions});
      sim.begin(flat);
      const r = plain(sim.run(4));
      return {r: scripts === C2 ? r : contactOf(r), cars: sim.cars.map(c => [c.x, c.y, c.angle, c.damaged, !!c.contactCrash, c.checkPointsCount, JSON.stringify(c.drivingStats)])};
    };
    const c2 = node(C2, ON);
    assert.ok(c2.r.contactDeaths > 0);
    assert.deepEqual(node({}, BLIND), c2, track + ': Node simulator');
    // Trial worker.
    const sim = new Simulation({track});
    const trial = async (scripts, collisions) => {
      const w = loadWorker('learning/trial-worker.js', {scripts});
      w.scope.road = w.scope.buildRoad({canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
      const run = w.scope.simulator({startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, maxSpeed: 15, seconds: 3, profile: 'balanced', collisions});
      const r = plain(run(brains(40, 'blind-trial-' + track)));
      return scripts === C2 ? r : contactOf(r);
    };
    assert.deepEqual(await trial({}, BLIND), await trial(C2, ON), track + ': trial worker');
    // Live worker (and the A/B baseline, the same file): C2's worker and core.
    const live = async (source, scripts) => {
      const w = loadWorker('sim-worker.js', {source, scripts, random: seededRandom('blind-live')});
      try {
        w.send({type: 'init', canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
        w.send({type: 'setSimSpeed', v: 100});
        w.send({type: 'begin', N: 40, seconds: 2, maxSpeed: 15, traction: .5, driverProfile: 'balanced', runSerial: 1,
          startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, brains: brains(40, 'blind-live-' + track), collisions: BLIND});
        const end = await w.waitFor(m => m.type === 'genEnd');
        const {simMs, steps, ...last} = w.posted.filter(m => m.type === 'snapshot').at(-1);
        return {end: plain(end), last: plain(last)};
      } finally { closeChannels(); }
    };
    const before = await live(SIM_C2, C2), after = await live(null, {});
    assert.ok(after.end.collisions.contactDeaths > 0);
    assert.deepEqual([after.end.collisions.seeCars, after.end.collisions.carReadings, after.end.collisions.sensed], [false, 0, 0]);
    assert.ok(after.last.bestReadingKinds.every(k => k === 0));
    assert.equal(typeof after.end.driving.carContact, 'boolean', JSON.stringify(after.end.driving));
    assert.deepEqual(withoutC3(after), before, track + ': live worker');
  }
});

// --- the four simulators ------------------------------------------------------------

test('the live worker and the Node simulator agree car by car with rays that see cars; snapshots say which rays read a car', async () => {
  for (const track of ['Rectangle', 'Triangle']) {
    const N = 48, seconds = 3, seed = 'rays-agree-' + track, sim = new Simulation({track});
    const w = loadWorker('sim-worker.js', {random: seededRandom(seed + ':random')});
    let end, snaps;
    try {
      w.send({type: 'init', canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
      w.send({type: 'setSimSpeed', v: 2});   // stride 1, as in the Node simulator
      w.send({type: 'begin', N, seconds, maxSpeed: 15, traction: .5, driverProfile: 'balanced', runSerial: 1,
        startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, brains: brains(N, seed), collisions: ON});
      end = await w.waitFor(m => m.type === 'genEnd');
      snaps = w.posted.filter(m => m.type === 'snapshot');
    } finally { closeChannels(); }
    const node = new Simulation({track, collisions: ON});
    node.begin(brains(N, seed));
    const result = node.run(seconds), last = snaps.at(-1);
    node.cars.forEach((c, i) => {
      const p = last.positions;
      assert.deepEqual([p[i * 5], p[i * 5 + 1], p[i * 5 + 2], p[i * 5 + 3]], [Math.fround(c.x), Math.fround(c.y), Math.fround(c.angle), c.damaged ? 1 : 0], `${track} car ${i}`);
    });
    assert.equal(end.fitness, result.fitness);
    assert.deepEqual(plain(end.driving), plain(result.driving), track + ': the elite\'s driving summary');
    assert.ok(node.collision.state.stats.carReadings > 0 && end.collisions.carReadings > 0 && end.collisions.seeCars === true);
    // Snapshots: kinds match the readings (a car only where a ray hit something), and some rays read cars.
    let carRays = 0;
    for (const s of snaps) {
      if (!s.bestReadings) continue;
      assert.equal(s.bestReadingKinds.length, 7);
      for (let r = 0; r < 7; r++) if (s.bestReadingKinds[r]) { carRays++; assert.ok(s.bestReadings[r * 3 + 2] >= 0); }
    }
    assert.ok(carRays > 0, track + ': the best car\'s rays read a car in some snapshot');
  }
});

test('the trial worker\'s simulator and the Node simulator agree with rays that see cars, and with a blind elite', () => {
  for (const track of ['Rectangle', 'Triangle']) {
    for (const collisions of [ON, {heatSize: 8, blind: [0]}]) {
      const sim = new Simulation({track, collisions}), w = loadWorker('learning/trial-worker.js'), flat = brains(40, 'rays-trial-' + track);
      w.scope.road = w.scope.buildRoad({canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
      const worker = w.scope.simulator({startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, maxSpeed: 15, seconds: 3, profile: 'balanced', collisions})(flat);
      sim.begin(flat);
      const node = sim.run(3);
      assert.deepEqual(plain(worker.driving), plain(node.driving), `${track} ${JSON.stringify(collisions)}: driving`);
      for (const key of ['fitness', 'popStillAlive', 'contactDeaths']) assert.equal(worker[key], node[key], `${track}: ${key}`);
      assert.deepEqual(Array.from(worker.vector), Array.from(node.vector), track + ': the same elite');
      assert.ok(sim.collision.state.stats.carReadings > 0);
    }
  }
});

test('collisions off: the four simulators do not connect any ray, and the sensor code reads no car', () => {
  const sim = new Simulation({track: 'Triangle'});
  sim.begin(brains(16, 'off'));
  sim.run(1);
  assert.ok(sim.cars.every(c => c.sensor.sight === null && c.sensor.readings.every(r => !r || r.kind === 'wall')));
  // CarCollisions is only looked up when a ray is connected: main.js loads no core.
  const scope = vm.createContext({Math, frameCount: 0, bestCar: null, traction: .5, invincible: false, SENSOR_STRIDE: 1});
  for (const f of ['utils.js', 'network.js', 'controls.js', 'sensor.js', 'car.js']) vm.runInContext(readFileSync(new URL('../AI-Car-Racer/' + f, import.meta.url), 'utf8'), scope);
  vm.runInContext('const c = new Car(100, 100, 30, 50, "AI", 15, 0); c.update([[{x: 0, y: 50}, {x: 200, y: 50}]], []); globalThis.r = c.sensor.readings.map(x => x && x.kind);', scope);
  assert.ok(scope.r.includes('wall'));
});
