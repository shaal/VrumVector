# Circuit Studio

Three.js r186 presentation for the existing planar simulation. The runtime and
addons are bundled together under `vendor/three-0.186.0`; the site remains a
static deployment. Rebuild that file with `npm ci && npm run vendor:three`.

## Included

- Procedural circuit garden, alpine, and desert scenery built around the actual
  inner/outer track loops. Barriers use the simulation's collision boundaries.
- Lit 3D cars, instanced population silhouettes, day/night lighting, TSL asphalt,
  GPU-animated rain, bloom, and optional reduced-resolution planar reflections.
- Orbit, overhead, chase, front, trackside, and automatic director cameras.
- My car follows the existing WASD-controlled player, including when stationary;
  Chase returns to the AI driver. Player vision shows that car's real sensors.
- Optional procedural engine and impact audio follows the selected driver.
  Sound starts off on every visit, creates its AudioContext only on an explicit
  click, and mutes while paused, hidden, or outside Studio. No audio is downloaded.
- Live champion sensor rays, actual binary control decisions, and crash density.
- Worker-recorded runs, slow playback, scrubbing, and up to two earlier ghosts.
- Classic Canvas 2D for editing, A/B comparison, and graphics failure recovery.
- Responsive controls and reduced-motion handling. WASD and arrow keys remain
  reserved for driving. C cycles cameras, F follows, V toggles AI vision, N
  toggles night, 0 resets orbit, and 3 returns to Classic 2D.

## Data and boundaries

The renderer consumes existing snapshots without writing to car, brain, physics,
fitness, or archive state. Each worker begin gets a separate presentation serial,
so interpolation also resets on manual restarts within one generation. Large
snapshot gaps are not interpolated. Above 5× training, live camera selection
temporarily uses overhead; recorded playback remains at its selected speed.

Replay records a fixed, evenly spaced cohort of at most 16 drivers at 20 Hz in
simulation time. At generation end, the furthest of these recorded drivers is
retained. It is explicitly not a claim to have recorded the global champion.
Each sample contains frame, position, heading, speed, controls, and damage state.
The recorder is bounded to 120 seconds / about 1.1 MB per generation, and six
selected runs are retained in memory. Changing the track clears them. Replay
does not alter training speed or pause the simulation. Replay shows recorded
controls; sensor beams are live-only because their history is not recorded.

All scenery uses a private PRNG. Decorative geometry never changes the road,
sensors, collision checks, or checkpoints. Weather is visual only. Rendered
population detail is capped by quality (300/800/1600 silhouettes); training
population size and population-wide statistics are not reduced.

## Compatibility and verification

WebGPURenderer automatically selects WebGL 2 when WebGPU is unavailable. Graphics
errors and device loss return to the existing renderer. `?graphics=classic`
forces the original view; `?graphics=studio&backend=webgl` exercises WebGL 2.
Use `?graphics=studio&scene=night&camera=chase` for the night view.

`npm run test:graphics` covers all ten preset road meshes, interpolation, restart
identity, track membership, private randomness, replay timing, bounded memory,
and track-specific ghosts. `npm run test:graphics:browser` starts a local server
and exercises real shader compilation, training, camera controls, reflections,
replay, mobile layout, the editor, and failure recovery with Playwright Chromium.
CI attaches screenshots and a report identifying the backend actually selected.
Native WebGPU runs with Mesa Vulkan under a virtual display, following Three.js's
own E2E setup. This verifies the API and shaders, not physical-GPU performance.
Visual/browser validation results are recorded in the pull request.

Quality is a rendering choice, not a promise of a particular frame rate. Profile
native WebGPU and WebGL 2 separately on representative mobile and desktop GPUs.
