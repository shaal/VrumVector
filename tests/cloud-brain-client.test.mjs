// The browser's cloud brain client (CB3 of docs/plan/cloud-brain.md):
// cloud/mode.js, cloud/client.js and cloud/session.js against a fake of the
// service (tests/helpers/cloud-brain-fake.mjs), with a fake clock and
// storage; the per-car origin that tags a clone of your driving; and (X1)
// verifications of brains that drove a lap, and the leaderboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wire from '../AI-Car-Racer/cloud/wire.js';
import {brainMode, saveBrainMode, consented, STORAGE_KEY} from '../AI-Car-Racer/cloud/mode.js';
import {CloudBrainClient, contributorToken, OUTBOX_KEY, OUTBOX_LIMITS} from '../AI-Car-Racer/cloud/client.js';
import {readFileSync} from 'node:fs';
import {SharedSession, unit, PULL_EVERY, BOARD_MS, loadConfig, pageGeometry, trackKeyOf} from '../AI-Car-Racer/cloud/session.js';
import {describeBoard} from '../AI-Car-Racer/cloud/ui.js';
import {geometryKey} from '../AI-Car-Racer/graphics/state.js';
import {buildPopulation, FLAT_LENGTH} from '../AI-Car-Racer/learning/policy.js';
import {createFakeCloudBrain} from './helpers/cloud-brain-fake.mjs';
import {Simulation} from './helpers/simulation.mjs';
import {loadWorker, closeChannels} from './helpers/workers.mjs';

const {DIMS, LIMITS, encodeF32, brainId} = wire;
const ENDPOINT = 'http://127.0.0.1:8899';
const TOKEN = 'ab'.repeat(16);

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
const sine = (n, seed, scale = 0.8) => Float32Array.from({length: n}, (_, i) => Math.sin(i * 0.37 + seed) * scale);
const context = {profile: 'balanced', track: 'client-test', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'};

function clientFor(fake, {storage = new MemoryStorage(), clock = {t: 1_000_000}, random = () => 0.5} = {}) {
  return new CloudBrainClient({endpoint: ENDPOINT, token: TOKEN, fetch: fake.fetch, storage, now: () => clock.t, random});
}
function wireBrain(seed, extra = {}) {
  return wire.brainToWire({vector: sine(DIMS.brain, seed), fitness: 10 + seed, meta: {generation: seed, source: 'evolved', learning: {context, styleScore: 0.5}}, ...extra});
}

test('the mode: ?brain= wins and is saved, else the saved choice; shared needs a secure context', () => {
  const storage = new MemoryStorage();
  assert.equal(brainMode({search: '', storage, secure: true}), 'local');
  assert.equal(brainMode({search: '?brain=shared', storage, secure: true}), 'shared');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).mode, 'shared');
  assert.equal(brainMode({search: '', storage, secure: true}), 'shared', 'saved');
  assert.equal(brainMode({search: '', storage, secure: false}), 'local', 'not without crypto.subtle');
  assert.equal(brainMode({search: '?brain=local', storage, secure: true}), 'local');
  assert.equal(brainMode({search: '', storage, secure: true}), 'local');
  saveBrainMode('shared', {}, storage);
  assert.equal(brainMode({search: '?brain=nonsense', storage, secure: true}), 'shared');
  // Consent: only the Memory control's yes (or the question a link opens) records it.
  assert.equal(consented(storage), false);
  saveBrainMode('shared', {consent: true}, storage);
  assert.equal(consented(storage), true);
  assert.equal(brainMode({search: '?brain=local', storage, secure: true}), 'local');
  assert.equal(consented(storage), true, 'kept across switches');
  saveBrainMode('shared', {}, storage);
  assert.equal(consented(storage), true);
  storage.setItem(STORAGE_KEY, '{broken');
  assert.equal(brainMode({search: '', storage, secure: true}), 'local');
  assert.equal(brainMode({search: '?brain=shared', storage: null, secure: true}), 'shared', 'no storage: still usable');
});

test('a contributor token is made once, 128 random bits in hex', () => {
  const storage = new MemoryStorage();
  const token = contributorToken(storage);
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(contributorToken(storage), token);
  storage.setItem('vv.cloudBrainToken', 'not a token');
  assert.notEqual(contributorToken(storage), 'not a token');
});

test('with no endpoint the client never makes a request', async () => {
  let calls = 0;
  const client = new CloudBrainClient({endpoint: null, token: TOKEN, fetch: async () => { calls++; throw new Error('no'); }, storage: new MemoryStorage()});
  assert.equal(client.status.state, 'unavailable');
  assert.equal(await client.enqueueBrain({brain: wireBrain(1), track: null}), false);
  assert.equal(await client.enqueueFeedback([{id: 'x'}]), 0);
  assert.equal(await client.flush(), 0);
  assert.equal(await client.recall({trackVec: unit(sine(DIMS.track, 1)), context}), null);
  assert.equal(await client.stats(), null);
  assert.equal(calls, 0);
  // The config: only an https endpoint, or http on localhost.
  const config = body => loadConfig(async () => ({json: async () => body}), 'x');
  assert.deepEqual(await config({endpoint: null}), {endpoint: null});
  assert.deepEqual(await config({endpoint: 'http://evil.example'}), {endpoint: null});
  assert.deepEqual(await config({endpoint: 'https://brain.example/x'}), {endpoint: 'https://brain.example'});
  assert.deepEqual(await config({endpoint: 'http://127.0.0.1:8879'}), {endpoint: 'http://127.0.0.1:8879'});
  assert.deepEqual(await loadConfig(async () => { throw new Error('offline'); }, 'x'), {endpoint: null});
});

test('the outbox survives a reload and is sent, then empty', async () => {
  const fake = createFakeCloudBrain(), storage = new MemoryStorage();
  const track = encodeF32(unit(sine(DIMS.track, 3)));
  const first = clientFor(fake, {storage});
  assert.equal(await first.enqueueBrain({brain: wireBrain(1), track}), true);
  assert.equal(await first.enqueueBrain({brain: wireBrain(1), track}), false, 'the same brain waits once');
  await first.enqueueBrain({brain: wireBrain(2), track: null});
  assert.deepEqual(first.pending(), {brains: 2, feedback: 0});
  // A new page: the same outbox.
  const second = clientFor(fake, {storage});
  assert.deepEqual(second.pending(), {brains: 2, feedback: 0});
  assert.equal(await second.flush(), 2);
  assert.deepEqual(second.pending(), {brains: 0, feedback: 0});
  assert.equal(JSON.parse(storage.getItem(OUTBOX_KEY)).brains.length, 0);
  assert.equal(fake.brains.size, 2);
  assert.equal(second.status.state, 'online');
  // The brain came with its track, and its meta.
  const id = await brainId(sine(DIMS.brain, 1));
  assert.equal(fake.brains.get(id).track, await brainId(wire.decodeF32(track, DIMS.track)));
  assert.equal(fake.brains.get(id).meta.learning.context.track, 'client-test');
});

test('requests are split by the counts and by bytes', async () => {
  const fake = createFakeCloudBrain(), client = clientFor(fake);
  // 40 brains (32 on 4 tracks, then 8 on 6), with the largest meta, and 120
  // feedback rows: full requests pass 64 KB before the counts run out.
  const tracks = Array.from({length: 6}, (_, i) => encodeF32(unit(sine(DIMS.track, 10 + i))));
  const big = {...context, track: 'x'.repeat(180), collisions: 'solid/k8/rays/' + 'a'.repeat(26)};
  const parents = await Promise.all(Array.from({length: 8}, (_, i) => brainId(sine(DIMS.brain, 900 + i))));
  for (let i = 0; i < 40; i++) {
    await client.enqueueBrain({brain: wire.brainToWire({vector: sine(DIMS.brain, 100 + i), fitness: i, dynamicsVec: unit(sine(DIMS.dynamics, i)),
      meta: {generation: i, parentIds: parents, source: 'evolved', learning: {context: big, styleScore: 0.5}}}), track: tracks[i < 32 ? i % 4 : i % 6]});
  }
  const id = await brainId(sine(DIMS.brain, 100));
  await client.enqueueFeedback(Array.from({length: 120}, (_, i) => wire.feedbackToWire({id, context: {...big, track: 'k' + i}, meanFitness: 5, count: 2})));
  await client.flush();
  assert.deepEqual(client.pending(), {brains: 0, feedback: 0});
  assert.equal(fake.brains.size, 40);
  const posts = fake.requests.filter(r => r.path === '/v1/contribute');
  for (const r of posts) {
    const body = JSON.parse(r.body);
    assert.ok(r.bytes <= LIMITS.requestBytes, `${r.bytes} bytes`);
    assert.ok(body.brains.length <= LIMITS.brainsPerRequest && body.tracks.length <= LIMITS.tracksPerRequest && body.feedback.length <= LIMITS.feedbackPerRequest);
  }
  assert.ok(posts.some(r => r.bytes > 50_000), 'some requests were filled close to the byte limit');
  assert.equal(posts.reduce((n, r) => n + JSON.parse(r.body).feedback.length, 0), 120);
});

test('refused items leave the outbox; a refused request too', async () => {
  const fake = createFakeCloudBrain(), client = clientFor(fake);
  const unknown = await brainId(sine(DIMS.brain, 77));
  await client.enqueueFeedback([wire.feedbackToWire({id: unknown, context, meanFitness: 1, count: 1})]);
  await client.enqueueBrain({brain: {...wireBrain(3), fitness: 1e9}, track: null}); // refused by the service as brain-fitness
  await client.flush();
  assert.deepEqual(client.pending(), {brains: 0, feedback: 0}, 'never resent');
  assert.equal(fake.brains.size, 0);
  // A request the service refuses whole (here: a bad token) is dropped too.
  const bad = new CloudBrainClient({endpoint: ENDPOINT, token: 'x', fetch: fake.fetch, storage: new MemoryStorage()});
  await bad.enqueueBrain({brain: wireBrain(4), track: null});
  await bad.flush();
  assert.deepEqual(bad.pending(), {brains: 0, feedback: 0});
  assert.equal(bad.status.lastError, 'token');
});

test('offline: the outbox waits, and retries back off from 1 s to 60 s', async () => {
  const fake = createFakeCloudBrain(), clock = {t: 5_000_000}, client = clientFor(fake, {clock});
  await client.enqueueBrain({brain: wireBrain(1), track: null});
  fake.down = 'offline';
  const delays = [];
  for (let i = 0; i < 9; i++) {
    await client.flush();
    assert.equal(client.status.state, 'offline');
    delays.push(client.retryAt - clock.t);
    const before = fake.requests.length;
    await client.flush();
    assert.equal(fake.requests.length, before, 'no request while backing off');
    assert.equal(await client.recall({trackVec: unit(sine(DIMS.track, 1)), context}), null);
    assert.equal(fake.requests.length, before);
    clock.t = client.retryAt;
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.deepEqual(client.pending(), {brains: 1, feedback: 0}, 'kept');
  fake.down = null;
  await client.flush();
  assert.equal(client.status.state, 'online');
  assert.deepEqual(client.pending(), {brains: 0, feedback: 0});
  // Paused or busy: kept as well.
  for (const [down, state] of [['disabled', 'disabled'], ['busy', 'offline'], ['error', 'offline']]) {
    const c = clientFor(fake, {clock});
    await c.enqueueBrain({brain: wireBrain(9), track: null});
    fake.down = down;
    await c.flush();
    assert.equal(c.status.state, state, down);
    assert.deepEqual(c.pending(), {brains: 1, feedback: 0}, down);
    fake.down = null;
  }
  // Jitter spreads retries: 0.8 to 1.2 of the delay.
  const jittery = clientFor(fake, {clock, random: () => 0});
  fake.down = 'offline';
  await jittery.enqueueBrain({brain: wireBrain(5), track: null});
  await jittery.flush();
  assert.equal(jittery.retryAt - clock.t, 800);
});

test('recall reads the pool; stats read the size', async () => {
  const fake = createFakeCloudBrain(), client = clientFor(fake);
  const track = unit(sine(DIMS.track, 4));
  await fake.seed([0, 1, 2].map(i => ({vector: sine(DIMS.brain, 30 + i), fitness: 5 * i, track, meta: {learning: {context}}})));
  const pool = await client.recall({trackVec: track, context, k: 2});
  assert.equal(pool.length, 2);
  assert.ok(pool[0].vector instanceof Float32Array && pool[0].fitness === 10);
  assert.equal(pool[0].id, await brainId(sine(DIMS.brain, 32)));
  assert.equal(client.status.received, 2);
  assert.deepEqual(await client.stats(), {ok: true, brains: 3, tracks: 1, contributorsToday: 0, contributions24h: 0});
  assert.equal(client.status.brains, 3);
});

test('a session maps local ids to cloud ids, and pulls on a new track and every few generations', async () => {
  const fake = createFakeCloudBrain();
  const client = clientFor(fake);
  const vectors = new Map([['brain_local_a', sine(DIMS.brain, 50)], ['brain_local_b', sine(DIMS.brain, 51)]]);
  const accepted = [];
  const bridge = {
    hooks: null,
    setCloudHooks(h) { this.hooks = h; },
    brainVector: id => vectors.get(id) || null,
    acceptCloudPool: (pool, trackVec, ctx) => { accepted.push({pool, trackVec, ctx}); return pool.length; },
  };
  let trackVec = sine(DIMS.track, 60, 3); // not a unit vector: the session scales it
  let generation = 0;
  const session = new SharedSession({bridge, client, page: {trackVec: () => trackVec, dynamicsVec: () => null, context: () => context, generation: () => generation}, setInterval: null});
  await fake.seed([{vector: sine(DIMS.brain, 70), fitness: 40, track: unit(trackVec)}]);
  await session.start();
  assert.equal(accepted.length, 1, 'a pull on start');
  assert.ok(accepted[0].trackVec === trackVec && accepted[0].pool.length === 1);
  await session.maybePull();
  assert.equal(accepted.length, 1, 'the same track: no pull');
  // A brain the bridge archived: its parents become cloud ids.
  bridge.hooks.onArchive({vector: sine(DIMS.brain, 52), fitness: 12, trackVec, dynamicsVec: sine(DIMS.dynamics, 1, 2),
    meta: {generation: 3, parentIds: ['brain_local_a', 'brain_gone'], learningContext: context, styleScore: 0.4, source: 'demonstration'}});
  bridge.hooks.onFeedback([{id: 'brain_local_b', context, meanFitness: 9, count: 4}, {id: 'brain_gone', context, meanFitness: 1, count: 1}]);
  await session.settled();
  const item = client.outbox.brains[0];
  assert.deepEqual(item.brain.meta.parentIds, [await brainId(vectors.get('brain_local_a'))]);
  assert.equal(item.brain.meta.source, 'demonstration');
  assert.ok(item.brain.dynamics, 'dynamics scaled to a unit vector and kept');
  assert.ok(wire.isUnit(wire.decodeF32(item.track, DIMS.track)));
  assert.deepEqual(client.outbox.feedback.map(r => r.id), [await brainId(vectors.get('brain_local_b'))]);
  // Every PULL_EVERY generations: a pull (new brains or not: a plateau
  // repeats its champion, and needs fresh shared brains the most).
  generation = PULL_EVERY - 1;
  await session.poll();
  assert.equal(accepted.length, 1, 'not yet');
  generation = PULL_EVERY;
  await session.poll();
  assert.equal(accepted.length, 2, 'every few generations');
  await session.poll();
  assert.equal(accepted.length, 2);
  // A new track: a pull.
  trackVec = sine(DIMS.track, 61);
  await session.maybePull();
  assert.equal(accepted.length, 3);
  // No track yet: no pull.
  trackVec = null;
  assert.equal(await session.maybePull({force: true}), 0);
  // A track of zeros: nothing to ask for either (no throw).
  trackVec = new Float32Array(DIMS.track);
  assert.equal(await session.maybePull({force: true}), 0);
  session.stop();
  assert.equal(bridge.hooks, null);
});

test('a car that is an exact copy of your driving keeps that origin', () => {
  const demo = {vector: Float32Array.from({length: FLAT_LENGTH}, (_, i) => Math.sin(i) * 0.5), id: null, kind: 'demonstration'};
  const other = {vector: Float32Array.from({length: FLAT_LENGTH}, (_, i) => Math.cos(i) * 0.5), id: 'brain_x'};
  let r = 1;
  const random = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const batch = buildPopulation({N: 8, seeds: [demo, other], plan: {mutation: 0.3, novel: 0.1, round: 1, stagnant: 0}, random});
  assert.equal(batch.origins[0], 'demonstration', 'the protected elite is the clone');
  assert.ok(batch.flat.subarray(0, FLAT_LENGTH).every((v, i) => v === demo.vector[i]));
  assert.ok(batch.origins.slice(1).every(o => o === null), 'mutations of it are evolved');
  const plain = buildPopulation({N: 4, seeds: [other], plan: {mutation: 0.3, novel: 0.1, round: 1, stagnant: 0}, random});
  assert.ok(plain.origins.every(o => o === null));
});

test('the sim worker reports the elite\'s origin only when it is a clone of your driving', async () => {
  // Four identical cars: the first is the elite (the first of equals).
  const run = async origins => {
    const sim = new Simulation({track: 'Rectangle'}), w = loadWorker('sim-worker.js');
    try {
      w.send({type: 'init', canvasW: 3200, canvasH: 1800, borders: sim.road.borders, checkPointList: sim.road.checkPointList});
      w.send({type: 'setSimSpeed', v: 100});
      const one = Float32Array.from({length: FLAT_LENGTH}, (_, i) => Math.sin(i) * 0.5), brains = new Float32Array(4 * FLAT_LENGTH);
      for (let i = 0; i < 4; i++) brains.set(one, i * FLAT_LENGTH);
      const begin = {type: 'begin', N: 4, seconds: 1, maxSpeed: 15, traction: .5, driverProfile: 'balanced', runSerial: 1,
        startInfo: {x: sim.spawn.x, y: sim.spawn.y, heading: sim.spawn.angle}, brains};
      if (origins) begin.seedOrigins = origins;
      w.send(begin);
      return await w.waitFor(m => m.type === 'genEnd');
    } finally { closeChannels(); }
  };
  assert.equal((await run(['demonstration', null, null, null])).eliteOrigin, 'demonstration');
  assert.equal('eliteOrigin' in (await run(null)), false, 'no origins: the message is as before');
  assert.equal('eliteOrigin' in (await run([null, null, null, 'demonstration'])), false, 'the elite is not the clone');
});

test('a request holds one row per brain and context, and none about a brain still waiting', async () => {
  const fake = createFakeCloudBrain(), client = clientFor(fake);
  // Three generations' feedback about one parent, before a flush.
  const parent = sine(DIMS.brain, 40), id = await brainId(parent);
  await fake.seed([{vector: parent, fitness: 10, track: null}]);
  for (const mean of [12, 14, 16]) await client.enqueueFeedback([wire.feedbackToWire({id, context, meanFitness: mean, count: 3})]);
  await client.flush();
  assert.equal([...fake.brains.get(id).feedback.values()][0].count, 3, 'each counted, none refused as a repeat');
  assert.equal(fake.requests.filter(r => r.path === '/v1/contribute').length, 3);
  // 24 brains, each with a row about itself: rows wait for their brain's request.
  const c2 = clientFor(fake);
  for (let i = 0; i < 24; i++) {
    const v = sine(DIMS.brain, 500 + i);
    await c2.enqueueBrain({id: await brainId(v), brain: wire.brainToWire({vector: v, fitness: i, meta: {}}), track: null});
    await c2.enqueueFeedback([wire.feedbackToWire({id: await brainId(v), context, meanFitness: i + 1, count: 2})]);
  }
  const before = fake.requests.length;
  await c2.flush();
  const answers = fake.requests.slice(before).map(r => JSON.parse(r.body));
  assert.equal(answers.reduce((n, b) => n + b.feedback.length, 0), 24);
  for (let i = 0; i < 24; i++) assert.equal([...fake.brains.get(await brainId(sine(DIMS.brain, 500 + i))).feedback.values()][0].count, 1, `row ${i} counted`);
});

test('tabs share the outbox: neither loses the other\'s items, and nothing is sent twice', async () => {
  const fake = createFakeCloudBrain(), storage = new MemoryStorage();
  let chain = Promise.resolve();
  const lock = (name, fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; }; // one lock for both, as Web Locks
  const tab = () => new CloudBrainClient({endpoint: ENDPOINT, token: TOKEN, fetch: fake.fetch, storage, now: () => 0, lock});
  const a = tab(), b = tab();
  await a.enqueueBrain({brain: wireBrain(1), track: null});
  await b.enqueueBrain({brain: wireBrain(2), track: null});
  assert.equal(JSON.parse(storage.getItem(OUTBOX_KEY)).brains.length, 2, 'both kept');
  const id = await brainId(sine(DIMS.brain, 1));
  await a.enqueueFeedback([wire.feedbackToWire({id, context, meanFitness: 20, count: 2})]);
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(fake.brains.size, 2);
  assert.equal([...fake.brains.get(id).feedback.values()][0].count, 1, 'the row was sent once');
  assert.equal(JSON.parse(storage.getItem(OUTBOX_KEY)).brains.length, 0);
});

test('sending and reading back off apart; a refused recall backs off', async () => {
  const fake = createFakeCloudBrain(), clock = {t: 1_000}, client = clientFor(fake, {clock});
  const track = unit(sine(DIMS.track, 5));
  fake.refuse.contribute = 'rate-limited';
  await client.enqueueBrain({brain: wireBrain(1), track: null});
  await client.flush();
  assert.equal(client.canTry('send'), false);
  assert.ok(await client.recall({trackVec: track, context}), 'reading is not held by a busy queue');
  assert.equal(client.canTry('send'), false, 'and a recall does not end the queue\'s backoff');
  fake.refuse = {recall: 'brain-schema'};
  clock.t += 120_000;
  assert.equal(await client.recall({trackVec: track, context}), null);
  const n = fake.requests.length;
  assert.equal(await client.recall({trackVec: track, context}), null);
  assert.equal(fake.requests.length, n, 'refused: no new request while backing off');
});

test('a full localStorage leaves no stale outbox to send again', async () => {
  const fake = createFakeCloudBrain(), storage = new MemoryStorage();
  const first = clientFor(fake, {storage});
  await first.enqueueBrain({brain: wireBrain(1), track: null});
  // From now on nothing can be written.
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const second = clientFor(fake, {storage});
  await second.flush();
  assert.equal(fake.brains.size, 1);
  assert.equal(storage.getItem(OUTBOX_KEY), null, 'removed rather than left stale');
  const third = clientFor(fake, {storage});
  assert.deepEqual(third.pending(), {brains: 0, feedback: 0});
});

test('a page the service refuses as outdated stops sending and reading until it reloads', async () => {
  const fake = createFakeCloudBrain(), storage = new MemoryStorage(), client = clientFor(fake, {storage});
  const track = unit(sine(DIMS.track, 5));
  // A refused contribution: kept, and nothing more is sent.
  fake.refuse.contribute = 'brain-schema';
  for (let i = 0; i < 20; i++) await client.enqueueBrain({brain: wireBrain(i), track: null});
  await client.flush();
  assert.equal(client.status.state, 'outdated');
  assert.equal(client.pending().brains, 20, 'the outbox is kept for a newer page');
  const n = fake.requests.length;
  assert.equal(await client.recall({trackVec: track, context}), null);
  assert.equal(await client.stats(), null);
  await client.flush();
  assert.equal(fake.requests.length, n, 'no request at all');
  // Reloaded (a newer page): it sends what waited.
  fake.refuse = {};
  const newer = clientFor(fake, {storage});
  await newer.flush();
  assert.deepEqual(newer.pending(), {brains: 0, feedback: 0});
  // A refused recall is outdated too, and a stats answer does not undo it.
  const reader = clientFor(fake);
  fake.refuse = {recall: 'protocol'};
  assert.equal(await reader.recall({trackVec: track, context}), null);
  assert.equal(reader.status.state, 'outdated');
  assert.equal(await reader.stats(), null);
  assert.equal(reader.status.state, 'outdated');
});

test('a network failure does not erase a busy service\'s backoff', async () => {
  const fake = createFakeCloudBrain(), clock = {t: 1_000}, client = clientFor(fake, {clock});
  fake.refuse.contribute = 'rate-limited';
  await client.enqueueBrain({brain: wireBrain(1), track: null});
  for (let i = 0; i < 5; i++) { await client.flush(); clock.t = client.backoff.send.retryAt; }
  await client.flush();
  const busyUntil = client.backoff.send.retryAt;
  fake.down = 'offline';
  await client.stats(); // fails on the network: both channels hold
  fake.down = null;
  clock.t = client.backoff.read.retryAt;
  assert.ok(await client.stats(), 'reading works again');
  assert.equal(client.backoff.send.error, 'rate-limited');
  assert.ok(client.backoff.send.retryAt >= busyUntil && !client.canTry('send'), 'still waiting out the 429');
});

test('the config is read once a try, and retried when it cannot be read', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw new Error('offline'); return {json: async () => ({endpoint: 'https://brain.example'})}; };
  assert.deepEqual(await loadConfig(flaky, 'x', {retries: 2, waitMs: [1]}), {endpoint: 'https://brain.example'});
  assert.equal(calls, 3, 'one fetch a try');
  calls = 0;
  assert.deepEqual(await loadConfig(async () => { calls++; return {json: async () => ({endpoint: null})}; }, 'x', {retries: 2, waitMs: [1]}), {endpoint: null});
  assert.equal(calls, 1, 'a config that says null is not retried');
});

test('a session pulls again on a new learning context, and when the coach\'s count restarts', async () => {
  const fake = createFakeCloudBrain(), client = clientFor(fake);
  const pulls = [];
  const bridge = {setCloudHooks() {}, brainVector: () => null, acceptCloudPool: (pool, t, ctx) => { pulls.push(ctx.profile); return 0; }};
  let ctx = {...context}, generation = 40;
  const trackVec = sine(DIMS.track, 70);
  const session = new SharedSession({bridge, client, page: {trackVec: () => trackVec, dynamicsVec: () => null, context: () => ctx, generation: () => generation}, setInterval: null});
  await session.start();
  assert.deepEqual(pulls, ['balanced']);
  ctx = {...context, profile: 'wild'}; generation = 0; // a new style: the coach counts from 0
  await session.poll();
  assert.deepEqual(pulls, ['balanced', 'wild'], 'a new context pulls');
  generation = PULL_EVERY;
  await session.poll();
  assert.equal(pulls.length, 3, 'and the count goes on from there');
});

// ─── X1: verified laps and the leaderboard ────────────────────────────────
const traces = JSON.parse(readFileSync(new URL('./fixtures/cloud-brain-sim/traces.json', import.meta.url), 'utf8'));
const RECT = traces.tracks.Rectangle;
const rectangle = {width: RECT.width, height: RECT.height, inner: RECT.inner, outer: RECT.outer, checkpoints: RECT.checkpoints};
const lapContext = {...context, track: RECT.key};

test('a verification sends the brain, its track and its context; a refusal waits without holding contributions', async () => {
  const fake = createFakeCloudBrain(), clock = {t: 1_000_000}, client = clientFor(fake, {clock});
  const vector = sine(DIMS.brain, 80);
  await fake.seed([{vector, fitness: 30, track: null}]);
  const r = await client.verify({vector, track: rectangle, context: lapContext});
  assert.deepEqual({ok: r.ok, id: r.id, track: r.track, matched: r.matched, laps: r.laps, lapFrames: r.lapFrames},
    {ok: true, id: await brainId(vector), track: RECT.key, matched: true, laps: 1, lapFrames: [600]});
  const sent = JSON.parse(fake.requests.at(-1).body);
  assert.deepEqual(Object.keys(sent).sort(), ['brainSchema', 'context', 'protocol', 'token', 'track', 'vector']);
  assert.deepEqual(sent.track, rectangle);
  const board = await client.leaderboard({track: RECT.key, maxSpeed: 15, traction: 0.5});
  assert.deepEqual(board.entries.map(e => [e.id, e.lapFrames]), [[r.id, 600]]);
  assert.equal(fake.requests.at(-1).path, '/v1/leaderboard');
  // Another physics: another board.
  assert.deepEqual((await client.leaderboard({track: RECT.key, maxSpeed: 12, traction: 0.5})).entries, []);
  // A brain the service does not hold: a refusal, asked again only by the caller.
  assert.deepEqual(await client.verify({vector: sine(DIMS.brain, 81), track: rectangle, context: lapContext}), {error: 'brain-unknown'});
  // Busy: the next verification waits about a minute; contributions do not.
  fake.refuse.verify = 'rate-limited';
  assert.equal(await client.verify({vector, track: rectangle, context: lapContext}), null);
  fake.refuse.verify = null;
  const asked = fake.requests.length;
  assert.equal(await client.verify({vector, track: rectangle, context: lapContext}), null);
  assert.equal(fake.requests.length, asked, 'waiting: no request');
  assert.ok(client.canTry('send') && client.canTry('read'));
  clock.t += 72_001;
  assert.equal((await client.verify({vector, track: rectangle, context: lapContext})).ok, true);
  // A refusal of this page's version stops everything, as a contribution's does.
  fake.refuse.verify = 'protocol';
  assert.equal(await client.verify({vector, track: rectangle, context: lapContext}), null);
  assert.equal(client.outdated, true);
  assert.equal(await client.leaderboard({track: RECT.key, maxSpeed: 15, traction: 0.5}), null);
});

test('a session verifies a brain that drove a lap once it is sent, the fastest lap first, and reads the leaderboard', async () => {
  const fake = createFakeCloudBrain(), clock = {t: 1_000_000}, client = clientFor(fake, {clock});
  const bridge = {hooks: null, setCloudHooks(h) { this.hooks = h; }, brainVector: () => null, acceptCloudPool: () => 0};
  let ctx = lapContext, geometry = rectangle;
  const boards = [];
  const session = new SharedSession({bridge, client, setInterval: null, page: {trackVec: () => null, dynamicsVec: () => null, context: () => ctx, generation: () => null,
    geometry: () => geometry}});
  session.onBoard = (board, about) => boards.push({ids: board.entries.map(e => e.id), mine: [...about.mine], last: about.last?.id ?? null});
  await session.start();
  await session.settled();
  assert.equal(fake.requests.filter(r => r.path === '/v1/leaderboard').length, 1, 'read on start');
  // Each archive is queued (or not) once its brain is in the outbox.
  const archive = async (seed, meta) => {
    bridge.hooks.onArchive({vector: sine(DIMS.brain, seed), fitness: 20, trackVec: null, meta: {generation: 1, learningContext: lapContext, ...meta}});
    await session.settled();
  };
  // Not verified, each for its one reason: no lap, car collisions, over
  // 120 s, another track, a track the service would refuse.
  for (const [seed, meta, page] of [[90, {fastestLap: undefined}], [91, {learningContext: {...lapContext, collisions: 'on'}}],
    [92, {learningContext: {...lapContext, seconds: 121}}], [93, {learningContext: {...lapContext, track: 'other'}}],
    // (The canvas is not in the key: only the track's own check refuses this one.)
    [94, {}, {...rectangle, width: 3199}]]) {
    geometry = page || rectangle;
    await archive(seed, {fastestLap: 9, ...meta});
    assert.equal(session.verifications.length, 0, `seed ${seed}`);
  }
  geometry = rectangle;
  // The same brain without its defect waits (120 s is allowed).
  await archive(90, {fastestLap: 9, learningContext: {...lapContext, seconds: 120}});
  assert.equal(session.verifications.length, 1);
  session.verifications = [];
  // Five laps: the four fastest wait.
  for (const [seed, lap] of [[95, 14], [96, 11], [97, 13], [98, 16], [99, 12]]) await archive(seed, {fastestLap: lap});
  assert.deepEqual(session.verifications.map(v => v.lap), [11, 12, 13, 14]);
  // Not before its brain is sent.
  assert.equal(await session.verifyNext(), null);
  assert.equal(fake.requests.filter(r => r.path === '/v1/verify').length, 0);
  // A tick: sent, then the fastest verified, and the leaderboard read again.
  const r = await session.tick();
  assert.equal(r.id, await brainId(sine(DIMS.brain, 96)));
  assert.deepEqual(session.verifications.map(v => v.lap), [12, 13, 14]);
  assert.deepEqual(boards.at(-1), {ids: [r.id], mine: [r.id], last: r.id});
  // Archived again: not verified twice.
  archive(96, {fastestLap: 11});
  await session.settled();
  assert.deepEqual(session.verifications.map(v => v.lap), [12, 13, 14]);
  // A brain the service does not hold (evicted, say): three tries, then it goes.
  fake.brains.delete(await brainId(sine(DIMS.brain, 99)));
  for (let i = 0; i < 3; i++) assert.deepEqual(await session.verifyNext(), {error: 'brain-unknown'});
  assert.deepEqual(session.verifications.map(v => v.lap), [13, 14]);
  // One verification at a time.
  const [one, two] = [session.verifyNext(), session.verifyNext()];
  assert.equal(one, two);
  await one;
  assert.deepEqual(session.verifications.map(v => v.lap), [14]);
  session.stop();
});

test('the leaderboard is read when the track or physics change, every minute, and a late answer for an old track is not shown', async () => {
  const fake = createFakeCloudBrain(), clock = {t: 1_000_000}, client = clientFor(fake, {clock});
  let ctx = lapContext;
  const shown = [];
  const session = new SharedSession({bridge: {setCloudHooks() {}}, client, setInterval: null, page: {trackVec: () => null, dynamicsVec: () => null, context: () => ctx, generation: () => null}});
  session.onBoard = board => shown.push(board ? `${board.track}|${board.maxSpeed}` : null);
  const reads = () => fake.requests.filter(r => r.path === '/v1/leaderboard').length;
  await session.refreshBoard();
  await session.refreshBoard();
  assert.equal(reads(), 1, 'the same board within a minute: not read again');
  clock.t += BOARD_MS;
  await session.refreshBoard();
  assert.equal(reads(), 2);
  ctx = {...lapContext, maxSpeed: 12};
  await session.refreshBoard();
  assert.equal(reads(), 3, 'new physics: read at once');
  // A context with no track key yet: nothing asked, and the old board goes.
  ctx = {...lapContext, track: ''};
  assert.equal(await session.refreshBoard({force: true}), null);
  assert.equal(reads(), 3);
  // The track changes while a read is on its way: that board is not shown.
  ctx = lapContext;
  const late = session.refreshBoard({force: true});
  ctx = {...lapContext, maxSpeed: 10};
  const now = session.refreshBoard();
  assert.equal(await late, null);
  await now;
  // A read that answers after a later one (a forced read after a
  // verification) is not shown either.
  const slow = session.refreshBoard({force: true}), fast = session.refreshBoard({force: true});
  assert.equal(await slow, null);
  assert.ok(await fast);
  // Moved on, and the read fails: the old track's board is not left up.
  fake.down = 'offline';
  ctx = {...lapContext, maxSpeed: 11};
  assert.equal(await session.refreshBoard(), null);
  assert.equal(session.board, null);
  fake.down = null;
  clock.t += 120_000;
  // No track, then the same track again within the minute: read again.
  ctx = {...lapContext, maxSpeed: 10};
  await session.refreshBoard();
  ctx = {...lapContext, track: ''};
  await session.refreshBoard();
  ctx = {...lapContext, maxSpeed: 10};
  const before = reads();
  assert.ok(await session.refreshBoard());
  assert.equal(reads(), before + 1);
  // Stopped while a read is on its way: it is not shown; after, nothing is read.
  const inFlight = session.refreshBoard({force: true});
  session.stop();
  assert.equal(await inFlight, null);
  const asked = reads();
  assert.equal(await session.refreshBoard({force: true}), null);
  assert.equal(reads(), asked, 'no read after stop');
  // (null: the line is cleared when the board shown is no longer this page's.)
  assert.deepEqual(shown, [`${RECT.key}|15`, `${RECT.key}|15`, null, `${RECT.key}|12`, null, `${RECT.key}|10`, `${RECT.key}|10`, null,
    `${RECT.key}|10`, null, `${RECT.key}|10`]);
});

test('the page\'s track is main.js\'s road as the service needs it, and the leaderboard line says where your car stands', () => {
  const p = (x, y) => ({x, y});
  const road = {left: 0, top: 0, right: 3200, bottom: 1800, innerList: [p(1, 2), p(3, 4), p(5, 6)], outerList: [p(0, 0), p(9, 0), p(9, 9)], checkPointList: [[p(1, 1), p(2, 2)]]};
  const g = pageGeometry(road);
  assert.deepEqual(g, {width: 3200, height: 1800, inner: [[1, 2], [3, 4], [5, 6]], outer: [[0, 0], [9, 0], [9, 9]], checkpoints: [[[1, 1], [2, 2]]]});
  assert.ok(wire.trackGeometry(g));
  assert.equal(trackKeyOf(g), geometryKey(road), 'the key of what is sent is the page\'s own');
  assert.equal(pageGeometry(null), null);
  assert.equal(pageGeometry({...road, left: 5}), null, 'a road not at the canvas origin');
  assert.equal(wire.trackGeometry(pageGeometry({...road, checkPointList: [[p(1, NaN), p(2, 2)]]})), null);
  const board = {track: RECT.key, entries: ['a', 'b', 'c', 'd'].map((id, i) => ({id, lapFrames: 600 + 60 * i}))};
  assert.equal(describeBoard(board, {mine: new Set(['b'])}), 'Fastest verified laps here: 1. 10.00 s · 2. 11.00 s (yours) · 3. 12.00 s');
  assert.equal(describeBoard(board, {mine: new Set(['d']), last: {track: RECT.key, lapFrames: [780]}}),
    'Fastest verified laps here: 1. 10.00 s · 2. 11.00 s · 3. 12.00 s · yours: 4th · your last car verified: 13.00 s');
  assert.equal(describeBoard({track: RECT.key, entries: []}, {last: {track: RECT.key, lapFrames: []}}),
    'No verified laps on this track yet · your last car did not repeat its lap when the service drove it');
  assert.equal(describeBoard({track: RECT.key, entries: []}, {last: {track: 'elsewhere', lapFrames: []}}), 'No verified laps on this track yet');
});

// ─── X3: race the cloud champion ──────────────────────────────────────────
import vm from 'node:vm';
import {Ghost, chooseChampion, RESPAWN_FRAMES} from '../AI-Car-Racer/cloud/ghost.js';
import {describeChampion} from '../AI-Car-Racer/cloud/ui.js';

/** The game's classic scripts in a vm, as the trial worker runs them, and the Rectangle road. */
function gameScope() {
  const files = ['utils.js', 'spatialGrid.js', 'network.js', 'controls.js', 'sensor.js', 'driver/profiles.js', 'car.js'];
  const scope = vm.createContext({Math, frameCount: 0, bestCar: null, traction: 0.5, invincible: false, SENSOR_STRIDE: 4, maxSpeed: 15});
  for (const f of files) vm.runInContext(readFileSync(new URL(`../AI-Car-Racer/${f}`, import.meta.url), 'utf8'), scope, {filename: f});
  vm.runInContext('globalThis.CarClass=Car;globalThis.GridClass=SpatialGrid;globalThis.NN=NeuralNetwork;', scope);
  const W = 3200, H = 1800, pts = l => l.map(([x, y]) => ({x, y}));
  const inner = pts(RECT.inner), outer = pts(RECT.outer), gates = RECT.checkpoints.map(g => pts(g));
  const borders = [[{x: 0, y: 0}, {x: 0, y: H}], [{x: W, y: 0}, {x: W, y: H}], [{x: 0, y: 0}, {x: W, y: 0}], [{x: 0, y: H}, {x: W, y: H}]];
  for (const loop of [inner, outer]) for (let i = 0; i < loop.length; i++) borders.push([loop[i], loop[(i + 1) % loop.length]]);
  const road = {left: 0, right: W, top: 0, bottom: H, borders, checkPointList: gates, borderGrid: new scope.GridClass(W, H, 200), cpGrid: new scope.GridClass(W, H, 200)};
  road.borderGrid.addSegments(borders); road.cpGrid.addSegments(gates);
  scope.road = road;
  const inflate = flat => {
    const nn = new scope.NN([10, 16, 4]);
    let at = 0;
    for (const level of nn.levels) {
      for (let j = 0; j < level.biases.length; j++) level.biases[j] = flat[at++];
      for (let j = 0; j < level.weights.length; j++) level.weights[j] = flat[at++];
    }
    return nn;
  };
  return {scope, road, inflate};
}
const lapCase = traces.cases.find(c => c.track === 'Rectangle' && c.outcome.laps > 0 && c.settings.seconds === 20 && c.settings.profile === 'balanced');
const lapVector = (() => { const raw = Buffer.from(lapCase.vector, 'base64'); return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); })();

test('the champion is the fastest verified brain the pull brought, else the pool\'s best that learned on this track', () => {
  const entry = (id, track = RECT.key, extra = {}) => ({id, vector: new Float32Array(244), fitness: 1, meta: {learning: {context: {profile: 'wild', track}}}, ...extra});
  const pool = [entry('brain_far', '1-2-3'), entry('brain_a'), entry('brain_b'), entry('brain_c')];
  const board = {track: RECT.key, entries: [{id: 'brain_z', lapFrames: 600, profile: 'calm'}, {id: 'brain_b', lapFrames: 650, profile: 'balanced'}, {id: 'brain_c', lapFrames: 700, profile: 'careful'}]};
  // The fastest the pull brought (brain_z's weights did not come).
  assert.deepEqual(chooseChampion(board, pool, RECT.key), {id: 'brain_b', vector: pool[2].vector, profile: 'balanced', lapFrames: 650, from: 'leaderboard'});
  // No board, or another track's: the pool's best on this track, not the
  // nearer track's brain ranked first.
  assert.deepEqual(chooseChampion(null, pool, RECT.key), {id: 'brain_a', vector: pool[1].vector, profile: 'wild', lapFrames: null, from: 'pool'});
  assert.equal(chooseChampion({...board, track: '1-2-3'}, pool, RECT.key).from, 'pool');
  assert.equal(chooseChampion(null, [entry('brain_far', '1-2-3')], RECT.key), null, 'only other tracks\' brains');
  assert.equal(chooseChampion(board, [], RECT.key), null);
  assert.equal(chooseChampion(board, pool, ''), null, 'no track yet');
  assert.equal(chooseChampion(board, [entry('brain_b', RECT.key, {vector: new Float32Array(3)})], RECT.key), null, 'no brain to drive');
  // One label, pressed or not.
  assert.equal(describeChampion({lapFrames: 998}), 'Race the cloud champion (16.63 s lap)');
  assert.equal(describeChampion({lapFrames: 998}, {wanted: true}), 'Race the cloud champion (16.63 s lap)');
  assert.equal(describeChampion({lapFrames: null}), 'Race the cloud champion');
  assert.equal(describeChampion(null), '');
  assert.equal(describeChampion(null, {wanted: true}), 'Race the cloud champion (waiting for one on this track)');
});

test('the ghost drives the champion\'s run: the game\'s car.js, sensing every frame, your physics, its profile', () => {
  const {scope, road, inflate} = gameScope();
  const start = lapCase.start, gates = road.checkPointList.length;
  let speed = 15;
  const ghost = new Ghost({Car: scope.CarClass, inflate, road: () => road, start: () => ({x: start.x, y: start.y, heading: start.angle}), maxSpeed: () => speed});
  const champion = profile => ({id: 'brain_x', vector: lapVector, profile, lapFrames: null});
  const drive = frames => { for (let f = 1; f <= frames; f++) { scope.frameCount = f * 7; ghost.step(); } return ghost.car.checkPointsCount + ghost.car.laps * gates; };
  assert.equal(ghost.enable(true), false, 'no champion yet: wanted, not racing');
  ghost.setChampion(champion('balanced'));
  assert.equal(ghost.enabled, true, 'racing as soon as one comes');
  // The page's frame counter runs on and its sensor stride is 4: the ghost
  // still senses every frame, as the service's verification did.
  assert.equal(drive(1200), lapCase.outcome.fitness);
  assert.deepEqual(ghost.status().lapFrames, lapCase.outcome.lapFrames);
  // Its profile and your physics: the traced careful run, and calm at 10 and 0.8.
  const traced = (profile, maxSpeed, traction) => traces.cases.find(c => c.vector === lapCase.vector && c.settings.seconds === 20 && c.settings.profile === profile && c.settings.maxSpeed === maxSpeed && c.settings.traction === traction).outcome.fitness;
  ghost.setChampion(null);
  ghost.setChampion(champion('careful'));
  assert.equal(drive(1200), traced('careful', 15, 0.5));
  ghost.setChampion(null);
  speed = 10; scope.traction = 0.8;
  ghost.setChampion(champion('calm'));
  assert.equal(drive(1200), traced('calm', 10, 0.8));
  speed = 15; scope.traction = 0.5;
  ghost.setChampion(null);
  ghost.setChampion(champion('balanced'));
  drive(100);
  // Another champion while racing waits for the next start; the same one
  // (its lap time known now) never restarts it and cancels the wait.
  const frames = ghost.frames;
  ghost.setChampion({id: 'brain_y', vector: new Float32Array(244), profile: 'calm', lapFrames: null});
  ghost.setChampion({...champion('balanced'), lapFrames: 998});
  assert.equal(ghost.frames, frames);
  ghost.reset();
  assert.equal(ghost.champion.id, 'brain_x', 'the wait was cancelled');
  ghost.setChampion({id: 'brain_y', vector: new Float32Array(244), profile: 'calm', lapFrames: null});
  ghost.reset();
  assert.equal(ghost.champion.id, 'brain_y');
  // None for this track: no car, the choice kept; one comes: racing again.
  ghost.setChampion(null);
  assert.equal(ghost.pose(), null);
  ghost.setChampion(champion('balanced'));
  assert.ok(ghost.pose(), 'racing again');
  // Off: no car.
  ghost.enable(false);
  assert.equal(ghost.pose(), null);
  ghost.step();
  assert.equal(ghost.frames, 0);
  // A wreck starts over after RESPAWN_FRAMES (as your car does).
  ghost.enable(true);
  ghost.setChampion({id: 'brain_w', vector: Float32Array.from({length: 244}, (_, i) => (i % 7) - 3), profile: 'reckless', lapFrames: null});
  ghost.reset();
  let crashedAt = null;
  for (let f = 1; f <= 1200 && crashedAt === null; f++) { ghost.step(); if (ghost.car.damaged) crashedAt = ghost.frames; }
  assert.ok(crashedAt, 'this brain crashes');
  for (let f = 0; f < RESPAWN_FRAMES; f++) ghost.step();
  assert.ok(!ghost.car.damaged && ghost.frames <= 1, `back at the start: ${ghost.frames}`);
  // Without sensing every frame, the stride would have made another drive.
  const plain = new scope.CarClass(start.x, start.y, 30, 50, 'AI', 15, start.angle);
  plain.brain = inflate(lapVector);
  const laps = [];
  for (let f = 1; f <= 1200; f++) { scope.frameCount = f * 7; const before = plain.laps; plain.update(road.borders, road.checkPointList); if (plain.laps > before) laps.push(f); }
  assert.notDeepEqual(laps, lapCase.outcome.lapFrames, 'the flag matters');
});

test('a session keeps its last pool and names the champion for its track: from the board when it holds one, cleared on another track', async () => {
  const fake = createFakeCloudBrain(), clock = {t: 1_000_000}, client = clientFor(fake, {clock});
  const other = sine(DIMS.brain, 140, 0.5), elsewhere = sine(DIMS.brain, 143, 0.5);
  const track = unit(sine(DIMS.track, 141));
  await fake.seed([{vector: lapVector, fitness: 6, track, meta: {learning: {context: lapContext}}}, {vector: other, fitness: 9, track, meta: {learning: {context: lapContext}}},
    {vector: elsewhere, fitness: 99, track, meta: {learning: {context: {...lapContext, track: '1-2-3'}}}}]);
  let trackVec = track, ctx = lapContext;
  const champions = [];
  const session = new SharedSession({bridge: {setCloudHooks() {}, acceptCloudPool: p => p.length}, client, setInterval: null,
    page: {trackVec: () => trackVec, dynamicsVec: () => null, context: () => ctx, generation: () => null}});
  session.onChampion = c => champions.push(c && [c.id, c.from, c.lapFrames]);
  await session.maybePull({force: true});
  // The pool's best on this track (the fake ranks by fitness; the 99 learned on another track).
  assert.deepEqual(champions.at(-1), [await brainId(other), 'pool', null]);
  // The lapping brain verified: the board's fastest is the champion, with its lap.
  await client.verify({vector: lapVector, track: rectangle, context: lapContext});
  await session.refreshBoard({force: true});
  assert.deepEqual(champions.at(-1), [await brainId(lapVector), 'leaderboard', 600]);
  // The same brain with its lap time known now: told (the label shows it).
  fake.verified = [];
  await session.refreshBoard({force: true});
  const n = champions.length;
  fake.brains.delete(await brainId(other));
  await session.maybePull({force: true});
  assert.deepEqual(champions.at(-1), [await brainId(lapVector), 'pool', null]);
  await client.verify({vector: lapVector, track: rectangle, context: lapContext});
  await session.refreshBoard({force: true});
  assert.ok(champions.length > n + 1);
  assert.deepEqual(champions.at(-1), [await brainId(lapVector), 'leaderboard', 600], 'same brain, its lap now');
  // Another track: no champion until its pool comes.
  trackVec = unit(sine(DIMS.track, 142));
  fake.down = 'offline';
  await session.maybePull();
  assert.equal(champions.at(-1), null);
});
