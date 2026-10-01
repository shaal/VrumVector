// cloud/session.js — the Shared brain mode, wired into the app
// (docs/plan/cloud-brain.md, CB3). index.html starts it once the bridge is
// ready, in both modes: it mounts the Memory control in the Vector Memory
// panel, and in shared mode it connects the bridge to the cloud client.
//
// In shared mode the bridge learns into its own IndexedDB replica
// (rv_car_learning_shared), so recommendSeeds stays synchronous and local
// ranking keeps working; this session keeps that replica in step with the
// cloud:
// - brains the bridge archives, and offspring feedback, are queued with their
//   cloud ids (SHA-256 of the weights) and pushed at most every 10 s;
// - a pool for the current track is pulled when the page starts, when the
//   track changes, and every few generations, and enters the replica;
// - a brain that drove a lap is verified once it is sent (X1): the service
//   drives it on the page's walls and gates, alone, from main.js's start; the
//   leaderboard for the track and physics is read every minute and after a
//   verification;
// - the champion (X3): the fastest verified brain the last pull brought, or
//   the pool's best, can race you as a ghost (cloud/ghost.js);
// - crash maps (X4): where this page's cars crash (and the gate layout
//   adaptive gates settled on) goes to everyone's crash map, at most one a
//   minute; with each pull, everyone's map for this track and the layouts
//   shared for its walls come back (an overlay; adaptive gates' candidates).
import {brainToWire, feedbackToWire, brainId, encodeF32, trackGeometry, boardQuery, parseBoard, isGeometrySig, isUnit, CRASH_DIM, DIMS, LIMITS} from './wire.js';
import {CloudBrainClient, contributorToken} from './client.js';
import {saveBrainMode, consented, consentedBefore} from './mode.js';
import {mountMemoryControl, ARRIVAL_DISCLOSURE, CHANGED_DISCLOSURE} from './ui.js';
import {Ghost, chooseChampion} from './ghost.js';
import {CrashOverlay} from './crashOverlay.js';
import {geometryKey} from '../graphics/state.js';

export const FLUSH_MS = 10_000;
const STATS_MS = 60_000;
const TRACK_POLL_MS = 5_000;
/** A pull every this many generations (and on a new track). */
export const PULL_EVERY = 5;
/** Brains waiting for a verification (the fastest laps are kept). */
export const VERIFY_QUEUE = 4;
/** Times the service may not hold a brain yet (another tab may still be sending it). */
export const VERIFY_TRIES = 3;
/** The leaderboard is read again after this long (and after a verification). */
export const BOARD_MS = 60_000;
/** A crash map is sent at most this often (the latest waits; X4). */
export const CRASH_SEND_MS = 60_000;

/**
 * A crash map the bridge archived ({map, meta}), as POST /v1/crashes takes
 * it on this track (`trackVec`), or null: the map as made (144 non-negative
 * numbers of length 1), its deaths, its collision mode, and the layout it
 * was measured with when it reads (the walls' signature `meta.walls`, the
 * same with adaptive gates on or off; gates; survival).
 */
export function crashToWire({map, meta = {}}, trackVec) {
  const track = unit(trackVec);
  if (!track || track.length !== DIMS.track || !(map instanceof Float32Array) || map.length !== CRASH_DIM) return null;
  if (!map.every(x => Number.isFinite(x) && x >= 0) || !isUnit(map)) return null;
  const deaths = Math.round(Number(meta.nDeaths));
  if (!(deaths >= LIMITS.crashDeaths[0] && deaths <= LIMITS.crashDeaths[1])) return null;
  let layout = null;
  const cps = meta.cps, survival = Number(meta.survival);
  if (Array.isArray(cps) && cps.length >= 1 && cps.length <= LIMITS.gates && isGeometrySig(meta.walls) && survival >= 0 && survival <= 1) {
    const gates = cps.map(g => (Array.isArray(g) && g.length === 2 ? g.map(p => [p?.x, p?.y]) : null));
    if (gates.every(g => g && g.flat().every(v => Number.isFinite(v) && Math.abs(v) <= LIMITS.coordinate))) layout = {geometry: meta.walls, survival, gates};
  }
  return {track, map, deaths, collisions: typeof meta.collisions === 'string' ? meta.collisions : 'off', layout};
}

/** The key the service gives a verification's track (wire.rs geometry_key). */
export function trackKeyOf(track) {
  const point = ([x, y]) => ({x, y});
  return geometryKey({innerList: track.inner.map(point), outerList: track.outer.map(point), checkPointList: track.checkpoints.map(g => g.map(point))});
}

/** v scaled to length 1 (the wire needs unit vectors), or null. */
export function unit(v) {
  if (!v || !v.length) return null;
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  return Float32Array.from(v, x => x / norm);
}

/**
 * cloud/config.json: {endpoint} (null on a deployment without the service, or
 * when it cannot be read after `retries` more tries, `waitMs` apart).
 */
export async function loadConfig(fetchImpl = globalThis.fetch?.bind(globalThis), url = new URL('./config.json', import.meta.url), {retries = 0, waitMs = [3000, 10000]} = {}) {
  for (let attempt = 0; ; attempt++) {
    const config = await readConfig(fetchImpl, url);
    if (config.endpoint || config.read || attempt >= retries) return {endpoint: config.endpoint};
    await new Promise(r => setTimeout(r, waitMs[Math.min(attempt, waitMs.length - 1)]));
  }
}
async function readConfig(fetchImpl, url) {
  let config;
  try {
    const response = await fetchImpl(url, {cache: 'no-store', signal: AbortSignal.timeout(7000)});
    config = await response.json();
  } catch {
    return {endpoint: null, read: false};
  }
  try {
    if (typeof config?.endpoint !== 'string') return {endpoint: null, read: true};
    const endpoint = new URL(config.endpoint);
    const local = ['localhost', '127.0.0.1'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) return {endpoint: null, read: true};
    return {endpoint: endpoint.origin, read: true};
  } catch {
    return {endpoint: null, read: true};
  }
}

/**
 * The bridge and the client, kept in step. `bridge` is ruvectorBridge.js (or
 * a fake with the same functions); `page` gives the current track vector,
 * dynamics query vector and learning context.
 */
export class SharedSession {
  constructor({bridge, client, page, setInterval: every = globalThis.setInterval?.bind(globalThis), clearInterval: stop = globalThis.clearInterval?.bind(globalThis)}) {
    this.bridge = bridge;
    this.client = client;
    this.page = page;
    this.every = every;
    this.stop_ = stop;
    this.timers = [];
    this.pulledTrack = null;
    this.pulledGeneration = null;
    this.pulling = null;
    this.pulls = 0;
    this.accepted = 0;
    this.pending = new Set(); // queueing work in flight (tests await it)
    this.verifications = []; // brains waiting for a verification, the fastest lap first
    this.verifying = null;
    this.verified = []; // the service's answers, newest last (up to VERIFY_QUEUE)
    this.mine = new Set(); // ids this page had verified
    this.board = null;
    this.boardKey = null;
    this.boardAt = -Infinity;
    this.boardSeq = 0;
    this.stopped = false;
    this.onBoard = null; // (board or null, {mine, last}) when the leaderboard is read or no longer this page's
    this.pool = []; // the last pull's entries (X3: the champion is among them)
    this.champion = null;
    this.onChampion = null; // (champion or null) when it changes
    this.crash = null; // the latest crash map waiting to be sent (X4)
    this.crashSentAt = -Infinity;
    this.crashSending = false;
    this.crashesSent = 0;
    this.sharedCrash = null; // everyone's crash map for this track and its layouts
    this.sharedCrashAbout = null; // the walls and collision mode it is for
    this.onCrashMap = null; // (shared or null) when it is read
  }

  start() {
    this.bridge.setCloudHooks({
      onArchive: entry => this.#track(this.pushBrain(entry)),
      onFeedback: rows => this.#track(this.pushFeedback(rows)),
      onCrash: crash => this.queueCrash(crash),
    });
    if (this.every) {
      this.timers.push(this.every(() => this.#track(this.tick()), FLUSH_MS));
      this.timers.push(this.every(() => this.poll(), TRACK_POLL_MS));
      this.timers.push(this.every(() => this.client.stats(), STATS_MS));
    }
    this.client.announce();
    this.client.stats();
    this.refreshBoard();
    return this.maybePull();
  }
  /** Every few seconds: a pull when due, and, once a retry is due, a try. */
  poll() {
    if (this.client.status.state !== 'online' && this.client.canTry('read')) this.client.stats();
    this.refreshBoard();
    return this.maybePull();
  }
  /** Every FLUSH_MS: what waits is sent, then a brain that drove a lap is verified, then a crash map. */
  async tick() {
    await this.client.flush();
    const verified = await this.verifyNext();
    await this.sendCrash();
    return verified;
  }

  /** A crash map the bridge archived: it waits, the latest replacing the one before (X4). */
  queueCrash(crash) {
    let trackVec = null;
    try { trackVec = this.page.trackVec(); } catch { /* no track */ }
    const wire = crashToWire(crash || {}, trackVec);
    if (wire) this.crash = wire;
    return !!wire;
  }

  /** The waiting crash map, at most one every CRASH_SEND_MS (one request at a time). */
  async sendCrash() {
    if (this.crashSending || !this.crash || this.client.now() - this.crashSentAt < CRASH_SEND_MS) return false;
    const crash = this.crash;
    this.crashSending = true;
    try {
      const sent = await this.client.sendCrash(crash);
      if (sent) this.crashesSent++;
      if (sent || this.client.canTry('send')) {
        // Sent, or refused for good: it no longer waits.
        if (this.crash === crash) this.crash = null;
        this.crashSentAt = this.client.now();
      }
      return sent;
    } finally {
      this.crashSending = false;
    }
  }

  #geometrySig() {
    try {
      const g = this.page.geometrySig?.();
      return isGeometrySig(g) ? g : null;
    } catch { return null; }
  }

  /** Everyone's crash map, once these are not the walls and mode it is for, goes (X4). */
  #crashesFor(geometry, collisions) {
    const about = (geometry || '') + '|' + collisions;
    if (about === this.sharedCrashAbout) return;
    this.sharedCrashAbout = about;
    if (!this.sharedCrash) return;
    this.sharedCrash = null;
    try { this.bridge.acceptSharedCrash?.(null); } catch (e) { console.warn('[cloud-brain]', e); }
    try { this.onCrashMap?.(null); } catch { /* the UI's problem */ }
  }

  /** Everyone's crash map for this track and the layouts for its walls (after a pull). */
  async pullCrashes(trackVec, context) {
    const geometry = this.#geometrySig();
    const collisions = context?.collisions || 'off';
    this.#crashesFor(geometry, collisions);
    const shared = await this.client.recallCrashes({track: unit(trackVec), collisions, geometry});
    // Another track or mode came while it was asked for: not this one's.
    if (!shared || this.sharedCrashAbout !== (geometry || '') + '|' + collisions) return null;
    this.sharedCrash = shared;
    try { this.bridge.acceptSharedCrash?.(shared, {geometry, collisions}); } catch (e) { console.warn('[cloud-brain]', e); }
    try { this.onCrashMap?.(shared); } catch { /* the UI's problem */ }
    return shared;
  }
  stop() {
    this.stopped = true;
    this.bridge.setCloudHooks(null);
    for (const t of this.timers) this.stop_?.(t);
    this.timers = [];
  }
  #track(promise) {
    this.pending.add(promise);
    promise.catch(e => console.warn('[cloud-brain]', e)).finally(() => this.pending.delete(promise));
    return promise;
  }
  /** Resolves once queued brains and rows are in the outbox. */
  async settled() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** A local archive id → its cloud id, from its weights (null if not held). */
  async cloudId(localId) {
    const v = this.bridge.brainVector(localId);
    return v ? brainId(v) : null;
  }

  /** A brain the bridge archived (not one it pulled): into the outbox. */
  async pushBrain({vector, fitness, trackVec, dynamicsVec, meta = {}}) {
    const parents = [];
    for (const id of (meta.parentIds || []).slice(0, LIMITS.parentIds)) {
      const cloud = await this.cloudId(id);
      if (cloud) parents.push(cloud);
    }
    const learning = meta.learningContext ? {context: meta.learningContext, styleScore: meta.styleScore, driving: meta.driving} : undefined;
    const brain = brainToWire({
      vector, fitness, dynamicsVec: unit(dynamicsVec),
      meta: {generation: meta.generation, parentIds: parents, fastestLap: meta.fastestLap, source: meta.source || 'evolved', learning},
    });
    const track = unit(trackVec), id = await brainId(vector);
    const queued = await this.client.enqueueBrain({id, brain, track: track && track.length === DIMS.track ? encodeF32(track) : null});
    this.queueVerification({vector, meta}, id);
    return queued;
  }

  /**
   * A brain that drove a lap here (X1), kept for a verification with the
   * page's walls and gates, when they are the track it learned on (its
   * context's key). The service runs a context alone: not with car
   * collisions, nor longer than 120 s. Returns whether it waits.
   */
  queueVerification({vector, meta = {}}, id) {
    const context = meta.learningContext;
    if (!(meta.fastestLap > 0) || !context || context.collisions !== 'off' || !(context.seconds <= LIMITS.verifySeconds)) return false;
    if (this.verifications.some(v => v.id === id) || this.mine.has(id)) return false;
    let track = null;
    try { track = trackGeometry(this.page.geometry?.()); } catch { /* no track */ }
    if (!track || trackKeyOf(track) !== context.track) return false;
    const item = {id, vector: Float32Array.from(vector), track, context, lap: meta.fastestLap, tries: 0};
    this.verifications.push(item);
    this.verifications.sort((a, b) => a.lap - b.lap);
    this.verifications.length = Math.min(this.verifications.length, VERIFY_QUEUE);
    return this.verifications.includes(item);
  }

  /**
   * The fastest lap waiting, once sent (a brain still in the outbox waits),
   * verified: one a call, so the flush timer's every 10 s stays within the
   * service's 6 a minute. Returns the service's answer, {error}, or null.
   */
  verifyNext() {
    if (this.verifying) return this.verifying;
    const unsent = new Set(this.client.outbox.brains.map(b => b.id));
    const item = this.verifications.find(v => !unsent.has(v.id));
    if (!item) return Promise.resolve(null);
    const done = () => { this.verifications = this.verifications.filter(v => v !== item); };
    this.verifying = (async () => {
      const r = await this.client.verify(item);
      if (!r) return null; // offline or busy: it waits
      if (r.error) {
        // Not held yet, or never: a few more tries, then it goes.
        if (r.error !== 'brain-unknown' || ++item.tries >= VERIFY_TRIES) done();
        return r;
      }
      done();
      this.mine.add(r.id);
      this.verified = [...this.verified, r].slice(-VERIFY_QUEUE);
      await this.refreshBoard({force: true});
      return r;
    })().finally(() => { this.verifying = null; });
    return this.verifying;
  }

  /**
   * The leaderboard for the current track and physics: read when they
   * change, after BOARD_MS, or when forced (after a verification).
   */
  async refreshBoard({force = false} = {}) {
    if (this.stopped) return null;
    let context = null;
    try { context = this.page.context(); } catch { /* none yet */ }
    const query = context && {track: context.track, maxSpeed: context.maxSpeed, traction: context.traction};
    const key = query && parseBoard(boardQuery(query)).ok ? boardQuery(query) : null;
    // Another track or physics (or none): the board shown is not this one's.
    if (key !== this.boardKey && this.board) this.#show(null);
    if (!key) { this.boardKey = null; return null; }
    if (!force && key === this.boardKey && this.client.now() - this.boardAt < BOARD_MS) return this.board;
    // One read a key a minute; a change, or a force, reads again. Only the
    // latest read is shown (an earlier one may answer after it).
    const seq = ++this.boardSeq;
    this.boardKey = key;
    this.boardAt = this.client.now();
    const board = await this.client.leaderboard(query);
    if (!board || seq !== this.boardSeq || this.stopped) return null;
    this.#show(board);
    return board;
  }
  #show(board) {
    this.board = board;
    try { this.onBoard?.(board, {mine: this.mine, last: this.verified.at(-1) || null}); } catch { /* the UI's problem */ }
    this.#pickChampion();
  }
  /** The champion (X3) for this track, from the board and the last pool; told when it changes. */
  #pickChampion() {
    let track = null;
    try { track = this.page.context()?.track || null; } catch { /* none yet */ }
    const champion = chooseChampion(this.board, this.pool, track);
    if (champion?.id === this.champion?.id && champion?.lapFrames === this.champion?.lapFrames) return;
    this.champion = champion;
    try { this.onChampion?.(champion); } catch { /* the UI's problem */ }
  }

  /** Offspring feedback the bridge applied: into the outbox, as cloud ids. */
  async pushFeedback(rows) {
    const out = [];
    for (const row of rows || []) {
      const id = await this.cloudId(row.id);
      if (!id || !row.context || !Number.isFinite(row.meanFitness) || !(row.count >= 1)) continue;
      out.push(feedbackToWire({id, context: row.context, meanFitness: row.meanFitness, count: row.count}));
    }
    return await this.client.enqueueFeedback(out);
  }

  /**
   * Pulls a pool for the current track when the track changed since the
   * last pull, or PULL_EVERY generations went by (or `force`), and gives it
   * to the bridge.
   */
  maybePull({force = false} = {}) {
    if (this.pulling) return this.pulling;
    const trackVec = this.page.trackVec();
    // No track yet, or one that is all zeros: nothing to ask for.
    if (!trackVec || trackVec.length !== DIMS.track || !unit(trackVec)) return Promise.resolve(0);
    // A pool is for a track and a learning context (its ranking and feedback
    // are per context): either changing pulls again.
    const context = this.page.context() || {};
    const key = encodeF32(trackVec) + '|' + JSON.stringify(context), generation = this.page.generation?.() ?? null;
    // The coach's count restarts with a new context: a smaller count is due too.
    const due = generation !== null && this.pulledGeneration !== null && (generation < this.pulledGeneration || generation - this.pulledGeneration >= PULL_EVERY);
    if (!force && key === this.pulledTrack && !due) return Promise.resolve(0);
    // Another track or context: the last pool's champion is not this one's,
    // nor (other walls or mode) everyone's crash map.
    if (key !== this.pulledTrack && this.pool.length) {
      this.pool = [];
      this.#pickChampion();
    }
    if (key !== this.pulledTrack) this.#crashesFor(this.#geometrySig(), context.collisions || 'off');
    this.pulling = (async () => {
      const track = unit(trackVec);
      const pool = await this.client.recall({trackVec: track, dynamicsVec: unit(this.page.dynamicsVec()), context, k: LIMITS.recallDefaultK});
      if (!pool) return 0;
      this.pulledTrack = key;
      this.pulledGeneration = generation;
      this.pulls++;
      this.pool = pool;
      this.#pickChampion();
      this.#track(this.pullCrashes(trackVec, context));
      const added = this.bridge.acceptCloudPool(pool, trackVec, context);
      this.accepted += added;
      return added;
    })().finally(() => { this.pulling = null; });
    return this.pulling;
  }
}

/** The page's track as a verification sends it: main.js's road (its walls, gates and canvas sides), or null. */
export function pageGeometry(r = typeof road === 'undefined' ? null : road) {
  if (!r || r.left !== 0 || r.top !== 0 || !Array.isArray(r.innerList) || !Array.isArray(r.outerList) || !Array.isArray(r.checkPointList)) return null;
  const xy = p => [p?.x, p?.y];
  return {width: r.right, height: r.bottom, inner: r.innerList.map(xy), outer: r.outerList.map(xy),
    checkpoints: r.checkPointList.map(g => (Array.isArray(g) ? g.map(xy) : null))};
}

/**
 * index.html calls this once the bridge is ready. Returns the session (shared
 * mode with a service), or null.
 */
export async function startCloudBrain(bridge, {win = globalThis.window, ask = text => globalThis.confirm?.(text) ?? false} = {}) {
  const mode = bridge.brainMode();
  // Reload into the chosen mode, without any ?brain= in the address.
  const reload = () => {
    try {
      const url = new URL(win.location.href);
      url.searchParams.delete('brain');
      win.location.replace(url.href);
    } catch { win?.location?.reload(); }
  };
  const config = await loadConfig(undefined, undefined, {retries: mode === 'shared' ? 2 : 0});
  const secure = !!globalThis.crypto?.subtle && globalThis.isSecureContext !== false;
  const available = !!config.endpoint && secure;
  const ui = mountMemoryControl({
    mode, available, secure,
    // The control asked about what is sent before a switch to shared.
    onChoose: choice => { saveBrainMode(choice, choice === 'shared' ? {consent: true} : {}); reload(); },
  });
  if (mode !== 'shared') return null;
  if (!available) { ui.setStatus({state: 'unavailable', secure}); return null; }
  // Arrived by a ?brain=shared link, or what is sent changed since the
  // player's yes: ask before anything is sent.
  if (!consented()) {
    if (!ask(consentedBefore() ? CHANGED_DISCLOSURE : ARRIVAL_DISCLOSURE)) { saveBrainMode('local'); reload(); return null; }
    saveBrainMode('shared', {consent: true});
  }
  const client = new CloudBrainClient({endpoint: config.endpoint, token: contributorToken(), onStatus: status => ui.setStatus(status)});
  const session = new SharedSession({
    bridge, client,
    page: {
      // Before the first run the page has no track vector yet: embed the
      // editor's track (what the run will use), so the first generation is
      // already seeded from the shared pool.
      trackVec: () => {
        if (!(win?.currentTrackVec instanceof Float32Array)) { try { win?.embedCurrentTrack?.(); } catch { /* no track yet */ } }
        return win?.currentTrackVec instanceof Float32Array ? win.currentTrackVec : null;
      },
      dynamicsVec: () => { try { return win?.__rvDynamics?.queryVector?.() || null; } catch { return null; } },
      context: () => { try { return bridge.info().learning?.context || null; } catch { return null; } },
      // Generations trained on this page (the driver-learning coach's rounds).
      generation: () => (Number.isFinite(win?.DriverLearning?.coach?.rounds) ? win.DriverLearning.coach.rounds : null),
      // The walls and gates the cars learn on (X1): main.js's `road`, a
      // top-level const of a classic script.
      geometry: () => pageGeometry(),
      // The walls' signature (X4: shared layouts are for these walls).
      geometrySig: () => win?.AdaptiveGates?.wallSignature?.() || null,
    },
  });
  session.onBoard = (board, about) => ui.setBoard(board, about);
  // The cloud champion's ghost (X3): main.js steps and draws window.CloudGhost.
  const ghost = new Ghost({
    Car: typeof Car === 'undefined' ? null : Car,
    // main.js's network from 244 weights (brainCodec.js is not loaded here).
    inflate: flat => globalThis.inflateBrainInline(Float32Array.from(flat)),
    road: () => (typeof road === 'undefined' ? null : road),
    start: () => (typeof startInfo === 'undefined' ? null : startInfo),
    maxSpeed: () => (typeof maxSpeed === 'undefined' ? 15 : maxSpeed),
  });
  const showChampion = () => ui.setChampion(session.champion, {wanted: ghost.wanted});
  session.onChampion = champion => { ghost.setChampion(champion); showChampion(); };
  ui.onRace = () => { ghost.enable(!ghost.wanted); showChampion(); };
  // Everyone's crash map (X4): main.js draws window.SharedCrashOverlay.
  const overlay = new CrashOverlay();
  const showCrashes = () => ui.setCrashMap(session.sharedCrash, {shown: overlay.shown});
  session.onCrashMap = shared => { overlay.set(shared?.map || null); showCrashes(); };
  ui.onCrashToggle = () => { overlay.show(!overlay.shown); showCrashes(); };
  if (win) { win.__rvCloud = session; win.CloudGhost = ghost; win.SharedCrashOverlay = overlay; }
  // (Unsent brains survive a reload in the outbox: nothing is sent on the way out.)
  session.start();
  return session;
}
