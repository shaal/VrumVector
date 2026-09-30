// The cloud brain's wire format (AI-Car-Racer/cloud/wire.js, CB1 of
// docs/plan/cloud-brain.md) and the fixtures the service (CB2) runs too.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import * as wire from '../AI-Car-Racer/cloud/wire.js';
import {buildPopulation, FLAT_LENGTH} from '../AI-Car-Racer/learning/policy.js';
import {USE_WEIGHT_DECAY} from '../AI-Car-Racer/learning/demonstrationSeed.js';
import {fixtures} from '../scripts/cloud-brain-fixtures.mjs';

const {encodeF32, decodeF32, brainId, REASONS, LIMITS, DIMS} = wire;
const root = new URL('./fixtures/cloud-brain/', import.meta.url);
const readJson = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const load = async kind => Object.fromEntries(await Promise.all((await readdir(new URL(kind + '/', root))).sort()
  .map(async file => [file.replace(/\.json$/, ''), await readJson(`${kind}/${file}`)])));

// What a fixture's route gives, in the shape of its `expect`.
// A refused request also gets the HTTP status the service answers with.
const refusal = r => ({...r, status: wire.httpStatus(r.error)});
// A fixture's body as the bytes on the wire.
const bytesOf = fixture => ('bodyBase64' in fixture ? new Uint8Array(Buffer.from(fixture.bodyBase64, 'base64')) : new TextEncoder().encode(fixture.body));
async function run(fixture, body = fixture.body) {
  const {route, expect} = fixture;
  if (route === 'contribute') {
    const r = await wire.parseContribute(body);
    if (!r.ok) return refusal(r);
    const out = {ok: true, accepted: r.brains.map(b => b.id), rejected: r.rejected, feedbackAccepted: r.feedback.length, feedbackRejected: r.feedbackRejected};
    if ('firstMeta' in expect) out.firstMeta = r.brains[0]?.meta;
    if ('tracks' in expect) out.tracks = r.brains.map(b => b.track);
    // deepStrictEqual tells -0 from 0: these also pin "outputs never hold -0".
    if ('fitness' in expect) out.fitness = r.brains.map(b => b.fitness);
    if ('feedbackRows' in expect) out.feedbackRows = r.feedback;
    // The vectors read, as fingerprints (brain_ + SHA-256 of their bytes).
    if ('trackPrints' in expect) out.trackPrints = await Promise.all(r.tracks.map(brainId));
    if ('dynamicsPrints' in expect) out.dynamicsPrints = await Promise.all(r.brains.map(b => (b.dynamics ? brainId(b.dynamics) : null)));
    return out;
  }
  if (route === 'recall') {
    const r = wire.parseRecall(body);
    if (!r.ok) return refusal(r);
    const out = {ok: true, k: r.k, dynamics: !!r.dynamics, context: r.context};
    if ('trackPrint' in expect) out.trackPrint = await brainId(r.track);
    if ('dynamicsPrint' in expect) out.dynamicsPrint = await brainId(r.dynamics);
    return out;
  }
  if (route === 'forget') {
    const r = wire.parseForget(body);
    return r.ok ? {ok: true} : refusal(r);
  }
  if (route === 'recall-response') {
    const r = await wire.parseRecallResponse(body);
    if (!r.ok) return r;
    const out = {ok: true, pool: r.pool.map(p => p.id), dropped: r.dropped};
    const numbers = p => ({fitness: p.fitness, score: p.score, feedback: p.feedback});
    if ('first' in expect) out.first = numbers(r.pool[0]);
    if ('second' in expect) out.second = numbers(r.pool[1]);
    if ('firstMeta' in expect) out.firstMeta = r.pool[0].meta;
    return out;
  }
  if (route === 'contribute-response') return wire.parseContributeResponse(body);
  if (route === 'stats-response') return wire.parseStatsResponse(body);
  if (route === 'error-response') {
    const r = wire.parseErrorResponse(body);
    return {...r, status: wire.httpStatus(r.error)};
  }
  throw new Error('unknown route ' + route);
}

test('the fixtures on disk are what the generator makes', async () => {
  const made = await fixtures();
  for (const kind of ['valid', 'invalid']) {
    const onDisk = await load(kind);
    assert.deepEqual(Object.keys(onDisk).sort(), Object.keys(made[kind]).sort(), kind);
    for (const name of Object.keys(onDisk)) assert.deepEqual(onDisk[name], JSON.parse(JSON.stringify(made[kind][name])), `${kind}/${name}`);
  }
  for (const table of ['contexts', 'meta']) assert.deepEqual(await readJson(`${table}.json`), JSON.parse(JSON.stringify(made[table])), table);
});

test('every fixture gives its expected result', async () => {
  for (const kind of ['valid', 'invalid']) {
    for (const [name, fixture] of Object.entries(await load(kind))) {
      // Read as bytes (as the service and the browser read), and a text body as text too.
      assert.equal(('body' in fixture) + ('bodyBase64' in fixture), 1, `${kind}/${name}: one body`);
      if ('body' in fixture) assert.ok(fixture.body.isWellFormed(), `${kind}/${name}: text bodies are well-formed Unicode`);
      const result = await run(fixture, bytesOf(fixture));
      assert.deepEqual(result, fixture.expect, `${kind}/${name}: ${fixture.description}`);
      if ('body' in fixture) assert.deepEqual(await run(fixture), fixture.expect, `${kind}/${name} as text`);
      // A valid request is accepted whole, a valid answer read; an invalid
      // fixture refuses something (answers: refused, or an unknown error).
      const answer = ['contribute-response', 'stats-response', 'error-response'].includes(fixture.route);
      const refusedSomething = answer ? !result.ok || result.error === 'server-error'
        : !result.ok || result.rejected?.length || result.feedbackRejected?.length || result.dropped?.length;
      assert.equal(!!refusedSomething, kind === 'invalid', `${kind}/${name}`);
    }
  }
  // Every reason code appears in some fixture, so the service is tested on each.
  const text = JSON.stringify(await load('invalid'));
  for (const reason of Object.values(REASONS)) assert.ok(text.includes(`"${reason}"`), `no fixture for ${reason}`);
});

test('contexts and meta are cleaned as the tables say', async () => {
  for (const {in: input, out} of await readJson('contexts.json')) assert.deepEqual(wire.wireContext(input), out, JSON.stringify(input));
  for (const {in: input, out} of await readJson('meta.json')) assert.deepEqual(wire.cleanBrainMeta(input), out, JSON.stringify(input));
  // Prototype keys in meta never reach a prototype.
  assert.equal({}.polluted, undefined);
});

test('bytes arrive in any container; text must be well-formed', async () => {
  const {runInNewContext} = await import('node:vm');
  const body = new TextEncoder().encode(wire.errorBody('disabled'));
  const padded = new Uint8Array(body.length + 7); padded.set(body, 3);
  for (const input of [body, body.buffer, new DataView(body.buffer), Buffer.from(body), padded.subarray(3, 3 + body.length),
    runInNewContext(`new Uint8Array([${body}])`), runInNewContext(`new Uint8Array([${body}]).buffer`)]) {
    assert.deepEqual(wire.parseErrorResponse(input), {ok: true, error: 'disabled'}, Object.prototype.toString.call(input));
  }
  const shared = new SharedArrayBuffer(body.length); new Uint8Array(shared).set(body);
  for (const input of [shared, new Uint8Array(shared)]) assert.deepEqual(wire.parseErrorResponse(input), {ok: true, error: 'disabled'}, 'shared');
  for (const input of [null, 42, {}, [1, 2], body.join(',')]) assert.deepEqual(wire.parseForget(input).ok, false);
  // A detached buffer (or a view of one) is not bytes: refused, never thrown.
  const moved = new TextEncoder().encode(wire.forgetBody({token: 'a'.repeat(32)})), view = new Uint8Array(moved.buffer);
  structuredClone(moved.buffer, {transfer: [moved.buffer]});
  for (const input of [moved.buffer, view, moved]) assert.deepEqual(wire.parseForget(input), {ok: false, error: 'shape'});
  assert.deepEqual(await wire.parseContribute(view), {ok: false, error: 'shape'});
  // Text that is not well-formed has no UTF-8 bytes: refused like the bytes a
  // sender could make of it (an escaped high half then a raw low half joins
  // into a pair in JavaScript, but not in UTF-8).
  const token = 'a'.repeat(32);
  for (const note of ['\\ud800\udc00', '\udc00', '\ud800']) {
    assert.deepEqual(wire.parseForget(`{"protocol":1,"token":"${token}","note":"${note}"}`), {ok: false, error: 'not-json'}, note);
  }
  assert.deepEqual(wire.parseForget(`{"protocol":1,"token":"${token}","note":"\\ud83d\\ude00😀"}`), {ok: true, token});  // an escaped pair and a raw one
  // Size first, as for bytes: over the limit and not well-formed is too large.
  assert.deepEqual(wire.parseForget(`{"protocol":1,"token":"${token}","n":"${'a'.repeat(LIMITS.requestBytes)}\ud800"}`), {ok: false, error: 'body-too-large'});
});

test('vectors round-trip bit for bit, as canonical little-endian base64', () => {
  const values = Float32Array.from([0, -0, 1, -1, 16, -16, 1e-45, 3.4028234663852886e38, 0.1, Math.PI]);
  const back = decodeF32(encodeF32(values), values.length);
  assert.ok(back.every((v, i) => Object.is(v, values[i])));
  assert.equal(encodeF32(Float32Array.of(1)), 'AACAPw==');   // little-endian: 00 00 80 3f
  const brain = Float32Array.from({length: FLAT_LENGTH}, (_, i) => Math.sin(i));
  const text = encodeF32(brain);
  assert.equal(text.length, 4 * Math.ceil(FLAT_LENGTH * 4 / 3));
  for (const bad of [text.slice(1), text + 'AAAA', text.replace('A', '*'), text.slice(0, -4) + '====', text.replace(/=+$/, ''), ' ' + text.slice(1),
    text.replace('+', '-'), text.slice(0, -3) + 'x==', null, 42, {}]) assert.equal(decodeF32(bad, FLAT_LENGTH), null, String(bad).slice(-8));
  assert.equal(decodeF32(text, FLAT_LENGTH - 1), null);
});

test('brain ids are the first 128 bits of SHA-256 of the little-endian bytes', async () => {
  for (const seed of [1, 2, 3]) {
    const v = Float32Array.from({length: FLAT_LENGTH}, (_, i) => Math.sin(i * seed));
    const bytes = Buffer.alloc(v.length * 4);
    v.forEach((x, i) => bytes.writeFloatLE(x, i * 4));
    assert.equal(await brainId(v), 'brain_' + createHash('sha256').update(bytes).digest('hex').slice(0, 32));
    assert.equal(await brainId(Array.from(v)), await brainId(v));
  }
  // -0 and 0 are different bytes, so different brains.
  const a = new Float32Array(FLAT_LENGTH), b = new Float32Array(FLAT_LENGTH); b[0] = -0;
  assert.notEqual(await brainId(a), await brainId(b));
});

test('the wire constants match the app', async () => {
  globalThis.window = {addEventListener() {}};
  try {
    const codec = await import('../AI-Car-Racer/brainCodec.js');
    assert.equal(wire.BRAIN_SCHEMA, codec.BRAIN_SCHEMA_VERSION);
    assert.equal(DIMS.brain, codec.FLAT_LENGTH);
  } finally { delete globalThis.window; }
  const bridge = await readFile(new URL('../AI-Car-Racer/ruvectorBridge.js', import.meta.url), 'utf8');
  assert.equal(DIMS.track, Number(/const TRACK_DIM = (\d+);/.exec(bridge)[1]));
  assert.equal(DIMS.dynamics, Number(/const DYNAMICS_DIM = (\d+);/.exec(bridge)[1]));
  assert.deepEqual(['body-too-large', 'rate-limited', 'disabled', 'server-error', 'token'].map(wire.httpStatus), [413, 429, 503, 500, 400]);
});

test('requests built by the browser parse back to what went in', async () => {
  const vector = Float32Array.from({length: FLAT_LENGTH}, (_, i) => Math.cos(i) * 0.9);
  const unit = dim => { const v = Float32Array.from({length: dim}, (_, i) => Math.sin(i + 1)); const n = Math.hypot(...v); return v.map(x => x / n); };
  const track = unit(DIMS.track), dynamics = unit(DIMS.dynamics);
  const context = {profile: 'careful', track: 'g9', maxSpeed: 12, traction: 0.4, seconds: 25, collisions: {heatSize: 8}};
  const token = 'ab'.repeat(16), id = await brainId(vector);
  const text = wire.contributeBody({token, tracks: [track], brains: [
    wire.brainToWire({vector, fitness: 7.5, track: 0, dynamicsVec: dynamics, meta: {generation: 3, parentIds: [], source: 'demonstration', learning: {context, styleScore: 0.4}}}),
    // An all-zero dynamics summary is left out, so the brain is not refused.
    wire.brainToWire({vector: vector.map(x => -x), fitness: 1, dynamicsVec: new Float32Array(DIMS.dynamics)}),
  ], feedback: [wire.feedbackToWire({id, context, meanFitness: 6, count: 9})]});
  const r = await wire.parseContribute(text);
  assert.equal(r.ok, true);
  assert.deepEqual([r.rejected, r.feedbackRejected, r.brains.length], [[], [], 2]);
  assert.equal(r.brains[0].id, id);
  assert.ok(r.brains[0].vector.every((v, i) => v === vector[i]));
  assert.equal(r.brains[0].track, 0);
  assert.equal(r.brains[1].dynamics, null);
  assert.ok(r.tracks[0].every((v, i) => v === track[i]) && r.brains[0].dynamics.every((v, i) => v === dynamics[i]));
  const clean = {version: 1, profile: 'careful', track: 'g9', maxSpeed: 12, traction: 0.4, seconds: 25, collisions: 'solid/k8/rays'};
  assert.deepEqual(r.brains[0].meta, {generation: 3, source: 'demonstration', learning: {context: clean, styleScore: 0.4}});
  assert.deepEqual(r.feedback[0], {id, context: clean, meanFitness: 6, count: 9});
  const recall = wire.parseRecall(wire.recallBody({trackVec: track, dynamicsVec: dynamics, context, k: 10}));
  assert.deepEqual([recall.ok, recall.k, recall.context], [true, 10, clean]);
  assert.deepEqual(wire.parseForget(wire.forgetBody({token})), {ok: true, token});
  assert.deepEqual(wire.parseErrorResponse(wire.errorBody('token')), {ok: true, error: 'token'});
});

test('real brains pass: a genetic population, and the clone bound', () => {
  // Evolved brains: a genetic population (fresh, mutated, elite) stays in ±1.
  const seed = {vector: Float32Array.from({length: FLAT_LENGTH}, (_, i) => Math.sin(i) * 0.8), id: 'x'};
  let r = 12345;
  const random = () => (r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const {flat} = buildPopulation({N: 64, seeds: [seed], incumbent: seed, plan: {mutation: 0.4, novel: 0.2, round: 3, stagnant: 0}, random});
  for (let i = 0; i < 64; i++) assert.equal(wire.brainProblem(flat.subarray(i * FLAT_LENGTH, (i + 1) * FLAT_LENGTH)), null, 'car ' + i);
  // "Use my driving" clones (weight decay 0.001) reached 6.76 at most over 14
  // clones (CB1, docs/validation/cloud-brain.md); the bound is 16. It rests on
  // that decay: lowering it needs a new measurement.
  assert.equal(USE_WEIGHT_DECAY, 0.001);
  assert.ok(LIMITS.maxWeight >= 2 * 6.76);
  // A clone without decay (never made by the app; 10 to 97 in CB1) is refused.
  const undecayed = Float32Array.from({length: FLAT_LENGTH}, (_, i) => (i === 180 ? 52 : 0.1));
  assert.equal(wire.brainProblem(undecayed), REASONS.brainWeightRange);
});

test('hostile input never throws, and every refusal has a known reason', async () => {
  const known = new Set([...Object.values(REASONS), ...wire.SERVICE_ERRORS]);
  const fixtures = Object.values(await load('valid')).concat(Object.values(await load('invalid')));
  const bodies = fixtures.filter(f => 'body' in f).map(f => f.body);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const parsers = [wire.parseContribute, wire.parseRecall, wire.parseForget, wire.parseRecallResponse, wire.parseContributeResponse, wire.parseStatsResponse, wire.parseErrorResponse];
  const hostile = ['-1e309', '{"__proto__":{"x":1}}', '[[[[[]]]]]', '"\\u0000"', '1e400', '"\\ud800"', '[' .repeat(40) + ']'.repeat(40), '12.0', '-0', 'null', '"12"', '{"constructor":{"prototype":{"x":1}}}'];
  let runs = 0;
  const check = async text => {
    for (const parse of parsers) {
      const result = await parse(text);
      runs++;
      assert.equal(typeof result.ok, 'boolean');
      if (!result.ok || result.error) assert.ok(known.has(result.error), result.error);
      for (const item of [...(result.rejected || []), ...(result.feedbackRejected || []), ...(result.dropped || [])]) assert.ok(known.has(item.reason), item.reason);
    }
  };
  for (let round = 0; round < 500; round++) {
    // Bytes: one byte set to any value (invalid UTF-8, a control character, a cut character).
    const data = new Uint8Array(bytesOf(fixtures[Math.floor(random() * fixtures.length)]));
    data[Math.floor(random() * data.length)] = Math.floor(random() * 256);
    await check(data);
  }
  for (let round = 0; round < 1500; round++) {
    let text = bodies[Math.floor(random() * bodies.length)];
    const at = Math.floor(random() * text.length);
    const op = Math.floor(random() * 5);
    if (op === 0) text = text.slice(0, at) + String.fromCharCode(Math.floor(random() * 128)) + text.slice(at + 1);
    else if (op === 1) text = text.slice(0, at);
    else if (op === 2) text = text.slice(0, at) + text.slice(at, at + 40) + text.slice(at);
    else if (op === 3) text = text.replace(/:(\d+(?:\.\d+)?|"[^"]*"|true|false|null)/, ':' + hostile[Math.floor(random() * hostile.length)]);
    else text = text.replace(/"[A-Za-z0-9+/]{8}/, '"' + 'A'.repeat(8));
    await check(text);
  }
  // Deep nesting in every place a cleaner reads (the old clamp/String coercion overflowed the stack).
  const deep = '['.repeat(20000) + ']'.repeat(20000);
  for (const text of [
    `{"protocol":1,"brainSchema":6,"track":"x","context":{"track":${deep},"maxSpeed":${deep}}}`,
    `{"protocol":1,"brainSchema":6,"pool":[{"feedback":{"weight":${deep}}}]}`,
    `{"protocol":1,"brainSchema":6,"token":"${'a'.repeat(32)}","feedback":[{"id":"x","context":{"track":${deep}}}]}`,
  ]) await check(text);
  assert.equal(runs, (500 + 1500 + 3) * parsers.length);
  assert.equal({}.x, undefined);
});
