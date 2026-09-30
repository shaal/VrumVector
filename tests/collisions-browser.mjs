// Car collisions (tasks C2 to C4) in the real app: ?collide=1 and the
// Experiments toggle, both sim-worker.js instances (live and A/B baseline)
// running in collision mode with rays that see cars, cause 5 in the metrics,
// the learning context, and vector memory in collision mode (C4: no SONA
// steps, crash maps without contact deaths and tagged with the mode, and
// contact statistics on archived drivers). With MEASURE=1 it also measures the real
// worker's step cost at N = 500 on Rectangle and Triangle: collisions off,
// on with rays that see walls only (carCollisions.seeCars = false, which the
// UI never sets; the context is then 'solid/k8'), and on with rays that see
// cars, and writes test-results/collisions/step-cost.json.
//
//   node tests/collisions-browser.mjs            (MEASURE=1 for the step cost, PORT=8897 for another port)
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import {chromium} from 'playwright';
import {waitForServer} from './helpers/server-ready.mjs';

const out = 'test-results/collisions'; await mkdir(out, {recursive: true});
const PORT = Number(process.env.PORT) || 8895, origin = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {stdio: 'ignore'});
let browser, page, stage = 'boot';
const errors = [];
const mark = value => { stage = value; console.log(stage); };

// Every sim-worker.js the page starts: what main posts to it and what it posts back.
const spyOnWorkers = () => {
  const Base = window.Worker;
  window.__simWorkers = [];
  window.Worker = class extends Base {
    constructor(url, options) {
      super(url, options);
      if (!String(url).includes('sim-worker.js')) return;
      const record = {begins: [], genEnds: [], lastSnapshot: null, runs: {}};
      window.__simWorkers.push(record);
      const post = this.postMessage.bind(this);
      this.postMessage = (message, transfer) => {
        if (message && message.type === 'begin') {
          record.begins.push({N: message.N, collisions: message.collisions ?? null, context: message.learningContext?.collisions ?? null});
        }
        return post(message, transfer);
      };
      this.addEventListener('message', event => {
        const m = event.data;
        if (!m) return;
        if (m.type === 'snapshot') {
          // Stepping time per generation (runSerial), for the step cost.
          const run = record.runs[m.runSerial] ||= {simMs: 0, steps: 0};
          run.simMs += m.simMs; run.steps += m.steps;
          record.lastSnapshot = {N: m.N, collisions: m.collisions ?? null, flags: m.carFlags ? Array.from(m.carFlags) : null,
            kinds: m.bestReadingKinds ? Array.from(m.bestReadingKinds) : null};
          if (m.bestReadingKinds && m.bestReadingKinds.includes(1)) record.carRaySnapshots = (record.carRaySnapshots || 0) + 1;
        }
        if (m.type === 'genEnd') {
          // The worker posts its last snapshot just before genEnd.
          const causes = Array.from(m.popDeathCauses);
          record.genEnds.push({runSerial: m.runSerial, N: m.popN, collisions: m.collisions ?? null, context: m.learningContext?.collisions ?? null,
            contact: causes.filter(c => c === 5).length, alive: m.popStillAlive, fitness: m.fitness, lastSnapshot: record.lastSnapshot,
            // Deaths a crash map counts (C4): a position, and not a car contact.
            mapDeaths: causes.filter((c, i) => c !== 5 && Number.isFinite(m.popDeathXY[i * 2])).length,
            deathXY: Array.from(m.popDeathXY), causes,
            frames: m.frameCount, ...(record.runs[m.runSerial] || {simMs: 0, steps: 0})});
        }
      });
    }
  };
};
const workers = () => page.evaluate(() => window.__simWorkers.map(w => ({...w, begins: w.begins.slice(), genEnds: w.genEnds.slice()})));
const waitGenEnds = (worker, count, timeout = 90000) =>
  page.waitForFunction(([w, n]) => window.__simWorkers[w] && window.__simWorkers[w].genEnds.length >= n, [worker, count], {timeout});
const toggle = () => page.evaluate(() => {
  const box = document.querySelector('[data-rv="exp-collide"]'), status = document.querySelector('[data-rv="exp-collide-status"]');
  return {checked: box.checked, status: status.textContent, on: window.carCollisionsEnabled(), context: window.DriverLearning.context?.collisions ?? null};
});

try {
  await waitForServer(origin, server);
  browser = await chromium.launch({headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  page = await browser.newPage({viewport: {width: 1280, height: 860}});
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  await page.addInitScript(() => {
    localStorage.setItem('vv.multiplayer', JSON.stringify({enabled: false, showDrivers: false}));
    localStorage.setItem('vv.panelCollapsed', '0');   // the control panel is open, so the toggle can be clicked
  });
  await page.addInitScript(spyOnWorkers);

  mark('?collide=1 turns the mode on and ticks the Experiments toggle');
  await page.goto(`${origin}/AI-Car-Racer/?collide=1`);
  await page.waitForFunction(() => window.DriverLearning && document.querySelector('[data-rv="exp-collide"]') && typeof window.setCarCollisions === 'function');
  let t = await toggle();
  assert.deepEqual([t.checked, t.status, t.on], [true, 'on · groups of 8', true]);
  assert.equal(await page.evaluate(() => document.querySelector('[data-rv="experiments"]').open), true, 'the panel opens to show the preset');

  mark('the live worker runs a generation in collision mode');
  await page.evaluate(() => { setN(96); setSeconds(4); setSimSpeed(20); pauseGame(); });
  await waitGenEnds(0, 1);
  let [live] = await workers();
  assert.deepEqual(live.begins[0], {N: 96, collisions: {heatSize: 8}, context: 'solid/k8/rays'});
  let gen = live.genEnds[0];
  assert.equal(gen.context, 'solid/k8/rays', 'the result carries its learning context');
  assert.equal(gen.collisions.heatSize, 8); assert.equal(gen.collisions.heats, 12);
  assert.ok(gen.contact > 0, 'some cars crashed into heat-mates: ' + JSON.stringify(gen));
  assert.equal(gen.collisions.contactDeaths, gen.contact, 'every contact death is cause 5');
  assert.deepEqual(gen.lastSnapshot.collisions, {heatSize: 8, heats: 12});
  assert.equal(gen.lastSnapshot.flags.length, 96);
  assert.equal(gen.lastSnapshot.flags.filter(f => f & 4).length, gen.contact, 'the last snapshot flags the same contact deaths');
  // Rays see cars (C3): the rays read heat-mates, and snapshots say which of the best car's rays did.
  assert.equal(gen.collisions.seeCars, true);
  assert.ok(gen.collisions.sensed > 0 && gen.collisions.carReadings > 0, 'rays read cars: ' + JSON.stringify(gen.collisions));
  assert.equal(gen.lastSnapshot.kinds.length, 7);
  assert.ok(live.carRaySnapshots > 0, 'some snapshot shows the best car\'s rays reading a car');
  t = await toggle(); assert.equal(t.context, 'solid/k8/rays');
  // The metrics HUD counts cause 5 on its own, not as alive.
  const row = await page.evaluate(() => __metricsLog[__metricsLog.length - 1]);
  assert.equal(row.dcContact, gen.contact);
  assert.equal(row.dcAlive + row.dcStalled, gen.alive, 'only cars still in play count as alive or stalled');
  assert.equal(row.dcHeadOn + row.dcSide + row.dcSlide + row.dcStalled + row.dcAlive + row.dcContact + row.dcOther, 96);
  assert.match(await page.evaluate(() => document.getElementById('metrics-hud').textContent), /contact \d+/);

  mark('C4: vector memory in collision mode');
  // Crash maps: every collision-mode map is tagged with the mode and counts
  // no contact death; archived drivers carry the contact statistics; SONA
  // records no step. Normal driving is checked after the toggle below.
  await page.waitForFunction(() => { try { return window.__rvBridge.info().sona.ready; } catch (_) { return false; } }, null, {timeout: 60000});
  const sona = () => page.evaluate(() => { const i = window.__rvBridge.info(); return {open: i.sona.trajectoryOpen, steps: i.sona.trajectorySteps, trajectories: i.sona.trajectories, lora: i.lora.rewardCount}; });
  // The stored crash map of a genEnd is the map of its deaths less the contacts.
  const mapOf = g => page.evaluate(([xy, causes, N]) => {
    const b = window.__rvBridge, vec = window.CrashMapCodec.encodeDeathMap(Float32Array.from(xy), N, canvas.width, canvas.height, Int8Array.from(causes));
    const all = window.CrashMapCodec.encodeDeathMap(Float32Array.from(xy), N, canvas.width, canvas.height);
    const hit = vec && b.recommendCrashLayouts(vec, 1)[0];
    let same = 0; for (let i = 0; i < vec.length; i++) same += vec[i] * all[i];
    return hit ? {similarity: hit.similarity, collisions: hit.collisions, nDeaths: hit.nDeaths, cosineWithContacts: same} : null;
  }, [g.deathXY, g.causes, g.N]);
  const memory = () => page.evaluate(() => {
    const b = window.__rvBridge, xy = new Float32Array(20).fill(400);
    const maps = b.crashMapCount() ? b.recommendCrashLayouts(b.encodeCrashMap(xy, 10), b.crashMapCount()) : [];
    const brains = (b.exportSnapshot().brains || []).map(e => e.meta).filter(m => m && m.learningContext);
    return {maps: maps.map(h => ({collisions: h.collisions, nDeaths: h.nDeaths})),
      drivers: brains.map(m => ({collisions: m.learningContext.collisions, driving: m.driving}))};
  });
  const sonaBefore = await sona();
  [live] = await workers();
  await waitGenEnds(0, live.genEnds.length + 2);
  // No step, no trajectory learned, and no trajectory open (an empty one
  // is closed without learning, so normal driving opens a fresh one).
  assert.deepEqual(await sona(), {open: false, steps: 0, trajectories: sonaBefore.trajectories, lora: sonaBefore.lora}, 'SONA and the LoRA reward learn nothing in collision mode: ' + JSON.stringify(sonaBefore));
  [live] = await workers();
  let mem = await memory();
  const solidMaps = mem.maps.filter(h => h.collisions === 'solid/k8/rays');
  const expectMaps = live.genEnds.filter(g => g.context === 'solid/k8/rays' && g.mapDeaths >= 3);
  assert.equal(solidMaps.length, expectMaps.length, 'one tagged map per collision generation: ' + JSON.stringify(mem.maps));
  assert.ok(solidMaps.length >= 2, 'maps from at least two collision generations: ' + JSON.stringify(mem.maps));
  assert.equal(mem.maps.length, solidMaps.length, 'no untagged map yet');
  console.log('  C4:', JSON.stringify({sona: sonaBefore, maps: solidMaps, contactDeaths: live.genEnds.map(g => g.contact), drivers: mem.drivers.length}));
  // A trajectory with steps from normal driving (as restored after a reload)
  // is pending in collision mode: the memory review pauses, and the next
  // collision generation learns it as normal driving and closes it.
  const review = await page.evaluate(() => {
    const b = window.__rvBridge, v = new Float32Array(512), off = {collisions: 'off'}; v[3] = 1;
    b.beginPhase4Trajectory(v, off); b.addPhase4Step(v, null, 1, off);
    return {done: window.DriverLearning.consolidate(), steps: b.info().sona.trajectorySteps};
  });
  assert.deepEqual(review, {done: false, steps: 1}, 'no review in collision mode');
  [live] = await workers();
  await waitGenEnds(0, live.genEnds.length + 1);
  const settled = await sona();
  // The agent counts a trajectory per processTask: the one step, then the track.
  assert.deepEqual([settled.open, settled.steps, settled.trajectories], [false, 0, sonaBefore.trajectories + 2], 'the normal steps were learned once, then the trajectory closed: ' + JSON.stringify(settled));
  assert.deepEqual(solidMaps.map(h => h.nDeaths).sort((a, b) => a - b), expectMaps.map(g => g.mapDeaths).sort((a, b) => a - b), 'maps count no contact death');
  // The stored vector is the map without the contact deaths (the passive archive, adaptive gates off).
  const lastMap = await mapOf(expectMaps.at(-1));
  assert.ok(lastMap.similarity > 0.9999 && lastMap.collisions === 'solid/k8/rays' && lastMap.nDeaths === expectMaps.at(-1).mapDeaths, JSON.stringify(lastMap));
  assert.ok(lastMap.cosineWithContacts < 0.9999, 'the contacts would change the map: ' + JSON.stringify(lastMap));
  const solidDrivers = mem.drivers.filter(d => d.collisions === 'solid/k8/rays');
  assert.ok(solidDrivers.length > 0, 'a collision-mode driver was archived: ' + JSON.stringify(mem.drivers));
  for (const d of solidDrivers) {
    assert.equal(typeof d.driving.carContact, 'boolean', JSON.stringify(d));
    assert.ok(d.driving.nearCarRate >= 0 && d.driving.nearCarRate <= 1, JSON.stringify(d));
  }

  mark('the A/B baseline worker runs in the same mode');
  await page.evaluate(() => window.__abSetEnabled(true));
  await waitGenEnds(1, 1);
  const [, baseline] = await workers();
  assert.deepEqual(baseline.begins[0], {N: 96, collisions: {heatSize: 8}, context: 'solid/k8/rays'});
  assert.equal(baseline.genEnds[0].context, 'solid/k8/rays');
  assert.ok(baseline.genEnds[0].collisions && baseline.genEnds[0].collisions.heats === 12, 'baseline genEnd: ' + JSON.stringify(baseline.genEnds[0]));
  assert.equal(baseline.genEnds[0].collisions.contactDeaths, baseline.genEnds[0].contact);
  assert.ok(baseline.genEnds[0].collisions.seeCars === true && baseline.genEnds[0].collisions.carReadings > 0, 'the baseline\'s rays read cars too');
  await page.evaluate(() => window.__abSetEnabled(false));

  mark('turning the toggle off starts a normal generation with a normal context');
  [live] = await workers();
  const before = live.begins.length;
  await page.locator('[data-rv="exp-collide"]').click();
  t = await toggle();
  assert.deepEqual([t.checked, t.status, t.on, t.context], [false, 'off', false, 'off']);
  await page.waitForFunction(n => window.__simWorkers[0].begins.length > n, before);
  [live] = await workers();
  assert.deepEqual(live.begins.at(-1), {N: 96, collisions: null, context: 'off'});
  const gens = live.genEnds.length;
  await waitGenEnds(0, gens + 1);
  [live] = await workers();
  gen = live.genEnds.at(-1);
  assert.deepEqual([gen.collisions, gen.context, gen.contact], [null, 'off', 0]);
  assert.equal(gen.lastSnapshot.flags, null, 'no car flags with collisions off');
  assert.equal(gen.lastSnapshot.kinds, null, 'no ray kinds with collisions off');
  assert.equal(await page.evaluate(() => __metricsLog[__metricsLog.length - 1].dcContact), 0);
  // C4: normal driving records SONA steps again, its crash map is untagged,
  // and its drivers carry no contact statistics.
  await waitGenEnds(0, live.genEnds.length + 1);
  const sonaNormal = await sona();
  assert.ok(sonaNormal.open && sonaNormal.steps > 0, 'SONA records normal driving: ' + JSON.stringify(sonaNormal));
  // A collision-mode brain (as from a peer tab) archived in this normal tab
  // adds no step and leaves this tab's trajectory alone.
  const peer = await page.evaluate(() => {
    const b = window.__rvBridge, info = () => { const s = b.info().sona; return [s.trajectoryOpen, s.trajectorySteps, s.trajectories]; };
    const before = info();
    b.archiveBrain(window.__rvUnflatten(new Float32Array(244).fill(0.01)), 1, window.currentTrackVec, 0, [], undefined, undefined,
      {context: {...window.DriverLearning.context, collisions: 'solid/k8/rays'}, styleScore: 0});
    return {before, after: info()};
  });
  assert.deepEqual(peer.after, peer.before, 'a peer\'s collision brain leaves this tab\'s SONA alone: ' + JSON.stringify(peer));
  assert.ok(sonaNormal.lora > sonaBefore.lora, 'the LoRA adapter is rewarded in normal driving: ' + JSON.stringify([sonaBefore, sonaNormal]));
  const normalMap = await mapOf(live.genEnds.at(-1));
  assert.ok(normalMap.similarity > 0.9999 && normalMap.collisions === 'off', JSON.stringify(normalMap));
  mem = await memory();
  assert.ok(mem.maps.some(h => h.collisions === 'off'), 'a normal-driving map: ' + JSON.stringify(mem.maps));
  assert.ok(mem.drivers.some(x => x.collisions === 'off'), 'a normal driver was archived');
  for (const d of mem.drivers.filter(x => x.collisions === 'off')) {
    assert.equal('carContact' in (d.driving || {}), false); assert.equal('nearCarRate' in (d.driving || {}), false);
  }
  // The mode is not a saved physics setting.
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => /collide|collision/i.test(k)).length), 0);

  mark('turning it back on starts a collision generation at once');
  await page.locator('[data-rv="exp-collide"]').click();
  t = await toggle();
  assert.deepEqual([t.checked, t.on], [true, true]);
  await page.waitForFunction(() => window.__simWorkers[0].begins.at(-1).collisions !== null);
  [live] = await workers();
  assert.deepEqual(live.begins.at(-1), {N: 96, collisions: {heatSize: 8}, context: 'solid/k8/rays'});
  // C4: the change of context reviewed normal driving's trajectory and opened
  // a new one; the first collision generation closes it, empty, unlearned.
  await waitGenEnds(0, live.genEnds.length + 1);
  const sonaBack = await sona();
  assert.deepEqual([sonaBack.open, sonaBack.steps], [false, 0], 'no trajectory stays open into collision mode: ' + JSON.stringify(sonaBack));
  assert.ok(sonaBack.trajectories > sonaNormal.trajectories, 'normal driving was reviewed on the way in: ' + JSON.stringify([sonaNormal, sonaBack]));

  mark('while paused, a change of mode starts the new generation paused; the console keeps the toggle in step');
  await page.evaluate(() => { if (!pause) pauseGame(); });
  const pausedAt = (await workers())[0].begins.length;
  await page.evaluate(() => window.setCarCollisions(false));
  t = await toggle();
  assert.deepEqual([t.checked, t.status, t.on, t.context], [false, 'off', false, 'off'], 'the checkbox follows setCarCollisions');
  await page.waitForFunction(n => window.__simWorkers[0].begins.length > n, pausedAt);
  [live] = await workers();
  assert.deepEqual(live.begins.at(-1), {N: 96, collisions: null, context: 'off'});
  assert.equal(await page.evaluate(() => pause), true, 'still paused');
  await page.evaluate(() => window.setCarCollisions(true));
  t = await toggle();
  assert.deepEqual([t.checked, t.context], [true, 'solid/k8/rays']);
  await page.evaluate(() => pauseGame());

  mark('the A/B baseline copies the primary generation, even when the mode changes where no generation starts');
  await page.evaluate(() => { phase = 3; window.setCarCollisions(false); });   // outside training, begin() starts nothing
  const spawned = (await workers()).length;
  await page.evaluate(() => window.__abSetEnabled(true));   // a fresh baseline worker
  await page.waitForFunction(n => window.__simWorkers.length > n && window.__simWorkers.at(-1).begins.length > 0, spawned);
  const b = (await workers()).at(-1).begins.at(-1);
  assert.deepEqual([b.collisions, b.context], [{heatSize: 8}, 'solid/k8/rays'], 'the primary generation still runs solid cars');
  await page.evaluate(() => { window.__abSetEnabled(false); phase = 4; });

  mark('C4: rays that see walls only (carCollisions.seeCars = false, benchmarks only) are labelled solid/k8');
  await page.evaluate(() => {
    window.carCollisions.seeCars = false;   // the stage above turned Solid cars off
    if (!window.carCollisionsEnabled()) window.setCarCollisions(true); else restartDriverLearning();
    if (pause) pauseGame();
  });
  await page.waitForFunction(() => window.__simWorkers[0].begins.at(-1).context === 'solid/k8');
  [live] = await workers();
  assert.deepEqual(live.begins.at(-1), {N: 96, collisions: {heatSize: 8, seeCars: false}, context: 'solid/k8'});
  await waitGenEnds(0, live.genEnds.length + 1);
  [live] = await workers();
  assert.deepEqual([live.genEnds.at(-1).context, live.genEnds.at(-1).collisions.seeCars], ['solid/k8', false]);
  await page.evaluate(() => { window.carCollisions.seeCars = undefined; restartDriverLearning(); if (!pause) pauseGame(); });

  let report = null;
  if (process.env.MEASURE === '1') {
    mark('step cost at N = 500 in the real worker');
    report = {date: new Date().toISOString(), machine: `${os.cpus()[0]?.model || 'unknown'} (${os.cpus().length} threads)`, browser: browser.version(), runs: []};
    // Three modes: collisions off; on in heats of 8 with rays that see walls
    // only (C2); and on in heats of 8 with rays that see cars (C3). 2x: the
    // stride is 1 in every mode. 100x: 16 off, 4 (the cap) on. (C2 also
    // measured heats of 1, where no car can touch another: the three passes
    // alone.) At 2x and 100x the worker times almost every step
    // (it posts a snapshot for each tick with steps, and a 100x tick runs
    // many steps); at 20x it posts every second tick, which times one stride
    // phase more than the others, so 20x is not measured. Each run skips the
    // generation it starts in, then measures two whole generations of 15 s.
    // The cost per step is the worker's own stepping time (snapshot simMs)
    // over the steps those snapshots report.
    for (const track of ['Rectangle', 'Triangle']) {
      for (const speed of [2, 100]) {
        for (const [heats, seeCars] of [[0, false], [8, false], [8, true]]) {
          await page.evaluate(([name, heats, speed, seeCars]) => {
            window.__switchTrackInMemory(name);
            window.carCollisions.heatSize = heats || 8;
            window.carCollisions.seeCars = seeCars ? undefined : false;
            if (window.carCollisionsEnabled() !== !!heats) window.setCarCollisions(!!heats);
            setN(500); setSeconds(15); setSimSpeed(speed);
            restartDriverLearning();
          }, [track, heats, speed, seeCars]);
          await page.waitForFunction(() => window.__simWorkers[0].begins.at(-1).N === 500);
          const start = (await workers())[0].genEnds.length;
          await waitGenEnds(0, start + 3, 300000);
          const gens = (await workers())[0].genEnds.slice(start + 1, start + 3);
          for (const g of gens) {
            assert.equal(g.N, 500); assert.equal(g.collisions ? g.collisions.heatSize : 0, heats);
            if (heats) assert.equal(g.collisions.seeCars, seeCars);
            assert.ok(g.steps > 0.95 * g.frames, 'almost every step was timed: ' + g.steps + ' of ' + g.frames);
          }
          const simMs = gens.reduce((a, g) => a + g.simMs, 0), steps = gens.reduce((a, g) => a + g.steps, 0);
          const sensed = gens.reduce((a, g) => a + (g.collisions?.sensed || 0), 0), carReadings = gens.reduce((a, g) => a + (g.collisions?.carReadings || 0), 0);
          report.runs.push({track, simSpeed: speed, collisions: heats ? `heats of ${heats}, rays see ${seeCars ? 'cars' : 'walls only'}` : 'off', msPerStep: +(simMs / steps).toFixed(3),
            stepsTimed: steps, steps: gens.reduce((a, g) => a + g.frames, 0),
            contactDeathsPerGeneration: gens.map(g => g.contact), stillAlive: gens.map(g => g.alive), fitness: gens.map(g => g.fitness),
            ...(heats && seeCars ? {sensedPerStep: +(sensed / gens.reduce((a, g) => a + g.frames, 0)).toFixed(1), carReadingShare: +(carReadings / Math.max(1, 7 * sensed)).toFixed(4)} : {})});
          console.log(JSON.stringify(report.runs.at(-1)));
        }
      }
    }
    await page.evaluate(() => { window.carCollisions.heatSize = 8; window.carCollisions.seeCars = undefined; });
    await writeFile(`${out}/step-cost.json`, JSON.stringify(report, null, 2) + '\n');
  }

  assert.deepEqual(errors, [], 'page errors');
  mark('screenshot');
  // Best effort: a busy software-GPU runner can take longer than the
  // screenshot timeout, and the picture is only for people to look at.
  await page.evaluate(() => { if (!pause) pauseGame(); });
  await page.screenshot({path: `${out}/collisions.png`, timeout: 60000}).catch(error => console.warn('screenshot skipped:', error.message.split('\n')[0]));
  console.log('collisions browser: ok' + (report ? ` (step cost: ${out}/step-cost.json)` : ''));
} catch (error) {
  console.error('failed at:', stage);
  if (page) await page.screenshot({path: `${out}/failure.png`}).catch(() => {});
  console.error(errors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
