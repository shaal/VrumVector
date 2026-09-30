// cloud/wire.js — the wire format of the shared cloud brain (protocol 1,
// docs/plan/cloud-brain.md, task CB1). One module for both directions: the
// browser builds requests and checks answers with it; the service (Rust,
// CB2) applies the same rules in the same order, and both run the same
// fixtures (tests/fixtures/cloud-brain/). The rules, in full, are in
// docs/validation/cloud-brain.md#cb1-the-wire-format.
//
// Everything arriving is hostile until checked. The parse* functions take the
// body's bytes (an ArrayBuffer or a view of one: read an answer with
// res.arrayBuffer(), never res.text()) or text already decoded. They never throw; every refusal has a
// stable reason code (REASONS). Types are strict:
// a number must be a JSON number, a string a JSON string; no value is coerced.
// An integer is any JSON number with an integral value (10, 10.0 and 1e1 are
// all 10; -0 is 0). null means absent.
//
// Vectors travel as canonical padded base64 of little-endian Float32. A brain
// is its 244 weights (topology 10-16-4); a track its 512-float CNN embedding
// and a driving summary its 64-float dynamics vector, both unit vectors.
// Brain ids are 128 bits of SHA-256 over those bytes: xxHash32 (the local
// archive's ids) is not collision resistant, and a shared service must not
// let anyone make a second brain with another brain's id.
import {FLAT_LENGTH, cleanContext, cleanLearning, clamp} from '../learning/policy.js';

export const PROTOCOL = 1;
// BRAIN_SCHEMA_VERSION of brainCodec.js (a test checks they agree): a client
// on another brain format is refused, never merged.
export const BRAIN_SCHEMA = 6;
export const DIMS = Object.freeze({brain: FLAT_LENGTH, track: 512, dynamics: 64});
export const LIMITS = Object.freeze({
  requestBytes: 65536,       // one request body, UTF-8
  responseBytes: 262144,     // one answer (a full recall is about 100 KB)
  depth: 32,                 // JSON nesting
  tracksPerRequest: 4,       // a contribution lists its tracks once; brains point at them
  brainsPerRequest: 16,
  feedbackPerRequest: 50,
  recallK: 64,               // k of a recall, 1..64
  recallDefaultK: 50,
  maxWeight: 16,             // |w|: evolved brains stay in ±1, "Use my driving" clones reach 6.76 (CB1)
  normTolerance: 1e-3,       // | ||v|| - 1 | for track and dynamics vectors, summed in f64 in order
  fitness: 1e6,              // |fitness|, |meanFitness|, |score|, fastest lap
  count: 1e6,                // feedback counts
  generation: 1e9,
  parentIds: 8,
  trackKey: 180,             // context.track: printable ASCII, cut to this
});
export const SOURCES = Object.freeze(['evolved', 'demonstration', 'cloud']);
const TOKEN = /^[0-9a-f]{32}$/;
const BRAIN_ID = /^brain_[0-9a-f]{32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PRINTABLE = /^[\x20-\x7e]*$/;

// Every reason a request, an answer, or one item of either is refused.
export const REASONS = Object.freeze({
  // the whole body
  notJson: 'not-json',            // not JSON, too deep, a non-finite number, a lone surrogate
  bodyTooLarge: 'body-too-large',
  shape: 'shape',                 // not an object, or a list that is not a list
  protocol: 'protocol',
  brainSchema: 'brain-schema',
  token: 'token',
  tooManyTracks: 'too-many-tracks',
  tooManyBrains: 'too-many-brains',
  tooManyFeedback: 'too-many-feedback',
  track: 'track',
  dynamics: 'dynamics',
  context: 'context',
  k: 'k-range',
  // one brain of a contribution
  brainEncoding: 'brain-encoding',
  brainNotFinite: 'brain-not-finite',
  brainWeightRange: 'brain-weight-range',
  brainFitness: 'brain-fitness',
  brainTrack: 'brain-track',
  brainDynamics: 'brain-dynamics',
  brainDuplicate: 'brain-duplicate',
  // one feedback row
  feedbackId: 'feedback-id',
  feedbackContext: 'feedback-context',
  feedbackNumbers: 'feedback-numbers',
  // one entry of a recall answer (checked by the browser)
  poolId: 'pool-id',
  poolDuplicate: 'pool-duplicate',
});
// Refusals only the service gives (CB4, CB5): in error answers, never from a parser here.
export const SERVICE_ERRORS = Object.freeze(['rate-limited', 'disabled', 'server-error']);
// Items only the service refuses (CB2): a feedback row about a brain the
// shared brain does not hold (never contributed, or evicted); a second row
// for the same brain and context in one request (the first counts); a row in
// a new context for a brain whose 8 contexts cannot be replaced.
export const SERVICE_ITEM_REASONS = Object.freeze(['feedback-unknown', 'feedback-duplicate', 'feedback-full']);
/** The HTTP status of an error answer. */
export function httpStatus(reason) {
  if (reason === REASONS.bodyTooLarge) return 413;
  if (reason === 'rate-limited') return 429;
  if (reason === 'disabled') return 503;
  if (reason === 'server-error') return 500;
  return 400;
}

// ─── values ───────────────────────────────────────────────────────────────

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const absent = v => v === undefined || v === null;
const isNum = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;
const isInt = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const own = (o, key) => (Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);

// ─── vectors ──────────────────────────────────────────────────────────────

const bytesOf = values => {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
  return new Uint8Array(view.buffer);
};

/** Float32 values as padded base64 of their little-endian bytes. */
export function encodeF32(values) {
  const bytes = bytesOf(values);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Canonical padded base64 of exactly `length` little-endian Float32 values
 * → Float32Array, or null. Canonical: the only text that encodes these bytes
 * (the unused bits of the last character are zero).
 */
export function decodeF32(text, length) {
  if (typeof text !== 'string' || text.length !== 4 * Math.ceil(length * 4 / 3) || !BASE64.test(text)) return null;
  let binary;
  try { binary = atob(text); } catch { return null; }
  if (binary.length !== length * 4 || btoa(binary) !== text) return null;
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * A brain's content id: `brain_` + the first 128 bits of SHA-256 of its
 * little-endian bytes. Needs crypto.subtle, which a browser offers only in a
 * secure context (https or localhost); the shared brain is off elsewhere.
 */
export async function brainId(vector) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytesOf(vector)));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, '0');
  return 'brain_' + hex;
}

const allFinite = v => v.every(Number.isFinite);
/** | ||v|| - 1 | ≤ 1e-3, the sum of squares taken in f64 in index order. */
export function isUnit(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  return Math.abs(Math.sqrt(sum) - 1) <= LIMITS.normTolerance;
}

/** A brain's 244 weights: a reason code, or null when valid. */
export function brainProblem(vector) {
  if (!vector || vector.length !== DIMS.brain) return REASONS.brainEncoding;
  if (!allFinite(vector)) return REASONS.brainNotFinite;
  for (const w of vector) if (Math.abs(w) > LIMITS.maxWeight) return REASONS.brainWeightRange;
  return null;
}
/** A valid unit vector of `dim` floats (a track or dynamics embedding). */
export function unitVector(vector, dim) {
  return !!vector && vector.length === dim && allFinite(vector) && isUnit(vector);
}

// ─── contexts and meta ────────────────────────────────────────────────────

/**
 * A learning context from the wire: only typed fields reach cleanContext
 * (learning/policy.js), whose defaults and clamps then apply exactly as in
 * the app (tests/fixtures/cloud-brain/contexts.json pins them). Not an
 * object → null.
 */
export function wireContext(raw) {
  if (!isObject(raw)) return null;
  const input = {};
  const profile = own(raw, 'profile'), track = own(raw, 'track'), collisions = own(raw, 'collisions');
  if (typeof profile === 'string') input.profile = profile;
  if (typeof track === 'string' && PRINTABLE.test(track)) input.track = track.slice(0, LIMITS.trackKey);
  for (const key of ['maxSpeed', 'traction', 'seconds']) if (typeof own(raw, key) === 'number') input[key] = own(raw, key);
  // A label with anything but printable ASCII is 'unknown' (so lowercasing is
  // ASCII-only on both sides: JS would turn the Kelvin sign into k).
  if (typeof collisions === 'string') input.collisions = PRINTABLE.test(collisions) ? collisions : 'unknown';
  return cleanContext(input);
}

/** The learning part of a brain's meta from the wire (cleanLearning, typed input), or undefined. */
function wireLearning(raw) {
  if (!isObject(raw)) return undefined;
  const context = wireContext(own(raw, 'context'));
  if (!context) return undefined;
  const input = {context};
  if (typeof own(raw, 'styleScore') === 'number') input.styleScore = own(raw, 'styleScore');
  const driving = own(raw, 'driving');
  if (isObject(driving)) {
    input.driving = {};
    for (const key of ['averageSpeed', 'nearWallRate', 'slideRate', 'smoothness', 'steeringChanges', 'aliveSeconds', 'nearCarRate']) {
      if (typeof own(driving, key) === 'number') input.driving[key] = own(driving, key);
    }
    for (const key of ['crashed', 'carContact']) if (typeof own(driving, key) === 'boolean') input.driving[key] = own(driving, key);
  }
  return cleanLearning(input);
}

/**
 * The meta a brain may carry, cleaned: known keys, typed and bounded
 * (tests/fixtures/cloud-brain/meta.json pins it). Unknown keys and bad values
 * are dropped, never refused.
 */
export function cleanBrainMeta(meta) {
  const m = isObject(meta) ? meta : {};
  const out = {};
  if (isInt(own(m, 'generation'), 0, LIMITS.generation)) out.generation = own(m, 'generation') + 0;
  const parents = own(m, 'parentIds');
  if (Array.isArray(parents)) {
    const ids = [...new Set(parents.filter(p => typeof p === 'string' && BRAIN_ID.test(p)))].slice(0, LIMITS.parentIds);
    if (ids.length) out.parentIds = ids;
  }
  const lap = own(m, 'fastestLap');
  if (typeof lap === 'number' && lap > 0 && lap <= LIMITS.fitness) out.fastestLap = lap;
  if (SOURCES.includes(own(m, 'source'))) out.source = own(m, 'source');
  const learning = wireLearning(own(m, 'learning'));
  if (learning) out.learning = learning;
  return out;
}

// ─── reading a body ───────────────────────────────────────────────────────

const refuse = error => ({ok: false, error});
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormedString = s => !LONE_SURROGATE.test(s);
// Every number finite (JSON.parse turns 1e400 into Infinity), every string
// and key well formed, containers nested at most 32 deep: the body is depth
// 1, and each array or object inside another adds 1 (scalars add nothing).
function wellFormed(value, depth) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return wellFormedString(value);
  if (value === null || typeof value !== 'object') return true;
  if (depth > LIMITS.depth) return false;
  if (Array.isArray(value)) return value.every(v => wellFormed(v, depth + 1));
  return Object.keys(value).every(k => wellFormedString(k) && wellFormed(value[k], depth + 1));
}

// Strict UTF-8: invalid bytes throw, and a byte-order mark is kept (so JSON.parse refuses it).
const UTF8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

// Bytes as a Uint8Array view: an ArrayBuffer (res.arrayBuffer()) or a
// SharedArrayBuffer, any typed array or DataView of one, from any realm;
// anything else (and a detached buffer) → null.
function asBytes(input) {
  try {
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const tag = Object.prototype.toString.call(input);
    if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return new Uint8Array(input);
  } catch { /* detached */ }
  return null;
}
// Some browsers' TextDecoder refuses a view of shared memory: decode a copy.
const unshared = bytes => (Object.prototype.toString.call(bytes.buffer) === '[object SharedArrayBuffer]' ? bytes.slice() : bytes);

/**
 * Size, JSON, shape, protocol, and (when asked) the brain format, in that
 * order. `input` is the body's bytes (what the service and the browser
 * receive: an ArrayBuffer, shared or not, or a view of one) or text already decoded (its size
 * counted in UTF-8 bytes; not well-formed Unicode, which has no UTF-8 bytes, is
 * `not-json`).
 */
function read(input, {maxBytes = LIMITS.requestBytes, schema = true} = {}) {
  let text;
  const bytes = asBytes(input);
  if (bytes) {
    if (bytes.length > maxBytes) return refuse(REASONS.bodyTooLarge);
    try { text = UTF8.decode(unshared(bytes)); } catch { return refuse(REASONS.notJson); }
  } else if (typeof input === 'string') {
    if (input.length > maxBytes || new TextEncoder().encode(input).length > maxBytes) return refuse(REASONS.bodyTooLarge);
    if (!wellFormedString(input)) return refuse(REASONS.notJson);
    text = input;
  } else return refuse(REASONS.shape);
  let body;
  try { body = JSON.parse(text); } catch { return refuse(REASONS.notJson); }
  if (!wellFormed(body, 1)) return refuse(REASONS.notJson);
  if (!isObject(body)) return refuse(REASONS.shape);
  if (own(body, 'protocol') !== PROTOCOL) return refuse(REASONS.protocol);
  if (schema && own(body, 'brainSchema') !== BRAIN_SCHEMA) return refuse(REASONS.brainSchema);
  return {ok: true, body};
}
const list = v => (absent(v) ? [] : Array.isArray(v) ? v : null);

// ─── requests (the service; mirrored here for tests and fast feedback) ────

/**
 * POST /v1/contribute. Checks, in order: the body (read), token, the three
 * lists (a non-list is `shape`) and their counts (tracks, brains, feedback),
 * each listed track; then each brain and each feedback row alone. A
 * request-level problem refuses the whole request ({ok: false, error}); a bad
 * brain or row is refused alone ({ok: true, tracks, brains, feedback,
 * rejected, feedbackRejected}).
 */
export async function parseContribute(text) {
  const r = read(text);
  if (!r.ok) return r;
  const token = own(r.body, 'token');
  if (typeof token !== 'string' || !TOKEN.test(token)) return refuse(REASONS.token);
  const tracks = list(own(r.body, 'tracks')), brains = list(own(r.body, 'brains')), feedback = list(own(r.body, 'feedback'));
  if (!tracks || !brains || !feedback) return refuse(REASONS.shape);
  if (tracks.length > LIMITS.tracksPerRequest) return refuse(REASONS.tooManyTracks);
  if (brains.length > LIMITS.brainsPerRequest) return refuse(REASONS.tooManyBrains);
  if (feedback.length > LIMITS.feedbackPerRequest) return refuse(REASONS.tooManyFeedback);
  const trackVecs = [];
  for (const text of tracks) {
    const vec = decodeF32(text, DIMS.track);
    if (!unitVector(vec, DIMS.track)) return refuse(REASONS.track);
    trackVecs.push(vec);
  }
  const accepted = [], rejected = [], seen = new Set();
  for (let index = 0; index < brains.length; index++) {
    const item = await brainItem(brains[index], trackVecs.length);
    if (item.error) { rejected.push({index, reason: item.error}); continue; }
    if (seen.has(item.value.id)) { rejected.push({index, reason: REASONS.brainDuplicate}); continue; }
    seen.add(item.value.id);
    accepted.push(item.value);
  }
  const rows = [], feedbackRejected = [];
  feedback.forEach((raw, index) => {
    const row = feedbackItem(raw);
    if (row.error) feedbackRejected.push({index, reason: row.error});
    else rows.push(row.value);
  });
  return {ok: true, token, tracks: trackVecs, brains: accepted, feedback: rows, rejected, feedbackRejected};
}

// One brain: encoding, finite, weight range, fitness, track index, dynamics.
async function brainItem(raw, trackCount) {
  if (!isObject(raw)) return {error: REASONS.brainEncoding};
  const vector = decodeF32(own(raw, 'vector'), DIMS.brain);
  const problem = brainProblem(vector);
  if (problem) return {error: problem};
  const fitness = own(raw, 'fitness');
  if (!isNum(fitness, -LIMITS.fitness, LIMITS.fitness)) return {error: REASONS.brainFitness};
  let track = null, dynamics = null;
  const index = own(raw, 'track');
  if (!absent(index)) {
    if (!isInt(index, 0, trackCount - 1)) return {error: REASONS.brainTrack};
    track = index + 0;
  }
  const dyn = own(raw, 'dynamics');
  if (!absent(dyn)) {
    dynamics = decodeF32(dyn, DIMS.dynamics);
    if (!unitVector(dynamics, DIMS.dynamics)) return {error: REASONS.brainDynamics};
  }
  return {value: {id: await brainId(vector), vector, fitness: fitness + 0, track, dynamics, meta: cleanBrainMeta(own(raw, 'meta'))}};
}

// One feedback row: id, context, numbers.
function feedbackItem(raw) {
  if (!isObject(raw) || typeof own(raw, 'id') !== 'string' || !BRAIN_ID.test(own(raw, 'id'))) return {error: REASONS.feedbackId};
  const context = wireContext(own(raw, 'context'));
  if (!context) return {error: REASONS.feedbackContext};
  const mean = own(raw, 'meanFitness'), count = own(raw, 'count');
  if (!isNum(mean, -LIMITS.fitness, LIMITS.fitness) || !isInt(count, 1, LIMITS.count)) return {error: REASONS.feedbackNumbers};
  return {value: {id: own(raw, 'id'), context, meanFitness: mean + 0, count: count + 0}};
}

/** POST /v1/recall. Checks, in order: the body, track, dynamics, context, k. */
export function parseRecall(text) {
  const r = read(text);
  if (!r.ok) return r;
  const track = decodeF32(own(r.body, 'track'), DIMS.track);
  if (!unitVector(track, DIMS.track)) return refuse(REASONS.track);
  let dynamics = null;
  const dyn = own(r.body, 'dynamics');
  if (!absent(dyn)) {
    dynamics = decodeF32(dyn, DIMS.dynamics);
    if (!unitVector(dynamics, DIMS.dynamics)) return refuse(REASONS.dynamics);
  }
  const context = wireContext(own(r.body, 'context'));
  if (!context) return refuse(REASONS.context);
  const kRaw = own(r.body, 'k'), k = absent(kRaw) ? LIMITS.recallDefaultK : kRaw;
  if (!isInt(k, 1, LIMITS.recallK)) return refuse(REASONS.k);
  return {ok: true, track, dynamics, context, k: k + 0};
}

/** POST /v1/forget (a CORS simple request). Checks the body (no brain format) and the token. */
export function parseForget(text) {
  const r = read(text, {schema: false});
  if (!r.ok) return r;
  const token = own(r.body, 'token');
  if (typeof token !== 'string' || !TOKEN.test(token)) return refuse(REASONS.token);
  return {ok: true, token};
}

// ─── answers (the browser) ────────────────────────────────────────────────

// Every answer may be up to 256 KiB; only a recall answer carries a brain format.
const ANSWER = Object.freeze({maxBytes: LIMITS.responseBytes, schema: false});
const bounded = (v, lo, hi) => (typeof v === 'number' ? clamp(v, lo, hi) : 0);
const whole = v => (isInt(v, 0, LIMITS.count) ? v + 0 : 0);

/**
 * The answer to a recall (up to 256 KiB, in the requested brain format). An
 * entry is dropped when it is not an object, its vector is bad, its id is not
 * its vector's content id, or its id came earlier. Other fields are bounded,
 * not refused. Returns {ok, pool, dropped} or {ok: false, error}.
 */
export async function parseRecallResponse(text) {
  const r = read(text, {maxBytes: LIMITS.responseBytes});
  if (!r.ok) return r;
  const raw = list(own(r.body, 'pool'));
  if (!raw || raw.length > LIMITS.recallK) return refuse(REASONS.shape);
  const pool = [], dropped = [], seen = new Set();
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (!isObject(entry)) { dropped.push({index, reason: REASONS.shape}); continue; }
    const vector = decodeF32(own(entry, 'vector'), DIMS.brain);
    const problem = brainProblem(vector);
    if (problem) { dropped.push({index, reason: problem}); continue; }
    const id = await brainId(vector);
    if (own(entry, 'id') !== id) { dropped.push({index, reason: REASONS.poolId}); continue; }
    if (seen.has(id)) { dropped.push({index, reason: REASONS.poolDuplicate}); continue; }
    seen.add(id);
    const f = isObject(own(entry, 'feedback')) ? own(entry, 'feedback') : {};
    pool.push({
      id, vector, meta: cleanBrainMeta(own(entry, 'meta')),
      fitness: bounded(own(entry, 'fitness'), -LIMITS.fitness, LIMITS.fitness),
      score: bounded(own(entry, 'score'), -LIMITS.fitness, LIMITS.fitness),
      feedback: {weight: bounded(own(f, 'weight'), -1, 1), count: whole(own(f, 'count')), contributors: whole(own(f, 'contributors'))},
    });
  }
  return {ok: true, pool, dropped};
}

const knownReason = new Set([...Object.values(REASONS), ...SERVICE_ERRORS, ...SERVICE_ITEM_REASONS]);
const reasonList = (v, max) => {
  const items = list(v);
  if (!items || items.length > max) return null;
  const out = [];
  for (const item of items) {
    if (!isObject(item) || !isInt(own(item, 'index'), 0, max - 1) || !knownReason.has(own(item, 'reason'))) return null;
    out.push({index: own(item, 'index') + 0, reason: own(item, 'reason')});
  }
  return out;
};

/** The answer to a contribution: {ok, accepted, rejected, feedbackAccepted, feedbackRejected} or {ok: false, error}. */
export function parseContributeResponse(text) {
  const r = read(text, ANSWER);
  if (!r.ok) return r;
  const accepted = list(own(r.body, 'accepted'));
  if (!accepted || accepted.length > LIMITS.brainsPerRequest || !accepted.every(id => typeof id === 'string' && BRAIN_ID.test(id))) return refuse(REASONS.shape);
  const rejected = reasonList(own(r.body, 'rejected'), LIMITS.brainsPerRequest);
  const feedbackRejected = reasonList(own(r.body, 'feedbackRejected'), LIMITS.feedbackPerRequest);
  const feedbackAccepted = own(r.body, 'feedbackAccepted');
  if (!rejected || !feedbackRejected || !isInt(feedbackAccepted, 0, LIMITS.feedbackPerRequest)) return refuse(REASONS.shape);
  return {ok: true, accepted: accepted.slice(), rejected, feedbackAccepted: feedbackAccepted + 0, feedbackRejected};
}

/** An error answer `{protocol, error}`: its reason, or 'server-error' when the body is not a known one. */
export function parseErrorResponse(text) {
  const r = read(text, ANSWER);
  const error = r.ok ? own(r.body, 'error') : undefined;
  return {ok: true, error: knownReason.has(error) ? error : 'server-error'};
}

/** GET /v1/stats: {ok, brains, tracks, contributorsToday, contributions24h} or {ok: false, error}. */
export function parseStatsResponse(text) {
  const r = read(text, ANSWER);
  if (!r.ok) return r;
  const out = {ok: true};
  for (const key of ['brains', 'tracks', 'contributorsToday', 'contributions24h']) {
    const v = own(r.body, key);
    if (!isInt(v, 0, Number.MAX_SAFE_INTEGER)) return refuse(REASONS.shape);
    out[key] = v + 0;
  }
  return out;
}

// ─── building requests and answers ────────────────────────────────────────

/**
 * A brain for /v1/contribute. `track` is the index of its track in the
 * request's `tracks`; dynamics that are not a unit vector (an all-zero
 * summary) are left out, so the brain is not refused for them.
 */
export function brainToWire({vector, fitness, track = null, dynamicsVec = null, meta = {}}) {
  const out = {vector: encodeF32(vector), fitness: Number(fitness)};
  if (Number.isInteger(track)) out.track = track;
  if (dynamicsVec && unitVector(Float32Array.from(dynamicsVec), DIMS.dynamics)) out.dynamics = encodeF32(dynamicsVec);
  // The app's own contexts may still hold collision settings ({heatSize}):
  // the app's cleanContext turns them into the label the wire carries.
  if (isObject(meta?.learning) && meta.learning.context && typeof meta.learning.context === 'object') {
    meta = {...meta, learning: {...meta.learning, context: cleanContext(meta.learning.context)}};
  }
  const clean = cleanBrainMeta(meta);
  if (Object.keys(clean).length) out.meta = clean;
  return out;
}
/** A feedback row: how the offspring of brain `id` (a cloud id) did in `context`. */
export function feedbackToWire({id, context, meanFitness, count}) {
  return {id, context: cleanContext(context), meanFitness: Number(meanFitness), count: Math.floor(Number(count))};
}
export function contributeBody({token, tracks = [], brains = [], feedback = []}) {
  return JSON.stringify({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, token,
    tracks: tracks.map(t => (typeof t === 'string' ? t : encodeF32(t))), brains, feedback});
}
export function recallBody({trackVec, dynamicsVec = null, context, k = LIMITS.recallDefaultK}) {
  const body = {protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, track: encodeF32(trackVec), context: cleanContext(context), k};
  if (dynamicsVec && unitVector(Float32Array.from(dynamicsVec), DIMS.dynamics)) body.dynamics = encodeF32(dynamicsVec);
  return JSON.stringify(body);
}
export function forgetBody({token}) {
  return JSON.stringify({protocol: PROTOCOL, token});
}
/** An error answer's body; its HTTP status is httpStatus(error). */
export function errorBody(error) {
  return JSON.stringify({protocol: PROTOCOL, error});
}
