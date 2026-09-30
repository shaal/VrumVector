// A fake of the shared cloud brain service for tests (CB3): the CB1 wire
// format through wire.js's own request parsers, and answers the browser's
// answer parsers accept. Much simpler than the real service (cloud-brain/):
// a recall returns the brains on the query's exact track (every brain when
// none is on it), best fitness first; feedback is counted per brain and
// context. `down` simulates the network ('offline': fetch throws;
// 'disabled': 503; 'error': 500; 'busy': 429).
import * as wire from '../../AI-Car-Racer/cloud/wire.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const error = reason => json({protocol: wire.PROTOCOL, error: reason}, wire.httpStatus(reason));

export function createFakeCloudBrain() {
  const brains = new Map(); // id → {vector, fitness, track, meta, feedback: Map}
  const fake = {
    brains,
    requests: [],
    down: null,
    /** {recall, contribute}: a reason to refuse that route with (tests of backoff). */
    refuse: {},
    contributors: new Set(),
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
      if (path === '/v1/contribute' && init.method === 'POST') return contribute(body);
      if (path === '/v1/recall' && init.method === 'POST') return recall(body);
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
