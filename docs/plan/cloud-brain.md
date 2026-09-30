# Cloud brain: one shared vector memory on Cloudflare (plan)

**Status:** CB0 is done: the `cloud-brain/` skeleton (a Rust SQLite Durable
Object built for `wasm32-unknown-emscripten`) runs locally, and D1 is taken
(Emscripten); results in
[cloud-brain-spike.md](../validation/cloud-brain-spike.md). D3–D10 are taken as
recommended (2026-09-30, to start work; any of them can still change). D2 (the
Cloudflare plan) and the deploy itself wait for your OK before CB5.

**Request (2026-09-30):** "research and implement
https://blog.cloudflare.com/rust-workers-emscripten-target/ for this project.
I'd like an option for people to teach and learn from 1 brain that lives in
cloudflare, as an alternative to the default local brain in the browser. ...
I am also open for any other cool idea that can be done with this new feature
of cloudflare ... keep them as PRs."

**Goal:** an opt-in **Shared brain** mode. Instead of the default vector memory
that lives in this browser (IndexedDB `rv_car_learning`), the app reads from and
teaches one brain that lives in a Cloudflare Durable Object. Everyone who opts in
contributes the drivers they train and the results of the seeds they were given;
everyone gets seeds for their track from what everybody has learned. The service
is Rust (ruvector crates) built with the new `wasm32-unknown-emscripten` target
for Rust Workers. The local brain stays the default and is never uploaded or
overwritten.

**How to use:** each task in [Tasks](#tasks) is one `/ship-next` iteration: one
branch, one PR, one squash merge into `main`. CB0–CB4 build and test locally
with no Cloudflare account. Anything that deploys, creates Cloudflare resources,
or pushes ruvector patches upstream waits for an explicit OK (CB5, and the
upstream half of CB6). Record measurements in
`docs/validation/cloud-brain.md`, not in this checklist.

## What the Emscripten target gives us, and what it does not

Source: [Supporting native Rust in Workers with the new Emscripten target for
wasm-bindgen](https://blog.cloudflare.com/rust-workers-emscripten-target/)
(Guy Bedford, Mitch Foley, 2026-09-28), the
[wasm-bindgen Emscripten reference](https://wasm-bindgen.github.io/wasm-bindgen/reference/emscripten.html),
the [workers-rs examples](https://github.com/cloudflare/workers-rs/tree/main/examples/emscripten)
and `worker-build` source ([PR #1061](https://github.com/cloudflare/workers-rs/pull/1061),
released in workers-rs v0.8.7 on 2026-09-25).

What it enables, compared with `wasm32-unknown-unknown`:

- A libc and POSIX layer: `std::fs`, `std::time`, `std::env` work
  (in-memory FS by default; `-sNODERAWFS` forwards to `node:fs`, which
  [worker-fs-mount](https://github.com/danlapid/worker-fs-mount) can back with the
  Durable Object's SQLite storage).
- Crates with C/C++ sources build (emcc is the C compiler and linker).
- Tokio, including `net`, through the experimental `experimental_tokio` feature
  (patched tokio/mio/libc forks until upstream PRs land), and `-sNODERAWSOCKETS`
  for TCP/UDP through `node:net`.
- Existence proof: a Tokio-based Minecraft server running in one SQLite-backed
  Durable Object ([rust-workers-minecraft](https://github.com/danlapid/rust-workers-minecraft)).

What it costs:

- **Experimental.** "first public experimental preview ... still in pre-release";
  wasm-bindgen: "flags and output shape may still change". The official Rust
  Workers docs still describe only `wasm32-unknown-unknown`.
- Rust **beta** toolchain in the examples; emsdk 6.0.10 installed and patched by
  `worker-build` (needs python3); a newer workerd than ours is likely needed
  (the Minecraft demo pins wrangler 4.141.0; we pin 4.103.0 / miniflare
  4.20260617.1).
- Panics: the research read "panic=abort only, no re-init hook". CB0 found
  that a Rust panic *unwinds* on this target by default (Wasm exception
  handling): locally the request got a 500 and the same instance kept serving,
  in-memory state included, so a panic in the middle of an update leaves it
  half done. Not yet seen on Cloudflare.
- wasm-bindgen: `wasm32-unknown-unknown` "stays the right default: it has the
  smallest runtime and the fastest cold start". The post gives no size or
  cold-start numbers. CB0 measured ours locally: no clear difference in cold
  start, and the `wasm32-unknown-unknown` bundle was the larger one (430 020
  bytes of Wasm against 369 151).
- One Wasm instance per isolate: the Minecraft notes say one object hosts one
  server at a time. Fine for one global brain; relevant if we ever shard.
- `wasm-bindgen-test` bodies are compiled, not executed: unit tests run natively
  (`cargo test`), integration tests run against `wrangler dev`/Miniflare.

Where it actually matters for ruvector (pinned `5356a84e2`): `ruvector-core`'s
default features are all marked "not available in WASM" today — `simd`
(`simsimd`, a C library), `storage` (`redb` + `memmap2`), `hnsw` (`hnsw_rs`),
`parallel` (rayon). The browser gets by with `memory-only` plus our fork's HNSW
wrapper. Under Emscripten, `simsimd` and `redb` should build and `std::fs`
persistence can land in DO SQLite; `hnsw_rs` probably still fails (it pulls
`mmap-rs` → `nix`), and rayon must stay off (no threads). (CB0 measured it:
`redb` builds and runs, `simsimd` builds but ruvector-core never calls it on
wasm32, `hnsw_rs` fails; see the spike.) `ruvector-gnn`'s
default `mmap` feature and SONA's native (non-`wasm`) build become possible;
SONA needs a small `time_compat.rs` cfg fix (both of its cfgs), because it gates on
`target_arch = "wasm32"` and would read the clock as 0 on Emscripten.
CB0 turns these "should"s into a measured feature matrix.

Honest summary: a shared brain does not *require* Emscripten. It is the right
experiment for this project because it lets the service run ruvector's native
Rust crates (and later a Rust port of the simulator) with little
`wasm`-feature forking. The service code stays target-agnostic (no Tokio, no
Emscripten-only APIs in the MVP), so falling back to `wasm32-unknown-unknown`
is a small change, not a rewrite: that target needs a `cdylib` library instead
of a bin, and getrandom's JavaScript backend. CB2 keeps it small by putting the
service logic in a library crate with no `worker` dependency.

## What "the brain" is today

`AI-Car-Racer/ruvectorBridge.js` over IndexedDB `rv_car_learning` (v4):

| Store | Vector | Meaning |
|---|---|---|
| `brains_10_16_4` | 244 floats (`brainCodec.js`, topology 10-16-4) | GA drivers + meta: fitness, fastestLap, generation, parentIds, learningContext, styleScore, driving stats |
| `tracks` | 512 floats (CNN embedding) | the circuit, deduplicated at cosine distance ≤ 0.005 |
| `dynamics` | 64 floats | how a brain drove |
| `crash_maps` | 144 floats (16×9) | where cars died (adaptive-gates curriculum) |
| `observations` | — | EMA feedback per brain × learning context |
| `lora_track` | — | SONA/MicroLoRA adapter and journal |

Plus the trainable GNN reranker weights and the lineage DAG. Brain IDs are
content hashes (`brain_<xxHash32><xxHash32'>`, `archive/identity.js`).

Call sites that matter: `main.js buildBrainsBuffer()` calls
`recommendSeeds(trackVec, 10)` **synchronously** at every generation start;
`archiveBrain(...)` and `observeOffspring(...)` run at generation end. The F6
cross-tab feature already has the shape we need: after an insert,
`archiveBrain` broadcasts a single-brain delta (`crosstab/wire.js`), and
received deltas go back through `archiveBrain` via `_onRemoteBrain`, where
content-hash dedup collapses echoes.

## Recommended design

### What is shared

v1: brains (244 floats + meta), their track embeddings (512), dynamics vectors
(64), and offspring feedback (brain id, learning context, mean fitness, count).
v2 (CB6): SONA trajectories through ruvector's own federated API
(`EphemeralAgent::export_state` → `FederatedCoordinator::aggregate`); the browser
already runs `WasmEphemeralAgent`. Later (X4): crash maps. Not shared: raw
human demonstrations (behavioural data, large); a "Use my driving" clone is an
ordinary brain and is shared tagged `source: 'demonstration'`.

### Where it runs

A new Worker `vectorvroom-brain` (the multiplayer Worker stays untouched) in
`cloud-brain/`: a Rust bin crate, `#[event(fetch)]` front door plus one
SQLite-backed `#[durable_object] SharedBrain` named `vectorvroom-shared-brain-v1`
— literally one brain. One object is single-threaded, so writes are serialized
without locks, and its ~1,000 req/s soft limit is far above this game's traffic.

Inside the object: SQLite tables (`brains`, `tracks`, `dynamics`, `feedback`,
`contributors`, `meta`) are the source of truth; in-memory indexes (ruvector-core
`memory-only`, a flat index: `hnsw_rs` does not build for Emscripten, and the
hyperbolic HNSW is too slow to build at this size, CB0) are rebuilt under
`blockConcurrencyWhile` on first request after a cold start. Caps: 20,000
brains and 5,000 tracks to start, with eviction by (feedback-adjusted fitness, age) that always keeps
each track's top brains. Memory is the constraint (128 MB per isolate, and
Wasm memory never shrinks): in CB0 the object's Wasm memory peaked at 48.6 MiB
with a `VectorDB` of 20 000 brains (the raw floats are 18.6 MiB; the peak also
holds Emscripten's 16 MiB starting memory and growth slack). Adding tracks
(5 000 × 512, 9.8 MiB raw) and dynamics (20 000 × 64, 4.9 MiB raw) comes to
roughly 65 MiB before slack and the JavaScript heap (an estimate). CB2 measures the real total and may lower the caps or keep
dynamics out of memory.
ruvector sources come from upstream `5356a84e2` plus
`scripts/ruvector-patches/`, fetched by a script into `.work/` like
`build-learning-wasm.sh` does.

### API (v1)

Browser → Worker → object. Bodies are JSON with vectors as base64 little-endian
Float32 (a brain is 1.3 KB instead of ~2.5 KB of decimal text).

The exact format, the order of every check and every refusal are in
[CB1](../validation/cloud-brain.md#cb1-the-wire-format) (`AI-Car-Racer/cloud/wire.js`
and the fixtures in `tests/fixtures/cloud-brain/`). Every body carries
`protocol: 1`; contributions, recalls and recall answers also `brainSchema: 6`.

- `GET /health` → `{ok, protocol:1, brain:true|false, build:{target, ruvector, spike}}`
- `POST /v1/recall` `{track, dynamics?, context, k?}` (k 1 to 64, 50 by
  default) → a ranked candidate pool: `{protocol, brainSchema, pool:[{id,
  vector, fitness, score, meta, feedback:{weight,count,contributors}}]}` (up to
  256 KiB)
- `POST /v1/contribute` `{token, tracks:[≤4], brains:[≤16], feedback:[≤50]}`
  → `{protocol, accepted:[id], rejected:[{index, reason}], feedbackAccepted,
  feedbackRejected:[{index, reason}]}` (a `quota` field comes with CB4);
  idempotent. Brain ids are 128 bits of SHA-256 of the weights' bytes,
  recomputed by the service (CB1: xxHash32 ids can be forged). A brain points
  at its track by index in `tracks` (CB1: a track in every brain did not fit
  16 brains in 64 KB).
- `GET /v1/stats` → `{protocol, brains, tracks, contributorsToday, contributions24h}`
- `POST /v1/forget` `{protocol, token}` → forget my contributions (a `POST`
  keeps it a CORS simple request)
- Errors: `{protocol, error}` with 413, 429, 503, 500 or 400 (CB1)
- CB6: `POST /v1/sona` `{token, export}`; X1: `GET /v1/leaderboard?track=`

Transport: HTTP with `Content-Type: text/plain` bodies (a CORS "simple request",
so no preflight doubles the request count) and `Access-Control-Allow-Origin` for
the same origins multiplayer allows. A hibernating WebSocket per training
session is the upgrade path if request counts bite: incoming WebSocket messages
are billed 20:1 and it enables live "someone beat your track" pushes.

### How the browser switches

A **Memory: This browser · Shared (cloud, beta)** control in the Vector Memory
panel, plus `?brain=shared` for tests; the choice is saved. Switching reloads the
page. In shared mode the bridge opens a separate IndexedDB,
`rv_car_learning_shared`, which holds a bounded **replica** of the cloud pool, so
`recommendSeeds` stays synchronous and local ranking code (context matching,
diversity, GNN) keeps working unchanged. `AI-Car-Racer/cloud/client.js`:

- **Pull:** on ready, when the track vector changes, and every few generations,
  `recall` fetches the pool for this track; entries enter the replica through the
  `_onRemoteBrain` path; server feedback weights replace local observation
  weights for those IDs.
- **Push:** in shared mode `archiveBrain` enqueues the same delta it would
  broadcast cross-tab; `observeOffspring` enqueues feedback; an outbox flushes at
  most every 10 s (coalesced, bounded, persisted so a reload does not lose it).
- **Offline:** failures back off (1 s → 60 s) and the panel shows
  "Shared brain offline — training from the last copy". Training never blocks on
  the network; a bare checkout with `endpoint: null` hides the option.

### Ranking

The server returns a ranked pool (default k = 50): track-neighbourhood join,
claimed fitness, aggregated offspring feedback, context match. The browser picks
its 10 seeds from the pool with the existing `_rankSeeds` logic. This avoids
porting ~230 lines of product logic to Rust in v1 while keeping the heavy
retrieval (HNSW over everyone's archive) on the server.

### Concurrency and consistency

The object serializes all writes; each request's SQLite writes commit together.
Duplicate contributions are no-ops (content IDs). Clients see eventual
consistency: the replica is at most one pull behind. Server state is versioned
(`meta.sql_schema`; `brainSchema: 6`, the `BRAIN_SCHEMA_VERSION`, in every
contribution and recall): a client on another brain schema is refused, not
merged.

### Abuse and validation

Everything is hostile until checked, on the server (and mirrored on the client
for fast feedback):

- Exact lengths (244 / 512 / 64), every float finite, |w| ≤ 16 ("Use my
  driving" clones reach 6.76, CB1), track and dynamics vectors L2-normalised
  within 1e-3, canonical base64, strict JSON types.
- Bounded meta: known keys only, typed, numbers clamped (the app's
  `cleanContext` and `cleanLearning`, `learning/policy.js`), `context.track`
  printable ASCII of at most 180 characters, the collision label at most 40,
  parentIds ≤ 8.
- Body ≤ 64 KB, ≤ 4 tracks, ≤ 16 brains and ≤ 50 feedback rows per request;
  fitness within ±1e6; per-token and
  per-IP rate limits (Rate Limiting binding; a token bucket in the object as a
  fallback) and daily quotas.
- **Claims are not trusted.** A brain's claimed fitness only ranks it for
  others after corroboration: offspring feedback from at least two other
  contributors, aggregated robustly (per-contributor cap, trimmed mean, 2σ outlier
  filter as in ruvector's `mcp-brain-server/aggregate.rs`). The GA loop is
  self-correcting: seeds that others breed from and do badly with sink. X1
  (server re-simulation) is the strong version.
- No panics on input: parse with fallible code, fuzz the validators natively.
- Circuit breaker `DISABLE_BRAIN=true` (same pattern as `DISABLE_MULTIPLAYER`).

### Privacy

Shared: network weights, fitness/laps, the track's CNN embedding (not its
geometry), driving summaries, learning context. An anonymous random token
(128-bit, localStorage) identifies a contributor for quotas and "forget me"; the
server stores only its SHA-256. IPs are used transiently for rate limiting and
not stored. The toggle says what is sent before the first upload.

### Cost and limits

Per training session: ~6 pushes + a few pulls per minute ≈ 400 requests per
training hour. Free plan: 100,000 requests/day, 100,000 DO rows written/day,
shared with multiplayer; CPU is 10 ms per invocation on Workers Free (unclear
for DO requests), which a cold start (instantiate + rebuild 20k-vector index)
will likely exceed. Workers Paid ($5/month minimum) gives 30 s CPU per request,
10M requests and 30M CPU-ms per month. Storage is negligible (20k brains ≈
40 MB).

### Local development and CI (no account needed)

- `cd cloud-brain && npm run dev` → `wrangler dev --port 8879` with
  `cloud-brain/`'s own wrangler (D10; first build takes minutes: emsdk +
  ruvector). CB2 adds `ALLOW_LOCAL`.
- `cargo test` natively for validation, ranking, aggregation, eviction (shared
  JSON fixtures with the browser tests).
- `tests/cloud-brain.test.mjs`: the built Worker under Miniflare/wrangler dev
  with a SQLite DO: contribute, recall, restart persistence, hostile fixtures,
  rate limits.
- Browser: Playwright against a small JS fake built from the same fixtures (fast
  CI, no Rust), plus one job against the real local service.
- CI workflow `cloud-brain.yml` on `cloud-brain/**` changes: pinned beta Rust,
  `worker-build` 0.8.7, cached `~/.cache/worker-build` (emsdk) and `target/`.

## How to prove it works

- **Isolation:** after a shared-mode session, the local IndexedDB is
  byte-identical to before.
- **Sharing:** two browser profiles on the local service. A trains on Rectangle in
  shared mode; B (fresh) gets A's brains among its first-generation seeds
  (`seedSources.archive > 0`), and B's offspring feedback changes A's pool
  weights.
- **Value:** fresh browser in shared mode vs fresh local, time to first full lap,
  on Rectangle and Triangle, n ≥ 6 per arm over at least 2 sessions (cross-track
  variance is high; Triangle punishes shapes that help Rectangle).
- **Abuse:** hostile fixtures rejected with reasons; a brain with a forged
  fitness at the bound (1e6) is never served to others before corroboration and sinks after
  honest feedback; no input makes the object panic.
- **Cost:** measured requests and rows written per training hour.

## Decisions

- **D1 — Service build target.** **Taken (2026-09-30, by CB0):** Rust on
  `wasm32-unknown-emscripten`, the target this work was asked to use. It met
  the bar: it built, ran a SQLite object locally and persisted it, the local
  cold start was far under 1 s, and ruvector-core's index of 20 000 brains fit
  in the object's memory ([spike](../validation/cloud-brain-spike.md)). It is
  not better than `wasm32-unknown-unknown`: the cold start was a tie, speed at
  moderate load went to that target or was level (under a saturated host,
  either way), and the panic difference is each target's default. Its costs: an experimental preview, a pinned 1.99
  beta (the next beta already breaks the build), minutes and about 1.7 GB to
  provision Emscripten on a clean machine or CI, and a SONA clock patch. Was
  recommended: Rust on
  `wasm32-unknown-emscripten` via `worker-build --emscripten`, if CB0 passes
  (builds, runs a SQLite DO under `wrangler dev`, cold start under 1 s of
  instantiate, index fits in memory). Alternatives: Rust on
  `wasm32-unknown-unknown` (stable, no Emscripten; same code; CB0 found no
  cold-start advantage, and its bundle was the larger);
  or a JS Durable Object loading the already-vendored browser wasm (fastest to
  ship, no Rust in CI, no Emscripten).
- **D2 — Cloudflare plan.** **Open (your call, before CB5). Recommended:** Workers Paid before this is public;
  Free is acceptable for local work and PR previews behind the breaker.
- **D3 — What is shared.** **Taken (2026-09-30, as recommended):** brains, tracks, dynamics, feedback
  in v1; SONA in CB6; demonstrations only as cloned brains, never raw.
- **D4 — Topology.** **Taken (2026-09-30, as recommended):** one global object ("one brain").
  Alternative: one object per track cluster (scales further, splits the brain,
  breaks cross-track transfer).
- **D5 — Switching.** **Taken (2026-09-30, as recommended):** reload into a separate IndexedDB replica.
  Alternative: hot-swap all module state in place (bridge, SONA, GNN, DAG) —
  error-prone.
- **D6 — Where ranking happens.** **Taken (2026-09-30, as recommended):** server ranks a pool, the
  browser picks seeds with existing code. Alternatives: port all of `_rankSeeds`
  to Rust; or the server stores only and the browser ranks everything.
- **D7 — Trust.** **Taken (2026-09-30, as recommended):** claims quarantined until corroborated by
  other contributors' feedback. Alternatives: trust claims (easy to poison), or
  require X1 verification before anything is shared.
- **D8 — Identity.** **Taken (2026-09-30, as recommended):** anonymous contributor token, optional
  callsign credit. Alternative: add Turnstile on first contribution if abuse
  appears.
- **D9 — Persistence.** **Taken (2026-09-30, as recommended):** explicit SQL tables (predictable rows
  written and read). Alternative (CB8): ruvector-core's own `redb` storage on
  `std::fs`, mounted onto DO SQLite with worker-fs-mount, as the Minecraft demo
  does.
- **D10 — Tooling pins.** **Taken (2026-09-30, as recommended):** `cloud-brain/` gets its own
  `package.json` with the wrangler/workerd the Emscripten build needs, so the
  multiplayer pins (wrangler 4.103.0, miniflare 4.20260617.1) do not move; a
  dated Rust beta in `rust-toolchain.toml`.

## Tasks

- [x] **CB0 — Toolchain spike (local, throwaway code).** `cloud-brain/`
  skeleton: bin crate, dated beta `rust-toolchain.toml`, `wrangler.jsonc`
  (`new_module_registry`, SQLite class `SharedBrain`), `worker-build --emscripten
  --release`. Under `wrangler dev`, prove: a `#[durable_object]` SQL round-trip
  and restart persistence; `ruvector-core` with `memory-only`, then `storage`,
  `simd`, `hnsw` one at a time; `ruvector-hyperbolic-hnsw` without rayon;
  `sona` without the `wasm` feature (clock check). Measure Wasm size,
  instantiate time, index rebuild time and memory at 20k brains, and what a
  deliberate panic does to later requests. Also build the same crate for
  `wasm32-unknown-unknown` for comparison. Write the feature matrix to
  `docs/validation/cloud-brain-spike.md`; decide D1. About 4–6 hours. No deploy.
  - [x] Skeleton: `cloud-brain/` (bin crate, `worker = "=0.8.7"`,
    `build.sh`, own wrangler 4.144.0), `SharedBrain` SQLite object,
    `GET /health`; `spike` feature routes.
  - [x] Toolchain pin: `beta-2026-09-27` (1.99 beta). The 1.100 beta's new
    Cargo build layout breaks worker-build 0.8.7's snippet copy.
  - [x] Measured (`npm run test:cloud-brain:spike`): SQL round trip and
    restart persistence; local cold start a tie (median 50 against 51 ms
    for the `wasm32-unknown-unknown` copy); compute speed at moderate load
    level or in the other build's favour (either way under a saturated host); a panic unwinds (500, the instance lives on) where the other target
    aborts (no answer, a new instance).
  - [x] Spike routes answer only with `CLOUD_BRAIN_SPIKE=1` (and `build.sh`
    refuses the feature in CI); the Pages deploys leave `cloud-brain/` out.
  - [x] ruvector matrix (`scripts/cloud-brain-spike-matrix.sh`; in the object:
    `scripts/cloud-brain-spike-ruvector.sh`):
    `memory-only` (also inside the object: 20 000 brains, a 48.6 MiB peak),
    `storage`, hyperbolic HNSW and SONA build and run;
    `simd` is unused on wasm32; `hnsw` (hnsw_rs → nix) fails; SONA's clock
    reads 0 on Emscripten (CB6 patch).
- [x] **CB1 — Wire format, validation and shared fixtures (browser side).**
  `AI-Car-Racer/cloud/wire.js`: base64 Float32 encode/decode, limits, meta
  cleaning (reusing `learning/policy.js`), content IDs (as planned: those of
  `archive/identity.js`; CB1 moved to SHA-256). `tests/fixtures/cloud-brain/{valid,invalid}/*.json` for
  both sides. Measure the largest weights real clones produce (sets the |w|
  bound). `tests/cloud-brain-wire.test.mjs`. About 3 hours.
  depends: — (parallel with CB0)
  - [x] `AI-Car-Racer/cloud/wire.js`: protocol 1, canonical base64
    little-endian Float32, strict JSON types (an integer is any integral
    number; null is absent), a fixed order of checks, SHA-256 content ids
    (xxHash32 ids can be forged), request builders, parsers that never throw
    (stable reason codes), and the four answers (recall, contribute, stats,
    error) with their HTTP statuses. Tracks are listed once per contribution
    (≤ 4) and brains point at them.
  - [x] 154 fixture bodies (10 of them raw bytes) plus the `contexts.json`
    (49) and `meta.json` (39) cleaning tables
    (`node scripts/cloud-brain-fixtures.mjs`); every reason code and every
    pair of adjacent checks covered; of 266 single mutations over five
    review rounds, all but 13 fail a test (11 behave the same as the code on
    any JSON input, one differs only in some browsers, one is
    single-precision summation near the tolerance); `npm run test:cloud-brain`. The service
    must refuse a `Content-Length` over 64 KB and cap the read, decode strict
    UTF-8 (`std::str::from_utf8`), parse with serde_json's `float_roundtrip`
    (checked on the fixtures and 14 000 hard numbers by the fourth review),
    turn -0 into 0 after `f64::clamp` (which keeps it), and never compute
    `tracks.len() - 1` (an index into no tracks underflows).
  - [x] Weight bound 16: "Use my driving" clones reach 6.76 at most (14
    clones), evolved brains 1.00; clones without decay (10 to 97) are
    refused. `cleanLearning` moved to `learning/policy.js` for both wires.
- [ ] **CB2 — SharedBrain service MVP.** Index: ruvector-core
  `memory-only` (flat; about 8 to 12 ms a search at 20 000 brains in CB0's Node
  probe), not
  `hnsw` (does not build). Keep the 20 000-brain cap: in the object,
  the object's Wasm memory peaked at 48.6 MiB with 20 000 brains and 101 MiB
  with 50 000, of 128 MB. `health`, `recall`, `contribute`,
  `stats`; SQLite schema v1 and migration table; index rebuild under
  `blockConcurrencyWhile`; ranking v1; caps and eviction; origin allowlist with
  `ALLOW_LOCAL`; `DISABLE_BRAIN`; `scripts/build-cloud-brain.sh` (fetch
  `5356a84e2`, apply patches into `.work/`); `cd cloud-brain && npm run dev`;
  `cargo test` on the CB1 fixtures; `tests/cloud-brain.test.mjs` against the
  built Worker. From CB0's review: put the service logic in a library crate
  without `worker` (native `cargo test` and fuzzing on stable, and a cheap
  `wasm32-unknown-unknown` fallback, checked in CI); the front door handles
  `DISABLE_BRAIN`, CORS preflight, 404s and body limits before the object;
  keep the index out of module scope (`main()` stays empty); decide whether
  the `spike` routes stay as regression checks. About 8 hours.
  depends: CB0, CB1
- [ ] **CB3 — Browser client and the Shared brain switch.**
  `AI-Car-Racer/cloud/client.js` and `cloud/config.json` (`endpoint: null` by
  default); bridge namespace switch (`rv_car_learning_shared`), push hook next to
  the cross-tab broadcast, pulls through `_onRemoteBrain`, feedback merge;
  persisted outbox; backoff; panel control with disclosure and status; offline
  banner; `?brain=shared`. Tests: unit (fake fetch), Playwright against the
  fixture fake, isolation check on the local IndexedDB, one run against the real
  local service (two profiles share seeds). About 8 hours.
  From CB1: contributions carry cloud ids (SHA-256 of the weights), so the
  client maps local brains and their parents to cloud ids; `archiveBrain`
  needs a `source` (`demonstration` for a "Use my driving" clone) to send;
  batches are split by bytes (the counts do not bound a request's size); the
  Shared brain option needs a secure context (`crypto.subtle`); answers are
  read as bytes (`await res.arrayBuffer()`) and given to the `wire.js`
  parsers as they are, never through `res.text()` or `res.json()`.
  depends: CB1 (fake); CB2 (integration run)
- [ ] **CB4 — Abuse and trust.** Contributor token and hashed storage, rate
  limits and quotas, robust feedback aggregation with per-contributor caps and a
  2σ filter, quarantine until corroboration, forged-fitness and flood tests,
  native fuzzing of validators, `POST /v1/forget` (the CB1 `forget` fixtures
  apply from then; CB2 skips them). About 6 hours.
  depends: CB2
- [ ] **CB5 — Deploy (needs your OK).** `deploy.yml` step like the multiplayer
  one (`vectorvroom-brain`, PR previews `vectorvroom-brain-pr-<n>`) with cached
  toolchain; writes the endpoint into `AI-Car-Racer/cloud/config.json`;
  `cloud-brain.yml` CI; `docs/operations/cloud-brain-operations.md` (usage,
  breaker, limits); first production health check. Needs a token with Workers
  Scripts: Edit and the D2 plan decision. About 4 hours plus the deploy.
  depends: CB3, CB4
- [ ] **CB6 — Shared SONA.** Browser posts `WasmEphemeralAgent.exportState()`
  trajectories (bounded, validated); the object runs
  `FederatedCoordinator::aggregate` with a quality threshold and outlier filter;
  `recall` returns `get_initial_patterns(k)` to warm-start new sessions. Add
  `scripts/ruvector-patches/sona-emscripten-time.patch` (the `time_compat.rs`
  cfgs; CB0 saw the clock read 0); an upstream PR only with your OK. Inside
  workerd, time stands still during synchronous work even after the patch:
  durations advance only across requests and I/O (not measured in CB0). A/B: warm-started vs cold SONA,
  Rectangle and Triangle, n ≥ 6 over 2 sessions. About 6 hours.
  depends: CB2 (CB5 for production)
- [ ] **CB7 — Optional: ruvector-core native persistence.** If CB0 shows
  `storage` works: `-sNODERAWFS` + `worker-fs-mount` + `durable-object-fs` at
  `/data`, and let ruvector-core's `redb` persist the archive. Compare rows
  written/read and cold start with CB2's SQL tables; keep the cheaper one (D9).
  About 6 hours.
  depends: CB0, CB2

## Later: other ideas (optional)

- [ ] **X1 — Verified laps and a global leaderboard.** A Rust crate `vv-sim`
  ports the deterministic core (car physics, rays, the 10-16-4 forward pass),
  checked against golden traces from `sim-worker.js` (tolerance, not bit
  equality: JS runs in f64, and `Math.sin` differs across engines). The object
  re-simulates a submitted brain on the submitted track geometry and records a
  verified lap time; `GET /v1/leaderboard?track=`; verified brains skip
  quarantine. Value: high (trust, anti-poisoning, competition). Effort: 12–16
  hours. Risk: simulator drift between JS and Rust; CPU per verification
  (one lap is a few million operations: fine on Paid, tight on Free).
  depends: CB4
- [ ] **X2 — The brain trains while nobody is playing.** A DO alarm runs a few
  GA generations with `vv-sim` on the most-played tracks under a CPU budget and
  archives the results as `source: 'cloud'`. Value: high "wow"; visitors find a
  brain that improved overnight. Effort: ~6 hours after X1. Risk: CPU cost
  (bounded by the budget; 30M CPU-ms/month are included on Paid) and inheriting
  any `vv-sim` fidelity gap.
  depends: X1
- [ ] **X3 — Race the cloud champion.** The best brain for your track drives a
  ghost car next to yours, simulated locally from its weights (no trajectory
  storage). Value: medium-high, immediate and visible. Effort: ~3 hours. Risk:
  low. Needs no Rust.
  depends: CB3
- [ ] **X4 — Everyone's crash map.** Aggregate 144-float crash maps per track
  neighbourhood; overlay "where everyone crashes here"; adaptive gates recall
  shared layouts. Value: medium (curriculum from many players). Effort: ~4
  hours. Risk: low; contact deaths stay filtered (car-collisions C4).
  depends: CB2

## Risks

- The toolchain is a public preview (workers-rs 0.8.7, 2026-09-25): flags and output shape may
  change, beta Rust, patched emsdk. Mitigation: pin everything, keep code
  target-agnostic, CB0 exit criteria, D1 fallback.
- A Rust panic unwinds (CB0), so the instance survives with whatever
  in-memory state the panic left. Mitigation: panic-free validators, fuzzing,
  and updates that change the in-memory index only after SQLite has committed.
- Cold start: instantiate plus index rebuild may exceed Free's 10 ms CPU.
  Mitigation: Paid plan, or persist a compact index snapshot.
- `hnsw_rs` does not build for Emscripten (`mmap-rs` → `nix`, CB0).
  Mitigation: ruvector's flat index (about 8 to 12 ms a search at 20k vectors
  in CB0's Node probe);
  the hyperbolic HNSW builds but took 0.5 to 0.7 s for 2 000 small vectors.
- Memory: 128 MB per isolate; with 20k brains the object's Wasm memory peaked
  at 48.6 MiB.
  Mitigation: caps sized from CB2's measured total.
- Poisoning through forged claims. Mitigation: D7 quarantine, robust
  aggregation, later X1.
- Quota sharing with multiplayer on the same account. Mitigation: batching,
  breaker, runbook alerts.
