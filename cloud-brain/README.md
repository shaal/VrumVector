# Cloud brain Worker

One shared vector memory for VectorVroom, as a Rust Worker with a SQLite
Durable Object ([plan](../docs/plan/cloud-brain.md), [results](../docs/validation/cloud-brain.md),
[spike](../docs/validation/cloud-brain-spike.md)). It is built for
`wasm32-unknown-emscripten` with `worker-build --emscripten`, an experimental
preview. `.github/workflows/deploy.yml` deploys it as `vectorvroom-brain`
(Workers Paid); the runbook is
[docs/operations/cloud-brain-operations.md](../docs/operations/cloud-brain-operations.md).

- `core/`: the service without the Workers runtime (the wire format of
  `AI-Car-Racer/cloud/wire.js` in Rust, the brain, ranking, feedback, caps and
  eviction, trust, quotas and forget), tested natively; `core/fuzz/` its
  fuzz targets (cargo-fuzz, nightly).
- `src/main.rs`: the front door (breaker, origins and CORS, the per-address
  rate limits, the 64 KB body limit, routes) and the `SharedBrain` object
  with its SQLite store.
- `.work/ruvector`: ruvector-core (upstream `5356a84e2`, memory-only, a flat
  index), fetched by `scripts/build-cloud-brain.sh` (ignored by git).

## Setup (once)

```sh
rustup toolchain install beta-2026-09-27 --profile minimal \
  --target wasm32-unknown-emscripten --target wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
cd cloud-brain && npm ci
```

For fuzzing (CB4) only, a nightly and cargo-fuzz:

```sh
rustup toolchain install nightly-2026-09-29 --profile minimal
cargo install cargo-fuzz --locked
```

`rust-toolchain.toml` pins the beta: a newer beta (1.100) changes Cargo's build
folder layout, and worker-build 0.8.7 then cannot find wasm-bindgen's JS
snippets. The first build provisions Emscripten 6.0.10 into worker-build's
cache (a few minutes).

## Run

```sh
cd cloud-brain
npm run dev          # wrangler dev on localhost:8879, localhost origins allowed
```

Run wrangler from `cloud-brain/` (or `wrangler --cwd cloud-brain ...`): its
build command runs `build.sh` in wrangler's working folder, which fetches the
ruvector sources the first time.

Routes: `GET /health`, `POST /v1/recall`, `POST /v1/contribute`,
`GET /v1/stats`, `POST /v1/forget`, `POST /v1/verify`,
`GET /v1/leaderboard`, `POST /v1/crashes`, `POST /v1/crashes/recall`
(bodies and answers: [CB1](../docs/validation/cloud-brain.md#cb1-the-wire-format),
[CB4](../docs/validation/cloud-brain.md#cb4-abuse-and-trust),
[X1](../docs/validation/cloud-brain.md#x1-verified-laps-and-a-leaderboard),
[X4](../docs/validation/cloud-brain.md#x4-everyones-crash-map)).
`sim/` is the game's simulation in Rust (crate `vectorvroom-sim`), which a
verification drives; `node scripts/cloud-brain-sim-traces.mjs` remakes its
golden traces from the game's own scripts (and the presets' keys the
service pins, `--presets`).
Variables: `DISABLE_BRAIN=true` answers every `/v1/` route with 503
`disabled`; `ALLOW_LOCAL=true` allows `http://localhost:<port>` and
`http://127.0.0.1:<port>` origins besides the deployed ones;
`QUOTA_REQUESTS`, `QUOTA_BRAINS`, `QUOTA_FEEDBACK` set a contributor's
daily quota (10 000, 5 000 and 50 000 by default; a string, a number or
a boolean in `vars` all read); `MAX_TRACKS` keeps fewer tracks than the
5 000 the object is sized for (never more). The per-address limits are the `ratelimits`
bindings in `wrangler.jsonc` (24 contributions and crash maps, 60 recalls,
crash recalls, stats, leaderboards and health checks, 3 forgets and 6
verifications a minute;
IPv6 by /64); `/health` says `limits: true` when all are bound. The
object runs at most 30 verifications a minute in all.
Cloud training (X2) is off unless `TRAIN_FRAMES` is set (frames a session,
e.g. 120 000: about 0.1 s); `TRAIN_EVERY_SECONDS` (1 800) and
`TRAIN_IDLE_MINUTES` (10) set when sessions run; `/health` says `training`.

## Test

```sh
bash scripts/build-cloud-brain.sh --test   # native: cargo test (the CB1 fixtures too)
npm run test:cloud-brain:service           # the built Worker under wrangler dev
node scripts/cloud-brain-load.mjs          # 20 000 brains: memory, latency, restart
bash scripts/fuzz-cloud-brain.sh 600       # 10 minutes each of the wire and brain fuzz targets
cargo test --release -p vectorvroom-sim -- --ignored --nocapture   # how long a verification takes
```

`CLOUD_BRAIN_FEATURES=spike npm run dev -- --var CLOUD_BRAIN_SPIKE:1` adds
the CB0 measurement routes (both are needed: the feature builds them, the
variable turns them on; `build.sh` refuses the feature under `CI` unless
`CLOUD_BRAIN_ALLOW_SPIKE=1`). From the repo root,
`npm run test:cloud-brain:spike` runs them on port 8880; the load script
reads the object's memory through them.
