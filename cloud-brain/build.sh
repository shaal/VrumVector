#!/usr/bin/env bash
# Build the cloud brain Worker for wasm32-unknown-emscripten (wrangler runs
# this before `wrangler dev` and `wrangler deploy`). CLOUD_BRAIN_FEATURES adds
# Cargo features, e.g. `spike` for the CB0 measurement routes; a deployed
# build never sets it.
set -euo pipefail
cd "$(dirname "$0")"
# The toolchain pin (docs/validation/cloud-brain-spike.md) depends on this
# exact worker-build.
WORKER_BUILD=0.8.7
if [[ "$(worker-build --version 2>/dev/null)" != "$WORKER_BUILD" ]]; then
  echo "build.sh: needs worker-build $WORKER_BUILD (cargo install worker-build --version $WORKER_BUILD --locked)" >&2
  exit 1
fi
# The ruvector sources the index comes from (fetched once into .work/).
bash ../scripts/build-cloud-brain.sh --fetch
args=(--emscripten --release)
# The spike routes (a panic, a 100 000-brain allocation) must never deploy:
# CI refuses them unless CLOUD_BRAIN_ALLOW_SPIKE=1 says the build stays local.
if [[ "${CLOUD_BRAIN_FEATURES:-}" == *spike* && -n "${CI:-}" && "${CLOUD_BRAIN_ALLOW_SPIKE:-}" != 1 ]]; then
  echo "build.sh: refusing the spike feature in CI (set CLOUD_BRAIN_ALLOW_SPIKE=1 for a local-only build)" >&2
  exit 1
fi
if [[ -n "${CLOUD_BRAIN_FEATURES:-}" ]]; then
  args+=(-- --features "$CLOUD_BRAIN_FEATURES")
fi
exec worker-build "${args[@]}"
