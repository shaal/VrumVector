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
- Rate limits, quotas and trust (quarantine until corroborated) are CB4.
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
  (`POST /v1/forget` comes with CB4). When the object fails (a panic, a
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
- Pulled brains carry the fitness their contributor claimed, on the track
  they were found on; a brain from another circuit is kept without a track.
  A pool is at most the nearest tracks' brains, so it can be smaller than k.
- A brain the service later quarantines or evicts stays in a replica that
  already pulled it (the replica is capped at 2 000 pulled brains).
- Claimed fitness is trusted until CB4 (quarantine until corroborated).
  Feedback sent twice (a lost answer, then a retry) counts twice.
- The service is not deployed: CB5 writes the endpoint into
  `cloud/config.json` at deploy.
