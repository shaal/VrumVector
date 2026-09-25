// Car collisions (task C2) in the real app: ?collide=1 and the Experiments
// toggle, both sim-worker.js instances (live and A/B baseline) running in
// collision mode, cause 5 in the metrics, and the learning context. With
// MEASURE=1 it also measures the real worker's step cost at N = 500 on
// Rectangle and Triangle, collisions off and on, and writes
// test-results/collisions/step-cost.json.
//
//   node tests/collisions-browser.mjs            (MEASURE=1 for the step cost)
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import {chromium} from 'playwright';
import {waitForServer} from './helpers/server-ready.mjs';

const out = 'test-results/collisions'; await mkdir(out, {recursive: true});
const PORT = 8895, origin = `http://127.0.0.1:${PORT}`;
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
        if (message && message.type === 'begin') record.begins.push({N: message.N, collisions: message.collisions ?? null, context: message.learningContext?.collisions ?? null});
        return post(message, transfer);
      };
      this.addEventListener('message', event => {
        const m = event.data;
        if (!m) return;
        if (m.type === 'snapshot') {
          // Stepping time per generation (runSerial), for the step cost.
          const run = record.runs[m.runSerial] ||= {simMs: 0, steps: 0};
          run.simMs += m.simMs; run.steps += m.steps;
          record.lastSnapshot = {N: m.N, collisions: m.collisions ?? null, flags: m.carFlags ? Array.from(m.carFlags) : null};
        }
        if (m.type === 'genEnd') {
          // The worker posts its last snapshot just before genEnd.
          const causes = Array.from(m.popDeathCauses);
          record.genEnds.push({runSerial: m.runSerial, N: m.popN, collisions: m.collisions ?? null, context: m.learningContext?.collisions ?? null,
            contact: causes.filter(c => c === 5).length, alive: m.popStillAlive, fitness: m.fitness, lastSnapshot: record.lastSnapshot,
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
  assert.deepEqual(live.begins[0], {N: 96, collisions: {heatSize: 8}, context: 'solid/k8'});
  let gen = live.genEnds[0];
  assert.equal(gen.context, 'solid/k8', 'the result carries its learning context');
  assert.equal(gen.collisions.heatSize, 8); assert.equal(gen.collisions.heats, 12);
  assert.ok(gen.contact > 0, 'some cars crashed into heat-mates: ' + JSON.stringify(gen));
  assert.equal(gen.collisions.contactDeaths, gen.contact, 'every contact death is cause 5');
  assert.deepEqual(gen.lastSnapshot.collisions, {heatSize: 8, heats: 12});
  assert.equal(gen.lastSnapshot.flags.length, 96);
  assert.equal(gen.lastSnapshot.flags.filter(f => f & 4).length, gen.contact, 'the last snapshot flags the same contact deaths');
  t = await toggle(); assert.equal(t.context, 'solid/k8');
  // The metrics HUD counts cause 5 on its own, not as alive.
  const row = await page.evaluate(() => __metricsLog[__metricsLog.length - 1]);
  assert.equal(row.dcContact, gen.contact);
  assert.equal(row.dcAlive + row.dcStalled, gen.alive, 'only cars still in play count as alive or stalled');
  assert.equal(row.dcHeadOn + row.dcSide + row.dcSlide + row.dcStalled + row.dcAlive + row.dcContact + row.dcOther, 96);
  assert.match(await page.evaluate(() => document.getElementById('metrics-hud').textContent), /contact \d+/);

  mark('the A/B baseline worker runs in the same mode');
  await page.evaluate(() => window.__abSetEnabled(true));
  await waitGenEnds(1, 1);
  const [, baseline] = await workers();
  assert.deepEqual(baseline.begins[0], {N: 96, collisions: {heatSize: 8}, context: 'solid/k8'});
  assert.equal(baseline.genEnds[0].context, 'solid/k8');
  assert.ok(baseline.genEnds[0].collisions && baseline.genEnds[0].collisions.heats === 12, 'baseline genEnd: ' + JSON.stringify(baseline.genEnds[0]));
  assert.equal(baseline.genEnds[0].collisions.contactDeaths, baseline.genEnds[0].contact);
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
  assert.equal(await page.evaluate(() => __metricsLog[__metricsLog.length - 1].dcContact), 0);
  // The mode is not a saved physics setting.
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => /collide|collision/i.test(k)).length), 0);

  mark('turning it back on starts a collision generation at once');
  await page.locator('[data-rv="exp-collide"]').click();
  t = await toggle();
  assert.deepEqual([t.checked, t.on], [true, true]);
  await page.waitForFunction(() => window.__simWorkers[0].begins.at(-1).collisions !== null);
  [live] = await workers();
  assert.deepEqual(live.begins.at(-1), {N: 96, collisions: {heatSize: 8}, context: 'solid/k8'});

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
  assert.deepEqual([t.checked, t.context], [true, 'solid/k8']);
  await page.evaluate(() => pauseGame());

  mark('the A/B baseline copies the primary generation, even when the mode changes where no generation starts');
  await page.evaluate(() => { phase = 3; window.setCarCollisions(false); });   // outside training, begin() starts nothing
  const spawned = (await workers()).length;
  await page.evaluate(() => window.__abSetEnabled(true));   // a fresh baseline worker
  await page.waitForFunction(n => window.__simWorkers.length > n && window.__simWorkers.at(-1).begins.length > 0, spawned);
  const b = (await workers()).at(-1).begins.at(-1);
  assert.deepEqual([b.collisions, b.context], [{heatSize: 8}, 'solid/k8'], 'the primary generation still runs solid cars');
  await page.evaluate(() => { window.__abSetEnabled(false); phase = 4; });

  let report = null;
  if (process.env.MEASURE === '1') {
    mark('step cost at N = 500 in the real worker');
    report = {date: new Date().toISOString(), machine: `${os.cpus()[0]?.model || 'unknown'} (${os.cpus().length} threads)`, browser: browser.version(), runs: []};
    // Three modes: collisions off; on in heats of 8; and on in heats of 1,
    // where no car can touch another, so it costs only the three passes and
    // (at 100x) the stride cap. 2x: the stride is 1 in every mode. 100x: 16
    // off, 4 (the cap) on. At 2x and 100x the worker times almost every step
    // (it posts a snapshot for each tick with steps, and a 100x tick runs
    // many steps); at 20x it posts every second tick, which times one stride
    // phase more than the others, so 20x is not measured. Each run skips the
    // generation it starts in, then measures two whole generations of 15 s.
    // The cost per step is the worker's own stepping time (snapshot simMs)
    // over the steps those snapshots report.
    for (const track of ['Rectangle', 'Triangle']) {
      for (const speed of [2, 100]) {
        for (const heats of [0, 8, 1]) {
          await page.evaluate(([name, heats, speed]) => {
            window.__switchTrackInMemory(name);
            window.carCollisions.heatSize = heats || 8;
            if (window.carCollisionsEnabled() !== !!heats) window.setCarCollisions(!!heats);
            setN(500); setSeconds(15); setSimSpeed(speed);
            restartDriverLearning();
          }, [track, heats, speed]);
          await page.waitForFunction(() => window.__simWorkers[0].begins.at(-1).N === 500);
          const start = (await workers())[0].genEnds.length;
          await waitGenEnds(0, start + 3, 300000);
          const gens = (await workers())[0].genEnds.slice(start + 1, start + 3);
          for (const g of gens) {
            assert.equal(g.N, 500); assert.equal(g.collisions ? g.collisions.heatSize : 0, heats);
            assert.ok(g.steps > 0.95 * g.frames, 'almost every step was timed: ' + g.steps + ' of ' + g.frames);
          }
          const simMs = gens.reduce((a, g) => a + g.simMs, 0), steps = gens.reduce((a, g) => a + g.steps, 0);
          report.runs.push({track, simSpeed: speed, collisions: heats ? 'heats of ' + heats : 'off', msPerStep: +(simMs / steps).toFixed(3),
            stepsTimed: steps, steps: gens.reduce((a, g) => a + g.frames, 0),
            contactDeathsPerGeneration: gens.map(g => g.contact), stillAlive: gens.map(g => g.alive), fitness: gens.map(g => g.fitness)});
          console.log(JSON.stringify(report.runs.at(-1)));
        }
      }
    }
    await page.evaluate(() => { window.carCollisions.heatSize = 8; });
    await writeFile(`${out}/step-cost.json`, JSON.stringify(report, null, 2) + '\n');
  }

  assert.deepEqual(errors, [], 'page errors');
  await page.screenshot({path: `${out}/collisions.png`});
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
