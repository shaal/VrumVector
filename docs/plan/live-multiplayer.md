# Live multiplayer

New visitors automatically join multiplayer at 1×, with other drivers hidden.
Joining does not start training or dismiss the **Start Training** screen. The
compact **Multiplayer** button shows the connection state and whether other
drivers are hidden. Open it for two independent controls:

- **Multiplayer** shares your WASD car. It is on by default. Turning it off
  disconnects, stops sharing your car, hides other drivers, and unlocks speed.
- **Show other drivers** displays their cars, callsigns, and lap standings. It
  is off by default. Hiding them keeps your car shared and preserves the socket
  and current lap. This control is unavailable while multiplayer is off.

Both explicit choices and the editable random callsign are remembered locally.
A saved opt-out stays off after reload; an explicit choice to show drivers stays
on. Chrome and incognito keep their preferences independently. The panel explains
that other players can see your car even when you hide theirs. The race code and physics are visible in the panel; extra racing guidance is under
**Room & racing details**.

All connected sessions join a shared lobby, including visitors with different saved
tracks or car settings. With **Show other drivers** on, matching drivers appear on
the track and in Best laps. Others appear under **Other races** with a **Join race**
button. Joining temporarily copies their walls, checkpoints, max speed, traction
and invincibility. It respawns the human cars, resets lap timing and local AI,
keeps the current paused/Start Training state, and turns adaptive gates off to
keep the shared course stable. **Restore my setup** restores the pre-join setup.
Joining never overwrites saved track/physics; reloading loads your own saved setup.
Equivalent numeric strings and point-property ordering match. Drivers with stale
poses remain named as waiting for a car, rather than silently disappearing from
standings. Preview PRs and production have separate services. No account is needed.

Remote cars have colored bodies and callsign labels in Circuit Studio and Classic
2D, including the **Tilt** view. They do not collide with other drivers. **Chase my car** uses the existing WASD
camera. Replays hide live cars until playback ends. Switching windows or hiding a
tab keeps its player connected: the car parks, receives an **away** label, and
sends a heartbeat every ten seconds when the browser allows it. Returning resumes
the same connection and clears held controls and the partial lap. Editor/A-B views,
closed pages, and switching multiplayer off leave the room. Failed connections
retry with bounded backoff. Silent foreground connections expire within 45–60
seconds; their stale car poses disappear after three seconds. Away connections
allow 180 seconds of silence (removal within 180–240 seconds), accommodating
Chrome's delayed background timers. A frozen/discarded tab or sleeping device can
still lose its connection; returning reconnects automatically. The lobby is limited
to 32 drivers. Normal and incognito windows discover each other: identity is
assigned per connection, without login or shared cookies. Different settings
require a Join race click to share the same course, not to discover each other.

Automatic joining or enabling multiplayer sets the game and AI training to 1× and locks the speed
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
Object for the public `/lobby`. Legacy `/room/<hash>` routes remain available for
older pages during rollout; both devices must reload to use the shared lobby.
WebSocket hibernation attachments retain small active-session state. Bounded
geometry is stored separately per connection so complex tracks do not overflow
attachment limits; it is deleted on departure. There is no race-history database.
Setup metadata is sent on change, on welcome and periodically for recovery,
not with every pose. Clients send five updates per second while moving, one
heartbeat per second while parked, and one every ten seconds in the background.
The cleanup alarm runs once per minute. The service caps accepted updates, bounds
message size,
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
If Cloudflare usage needs an immediate pause without changing Pages, deploy the
Worker with `--var DISABLE_MULTIPLAYER:true`; `/health` reports
`multiplayer:false` while the circuit breaker is active.

Local setup:

1. `npm ci` (Node 22+).
2. `npm run dev:multiplayer` starts the local service on port 8878.
3. Set the local `AI-Car-Racer/multiplayer/config.json` endpoint to
   `http://127.0.0.1:8878` (do not commit that local value).
4. Serve the repository, e.g. `python3 -m http.server 8877`, and open
   `http://127.0.0.1:8877/AI-Car-Racer/?rv=0` in two browser profiles.

`npm run test:multiplayer` exercises actual Durable Objects/WebSockets through
Miniflare, including relay, isolation, departure, away/resume states, input
rejection, interpolation, and lap validity. Simulated-clock client checks cover
minute-long timer delays and acknowledgment grace on resume.
`npm run test:multiplayer:browser` runs independent browser
contexts (desktop and mobile emulation from first load) against that service,
covering automatic joining without starting training,
hidden-by-default drivers, independent visibility, saved choices and opt-out,
callsigns, actual WASD motion,
1–5-car worker cohorts, generation continuity, 3D cars, mobile layout, isolation,
reconnection, visibility lifecycle, and reload behavior. The visibility event is
simulated in this headless test; parked car rendering and retention of the same
live socket across away/resume are checked against the real local service.
`node tests/multiplayer-discovery-browser.mjs` additionally loads independent
desktop/mobile profiles with different saved tracks and physics, checks discovery,
taps Join race, verifies geometry/physics synchronization and preservation of
saved settings, restores the original setup, and checks real WASD pose delivery.
Mobile emulation is not a physical-phone test.
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
