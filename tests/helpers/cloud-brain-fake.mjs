// A fake of the shared cloud brain service for tests (CB3): the CB1 wire
// format through wire.js's own request parsers, and answers the browser's
// answer parsers accept. Much simpler than the real service (cloud-brain/):
// a recall returns the brains on the query's exact track (every brain when
// none is on it), best fitness first; feedback is counted per brain and
// context. `down` simulates the network ('offline': fetch throws;
// 'disabled': 503; 'error': 500; 'busy': 429). A verification (X1) does not
// drive the car: its outcome is `verifyOutcome(v)` (by default one lap in
// 10 s), kept per brain, track and physics for the leaderboard. Crash maps
// (X4) are kept per contributor, exact track and mode (with their best
// layout); a recall sums those on the query's track and gives their layouts
// for the walls, the best survival first. `noCrashes`: a service from before
// X4 (its crash routes answer 404).
import * as wire from '../../AI-Car-Racer/cloud/wire.js';
import {geometryKey} from '../../AI-Car-Racer/graphics/state.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const error = reason => json({protocol: wire.PROTOCOL, error: reason}, wire.httpStatus(reason));

export function createFakeCloudBrain() {
  const brains = new Map(); // id → {vector, fitness, track, meta, feedback: Map}
  const fake = {
    brains,
    requests: [],
    down: null,
    /** {recall, contribute, verify, leaderboard}: a reason to refuse that route with (tests of backoff). */
    refuse: {},
    contributors: new Set(),
    /** Verified runs: {id, track, profile, maxSpeed, traction, seconds, laps, lapFrames, fitness, created}. */
    verified: [],
    /** Crash maps and layouts sent (X4): {token, track (its id), map, deaths, collisions, layout}. */
    crashes: [],
    /** The outcome of a verification: {laps, lapFrames, fitness, crashedAt, frames}. */
    verifyOutcome: v => ({laps: 1, lapFrames: [600], fitness: v.geometry.checkpoints.length, crashedAt: null, frames: Math.floor(v.context.seconds * 60)}),
    /** Adds brains directly: [{vector, fitness, track (Float32Array|null), meta}]. */
    async seed(items) {
      for (const item of items) {
        const id = await wire.brainId(item.vector);
        brains.set(id, {vector: Float32Array.from(item.vector), fitness: item.fitness, track: item.track ? await wire.brainId(item.track) : null, meta: wire.cleanBrainMeta(item.meta || {}), feedback: new Map()});
      }
    },
    /** fetch(url, init) for the client under test. */
    async fetch(url, init = {}) {
      const path = new URL(url).pathname;
      const body = init.body === undefined ? null : new TextEncoder().encode(String(init.body));
      fake.requests.push({path, bytes: body ? body.length : 0, body: body ? new TextDecoder().decode(body) : null});
      if (fake.down === 'offline') throw new TypeError('Failed to fetch');
      if (fake.down === 'disabled') return error('disabled');
      if (fake.down === 'error') return error('server-error');
      if (fake.down === 'busy') return error('rate-limited');
      if (path === '/v1/contribute' && fake.refuse.contribute) return error(fake.refuse.contribute);
      if (path === '/v1/recall' && fake.refuse.recall) return error(fake.refuse.recall);
      if (path === '/v1/verify' && fake.refuse.verify) return error(fake.refuse.verify);
      if (path === '/v1/leaderboard' && fake.refuse.leaderboard) return error(fake.refuse.leaderboard);
      if (path === '/v1/contribute' && init.method === 'POST') return contribute(body);
      if (path === '/v1/recall' && init.method === 'POST') return recall(body);
      if (path === '/v1/verify' && init.method === 'POST') return verify(body);
      if (path === '/v1/leaderboard') return leaderboard(new URL(url).search.slice(1));
      if (path.startsWith('/v1/crashes') && fake.noCrashes) return new Response('Not found', {status: 404});
      if (path === '/v1/crashes' && fake.refuse.crashes) return error(fake.refuse.crashes);
      if (path === '/v1/crashes' && init.method === 'POST') return crashes(body);
      if (path === '/v1/crashes/recall' && init.method === 'POST') return crashRecall(body);
      if (path === '/v1/stats') return json({protocol: wire.PROTOCOL, brains: brains.size, tracks: new Set([...brains.values()].map(b => b.track).filter(Boolean)).size, contributorsToday: fake.contributors.size, contributions24h: fake.requests.filter(r => r.path === '/v1/contribute').length});
      return new Response('Not found', {status: 404});
    },
  };

  async function contribute(bytes) {
    const c = await wire.parseContribute(bytes);
    if (!c.ok) return error(c.error);
    fake.contributors.add(c.token);
    const tracks = await Promise.all(c.tracks.map(t => wire.brainId(t)));
    const accepted = [];
    for (const b of c.brains) {
      accepted.push(b.id);
      if (!brains.has(b.id)) brains.set(b.id, {vector: b.vector, fitness: b.fitness, track: b.track === null ? null : tracks[b.track], meta: b.meta, feedback: new Map()});
    }
    const feedbackRejected = [...c.feedbackRejected];
    let feedbackAccepted = 0;
    const seen = new Set();
    c.feedback.forEach((row, i) => {
      const brain = brains.get(row.id), key = JSON.stringify(row.context);
      // The index of this row in the request: the parser keeps accepted rows in order.
      const index = indexOf(c, i);
      if (!brain) { feedbackRejected.push({index, reason: 'feedback-unknown'}); return; }
      if (seen.has(row.id + key)) { feedbackRejected.push({index, reason: 'feedback-duplicate'}); return; }
      seen.add(row.id + key);
      const f = brain.feedback.get(key) || {weight: 0, count: 0, contributors: new Set()};
      f.weight = 0.3 * Math.max(-1, Math.min(1, (row.meanFitness - brain.fitness) / Math.max(1, Math.abs(brain.fitness)))) + 0.7 * f.weight;
      f.count++;
      f.contributors.add(c.token);
      brain.feedback.set(key, f);
      feedbackAccepted++;
    });
    feedbackRejected.sort((a, b) => a.index - b.index);
    return json({protocol: wire.PROTOCOL, accepted, rejected: c.rejected, feedbackAccepted, feedbackRejected});
  }

  // The accepted row i's index in the request (rows refused by the parser are skipped).
  function indexOf(c, i) {
    const refused = new Set(c.feedbackRejected.map(r => r.index));
    let seen = -1;
    for (let index = 0; ; index++) {
      if (refused.has(index)) continue;
      if (++seen === i) return index;
    }
  }

  async function recall(bytes) {
    const r = await wire.parseRecall(bytes);
    if (!r.ok) return error(r.error);
    const track = await wire.brainId(r.track), key = JSON.stringify(r.context);
    const all = [...brains.entries()];
    const onTrack = all.filter(([, b]) => b.track === track);
    const pool = (onTrack.length ? onTrack : all).sort((a, b) => b[1].fitness - a[1].fitness).slice(0, r.k).map(([id, b], i) => {
      const f = b.feedback.get(key);
      return {id, vector: wire.encodeF32(b.vector), fitness: b.fitness, score: 1 - i / 100, meta: b.meta, trackSim: onTrack.length ? 1 : 0,
        feedback: {weight: f ? f.weight : 0, count: f ? f.count : 0, contributors: f ? f.contributors.size : 0}};
    });
    return json({protocol: wire.PROTOCOL, brainSchema: wire.BRAIN_SCHEMA, pool});
  }

  async function verify(bytes) {
    const v = await wire.parseVerify(bytes);
    if (!v.ok) return error(v.error);
    if (!brains.has(v.id)) return error('brain-unknown');
    const point = ([x, y]) => ({x, y});
    const track = geometryKey({innerList: v.geometry.inner.map(point), outerList: v.geometry.outer.map(point), checkPointList: v.geometry.checkpoints.map(g => g.map(point))});
    const outcome = fake.verifyOutcome(v);
    const run = {id: v.id, track, profile: v.context.profile, maxSpeed: v.context.maxSpeed, traction: v.context.traction, seconds: v.context.seconds, ...outcome, created: fake.verified.length + 1};
    fake.verified = fake.verified.filter(r => !(r.id === run.id && r.track === track && r.profile === run.profile && r.maxSpeed === run.maxSpeed && r.traction === run.traction && r.seconds === run.seconds));
    fake.verified.push(run);
    return json({protocol: wire.PROTOCOL, id: v.id, track, matched: track === v.context.track, ...outcome});
  }

  function leaderboard(query) {
    const b = wire.parseBoard(query);
    if (!b.ok) return error(b.error);
    const seen = new Set();
    const entries = fake.verified.filter(r => r.track === b.track && r.maxSpeed === b.maxSpeed && r.traction === b.traction && r.laps > 0 && brains.has(r.id))
      .sort((x, y) => x.lapFrames[0] - y.lapFrames[0] || y.fitness - x.fitness || x.created - y.created)
      .filter(r => !seen.has(r.id) && seen.add(r.id)) // a brain once, at its best run
      .slice(0, wire.LIMITS.boardSize)
      .map(r => ({id: r.id, lapFrames: r.lapFrames[0], laps: r.laps, fitness: r.fitness, profile: r.profile, verified: r.created}));
    return json({protocol: wire.PROTOCOL, track: b.track, maxSpeed: b.maxSpeed, traction: b.traction, entries});
  }

  async function crashes(bytes) {
    const c = wire.parseCrashes(bytes);
    if (!c.ok) return error(c.error);
    const track = await wire.brainId(c.track);
    const mine = r => r.token === c.token && r.track === track && r.collisions === c.collisions;
    const held = fake.crashes.find(mine)?.layout || null;
    const layout = held && (!c.layout || c.layout.survival < held.survival) ? held : c.layout;
    fake.crashes = fake.crashes.filter(r => !mine(r));
    fake.crashes.push({token: c.token, track, map: c.map, deaths: c.deaths, collisions: c.collisions, layout});
    return json({protocol: wire.PROTOCOL, accepted: true});
  }

  async function crashRecall(bytes) {
    const r = wire.parseCrashRecall(bytes);
    if (!r.ok) return error(r.error);
    const track = await wire.brainId(r.track);
    const here = fake.crashes.filter(c => c.track === track && c.collisions === r.collisions);
    const sum = new Float64Array(wire.CRASH_DIM);
    for (const c of here) c.map.forEach((x, i) => { sum[i] += x; });
    const norm = Math.hypot(...sum);
    const layouts = here.filter(c => c.layout && c.layout.geometry === r.geometry)
      .sort((a, b) => b.layout.survival - a.layout.survival).slice(0, wire.LIMITS.crashLayouts).map(c => ({gates: c.layout.gates, survival: c.layout.survival}));
    return json({protocol: wire.PROTOCOL, map: norm > 0 ? wire.encodeF32(Float32Array.from(sum, x => x / norm)) : null,
      contributors: new Set(here.map(c => c.token)).size, tracks: here.length ? 1 : 0, layouts});
  }

  return fake;
}

/** A Playwright route handler serving `fake` (for page.route(endpoint + '/**', ...)). */
export function routeTo(fake, origin) {
  return async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type'}});
    let response;
    try {
      response = await fake.fetch(request.url(), {method: request.method(), body: request.postData() ?? undefined});
    } catch {
      return route.abort('connectionrefused');
    }
    return route.fulfill({status: response.status, body: Buffer.from(await response.arrayBuffer()),
      headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin}});
  };
}
