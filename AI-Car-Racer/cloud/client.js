// cloud/client.js — the browser's side of the shared cloud brain
// (docs/plan/cloud-brain.md, CB3). It knows the wire format (cloud/wire.js)
// and HTTP, nothing of the app: brains and feedback rows come in already in
// cloud terms (cloud ids), recall pools go out as parsed entries.
//
// - Push: brains and feedback wait in an outbox kept in localStorage (a
//   reload does not lose them), shared by this browser's tabs (a Web Lock
//   guards it; every change re-reads it first), sent at most every flushMs,
//   split into requests by the protocol's counts and by bytes (the counts
//   do not bound a request's size). A request holds at most one row per
//   brain and context (the service would refuse a second as a repeat; it
//   goes in the next request), and no row about a brain still waiting.
// - Pull: recall() asks for a pool for a track.
// - Verify (X1): verify() has the service drive a brain it holds on a track;
//   leaderboard() reads the fastest verified first laps.
// - Crash maps (X4): sendCrash() gives where this page's cars crashed on a
//   track (and its gate layout); recallCrashes() reads everyone's.
// - Offline: a failure backs off (1 s, doubling, to 60 s) on a monotonic
//   clock, sending and reading apart; training never waits on the network.
// Answers are read as bytes and given to wire.js's parsers as they are.
import {LIMITS, SERVICE_ERRORS, contributeBody, recallBody, verifyBody, boardQuery, parseContributeResponse, parseRecallResponse, parseErrorResponse, parseStatsResponse,
  parseVerifyResponse, parseLeaderboardResponse, crashesBody, crashRecallBody, parseCrashesResponse, parseCrashRecallResponse} from './wire.js';

export const OUTBOX_KEY = 'vv.cloudBrainOutbox';
export const TOKEN_KEY = 'vv.cloudBrainToken';
const LOCK_NAME = 'vv.cloudBrainOutbox';
// Kept while offline: the newest win (an old brain is worth less than a new one).
export const OUTBOX_LIMITS = Object.freeze({brains: 64, feedback: 200});
const BACKOFF_MS = {first: 1000, max: 60000};
const TIMEOUT_MS = 15000;
// A verification the service could not take now (busy, paused, broken):
// the next waits this long. It does not hold contributions or recalls.
export const VERIFY_WAIT_MS = 60000;

/** A contributor token: 128 random bits as hex, made once and kept. */
export function contributorToken(storage = globalThis.localStorage, random = n => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  try {
    const kept = storage?.getItem(TOKEN_KEY);
    if (/^[0-9a-f]{32}$/.test(kept || '')) return kept;
  } catch { /* storage unavailable: a token for this page only */ }
  const token = Array.from(random(16), b => b.toString(16).padStart(2, '0')).join('');
  try { storage?.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  return token;
}

const bytesOf = text => new TextEncoder().encode(text).length;
const rowKey = row => row.id + '|' + JSON.stringify(row.context);
const monotonic = () => globalThis.performance?.now?.() ?? Date.now();
// Web Locks serialize this browser's tabs; without them (Node, old browsers)
// a promise chain serializes this client's own work.
function webLock() {
  let chain = Promise.resolve();
  return (name, fn) => {
    if (globalThis.navigator?.locks) return globalThis.navigator.locks.request(name, fn);
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
}

export class CloudBrainClient {
  /**
   * endpoint: the service origin (null: unavailable, no request is ever made).
   * fetch, storage, now (a monotonic clock, ms), random, lock: injected (tests use fakes).
   */
  constructor({endpoint, token, fetch = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage, now = monotonic, random = Math.random, lock = webLock(), onStatus = null} = {}) {
    this.endpoint = endpoint ? String(endpoint).replace(/\/+$/, '') : null;
    this.token = token;
    this.fetch = fetch;
    this.storage = storage;
    this.now = now;
    this.random = random;
    this.lock = lock;
    this.onStatus = onStatus;
    // Sending and reading back off apart (a busy contribution queue does not
    // stop recalls, and a recall does not end the contributions' backoff).
    this.backoff = {send: {failures: 0, retryAt: 0, error: null}, read: {failures: 0, retryAt: 0, error: null}};
    this.flushing = null;
    this.verifyAt = 0;
    // The service has crash maps (X4; one from before them answers 404: they
    // stop for this page, and nothing backs off).
    this.crashMaps = true;
    this.saveFailed = false;
    // The service refused this page's protocol or brain format: nothing more
    // is sent until the page reloads (a newer version).
    this.outdated = false;
    this.status = {state: this.endpoint ? 'idle' : 'unavailable', brains: null, tracks: null, lastError: null, sent: 0, received: 0};
    this.outbox = this.#load();
  }

  // ─── the outbox ───────────────────────────────────────────────────────────

  #load() {
    try {
      const kept = JSON.parse(this.storage?.getItem(OUTBOX_KEY) || 'null');
      if (kept?.v === 1 && Array.isArray(kept.brains) && Array.isArray(kept.feedback)) return {brains: kept.brains, feedback: kept.feedback};
    } catch { /* a damaged outbox starts empty */ }
    // Storage that cannot be written keeps this page's outbox in memory.
    return this.saveFailed && this.outbox ? this.outbox : {brains: [], feedback: []};
  }
  #save() {
    try {
      this.storage?.setItem(OUTBOX_KEY, JSON.stringify({v: 1, ...this.outbox}));
      this.saveFailed = false;
    } catch {
      // Full: no stale copy is left to be sent again after a reload.
      this.saveFailed = true;
      try { this.storage?.removeItem(OUTBOX_KEY); } catch { /* nothing more to do */ }
    }
  }
  /** fn(outbox) with this browser's current outbox, saved after (one tab at a time). */
  #withOutbox(fn) {
    return this.lock(LOCK_NAME, async () => {
      this.outbox = this.#load();
      const result = await fn(this.outbox);
      this.#save();
      return result;
    });
  }

  /**
   * One brain for the outbox: {id (its cloud id), brain (a wire brain from
   * brainToWire, with no `track` index), track (base64 of its track
   * embedding, or null)}. A brain already waiting is not added twice.
   */
  enqueueBrain(item) {
    if (!this.endpoint || !item?.brain?.vector) return Promise.resolve(false);
    return this.#withOutbox(outbox => {
      if (outbox.brains.some(b => b.brain.vector === item.brain.vector)) return false;
      outbox.brains.push({id: typeof item.id === 'string' ? item.id : null, brain: item.brain, track: typeof item.track === 'string' ? item.track : null});
      if (outbox.brains.length > OUTBOX_LIMITS.brains) outbox.brains.splice(0, outbox.brains.length - OUTBOX_LIMITS.brains);
      return true;
    });
  }
  /** Feedback rows (feedbackToWire), each about a cloud id. */
  enqueueFeedback(rows) {
    if (!this.endpoint || !Array.isArray(rows) || !rows.length) return Promise.resolve(0);
    return this.#withOutbox(outbox => {
      outbox.feedback.push(...rows);
      if (outbox.feedback.length > OUTBOX_LIMITS.feedback) outbox.feedback.splice(0, outbox.feedback.length - OUTBOX_LIMITS.feedback);
      return rows.length;
    });
  }
  pending() {
    return {brains: this.outbox.brains.length, feedback: this.outbox.feedback.length};
  }

  /**
   * The next request: the oldest brains and rows that fit one request (at
   * most 16 brains on 4 tracks, 50 rows, 64 KB; one row per brain and
   * context; no row about a brain left waiting). Returns {body, brains,
   * feedback} (the outbox items it holds), or null when nothing can go.
   */
  nextBatch() {
    const {brains: waiting, feedback: rows} = this.outbox;
    const tracks = [], brains = [], feedback = [];
    const body = () => contributeBody({token: this.token, tracks, brains: brains.map(b => b.wire), feedback});
    const fits = () => bytesOf(body()) <= LIMITS.requestBytes;
    for (const item of waiting) {
      if (brains.length >= LIMITS.brainsPerRequest) break;
      let index = item.track === null ? null : tracks.indexOf(item.track);
      const newTrack = item.track !== null && index < 0;
      if (newTrack && tracks.length >= LIMITS.tracksPerRequest) break;
      if (newTrack) { tracks.push(item.track); index = tracks.length - 1; }
      brains.push({item, wire: index === null ? item.brain : {...item.brain, track: index}});
      if (!fits() && brains.length > 1) {
        brains.pop();
        if (newTrack) tracks.pop();
        break;
      }
    }
    const sending = new Set(brains.map(b => b.item));
    const left = new Set(waiting.filter(b => !sending.has(b) && b.id).map(b => b.id));
    const keys = new Set();
    for (const row of rows) {
      if (feedback.length >= LIMITS.feedbackPerRequest) break;
      if (left.has(row.id) || keys.has(rowKey(row))) continue;
      feedback.push(row);
      if (!fits() && feedback.length + brains.length > 1) { feedback.pop(); break; }
      keys.add(rowKey(row));
    }
    if (!brains.length && !feedback.length) return null;
    return {body: body(), brains: brains.map(b => b.item), feedback};
  }

  #drop(outbox, batch) {
    // By content: the outbox may have been re-read since the batch was made.
    const brains = new Set(batch.brains.map(b => b.brain.vector));
    const rows = new Map();
    for (const r of batch.feedback) { const k = JSON.stringify(r); rows.set(k, (rows.get(k) || 0) + 1); }
    outbox.brains = outbox.brains.filter(b => !brains.has(b.brain.vector));
    outbox.feedback = outbox.feedback.filter(r => {
      const k = JSON.stringify(r), n = rows.get(k) || 0;
      if (n > 0) { rows.set(k, n - 1); return false; }
      return true;
    });
  }

  // ─── the network ──────────────────────────────────────────────────────────

  /** The state for an error: paused, refused as out of date, or offline. */
  static stateFor(error) {
    return error === 'disabled' ? 'disabled' : error === 'brain-schema' || error === 'protocol' ? 'outdated' : 'offline';
  }
  /** Tells onStatus the current status (e.g. once, at start). */
  announce() {
    this.#set({});
  }
  #set(changes) {
    Object.assign(this.status, changes);
    const retryAt = Math.max(this.backoff.send.retryAt, this.backoff.read.retryAt);
    try { this.onStatus?.({...this.status, pending: this.pending(), retryIn: Math.max(0, retryAt - this.now())}); } catch { /* the UI's problem */ }
  }
  #ok(channel) {
    const clear = {failures: 0, retryAt: 0, error: null};
    this.backoff[channel] = {...clear};
    // The network is back for both; a refusal or a busy service on the other
    // side still waits out its own backoff.
    const otherName = channel === 'send' ? 'read' : 'send', other = this.backoff[otherName];
    if (other.error === 'network') this.backoff[otherName] = {...clear};
    const still = this.backoff[otherName].failures ? this.backoff[otherName].error : null;
    this.#set({state: still ? CloudBrainClient.stateFor(still) : 'online', lastError: still});
  }
  #failed(channel, error) {
    if (error === 'protocol' || error === 'brain-schema') this.outdated = true;
    // A network failure holds both: nothing gets through.
    for (const name of error === 'network' ? ['send', 'read'] : [channel]) {
      const b = this.backoff[name];
      b.failures++;
      // A refusal (busy, paused) outlasts a network failure on top of it:
      // only its own success clears it.
      if (!(error === 'network' && b.error && b.error !== 'network')) b.error = error;
      const delay = Math.min(BACKOFF_MS.max, BACKOFF_MS.first * 2 ** (b.failures - 1));
      b.retryAt = this.now() + delay * (0.8 + 0.4 * this.random());
    }
    this.#set({state: this.outdated ? 'outdated' : CloudBrainClient.stateFor(error), lastError: error});
  }
  /** False while that channel backs off, once outdated, or with no endpoint: no request is made. */
  canTry(channel = 'send') {
    return !!this.endpoint && !this.outdated && this.now() >= this.backoff[channel].retryAt;
  }
  get retryAt() {
    return Math.max(this.backoff.send.retryAt, this.backoff.read.retryAt);
  }

  /** POST or GET; the answer as bytes, or {error: 'network'}. */
  async #request(path, body) {
    try {
      const response = await this.fetch(this.endpoint + path, {
        method: body === undefined ? 'GET' : 'POST',
        body,
        headers: body === undefined ? undefined : {'Content-Type': 'text/plain'},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {status: response.status, bytes: new Uint8Array(await response.arrayBuffer())};
    } catch (e) {
      return {error: 'network', message: String(e?.message || e)};
    }
  }

  /**
   * Sends what waits, request by request, until the outbox is empty or a
   * request fails (then it backs off and keeps the rest). One flush at a
   * time in this tab, and the outbox is this tab's while it runs.
   */
  flush() {
    if (!this.flushing) this.flushing = this.#withOutbox(outbox => this.#flush(outbox)).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async #flush(outbox) {
    let sent = 0;
    while (this.canTry('send')) {
      const batch = this.nextBatch();
      if (!batch) break;
      const answer = await this.#request('/v1/contribute', batch.body);
      if (answer.error) { this.#failed('send', answer.error); break; }
      if (answer.status === 200) {
        const r = parseContributeResponse(answer.bytes);
        // Refused items (a bad brain, a row about an evicted brain) would be
        // refused again: every item of the batch leaves the outbox.
        this.#drop(outbox, batch);
        this.#save();
        if (!r.ok) { this.#failed('send', 'bad-answer'); break; }
        sent += batch.brains.length + batch.feedback.length;
        this.#set({sent: this.status.sent + batch.brains.length});
        this.#ok('send');
        continue;
      }
      const {error} = parseErrorResponse(answer.bytes);
      // The service is paused, busy or broken, or refuses this version of
      // the page: keep the batch (a newer page may send it).
      if (answer.status >= 500 || answer.status === 429 || SERVICE_ERRORS.includes(error) || error === 'protocol' || error === 'brain-schema') {
        this.#failed('send', error);
        break;
      }
      // The service refuses the request itself (it would refuse it again).
      this.#drop(outbox, batch);
      this.#save();
      this.#set({lastError: error});
    }
    return sent;
  }

  /**
   * A pool for this track: entries {id, vector, meta, fitness, score,
   * trackSim, feedback} (wire.js parseRecallResponse), or null (offline,
   * backing off, or refused: a refusal backs off too, so it is not repeated
   * every few seconds).
   */
  async recall({trackVec, dynamicsVec = null, context, k = LIMITS.recallDefaultK}) {
    if (!this.canTry('read') || !trackVec) return null;
    const answer = await this.#request('/v1/recall', recallBody({trackVec, dynamicsVec, context, k}));
    if (answer.error) { this.#failed('read', answer.error); return null; }
    if (answer.status !== 200) { this.#failed('read', parseErrorResponse(answer.bytes).error); return null; }
    const r = await parseRecallResponse(answer.bytes);
    if (!r.ok) { this.#failed('read', 'bad-answer'); return null; }
    this.#set({received: this.status.received + r.pool.length});
    this.#ok('read');
    return r.pool;
  }

  /**
   * POST /v1/verify (X1): the service drives a brain it holds on `track`
   * ({width, height, inner, outer, checkpoints}) in `context`, from the
   * start pose it finds from the gates. Returns the answer (wire.js
   * parseVerifyResponse), {error} when the service refuses this
   * verification (asking again would not help, except 'brain-unknown'
   * while it does not hold the brain yet), or null (offline, waiting, or
   * busy: try later).
   */
  async verify({vector, track, context}) {
    if (!this.canTry('send') || this.now() < this.verifyAt) return null;
    const answer = await this.#request('/v1/verify', verifyBody({token: this.token, vector, track, context}));
    if (answer.error) { this.#failed('send', answer.error); return null; }
    const wait = () => { this.verifyAt = this.now() + VERIFY_WAIT_MS * (0.8 + 0.4 * this.random()); return null; };
    if (answer.status === 200) {
      const r = parseVerifyResponse(answer.bytes);
      return r.ok ? r : wait();
    }
    const {error} = parseErrorResponse(answer.bytes);
    if (error === 'protocol' || error === 'brain-schema') { this.#failed('send', error); return null; }
    if (answer.status >= 500 || answer.status === 429 || SERVICE_ERRORS.includes(error)) return wait();
    return {error};
  }

  /**
   * GET /v1/leaderboard (X1): {track, maxSpeed, traction, entries: [{id,
   * lapFrames, laps, fitness, profile, verified}]} (wire.js
   * parseLeaderboardResponse), or null.
   */
  async leaderboard({track, maxSpeed, traction}) {
    if (!this.canTry('read')) return null;
    const answer = await this.#request('/v1/leaderboard?' + boardQuery({track, maxSpeed, traction}));
    if (answer.error) { this.#failed('read', answer.error); return null; }
    if (answer.status !== 200) { this.#failed('read', parseErrorResponse(answer.bytes).error); return null; }
    const r = parseLeaderboardResponse(answer.bytes);
    if (!r.ok) { this.#failed('read', 'bad-answer'); return null; }
    this.#ok('read');
    return r;
  }

  /**
   * POST /v1/crashes (X4): a crash map for a track ({track (unit), map (144,
   * length 1), deaths, collisions, layout ({geometry, survival, gates}) or
   * null}). True when kept; false when refused or not sent (offline, backing
   * off: the next map goes instead, nothing waits).
   */
  async sendCrash(crash) {
    if (!this.crashMaps || !this.canTry('send')) return false;
    const answer = await this.#request('/v1/crashes', crashesBody({token: this.token, ...crash}));
    if (answer.error) { this.#failed('send', answer.error); return false; }
    if (answer.status === 200) return parseCrashesResponse(answer.bytes).accepted === true;
    if (answer.status === 404) { this.crashMaps = false; return false; }
    const {error} = parseErrorResponse(answer.bytes);
    if (answer.status >= 500 || answer.status === 429 || SERVICE_ERRORS.includes(error) || error === 'protocol') this.#failed('send', error);
    return false;
  }

  /**
   * POST /v1/crashes/recall (X4): {map (144 numbers, or null), contributors,
   * tracks, layouts: [{gates, survival}]} near a track, or null.
   */
  async recallCrashes({track, collisions = 'off', geometry = null}) {
    if (!this.crashMaps || !this.canTry('read') || !track) return null;
    const answer = await this.#request('/v1/crashes/recall', crashRecallBody({track, collisions, geometry}));
    if (answer.error) { this.#failed('read', answer.error); return null; }
    if (answer.status === 404) { this.crashMaps = false; return null; }
    if (answer.status !== 200) { this.#failed('read', parseErrorResponse(answer.bytes).error); return null; }
    const r = parseCrashRecallResponse(answer.bytes);
    if (!r.ok) { this.#failed('read', 'bad-answer'); return null; }
    this.#ok('read');
    return r;
  }

  /** GET /v1/stats: {brains, tracks, contributorsToday, contributions24h}, or null. */
  async stats() {
    if (!this.canTry('read')) return null;
    const answer = await this.#request('/v1/stats');
    if (answer.error) { this.#failed('read', answer.error); return null; }
    if (answer.status !== 200) { this.#failed('read', parseErrorResponse(answer.bytes).error); return null; }
    const r = parseStatsResponse(answer.bytes);
    if (!r.ok) { this.#failed('read', 'bad-answer'); return null; }
    this.#set({brains: r.brains, tracks: r.tracks});
    this.#ok('read');
    return r;
  }
}
