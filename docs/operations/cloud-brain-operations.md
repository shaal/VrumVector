# Cloud brain operations

The runbook for the shared cloud brain used by
[VectorVroom](https://vv.shaal.dev/AI-Car-Racer/) in shared mode
([plan](../plan/cloud-brain.md), [results](../validation/cloud-brain.md)).

## Architecture

- The `vectorvroom-brain` Cloudflare Worker (Rust, `wasm32-unknown-emscripten`,
  `cloud-brain/`) answers the page's requests: recall, contribute, forget,
  stats, verify, leaderboard, crash maps.
- Its front door applies the breaker, origins and CORS, the per-address
  rate limits and the 64 KB body limit before the Durable Object.
- One SQLite Durable Object (`SharedBrain`) holds everything: brains,
  feedback, tracks, verified runs, pinned geometries, crash maps, quotas.
  It rebuilds its in-memory index from SQL after a restart.
- Pages serves the game. `AI-Car-Racer/cloud/config.json` names the Worker;
  `{"endpoint": null}` hides the Shared option.

Production endpoints:

```text
Game:    https://vv.shaal.dev/AI-Car-Racer/
Worker:  https://vectorvroom-brain.shaal.workers.dev
Health:  https://vectorvroom-brain.shaal.workers.dev/health
```

A pull request gets `vectorvroom-brain-pr-<n>` (its own Durable Object, its
own data) and a Pages preview that points at it.

## Plan and cost (D2: Workers Paid)

The account is on Workers Paid ($5 a month minimum). `wrangler.jsonc` sets
`limits.cpu_ms` to 30 000, which only Paid accounts can set. Free's 10 ms
of CPU a request is far too little: a cold start rebuilds the index (a
recall then took 0.7 to 1.1 s locally) and a contribution at the cap takes
53 to 82 ms.

What drives the bill:

| Source | Volume |
|---|---|
| A training page | about 6 contributions, 1 crash map, a few recalls a minute (about 500 requests an hour) |
| Rows written | a contribution's brains and feedback rows, 1 crash map row a minute |
| Rows read | a crash recall up to 80; a forget reads every feedback record of the token's tag |
| Storage | 20k brains about 40 MB; crash maps at most 5 000 tracks × 4 modes × 16 rows |
| CPU | a cold start about 1 s; a verification up to about 0.1 s |

Check the Workers and Durable Objects usage pages in the dashboard weekly
while traffic is new.

## Limits

| Limit | Value | Where |
|---|---|---|
| Writes per address (contribute, crash maps) | 24 a minute | `wrangler.jsonc` `WRITE_LIMIT` |
| Reads per address (recall, crash recall, stats, leaderboard, health) | 60 a minute | `READ_LIMIT` |
| Forgets per address | 3 a minute | `FORGET_LIMIT` |
| Verifications per address | 6 a minute; 30 a minute in all | `VERIFY_LIMIT`, `VERIFY_PER_MINUTE` |
| Daily quota per token | 10 000 requests, 5 000 brains, 50 000 feedback rows | `QUOTA_*` vars |
| Brains, tracks | 20 000, 5 000 | `Config`, `MAX_TRACKS` (fewer only) |

The rate-limit `namespace_id`s 4201 to 4204 must stay unique among the
account's rate limiters. PR previews share them with production, so a
preview's traffic counts against the same addresses. A quota-exhausted page
retries about once a minute (the client does not read `Retry-After` yet).

## Emergency disablement

This answers every `/v1/` route with 503 `disabled` without changing the
Pages site. Pages show "unavailable" and train from their own memory.

```sh
cd cloud-brain
npx wrangler deploy --name vectorvroom-brain --var DISABLE_BRAIN:true
```

While disabled, `/health` returns `"brain":false`. Deploy normally (or let
the next `main` deploy run) to turn it back on; the normal configuration
does not set the variable. The data stays in the Durable Object either way.

## Deploy and verify

Push to `main`. `.github/workflows/deploy.yml`:

1. Installs the pinned toolchain (`.github/actions/cloud-brain-toolchain`:
   the Rust beta, worker-build 0.8.7, the Emscripten it provisions; cached).
2. Deploys the Worker from `cloud-brain/` with its own wrangler
   (`vectorvroom-brain`, or `vectorvroom-brain-pr-<n>`).
3. Runs `scripts/cloud-brain-health.mjs` on it: `/health` must say `ok`,
   `brain`, `limits` and the page's protocol, and `/v1/stats` must answer
   `https://vv.shaal.dev` with CORS.
4. Writes the Worker origin into `AI-Car-Racer/cloud/config.json` only if
   that passed (else `null`: the Shared option is hidden), then publishes
   Pages. A failed brain deploy fails the workflow after Pages is published.

After a run, verify by hand:

```sh
node scripts/cloud-brain-health.mjs https://vectorvroom-brain.shaal.workers.dev
curl -fsS https://vv.shaal.dev/AI-Car-Racer/cloud/config.json
```

The token in `CLOUDFLARE_WORKERS_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`) needs
Workers Scripts: Edit on the account in `CLOUDFLARE_ACCOUNT_ID`.

Roll back a bad Worker version (the data stays):

```sh
cd cloud-brain
npx wrangler deployments list --name vectorvroom-brain
npx wrangler rollback --name vectorvroom-brain <version-id>
```

A rollback across an SQL schema change is not safe: a migration newer
than the build (the `migrations` table) makes an older Worker refuse to
serve (`/health` `ok:false`, every route `server-error`). Fix forward
instead.

## The per-address limit keys

The limits key on `CF-Connecting-IP`, which Cloudflare sets at the edge (a
client cannot choose it). Check it after a change to the front door. These
25 writes carry made-up `CF-Connecting-IP` headers and invalid bodies, so
nothing is stored. The first 24 get 400, the 25th 429:

```sh
for i in $(seq 1 25); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST \
    -H 'Origin: https://vv.shaal.dev' -H "CF-Connecting-IP: 198.51.100.$i" \
    --data 'x' https://vectorvroom-brain.shaal.workers.dev/v1/contribute
done; echo
```

## Cloud training (X2)

Off unless `TRAIN_FRAMES` is set. To turn it on, deploy with, for example,
`--var TRAIN_FRAMES:120000` (about 0.1 s of CPU a session).
`TRAIN_EVERY_SECONDS` (1 800) and `TRAIN_IDLE_MINUTES` (10) set when
sessions run. `/health` then says `"training":true`.

## Forget and data requests

The page's "forget me" calls `POST /v1/forget` with the browser's token.
It deletes the token's brains, their feedback, the brains the service bred
from them, and the token's crash maps. It keeps runs the service drove,
without the token. The service stores only the SHA-256 of a token, never
an IP address.

## Fuzzing (after a change to `cloud-brain/core`)

```sh
rustup toolchain install nightly-2026-09-29 --profile minimal
cargo install cargo-fuzz --locked
bash scripts/fuzz-cloud-brain.sh 300        # 5 minutes per target
```

A failure leaves its input in `cloud-brain/core/fuzz/artifacts/<target>/`
and exits non-zero.

## PR previews

Each PR leaves a `vectorvroom-brain-pr-<n>` Worker and its Durable Object.
Delete them when the PR is closed:

```sh
cd cloud-brain && npx wrangler delete --name vectorvroom-brain-pr-<n>
```

## Verification commands

From the repository root (`.github/workflows/cloud-brain.yml` runs them):

```sh
npm ci && (cd cloud-brain && npm ci)
bash scripts/build-cloud-brain.sh --test
npm run test:cloud-brain
npm run test:cloud-brain:service
npx playwright install --with-deps chromium
npm run test:cloud-brain:browser
```
