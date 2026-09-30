# Cloud brain Worker

One shared vector memory for VectorVroom, as a Rust Worker with a SQLite
Durable Object ([plan](../docs/plan/cloud-brain.md), [results](../docs/validation/cloud-brain.md),
[spike](../docs/validation/cloud-brain-spike.md)). It is built for
`wasm32-unknown-emscripten` with `worker-build --emscripten`, an experimental
preview. Nothing here is deployed yet.

- `core/`: the service without the Workers runtime (the wire format of
  `AI-Car-Racer/cloud/wire.js` in Rust, the brain, ranking, feedback, caps and
  eviction), tested natively.
- `src/main.rs`: the front door (breaker, origins and CORS, the 64 KB body
  limit, routes) and the `SharedBrain` object with its SQLite store.
- `.work/ruvector`: ruvector-core (upstream `5356a84e2`, memory-only, a flat
  index), fetched by `scripts/build-cloud-brain.sh` (ignored by git).

## Setup (once)

```sh
rustup toolchain install beta-2026-09-27 --profile minimal \
  --target wasm32-unknown-emscripten --target wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
cd cloud-brain && npm ci
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
`GET /v1/stats` (bodies and answers: [CB1](../docs/validation/cloud-brain.md#cb1-the-wire-format)).
Variables: `DISABLE_BRAIN=true` answers every `/v1/` route with 503
`disabled`; `ALLOW_LOCAL=true` allows `http://localhost:<port>` and
`http://127.0.0.1:<port>` origins besides the deployed ones.

## Test

```sh
bash scripts/build-cloud-brain.sh --test   # native: cargo test (the CB1 fixtures too)
npm run test:cloud-brain:service           # the built Worker under wrangler dev
node scripts/cloud-brain-load.mjs          # 20 000 brains: memory, latency, restart
```

`CLOUD_BRAIN_FEATURES=spike npm run dev -- --var CLOUD_BRAIN_SPIKE:1` adds
the CB0 measurement routes (both are needed: the feature builds them, the
variable turns them on; `build.sh` refuses the feature under `CI` unless
`CLOUD_BRAIN_ALLOW_SPIKE=1`). From the repo root,
`npm run test:cloud-brain:spike` runs them on port 8880; the load script
reads the object's memory through them.
