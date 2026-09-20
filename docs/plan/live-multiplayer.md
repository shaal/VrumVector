# Live multiplayer

Open **Multiplayer**, edit the random callsign, then enable **Show live drivers**.
It starts off on every page load. The callsign alone is remembered locally.
Enabling the option shares the WASD car and joins other visible, opted-in browser
sessions with the same track geometry, max speed, traction, and invincibility
setting. Equal numeric settings match even when loaded from older saved slider
values. The panel shows a room code and current physics: friends with the same
code are on the same grid. Different codes mean the track or vehicle settings
differ. Preview PRs and production have separate services. No account is needed.

Remote cars have colored bodies and callsign labels in Circuit Studio and Classic
2D, including the **Tilt** view. They do not collide with other drivers. **Chase my car** uses the existing WASD
camera. Replays hide live cars until playback ends. Hidden tabs, editor/A-B views,
closed pages, and switching multiplayer off leave the room. Failed connections
retry with bounded backoff. Silent connections expire within 15–30 seconds;
stale car poses disappear after three seconds. Rooms are limited to 32 drivers.

Enabling multiplayer sets the game and AI training to 1× and locks the speed
selector while connected or reconnecting. Turning multiplayer off unlocks the
selector and leaves it at 1×. Automatic AI generation changes preserve the human
car and lap. Manual restarts reset the
attempt. Lap timing uses ordered start/checkpoint crossings and the independent
60 Hz human physics clock; crashes, pauses, teleports, and backgrounding invalidate
the current attempt. Best laps appear beside other drivers and **AI leader (local)**.
AI training stays local to each browser. This is casual live time-trial racing,
with client-reported poses and lap times; it is not an authoritative ranked race,
shared AI simulation, or a synchronized starting grid.

Training tuning now offers every population from 1 to 2,000, including quick
buttons for 1, 2, 3, 4, and 5. Changes take effect on the next generation. The
slider supports keyboard adjustment and has a visible accessible label.

## Service and deployment

`multiplayer/worker.js` runs a Cloudflare Worker with one SQLite-backed Durable
Object per track/rules hash. WebSocket hibernation attachments retain only active
session state; there is no race-history database. The service accepts ten updates
per second from each normal client, caps accepted updates, bounds message size,
validates the wire shape and numeric ranges, assigns connection IDs, and allows
only the deployed site origins. Callsigns are plain text in all views.

The existing Pages workflow deploys the service first, writes its HTTPS origin to
`AI-Car-Racer/multiplayer/config.json`, then stages and publishes the static site.
A PR uses `vectorvroom-live-pr-<number>`; main uses `vectorvroom-live`. The existing
Cloudflare token needs **Workers Scripts: Edit** as well as Pages deployment
access on the configured account. Alternatively, set the repository secret
`CLOUDFLARE_WORKERS_API_TOKEN` to a token with Workers access for that account;
the Pages token then keeps its current scope. If service deployment fails, the
static preview still publishes with multiplayer unavailable, and the workflow
reports the service failure. Rerun the deployment after fixing access. A Durable Object migration creates the room
namespace. PR services can be deleted after the PR closes. A bare static checkout
has no endpoint configured and reports that clearly when joining is attempted.

Local setup:

1. `npm ci` (Node 22+).
2. `npm run dev:multiplayer` starts the local service on port 8878.
3. Set the local `AI-Car-Racer/multiplayer/config.json` endpoint to
   `http://127.0.0.1:8878` (do not commit that local value).
4. Serve the repository, e.g. `python3 -m http.server 8877`, and open
   `http://127.0.0.1:8877/AI-Car-Racer/?rv=0` in two browser profiles.

`npm run test:multiplayer` exercises actual Durable Objects/WebSockets through
Miniflare, including relay, isolation, departure, input rejection, interpolation,
and lap validity. `npm run test:multiplayer:browser` runs independent browser
contexts against that service, covering opt-in, callsigns, actual WASD motion,
1–5-car worker cohorts, generation continuity, 3D cars, mobile layout, isolation,
reconnection, visibility lifecycle, and reload defaults. The visibility event is
simulated in this headless test; socket disconnection and rejoining are real.
The existing WebGPU/WebGL and contrast workflows continue to run.

## AI driving

**AI driving: off/on** is available in Classic 2D and Circuit Studio. It starts off
on every visit. Enabling it starts or resumes training and copies the live leading
AI network once per second. The WASD car evaluates its own sensors against a
private copy, so the co-driver learns along with the local population and may
still crash while training. It does not replay the leader's position or inputs.

Holding A/D overrides the complete steering axis; holding W/S overrides the
acceleration/braking axis. Other axes remain under AI control. Releasing the keys
returns those controls to the AI. Switching AI driving off immediately restores
manual control, including keys already held. Blur and visibility changes clear
held inputs. Automatic generations preserve the assisted car; manual restarts
reset it. Worker replies from old runs are ignored.

Normal visits start in Classic 2D, including after a previous 3D session. The
**Switch to 3D graphics** button opens Studio; **Switch to 2D** returns. Explicit
`?graphics=studio` links remain available for direct Studio previews.
