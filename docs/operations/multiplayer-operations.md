# Multiplayer operations

This is the operational runbook for the live multiplayer service used by
[VectorVroom](https://vv.shaal.dev/AI-Car-Racer/).

## Architecture

- Cloudflare Pages serves the static game client and vendored RuVector WASM.
- The `vectorvroom-live` Cloudflare Worker accepts WebSocket upgrades.
- Its SQLite-backed Durable Object (`LiveRoom`) hosts the shared public lobby.
- Browsers run their own physics, AI training, and rendering. The Worker relays
  bounded human poses, callsigns, setup metadata, and lap results; it does not
  run the AI on every physics tick.
- Setup geometry is persisted only when it changes. There is no race-history
  database.

Production endpoints:

```text
Game:   https://vv.shaal.dev/AI-Car-Racer/
Worker: https://vectorvroom-live.shaal.workers.dev
Health: https://vectorvroom-live.shaal.workers.dev/health
```

## Current traffic policy

The client interpolates remote poses, so high-frequency network updates are not
needed for smooth rendering.

| Situation | Client update interval |
|---|---:|
| Moving in the foreground | 200 ms (5 Hz) |
| Paused, stationary, or before Start Training | 1,000 ms (1 Hz) |
| Hidden/background tab | 10,000 ms heartbeat |
| Visibility transition | Immediate parked/resumed pose |

The Worker accepts at most one update per connection every 150 ms. Durable
Object cleanup alarms run every 60 seconds. Active sessions expire after 45
seconds of silence; explicitly away sessions expire after 180 seconds. These
values intentionally trade a little stale-presence delay for substantially
lower Durable Object usage.

## Interpreting Cloudflare usage

Inspect **Workers & Pages → Durable Objects → `vectorvroom-live_LiveRoom` →
Metrics** over the same time range as the alert.

The important relationships are:

- A large **Inbound hibernatable WebSocket messages** count indicates pose
  traffic from browsers.
- **Outbound** messages represent broadcasts and are not the same as incoming
  request volume.
- **Alarm** counts reflect the cleanup cadence and should drop after moving
  from the old 15-second schedule to the one-minute schedule.
- **Client disconnected** errors usually mean a tab closed, reloaded, or lost
  its mobile network. CPU-limit, memory-limit, internal, or Worker-thrown
  errors are the signals that indicate a server-side failure.
- Storage and memory should remain small because poses live in hibernation
  attachments and only setup changes are persisted.

Cloudflare's dashboard shows actual Durable Object activity. Billing can apply
a separate 20:1 ratio to incoming WebSocket messages, so the dashboard's
**Requests** card must not be treated as an exact billable-request count.
Confirm the plan and the exact category named by the alert before comparing it
with a quota. See Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

At the time of this update, Cloudflare documents 100,000 Workers Free requests
per day and a separate Durable Objects billing model for paid usage. Treat those
numbers as plan documentation, not as a substitute for checking the account's
current plan and alert category.

The 2026-09-21 snapshot that motivated this runbook showed approximately 739k
Durable Object requests, 733k inbound hibernatable messages, and 7k alarms,
with zero CPU, memory, internal, or Worker-thrown failures. That pattern points
to multiplayer pose frequency—not AI training, Pages, storage, or CPU—as the
primary source of usage.

## Alert response

1. Check whether the alert is for a Workers Free quota, a Durable Objects
   billing metric, or a custom account alert.
2. Compare **Inbound hibernatable messages**, **Requests by type**, and
   **Alarms** in the same 24-hour window.
3. Check invocation errors. If only client disconnects are elevated and CPU or
   memory limits remain zero, the service is noisy but not overloaded.
4. Keep the reduced client policy enabled. Do not restore 10 Hz pose updates
   to improve visual smoothness; interpolation is the intended solution.
5. If a hard limit is imminent, use the emergency switch below. Then deploy the
   normal configuration after the account is safe.

## Emergency disablement

This pauses new multiplayer connections without changing the Pages site:

```sh
npx wrangler deploy \
  --config multiplayer/wrangler.jsonc \
  --name vectorvroom-live \
  --var DISABLE_MULTIPLAYER:true
```

While disabled, `/health` returns `multiplayer:false`. The static game remains
playable locally; its multiplayer control reports the service as unavailable.
Re-enable the service by deploying normally, without the variable. The regular
GitHub Actions deployment also clears the emergency setting because the normal
Worker configuration does not define it.

## Deploy and verify

For production, push to `main` and let `.github/workflows/deploy.yml` run. The
workflow:

1. Deploys the Worker (`vectorvroom-live` on `main`, a PR-specific Worker on a
   pull request).
2. Writes the Worker origin to `AI-Car-Racer/multiplayer/config.json`.
3. Stages and publishes the static Pages release.

After a successful run, verify both endpoints:

```sh
curl -fsS https://vectorvroom-live.shaal.workers.dev/health
curl -fsSI https://vv.shaal.dev/AI-Car-Racer/
```

The normal health response includes `"ok":true`, `"protocol":2`, and
`"multiplayer":true`. A Pages-only upload can leave the client with a stale or
missing Worker endpoint, so use the workflow for a production multiplayer
release.

## Verification commands

Run from the repository root:

```sh
npm ci
npm run test:multiplayer
npx playwright install --with-deps chromium
node tests/multiplayer-discovery-browser.mjs
npm run test:multiplayer:browser
```

The Node suite covers Durable Object/WebSocket relay, validation, throttling,
away/resume behavior, interpolation, and lap timing. The browser suites cover
desktop/mobile discovery, saved preferences, different race setups, actual
WASD movement, reconnects, 3D rendering, and visibility lifecycle. A local
browser test requires the Playwright Chromium binary; CI installs it explicitly.
