// CB2 (docs/plan/cloud-brain.md): the shared brain at its caps, under
// `wrangler dev` (local workerd). Fills it with BRAINS brains (default 20 000,
// the cap) on TRACKS tracks (default 5 000, the cap), each with dynamics and
// meta, through /v1/contribute; then the most feedback the brain keeps
// (CONTEXTS contexts a brain, each from CONTRIBUTORS contributors, 180-character
// track keys); then measures recall latency, the object's Wasm memory (a
// high-water mark, from the spike build's /spike/memory), the first recall
// after a restart (the index rebuilt from SQLite), and that OVER more brains
// leave the count at the cap. Recorded in docs/validation/cloud-brain.md (CB2).
//
//   node scripts/cloud-brain-load.mjs [--brains 20000] [--tracks 5000] [--over 1000] [--contexts 8] [--contributors 8]
//
// Needs the cloud-brain toolchain; PORT (default 8882).
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as wire from '../AI-Car-Racer/cloud/wire.js';
import {startDev} from '../tests/cloud-brain-dev.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const BRAINS = arg('brains', 20_000), TRACKS = arg('tracks', 5_000), OVER = arg('over', 1_000);
const CONTEXTS = arg('contexts', 8), CONTRIBUTORS = arg('contributors', 8);
const PORT = Number(process.env.PORT) || 8882, PAGE = 'http://localhost:8080';
const {DIMS, LIMITS} = wire;

function stream(seed) {
  let s = BigInt(seed) || 1n;
  return () => { s ^= (s << 13n) & 0xffffffffffffffffn; s ^= s >> 7n; s ^= (s << 17n) & 0xffffffffffffffffn; return Number(s >> 11n) / 2 ** 53 * 2 - 1; };
}
const vector = (seed, n, scale = 1) => { const r = stream(seed); return Float32Array.from({length: n}, () => r() * scale); };
const unit = (seed, n) => { const v = vector(seed, n); const norm = Math.hypot(...v); return v.map(x => x / norm); };
const context = i => ({profile: ['balanced', 'wild', 'careful'][i % 3], track: 'load-' + (i % 97), maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'});

const env = {CLOUD_BRAIN_FEATURES: 'spike', CLOUD_BRAIN_ALLOW_SPIKE: '1'};
const vars = {ALLOW_LOCAL: 'true', CLOUD_BRAIN_SPIKE: '1'};
const persist = await mkdtemp(path.join(os.tmpdir(), 'cloud-brain-load-'));
let dev = await startDev({port: PORT, persist, vars, env});
const post = (route, body) => fetch(dev.origin + route, {method: 'POST', body, headers: {Origin: PAGE}, signal: AbortSignal.timeout(120_000)});
const get = route => fetch(dev.origin + route, {headers: {Origin: PAGE}, signal: AbortSignal.timeout(120_000)});
const memory = async () => +(((await (await get('/spike/memory')).json()).bytes) / 2 ** 20).toFixed(1);
const quantile = (xs, q) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

const parentIds = await Promise.all(Array.from({length: 8}, (_, i) => wire.brainId(vector(900_000 + i, DIMS.brain))));
async function fill(from, to) {
  const times = [];
  let largest = 0;
  for (let start = from; start < to; start += LIMITS.brainsPerRequest) {
    const n = Math.min(LIMITS.brainsPerRequest, to - start);
    // Four tracks a request, TRACKS in all; each brain on one of them.
    const trackSeeds = Array.from({length: LIMITS.tracksPerRequest}, (_, i) => 10_000_000 + ((start / LIMITS.brainsPerRequest) * LIMITS.tracksPerRequest + i) % TRACKS);
    const brains = Array.from({length: n}, (_, i) => wire.brainToWire({
      vector: vector(start + i + 1, DIMS.brain, 0.9), fitness: ((start + i) * 7919) % 2000 - 500, track: i % LIMITS.tracksPerRequest,
      dynamicsVec: unit(20_000_000 + start + i, DIMS.dynamics),
      // The largest meta a brain can carry (its answer entry is the largest too).
      meta: {generation: start + i, parentIds, source: 'evolved', learning: {context: {...context(start + i), track: context(start + i).track.padEnd(180, 'x'),
        collisions: 'solid/k8/rays/' + 'a'.repeat(26)}, styleScore: 0.5,
        driving: {averageSpeed: 0.5, nearWallRate: 0.1, slideRate: 0.05, smoothness: 0.7, steeringChanges: 40, aliveSeconds: 20, crashed: false}}},
    }));
    const body = wire.contributeBody({token: 'ab'.repeat(16), tracks: trackSeeds.map(s => unit(s, DIMS.track)), brains});
    largest = Math.max(largest, body.length);
    const t0 = performance.now();
    const res = await post('/v1/contribute', body);
    const answer = wire.parseContributeResponse(new Uint8Array(await res.arrayBuffer()));
    times.push(performance.now() - t0);
    if (!answer.ok || answer.accepted.length !== n) throw new Error(`contribute at ${start}: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  }
  return {requests: times.length, p50: +quantile(times, 0.5).toFixed(1), p95: +quantile(times, 0.95).toFixed(1), largestBody: largest};
}

// Every brain gets CONTEXTS contexts from each of CONTRIBUTORS contributors
// (50 rows a request): the most feedback memory the caps allow.
async function flood() {
  const ids = [];
  for (let i = 0; i < BRAINS; i++) ids.push(await wire.brainId(vector(i + 1, DIMS.brain, 0.9)));
  const contexts = Array.from({length: CONTEXTS}, (_, c) => ({...context(c), track: `flood-${c}-`.padEnd(180, 'x')}));
  const times = [];
  for (let who = 0; who < CONTRIBUTORS; who++) {
    const token = (who + 1).toString(16).padStart(32, 'f');
    let rows = [];
    const send = async () => {
      const t0 = performance.now();
      const res = await post('/v1/contribute', wire.contributeBody({token, feedback: rows}));
      const answer = wire.parseContributeResponse(new Uint8Array(await res.arrayBuffer()));
      times.push(performance.now() - t0);
      if (!answer.ok || answer.feedbackAccepted !== rows.length) throw new Error(`feedback: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
      rows = [];
    };
    for (const id of ids) {
      for (const c of contexts) {
        rows.push(wire.feedbackToWire({id, context: c, meanFitness: 100 + who, count: 5}));
        if (rows.length === LIMITS.feedbackPerRequest) await send();
      }
    }
    if (rows.length) await send();
  }
  return {requests: times.length, rows: BRAINS * CONTEXTS * CONTRIBUTORS, p50: +quantile(times, 0.5).toFixed(1), p95: +quantile(times, 0.95).toFixed(1)};
}

async function recalls(label, count = 50) {
  const times = [];
  let bytes = 0, pool = 0;
  for (let i = 0; i < count; i++) {
    const body = wire.recallBody({trackVec: unit(10_000_000 + (i * 37) % TRACKS, DIMS.track), dynamicsVec: unit(20_000_000 + i, DIMS.dynamics), context: context(i), k: 64});
    const t0 = performance.now();
    const res = await post('/v1/recall', body);
    const data = new Uint8Array(await res.arrayBuffer());
    times.push(performance.now() - t0);
    const r = await wire.parseRecallResponse(data);
    if (!r.ok || r.dropped.length) throw new Error(`recall: ${JSON.stringify(r).slice(0, 300)}`);
    bytes = Math.max(bytes, data.length);
    pool = r.pool.length;
  }
  return {label, recalls: count, p50: +quantile(times, 0.5).toFixed(1), p95: +quantile(times, 0.95).toFixed(1), largestAnswer: bytes, pool};
}

const report = {date: new Date().toISOString(), machine: `${os.cpus()[0]?.model} (${os.cpus().length} threads)`, brains: BRAINS, tracks: TRACKS};
try {
  report.memoryEmpty = await memory();
  const t0 = performance.now();
  report.fill = await fill(0, BRAINS);
  report.fill.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  report.stats = await (await get('/v1/stats')).json();
  report.recall = await recalls('warm');
  report.memoryFull = await memory();
  if (CONTEXTS && CONTRIBUTORS) {
    const t1 = performance.now();
    report.feedback = await flood();
    report.feedback.seconds = +((performance.now() - t1) / 1000).toFixed(1);
    report.recallWithFeedback = await recalls('with feedback');
    report.memoryWithFeedback = await memory();
  }
  await dev.stop();
  dev = await startDev({port: PORT, persist, vars, env});
  const cold = performance.now();
  const first = await post('/v1/recall', wire.recallBody({trackVec: unit(10_000_000, DIMS.track), context: context(0), k: 64}));
  await first.arrayBuffer();
  report.firstRecallAfterRestartMs = +(performance.now() - cold).toFixed(1);
  report.memoryAfterRebuild = await memory();
  report.recallAfterRestart = await recalls('after restart', 20);
  if (OVER) {
    report.over = await fill(BRAINS, BRAINS + OVER);
    report.statsOver = await (await get('/v1/stats')).json();
    report.memoryOver = await memory();
  }
  console.log(JSON.stringify(report, null, 1));
} finally {
  await dev.stop();
  await rm(persist, {recursive: true, force: true});
}
