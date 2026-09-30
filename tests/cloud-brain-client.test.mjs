// The browser's cloud brain client (CB3 of docs/plan/cloud-brain.md):
// cloud/mode.js, cloud/client.js and cloud/session.js against a fake of the
// service (tests/helpers/cloud-brain-fake.mjs), with a fake clock and
// storage; and the per-car origin that tags a clone of your driving.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wire from '../AI-Car-Racer/cloud/wire.js';
import {brainMode, saveBrainMode, consented, STORAGE_KEY} from '../AI-Car-Racer/cloud/mode.js';
import {CloudBrainClient, contributorToken, OUTBOX_KEY, OUTBOX_LIMITS} from '../AI-Car-Racer/cloud/client.js';
import {SharedSession, unit, PULL_EVERY, loadConfig} from '../AI-Car-Racer/cloud/session.js';
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
