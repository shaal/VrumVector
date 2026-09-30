// The cloud brain service (CB2 of docs/plan/cloud-brain.md): the built
// Worker (wasm32-unknown-emscripten) under `wrangler dev` with a SQLite
// Durable Object. The front door (origins, CORS, the breaker, the body
// limit, routes), every CB1 request fixture over HTTP, answers read with the
// browser's own parsers, a contribution coming back from a recall, feedback,
// stats, persistence across a restart.
//
//   npm run test:cloud-brain:service      (PORT=8881 by default)
//
// Needs the cloud-brain toolchain (cloud-brain/README.md); wrangler builds
// the Worker first (scripts/build-cloud-brain.sh fetches ruvector once).
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
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

const call = (route, {method = 'GET', body, origin = PAGE, duplex} = {}) => fetch(dev.origin + route, {
  method, body, duplex, signal: AbortSignal.timeout(30_000),
  headers: {...(origin ? {Origin: origin} : {}), 'Content-Type': 'text/plain'},
});
const bytes = async res => new Uint8Array(await res.arrayBuffer());
const post = (route, body) => call(route, {method: 'POST', body});

const sine = (n, seed, scale = 1) => Float32Array.from({length: n}, (_, i) => Math.sin(i * 0.37 + seed) * scale);
const unit = (n, seed) => { const v = sine(n, seed); const norm = Math.hypot(...v); return v.map(x => x / norm); };
const context = {profile: 'balanced', track: 'service-test', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'};

test('health answers without an origin', async () => {
  const res = await call('/health', {origin: null});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {ok: true, protocol: 1, brain: true,
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
  for (const [method, route] of [['GET', '/v1/recall'], ['POST', '/v1/forget'], ['POST', '/v1/stats'], ['GET', '/nope'], ['GET', '/v1/'],
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
      // The forget route comes with CB4.
      if (!['contribute', 'recall'].includes(fixture.route)) continue;
      const body = 'bodyBase64' in fixture ? Buffer.from(fixture.bodyBase64, 'base64') : fixture.body;
      const res = await post('/v1/' + fixture.route, body);
      const answer = await bytes(res), where = `${kind}/${file}`, expect = fixture.expect;
      checked++;
      if (!expect.ok) {
        assert.equal(res.status, expect.status, where);
        assert.deepEqual(wire.parseErrorResponse(answer), {ok: true, error: expect.error}, where);
        continue;
      }
      assert.equal(res.status, 200, where);
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
  assert.ok(checked >= 100, `${checked} fixtures`);
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
  // Same track (similarity 1), so fitness orders them: 50, 40, 30.
  assert.deepEqual(recall.pool.map(p => p.id), ids.slice().reverse());
  for (const entry of recall.pool) {
    const mine = OURS[ids.indexOf(entry.id)];
    assert.ok(entry.vector.every((v, i) => Object.is(v, mine.vector[i])), 'bit for bit');
    assert.equal(entry.fitness, mine.fitness);
    assert.ok(entry.score > 0 && entry.score <= 1.3 * 1.3);
    assert.equal(entry.meta.learning.context.track, 'service-test');
  }
  assert.equal(recall.pool[0].meta.source, 'demonstration');
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
  // Its own context: 0.3 × (45 − 30) / 30.
  assert.ok(Math.abs(entry.feedback.weight - 0.15) < 1e-9, JSON.stringify(entry.feedback));
  assert.deepEqual([entry.feedback.count, entry.feedback.contributors], [1, 1]);
});

test('stats count what was contributed', async () => {
  const stats = wire.parseStatsResponse(await bytes(await call('/v1/stats')));
  assert.equal(stats.ok, true);
  assert.ok(stats.brains >= 3 && stats.tracks >= 1, JSON.stringify(stats));
  assert.ok(stats.contributorsToday >= 3, JSON.stringify(stats)); // the fixtures' token, TOKEN, OTHER
  assert.ok(stats.contributions24h >= 3);
});

test('the brain survives a restart, and the breaker turns it off', async () => {
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
