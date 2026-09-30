# Cloud brain: the toolchain spike (CB0)

CB0 of [cloud-brain.md](../plan/cloud-brain.md): does a Rust Worker built for
`wasm32-unknown-emscripten` (workers-rs v0.8.7, an experimental preview since
2026-09-25) run a SQLite-backed Durable Object, and which ruvector crates build
and run on it? Everything here ran locally (`wrangler dev` 4.144.0, local
workerd), with no Cloudflare account, on an Apple M3 Max shared with other work
(load average 9 to 30). Nothing was deployed. Raw results:
[cloud-brain-spike.json](cloud-brain-spike.json).

**Decision D1: the service is Rust on `wasm32-unknown-emscripten`,** the target
this work was asked to use. It met the functional bar: it built, ran a SQLite
object locally and kept its data across a restart, and ruvector-core ran inside
the object. It is not better: against a `wasm32-unknown-unknown` build of the
same code, the cold start was a tie, speed at moderate load went to that build
or was level (under a saturated host, results went either way), and the panic
difference is each target's default. Its costs are
listed below. The fallback stays cheap if CB2 puts the service logic in a
library crate (see the end).

## The skeleton

`cloud-brain/`: a Rust bin crate (`vectorvroom-brain`), `worker = "=0.8.7"`,
built by `bash cloud-brain/build.sh` (`worker-build --emscripten --release`;
it checks for worker-build 0.8.7).

- The front door sends every request to one Durable Object,
  `SharedBrain`, named `vectorvroom-shared-brain-v1`, a SQLite class
  (`new_sqlite_classes`). Its constructor creates `meta` with `sql_schema`; if
  that fails, every request answers 503.
- `GET /health` → `{ok, protocol: 1, brain: true, build: {target, ruvector,
  spike}}`. Everything else is 404 in a normal build.
- The `spike` Cargo feature (`CLOUD_BRAIN_FEATURES=spike`) adds `/spike/sql`
  (a row in and out of its own `spike_kv` table), `/spike/panic`,
  `/spike/memory`, and `/spike/index`. They answer only when the variable
  `CLOUD_BRAIN_SPIKE=1` is set (the spike test passes it to `wrangler dev`): a
  spike build without it answered 404 on every spike route. `build.sh` also
  refuses the feature under `CI` unless `CLOUD_BRAIN_ALLOW_SPIKE=1`, and CB5's
  deploy should check that `/health` says `spike: false`.
- `cloud-brain/` has its own `package.json` (wrangler 4.144.0), so the
  multiplayer pins (wrangler 4.103.0) do not move (D10). Run wrangler from
  `cloud-brain/` or with `--cwd cloud-brain`: its `build.cwd` is relative to
  wrangler's working folder, not to the config file.
- The Pages deploys (`deploy.yml`, `scripts/deploy-cloudflare.sh`,
  `.assetsignore`) leave `cloud-brain/` out.

## Toolchain findings

- **Pin `beta-2026-09-27` (Rust 1.99.0-beta.8).** With `beta-2026-09-29`
  (1.100.0-beta.1), Cargo's new build-folder layout puts the link output in
  `target/<triple>/release/build/<crate>/<hash>/out/`, and worker-build 0.8.7
  copies wasm-bindgen's JS snippets only from `release/deps/snippets`
  (`worker-build/src/build/mod.rs:474`), which no longer exists. The bundle then
  fails: `Could not resolve "./snippets/worker-…/inline0.js"` (the `worker`
  crate's own inline JS). Reproduced twice (once in review). A later beta needs
  a worker-build that knows the new layout.
- **worker-build provisions a patched Emscripten 6.0.10** into its cache
  (`~/Library/Caches/worker-build/` on macOS) on the first build, about
  3 minutes; a clean build then takes about 1 minute. It also fetches
  wasm-bindgen 0.2.129 and esbuild.
- `new_module_registry` is required (the Emscripten glue uses
  `import.meta.url`).
- **A Rust panic unwinds on Emscripten** (Wasm exception handling;
  `rustc --print cfg` says `panic="unwind"` for this target, and the build sets
  nothing else). `wasm32-unknown-unknown` aborts by default.
- On `wasm32-unknown-unknown`, ruvector crates need getrandom's JavaScript
  backend (`getrandom` 0.2 `js`, 0.3 `wasm_js` plus
  `--cfg getrandom_backend="wasm_js"`), as the browser builds do. Emscripten
  needs nothing.

## Measurements

`npm run test:cloud-brain:spike` (reports in `test-results/cloud-brain/`). The
`wasm32-unknown-unknown` column is a throwaway copy of the same code made a
`cdylib` (that target needs a library; worker-build then adds its abort
recovery), run through the same script, the two alternating. The host's load
still moved within a pair: in one session the same benchmark took 626 to 762 ms
on Emscripten and, a minute later, 45 to 47 ms on the other build.

| | `wasm32-unknown-emscripten` | `wasm32-unknown-unknown` |
|---|---|---|
| Size, spike build (Wasm / JS) | 369 151 / 46 802 bytes | 430 020 / 25 082 bytes |
| Size, normal build (Wasm / JS) | 324 658 / 46 043 bytes | — |
| Cold start, 5 paired restarts (median, range) | 50 ms (47 to 56) | 51 ms (41 to 54) |
| Final run, load 9 to 10: 20 000 / 50 000 brains | 46 to 47 / 112 to 120 ms | 45 to 47 / 106 to 109 ms |
| SQL round trip; row survives a restart | yes; yes | yes; yes |
| `GET /spike/panic` | 500 at once | no answer (30 s timeout) |
| After the panic | `/health` 5 of 5 200, SQL 200; the same instance (memory 46.8 MB kept) | `/health` 5 of 5 200, SQL 200; a new instance (memory 1.3 MB) |

- **Cold start** is the first request 3 s after the port accepts connections
  (by then wrangler has finished loading its runtime): it loads the module and
  constructs the object. A tie, each build faster in some pairs (load 13 to
  23); after a restart it was 13 to 16 ms. Both are far under CB0's 1 s bar
  locally; production is CB5.
- **Speed: no advantage for Emscripten.** `/spike/index` makes n random
  244-float brains and runs 10 exhaustive cosine searches (a compute
  benchmark: no SQLite read, no index structure). Times moved several-fold with
  the host's load in the same build: 20 000 brains took 44 to 681 ms on
  `wasm32-unknown-unknown` and 46 to 762 ms on Emscripten across sessions
  (this doc's runs and the reviews'). At moderate load `wasm32-unknown-unknown`
  was faster (review, load 10 to 15: 44 to 63 against 59 to 95 ms at 20 000) or
  level (the final pair, load 9 to 10: 45 to 47 against 46 to 47 ms). Under a
  saturated host (load 22 to 27) Emscripten was the faster at 50 000 in one
  pair (1 071 to 1 299 against 1 216 to 1 717 ms): noise, either way.
- **Memory: not comparable this way.** `/spike/memory` is the Wasm memory
  high-water mark (it never shrinks). After 5 000, 20 000 and 50 000 brains in a
  row, Emscripten shows 46.8 MiB (it starts at a 16 MiB floor and reused the
  freed blocks); `wasm32-unknown-unknown` shows 71.1 MiB, the earlier blocks
  kept beside the 50 000 one. The same order, every run.
- **Panics.** The difference is mostly each target's default: worker-build's
  `--panic-unwind` gives `wasm32-unknown-unknown` unwinding too, but needs a
  nightly toolchain and `rust-src`. For CB2 it
  matters either way: with unwinding, the instance lives on, so a panic in the
  middle of an update leaves the in-memory index half updated; with an abort,
  the instance is replaced and the index must be rebuilt.
- Workers Free allows 10 ms of CPU per request; building an index of 20 000
  brains took tens to hundreds of ms here. That is the case for Workers Paid
  (D2), or for a persisted index snapshot.
- The earlier full runs (`earlierRuns` in the JSON) timed the first request
  right after the port opened, before wrangler had finished loading its
  runtime, at load averages of 22 to 30: 1.7 to 4 s in three of the four runs
  (0.35 to 0.42 s in the fourth). That was wrangler's start-up under a
  saturated host, not the Worker's cold start.

## ruvector on Emscripten

`RUVECTOR_SRC=<a ruvector checkout> bash scripts/cloud-brain-spike-matrix.sh`
builds a probe against ruvnet/ruvector `5356a84e2` (the commit the browser
builds use; upstream's `Cargo.lock` pins the versions, and upstream's release
profile applies) for both targets. The probe is a plain program linked by emcc
for Node with `-Cpanic=abort`, not built like the Worker; the Emscripten builds run under Node, and on
`wasm32-unknown-unknown` "builds" means it compiles, nothing runs.

| Configuration | wasm32-unknown-emscripten | runs (Node) | wasm32-unknown-unknown |
|---|---|---|---|
| `core-memory` | builds, 125 KB | ruvector-core: 20000 inserts 30 ms, 10 searches 121.8 ms, 100 hits | builds |
| `core-storage` | builds, 700 KB | ruvector-core: 20000 inserts 604 ms, 10 searches 95.6 ms, 100 hits | builds |
| `core-simd` | builds, 125 KB | ruvector-core: 20000 inserts 23 ms, 10 searches 90.1 ms, 100 hits | builds |
| `core-hnsw` | fails: error[E0433]: cannot find module or crate `sys` in the crate root in sysctl-0.5.5/src/lib.rs:77:9 | — | fails: error[E0433]: cannot find module or crate `platform` in this scope in mmap-rs-0.6.1/src/areas.rs:122:21 |
| `hyperbolic` | builds, 120 KB | hyperbolic-hnsw: 2000 inserts 678 ms, 10 searches 0.8 ms, 50 hits | builds |
| `sona` | builds, 125 KB | sona: 200 tasks + aggregate 64 ms, accepted 200, session_duration_ms 0 (std clock 1790768139 s since 1970) | builds |

- **`memory-only` works, also inside the Durable Object.** ruvector-core's
  `VectorDB` with its flat index (`memory-only` itself is an empty marker: it
  just leaves the native features off). This is what CB2 uses first.
  `RUVECTOR_SRC=<checkout> bash scripts/cloud-brain-spike-ruvector.sh` builds
  a throwaway copy of the Worker with ruvector-core added (348 775 bytes of
  Wasm with upstream's `Cargo.lock`) and runs it under `wrangler dev`:

  | Brains in the object's `VectorDB` | Inserts and 10 searches | Module memory |
  |---|---|---|
  | 20 000 | 113 to 141 ms (3 runs; 123 to 158 in a first, hand-made run) | 48.6 MiB |
  | 50 000 | 299 ms (333 in the first run) | 101 MiB |

  Module memory is the Wasm high-water mark: it includes Emscripten's 16 MiB
  starting memory and growth slack beside the 18.6 MiB of raw floats (20 000 ×
  244 × 4 bytes) and the `VectorDB`'s ids and maps. 50 000 brains come close to
  a Worker's 128 MB, and Wasm memory never shrinks. CB2's other indexes
  (tracks, dynamics) share that budget.
- **`storage` (redb over `std::fs`) builds and runs on Emscripten**, on its
  in-memory file system (0.5 to 1.3 s for 20 000 inserts across runs). Persisting it needs a file
  system backed by the object's SQLite, as the Minecraft demo mounts with
  `worker-fs-mount` and `durable-object-fs` (`-sNODERAWFS` routes `std::fs` to
  `node:fs`, which those packages then serve) (CB7).
- **`simd` builds but does nothing on either Wasm target**: ruvector-core calls
  SimSIMD only when `target_arch` is not `wasm32` (`distance.rs`), and falls
  back to scalar code.
- **`hnsw` (hnsw_rs) fails on both targets**: its dependencies (`sysctl`,
  and `mmap-rs`, which pulls `nix` 0.26) have no Emscripten support; the first
  error depends on build order. The hyperbolic HNSW builds and runs but took
  0.5 to 0.7 s for 2 000 small (16-float) vectors, so it is no index for 20 000
  brains; at that size a flat search took about 8 to 12 ms in the Node probe.
- **SONA runs, but its clock reads 0 on Emscripten.** `EphemeralAgent` and
  `FederatedCoordinator` (the federated path of CB6) work, but
  `session_duration_ms` is 0 after a 50 ms busy wait: `time_compat.rs` picks its
  Wasm branch for every `target_arch = "wasm32"`, and without the `wasm` feature
  that branch returns 0. CB6 patches both cfgs (`target_os = "emscripten"`
  takes the `std` branch). Even then, inside workerd `Date.now()` and
  `performance.now()` stand still during synchronous work, so a duration
  measured within one request stays about 0 until the request does I/O (not
  measured here).

## Reproduce

```sh
rustup toolchain install beta-2026-09-27 --profile minimal \
  --target wasm32-unknown-emscripten --target wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
(cd cloud-brain && npm ci && bash build.sh)   # provisions Emscripten the first time
npm run test:cloud-brain:spike                # COLD_ONLY=5 for cold starts only
RUVECTOR_SRC=<ruvector checkout> bash scripts/cloud-brain-spike-matrix.sh
RUVECTOR_SRC=<ruvector checkout> bash scripts/cloud-brain-spike-ruvector.sh
```

## Costs of the choice, and the fallback

- An experimental preview: flags and output may change.
- The toolchain is pinned to the last 1.99 beta; the 1.100 beta already breaks
  the build with worker-build 0.8.7.
- A clean machine or CI runner spends minutes provisioning Emscripten, and
  worker-build's cache takes about 1.7 GB (worth caching in CI).
- SONA needs a patch (CB6).

Falling back to `wasm32-unknown-unknown` needs a `cdylib` library instead of
the bin, and getrandom's JavaScript backend. CB2 keeps that small by putting the
service logic in a library crate with no `worker` dependency, checked in CI for
both targets.

## Limits

- One machine, local workerd, a busy host: times are local and noisy; CB5
  measures the deployed object.
- The `wasm32-unknown-unknown` comparison is a hand-made copy, not a
  maintained build.
- Every result depends on the pins: Rust `beta-2026-09-27`, worker-build 0.8.7,
  Emscripten 6.0.10, wrangler 4.144.0.
