// The shared cloud brain's wire fixtures (docs/plan/cloud-brain.md, CB1):
// requests and answers with the result each must give, plus two tables that
// pin how contexts and meta are cleaned. The browser's cloud/wire.js and the
// service (CB2, Rust) both run them. Deterministic: every vector comes from a
// fixed xorshift stream.
//
//   node scripts/cloud-brain-fixtures.mjs     writes tests/fixtures/cloud-brain/
//
// A fixture: {description, route, body or bodyBase64, expect}. body is the
// raw text (sent as its UTF-8 bytes); bodyBase64 is raw bytes, for bodies that
// are not valid UTF-8. route is
// contribute | recall | forget | recall-response | contribute-response |
// stats-response | error-response. expect is {ok: false, error} for a refused
// body, or what was accepted: ids, refused items with their reasons, and
// (for some) the values read: cleaned meta and contexts, fitness values,
// feedback rows, track indices, and vector fingerprints (`brain_` + the
// first 128 bits of SHA-256 of the decoded vector's bytes, as for a brain id). contexts.json and meta.json are lists of
// {in, out}: wireContext(in) and cleanBrainMeta(in). match.json (CB2) lists
// {memory, query, factor}: matchContext's factor, which the service's
// ranking uses too (memory null: a brain without a context).
import {mkdir, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {encodeF32, brainId, httpStatus, wireContext, PROTOCOL, BRAIN_SCHEMA, LIMITS, DIMS, REASONS} from '../AI-Car-Racer/cloud/wire.js';
import {matchContext} from '../AI-Car-Racer/learning/policy.js';

function stream(seed) {
  let s = BigInt(seed) || 1n;
  return () => {
    s ^= (s << 13n) & 0xffffffffffffffffn; s ^= s >> 7n; s ^= (s << 17n) & 0xffffffffffffffffn;
    return Number(s >> 11n) / 2 ** 53;
  };
}
const brain = (seed, scale = 1) => { const r = stream(seed); return Float32Array.from({length: DIMS.brain}, () => (r() * 2 - 1) * scale); };
const unit = (seed, dim) => { const r = stream(seed), v = Float32Array.from({length: dim}, () => r() * 2 - 1); const n = Math.hypot(...v); return v.map(x => x / n); };
// A vector of norm as close to `norm` as Float32 allows.
const scaled = (v, norm) => v.map(x => x * norm);
// The norm the rule sees: the sum of squares of the stored Float32 values, in f64, in index order.
const f64Norm = v => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); };
// A stored vector whose f64 norm lies strictly inside (lo, hi), or the generator stops.
function normBetween(v, target, lo, hi) {
  const out = scaled(v, target), n = f64Norm(out);
  if (!(n > lo && n < hi)) throw new Error(`norm ${n} not in (${lo}, ${hi})`);
  return out;
}
const TOKEN = '0123456789abcdef0123456789abcdef';
const CONTEXT = {version: 1, profile: 'balanced', track: '1a2b3c4d-5e6f7a8b-812', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'};
const json = value => JSON.stringify(value);
const envelope = extra => ({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, token: TOKEN, tracks: [], brains: [], feedback: [], ...extra});
const wireBrain = (vector, extra = {}) => ({vector: encodeF32(vector), fitness: 12, ...extra});
const row = (id, extra = {}) => ({id, context: CONTEXT, meanFitness: 9.5, count: 12, ...extra});
const recall = (track, extra = {}) => json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, track: encodeF32(track), context: CONTEXT, ...extra});
const accepts = (accepted, extra = {}) => ({ok: true, accepted, rejected: [], feedbackAccepted: 0, feedbackRejected: [], ...extra});
const REQUESTS = ['contribute', 'recall', 'forget'];
const refused = (description, route, body, error) => ({description, route, body,
  expect: REQUESTS.includes(route) ? {ok: false, error, status: httpStatus(error)} : {ok: false, error}});
// A body given as bytes: parts are text (UTF-8) or lists of raw byte values.
const bytes = (...parts) => Buffer.concat(parts.map(p => Buffer.from(typeof p === 'string' ? p : p))).toString('base64');
const refusedBytes = (description, route, bodyBase64, error) => {
  const {body, ...rest} = refused(description, route, null, error);
  return {...rest, bodyBase64};
};

export async function fixtures() {
  const id = v => brainId(v);
  const evolved = brain(1), clone = brain(2, 6.8), track = unit(3, DIMS.track), dynamics = unit(4, DIMS.dynamics);
  const nanBrain = brain(5); nanBrain[17] = NaN;
  const infBrain = brain(11); infBrain[3] = -Infinity;
  const heavyBrain = brain(6); heavyBrain[200] = 16.5;
  const nanHeavyBrain = brain(8); nanHeavyBrain[10] = 17; nanHeavyBrain[20] = NaN;
  const edgeBrain = brain(7); edgeBrain[0] = -16; edgeBrain[1] = 16; edgeBrain[2] = -0; edgeBrain[3] = 1e-45;
  const valid = {}, invalid = {};

  // ─── contribute ─────────────────────────────────────────────────────────
  valid['contribute-evolved-brain'] = {
    description: 'One evolved brain with its track (by index), dynamics, and meta.',
    route: 'contribute',
    body: json(envelope({tracks: [encodeF32(track)], brains: [wireBrain(evolved, {fitness: 1432.3, track: 0, dynamics: encodeF32(dynamics), meta: {
      generation: 41, parentIds: [await id(clone)], fastestLap: 1432.5, source: 'evolved',
      learning: {context: CONTEXT, styleScore: 0.25, driving: {averageSpeed: 0.62, nearWallRate: 0.08, slideRate: 0.01, smoothness: 0.9, crashed: false}}}})]})),
    expect: accepts([await id(evolved)], {firstMeta: {generation: 41, parentIds: [await id(clone)], fastestLap: 1432.5, source: 'evolved',
      learning: {context: CONTEXT, styleScore: 0.25, driving: {averageSpeed: 0.62, nearWallRate: 0.08, slideRate: 0.01, smoothness: 0.9, crashed: false}}},
      fitness: [1432.3], tracks: [0], trackPrints: [await id(track)], dynamicsPrints: [await id(dynamics)]}),
  };
  valid['contribute-clone-and-edges'] = {
    description: 'A clone of your driving (weights up to 6.8); weights at the bound (±16), -0, the smallest subnormal.',
    route: 'contribute',
    body: json(envelope({brains: [wireBrain(clone, {meta: {source: 'demonstration'}}), wireBrain(edgeBrain)]})),
    expect: accepts([await id(clone), await id(edgeBrain)]),
  };
  valid['contribute-feedback-only'] = {
    description: 'Offspring feedback without brains; counts and fitness at their bounds.',
    route: 'contribute',
    body: json(envelope({feedback: [row(await id(evolved), {count: LIMITS.count, meanFitness: LIMITS.fitness}), row(await id(clone), {meanFitness: -LIMITS.fitness, count: 1}),
      row(await id(clone), {meanFitness: 9.1, count: 3, context: {profile: 'wild', maxSpeed: 500}})]})),
    expect: accepts([], {feedbackAccepted: 3, feedbackRows: [
      {id: await id(evolved), context: CONTEXT, meanFitness: LIMITS.fitness, count: LIMITS.count},
      {id: await id(clone), context: CONTEXT, meanFitness: -LIMITS.fitness, count: 1},
      {id: await id(clone), context: {version: 1, profile: 'wild', track: '', maxSpeed: 100, traction: 0.5, seconds: 20, collisions: 'off'}, meanFitness: 9.1, count: 3}]}),
  };
  const full = [];
  for (let i = 0; i < LIMITS.brainsPerRequest; i++) full.push(wireBrain(brain(100 + i), {track: i % LIMITS.tracksPerRequest, dynamics: encodeF32(unit(200 + i, DIMS.dynamics)),
    meta: {generation: 1000 + i, parentIds: [], source: 'evolved', learning: {context: CONTEXT, styleScore: 0.5, driving: {averageSpeed: 0.5, nearWallRate: 0.1, slideRate: 0.1, smoothness: 0.5, steeringChanges: 12, aliveSeconds: 20, crashed: true}}}}));
  const fullRows = [];
  for (let i = 0; i < LIMITS.feedbackPerRequest; i++) fullRows.push(row(await id(brain(400 + i))));
  const fullIds = [];
  for (let i = 0; i < LIMITS.brainsPerRequest; i++) fullIds.push(await id(brain(100 + i)));
  valid['contribute-at-the-limits'] = {
    description: '16 brains with meta, 4 tracks, 50 feedback rows (the most of each) with the app\'s short track keys: under 64 KB. The counts do not bound the size; a client splits by bytes.',
    route: 'contribute',
    body: json(envelope({tracks: Array.from({length: LIMITS.tracksPerRequest}, (_, i) => encodeF32(unit(300 + i, DIMS.track))), brains: full, feedback: fullRows})),
    expect: accepts(fullIds, {feedbackAccepted: LIMITS.feedbackPerRequest}),
  };
  valid['contribute-integers-as-floats'] = {
    description: 'Integers written 1.0, 1e1, -0 and 2.0E0 (a track index, counts): an integer is any integral number.',
    route: 'contribute',
    body: json(envelope({tracks: [encodeF32(track), encodeF32(unit(12, DIMS.track))]})).replace('"brains":[]', `"brains":[{"vector":"${encodeF32(evolved)}","fitness":1e1,"track":-0},{"vector":"${encodeF32(clone)}","fitness":3,"track":1.0}]`)
      .replace('"feedback":[]', `"feedback":[{"id":"${await id(evolved)}","context":${json(CONTEXT)},"meanFitness":2,"count":2.0E0}]`),
    expect: accepts([await id(evolved), await id(clone)], {feedbackAccepted: 1, tracks: [0, 1], fitness: [10, 3], trackPrints: [await id(track), await id(unit(12, DIMS.track))],
      feedbackRows: [{id: await id(evolved), context: CONTEXT, meanFitness: 2, count: 2}]}),
  };
  valid['contribute-negative-zero'] = {
    description: 'Outputs never hold -0: a fitness and a mean fitness of -0 come out as 0.',
    route: 'contribute',
    body: json(envelope({brains: [wireBrain(evolved)], feedback: [row(await id(evolved))]})).replace('"fitness":12', '"fitness":-0').replace('"meanFitness":9.5', '"meanFitness":-0'),
    expect: accepts([await id(evolved)], {feedbackAccepted: 1, fitness: [0], feedbackRows: [{id: await id(evolved), context: CONTEXT, meanFitness: 0, count: 12}]}),
  };
  valid['contribute-header-as-floats'] = {
    description: 'protocol 1.0, brainSchema 6e0, a meta generation 2.0: integers written as floats.',
    route: 'contribute',
    body: json(envelope({brains: [wireBrain(evolved, {meta: {generation: 2}})]})).replace('"protocol":1,', '"protocol":1.0,')
      .replace('"brainSchema":6,', '"brainSchema":6e0,').replace('"generation":2', '"generation":2.0'),
    expect: accepts([await id(evolved)], {firstMeta: {generation: 2}}),
  };
  valid['contribute-negative-zero-meta'] = {
    description: 'Meta numbers of -0 (generation, styleScore, driving, a context number) come out as 0; a fastest lap of -0 is not over 0, so dropped.',
    route: 'contribute',
    body: json(envelope({brains: [wireBrain(evolved, {meta: {generation: 7, fastestLap: 99.5, learning: {context: CONTEXT, styleScore: 0.25,
      driving: {averageSpeed: 0.375, steeringChanges: 3, nearCarRate: 0.125}}}})]}))
      .replace('"generation":7', '"generation":-0').replace('"styleScore":0.25', '"styleScore":-0').replace('"averageSpeed":0.375', '"averageSpeed":-0')
      .replace('"steeringChanges":3', '"steeringChanges":-0.0').replace('"nearCarRate":0.125', '"nearCarRate":-0e0').replace('"traction":0.5', '"traction":-0')
      .replace('"fastestLap":99.5', '"fastestLap":-0'),
    expect: accepts([await id(evolved)], {firstMeta: {generation: 0, learning: {context: {...CONTEXT, traction: 0}, styleScore: 0,
      driving: {averageSpeed: 0, steeringChanges: 0, nearCarRate: 0}}}}),
  };
  invalid['contribute-items-not-objects'] = {
    description: 'List items that are not objects (null too: null is an item, not an absent one): each brain is brain-encoding, each row feedback-id.',
    route: 'contribute',
    body: json(envelope({brains: [null, 7, [], 'brain'], feedback: [null, 'row', [], 3]})),
    expect: {ok: true, accepted: [], rejected: [0, 1, 2, 3].map(index => ({index, reason: REASONS.brainEncoding})),
      feedbackAccepted: 0, feedbackRejected: [0, 1, 2, 3].map(index => ({index, reason: REASONS.feedbackId}))},
  };
  valid['contribute-null-is-absent'] = {
    description: 'null means absent: lists, a track index, dynamics, meta.',
    route: 'contribute',
    body: json({...envelope(), tracks: null, feedback: null, brains: [wireBrain(evolved, {track: null, dynamics: null, meta: null})]}),
    expect: accepts([await id(evolved)], {tracks: [null]}),
  };
  valid['contribute-duplicate-keys'] = {
    description: 'A key given twice: the last one counts (JSON.parse, serde_json::Value).',
    route: 'contribute',
    body: json(envelope({brains: [wireBrain(evolved)]})).replace(`"token":"${TOKEN}"`, `"token":"bad","token":"${TOKEN}"`),
    expect: accepts([await id(evolved)]),
  };
  const padded = n => json({...envelope(), pad: 'x'.repeat(n)});
  const overhead = padded(0).length;
  valid['contribute-exactly-64kb'] = {
    description: 'Exactly 65 536 bytes (an unknown top-level key pads it): accepted.',
    route: 'contribute', body: padded(LIMITS.requestBytes - overhead), expect: accepts([]),
  };
  // Depth: the body is depth 1; each nested array or object adds 1.
  valid['contribute-depth-32'] = {
    description: 'An unknown key nested to depth 32 (the most): accepted.',
    route: 'contribute', body: json({...envelope(), deep: JSON.parse('['.repeat(31) + '1' + ']'.repeat(31))}), expect: accepts([]),
  };
  valid['contribute-units-at-tolerance'] = {
    description: 'A track and dynamics of norm 1.000995 and 0.999005: inside the 1e-3 tolerance (the sum of squares in double precision).',
    route: 'contribute',
    body: json(envelope({tracks: [encodeF32(scaled(track, 1.000995))], brains: [wireBrain(evolved, {track: 0, dynamics: encodeF32(scaled(dynamics, 0.999005))})]})),
    expect: accepts([await id(evolved)], {trackPrints: [await id(scaled(track, 1.000995))], dynamicsPrints: [await id(scaled(dynamics, 0.999005))]}),
  };
  // Between |n - 1| <= 1e-3 and |n^2 - 1| <= 2e-3 lies a gap of about 5e-7:
  // these pin the rule (and double-precision summation) inside it.
  valid['contribute-unit-inside-the-gap'] = {
    description: 'A track of norm 1.0009998: within 1e-3 of 1, though its squared norm is over 1.002.',
    route: 'contribute',
    body: json(envelope({tracks: [encodeF32(normBetween(track, 1.0009998, 1.0009996, 1.0009999))]})),
    expect: accepts([]),
  };
  invalid['track-not-unit-inside-the-gap'] = refused('A track of norm 0.9989998: its squared norm is within 2e-3 of 1, but the norm is not within 1e-3.', 'contribute',
    json(envelope({tracks: [encodeF32(normBetween(track, 0.9989998, 0.9989996, 0.9989999))]})), REASONS.track);
  valid['contribute-fitness-at-the-bounds'] = {
    description: 'Fitness exactly +1e6 and -1e6.',
    route: 'contribute',
    body: json(envelope({brains: [wireBrain(evolved, {fitness: LIMITS.fitness}), wireBrain(clone, {fitness: -LIMITS.fitness})]})),
    expect: accepts([await id(evolved), await id(clone)], {fitness: [LIMITS.fitness, -LIMITS.fitness]}),
  };

  invalid['not-json'] = refused('Not JSON.', 'contribute', '{"protocol":1,', REASONS.notJson);
  invalid['not-json-bom'] = refused('A byte-order mark before the JSON.', 'contribute', '﻿' + json(envelope()), REASONS.notJson);
  invalid['not-json-overflow'] = refused('A number too large for a double (1e400).', 'contribute', json(envelope({brains: [wireBrain(evolved)]})).replace('"fitness":12', '"fitness":1e400'), REASONS.notJson);
  invalid['not-json-lone-surrogate'] = refused('A lone surrogate in a string.', 'contribute', json(envelope()).replace(`"token":"${TOKEN}"`, `"token":"${TOKEN}","note":"\\ud800"`), REASONS.notJson);
  valid['contribute-depth-32-objects'] = {
    description: 'An unknown key nested to depth 32 in objects: accepted.',
    route: 'contribute', body: json({...envelope(), deep: JSON.parse('{"a":'.repeat(31) + '1' + '}'.repeat(31))}), expect: accepts([]),
  };
  invalid['not-json-depth-33-objects'] = refused('Objects nested one level too deep (33).', 'contribute',
    json({...envelope(), deep: JSON.parse('{"a":'.repeat(32) + '1' + '}'.repeat(32))}), REASONS.notJson);
  invalid['not-json-depth-33-mixed'] = refused('Arrays and objects in turn, nested one level too deep (33).', 'contribute',
    json({...envelope(), deep: JSON.parse('[{"a":'.repeat(16) + '1' + '}]'.repeat(16))}), REASONS.notJson);
  invalid['not-json-depth-33'] = refused('Nesting one level too deep (33).', 'contribute', json({...envelope(), deep: JSON.parse('['.repeat(32) + '1' + ']'.repeat(32))}), REASONS.notJson);
  invalid['body-too-large'] = refused('One byte over 64 KB.', 'contribute', padded(LIMITS.requestBytes - overhead + 1), REASONS.bodyTooLarge);
  invalid['body-too-large-utf8'] = refused('Under 65 536 characters, over 65 536 UTF-8 bytes.', 'contribute', json({...envelope(), pad: 'é'.repeat(40000)}), REASONS.bodyTooLarge);
  invalid['body-too-large-and-not-json'] = refused('Too large and not JSON: size is checked first.', 'contribute', '{' + 'x'.repeat(LIMITS.requestBytes), REASONS.bodyTooLarge);
  // Bodies as bytes: the service reads bytes, and so does the browser (CB3).
  // The envelope with an unknown key "note" whose string the bytes go into.
  const env = json(envelope()), cut = env.indexOf(`"token":"${TOKEN}"`) + `"token":"${TOKEN}"`.length;
  const note = text => env.slice(0, cut) + ',"note":"' + text, noteEnd = '"' + env.slice(cut);
  valid['contribute-bytes-utf8'] = {description: 'A body with 2-, 3- and 4-byte UTF-8 characters in an unknown key.', route: 'contribute',
    bodyBase64: bytes(note('é€😀') + noteEnd), expect: accepts([])};
  const utf8Pad = json({...envelope(), pad: ''}).length, utf8Fill = LIMITS.requestBytes - utf8Pad;
  valid['contribute-bytes-exactly-64kb'] = {description: 'Exactly 65 536 bytes, most of them 2-byte characters: accepted.', route: 'contribute',
    bodyBase64: bytes(json({...envelope(), pad: 'é'.repeat(Math.floor(utf8Fill / 2)) + 'x'.repeat(utf8Fill % 2)})), expect: accepts([])};
  invalid['not-json-invalid-utf8'] = refusedBytes('A byte (0xff) that is never UTF-8.', 'contribute', bytes(note(''), [0xff], noteEnd), REASONS.notJson);
  invalid['not-json-overlong-utf8'] = refusedBytes('An overlong encoding of "/" (0xc0 0xaf).', 'contribute', bytes(note(''), [0xc0, 0xaf], noteEnd), REASONS.notJson);
  invalid['not-json-utf8-surrogate'] = refusedBytes('A surrogate encoded as UTF-8 (0xed 0xa0 0x80).', 'contribute', bytes(note(''), [0xed, 0xa0, 0x80], noteEnd), REASONS.notJson);
  invalid['not-json-truncated-utf8'] = refusedBytes('A 3-byte character cut after 2 bytes.', 'contribute', bytes(note(''), [0xe2, 0x82], noteEnd), REASONS.notJson);
  invalid['not-json-bom-bytes'] = refusedBytes('The UTF-8 byte-order mark (0xef 0xbb 0xbf) before the JSON.', 'contribute', bytes([0xef, 0xbb, 0xbf], json(envelope())), REASONS.notJson);
  invalid['body-too-large-before-utf8'] = refusedBytes('65 537 bytes, one of them 0xff: size is checked first.', 'contribute',
    bytes(note(''), Array(LIMITS.requestBytes + 1 - Buffer.byteLength(note('') + noteEnd)).fill(0xff), noteEnd), REASONS.bodyTooLarge);
  invalid['body-is-an-array'] = refused('A JSON array, not an object.', 'contribute', '[1,2,3]', REASONS.shape);
  invalid['protocol-2'] = refused('Another protocol.', 'contribute', json(envelope({protocol: 2})), REASONS.protocol);
  invalid['protocol-as-string'] = refused('protocol "1", a string.', 'contribute', json(envelope({protocol: '1'})), REASONS.protocol);
  invalid['protocol-before-schema'] = refused('Another protocol and another brain format: protocol first.', 'contribute', json(envelope({protocol: 2, brainSchema: 5})), REASONS.protocol);
  invalid['brain-schema-as-string'] = refused('brainSchema "6", a string.', 'contribute', json(envelope({brainSchema: '6'})), REASONS.brainSchema);
  invalid['brain-schema-5'] = refused('Another brain format.', 'contribute', json(envelope({brainSchema: 5})), REASONS.brainSchema);
  invalid['token-uppercase'] = refused('A token that is not 32 lowercase hex digits.', 'contribute', json(envelope({token: TOKEN.toUpperCase()})), REASONS.token);
  invalid['token-missing'] = refused('No token.', 'contribute', json({...envelope(), token: undefined}), REASONS.token);
  invalid['token-before-counts'] = refused('A bad token and 17 brains: the token first.', 'contribute', json(envelope({token: 'x', brains: Array.from({length: 17}, () => 1)})), REASONS.token);
  invalid['too-many-tracks'] = refused('5 tracks.', 'contribute', json(envelope({tracks: Array.from({length: 5}, (_, i) => encodeF32(unit(600 + i, DIMS.track)))})), REASONS.tooManyTracks);
  invalid['too-many-brains'] = refused('17 brains.', 'contribute', json(envelope({brains: Array.from({length: LIMITS.brainsPerRequest + 1}, (_, i) => wireBrain(brain(500 + i)))})), REASONS.tooManyBrains);
  invalid['too-many-feedback'] = refused('51 feedback rows.', 'contribute', json(envelope({feedback: Array.from({length: LIMITS.feedbackPerRequest + 1}, () => ({}))})), REASONS.tooManyFeedback);
  invalid['counts-before-tracks'] = refused('17 brains and a bad track: the counts first.', 'contribute', json(envelope({tracks: ['AAAA'], brains: Array.from({length: 17}, () => 1)})), REASONS.tooManyBrains);
  invalid['track-not-a-string'] = refused('A listed track that is a number: track (not shape).', 'contribute', json(envelope({tracks: [5]})), REASONS.track);
  invalid['track-not-unit'] = refused('A listed track of norm 1.001005.', 'contribute', json(envelope({tracks: [encodeF32(scaled(track, 1.001005))]})), REASONS.track);
  invalid['track-not-unit-low'] = refused('A listed track of norm 0.998995.', 'contribute', json(envelope({tracks: [encodeF32(scaled(track, 0.998995))]})), REASONS.track);
  invalid['token-too-long'] = refused('A token of 33 hex digits.', 'contribute', json(envelope({token: TOKEN + 'a'})), REASONS.token);
  invalid['token-too-short'] = refused('A token of 31 hex digits.', 'contribute', json(envelope({token: TOKEN.slice(1)})), REASONS.token);
  invalid['not-json-lone-surrogate-key'] = refused('A lone surrogate in a key.', 'contribute', json(envelope()).replace('"token"', '"\\udc00":1,"token"'), REASONS.notJson);
  invalid['list-shapes-before-counts-5-tracks'] = refused('5 tracks and brains not a list: every list shape before any count.', 'contribute', json(envelope({tracks: Array.from({length: 5}, () => 'AAAA'), brains: {}})), REASONS.shape);
  invalid['brains-not-a-list'] = refused('brains is an object.', 'contribute', json(envelope({brains: {0: 1}})), REASONS.shape);

  // Which reason wins when a body has several faults (the order in the doc).
  invalid['json-before-shape'] = refused('An array holding 1e400: well-formedness before shape.', 'contribute', '[1e400]', REASONS.notJson);
  invalid['json-before-protocol'] = refused('Another protocol and 1e400: well-formedness before protocol.', 'contribute', json(envelope({protocol: 2})).replace('"token"', '"x":1e400,"token"'), REASONS.notJson);
  invalid['token-before-list-shape'] = refused('A bad token and brains not a list: the token first.', 'contribute', json(envelope({token: 'x', brains: {}})), REASONS.token);
  invalid['counts-tracks-before-brains'] = refused('5 tracks and 17 brains: tracks counted first.', 'contribute',
    json(envelope({tracks: Array.from({length: 5}, () => 'AAAA'), brains: Array.from({length: 17}, () => 1)})), REASONS.tooManyTracks);
  invalid['counts-brains-before-feedback'] = refused('17 brains and 51 feedback rows: brains counted before feedback.', 'contribute',
    json(envelope({brains: Array.from({length: 17}, () => 1), feedback: Array.from({length: 51}, () => 1)})), REASONS.tooManyBrains);
  invalid['brain-schema-before-token'] = refused('Another brain format and a bad token: the format first.', 'contribute',
    json(envelope({brainSchema: 5, token: 'x'})), REASONS.brainSchema);
  invalid['list-shapes-before-counts-feedback'] = refused('17 brains and feedback not a list: every list shape before any count.', 'contribute',
    json(envelope({brains: Array.from({length: 17}, () => 1), feedback: {}})), REASONS.shape);
  invalid['list-shapes-before-counts'] = refused('17 brains and tracks not a list: every list shape before any count.', 'contribute', json(envelope({tracks: {}, brains: Array.from({length: 17}, () => 1)})), REASONS.shape);
  // Floats read as the nearest double (serde_json needs float_roundtrip): these sit next to a bound.
  // 1e6 + 2^-34 lies exactly halfway between 1e6 and the next double: it
  // rounds to even (1e6, accepted); one digit more and it rounds up (refused).
  valid['contribute-float-halfway-rounds-to-even'] = {
    description: 'meanFitness 1000000.0000000000582076609134674072265625, exactly halfway to the next double: rounds to even, 1e6, within the bound.',
    route: 'contribute',
    body: json(envelope({feedback: [row(await id(evolved))]})).replace('"meanFitness":9.5', '"meanFitness":1000000.0000000000582076609134674072265625'),
    expect: accepts([], {feedbackAccepted: 1}),
  };
  invalid['contribute-float-just-past-halfway'] = {
    description: 'meanFitness 1000000.0000000000582076609134674072265626, just past halfway: rounds up, over 1e6.',
    route: 'contribute',
    body: json(envelope({feedback: [row(await id(evolved))]})).replace('"meanFitness":9.5', '"meanFitness":1000000.0000000000582076609134674072265626'),
    expect: accepts([], {feedbackRejected: [{index: 0, reason: REASONS.feedbackNumbers}]}),
  };
  invalid['contribute-float-just-over-bound'] = {
    description: 'meanFitness 1000000.00000000005821 is over 1e6 once read correctly rounded (a sloppy parser reads 1e6).',
    route: 'contribute',
    body: json(envelope({feedback: [row(await id(evolved))]})).replace('"meanFitness":9.5', '"meanFitness":1000000.00000000005821'),
    expect: accepts([], {feedbackRejected: [{index: 0, reason: REASONS.feedbackNumbers}]}),
  };
  // The last character before '==' carries 2 data bits and 4 unused ones:
  // set its lowest (unused) bit. The alphabet stays valid; only canonicality fails.
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const canonical = encodeF32(evolved), last = canonical.length - 3;
  const nonCanonical = canonical.slice(0, last) + ALPHABET[ALPHABET.indexOf(canonical[last]) | 1] + canonical.slice(last + 1);
  invalid['contribute-bad-items'] = {
    description: 'Each bad brain and feedback row is refused alone (the first failing check wins); the good ones are accepted.',
    route: 'contribute',
    body: json(envelope({tracks: [encodeF32(track)], brains: [
      wireBrain(evolved),                                                          // 0 ok
      {vector: 'AAAA', fitness: 1},                                                // 1 encoding
      wireBrain(nanBrain),                                                         // 2 NaN
      wireBrain(heavyBrain),                                                       // 3 16.5
      {vector: encodeF32(clone)},                                                  // 4 no fitness
      wireBrain(clone, {fitness: '12'}),                                           // 5 fitness a string
      wireBrain(clone, {track: 1}),                                                // 6 no track 1
      wireBrain(clone, {dynamics: encodeF32(scaled(unit(9, DIMS.dynamics), 2))}), // 7 dynamics norm 2
      wireBrain(evolved),                                                          // 8 duplicate of 0
      wireBrain(brain(10, 0.5).subarray(0, 243)),                                  // 9 243 floats
      'brain',                                                                     // 10 not an object
      wireBrain(clone, {track: 0}),                                                // 11 ok
      {vector: nonCanonical, fitness: 1},                                          // 12 non-canonical base64
      {vector: encodeF32(evolved).replace(/=+$/, ''), fitness: 1},                 // 13 unpadded
      {...wireBrain(infBrain), fitness: 'x'},                                      // 14 -Infinity and bad fitness: not finite wins
      wireBrain(brain(13), {fitness: LIMITS.fitness + 1}),                         // 15 fitness over the bound
    ], feedback: [
      row(await id(evolved)),                                                      // 0 ok
      row('brain_x'),                                                              // 1 id
      row(await id(clone), {context: 'balanced'}),                                 // 2 context a string
      row(await id(clone), {count: 0}),                                            // 3 count 0
      row(await id(clone), {count: 2.5}),                                          // 4 count not whole
      row(await id(clone), {meanFitness: LIMITS.fitness * 1.5}),                   // 5 mean over the bound
      row(await id(clone), {count: LIMITS.count + 1}),                             // 6 count over the bound
      row(await id(clone), {meanFitness: -LIMITS.fitness * 1.5}),                  // 7 mean under the bound
      row(await id(clone), {context: []}),                                         // 8 context a list
      row(await id(clone).then(x => x + '_2')),                                    // 9 a suffixed local id
      row((await id(clone)).slice(0, 22)),                                         // 10 a 64-bit id
    ]})),
    expect: {ok: true, accepted: [await id(evolved), await id(clone)], rejected: [
      {index: 1, reason: REASONS.brainEncoding}, {index: 2, reason: REASONS.brainNotFinite}, {index: 3, reason: REASONS.brainWeightRange},
      {index: 4, reason: REASONS.brainFitness}, {index: 5, reason: REASONS.brainFitness}, {index: 6, reason: REASONS.brainTrack},
      {index: 7, reason: REASONS.brainDynamics}, {index: 8, reason: REASONS.brainDuplicate}, {index: 9, reason: REASONS.brainEncoding},
      {index: 10, reason: REASONS.brainEncoding}, {index: 12, reason: REASONS.brainEncoding}, {index: 13, reason: REASONS.brainEncoding},
      {index: 14, reason: REASONS.brainNotFinite}, {index: 15, reason: REASONS.brainFitness}],
      feedbackAccepted: 1, feedbackRejected: [
        {index: 1, reason: REASONS.feedbackId}, {index: 2, reason: REASONS.feedbackContext}, {index: 3, reason: REASONS.feedbackNumbers},
        {index: 4, reason: REASONS.feedbackNumbers}, {index: 5, reason: REASONS.feedbackNumbers}, {index: 6, reason: REASONS.feedbackNumbers},
        {index: 7, reason: REASONS.feedbackNumbers}, {index: 8, reason: REASONS.feedbackContext}, {index: 9, reason: REASONS.feedbackId},
        {index: 10, reason: REASONS.feedbackId}]},
  };

  invalid['contribute-item-precedence'] = {
    description: 'Brains and rows with two faults each: the earlier check in the doc wins.',
    route: 'contribute',
    body: json(envelope({tracks: [encodeF32(track)], brains: [
      wireBrain(evolved),                                                                    // 0 ok
      wireBrain(brain(20), {fitness: 'x', track: 5}),                                        // 1 fitness before track
      wireBrain(brain(21), {track: 5, dynamics: 'x'}),                                       // 2 track before dynamics
      wireBrain(evolved, {dynamics: 'x'}),                                                   // 3 dynamics before duplicate
      wireBrain(heavyBrain, {fitness: 'x'}),                                                 // 4 weight range before fitness
      wireBrain(nanHeavyBrain),                                                              // 5 not finite before weight range
      wireBrain(clone, {fitness: 'x'}),                                                      // 6 refused
      wireBrain(clone),                                                                      // 7 ok: only an accepted brain makes a duplicate
    ], feedback: [
      {id: 'x', context: 'x', meanFitness: 'x', count: 0},                                   // 0 id first
      {id: await id(evolved), context: 'x', meanFitness: 'x', count: 0},                     // 1 context before numbers
      {id: await id(evolved) + 'a', context: CONTEXT, meanFitness: 1, count: 1},             // 2 an id of 33 hex digits
    ]})),
    expect: {ok: true, accepted: [await id(evolved), await id(clone)], rejected: [
      {index: 1, reason: REASONS.brainFitness}, {index: 2, reason: REASONS.brainTrack}, {index: 3, reason: REASONS.brainDynamics},
      {index: 4, reason: REASONS.brainWeightRange}, {index: 5, reason: REASONS.brainNotFinite}, {index: 6, reason: REASONS.brainFitness}],
      feedbackAccepted: 0, feedbackRejected: [
        {index: 0, reason: REASONS.feedbackId}, {index: 1, reason: REASONS.feedbackContext}, {index: 2, reason: REASONS.feedbackId}]},
  };
  invalid['contribute-typed-fields'] = {
    description: 'Strings and booleans where numbers or vectors go are refused, never read: a track index "0" or false, dynamics "", a mean fitness "9.5", a count "12" or true.',
    route: 'contribute',
    body: json(envelope({tracks: [encodeF32(track)], brains: [wireBrain(brain(30), {track: '0'}), wireBrain(brain(31), {track: false}), wireBrain(brain(32), {dynamics: ''})],
      feedback: [row(await id(evolved), {meanFitness: '9.5'}), row(await id(evolved), {count: '12'}), row(await id(evolved), {count: true})]})),
    expect: {ok: true, accepted: [], rejected: [{index: 0, reason: REASONS.brainTrack}, {index: 1, reason: REASONS.brainTrack}, {index: 2, reason: REASONS.brainDynamics}],
      feedbackAccepted: 0, feedbackRejected: [0, 1, 2].map(index => ({index, reason: REASONS.feedbackNumbers}))},
  };
  invalid['contribute-track-index-no-tracks'] = {
    description: 'A track index 0 when tracks is empty: brain-track (no index is valid; in Rust, tracks.len() - 1 underflows).',
    route: 'contribute', body: json(envelope({tracks: [], brains: [wireBrain(evolved, {track: 0})]})),
    expect: {ok: true, accepted: [], rejected: [{index: 0, reason: REASONS.brainTrack}], feedbackAccepted: 0, feedbackRejected: []},
  };
  invalid['contribute-track-index-tracks-absent'] = {
    description: 'A track index 0 when tracks is absent: brain-track.',
    route: 'contribute', body: json({...envelope({brains: [wireBrain(evolved, {track: 0})]}), tracks: undefined}),
    expect: {ok: true, accepted: [], rejected: [{index: 0, reason: REASONS.brainTrack}], feedbackAccepted: 0, feedbackRejected: []},
  };
  invalid['contribute-bad-track-indices'] = {
    description: 'A negative and a fractional track index are refused; a whole one in range is accepted.',
    route: 'contribute',
    body: json(envelope({tracks: [encodeF32(track)], brains: [wireBrain(brain(14), {track: -1}), wireBrain(brain(15), {track: 0.5}), wireBrain(brain(16), {track: 0})]})),
    expect: {ok: true, accepted: [await id(brain(16))], rejected: [{index: 0, reason: REASONS.brainTrack}, {index: 1, reason: REASONS.brainTrack}], feedbackAccepted: 0, feedbackRejected: []},
  };

  // ─── recall ─────────────────────────────────────────────────────────────
  valid['recall'] = {description: 'Recall for a track, with the default k.', route: 'recall',
    body: recall(track), expect: {ok: true, k: LIMITS.recallDefaultK, dynamics: false, context: CONTEXT}};
  valid['recall-with-dynamics-k1'] = {description: 'Recall with dynamics and the smallest k.', route: 'recall',
    body: recall(track, {dynamics: encodeF32(dynamics), k: 1}), expect: {ok: true, k: 1, dynamics: true, context: CONTEXT, trackPrint: await id(track), dynamicsPrint: await id(dynamics)}};
  valid['recall-k-64-as-float'] = {description: 'The largest k, written 64.0; null dynamics.', route: 'recall',
    body: recall(track, {dynamics: null}).slice(0, -1) + ',"k":64.0}', expect: {ok: true, k: 64, dynamics: false, context: CONTEXT}};
  valid['recall-k-null'] = {description: 'k null: the default.', route: 'recall',
    body: recall(track, {k: null}), expect: {ok: true, k: LIMITS.recallDefaultK, dynamics: false, context: CONTEXT}};
  valid['recall-context-cleaned'] = {description: "The context is cleaned on the service's side too (typed fields only).", route: 'recall',
    body: recall(track, {context: {profile: 'nope', track: 'x', maxSpeed: '30', traction: [0.3], seconds: '45', collisions: {heatSize: 8}}}),
    expect: {ok: true, k: LIMITS.recallDefaultK, dynamics: false, context: {version: 1, profile: 'balanced', track: 'x', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}}};
  invalid['recall-dynamics-empty-string'] = refused('Dynamics "": refused, not absent.', 'recall', recall(track, {dynamics: ''}), REASONS.dynamics);
  invalid['recall-dynamics-false'] = refused('Dynamics false: refused, not absent.', 'recall', recall(track, {dynamics: false}), REASONS.dynamics);
  invalid['recall-k-0'] = refused('k below 1.', 'recall', recall(track, {k: 0}), REASONS.k);
  invalid['recall-k-65'] = refused('k above 64.', 'recall', recall(track, {k: 65}), REASONS.k);
  invalid['recall-k-fraction'] = refused('k not an integer.', 'recall', recall(track, {k: 2.5}), REASONS.k);
  invalid['recall-k-string'] = refused('k a string.', 'recall', recall(track, {k: '10'}), REASONS.k);
  invalid['recall-track-not-unit'] = refused('A track of norm 1.0011.', 'recall', recall(scaled(track, 1.0011)), REASONS.track);
  invalid['recall-track-short'] = refused('A track of 511 floats.', 'recall', recall(track.subarray(0, 511)), REASONS.track);
  invalid['recall-track-missing'] = refused('No track.', 'recall', json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, context: CONTEXT}), REASONS.track);
  invalid['recall-dynamics-not-unit'] = refused('Dynamics of norm 0.5.', 'recall', recall(track, {dynamics: encodeF32(scaled(dynamics, 0.5))}), REASONS.dynamics);
  invalid['recall-no-context'] = refused('No context.', 'recall', recall(track, {context: null}), REASONS.context);
  invalid['recall-context-a-list'] = refused('A context that is a list.', 'recall', recall(track, {context: [CONTEXT]}), REASONS.context);
  invalid['recall-track-before-k'] = refused('A bad track and a bad k: the track first.', 'recall', recall(scaled(track, 2), {k: 0}), REASONS.track);
  invalid['recall-context-before-k'] = refused('No context and a bad k: the context first.', 'recall', recall(track, {context: null, k: 0}), REASONS.context);
  invalid['recall-track-before-dynamics'] = refused('A bad track and bad dynamics: the track first.', 'recall', recall(scaled(track, 2), {dynamics: 'x'}), REASONS.track);
  invalid['recall-dynamics-before-context'] = refused('Bad dynamics and no context: dynamics first.', 'recall', recall(track, {dynamics: 'x', context: null}), REASONS.dynamics);
  invalid['recall-track-before-context'] = refused('A bad track and no context: the track first.', 'recall', recall(scaled(track, 2), {context: null}), REASONS.track);
  invalid['recall-brain-schema-before-track'] = refused('Another brain format and a bad track: the format first.', 'recall',
    recall(scaled(track, 2), {brainSchema: 5}), REASONS.brainSchema);
  valid['recall-header-as-floats'] = {description: 'protocol 1E0 and brainSchema 6.0.', route: 'recall',
    body: recall(track).replace('"protocol":1,', '"protocol":1E0,').replace('"brainSchema":6,', '"brainSchema":6.0,'),
    expect: {ok: true, k: LIMITS.recallDefaultK, dynamics: false, context: CONTEXT}};
  valid['recall-track-near-unit'] = {description: 'A track of norm 1.000995 is read as it is (not normalised).', route: 'recall',
    body: recall(scaled(track, 1.000995)), expect: {ok: true, k: LIMITS.recallDefaultK, dynamics: false, context: CONTEXT, trackPrint: await id(scaled(track, 1.000995))}};
  valid['recall-negative-zero'] = {description: 'A context with traction -0: cleaned to 0, never -0.', route: 'recall',
    body: recall(track).replace('"traction":0.5', '"traction":-0'), expect: {ok: true, k: LIMITS.recallDefaultK, dynamics: false, context: {...CONTEXT, traction: 0}}};
  valid['recall-k-float-roundtrip'] = {description: 'k 64.000000000000007105 is 64 once read correctly rounded.', route: 'recall',
    body: recall(track).slice(0, -1) + ',"k":64.000000000000007105}', expect: {ok: true, k: 64, dynamics: false, context: CONTEXT}};

  // ─── forget ─────────────────────────────────────────────────────────────
  valid['forget'] = {description: 'Forget a contributor (no brain format needed).', route: 'forget', body: json({protocol: PROTOCOL, token: TOKEN}), expect: {ok: true}};
  valid['forget-ignores-brain-schema'] = {description: 'A forget with another brainSchema: the format is not checked.', route: 'forget',
    body: json({protocol: PROTOCOL, brainSchema: 5, token: TOKEN}), expect: {ok: true}};
  invalid['forget-bad-token'] = refused('Forget with a short token.', 'forget', json({protocol: PROTOCOL, token: 'abc'}), REASONS.token);

  // ─── answers ────────────────────────────────────────────────────────────
  const entry = async (v, i, extra = {}) => ({id: await id(v), vector: encodeF32(v), fitness: 10 - i, score: 1 - i / 100,
    meta: {generation: i, source: 'evolved', learning: {context: CONTEXT, styleScore: 0.5, driving: {averageSpeed: 0.5, smoothness: 0.5, crashed: false}}},
    feedback: {weight: 0.2, count: 4, contributors: 2}, ...extra});
  const fullPool = [];
  for (let i = 0; i < LIMITS.recallK; i++) fullPool.push(await entry(brain(700 + i), i));
  valid['recall-response-full'] = {
    description: 'A full answer: 64 entries with meta (about 100 KB, under the 256 KiB answer limit).',
    route: 'recall-response',
    body: json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, pool: fullPool, tracks: 1, stats: {brains: 64}}),
    expect: {ok: true, pool: fullPool.map(e => e.id), dropped: []},
  };
  valid['recall-response-bounded'] = {
    description: 'Out-of-range or mistyped fields are bounded, not refused.',
    route: 'recall-response',
    body: json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, pool: [await entry(evolved, 0, {fitness: 1e9, score: -1e300, feedback: {weight: 7, count: -3, contributors: '2'},
      meta: {generation: 3, source: 'evolved', bogus: true, parentIds: ['x', await id(clone)], learning: {context: {...CONTEXT, maxSpeed: 500}, styleScore: 3}}})]}),
    expect: {ok: true, pool: [await id(evolved)], dropped: [], first: {fitness: LIMITS.fitness, score: -LIMITS.fitness, feedback: {weight: 1, count: 0, contributors: 0}},
      firstMeta: {generation: 3, source: 'evolved', parentIds: [await id(clone)], learning: {context: {...CONTEXT, maxSpeed: 100}, styleScore: 1}}},
  };
  invalid['recall-response-bad-entries'] = {
    description: 'Entries dropped: a vector with another id, a bad vector, not an object, a repeated id, null; a repeat with a wrong id (the id is checked first); a bad vector and a bad id (the vector is checked first).',
    route: 'recall-response',
    body: json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, pool: [
      await entry(evolved, 0), {...await entry(clone, 1), id: await id(evolved)}, await entry(heavyBrain, 2), 'entry', await entry(evolved, 4), null,
      {...await entry(evolved, 6), id: await id(clone)}, {...await entry(evolved, 7), vector: 'AAAA', id: 'x'}]}),
    expect: {ok: true, pool: [await id(evolved)], dropped: [
      {index: 1, reason: REASONS.poolId}, {index: 2, reason: REASONS.brainWeightRange}, {index: 3, reason: REASONS.shape}, {index: 4, reason: REASONS.poolDuplicate},
      {index: 5, reason: REASONS.shape}, {index: 6, reason: REASONS.poolId}, {index: 7, reason: REASONS.brainEncoding}]},
  };
  const answerPad = n => json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, pool: [], pad: 'x'.repeat(n)});
  const answerOverhead = answerPad(0).length;
  valid['recall-response-exactly-256kib'] = {description: 'An answer of exactly 262 144 bytes.', route: 'recall-response',
    body: answerPad(LIMITS.responseBytes - answerOverhead), expect: {ok: true, pool: [], dropped: []}};
  invalid['recall-response-too-large'] = refused('An answer one byte over 256 KiB.', 'recall-response', answerPad(LIMITS.responseBytes - answerOverhead + 1), REASONS.bodyTooLarge);
  valid['recall-response-bounded-low'] = {
    description: 'Lower bounds: weight -7 is -1, fitness -1e9 is -1e6, a count or contributors over 1e6 is 0; values that are not exact in single precision (10.1, 0.3, 0.1) are kept as they are.',
    route: 'recall-response',
    body: json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, pool: [await entry(clone, 0, {fitness: -1e9, score: 1e300, feedback: {weight: -7, count: LIMITS.count + 1, contributors: LIMITS.count}}),
      await entry(evolved, 1, {fitness: 10.1, score: 0.3, feedback: {weight: 0.1, count: LIMITS.count, contributors: LIMITS.count + 1}})]}),
    expect: {ok: true, pool: [await id(clone), await id(evolved)], dropped: [], first: {fitness: -LIMITS.fitness, score: LIMITS.fitness, feedback: {weight: -1, count: 0, contributors: LIMITS.count}},
      second: {fitness: 10.1, score: 0.3, feedback: {weight: 0.1, count: LIMITS.count, contributors: 0}}},
  };
  invalid['recall-response-too-many'] = refused('65 entries.', 'recall-response',
    json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, pool: Array.from({length: 65}, () => 1)}), REASONS.shape);
  invalid['recall-response-other-schema'] = refused('An answer in another brain format.', 'recall-response',
    json({protocol: PROTOCOL, brainSchema: 5, pool: []}), REASONS.brainSchema);

  valid['contribute-response'] = {description: 'The answer to a contribution.', route: 'contribute-response',
    body: json({protocol: PROTOCOL, accepted: [await id(evolved)], rejected: [{index: 1, reason: REASONS.brainNotFinite}], feedbackAccepted: 3, feedbackRejected: [{index: 0, reason: REASONS.feedbackId}]}),
    expect: {ok: true, accepted: [await id(evolved)], rejected: [{index: 1, reason: REASONS.brainNotFinite}], feedbackAccepted: 3, feedbackRejected: [{index: 0, reason: REASONS.feedbackId}]}};
  invalid['contribute-response-unknown-reason'] = refused('A refused item with an unknown reason.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [{index: 0, reason: 'nope'}], feedbackAccepted: 0, feedbackRejected: []}), REASONS.shape);
  valid['stats-response'] = {description: 'GET /v1/stats.', route: 'stats-response',
    body: json({protocol: PROTOCOL, brains: 20000, tracks: 31, contributorsToday: 4, contributions24h: 120}),
    expect: {ok: true, brains: 20000, tracks: 31, contributorsToday: 4, contributions24h: 120}};
  invalid['stats-response-negative'] = refused('A negative count.', 'stats-response', json({protocol: PROTOCOL, brains: -1, tracks: 0, contributorsToday: 0, contributions24h: 0}), REASONS.shape);
  valid['error-response'] = {description: 'An error answer (HTTP 429).', route: 'error-response', body: json({protocol: PROTOCOL, error: 'rate-limited'}), expect: {ok: true, error: 'rate-limited', status: 429}};
  valid['error-response-disabled'] = {description: 'The breaker is on (HTTP 503).', route: 'error-response', body: json({protocol: PROTOCOL, error: 'disabled'}), expect: {ok: true, error: 'disabled', status: 503}};
  valid['error-response-too-large'] = {description: 'A request over 64 KB (HTTP 413).', route: 'error-response', body: json({protocol: PROTOCOL, error: REASONS.bodyTooLarge}), expect: {ok: true, error: REASONS.bodyTooLarge, status: 413}};
  invalid['error-response-other-protocol'] = {description: 'An error answer in another protocol is a server error.', route: 'error-response',
    body: json({protocol: 2, error: 'rate-limited'}), expect: {ok: true, error: 'server-error', status: 500}};
  invalid['contribute-response-bad-id'] = refused('An accepted id that is not a cloud id.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: ['brain_x'], rejected: [], feedbackAccepted: 0, feedbackRejected: []}), REASONS.shape);
  invalid['contribute-response-index-out-of-range'] = refused('A refused brain at index 16.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [{index: 16, reason: REASONS.brainFitness}], feedbackAccepted: 0, feedbackRejected: []}), REASONS.shape);
  invalid['contribute-response-feedback-count'] = refused('51 feedback rows accepted.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [], feedbackAccepted: 51, feedbackRejected: []}), REASONS.shape);
  invalid['stats-response-unsafe-integer'] = refused('A count beyond 2^53 - 1.', 'stats-response',
    json({protocol: PROTOCOL, brains: 2 ** 53, tracks: 0, contributorsToday: 0, contributions24h: 0}), REASONS.shape);
  invalid['error-response-unknown'] = {description: 'An error the browser does not know is a server error.', route: 'error-response',
    body: 'Internal Server Error', expect: {ok: true, error: 'server-error', status: 500}};

  valid['recall-response-strings'] = {
    description: 'Numbers given as strings are not read: 0.',
    route: 'recall-response',
    body: json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, pool: [await entry(evolved, 0, {fitness: '500', score: '0.5', feedback: {weight: '0.5', count: '4', contributors: true}})]}),
    expect: {ok: true, pool: [await id(evolved)], dropped: [], first: {fitness: 0, score: 0, feedback: {weight: 0, count: 0, contributors: 0}}},
  };
  valid['recall-response-no-pool'] = {description: 'No pool: an empty one.', route: 'recall-response',
    body: json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA}), expect: {ok: true, pool: [], dropped: []}};
  valid['recall-response-negative-zero'] = {
    description: 'Numbers of -0 in an entry come out as 0.',
    route: 'recall-response',
    body: json({protocol: PROTOCOL, brainSchema: BRAIN_SCHEMA, pool: [await entry(evolved, 0, {fitness: 11.5, score: 0.75, feedback: {weight: 0.625, count: 3, contributors: 5}})]})
      .replace('"fitness":11.5', '"fitness":-0').replace('"score":0.75', '"score":-0.0').replace('"weight":0.625', '"weight":-0')
      .replace('"count":3', '"count":-0').replace('"contributors":5', '"contributors":-0e0'),
    expect: {ok: true, pool: [await id(evolved)], dropped: [], first: {fitness: 0, score: 0, feedback: {weight: 0, count: 0, contributors: 0}}},
  };
  invalid['recall-response-invalid-utf8'] = refusedBytes('An answer with a byte (0xff) that is never UTF-8.', 'recall-response',
    bytes('{"protocol":1,"brainSchema":6,"pool":[],"note":"', [0xff], '"}'), REASONS.notJson);
  // Every answer may be up to 256 KiB, not only a recall.
  const bigAnswer = (fields, n) => json({protocol: PROTOCOL, ...fields, pad: 'x'.repeat(n)});
  const answerSize = (fields, target) => bigAnswer(fields, target - bigAnswer(fields, 0).length);
  const contributeAnswer = {accepted: [], rejected: [], feedbackAccepted: 0, feedbackRejected: []};
  const statsAnswer = {brains: 1, tracks: 1, contributorsToday: 1, contributions24h: 1};
  valid['contribute-response-large'] = {description: 'A contribution answer of 100 000 bytes (over 64 KB, under 256 KiB).', route: 'contribute-response',
    body: answerSize(contributeAnswer, 100000), expect: {ok: true, ...contributeAnswer}};
  invalid['contribute-response-too-large'] = refused('A contribution answer one byte over 256 KiB.', 'contribute-response',
    answerSize(contributeAnswer, LIMITS.responseBytes + 1), REASONS.bodyTooLarge);
  valid['stats-response-large'] = {description: 'A stats answer of 100 000 bytes.', route: 'stats-response',
    body: answerSize(statsAnswer, 100000), expect: {ok: true, ...statsAnswer}};
  valid['error-response-large'] = {description: 'An error answer of 100 000 bytes.', route: 'error-response',
    body: answerSize({error: 'disabled'}, 100000), expect: {ok: true, error: 'disabled', status: 503}};
  invalid['error-response-too-large'] = {description: 'An error answer over 256 KiB is a server error.', route: 'error-response',
    body: answerSize({error: 'disabled'}, LIMITS.responseBytes + 1), expect: {ok: true, error: 'server-error', status: 500}};
  invalid['error-response-invalid-utf8'] = {description: 'An error answer that is not UTF-8 is a server error.', route: 'error-response',
    bodyBase64: bytes('{"protocol":1,"error":"disabled","note":"', [0xc3], '"}'), expect: {ok: true, error: 'server-error', status: 500}};
  const idsOf = async n => { const out = []; for (let i = 0; i < n; i++) out.push(await id(brain(800 + i))); return out; };
  valid['contribute-response-at-the-bounds'] = {description: '16 accepted ids, refused indices 15 and 49, 50 rows accepted.', route: 'contribute-response',
    body: json({protocol: PROTOCOL, accepted: await idsOf(16), rejected: [{index: 15, reason: REASONS.brainFitness}], feedbackAccepted: 50,
      feedbackRejected: [{index: 49, reason: REASONS.feedbackId}]}),
    expect: {ok: true, accepted: await idsOf(16), rejected: [{index: 15, reason: REASONS.brainFitness}], feedbackAccepted: 50,
      feedbackRejected: [{index: 49, reason: REASONS.feedbackId}]}};
  valid['contribute-response-lists-absent'] = {description: 'Lists absent or null: empty.', route: 'contribute-response',
    body: json({protocol: PROTOCOL, rejected: null, feedbackAccepted: 0}), expect: {ok: true, accepted: [], rejected: [], feedbackAccepted: 0, feedbackRejected: []}};
  invalid['contribute-response-17-accepted'] = refused('17 accepted ids.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: await idsOf(17), rejected: [], feedbackAccepted: 0, feedbackRejected: []}), REASONS.shape);
  invalid['contribute-response-feedback-index-50'] = refused('A refused row at index 50.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [], feedbackAccepted: 0, feedbackRejected: [{index: 50, reason: REASONS.feedbackId}]}), REASONS.shape);
  invalid['contribute-response-no-feedback-accepted'] = refused('No feedbackAccepted.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [], feedbackRejected: []}), REASONS.shape);
  invalid['stats-response-too-large'] = refused('A stats answer one byte over 256 KiB.', 'stats-response', answerSize(statsAnswer, LIMITS.responseBytes + 1), REASONS.bodyTooLarge);
  valid['stats-response-negative-zero'] = {description: 'Counts of -0 come out as 0.', route: 'stats-response',
    body: json({protocol: PROTOCOL, brains: 7, tracks: 8, contributorsToday: 9, contributions24h: 10}).replace('"brains":7', '"brains":-0').replace('"tracks":8', '"tracks":-0.0')
      .replace('"contributorsToday":9', '"contributorsToday":-0e0').replace('"contributions24h":10', '"contributions24h":-0'),
    expect: {ok: true, brains: 0, tracks: 0, contributorsToday: 0, contributions24h: 0}};
  valid['contribute-response-negative-zero'] = {description: 'feedbackAccepted and an index of -0 come out as 0.', route: 'contribute-response',
    body: json({protocol: PROTOCOL, accepted: [], rejected: [{index: 3, reason: REASONS.brainFitness}], feedbackAccepted: 5, feedbackRejected: [{index: 4, reason: REASONS.feedbackId}]})
      .replace('"index":3', '"index":-0').replace('"feedbackAccepted":5', '"feedbackAccepted":-0').replace('"index":4', '"index":-0.0'),
    expect: {ok: true, accepted: [], rejected: [{index: 0, reason: REASONS.brainFitness}], feedbackAccepted: 0, feedbackRejected: [{index: 0, reason: REASONS.feedbackId}]}};
  invalid['contribute-response-17-rejected'] = refused('17 refused brains (at most 16).', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: Array.from({length: 17}, () => ({index: 0, reason: REASONS.brainFitness})), feedbackAccepted: 0, feedbackRejected: []}), REASONS.shape);
  invalid['contribute-response-51-feedback-rejected'] = refused('51 refused rows (at most 50).', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [], feedbackAccepted: 0, feedbackRejected: Array.from({length: 51}, () => ({index: 0, reason: REASONS.feedbackId}))}), REASONS.shape);
  invalid['contribute-response-index-negative'] = refused('A refused brain at index -1.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [{index: -1, reason: REASONS.brainFitness}], feedbackAccepted: 0, feedbackRejected: []}), REASONS.shape);
  invalid['contribute-response-feedback-accepted-negative'] = refused('feedbackAccepted -1.', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [], feedbackAccepted: -1, feedbackRejected: []}), REASONS.shape);
  invalid['error-response-unknown-reason'] = {description: 'A readable error answer with a reason the browser does not know is a server error.', route: 'error-response',
    body: json({protocol: PROTOCOL, error: 'nope'}), expect: {ok: true, error: 'server-error', status: 500}};
  invalid['stats-response-string'] = refused('A count given as a string ("7").', 'stats-response', json({protocol: PROTOCOL, ...statsAnswer, brains: '7'}), REASONS.shape);
  invalid['contribute-response-strings'] = refused('feedbackAccepted given as a string ("5").', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [], feedbackAccepted: '5', feedbackRejected: []}), REASONS.shape);
  invalid['contribute-response-index-string'] = refused('A refused index given as a string ("3").', 'contribute-response',
    json({protocol: PROTOCOL, accepted: [], rejected: [{index: '3', reason: REASONS.brainFitness}], feedbackAccepted: 0, feedbackRejected: []}), REASONS.shape);
  valid['contribute-response-feedback-unknown'] = {description: 'Rows the service refuses alone: a brain it does not hold, a second row for one brain and context, a new context with none to replace.', route: 'contribute-response',
    body: json({protocol: PROTOCOL, accepted: [], rejected: [], feedbackAccepted: 1, feedbackRejected: [{index: 1, reason: 'feedback-unknown'}, {index: 2, reason: 'feedback-duplicate'}, {index: 3, reason: 'feedback-full'}]}),
    expect: {ok: true, accepted: [], rejected: [], feedbackAccepted: 1, feedbackRejected: [{index: 1, reason: 'feedback-unknown'}, {index: 2, reason: 'feedback-duplicate'}, {index: 3, reason: 'feedback-full'}]}};
  valid['stats-response-max-safe'] = {description: 'A count of 2^53 - 1.', route: 'stats-response',
    body: json({protocol: PROTOCOL, ...statsAnswer, brains: Number.MAX_SAFE_INTEGER}), expect: {ok: true, ...statsAnswer, brains: Number.MAX_SAFE_INTEGER}};
  invalid['stats-response-missing'] = refused('No contributions24h.', 'stats-response',
    json({protocol: PROTOCOL, brains: 1, tracks: 1, contributorsToday: 1}), REASONS.shape);
  invalid['stats-response-fraction'] = refused('A count of 1.5.', 'stats-response', json({protocol: PROTOCOL, ...statsAnswer, tracks: 1.5}), REASONS.shape);

  // ─── tables ─────────────────────────────────────────────────────────────
  const contexts = [
    [CONTEXT, CONTEXT],
    [{}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{profile: 'careful', maxSpeed: 0, traction: 0, seconds: 0}, {version: 1, profile: 'careful', track: '', maxSpeed: 15, traction: 0, seconds: 20, collisions: 'off'}],
    [{profile: 'nope', maxSpeed: 0.5, traction: -1, seconds: 0.2}, {version: 1, profile: 'balanced', track: '', maxSpeed: 1, traction: 0, seconds: 1, collisions: 'off'}],
    [{maxSpeed: 1e9, traction: 2, seconds: 601}, {version: 1, profile: 'balanced', track: '', maxSpeed: 100, traction: 1, seconds: 600, collisions: 'off'}],
    [{maxSpeed: 12.5, traction: 0.25, seconds: 45.5}, {version: 1, profile: 'balanced', track: '', maxSpeed: 12.5, traction: 0.25, seconds: 45.5, collisions: 'off'}],
    [{maxSpeed: '30', traction: '0.3', seconds: true, profile: 7, track: 42}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{maxSpeed: [30], traction: false, seconds: '45'}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    ...['balanced', 'calm', 'careful', 'wild', 'reckless', 'Balanced'].map(profile => [{profile}, {version: 1, profile: profile === 'Balanced' ? 'balanced' : profile, track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}]),
    [{track: 'x'.repeat(181)}, {version: 1, profile: 'balanced', track: 'x'.repeat(180), maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{track: 'café'}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{track: 'a\tb'}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{track: 'x'.repeat(181) + '\t'}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{track: 'x'.repeat(180) + '\t'}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{track: 'a\u007fb'}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{track: ' ~ '}, {version: 1, profile: 'balanced', track: ' ~ ', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    ...[['off', 'off'], ['', 'off'], ['solid/k8/rays', 'solid/k8/rays'], ['SOLID/K008/RAYS', 'solid/k8/rays'], ['solid/k8', 'solid/k8'], ['solid/k08x', 'solid/k8x'], ['solid/kall', 'solid/kall'],
      ['solid/k0', 'solid/k0'], ['solid/k99999', 'solid/k65536'], ['solid/k8/rays/a/b', 'solid/k8/rays/a/b'], ['solid/k8/rays/a/b/c', 'unknown'],
      ['<script>', 'unknown'], ['x'.repeat(40), 'x'.repeat(40)], ['x'.repeat(41), 'unknown'], ['sølid', 'unknown'], ['Solid/K8/Rays ', 'unknown'],
      ['solid/\u212a8/rays', 'unknown'], ['solid/k' + '9'.repeat(30), 'solid/k65536'], ['solid/k' + '0'.repeat(40) + '8', 'solid/k8'], ['solid/k' + '0'.repeat(40) + '8/rays', 'solid/k8/rays'],
      ['Solid/Kall/RAYS', 'solid/kall/rays'], ['unknown', 'unknown']]
      .map(([label, out]) => [{collisions: label}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: out}]),
    [{collisions: {heatSize: 8}}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{collisions: true}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [{version: 9, extra: 1}, {version: 1, profile: 'balanced', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}],
    [[], null], ['balanced', null], [null, null],
  ].map(([input, out]) => ({in: input, out}));
  const cloneId = await id(clone), evolvedId = await id(evolved);
  const meta = [
    [{}, {}],
    [null, {}],
    [[1], {}],
    [{generation: 0}, {generation: 0}],
    [{generation: LIMITS.generation}, {generation: LIMITS.generation}],
    [{generation: LIMITS.generation + 1}, {}],
    [{generation: 41.5}, {}],
    [{generation: -3}, {}],
    [{generation: '41'}, {}],
    [{parentIds: [evolvedId, cloneId, evolvedId, 'brain_x', cloneId + '_2', cloneId.slice(0, 22), 7]}, {parentIds: [evolvedId, cloneId]}],
    [{parentIds: Array.from({length: 10}, (_, i) => 'brain_' + i.toString(16).padStart(32, '0'))}, {parentIds: Array.from({length: 8}, (_, i) => 'brain_' + i.toString(16).padStart(32, '0'))}],
    [{parentIds: 'brain'}, {}],
    [{parentIds: []}, {}],
    // Filter, then deduplicate, then keep 8: a repeated first id still leaves 8.
    [{parentIds: ['brain_' + 'a'.repeat(32), 'brain_' + 'a'.repeat(32), ...Array.from({length: 8}, (_, i) => 'brain_' + (i + 1).toString(16).padStart(32, '0'))]},
     {parentIds: ['brain_' + 'a'.repeat(32), ...Array.from({length: 7}, (_, i) => 'brain_' + (i + 1).toString(16).padStart(32, '0'))]}],
    [{parentIds: ['brain_' + 'a'.repeat(33)]}, {}],
    [{fastestLap: 0}, {}],
    [{fastestLap: 1e-9}, {fastestLap: 1e-9}],
    [{fastestLap: LIMITS.fitness}, {fastestLap: LIMITS.fitness}],
    [{fastestLap: LIMITS.fitness + 1}, {}],
    [{fastestLap: '100'}, {}],
    ...[['evolved', 'evolved'], ['demonstration', 'demonstration'], ['cloud', 'cloud'], ['Evolved', undefined], ['', undefined], [1, undefined]]
      .map(([source, out]) => [{source}, out ? {source: out} : {}]),
    [{learning: {context: CONTEXT}}, {learning: {context: CONTEXT, styleScore: 0}}],
    [{learning: {context: CONTEXT, styleScore: 7}}, {learning: {context: CONTEXT, styleScore: 1}}],
    [{learning: {context: CONTEXT, styleScore: -1}}, {learning: {context: CONTEXT, styleScore: 0}}],
    [{learning: {context: CONTEXT, styleScore: '0.5'}}, {learning: {context: CONTEXT, styleScore: 0}}],
    [{learning: {context: {profile: 'wild'}}}, {learning: {context: {version: 1, profile: 'wild', track: '', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'}, styleScore: 0}}],
    [{learning: {context: []}}, {}],
    [{learning: {styleScore: 1}}, {}],
    [{learning: []}, {}],
    [{learning: {context: CONTEXT, driving: {averageSpeed: 3, nearWallRate: -1, slideRate: 0.5, smoothness: '1', steeringChanges: 2e9, aliveSeconds: -5,
      nearCarRate: 0.25, crashed: 'yes', carContact: true, unknown: 1}}},
     {learning: {context: CONTEXT, styleScore: 0, driving: {averageSpeed: 1, nearWallRate: 0, slideRate: 0.5, steeringChanges: 1e9, aliveSeconds: 0, nearCarRate: 0.25, carContact: true}}}],
    [{learning: {context: CONTEXT, driving: []}}, {learning: {context: CONTEXT, styleScore: 0}}],
    [{learning: {context: CONTEXT, driving: {}}}, {learning: {context: CONTEXT, styleScore: 0, driving: {}}}],
    [{learning: {context: CONTEXT, driving: {smoothness: 2, slideRate: 2, nearCarRate: 2, nearWallRate: 2, averageSpeed: -1, steeringChanges: -1, aliveSeconds: 2e9}}},
     {learning: {context: CONTEXT, styleScore: 0, driving: {smoothness: 1, slideRate: 1, nearCarRate: 1, nearWallRate: 1, averageSpeed: 0, steeringChanges: 0, aliveSeconds: 1e9}}}],
    // (JSON.parse: an own __proto__ key, as a body carries it.)
    [JSON.parse('{"script":"<script>","__proto__":{"polluted":true},"constructor":1,"generation":2}'), {generation: 2}],
  ].map(([input, out]) => ({in: input, out}));
  // The context match the service ranks with: every difference alone, some
  // together, and memories without a context.
  const base = {profile: 'balanced', track: 'g1', maxSpeed: 15, traction: 0.5, seconds: 20, collisions: 'off'};
  const variants = [{}, {profile: 'wild'}, {profile: 'careful'}, {track: 'other'}, {maxSpeed: 22}, {traction: 0.2}, {seconds: 45},
    {collisions: 'solid/k8/rays'}, {collisions: 'solid/k8'}, {collisions: 'solid/kall/rays'}, {collisions: 'unknown'}, {collisions: 'ghost'},
    {profile: 'wild', maxSpeed: 22, seconds: 45, collisions: 'solid/k8'}];
  const match = [];
  for (const q of variants) {
    const query = wireContext({...base, ...q});
    match.push({memory: null, query, factor: matchContext({}, query).factor});
    for (const m of variants) {
      const memory = wireContext({...base, ...m});
      match.push({memory, query, factor: matchContext({learningContext: memory}, query).factor});
    }
  }
  return {valid, invalid, contexts, meta, match};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../tests/fixtures/cloud-brain/', import.meta.url));
  const all = await fixtures();
  await rm(root, {recursive: true, force: true});
  for (const kind of ['valid', 'invalid']) {
    await mkdir(root + kind, {recursive: true});
    for (const [name, fixture] of Object.entries(all[kind])) await writeFile(`${root}${kind}/${name}.json`, JSON.stringify(fixture, null, 1) + '\n');
    console.log(kind, Object.keys(all[kind]).length);
  }
  for (const table of ['contexts', 'meta', 'match']) {
    await writeFile(`${root}${table}.json`, JSON.stringify(all[table], null, 1) + '\n');
    console.log(table, all[table].length);
  }
}
