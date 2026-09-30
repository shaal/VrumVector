// The cloud brain service (CB2 and CB4 of docs/plan/cloud-brain.md): the
// built Worker (wasm32-unknown-emscripten) under `wrangler dev` with a
// SQLite Durable Object. The front door (origins, CORS, the breaker, the
// body limit, routes, the per-address rate limits), every CB1 request
// fixture over HTTP, answers read with the browser's own parsers, a
// contribution coming back from a recall, feedback, stats, persistence
// across a restart, quarantine of claims, forget, daily quotas, the token
// never stored, and the migration from SQL schema 1.
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
const context = {profile: 'balanced', track: 'service-test', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'};

test('health answers without an origin', async () => {
  const res = await call('/health', {origin: null});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {ok: true, protocol: 1, brain: true, limits: true,
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
      if (!['contribute', 'recall', 'forget'].includes(fixture.route)) continue;
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
      if (fixture.route === 'forget') {
        const forgot = JSON.parse(new TextDecoder().decode(answer));
        assert.deepEqual(Object.keys(forgot).sort(), ['brains', 'feedback', 'protocol'], where);
        assert.ok(forgot.protocol === 1 && Number.isInteger(forgot.brains) && Number.isInteger(forgot.feedback), where);
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
  assert.ok(checked >= 104, `${checked} fixtures`);
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
  assert.deepEqual(await res.json(), {protocol: 1, brains: 1, feedback: 1});
  assert.ok(!(await pool(track)).some(p => p.id === id), 'the brain is gone');
  assert.deepEqual((await pool(TRACK)).find(p => p.id === theirs).feedback, {weight: 0, count: 0, contributors: 0}, 'and the feedback');
  assert.deepEqual(await (await post('/v1/forget', wire.forgetBody({token: LEAVER}))).json(), {protocol: 1, brains: 0, feedback: 0});
});

test('an address past its limits gets 429 rate-limited, with CORS and Retry-After', async () => {
  // Local windows are whole minutes of the clock: start early in one.
  const into = Date.now() % 60_000;
  if (into > 45_000) await new Promise(r => setTimeout(r, 60_000 - into + 200));
  const address = '192.0.2.7';
  const write = body => call('/v1/contribute', {method: 'POST', body, address});
  const statuses = [];
  for (let i = 0; i < 20; i++) statuses.push((await write(wire.contributeBody({token: TOKEN}))).status);
  assert.deepEqual(statuses, Array(20).fill(200));
  // The 21st write in the minute is refused before it reaches the object.
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
  for (let i = 1; i <= 21; i++) v6.push((await call('/v1/contribute', {method: 'POST', body: wire.contributeBody({token: TOKEN}), address: `2001:db8:7:9::${i.toString(16)}`})).status);
  assert.deepEqual(v6, [...Array(20).fill(200), 429]);
  assert.equal((await call('/v1/contribute', {method: 'POST', body: wire.contributeBody({token: TOKEN}), address: '2001:db8:7:a::1'})).status, 200, 'another /64');
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
  assert.deepEqual(await forgot.json(), {protocol: 1, brains: 2, feedback: 0});
});

test('a database at SQL schema 1 is migrated', async () => {
  // Back to schema 1 as CB2 left it: the old contributors table, feedback in
  // the old format, no migration 2. Then again with the migration cut short.
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
    db.exec(`DROP TABLE contributors; DROP INDEX IF EXISTS brains_contributor; DELETE FROM feedback;
      DELETE FROM migrations WHERE version = 2; UPDATE meta SET value = '1' WHERE key = 'sql_schema'`);
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
    assert.deepEqual(after.prepare('SELECT version FROM migrations ORDER BY version').all().map(r => r.version), [1, 2]);
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
  db.prepare('INSERT INTO migrations (version, applied) VALUES (3, ?)').run(Date.now());
  db.close();
  dev = await startDev({port: PORT, persist, vars: {ALLOW_LOCAL: 'true'}});
  assert.equal((await (await call('/health', {origin: null})).json()).ok, false);
  const refused = await call('/v1/stats');
  assert.equal(refused.status, 500);
  assert.deepEqual(wire.parseErrorResponse(await bytes(refused)), {ok: true, error: 'server-error'});
});
