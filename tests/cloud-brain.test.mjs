// The cloud brain service (CB2 and CB4 of docs/plan/cloud-brain.md): the
// built Worker (wasm32-unknown-emscripten) under `wrangler dev` with a
// SQLite Durable Object. The front door (origins, CORS, the breaker, the
// body limit, routes, the per-address rate limits), every CB1 request
// fixture over HTTP, answers read with the browser's own parsers, a
// contribution coming back from a recall, feedback, stats, persistence
// across a restart, quarantine of claims, forget, daily quotas, the token
// never stored, the migration from SQL schema 1, (X1) verified runs, the
// leaderboard and what a costly track takes, and (X2) cloud training, on a
// second Worker with it turned on.
//
//   npm run test:cloud-brain:service      (PORT=8881 by default)
//
// Needs the cloud-brain toolchain (cloud-brain/README.md); wrangler builds
// the Worker first (scripts/build-cloud-brain.sh fetches ruvector once).
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as wire from '../AI-Car-Racer/cloud/wire.js';
import {startDev} from './cloud-brain-dev.mjs';

const {encodeF32, brainId, DIMS, LIMITS} = wire;
const PORT = Number(process.env.PORT) || 8881;
const PAGE = 'http://localhost:8080'; // allowed with ALLOW_LOCAL
const TOKEN = 'ab'.repeat(16), OTHER = 'cd'.repeat(16);
let dev, persist;

before(async () => {
  persist = await mkdtemp(path.join(os.tmpdir(), 'cloud-brain-'));
  dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true'}});
});
after(async () => {
  await dev?.stop();
  if (persist) await rm(persist, {recursive: true, force: true});
});

// Each request comes from its own address (wrangler dev keeps a
// CF-Connecting-IP the client sends; Cloudflare sets it), so only the
// rate-limit test meets the per-address limits.
let requests = 0;
const nextAddress = () => `10.${(++requests >> 16) & 255}.${(requests >> 8) & 255}.${requests & 255}`;
const call = (route, {method = 'GET', body, origin = PAGE, duplex, address = nextAddress()} = {}) => fetch(dev.origin + route, {
  method, body, duplex, signal: AbortSignal.timeout(30_000),
  headers: {...(origin ? {Origin: origin} : {}), 'Content-Type': 'text/plain', 'CF-Connecting-IP': address},
});
const bytes = async res => new Uint8Array(await res.arrayBuffer());
// A test that counts a day waits out the minute around UTC midnight.
const awayFromMidnight = async () => {
  const left = 86_400_000 - Date.now() % 86_400_000;
  if (left < 60_000 || left > 86_400_000 - 5_000) await new Promise(r => setTimeout(r, left + 5_000));
};
const post = (route, body) => call(route, {method: 'POST', body});

const sine = (n, seed, scale = 1) => Float32Array.from({length: n}, (_, i) => Math.sin(i * 0.37 + seed) * scale);
const unit = (n, seed) => { const v = sine(n, seed); const norm = Math.hypot(...v); return v.map(x => x / norm); };
const unit2 = v => { const norm = Math.hypot(...v); return v.map(x => x / norm); };
const context = {profile: 'balanced', track: 'service-test', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'};

test('health answers without an origin', async () => {
  const res = await call('/health', {origin: null});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {ok: true, protocol: 1, brain: true, limits: true, training: false,
    build: {target: 'wasm32-unknown-emscripten', ruvector: '5356a84e2', spike: false}});
});

test('origins, CORS and routes', async () => {
  const recall = wire.recallBody({trackVec: unit(DIMS.track, 1), context});
  for (const origin of [null, 'https://evil.example', 'https://evilvectorvroom.pages.dev', 'https://x.vectorvroom.pages.dev.evil.com',
    'http://localhost:80a', 'http://localhost:']) {
    const res = await call('/v1/recall', {method: 'POST', body: recall, origin});
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  for (const origin of [PAGE, 'http://127.0.0.1:5173', 'https://vectorvroom.pages.dev', 'https://pr-12.vectorvroom.pages.dev', 'https://vv.shaal.dev']) {
    const res = await call('/v1/recall', {method: 'POST', body: recall, origin});
    assert.equal(res.status, 200, origin);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('vary'), 'Origin');
  }
  const preflight = await call('/v1/contribute', {method: 'OPTIONS'});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), PAGE);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  for (const [method, route] of [['GET', '/v1/recall'], ['GET', '/v1/forget'], ['POST', '/v1/stats'], ['GET', '/nope'], ['GET', '/v1/'],
    ['POST', '/health'], ['PUT', '/health'], ['DELETE', '/health'], ['POST', '/spike/sql'], ['GET', '/spike/memory']]) {
    const res = await call(route, {method, body: method === 'GET' ? undefined : '{}', origin: route.startsWith('/v1/') ? PAGE : null});
    assert.equal(res.status, 404, `${method} ${route}`);
  }
  // Only GET /health reaches the object outside /v1/: a large body elsewhere
  // is never read.
  const big = await call('/health', {method: 'POST', body: 'x'.repeat(5_000_000), origin: null});
  assert.equal(big.status, 404);
});

test('bodies over 64 KB are refused before they reach the brain', async () => {
  const big = '{"protocol":1,"pad":"' + 'x'.repeat(LIMITS.requestBytes) + '"}';
  const res = await post('/v1/contribute', big);
  assert.equal(res.status, 413);
  assert.deepEqual(wire.parseErrorResponse(await bytes(res)), {ok: true, error: 'body-too-large'});
  // Without a Content-Length (a stream), the read stops at the limit.
  const chunk = new TextEncoder().encode('x'.repeat(10_000));
  let sent = 0;
  const stream = new ReadableStream({pull(controller) {
    if (sent++ < 8) controller.enqueue(chunk); else controller.close();
  }});
  const streamed = await call('/v1/recall', {method: 'POST', body: stream, duplex: 'half'});
  assert.equal(streamed.status, 413);
  assert.deepEqual(wire.parseErrorResponse(await bytes(streamed)), {ok: true, error: 'body-too-large'});
  // Exactly the limit is read (and refused for what it says, not its size).
  const exact = '{"protocol":1,"pad":"' + 'x'.repeat(LIMITS.requestBytes - 23) + '"}';
  assert.equal(new TextEncoder().encode(exact).length, LIMITS.requestBytes);
  assert.deepEqual(wire.parseErrorResponse(await bytes(await post('/v1/recall', exact))), {ok: true, error: 'brain-schema'});
});

test('every CB1 request fixture gets the answer the wire format says', async () => {
  const root = new URL('./fixtures/cloud-brain/', import.meta.url);
  let checked = 0;
  for (const kind of ['valid', 'invalid']) {
    for (const file of (await readdir(new URL(kind + '/', root))).sort()) {
      const fixture = JSON.parse(await readFile(new URL(`${kind}/${file}`, root), 'utf8'));
      if (!['contribute', 'recall', 'forget', 'verify', 'leaderboard', 'crashes', 'crash-recall'].includes(fixture.route)) continue;
      const body = 'bodyBase64' in fixture ? Buffer.from(fixture.bodyBase64, 'base64') : fixture.body;
      // A leaderboard fixture's body is its query string.
      const res = fixture.route === 'leaderboard' ? await call('/v1/leaderboard?' + body)
        : await post(fixture.route === 'crash-recall' ? '/v1/crashes/recall' : '/v1/' + fixture.route, body);
      const answer = await bytes(res), where = `${kind}/${file}`, expect = fixture.expect;
      checked++;
      if (fixture.route === 'verify' && expect.ok) {
        // The fixtures' brains are not held: the service alone refuses them.
        assert.equal(res.status, 400, where);
        assert.deepEqual(wire.parseErrorResponse(answer), {ok: true, error: 'brain-unknown'}, where);
        continue;
      }
      if (!expect.ok) {
        assert.equal(res.status, expect.status, where);
        assert.deepEqual(wire.parseErrorResponse(answer), {ok: true, error: expect.error}, where);
        continue;
      }
      assert.equal(res.status, 200, where);
      if (fixture.route === 'leaderboard') {
        assert.deepEqual(wire.parseLeaderboardResponse(answer), {...expect, entries: []}, where);
        continue;
      }
      if (fixture.route === 'forget') {
        const forgot = JSON.parse(new TextDecoder().decode(answer));
        assert.deepEqual(Object.keys(forgot).sort(), ['brains', 'crashes', 'feedback', 'protocol'], where);
        assert.ok(forgot.protocol === 1 && [forgot.brains, forgot.feedback, forgot.crashes].every(Number.isInteger), where);
        continue;
      }
      if (fixture.route === 'crashes') {
        assert.deepEqual(wire.parseCrashesResponse(answer), {ok: true, accepted: true}, where);
        continue;
      }
      if (fixture.route === 'crash-recall') {
        assert.equal(wire.parseCrashRecallResponse(answer).ok, true, where);
        continue;
      }
      if (fixture.route === 'recall') {
        const r = await wire.parseRecallResponse(answer);
        assert.equal(r.ok, true, where);
        assert.deepEqual(r.dropped, [], where);
        assert.ok(r.pool.length <= expect.k, where);
        continue;
      }
      const r = wire.parseContributeResponse(answer);
      assert.equal(r.ok, true, where);
      assert.deepEqual(r.accepted, expect.accepted, where);
      assert.deepEqual(r.rejected, expect.rejected, where);
      // Rows about brains the service does not hold, and repeats, are refused
      // by the service alone; every other row is as the parser says.
      const unknown = r.feedbackRejected.filter(x => !expect.feedbackRejected.some(e => e.index === x.index));
      assert.ok(unknown.every(x => wire.SERVICE_ITEM_REASONS.includes(x.reason)), where);
      for (const e of expect.feedbackRejected) assert.ok(r.feedbackRejected.some(x => x.index === e.index && x.reason === e.reason), where);
      assert.equal(r.feedbackAccepted + unknown.length, expect.feedbackAccepted, where);
    }
  }
  assert.ok(checked >= 160, `${checked} fixtures`);
});

// The brains this file contributes, on a track no fixture uses.
const TRACK = unit(DIMS.track, 42);
const OURS = [0, 1, 2].map(i => ({vector: sine(DIMS.brain, 100 + i, 0.8), fitness: 30 + 10 * i}));

test('a contribution comes back from a recall, bit for bit', async () => {
  const dynamics = unit(DIMS.dynamics, 7);
  const brains = OURS.map((b, i) => wire.brainToWire({vector: b.vector, fitness: b.fitness, track: 0, dynamicsVec: i === 0 ? dynamics : null,
    meta: {generation: 5 + i, parentIds: [], source: i === 2 ? 'demonstration' : 'evolved', learning: {context, styleScore: 0.25 * i}}}));
  const res = await post('/v1/contribute', wire.contributeBody({token: TOKEN, tracks: [TRACK], brains}));
  assert.equal(res.status, 200);
  const ids = await Promise.all(OURS.map(b => brainId(b.vector)));
  assert.deepEqual(wire.parseContributeResponse(await bytes(res)), {ok: true, accepted: ids, rejected: [], feedbackAccepted: 0, feedbackRejected: []});
  const recall = await wire.parseRecallResponse(await bytes(await post('/v1/recall', wire.recallBody({trackVec: TRACK, context, k: 3}))));
  assert.equal(recall.ok, true);
  assert.deepEqual(recall.dropped, []);
  // Same track and context, and each served with a trusted fitness of 0:
  // they tie, in id order.
  assert.deepEqual(recall.pool.map(p => p.id), ids.slice().sort());
  for (const entry of recall.pool) {
    const mine = OURS[ids.indexOf(entry.id)];
    assert.ok(entry.vector.every((v, i) => Object.is(v, mine.vector[i])), 'bit for bit');
    // Nobody else has bred from them: served as fitness 0, not their claim (CB4).
    assert.equal(entry.fitness, 0);
    assert.ok(entry.score > 0 && entry.score <= 1.3 * 1.3);
    assert.equal(entry.meta.learning.context.track, 'service-test');
  }
  assert.equal(recall.pool.find(p => p.id === ids[2]).meta.source, 'demonstration');
  // Contributing it again changes nothing (idempotent).
  const again = await post('/v1/contribute', wire.contributeBody({token: OTHER, tracks: [TRACK], brains}));
  assert.deepEqual(wire.parseContributeResponse(await bytes(again)).accepted, ids);
});

test('offspring feedback from another contributor reaches the pool', async () => {
  const id = await brainId(OURS[0].vector);
  const unknown = await brainId(sine(DIMS.brain, 999, 0.5));
  const res = await post('/v1/contribute', wire.contributeBody({token: OTHER, feedback: [
    wire.feedbackToWire({id, context, meanFitness: 45, count: 12}),
    wire.feedbackToWire({id: unknown, context, meanFitness: 1, count: 1}),
    wire.feedbackToWire({id, context, meanFitness: 90, count: 12}),
  ]}));
  assert.deepEqual(wire.parseContributeResponse(await bytes(res)), {ok: true, accepted: [], rejected: [], feedbackAccepted: 1,
    feedbackRejected: [{index: 1, reason: 'feedback-unknown'}, {index: 2, reason: 'feedback-duplicate'}]});
  const recall = await wire.parseRecallResponse(await bytes(await post('/v1/recall', wire.recallBody({trackVec: TRACK, context, k: 3}))));
  const entry = recall.pool.find(p => p.id === id);
  // Its own context: (45 − 30) / 30, OTHER's first value (in steps of 1/32 767).
  assert.ok(Math.abs(entry.feedback.weight - 0.5) < 1e-4, JSON.stringify(entry.feedback));
  assert.deepEqual([entry.feedback.count, entry.feedback.contributors], [1, 1]);
  // One other contributor: still quarantined, but its weight lifts it.
  assert.equal(entry.fitness, 0);
  assert.equal(recall.pool[0].id, id);
});

test('stats count what was contributed', async () => {
  const stats = wire.parseStatsResponse(await bytes(await call('/v1/stats')));
  assert.equal(stats.ok, true);
  assert.ok(stats.brains >= 3 && stats.tracks >= 1, JSON.stringify(stats));
  assert.ok(stats.contributorsToday >= 3, JSON.stringify(stats)); // the fixtures' token, TOKEN, OTHER
  assert.ok(stats.contributions24h >= 3);
});

test('a forged fitness is served as 0 until two others corroborate it, then as what its offspring showed', async () => {
  const FORGER = 'ef'.repeat(16), track = unit(DIMS.track, 43), forged = sine(DIMS.brain, 500, 0.7);
  const ctx = {...context, track: 'forged-test'};
  const brains = [wire.brainToWire({vector: forged, fitness: 1e6, track: 0, meta: {generation: 1, source: 'evolved', learning: {context: ctx, styleScore: 0}}})];
  assert.equal((await post('/v1/contribute', wire.contributeBody({token: FORGER, tracks: [track], brains}))).status, 200);
  const id = await brainId(forged);
  const entry = async () => (await wire.parseRecallResponse(await bytes(await post('/v1/recall', wire.recallBody({trackVec: track, context: ctx, k: 5}))))).pool.find(p => p.id === id);
  assert.equal((await entry()).fitness, 0, 'its claim is not served');
  // Its contributor praising it: accepted, and not evidence.
  const praise = wire.contributeBody({token: FORGER, feedback: [wire.feedbackToWire({id, context: ctx, meanFitness: 1e6, count: 50})]});
  assert.equal(wire.parseContributeResponse(await bytes(await post('/v1/contribute', praise))).feedbackAccepted, 1);
  assert.deepEqual((await entry()).feedback, {weight: 0, count: 0, contributors: 0});
  // Offspring from two others, 50 each: after the second it is worth 50.
  for (const [i, token] of ['a1'.repeat(16), 'a2'.repeat(16)].entries()) {
    const rows = [wire.feedbackToWire({id, context: ctx, meanFitness: 50, count: 8})];
    assert.equal(wire.parseContributeResponse(await bytes(await post('/v1/contribute', wire.contributeBody({token, feedback: rows})))).feedbackAccepted, 1);
    const e = await entry();
    assert.equal(e.fitness, i === 0 ? 0 : 50, JSON.stringify(e));
    assert.equal(e.feedback.contributors, i + 1);
  }
});

test('forget deletes a contributor\'s brains and takes their feedback out', async () => {
  const LEAVER = 'be'.repeat(16), track = unit(DIMS.track, 44), mine = sine(DIMS.brain, 600, 0.6);
  const brains = [wire.brainToWire({vector: mine, fitness: 20, track: 0, meta: {learning: {context, styleScore: 0}}})];
  await post('/v1/contribute', wire.contributeBody({token: LEAVER, tracks: [track], brains}));
  const [id, theirs] = [await brainId(mine), await brainId(OURS[1].vector)];
  const rows = [wire.feedbackToWire({id: theirs, context, meanFitness: 44, count: 3})];
  assert.equal(wire.parseContributeResponse(await bytes(await post('/v1/contribute', wire.contributeBody({token: LEAVER, feedback: rows})))).feedbackAccepted, 1);
  const pool = async trackVec => (await wire.parseRecallResponse(await bytes(await post('/v1/recall', wire.recallBody({trackVec, context, k: 64}))))).pool;
  assert.ok((await pool(track)).some(p => p.id === id));
  assert.equal((await pool(TRACK)).find(p => p.id === theirs).feedback.contributors, 1);
  const res = await post('/v1/forget', wire.forgetBody({token: LEAVER}));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), PAGE);
  assert.deepEqual(await res.json(), {protocol: 1, brains: 1, feedback: 1, crashes: 0});
  assert.ok(!(await pool(track)).some(p => p.id === id), 'the brain is gone');
  assert.deepEqual((await pool(TRACK)).find(p => p.id === theirs).feedback, {weight: 0, count: 0, contributors: 0}, 'and the feedback');
  assert.deepEqual(await (await post('/v1/forget', wire.forgetBody({token: LEAVER}))).json(), {protocol: 1, brains: 0, feedback: 0, crashes: 0});
});

test('an address past its limits gets 429 rate-limited, with CORS and Retry-After', async () => {
  // Local windows are whole minutes of the clock: start early in one.
  const into = Date.now() % 60_000;
  if (into > 45_000) await new Promise(r => setTimeout(r, 60_000 - into + 200));
  const address = '192.0.2.7';
  const write = body => call('/v1/contribute', {method: 'POST', body, address});
  const statuses = [];
  for (let i = 0; i < 23; i++) statuses.push((await write(wire.contributeBody({token: TOKEN}))).status);
  // A crash map is a write too (X4): 3 browsers' 6 contributions and 1 crash map a minute fit.
  const map = new Float32Array(wire.CRASH_DIM);
  map[3] = 1;
  statuses.push((await call('/v1/crashes', {method: 'POST', body: wire.crashesBody({token: TOKEN, track: unit(DIMS.track, 81), map, deaths: 4}), address})).status);
  assert.deepEqual(statuses, Array(24).fill(200));
  // The 25th write in the minute is refused before it reaches the object.
  const res = await write(wire.contributeBody({token: TOKEN}));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
  assert.equal(res.headers.get('access-control-allow-origin'), PAGE);
  assert.match(res.headers.get('access-control-expose-headers') || '', /Retry-After/i, 'the page can read it');
  assert.deepEqual(wire.parseErrorResponse(await bytes(res)), {ok: true, error: 'rate-limited'});
  assert.equal((await write('not even json')).status, 429, 'refused before the body is read');
  // Forgets are counted apart: 3 a minute (one can read every record).
  const forgets = [];
  for (let i = 0; i < 4; i++) forgets.push((await call('/v1/forget', {method: 'POST', body: wire.forgetBody({token: 'cc'.repeat(16)}), address})).status);
  assert.deepEqual(forgets, [200, 200, 200, 429]);
  // Reads are counted apart: 60 a minute.
  const reads = [];
  for (let i = 0; i < 61; i++) reads.push((await call('/v1/stats', {address})).status);
  assert.deepEqual(reads, [...Array(60).fill(200), 429]);
  assert.equal((await call('/health', {origin: null, address})).status, 429, 'health reaches the object: a read');
  // Another address is not affected.
  assert.equal((await call('/v1/contribute', {method: 'POST', body: wire.contributeBody({token: TOKEN})})).status, 200);
  // IPv6 is counted by its /64: one host cannot rotate past the limit.
  const v6 = [];
  for (let i = 1; i <= 25; i++) v6.push((await call('/v1/contribute', {method: 'POST', body: wire.contributeBody({token: TOKEN}), address: `2001:db8:7:9::${i.toString(16)}`})).status);
  assert.deepEqual(v6, [...Array(24).fill(200), 429]);
  assert.equal((await call('/v1/contribute', {method: 'POST', body: wire.contributeBody({token: TOKEN}), address: '2001:db8:7:a::1'})).status, 200, 'another /64');
});

test('a verified run is the brain\'s fitness, and the leaderboard lists its first lap', async () => {
  // A brain the game's own learning loop evolved on Rectangle, and what the
  // game's scripts made of it (tests/fixtures/cloud-brain-sim/traces.json).
  const traces = JSON.parse(await readFile(new URL('./fixtures/cloud-brain-sim/traces.json', import.meta.url), 'utf8'));
  const c = traces.cases.find(x => x.track === 'Rectangle' && x.outcome.laps > 0 && x.settings.seconds === 20);
  const t = traces.tracks.Rectangle;
  const raw = Buffer.from(c.vector, 'base64'), vector = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const ctx = {profile: c.settings.profile, track: t.key, maxSpeed: c.settings.maxSpeed, traction: c.settings.traction, seconds: 20, collisions: 'off'};
  const OWNER = '0a'.repeat(16), id = await brainId(vector), track = unit(DIMS.track, 45);
  await post('/v1/contribute', wire.contributeBody({token: OWNER, tracks: [track],
    brains: [wire.brainToWire({vector, fitness: 1e6, track: 0, meta: {learning: {context: ctx, styleScore: 0}}})]}));
  const served = async () => (await wire.parseRecallResponse(await bytes(await post('/v1/recall', wire.recallBody({trackVec: track, context: ctx, k: 5}))))).pool.find(p => p.id === id).fitness;
  assert.equal(await served(), 0, 'a claim of 1e6, quarantined');
  const geometry = {width: t.width, height: t.height, inner: t.inner, outer: t.outer, checkpoints: t.checkpoints};
  const started = performance.now();
  const res = await post('/v1/verify', wire.verifyBody({token: TOKEN, vector, track: geometry, context: ctx, start: {x: c.start.x, y: c.start.y, heading: c.start.angle}}));
  console.log(`# a verification of ${c.outcome.frames} frames: ${(performance.now() - started).toFixed(0)} ms`);
  assert.equal(res.status, 200);
  const v = wire.parseVerifyResponse(await bytes(res));
  assert.deepEqual(v, {ok: true, id, track: t.key, matched: true, fitness: c.outcome.fitness, laps: c.outcome.laps, lapFrames: c.outcome.lapFrames,
    crashedAt: c.outcome.crashedAt, frames: c.outcome.frames}, 'the service drove it as the browser did');
  assert.equal(await served(), c.outcome.fitness, 'its fitness is the service\'s run');
  const board = wire.parseLeaderboardResponse(await bytes(await call('/v1/leaderboard?' + wire.boardQuery({track: t.key, maxSpeed: ctx.maxSpeed, traction: ctx.traction}))));
  assert.equal(board.ok, true);
  assert.deepEqual(board.entries.map(e => [e.id, e.lapFrames, e.profile]), [[id, c.outcome.lapFrames[0], ctx.profile]]);
  // A brain the service does not hold: refused.
  const stranger = await post('/v1/verify', wire.verifyBody({token: TOKEN, vector: sine(DIMS.brain, 77, 0.5), track: geometry, context: ctx}));
  assert.equal(stranger.status, 400);
  assert.deepEqual(wire.parseErrorResponse(await bytes(stranger)), {ok: true, error: 'brain-unknown'});
  // Six verifications a minute from one address.
  const address = '198.51.100.9', statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await call('/v1/verify', {method: 'POST', address, body: wire.verifyBody({token: TOKEN, vector, track: geometry, context: ctx})})).status);
  assert.deepEqual(statuses.slice(0, 6), Array(6).fill(200));
  assert.equal(statuses[6], 429);
});

test('the leaderboard orders the stored runs by first lap, fitness and age, a brain once', async () => {
  // Runs written into the object's SQLite (as many verifications would),
  // read after a restart: the order is SQL's.
  const {DatabaseSync} = await import('node:sqlite');
  const KEY = '1a2b-3c4d-99', ctx = {...context, track: KEY};
  const vectors = [0, 1, 2, 3, 4].map(i => sine(DIMS.brain, 300 + i, 0.5));
  const ids = await Promise.all(vectors.map(v => brainId(v)));
  await post('/v1/contribute', wire.contributeBody({token: OTHER, brains: vectors.map(vector => wire.brainToWire({vector, fitness: 1, meta: {learning: {context: ctx, styleScore: 0}}}))}));
  await dev.stop();
  const dir = path.join(persist, 'v3/do/vectorvroom-brain-SharedBrain');
  const db = new DatabaseSync(path.join(dir, (await readdir(dir)).find(f => f.endsWith('.sqlite') && !f.startsWith('metadata'))));
  const put = db.prepare(`INSERT INTO verified (brain, track, profile, max_speed, traction, seconds, fitness, laps, lap_frames, frames, contributor, created)
    VALUES (?, ?, ?, 15, 0.5, 30, ?, ?, ?, 1800, '', ?)`);
  for (const [i, profile, lap, fitness, created] of [[0, 'balanced', 900, 6, 1], [1, 'balanced', 800, 5, 2], [2, 'balanced', 800, 7, 4],
    [3, 'balanced', 800, 7, 3], [0, 'wild', 700, 4, 5], [4, 'balanced', null, 3, 6]]) {
    put.run(ids[i], KEY, profile, fitness, lap === null ? 0 : 1, lap, created);
  }
  db.close();
  dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true'}});
  const board = wire.parseLeaderboardResponse(await bytes(await call('/v1/leaderboard?track=' + KEY)));
  assert.deepEqual(board.entries.map(e => [ids.indexOf(e.id), e.lapFrames, e.profile]), [[0, 700, 'wild'], [3, 800, 'balanced'], [2, 800, 'balanced'], [1, 800, 'balanced']]);
});

test('a track made to be costly is stopped within its budget and refused', async () => {
  // As cloud-brain/sim/tests/cost.rs: walls as long diagonals over every grid
  // cell, or zigzagging within the sensors' reach of a car that never moves.
  const far = 99900;
  const diagonal = (i, flip) => (i % 2 ? [far, flip * (far + i / 255)] : [-far, flip * (-far + i / 255)]);
  const zigzag = y => Array.from({length: 256}, (_, i) => [i % 2 ? 3200 : 0, y + i * 0.01]);
  const tracks = {
    diagonals: {width: 3200, height: 1800, inner: Array.from({length: 256}, (_, i) => diagonal(i, 1)), outer: Array.from({length: 256}, (_, i) => diagonal(i, -1)),
      checkpoints: [[[2600, 300], [2600, 301]], [[2601, 300], [2601, 301]], ...Array.from({length: 62}, (_, i) => [[-far, -far + i], [far, far + i]])]},
    zigzags: {width: 3200, height: 1800, inner: zigzag(300), outer: zigzag(700),
      checkpoints: [[[1600, 400], [1600, 600]], [[1700, 400], [1700, 600]], ...Array.from({length: 62}, (_, i) => [[1300 + i * 10, 420], [1300 + i * 10, 440]])]},
  };
  const vector = new Float32Array(DIMS.brain);
  vector.fill(1, 176, 180); // the output layer's biases: every output off
  const ctx = {...context, seconds: 120};
  await post('/v1/contribute', wire.contributeBody({token: OTHER, brains: [wire.brainToWire({vector, fitness: 1, meta: {learning: {context: ctx, styleScore: 0}}})]}));
  for (const [name, track] of Object.entries(tracks)) {
    const started = performance.now();
    const res = await post('/v1/verify', wire.verifyBody({token: TOKEN, vector, track, context: ctx}));
    const ms = performance.now() - started;
    console.log(`# ${name}, stopped within the budget: ${ms.toFixed(0)} ms`);
    assert.equal(res.status, 400);
    assert.deepEqual(wire.parseErrorResponse(await bytes(res)), {ok: true, error: 'track-geometry'});
    assert.ok(ms < 1000, `${ms} ms`);
  }
});

test('while nobody plays, the service breeds a better brain on the busiest preset and serves it as its own', async () => {
  // A second Worker, training on: a session every second (each up to
  // 120 000 frames), right after the last contribution.
  const store = await mkdtemp(path.join(os.tmpdir(), 'cloud-brain-train-'));
  const trainer = await startDev({port: PORT + 1, persist: store, logLevel: 'log', vars: {ALLOW_LOCAL: 'true', TRAIN_FRAMES: '120000', TRAIN_EVERY_SECONDS: '1', TRAIN_IDLE_MINUTES: '0'}});
  const at = (route, body) => fetch(trainer.origin + route, {method: body === undefined ? 'GET' : 'POST', body, signal: AbortSignal.timeout(30_000),
    headers: {Origin: PAGE, 'Content-Type': 'text/plain', 'CF-Connecting-IP': nextAddress()}});
  try {
    assert.equal((await (await at('/health')).json()).training, true);
    // The Rectangle brain the game's learning loop evolved (it laps: fitness
    // 6), and the random ones, in its context.
    const traces = JSON.parse(await readFile(new URL('./fixtures/cloud-brain-sim/traces.json', import.meta.url), 'utf8'));
    const toVector = c => { const raw = Buffer.from(c.vector, 'base64'); return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); };
    const rectangle = traces.cases.filter(c => c.track === 'Rectangle');
    const evolved = rectangle.find(c => c.outcome.laps > 0 && c.settings.seconds === 20 && c.settings.profile === 'balanced');
    const seeds = [evolved, ...rectangle.filter(c => c.brain.startsWith('random'))].map(toVector);
    const ctx = {profile: 'balanced', track: traces.tracks.Rectangle.key, maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'};
    const track = unit(DIMS.track, 91);
    const ids = await Promise.all(seeds.map(v => brainId(v)));
    assert.equal((await at('/v1/contribute', wire.contributeBody({token: TOKEN, tracks: [track],
      brains: seeds.map(vector => wire.brainToWire({vector, fitness: 1, track: 0, meta: {generation: 3, learning: {context: ctx, styleScore: 0}}}))}))).status, 200);
    // Sessions run on their own; a brain of the service's appears.
    const started = performance.now();
    let cloud = null;
    while (!cloud && performance.now() - started < 150_000) {
      await new Promise(r => setTimeout(r, 2000));
      const pool = (await wire.parseRecallResponse(await bytes(await at('/v1/recall', wire.recallBody({trackVec: track, context: ctx, k: 64}))))).pool;
      cloud = pool.find(p => p.meta.source === 'cloud') || null;
    }
    // A few more sessions, for their times (each logged with its report).
    await new Promise(r => setTimeout(r, 4000));
    const sessions = [...trainer.log().matchAll(/cloud brain: trained in (\d+) ms: (\{.*\})/g)].map(m => ({ms: Number(m[1]), ...JSON.parse(m[2])}));
    console.log(`# a cloud brain after ${((performance.now() - started) / 1000).toFixed(0)} s: fitness ${cloud?.fitness}; ${sessions.length} sessions of ${sessions.map(s => s.frames).join('/')} frames in ${sessions.map(s => s.ms).join('/')} ms`);
    assert.ok(sessions.length >= 1 && sessions.every(s => s.frames <= 120_000 && s.track === 'Rectangle'), JSON.stringify(sessions.slice(0, 2)));
    assert.ok(cloud, 'a brain the service bred: ' + trainer.log().slice(-1500));
    assert.ok(cloud.fitness >= evolved.outcome.fitness, `it drove at least as well as the best seed (${cloud.fitness})`);
    assert.ok(!ids.includes(cloud.id) && ids.includes(cloud.meta.parentIds[0]), 'a new brain, bred from a seed');
    assert.deepEqual(cloud.meta.learning.context.track, ctx.track);
    // Anyone verifying it gets its fitness.
    const v = wire.parseVerifyResponse(await bytes(await at('/v1/verify', wire.verifyBody({token: OTHER, vector: cloud.vector, track: {width: 3200, height: 1800,
      inner: traces.tracks.Rectangle.inner, outer: traces.tracks.Rectangle.outer, checkpoints: traces.tracks.Rectangle.checkpoints}, context: ctx}))));
    assert.equal(v.fitness, cloud.fitness);
  } finally {
    await trainer.stop();
    await rm(store, {recursive: true, force: true});
  }
});

test('everyone\'s crash map: two players\' maps near a track come back as one, with the best layouts, and forget takes a player\'s out', async () => {
  // A near track (cosine ~0.96: its own track, within the neighbourhood).
  const track = unit(DIMS.track, 61), other = unit(DIMS.track, 62), near = unit2(track.map((x, i) => x + 0.3 * other[i]));
  const mapOf = cells => { const m = new Float32Array(wire.CRASH_DIM); for (const [i, n] of cells) m[i] = Math.log1p(n); const s = Math.hypot(...m); return m.map(x => x / s); };
  const send = (token, t, cells, layout = null) => post('/v1/crashes', wire.crashesBody({token, track: t, map: mapOf(cells), deaths: 9, layout}));
  const layout = (survival, x) => ({geometry: 'g1a2b', survival, gates: [[[x, 300], [x, 700]], [[2000, 300], [2000, 700]]]});
  const A = '1a'.repeat(16), B = '1b'.repeat(16);
  assert.equal((await send(A, track, [[10, 5]], layout(0.6, 1000))).status, 200);
  assert.equal((await send(B, near, [[20, 5]], layout(0.8, 1100))).status, 200);
  const recall = async () => wire.parseCrashRecallResponse(await bytes(await post('/v1/crashes/recall', wire.crashRecallBody({track, geometry: 'g1a2b'}))));
  let r = await recall();
  assert.deepEqual([r.ok, r.contributors, r.tracks], [true, 2, 2]);
  assert.ok(r.map[10] > 0 && r.map[20] > 0 && r.map[30] === 0, 'both players\' crashes');
  assert.deepEqual(r.layouts.map(l => [l.survival, l.gates[0][0][0]]), [[0.8, 1100], [0.6, 1000]]);
  // Another collision mode: none of these.
  const solid = wire.parseCrashRecallResponse(await bytes(await post('/v1/crashes/recall', wire.crashRecallBody({track, collisions: 'solid/k8', geometry: 'g1a2b'}))));
  assert.deepEqual([solid.map, solid.contributors, solid.layouts], [null, 0, []]);
  // A's next map, with no layout or a worse one, keeps their layout (read back from SQL whole).
  assert.equal((await send(A, track, [[12, 5]])).status, 200);
  assert.equal((await send(A, track, [[12, 5]], layout(0.3, 900))).status, 200);
  r = await recall();
  assert.deepEqual(r.layouts.map(l => [l.survival, l.gates]), [[0.8, layout(0.8, 1100).gates], [0.6, layout(0.6, 1000).gates]]);
  assert.ok(r.map[12] > 0 && r.map[10] === 0, 'their latest map');
  // Forget takes B's map and layout.
  assert.deepEqual(await (await post('/v1/forget', wire.forgetBody({token: B}))).json(), {protocol: 1, brains: 0, feedback: 0, crashes: 1});
  r = await recall();
  assert.deepEqual([r.contributors, r.layouts.length], [1, 1]);
  assert.ok(r.map[20] === 0 && r.map[12] > 0);
  // A map that is not one is refused with its reason.
  const bad = await post('/v1/crashes', wire.crashesBody({token: A, track, map: mapOf([[10, 5]]).map(x => x * 2), deaths: 9}));
  assert.equal(bad.status, 400);
  assert.deepEqual(wire.parseErrorResponse(await bytes(bad)), {ok: true, error: 'crash-map'});
});

test('a track dropped to make room takes its crash maps with it', async () => {
  // A third Worker that keeps 2 tracks (MAX_TRACKS), on a store of its own.
  const {DatabaseSync} = await import('node:sqlite');
  const store = await mkdtemp(path.join(os.tmpdir(), 'cloud-brain-tracks-'));
  const small = await startDev({port: PORT + 2, persist: store, vars: {ALLOW_LOCAL: 'true', MAX_TRACKS: '2'}});
  const at = (route, body) => fetch(small.origin + route, {method: 'POST', body, signal: AbortSignal.timeout(30_000),
    headers: {Origin: PAGE, 'Content-Type': 'text/plain', 'CF-Connecting-IP': nextAddress()}});
  const map = new Float32Array(wire.CRASH_DIM);
  map[5] = 1;
  const tracks = [71, 72, 73].map(seed => unit(DIMS.track, seed));
  let running = true;
  try {
    for (const [i, track] of tracks.entries()) {
      const res = await at('/v1/crashes', wire.crashesBody({token: 'd' + i + 'd'.repeat(30), track, map, deaths: 4}));
      assert.equal(wire.parseCrashesResponse(await bytes(res)).accepted, true);
    }
    const mapOn = async track => wire.parseCrashRecallResponse(await bytes(await at('/v1/crashes/recall', wire.crashRecallBody({track})))).map;
    assert.equal(await mapOn(tracks[0]), null, 'the oldest track went, its map with it');
    assert.equal((await mapOn(tracks[2]))[5], 1);
    await small.stop();
    running = false;
    const dir = path.join(store, 'v3/do/vectorvroom-brain-SharedBrain');
    const db = new DatabaseSync(path.join(dir, (await readdir(dir)).find(f => f.endsWith('.sqlite') && !f.startsWith('metadata'))), {readOnly: true});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crash_maps').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crash_maps WHERE track NOT IN (SELECT id FROM tracks)').get().n, 0);
    db.close();
  } finally {
    if (running) await small.stop();
    await rm(store, {recursive: true, force: true});
  }
});

test('the token is never stored, only its hash', async () => {
  const dir = path.join(persist, 'v3/do/vectorvroom-brain-SharedBrain');
  const files = (await readdir(dir)).filter(f => !f.startsWith('metadata'));
  assert.ok(files.some(f => f.endsWith('.sqlite')), files.join());
  const stored = Buffer.concat(await Promise.all(files.map(f => readFile(path.join(dir, f)))));
  for (const token of [TOKEN, OTHER]) {
    assert.ok(!stored.includes(token), 'a token in the store');
    const hash = createHash('sha256').update(token).digest('hex').slice(0, 32);
    assert.ok(stored.includes(hash), 'its hash identifies the contributor');
  }
});

test('the brain survives a restart, and the breaker turns it off', async () => {
  await awayFromMidnight();
  const query = wire.recallBody({trackVec: TRACK, dynamicsVec: unit(DIMS.dynamics, 7), context, k: 64});
  const before = await bytes(await post('/v1/recall', query));
  const stats = await (await call('/v1/stats')).json();
  await dev.stop();
  dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true'}});
  const t0 = performance.now();
  const after = await bytes(await post('/v1/recall', query));
  console.log(`# first recall after a restart (loads ${stats.brains} brains): ${(performance.now() - t0).toFixed(0)} ms`);
  assert.deepEqual(after, before, 'the same answer, byte for byte');
  assert.deepEqual(await (await call('/v1/stats')).json(), stats);
  await dev.stop();
  dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true', DISABLE_BRAIN: 'true'}});
  const off = await post('/v1/recall', query);
  assert.equal(off.status, 503);
  assert.equal(off.headers.get('access-control-allow-origin'), PAGE, 'the page can read why');
  assert.deepEqual(wire.parseErrorResponse(await bytes(off)), {ok: true, error: 'disabled'});
  assert.equal((await (await call('/health', {origin: null})).json()).brain, false);
});

test('a daily quota refuses a token past it with 429 until midnight', async () => {
  await awayFromMidnight();
  await dev.stop();
  dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true', QUOTA_REQUESTS: '3', QUOTA_BRAINS: '2', QUOTA_FEEDBACK: '50'}});
  const [SPENDER, SAVER] = ['5a'.repeat(16), '5b'.repeat(16)];
  const brain = seed => wire.brainToWire({vector: sine(DIMS.brain, seed, 0.5), fitness: 1});
  const send = (token, brains) => post('/v1/contribute', wire.contributeBody({token, brains}));
  assert.equal((await send(SPENDER, [brain(700), brain(701)])).status, 200);
  const over = await send(SPENDER, [brain(702)]);
  assert.equal(over.status, 429, 'a third brain today');
  const retry = Number(over.headers.get('retry-after'));
  const toMidnight = (86_400_000 - Date.now() % 86_400_000) / 1000;
  assert.ok(retry >= toMidnight - 5 && retry <= toMidnight + 5, `${retry} s, midnight in ${toMidnight} s`);
  assert.equal(over.headers.get('access-control-allow-origin'), PAGE);
  assert.deepEqual(wire.parseErrorResponse(await bytes(over)), {ok: true, error: 'rate-limited'});
  assert.equal((await send(SPENDER, [])).status, 200, 'a second request, no brain');
  assert.equal((await send(SPENDER, [])).status, 200, 'a third');
  assert.equal((await send(SPENDER, [])).status, 429, 'a fourth');
  assert.equal((await send(SAVER, [brain(703)])).status, 200, 'another token is not affected');
  // Forgetting works past the quota (and is not counted).
  const forgot = await post('/v1/forget', wire.forgetBody({token: SPENDER}));
  assert.equal(forgot.status, 200);
  assert.deepEqual(await forgot.json(), {protocol: 1, brains: 2, feedback: 0, crashes: 0});
});

test('a database at SQL schema 1 is migrated', async () => {
  // Back to schema 1 as CB2 left it: the old contributors table, feedback in
  // the old format, no migrations 2 and 3. Then again with migration 2 cut short.
  const {DatabaseSync} = await import('node:sqlite');
  const dir = path.join(persist, 'v3/do/vectorvroom-brain-SharedBrain');
  const file = path.join(dir, (await readdir(dir)).find(f => f.endsWith('.sqlite') && !f.startsWith('metadata')));
  const brainsBefore = (await (await call('/v1/stats')).json()).brains;
  const mine = createHash('sha256').update(TOKEN).digest('hex').slice(0, 32);
  for (const cut of [false, true]) {
    await dev.stop();
    const db = new DatabaseSync(file);
    // A brain TOKEN did not contribute: its feedback is evidence, and written.
    const theirs = db.prepare('SELECT id FROM brains WHERE contributor != ? LIMIT 1').get(mine).id;
    db.exec(`DROP TABLE contributors; DROP INDEX IF EXISTS brains_contributor; DROP TABLE IF EXISTS verified; DROP TABLE IF EXISTS geometries; DROP TABLE IF EXISTS crash_maps; DELETE FROM feedback;
      DELETE FROM migrations WHERE version >= 2; UPDATE meta SET value = '1' WHERE key = 'sql_schema'`);
    db.prepare(`INSERT INTO feedback (brain, context_key, context, weight, count, baseline, contributors, updated)
      VALUES (?, '0123456789abcdef', '{}', 0.5, 3, 40, 'aaaaaaaa,bbbbbbbb', ?)`).run(theirs, Date.now());
    // Cut short: the contributors table already dropped, the migration not recorded.
    if (!cut) {
      db.exec(`CREATE TABLE contributors (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
        CREATE INDEX contributors_last_seen ON contributors (last_seen)`);
      db.prepare('INSERT INTO contributors VALUES (?, ?, ?)').run('00'.repeat(16), Date.now(), Date.now());
    }
    db.close();
    dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true'}});
    const health = await (await call('/health', {origin: null})).json();
    assert.equal(health.ok, true, `migrated (cut short: ${cut})`);
    const stats = await (await call('/v1/stats')).json();
    assert.equal(stats.brains, brainsBefore, 'the brains stay');
    const res = await post('/v1/contribute', wire.contributeBody({token: TOKEN, feedback: [wire.feedbackToWire({id: theirs, context, meanFitness: 1, count: 1})]}));
    assert.equal(res.status, 200, 'quotas and feedback work on the new tables');
    assert.equal(wire.parseContributeResponse(await bytes(res)).feedbackAccepted, 1);
    await dev.stop();
    const after = new DatabaseSync(file, {readOnly: true});
    assert.deepEqual(after.prepare('SELECT version FROM migrations ORDER BY version').all().map(r => r.version), [1, 2, 3, 4]);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('crash_maps', 'crash_maps_contributor')").get().n, 2, 'schema 4: crash maps');
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('verified', 'geometries')").get().n, 2, 'schema 3: verified runs, pinned geometries');
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM geometries').get().n, 10, 'the presets pinned');
    assert.ok(after.prepare("SELECT COUNT(*) AS n FROM feedback WHERE contributors = 'aaaaaaaa,bbbbbbbb'").get().n === 0, 'schema 1 feedback is gone');
    const slots = after.prepare('SELECT contributors FROM feedback WHERE brain = ?').all(theirs).map(r => r.contributors);
    assert.deepEqual(slots.map(t => t.split(':')[0]), [mine], 'a slot with its contributor id');
    const columns = after.prepare("SELECT name FROM pragma_table_info('contributors')").all().map(r => r.name);
    assert.deepEqual(columns, ['id', 'first_seen', 'last_seen', 'day', 'requests', 'brains', 'feedback']);
    after.close();
    dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true'}});
  }
  // A database newer than the build is not served from.
  await dev.stop();
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO migrations (version, applied) VALUES (5, ?)').run(Date.now());
  db.close();
  dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true'}});
  assert.equal((await (await call('/health', {origin: null})).json()).ok, false);
  const refused = await call('/v1/stats');
  assert.equal(refused.status, 500);
  assert.deepEqual(wire.parseErrorResponse(await bytes(refused)), {ok: true, error: 'server-error'});
});
