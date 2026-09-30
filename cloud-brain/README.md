# Cloud brain Worker

One shared vector memory for VectorVroom, as a Rust Worker with a SQLite
Durable Object ([plan](../docs/plan/cloud-brain.md), [spike results](../docs/validation/cloud-brain-spike.md)).
It is built for `wasm32-unknown-emscripten` with `worker-build --emscripten`, an
experimental preview. Nothing here is deployed yet.

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
npm run dev          # wrangler dev; GET http://localhost:8879/health
```

Run wrangler from `cloud-brain/` (or `wrangler --cwd cloud-brain ...`): its
build command runs `build.sh` in wrangler's working folder. `wrangler dev`
listens on `localhost:8879`.

`CLOUD_BRAIN_FEATURES=spike npm run dev` adds the CB0 measurement routes
(`build.sh` refuses them under `CI` unless `CLOUD_BRAIN_ALLOW_SPIKE=1`). From
the repo root, `npm run test:cloud-brain:spike` runs them on port 8880.
