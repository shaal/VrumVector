# Cloud brain

The shared cloud brain, planned in [cloud-brain.md](../plan/cloud-brain.md).
This page records what each task measured and proved. The toolchain spike
(CB0) has its own page: [cloud-brain-spike.md](cloud-brain-spike.md).

## CB1: the wire format

`AI-Car-Racer/cloud/wire.js`, protocol 1. The browser builds requests and
checks answers with it; the service (CB2, Rust) applies the same rules in the
same order, and both run the same fixtures (`tests/fixtures/cloud-brain/`:
52 valid and 104 invalid bodies, plus `contexts.json` (49 rows) and
`meta.json` (39 rows) for cleaning, and, since CB2, `match.json` (182 rows:
the context match the service ranks with); made by
`node scripts/cloud-brain-fixtures.mjs`). A fixture's body is `body` (text,
sent as its UTF-8 bytes) or `bodyBase64` (raw bytes, for bodies that are not
UTF-8). A fixture's `expect` gives the result, and for some fixtures the
values read: cleaned meta, contexts and feedback rows, fitness values, track
indices, and fingerprints of the vectors read (`brain_` and the first 128
bits of SHA-256 of their bytes, as for a brain id). Numbers compare by value
(`15` and `15.0` are equal), but -0 is not 0.

### Reading a body

Every body, request or answer, is read the same way, in this order; the first
failing step is the reason:

1. **Size**: at most 65 536 bytes for a request, 262 144 for any answer (a
   full recall answer, 64 entries with meta, is 110 305 bytes), counted on the
   raw bytes → `body-too-large`. Both sides read the body as bytes, never
   as text (`text()` drops a byte-order mark and turns invalid UTF-8 into
   replacement characters). The service refuses a `Content-Length` over the
   limit before reading, and reads at most the limit plus one byte (a chunked
   body has no `Content-Length`; `req.bytes()` alone would read all of it
   first). The browser (CB3) gives `await res.arrayBuffer()` to the parsers,
   which take an `ArrayBuffer` or `SharedArrayBuffer` or any view of one (a
   detached one is `shape`, never a throw). They also take text
   already decoded, for tests: its size is counted in UTF-8 bytes, and text
   that is not well-formed Unicode (it has no UTF-8 bytes) is `not-json`,
   checked after the size, as for bytes.
2. **JSON**: strict UTF-8 (a byte-order mark is kept, so it fails as JSON;
   JS `TextDecoder` with `fatal: true, ignoreBOM: true`, Rust
   `std::str::from_utf8`), then parse into a generic value (JS `JSON.parse`, Rust
   `serde_json::Value` with the `float_roundtrip` feature, so every number is
   the nearest double, ties to even, as in JS: three of the four float
   fixtures fail without it). A key
   given twice keeps its last value. Refused as `not-json`: not JSON,
   invalid UTF-8 (a byte that is never UTF-8, an overlong form, an encoded
   surrogate, a cut character), a byte-order mark, containers nested deeper
   than 32 (the body
   object is depth 1 and each array or object inside another adds 1; numbers
   and strings add nothing), a number outside the double range (`1e400`), a
   string or key with a lone surrogate. (A value that a later duplicate key
   replaces is also checked by serde_json but not by `JSON.parse`; such bodies
   are hostile, and the fixtures leave them out.)
3. **Shape**: the body is an object → else `shape`.
4. **Protocol**: `protocol` is the number 1 → else `protocol`.
5. **Brain format**: `brainSchema` is 6 (`BRAIN_SCHEMA_VERSION`) for a
   contribution, a recall and a recall answer → else `brain-schema`.

**Types are strict**, with no coercion: a number must be a JSON number (the
string `"12"` is not), a string a JSON string. **An integer is any number with
an integral value**: `10`, `10.0`, `1e1` are 10 (also `protocol` 1.0 and
`brainSchema` 6e0), and `-0` is 0. **`null` means absent** for every field; a
`null` item in a list is an item that is not an object. **Outputs never hold
-0**: a -0 anywhere (a fitness, a mean fitness, a context number, a meta
number, a number in an answer) comes out as 0 (in Rust, `f64::clamp` keeps
-0: add 0.0).

### Vectors and ids

- **Vectors are canonical padded base64 of little-endian Float32**: exactly
  `4·ceil(4n/3)` characters, the standard alphabet, and the only text that
  encodes those bytes (the unused bits of the last character are zero). A brain
  is its 244 weights (1 304 characters); a track its 512-float CNN embedding
  (2 732); a driving summary its 64-float dynamics vector (344).
- **Tracks and dynamics are unit vectors**: |‖v‖ − 1| ≤ 1e-3, the sum of
  squares taken in double precision in index order (1.0009 passes, 1.0011
  does not).
- **A brain is valid** when all 244 values are finite (`brain-not-finite`) and
  none is over 16 in size (`brain-weight-range`); -0 and subnormals are
  fine.
- **Brain ids are `brain_` and the first 128 bits (32 hex digits) of SHA-256
  of the brain's little-endian bytes** (`crypto.subtle`, so the browser needs
  a secure context: https, or localhost). A review showed that xxHash32 ids (the
  local archive's) can be forged: a different, valid brain with any given
  brain's id took 11 ms for 200 of 200 brains. A shared service must not let
  anyone claim another brain's id, so the cloud uses SHA-256 and the service
  recomputes every id. Local archive ids stay as they are; the browser maps
  local brains to cloud ids from their weights.

### Requests

**`POST /v1/contribute`** `{protocol, brainSchema, token, tracks, brains,
feedback}`. After reading the body, in order: the token (32 lowercase hex
digits → `token`); `tracks`, `brains`, `feedback` are lists or absent
(`shape`); their counts (≤ 4 → `too-many-tracks`, ≤ 16 → `too-many-brains`,
≤ 50 → `too-many-feedback`); every listed track is a unit vector (`track`).
These refuse the whole request; all three list shapes are checked before any
count. Then each brain and each feedback row alone,
the first failing check giving its reason:

- **A brain** `{vector, fitness, track?, dynamics?, meta?}`: an object with a
  valid encoded vector (`brain-encoding`), finite (`brain-not-finite`),
  within ±16 (`brain-weight-range`); `fitness` a number within ±1e6
  (`brain-fitness`); `track` an integer index into `tracks`
  (`brain-track`); `dynamics` a unit vector (`brain-dynamics`); not the same
  brain as an earlier accepted brain in the request (`brain-duplicate`; a
  brain refused earlier does not make a later copy a duplicate). A
  contribution lists its tracks once and brains point at them: with a track in
  every brain, 16 brains with meta, 4 tracks and 50 rows measured 87 627 bytes,
  over the limit; listed once, the same request (the
  `contribute-at-the-limits` fixture, the app's short track keys) is 54 838
  bytes. The counts do not bound the size: with 180-character track keys in
  every context it is 65 332 bytes, with 40-character collision labels too
  67 774, over the limit. A client splits a batch by bytes.
- **A feedback row** `{id, context, meanFitness, count}`: an object with a
  cloud id (`feedback-id`; any other item is `feedback-id` too), a context
  object (`feedback-context`), `meanFitness`
  within ±1e6 and `count` an integer from 1 to 1e6 (`feedback-numbers`).

**`POST /v1/recall`** `{protocol, brainSchema, track, dynamics?, context, k?}`:
in order, `track` a unit vector (`track`), `dynamics` a unit vector
(`dynamics`), `context` an object (`context`), `k` an integer from 1 to 64,
50 when absent (`k-range`).

**`POST /v1/forget`** `{protocol, token}`: the token (`token`); no brain
format. (A `POST` with a `text/plain` body is a CORS simple request; a
`DELETE` would need a preflight.)

### Contexts and meta

- **A context** is cleaned by the app's own `cleanContext`
  (`learning/policy.js`) after only typed fields are kept (`version` and
  anything else is ignored; the result has `version: 1`):
  - `profile`: a string; not one of `balanced`, `calm`, `careful`, `wild`,
    `reckless` (exactly) → `balanced`;
  - `track`: a string of printable ASCII (0x20 to 0x7e; tested on the whole
    string), then cut to 180 characters; anything else → `''`;
  - `maxSpeed`: a number, 0 or absent → 15, then clamped to 1..100;
    `traction`: a number, absent → 0.5 (0 stays 0), clamped to 0..1;
    `seconds`: 0 or absent → 20, clamped to 1..600;
  - `collisions`: a string (anything else → `off`); not printable ASCII →
    `unknown`; `''` or `off` → `off`; otherwise ASCII-lowercased, a
    `solid/k<digits>` prefix rewritten with the number (any length, leading
    zeros dropped) capped at 65 536, and kept if the result is at most 40
    characters of `[a-z0-9]` segments joined by at most 4 more `/`-segments,
    else `unknown`.
  `contexts.json` pins each rule. The service cleans contexts too.
- **Meta** is cleaned, never refused (anything else is dropped; `meta.json`
  pins each rule):
  - `generation`: an integer from 0 to 1e9;
  - `parentIds`: a list; keep the cloud ids, then drop repeats, then keep the
    first 8; an empty result is left out;
  - `fastestLap`: a number over 0, at most 1e6;
  - `source`: `evolved`, `demonstration`, or `cloud` (X2);
  - `learning`: an object with a context object (else left out): the
    context as above; `styleScore` a number clamped to 0..1, else 0;
    `driving`, when an object (kept even if empty): `averageSpeed`,
    `nearWallRate`, `slideRate`, `smoothness`, `nearCarRate` numbers clamped to
    0..1; `steeringChanges`, `aliveSeconds` numbers clamped to 0..1e9;
    `crashed`, `carContact` booleans.

### Answers

| Answer | Shape | Checked by the browser |
|---|---|---|
| Recall | `{protocol, brainSchema, pool: [{id, vector, fitness, score, trackSim, meta, feedback: {weight, count, contributors}}]}` | Up to 64 entries (`shape`; no pool is an empty one); an entry is dropped when it is not an object (`shape`), its vector is bad, its id is not its vector's id (`pool-id`), or its id came earlier (`pool-duplicate`); `fitness` and `score` clamped to ±1e6, `weight` to ±1, counts whole from 0 to 1e6 (else 0); `trackSim` (added in CB3: how near the track it was found on was) clamped to ±1, null when absent or not a number; meta cleaned as above |
| Contribute | `{protocol, accepted: [id], rejected: [{index, reason}], feedbackAccepted, feedbackRejected: [{index, reason}]}` | Up to 16 cloud ids; `rejected` up to 16 items with index 0 to 15, `feedbackRejected` up to 50 with index 0 to 49, reasons known ones, including three only the service gives (CB2): `feedback-unknown`, a row about a brain it does not hold; `feedback-duplicate`, a second row for the same brain and context in one request; `feedback-full`, a new context for a brain whose 8 contexts cannot be replaced (a list absent or null is empty); `feedbackAccepted` an integer from 0 to 50, required; anything else → `shape` |
| Stats | `{protocol, brains, tracks, contributorsToday, contributions24h}` | All four required, integers from 0 to 2^53 − 1 → else `shape` |
| Error | `{protocol, error}` | An unknown or unreadable error (another protocol, not JSON, over 256 KiB, not UTF-8) is `server-error` |

HTTP status of an error answer: 413 `body-too-large`, 429 `rate-limited`
(CB4), 503 `disabled` (the breaker), 500 `server-error`, 400 for every other
reason.

### The weight bound

`node scripts/measure-clone-decay.mjs --decays 0.001,0`: the largest weight
of each clone, 7 teachers on each of Rectangle and Triangle
([raw](cloud-brain-cb1-weights.json)).

| Brains | Largest weight |
|---|---|
| Evolved (the 14 teachers) | 0.88 to 1.00 |
| "Use my driving" clones (weight decay 0.001) | 1.89 to 6.76 |
| Clones without decay | 10.0 to 96.8 |

The bound is 16: 2.4 times the largest clone the app makes (the app always
trains with `USE_WEIGHT_DECAY` 0.001; the test fails if that changes).
Clones without decay are refused; the app never makes them.

### Evidence

`npm run test:cloud-brain` (`tests/cloud-brain-wire.test.mjs`, 10 tests;
every fixture is read as bytes, and a text fixture as text too):

| Claim | How the test checks it |
|---|---|
| The fixtures | On disk exactly as the generator makes them; each body gives its expected result (ids, refused items with reasons, cleaned values, HTTP status); each context and meta row cleans as its table says; every reason code appears in some fixture |
| Precedence | Fixtures with two faults pin which reason wins, for every pair of adjacent checks: size before UTF-8 and before JSON, JSON before shape and before protocol, protocol before format, format before token (contribute) and before track (recall), token before list shapes and counts, every list shape before any count, tracks counted before brains before feedback, counts before tracks; per brain encoding, not-finite, weight range, fitness, track, dynamics, then duplicate; per row id, context, numbers; recall track, dynamics, context, k |
| Floats | Values next to a bound read as the nearest double: `k` 64.000000000000007105 is 64; a mean fitness exactly halfway between 1e6 and the next double rounds to even (1e6, accepted), and one digit past halfway rounds up (refused) |
| Bytes | Invalid UTF-8 (0xff, an overlong form, an encoded surrogate, a cut character) and a byte-order mark are `not-json`, in a request and in answers; 2-, 3- and 4-byte characters pass; exactly 65 536 bytes of mostly 2-byte characters pass; an `ArrayBuffer`, a `DataView`, a `Buffer`, an offset view and a Uint8Array from another realm, shared memory all read the same; a detached buffer is `shape`; text with a lone surrogate (raw, or an escaped half joined to a raw half) is `not-json`, and `body-too-large` when it is also over the limit |
| Strict types | Numeric strings and booleans are refused, never read: a track index `"0"` or `false`, dynamics `""` or `false`, a mean fitness `"9.5"`, a count `"12"` or `true`, `brainSchema` `"6"`; in a context, `maxSpeed` `"30"` and `seconds` `"45"` take the defaults; in a recall answer, numbers given as strings are 0; in a stats or contribution answer (a count, `feedbackAccepted`, an index) they are `shape` |
| Values read | Accepted fitness values (1432.3, which is not exact in single precision, 1e1 as 10, ±1e6), whole feedback rows with cleaned contexts, the track and dynamics vectors in order (fingerprints; a recall track near 1 is not normalised), a recall entry's cleaned meta, and recall-answer numbers not exact in single precision |
| Integers and -0 | `protocol` 1.0 and 1E0, `brainSchema` 6e0 and 6.0, a generation 2.0 are integers; -0 in meta (generation, styleScore, driving, a context number) and in a recall answer comes out as 0 |
| Unit tolerance | Norms 1.000995 and 0.999005 pass, 1.001005 and 0.998995 fail; 1.0009998 passes and 0.9989998 fails (between the norm rule and a squared-norm rule) |
| Exact vectors | 0, -0, ±1, ±16, the smallest subnormal, the largest float, π round-trip bit for bit; 1.0 is `AACAPw==`; wrong lengths, other alphabets, whitespace, unpadded or non-canonical text are refused |
| Ids | Equal to an independent SHA-256 (Node's `crypto`) of the little-endian bytes; -0 and 0 are different brains |
| Constants | The brain format and length match `brainCodec.js`; the track and dynamics sizes match `ruvectorBridge.js`; the HTTP statuses |
| Round trip | Requests built by the browser parse back to what went in; an all-zero dynamics summary is left out rather than getting the brain refused |
| Real brains | A 64-car genetic population passes; an undecayed clone's 52 is refused |
| Hostile input | 500 random byte edits and 1 500 random text edits of the fixtures (flipped, cut, spliced characters; `1e309`, `__proto__`, `constructor`, deep arrays, NUL, lone surrogates, `12.0`, `-0`) and bodies nested 20 000 deep, through all seven parsers: no throw, every refusal a known reason |
| Mutations | Five sets, 266 single changes: 63 of the author's, 47 of the second review's, 28 after the third, 42 of the fourth review's and 86 of the fifth's (some are earlier changes rewritten for code that moved): bounds, check order, types, canonical base64, byte order, the hash, depth, surrogates, strict UTF-8, byte containers, deduplication, defaults, clamps, the label rules, -0, the values read, the answers and their size. All fail a test except 13. Eleven behave the same as the code on any JSON input: the base64 length and alphabet pre-checks (the canonical check repeats them); typing `crashed`/`carContact` and the driving numbers, and cutting a track key at 181 (`cleanLearning` and `cleanContext` repeat them); `+x` for `Number(x)` in the style-score clamp; `item === null` for "not an object" in an answer's refused items and an entry's `feedback` (a JSON string, number or list has no such keys); depth counted on containers only, and lowercasing ASCII only, which are now the rules themselves (the parsers pass only printable-ASCII labels to `collisionsLabel`; the app's own `collisionsLabel` still lowercases any letter, which does not reach the wire, because `brainToWire` sends its ASCII result); `<` for `<=` in the unit check, which differs only when \|‖v‖ − 1\| is exactly the double nearest 1e-3, which no fixture reaches. One differs only in some browsers: decoding a view of shared memory without a copy (Node's `TextDecoder` accepts it). One differs from the rule: summing the squares in single precision, only within about 1e-6 of the tolerance (the rule says double precision). Before the reviews' rewrite, 52 of 78 survived. |

### Limits

- CB2 implements these rules in Rust (`cloud-brain/core/src/wire.rs`) and
  runs the same fixtures.
- Rate limits, quotas and trust (quarantine until corroborated) are CB4
  ([below](#cb4-abuse-and-trust)).
- The browser keeps its xxHash32 ids locally; CB3 computes cloud ids from
  weights when it contributes and when it records parents.

## CB2: the service

`cloud-brain/`: a Rust Worker for `wasm32-unknown-emscripten` (workers-rs
0.8.7) with one SQLite Durable Object, `SharedBrain`. The logic is a library
crate without the Workers runtime (`cloud-brain/core`), tested natively; the
Worker adds the front door, the object and its SQLite store.

### What it does

- **Front door** (before the object): `GET /health` and, in a spike build,
  `/spike/*` go to the object; everything else outside `/v1/` is 404 (a
  `POST /health` never reaches the object).
  `DISABLE_BRAIN=true` answers every `/v1/` route 503 `disabled`, readable by
  the page. Origins are multiplayer's (`*.vectorvroom.pages.dev`,
  `vectorvroom.shaal.dev`, `vv.shaal.dev`), plus `http://localhost:<port>`
  and `http://127.0.0.1:<port>` with `ALLOW_LOCAL=true`; any other origin
  (or none) is 403. `OPTIONS` answers the CORS preflight. A body with a
  `Content-Length` over 64 KB is refused before it is read, and a body
  without one is read only up to the limit (413 `body-too-large`). Routes:
  `POST /v1/recall`, `POST /v1/contribute`, `GET /v1/stats`
  (`POST /v1/forget` and the rate limits came with CB4). When the object fails (a panic, a
  reset), the page still gets a readable 500 `server-error` with CORS
  headers. The object itself serves only those three routes (404 before
  reading a body), and refuses with `disabled` while the breaker is on.
- **Parsing**: `core/src/wire.rs`, the CB1 rules in Rust: strict UTF-8
  (`std::str::from_utf8`), serde_json with `float_roundtrip`, canonical base64
  (the `base64` crate's standard engine), SHA-256 ids. Every CB1 request
  fixture gives the browser's result (`cargo test`), including the values read.
- **The brain** (`core/src/brain.rs`): tracks are one index of 512-float
  embeddings (ruvector-core `VectorDB`, memory-only, a flat cosine index);
  a listed track within cosine distance 0.005 of a held one is that track
  (as the browser dedupes). Dynamics are a second index, 64 floats a brain.
  Nearest neighbours tie by id, so a rebuild ranks equal distances the same
  way (the flat index alone orders them as its hash map iterates; when the
  ties reach past what it was asked for, it is asked for all of them). Brain
  weights and meta stay in SQLite: a recall reads only the brains it
  returns, and checks each one's id against its weights. In memory a brain
  is its fitness, track, and what the context match compares (the collision
  label as a hash): about the same for every brain, however large its meta.
- **Recall** ranks as the browser ranks its own memory (`_rankSeeds` with a
  learning context): the brains of the 5 nearest tracks (every brain when no
  track is held), each scored
  (0.5 + 0.5·track similarity) × (0.5 + 0.5·tanh(fitness / 100)) ×
  (1 + 0.3·dynamics similarity, for the 25 nearest dynamics) ×
  matchContext factor × (1 + 0.3·feedback weight in the query's context);
  the best k. Each entry carries `trackSim`, the similarity of the track it
  was found on (0 from the fallback), since CB3.
- **Feedback** follows the browser's `observeOffspring`: in the brain's own
  context (the same context key, with a track key, as `matchContext`'s exact
  match needs) the baseline is its fitness; in another context the first
  row only sets a baseline; one row counts per brain and context in a
  request (a second is `feedback-duplicate`), as the browser counts one
  outcome per brain; the weight is an exponential moving average (0.3) of
  (mean − baseline) / max(1, |baseline|), clamped to ±1. A row about a brain
  the service does not hold is refused as `feedback-unknown` (a service-only
  item reason, known to `wire.js`). Feedback is kept for 8 contexts a
  brain. A new context replaces the least reported one among those reported
  once or not for 7 days, never one this request reported, so new contexts
  (however many, from anyone) cannot push out what repeated reports built up;
  with none to replace, the row is `feedback-full`. At most 8 distinct
  contributors are counted per brain and context. Memory holds each brain
  and context in a 64-byte record (about 150 bytes with its map; the
  context as a 64-bit hash, contributors as 32-bit ones); the context itself
  stays in SQLite.
- **Contributions are idempotent**: a brain already held is accepted again
  and changes nothing (the first contributor keeps it).
- **Caps**: 20 000 brains and 5 000 tracks. Over 20 000, the least valuable
  brains go: fitness adjusted by feedback (the count-weighted mean weight),
  the oldest first among equals; never a brain of this request, nor one of
  each track's 3 best. A new track over 5 000 replaces the oldest track no
  brain uses and this request does not list; when there is none, the brain
  is kept without a track (it can still come through the every-brain
  fallback).
- **Stats**: brains, tracks, distinct contributors seen since UTC midnight
  (from the `contributors` table), contributions in the last 1 440 minutes
  (counted by the minute: 1 440 counters, however many requests arrive).
  So memory is bounded by the caps, not by how many requests arrive (CB4
  adds quotas for their cost; the `contributors` table still gains a row
  for every new token, which CB4's forget and quotas prune).
- **Storage**: SQL schema 1 (a `migrations` table records what ran,
  `meta.sql_schema` the latest; every statement can run again, so a
  migration cut short finishes at the next start, and a database newer than
  the build is refused rather than served): `tracks`, `brains` (weights and dynamics as
  little-endian blobs, meta as cleaned JSON), `feedback` (per brain and
  context), `contribution_minutes` (24 hours), `contributors` (first and
  last seen; CB4's quotas). A contributor is 128 bits of SHA-256 of their
  token; the token is never stored. A rebuild deletes rows that no longer
  clean (a corrupt meta, a vector of the wrong size, feedback over the cap
  or about a brain not held), so a brain serves the same live and rebuilt.
- **Consistency**: the object parses a request before it touches the
  brain (a refused body never builds it), and builds the brain from SQLite
  on the first request that needs it, streaming the rows (never a second
  copy of the store in memory), with no await in between, so no request sees it
  half built (the effect of `blockConcurrencyWhile`). A request takes the
  brain out and puts it back only when it succeeds: after a store error or a
  panic the next request rebuilds it from what SQLite holds. workers-rs 0.8.7
  has no `transactionSync`, so a request's writes are not one transaction; the
  store is written in an order that leaves it valid after any prefix (a
  failed contribution may keep some of its brains; sending it again is safe).

### Measured

`node scripts/cloud-brain-load.mjs` under `wrangler dev` (local workerd;
Apple M3 Max), the spike build for the memory reading
([raw](cloud-brain-cb2-load.json)): 20 000 brains, each with dynamics and
the largest meta a brain can carry (a 180-character track key, a
40-character collision label, 8 parents), on 5 000 tracks, contributed 16 at
a time; then the most feedback the caps keep: 8 contexts on every brain,
each reported by 8 contributors (1 280 000 rows, 50 a request).

| | |
|---|---|
| Filling it (1 250 contributions) | 18.0 s; a contribution p50 13.4 ms, p95 22.1 ms |
| Recall (k 64, with dynamics) | p50 12.8 ms, p95 14.5 ms; with all the feedback p50 17.9 ms; the largest answer 47 240 bytes |
| The object's Wasm memory (a high-water mark; the limit is 128 MB) | 16.3 MiB empty; 48.6 MiB with the brains; 70.1 MiB with all the feedback, after a rebuild, and after eviction |
| First recall after a restart (the brain rebuilt from SQLite) | 1 064 ms |
| 1 008 more brains (eviction) | the count stays 20 000; a contribution p50 82 ms, p95 119 ms |

The table is the last run, on the build this page describes. Latencies vary
between runs: the run before (the same feedback, before the last review's
fixes) measured 680 ms for the first recall after a restart and 53 ms for a
contribution at the cap, and a review on a busier machine measured about
1.7 times an earlier build's figures. Memory did not vary between runs.

Before the review, memory held each brain's meta and every feedback context
with all its contributors: the same flood (with 32 contexts and 256
contributors a context allowed) reached 101 MiB, and an unbounded one passed
128 MB and failed again at every rebuild. Now memory is bounded by the caps.
The caps stand at 20 000 brains and 5 000 tracks.

A contribution at the cap costs 40 to 70 ms more (every brain is valued to
pick what goes), and the first recall after a restart reads every row
(about 185 000 of them here). On
the Workers Free plan's 10 ms CPU a request, neither fits (D2). With 5
nearest tracks and 4 brains a track, these recalls returned 20 brains: a
pool is as large as the nearest tracks' brains.

### Evidence

| Claim | Test |
|---|---|
| The CB1 rules, in Rust | `cargo test` (`core/tests/fixtures.rs`): every request fixture (contribute, recall, forget: 104 bodies, 8 of them as bytes) and the context and meta tables give the browser's results, values read included |
| The brain | `core/tests/brain.rs`, 35 tests: a round trip bit for bit; idempotent contributions; near tracks as one; ranking by track, fitness, context and dynamics; the every-brain fallback; feedback in the brain's own and another context; the 8-context and 8-contributor caps (after a reopen too); eviction by value, age, and the protected brains, and an evicted brain's feedback gone with it; the track cap (the oldest unused track goes, never one the request lists); one feedback row per brain and context in a request; a context without a track key never exact; a baseline that moves in another context; feedback in another context leaving the ranking alone; the 25 nearest dynamics counted in order; equal distances ranked the same after every rebuild; a contribution at midnight counted today; the score equal to the documented product (so each constant is pinned); the 5 nearest tracks searched, not a sixth; a brain's value weighing each context by its count; 3 000 contributions counted in 3 minute rows; 96 equal distances ranked the same after every rebuild; new contexts refused (`feedback-full`) rather than pushing out a context reported 5 times, which only goes once it is a week old; rows that do not clean deleted at rebuild; a day of minutes the most memory and the store hold; a reopened brain answers byte for byte as before; a store that fails after each of its first 12 writes reopens consistently; stats over a day boundary; 64 entries with the largest meta fit in 256 KiB and hold no -0; the context match equals `matchContext` on 182 pairs (`match.json`); 6 000 edited bodies through parsers and brain without a panic |
| The Worker | `npm run test:cloud-brain:service` (`tests/cloud-brain.test.mjs`, 8 tests, the built Worker under `wrangler dev`): health; origins (6 refused, 5 allowed), CORS headers, the preflight, 404s; a body over 64 KB refused by length and as a stream, and exactly 64 KB read; every CB1 contribute and recall fixture (101) over HTTP with the status and reason the fixture gives, answers read with `wire.js`'s own parsers; a contribution comes back bit for bit; feedback reaches the pool; stats; the same recall answer byte for byte after a restart; the breaker |
| Mutations of `brain.rs` | 41 single changes over two rounds (constants, bounds, orders, caps, protections, ties, windows, the context replacement rule, the minute counts, the rebuild's cleanup): all fail a test but two that behave the same (the best of a brain's track similarities, when a brain has one track; `<` for `<=` at the 24-hour edge, which the stats filter repeats) |
| Both targets | `bash scripts/build-cloud-brain.sh --test`: native tests, then the Worker checked for `wasm32-unknown-unknown` (D1's fallback; `getrandom` gets its JavaScript backend there) |
| The spike routes | `npm run test:cloud-brain:spike` still passes: they stay, behind the `spike` feature and `CLOUD_BRAIN_SPIKE=1`, and the load script reads memory through them |

## CB3: the browser client

`AI-Car-Racer/cloud/`: `mode.js` (which memory), `client.js` (the outbox and
HTTP), `session.js` (the bridge and the client kept in step), `ui.js` (the
Memory control), `config.json` (`{"endpoint": null}` until CB5 deploys the
service). The client never imports the bridge: it is tested in Node with a
fake `fetch`.

### How it works

- **Switching.** The Vector Memory panel shows **Memory: This browser ·
  Shared (cloud, beta)** where a service is configured and the page is a
  secure context (`crypto.subtle` computes cloud ids); elsewhere the row is
  hidden. A radio alone changes nothing (arrow keys move through radios):
  a Switch button, which says it reloads the page, switches. Switching to
  Shared first says what is sent: the best cars' weights (a clone of your
  own driving too, marked as such), fitness, laps, generation and lineage,
  driving summaries and the 64-number driving signature, the track's
  embedding and a fingerprint of its shape, learning settings, offspring
  results, with an anonymous token that links contributions to each other;
  the service sees the IP address and does not store it; recordings are
  never sent. The choice and the consent are saved (`vv.cloudBrain`) and
  the page reloads.
  `?brain=shared` and `?brain=local` choose too, and are then removed from
  the address, so the control is never overridden by a link. A link that
  opens shared mode records no consent: the page asks the same question
  before anything is sent, and Cancel returns to this browser's memory.
- **Isolation.** `cloud/scope.js`, the first script of the page, fixes the
  mode before any other code runs. Shared mode opens its own IndexedDB
  (`rv_car_learning_shared`; the GNN, LoRA and SONA state live there too),
  talks to other tabs only on `vectorvroom-archive-shared`, and keeps its own
  copy of the training state in `localStorage` (`<key>.shared` for the car
  saved each generation and used as a prior seed, the driver champions, the
  transfer guards, the schema version, and their siblings). So neither
  mode's training reaches the other's.
- **Push.** A brain this tab archives (not one it pulled, nor one another tab
  sent) goes to the outbox with its cloud id, its parents' cloud ids (local
  archive ids mapped to SHA-256 of their weights), its track and dynamics
  scaled to unit vectors, its meta, and its source: `demonstration` when the
  archived elite is the exact copy of your driving ("Use my driving":
  `buildPopulation` keeps a per-car origin, the sim worker reports the
  elite's), else `evolved`. Offspring feedback the bridge applies goes too,
  as cloud ids. What the page archives before the session attaches (while
  it loads its config) waits in the bridge and is handed over. The outbox
  lives in `localStorage` (`vv.cloudBrainOutbox`; the newest 64 brains and
  200 rows), shared by this browser's tabs under a Web Lock (every change
  re-reads it; a browser without Web Locks serializes each tab alone, so
  two tabs could send the same item twice), and is sent at most every 10 s, split by the counts (16
  brains on 4 tracks, 50 rows) and by bytes (64 KB). A request holds one row
  per brain and context (the next row about it waits for the next request,
  so each generation counts) and no row about a brain still waiting.
  Refused items, and requests the service refuses whole, leave the outbox;
  a pause, a 429 or a 5xx keeps it. If `localStorage` is full, the stored
  copy is removed rather than left stale (sent twice after a reload).
- **Pull.** A pool for the current track (k 50) is recalled when the page
  starts (the editor's track is embedded if the run has not started, so the
  first generation is already seeded from it), when the track changes, and
  every 5 generations (counted by the coach, whether or not a generation
  archived a new brain: a plateau needs fresh shared brains the most), and
  when the learning context changes (a pool's ranking and feedback are per
  context). Its
  brains enter the replica through the
  bridge (`acceptCloudPool`), tagged source `cloud`, without training this
  tab's LoRA or SONA on them and without being relayed to other tabs. A
  brain the service found on a track this near (`trackSim` ≥ 0.95) is filed
  on the current track; others are kept without a track (only the fallback
  for a replica with no brain on its nearest tracks uses them) until a later
  pull finds them on a near track, which files them there. The replica
  takes up to 2 000 pulled brains, then only ones on the current track up
  to 4 000; past that a pull only refreshes feedback. A pulled brain keeps
  its `cloud` tag when it is archived again. The service's feedback
  for this context replaces the replica's own weights. `recommendSeeds`
  stays synchronous and ranks the replica as before.
- **Offline.** A failure backs off from 1 s, doubling, to 60 s (±20 %) on a
  monotonic clock; sending and reading back off apart (a busy contribution
  queue does not stop recalls, and a recall does not end its backoff), and
  a network failure holds both until either succeeds. A refused recall
  backs off too. The status line turns into "Shared brain offline —
  training from the last copy (retrying in N s)", counting down; training
  never waits on the network; only the state is announced to screen
  readers, not the countdown. A small notice also shows at the bottom of
  the page while offline (the panel is often collapsed). "Paused" when the
  service's breaker is on; "refused this version — reload to update" when
  the service refuses the page's protocol or brain format, and then nothing
  more is sent or asked until the page reloads (the outbox is kept for the
  newer page). A busy service's backoff outlasts a network failure on top
  of it. The status says "connecting" until the first answer.

### Evidence

| Claim | Test |
|---|---|
| The client | `npm run test:cloud-brain` (`tests/cloud-brain-client.test.mjs`, 19 tests, with a JS fake of the service in `tests/helpers/cloud-brain-fake.mjs`): the mode and consent (the URL chooses, the saved choice otherwise, never shared without a secure context; only a yes records consent, kept across switches); the token; no request at all without an endpoint, and only https or local http endpoints; the outbox survives a new page and empties once sent; 40 brains with the largest meta and 120 rows split into requests within the counts and 64 KB (some filled past 50 KB); one row per brain and context per request (three generations' rows about one parent all counted) and no row ahead of its brain (24 brains and their rows, all counted); two tabs sharing the outbox lose nothing and send nothing twice; refused items and refused requests never resent; offline backoff 1, 2, 4 … 32, 60, 60 s with no request in between, and kept items sent on recovery; paused and busy keep the outbox; sending and reading back off apart, and a refused recall backs off; a full `localStorage` leaves no stale copy; a page refused as outdated sends and asks nothing more and keeps its outbox for a newer page; a network failure does not erase a 429 backoff; the config is fetched once a try and retried only when unreadable; recall and stats; a session maps ids, scales vectors, pulls on start, on a new track, on a new learning context, every 5 generations (new brains or not, and after the coach's count restarts), and not without a track or with a track of zeros; the clone's exact copy keeps its origin in `buildPopulation`, and the real sim worker reports it only for a clone elite |
| The app | `npm run test:cloud-brain:browser` (`tests/cloud-brain-browser.mjs`, Chromium): no Memory row without a service; with one, a radio alone switches nothing, and Switch to Shared shows the disclosure first (dismissed: nothing saved), accepting reloads into shared mode, and back; a link to shared mode asks first (declined: back to local, nothing sent), is removed from the address, and an opt-out from the control survives a reload; on the fake, the pull on start fills the replica (6 brains, tagged `cloud`) and the first generation (generation 0, read while it runs) is seeded from it (15 of 16 cars), trained brains and offspring feedback about the pulled brains are pushed with context and source, the pulled brains kept without a track are filed on it once a pull finds them there, offline shows the banner (the countdown outside the announced text) and the notice outside the panel, and recovers; **a clone of your driving** (one car, the clone in the protected slot) is archived and sent tagged `demonstration`; **isolation**: after two local generations and a shared session with contributions and pulls, every store of `rv_car_learning` is byte-identical, and a local generation after it takes no shared brain and the local champions are unchanged; **two profiles on the real local service** (the built Worker under wrangler dev): A trains and its brains reach the service; B, fresh, has 15 of 16 cars of its generation 0 seeded from A's brain; after B trains, a brain in A's pool has feedback from 2 contributors (the run writes `test-results/cloud-brain/browser.json`). The whole test passes in Chromium (four runs in a row) and in WebKit (`BROWSER=webkit`, Safari's engine: Web Locks and the storage scoping behave the same); Firefox would not launch in this environment at all (a blank page timed out), so it is not verified |
| Nothing else moved | `npm run test:learning` (147), `test:learning:browser`, `test:demonstration:browser` (which now checks that every car has an origin and no more carry `demonstration` than were drawn from your driving), and the collision suites (the worker's message is unchanged unless the elite is a clone) |

### Limits

- Both modes share what is not training state: "Use my driving" recordings
  (`vv-demonstrations`), settings, the graphics and multiplayer choices, the
  track's checkpoints, and the named brain saves (`vv_brainsave_*`: loading
  one into a mode is the player's choice).
- A link that opens shared mode asks with the browser's own dialog, which
  holds the page until answered (a sandboxed frame answers Cancel: the page
  stays local).
- Pulled brains carry the fitness the service serves, on the track they
  were found on; a brain from another circuit is kept without a track. (Up
  to CB4 that was the claimed fitness; since CB4 it is the trusted fitness,
  refreshed at every pull until this tab measures the brain.) A pool is at
  most the nearest tracks' brains, so it can be smaller than k.
- A brain the service later quarantines or evicts stays in a replica that
  already pulled it (the replica is capped at 2 000 pulled brains).
- Claimed fitness was trusted until CB4 (quarantine until corroborated).
  Feedback sent twice (a lost answer, then a retry) counts twice: since
  CB4 twice in one contributor's own value, never as a second contributor.
- The service is not deployed: CB5 writes the endpoint into
  `cloud/config.json` at deploy.

## CB4: abuse and trust

Everything a contributor says is a claim until someone else's offspring
back it: a brain's claimed fitness, and its contributor's reports about its
offspring. CB4 adds that trust rule, feedback kept per contributor, limits
per address and per token, `POST /v1/forget`, and native fuzzing; the
browser follows the served fitness.

### What it does

- **Quarantine (D7).** A brain is corroborated once two contributors other
  than its own have reported its offspring in the brain's own context (its
  learning context, when that has a track key: there every row is measured
  against the claim). Until then it ranks, is valued for eviction and is
  served as fitness `min(claim, 0)`: a neutral fitness term, or its claim
  if that is lower (a claim can only lower a brain). It is still served, so
  others can breed from it and report. Once corroborated it is worth what
  its offspring showed (the trimmed mean of the mean fitness each of those
  contributors reported last), at most its claim and at least
  `min(claim, 0)`: a claim of 1e6 whose offspring score 50 is worth 50;
  offspring that do better never raise a claim; reports of -1e6 bring an
  honest brain back to a neutral fitness, no lower (its feedback weight
  still ranks it, down to 0.7 times, as any brain whose offspring did
  badly: below a brain nobody reported). A recall answer's `fitness` is
  this trusted fitness (the browser ranks its replica by that number).
  Recall has no token, so this applies to everyone, the brain's own
  contributor too (their replica holds the brain with its real fitness).
  A brain whose context has no track key is never corroborated.
- **Feedback per contributor.** A brain and context keep, in one 64-byte
  record, up to 8 contributors (the ones who reported most recently; a
  ninth replaces the least recent), each with a weight and the mean fitness
  they reported last. A contributor's first measured row sets their
  weight; later rows move it by an exponential moving average (0.3). In
  the brain's own context each row is measured against its claim; in
  another, against the contributor's own previous mean (their first row
  only sets it), so no contributor's reports shift another's. The weight
  served and ranked with is the trimmed mean of the contributors' weights:
  with 3 or more, the lowest and highest quarter (rounded up) are left
  out, so one contributor among 3 cannot pull it to their end, and each
  contributor counts once however often they report. (A 2σ filter was the
  other option: it cannot drop anything among 5 values or fewer, since none
  is 2σ from their mean, and 8 is the most there are.) A contributor's rows
  about their own brains are accepted and change nothing. `count` is the
  other contributors' rows, `contributors` how many are kept. In memory a
  contributor is a 16-bit tag, the first 4 hex digits of their id (8 tags,
  8 weights in steps of 1/32 767 and 8 bfloat16 means fit the 64 bytes);
  the store keeps each slot's full contributor id. Two contributors to one brain and context share a tag
  about once in 65 536 pairs; they then share a slot, credited to the one
  who reported last.
- **Contexts.** A brain's own context is always kept: its first row takes
  the place of the weakest other context. A new other context replaces the
  weakest (fewest contributors with a value, then fewest rows, then the
  oldest) among those one contributor at most measured, or none for 7
  days; never the brain's own, nor one this request reported; with none,
  `feedback-full`. Rows that only set a baseline count for nothing. So
  junk contexts from one token (however many rows) hold no place, and
  nobody can keep a brain from being corroborated.
- **Eviction** values brains by trusted fitness, and weighs each context's
  weight by its contributors with a value (not its rows). Each track's 3 best
  corroborated brains are kept: an uncorroborated brain holds no place, as
  anyone can make a track of their own.
- **Per-address limits** (the front door, before the body is read; the
  Rate Limiting binding): 20 contributions, 60 recalls, stats and health
  checks, and 3 forgets a minute, per `CF-Connecting-IP` (an
  IPv6 address by its /64, which one host holds). A browser sends at most 6
  contributions a minute. The address is a key, never stored. Past a
  limit: 429 `rate-limited`, `Retry-After: 60`, with CORS (and
  `Access-Control-Expose-Headers: Retry-After`) so the page can read it.
  Without a binding, or when it fails, the request goes on (logged):
  `/health` says `limits: false`, and the quotas still hold.
- **Daily quotas** per token (UTC day): 10 000 requests, 5 000 brains and
  50 000 feedback rows (those that parse), enough for a tab that trains all
  day (at most one contribution every 10 s). A contribution that would go
  past any of them is refused whole, 429 `rate-limited` with `Retry-After`
  the seconds to midnight, and writes nothing. `QUOTA_REQUESTS`,
  `QUOTA_BRAINS` and `QUOTA_FEEDBACK` change them (a string, a number or a
  boolean in `vars` all read; so does `DISABLE_BRAIN`). The counts live in
  the `contributors` table, which holds today's contributors only (older
  rows go as requests arrive).
- **Forget.** `POST /v1/forget {protocol, token}` →
  `{protocol, brains, feedback}`: every brain the token contributed goes,
  with its feedback, and the token's slot is taken out of every record the
  store holds with its full id (a record left empty goes); the numbers are
  what went. Not limited by the quota (the address limit counts it) and not
  counted. What it reads: the records with a slot of the token's 16-bit
  tag are in memory; up to 256 are read by key (a token that reported
  nothing reads a tag's share of the records, a few), more (a heavy
  contributor, or a token made to share one's tag) in one pass over the
  stored records, 500 at a time, so a forget never reads more than the
  records once and builds no list of them. What stays: tracks (they are no one's), the row counts of
  records the token was in, parent ids in other brains' meta, copies in
  replicas, today's quota counts. A brain two tokens contributed goes with
  the first.
- **The browser.** A pulled brain keeps the service's trusted fitness,
  refreshed at every pull until this tab measures it (archives it again);
  its offspring here are not measured against it (the first outcome only
  sets a baseline, as in another context), since 0 before corroboration is
  not a measurement.
- **Storage**: SQL schema 2. Nothing was deployed at schema 1, so the
  migration starts feedback over (schema 1 had one weight for everyone)
  and recreates `contributors` with the day's counts; an index on
  `brains.contributor` serves forget. A record's slots are `id:weight:mean`,
  the most recent first; a record whose slots do not read, or whose tags
  are not their ids', is deleted at the next rebuild.

### Measured

`node scripts/cloud-brain-load.mjs` under `wrangler dev` (local workerd;
Apple M3 Max), the spike build for the memory reading
([raw](cloud-brain-cb4-load.json)): CB2's load (20 000 brains with the
largest meta on 5 000 tracks; then 8 contexts on every brain from 8
contributors, 1 280 000 rows), the quotas lifted and each request from its
own address; then three forgets.

| | CB4 | CB2 |
|---|---|---|
| Filling it (1 250 contributions) | 15.3 s; p50 10.8 ms, p95 16.9 ms | 18.0 s; 13.4, 22.1 ms |
| Recall (k 64, with dynamics) | p50 12.1 ms, p95 13.8 ms; with all the feedback p50 12.8 ms | 12.8, 14.5; 17.9 ms |
| The object's Wasm memory (high-water) | 16.3 MiB empty; 48.6 with the brains; 70.1 with all the feedback, after the forgets, after a rebuild and after eviction | the same |
| First recall after a restart | 1 142 ms | 1 064 ms |
| 1 008 more brains (eviction) | p50 64 ms, p95 85 ms | 82, 119 ms |
| Forget: a token nobody used | 18 ms | |
| Forget: a token made to share the flooder's tag (in every record) | 133 ms (one pass over 160 000 records), nothing forgotten | |
| Forget: the flooder (in all 160 000 records) | 3 038 ms, 160 000 records rewritten | |

The 64-byte records keep memory where CB2 left it. Before forget read the
records a page at a time, forgetting the flooder raised the high-water mark
to 101 MiB (a list of every record); with the ids taken from each slot
rather than hashed again, the first recall after a restart went from 1.7 s
back to 1.1 s. Latencies vary between runs (CB2): these are 0.7 to 1.1
times CB2's.
Two early runs (on code since changed, while other builds, fuzzers and
browser tests shared the machine) each lost one request of the flood: a
120 s timeout, and a 500 whose body was not the service's. The cause was
not found. Ten later full floods lost none: the whole script four times
(one with every core kept busy, one beside both fuzzers), the flood alone
twice, and floods while a second `wrangler dev` built another build and
while a changed source rebuilt the Worker under it. A 500 not from the
service is an error the front door let through; an error reading the body
or making the object's request now answers `server-error` like the object's
own failures (the client backs off on any 5xx), and the script prints
`wrangler dev`'s output when a request fails.

On the Workers Free plan (10 ms CPU a request) none of the forgets, the
restart or a contribution at the cap fits (D2).

### Evidence

| Claim | Test |
|---|---|
| Trust, quotas, forget | `cargo test` (`core/tests/trust.rs`, 16 tests): a forged fitness of 1e6 ranks and is served as 0 until two others corroborate it, then as the 50 its offspring showed (its contributor's praise changes nothing, one other's report keeps it at 0 and sinks it); a claim can only lower a brain before corroboration, and a context without a track key never corroborates; one contributor's 50 reports count once and an outlier among four moves the weight from 0.05 to -0.025 (the plain mean would be -0.2375); the 8 contributors kept are the most recent; a quota refuses a request whole (nothing written, `Retry-After` to midnight) and starts over at midnight, per token; the contributors table holds today only; forget deletes the token's brains and takes out exactly its slots (a token with the same tag takes out nothing), keeps stored contexts, and a store failing after each of its writes reopens consistently; eviction by trusted fitness (the flood goes first; trusting claims, the forged brains would win); 60 brains from 30 tokens leave the corroborated ones; reports of -1e6 bring a brain to 0, not below; junk contexts from two tokens cannot keep a brain's own context out; tracks of their own protect no uncorroborated brain; forget goes through 1 280 records (more than a page); what a forget reads (a fresh token nothing, its 3 records by key, a token made to share a heavy contributor's tag one query over the records, never one a record). `core/tests/brain.rs` (36) keeps CB2's tests, with the new rules: contexts several contributors built stay, a brain's own is always taken, a request never replaces its own new contexts, and a brain's value and the replacement order count contributors with a value |
| The Worker | `npm run test:cloud-brain:service` (14 tests, the built Worker under `wrangler dev`): every CB1 fixture over HTTP, the `forget` ones too; a forged fitness served as 0, then 50 after two others; forget over HTTP; 20 writes a minute from one address then 429 with `Retry-After: 60`, CORS and the header exposed, a body not even read, 3 forgets then 429, 60 reads then 429, `/health` counted as a read, 20 from one IPv6 /64 then 429 and another /64 free; the token nowhere in the object's SQLite files, its hash there; a daily quota (429 with `Retry-After` to midnight, per token; forget past it); the migration from schema 1, whole and cut short (schema 1 feedback gone, a new slot with its contributor id, the new columns); a database newer than the build refused |
| The browser | `npm run test:cloud-brain:browser` (Chromium and WebKit): as in CB3, and a pulled brain takes the served fitness at every pull until this tab measures it, and its first offspring outcome here only sets a baseline; measured here in one context (archived again), its outcomes there are measured against this tab's fitness (0.25), in the context it was pulled in still not, and a later pull refreshes that evaluation only; on the real service B's generation 0 is still 15 of 16 cars from A's brains, A's pool has B's feedback and no fitness above 0 |
| Fuzzing | `bash scripts/fuzz-cloud-brain.sh` (libFuzzer and AddressSanitizer, nightly-2026-09-29): on the final code, about 12 minutes each, `wire` 5 075 743 inputs and `brain` 59 706 request sequences (and 3 minutes each before that: 1 536 180 and 20 994); over the task, all clean: 10 minutes each before the review fixes (3 751 250 and 139 718), after the first round (3 522 918 and 64 757) and 5 after the second (2 645 780 and 35 802). A planted trust bug (one corroborator instead of two) was caught in its first seconds ("served 896 with 1 corroborators") |
| Reviews | Three adversarial reviews (core logic; Worker, SQL and tests; spec and abuse) found a forget that matched 16-bit tags (a stranger could erase others' feedback), a brain's own context that junk contexts could lock out, eviction weighed by rows, reports that could sink a brain to -1e6, tracks of one's own pinning brains, the browser using the served 0 as a baseline, IPv6 addresses each counted alone, `Retry-After` not exposed, and number or boolean `vars` ignored. A second round found the browser's baseline check missing an evaluation's mark after a re-archive, a forget that scanned every record for any token, baseline-only rows holding contexts, and two tests that a mutant passed; a third, that a token made to share a heavy contributor's tag chose what a forget reads, and three tests missing. All are fixed and tested above: 9 mutants of the new rules (each put back as it was: tag forget, no floor, rows or all contributors counted, no request exclusion, no tag prefilter, never one pass) each fail a test |

### Limits

- **Sybil.** Tokens are free: two more tokens corroborate a forged claim
  (then served at its claim), and a few can bring an honest brain back to
  a neutral fitness (and its weight lower), or push honest contributors out
  of a record's 8 slots. In another context than a brain's own, one junk
  row replaces a context where one contributor measured and the others only
  set baselines, and two tokens measuring 8 contexts keep new ones out for
  7 days (the brain's own is always kept). The
  per-address limits slow this, the quarantine stops a single token, and
  feedback never takes a brain below `min(claim, 0)`. Turnstile on the
  first contribution (D8) or server re-simulation (X1) is the fix if abuse
  appears.
- A brain is corroborated only in its own context: others must breed from
  it on the same track key and settings.
- Tracks are no one's: with 5 000 tracks each holding a brain, a new track
  is kept without one (CB2). Tokens can fill the table in about an hour
  from one address.
- A token past its quota retries about once a minute until midnight: the
  client backs off to 60 s and does not read `Retry-After` yet.
- The per-address key trusts `CF-Connecting-IP`, which Cloudflare sets;
  CB5 checks that a client cannot choose it on the deployed Worker.
  Cloudflare's limiter counts per location and is approximate.
- `fastestLap` in meta is served as claimed (it does not rank).
- The page has no "forget me" control yet; the route is there.

## X1: verified laps and a leaderboard

A claimed fitness is a claim; a lap the service drove itself is not. X1
ports the game's simulation to Rust, has the service drive a brain on the
page's track, serves the result as the brain's fitness in its own context
(past quarantine), and lists the fastest verified first laps per track.

### What it does

- **The simulator** (`cloud-brain/sim`, crate `vectorvroom-sim`; the
  plan's `vv-sim`) ports the deterministic core as the trial worker runs
  it: car.js (driving, sliding, traction, `#move`, the polygon and wall
  test, gates in order and laps), sensor.js (7 rays of 400 px) on
  spatialGrid.js's 200 px cells, network.js's 10-16-4 forward pass (f32
  weights, f64 sums, `tanh` hidden, `sum > bias` outputs),
  driver/profiles.js (the five profiles' pace, corners, braking and
  patience) and main.js's `computeStartInfoInPlace`. One car alone, sensors
  every frame, no start jitter: the browser reuses controls between sensor
  reads at high simulation speeds and may run cars together, so a
  verification measures the brain, not one browser run of it.
- **Math as V8 does it.** `Math.hypot` is V8's own algorithm (largest
  magnitude, then a compensated sum), `Math.tanh` fdlibm's (which V8 uses),
  both bit for bit; `sin`, `cos` and `atan2` are musl's (the `libm` crate),
  within 1 ulp of V8's (on 400 000 values the simulation meets, 2.5 % of
  `sin` results differ by 1 ulp). Every function gives the same bits
  natively and in Wasm.
- **`POST /v1/verify`** `{protocol, brainSchema, token, vector, track:
  {width, height, inner, outer, checkpoints}, context}` → `{protocol, id,
  track, matched, fitness, laps, lapFrames, crashedAt, frames}`. Checked in
  order: the body, token, the brain's vector, the track (the game's
  3200 × 1800 canvas: its sides are walls and the sensors' side inputs
  scale by its diagonal, so another size would be another track; loops of
  3 to 256 points, 1 to 64 gates, coordinates within ±100 000), the context
  (collisions off and at most 120 s, else `verify-context`). A brain the
  service does not hold: 400 `brain-unknown`, not counted. The service finds
  the start pose from the gates as main.js does (a `start` in the body is
  not read): a run depends on the brain, the track and the context only, so
  whoever asks gets the same run. It drives `floor(seconds × 60)` frames, or
  until the car crashes.
- **A budget of work.** The car counts the segments its grid queries
  return (`Car::work`). Past 600 a frame on average the run stops and the
  verification is refused, `track-geometry` (counted: it ran): the ten presets take at most
  37 a frame, a track built so every wall is in every ray's way takes 1 500
  to 4 200.
- **The track key** of the geometry is the page's own: graphics/state.js's
  `geometryKey` (FNV-1a and djb2 over `JSON.stringify([inner, outer,
  checkpoints])`, moved there from learning/session.js) is computed in Rust,
  numbers written as JavaScript writes them (the `ryu-js` crate: Rust's own
  formatting breaks exact ties between two shortest forms the other way).
  `matched` says whether it is the context's `track`; the run is kept under
  the key of the geometry sent, never under the context's word.
- **One geometry a key.** A key is two 32-bit hashes, not a digest: a
  second track can be built to share one (about 2^32 work). So the first
  geometry run under a key is the only one ever run under it: the SHA-256
  of the text the key hashes is kept (`geometries`), and another geometry
  with that key is refused, `track-geometry`, before it is counted. The ten
  presets' keys are pinned to their own geometries when the object opens.
- **Standing.** In a recall whose context is the brain's own (its key,
  profile, speed, traction and seconds, collisions off), a run there is its
  fitness: the claim and the quarantine no longer count. Its contributors'
  reports in that context are measured against the run, not the claim (a
  claim made low on purpose would make every offspring look better). In
  every other context, and for eviction and each track's protected best,
  CB4's rules hold: the brain's contributor chooses the track it ran on, and
  a track anyone can make up (one gate under a parked car counts a lap every
  frame, in the game too) protects nothing elsewhere. Runs in other
  contexts count only on the leaderboard. A brain keeps 4 runs (the oldest
  go first, never the one in its own context); they go with the brain;
  forget takes the token's id off the runs it asked for (`verified` and
  `geometries` tables, SQL schema 3).
- **`GET /v1/leaderboard?track=&maxSpeed=&traction=`** → `{protocol, track,
  maxSpeed, traction, entries}`: up to 20 `{id, lapFrames, laps, fitness,
  profile, verified}`, a brain once at its best run, of brains the service
  holds, the fastest first lap first (then fitness, then the oldest),
  whatever profile or run length. `maxSpeed` and `traction` are cleaned as a
  context's (15 and 0.5 when absent); a bad query is 400
  `leaderboard-query`.
- **Limits.** 6 verifications a minute per address (the `VERIFY_LIMIT`
  binding; the leaderboard counts as a read); each one counts a request and
  a brain on the token's daily quota; and at most 30 a minute for everyone
  (in the object's memory): the object answers one request at a time, and
  a verification takes up to ~0.1 s, so at most ~3 s of a minute.
- **The browser** (cloud/session.js, client.js, ui.js). A brain the bridge
  archives with a `fastestLap`, learned with collisions off in at most
  120 s on the page's current track (the key of the walls and gates it
  would send is its context's), waits for a verification with main.js's
  `road`; the 4 with the fastest laps wait. Once its brain has left the
  outbox, the flush timer verifies one every 10 s (within the 6 a minute);
  `brain-unknown` is tried 3 times (another tab may still be sending it), a
  busy or paused service makes the next wait a minute without holding
  contributions or recalls. The leaderboard for the current track and
  physics is read on start, when they change (the line is cleared first),
  every minute and after a verification; only the latest read is shown.
  The Memory panel shows it: "Fastest verified laps here: 1. 16.63 s
  (yours) · your last car verified: 16.63 s". What shared mode sends now
  says the track's walls and checkpoints go with a car that drove a lap
  (nothing was deployed, so no consent was given to the earlier text).

### Measured

| | |
|---|---|
| Fidelity, the fixture (125 cases: the five presets, 2 random and 3 evolved brains each, 7 settings of 20 and 40 s; 20 lap, from 4 brains on the Rectangle, Monza and Monaco: no brain the learning loop evolved in 80 generations laps the Oval or the Triangle) | 125 identical, from the browser's start pose and from the port's own: every frame's controls, the outcome (fitness, laps, lap frames, crash frame); states every 30 frames within 1e-9 relative, 3 837 of 4 352 bit for bit |
| Fidelity, the fixture's cases and 2 000 more random brains and settings on all ten presets (`--extra 2000`, `SIM_TRACES`) | 2 125 identical (21 lap), from the browser's start pose and from the port's own; 52 702 of 53 500 states bit for bit; no case parted at a near-threshold frame |
| The start pose | x and y exact on the five presets, the heading within 2 ulps; the port's own drives every case of both sets as the browser's |
| Track keys | `js_number` equals `JSON.stringify` on the fixture's 1 128 numbers and on 757 787 more (random bits, ties, powers of ten and their neighbours) |
| Native speed (release, Apple M3 Max) | 0.9 to 1.5 µs a frame: 6.5 to 10.9 ms for 120 s |
| A verification over HTTP (`wrangler dev`, Wasm) | 7 to 18 ms for 1 200 frames (the round trip, the run and the write) |
| Work a frame (segments examined) | at most 36 in the fixture, 37 in the extended set (all ten presets) |
| A track made to be costly (`sim/tests/cost.rs`: walls zigzagging across the canvas within the sensors' reach of a car that never moves, or as diagonals over every grid cell; 64 gates; 120 s) | without the budget 65 and 237 ms native (11.4 and 30.0 million segments); stopped by it after 25 and 34 ms native, 46 to 98 ms under `wrangler dev` |

On the Workers Free plan (10 ms CPU a request) a verification of a 20 s run
is at the limit and longer ones do not fit (D2).

### Evidence

| Claim | Test |
|---|---|
| The simulator drives as the game | `cargo test -p vectorvroom-sim` (`sim/tests/traces.rs`): the golden traces of `node scripts/cloud-brain-sim-traces.mjs` (the game's classic scripts in a Node vm, Math.random seeded, brains from the game's `LearningCoach`) as in the table, from either start pose; `sim/tests/cost.rs`: the costly tracks run without a crash (their timing probe is `--ignored`) |
| The service | `cargo test` (`core/tests/verify.rs`, 17 tests): the track key and `js_number` equal the page's; the ten presets pinned to their geometries (the keys and SHA-256 Node computed) when the brain opens; a player's track pinned by its first run, another geometry under a pinned key refused before it is counted, pins kept by a rebuild; every lapping case's verification equals the game's outcome and becomes the brain's served fitness in its own context, also after a rebuild; a run in another context or on another key decides nothing, after a rebuild too; a made-up one-gate track (1 200 in 20 s) counts only in its own context, served 0 on the real Rectangle, and is evicted before a corroborated brain; reports measured against the run (a claim of -1e6 no longer lifts the weight to 1); the leaderboard's order (first lap, fitness, age), a brain once, at most 20, physics, eviction; `brain-unknown` before any counting; 30 a minute for everyone, then `Retry-After` to the next minute, not counted; 4 runs a brain, always the own context's; forget; another token's run, with a start pose in the body, is the same run, and another canvas is refused; the costly tracks stopped and refused, their keys not pinned (nor one asked about past the minute's 30), a track at ~543 segments a frame run and one at ~663 stopped; runs that differ only in length are two runs; hostile bodies and queries refused with their reasons. `npm run test:cloud-brain` (wire 10, client 23): the fixtures for `verify`, `leaderboard` and their answers (66 valid, 147 invalid in all), the client's verify and leaderboard, the session's queue (each reason not to verify alone, the 4 fastest, after sending, retries, one at a time), the leaderboard's reads (a late answer, an old track's board, no track then the same track again, a read in flight at stop, none after), the page geometry and the panel's line |
| The Worker | `npm run test:cloud-brain:service` (17 tests): every fixture over HTTP; the migration to schema 3 (its tables, the presets pinned); a claim of 1e6 served as 0, then the verified run's fitness; the verification equal to the game's run; the leaderboard, and its order from rows written into SQLite and read after a restart (a brain once); `brain-unknown`; 6 verifications a minute from one address then 429; both costly tracks stopped and refused within 0.1 s |
| The browser | `npm run test:cloud-brain:browser`: on the real service, a brain the game evolved on the Rectangle (the page's default track: its key is the fixture's) is archived through the bridge with a lap, sent, verified with the same outcome as the game's (fitness 6, its lap at frame 998), served with that fitness in its context, and shown in the Memory panel ("Fastest verified laps here: 1. 16.63 s (yours) · your last car verified: 16.63 s"); another profile sees it without "(yours)" |
| Fuzzing | `bash scripts/fuzz-cloud-brain.sh 300`: `wire` now also takes every body through `parse_verify` (what it accepts holds the track's bounds and the game's canvas) and drives each accepted track for 2 s within its budget, and `parse_board`; `brain` adds verifications (on the traces' tracks with their evolved brains, a made-up one-gate track, degenerate and costly tracks) and leaderboards to its request sequences, and checks after every step that a verified fitness is served only in the brain's own context, every run's key is pinned (the presets' to theirs), at most 4 runs a brain, a board of held brains with a lap, each once, in order, and a rebuild's boards equal the live ones. On the final code, 5 minutes each: `wire` 2 004 011 inputs, `brain` 31 018 sequences, clean |
| Reviews | Three adversarial reviews (correctness, abuse, spec fit) found: a run on a made-up one-gate track served everywhere (fitness 7 200 for a parked car), anyone able to change a brain's standing by verifying it on another canvas size (not in the key), reports measured against a claim made low on purpose, a worst case 4 times the measured one (walls as diagonals over a 10 000 px canvas), `js_number` breaking ties unlike JavaScript (599 of 757 787 numbers), the sim test reading JavaScript's numbers a bit off (no `float_roundtrip`: 2 010 states bit for bit, not 2 753), a brain listed up to 4 times, a client test whose cases were refused for the wrong reason (4 surviving mutants), untested leaderboard order and rebuild paths (3 more), thin lap evidence (15 cases from 3 brains), and client races (a late board shown, an old track's board left up). All are fixed and tested above. A second round (trust and abuse; integration, parity and tests) found no way past the fixes (the canvas pin, the context binding, the pins and the budget held under its probes; 20 000 leaderboard queries and 6 000 verify bodies parsed the same in JavaScript and Rust; `js_number` equal on 414 720 more numbers) and 9 mutants that survived the tests (a track refused for its key, not its own check; a pin written before the run; runs differing only in length merged; a budget twice as loose; three session races; a 10-digit key length; an unchecked crash frame), and stale figures. All are tested above: each of those mutants now fails a test. |

### Limits

- A verification measures the brain on the page's walls and gates as the
  service runs it: alone, sensors every frame, from main.js's start pose.
  The browser's own runs differ at high simulation speeds (controls reused
  between sensor reads), with pose jitter on, or with car collisions; that
  is the browser's run, not the brain's.
- A track of a player's own is pinned by its first verification: someone
  who builds a second track with its key (about 2^32 work) and verifies on
  it first decides what runs under that key (the presets are pinned from
  the start).
- Anyone can verify any brain the service holds, in any context. In its
  own context that is the same run whoever asks; in four other contexts it
  pushes out the brain's other runs (and their leaderboard entries).
- 30 verifications a minute for everyone: five addresses at their limit
  use them up, and the rest wait a minute (training and recalls do not).
- One contributor can list up to 20 slightly changed copies of a brain
  that laps.
- With Adaptive Gates on, a generation that moved the gates is not
  verified (its walls and gates are not its context's track).
- The queue keeps the 4 brains with the fastest laps the browser saw; the
  leaderboard ranks the first lap the service drove.
- The client does not read `Retry-After` (as in CB4).
