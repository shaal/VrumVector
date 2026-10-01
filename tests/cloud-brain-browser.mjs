// The Shared brain mode in the app (CB3 of docs/plan/cloud-brain.md), in
// Chromium:
// 1. the Memory control: hidden with no service; with one, what is sent is
//    asked before switching, and switching reloads into shared mode;
// 2. shared mode against the fake service (tests/helpers/cloud-brain-fake.mjs):
//    a pool pulled on start seeds the first generation; trained brains and
//    offspring feedback are pushed; offline shows the banner and recovers;
// 3. isolation: a shared session leaves this browser's own IndexedDB as it was;
// 4. two browser profiles on the real local service (cloud-brain/, under
//    wrangler dev): B, fresh, gets A's brains among its first seeds, and B's
//    offspring feedback reaches A's pool (A's own reports about its own
//    brains are not evidence, CB4), and A's brains are served with a
//    neutral fitness until two others corroborate them;
// 5. a verified lap (X1), on the real service: a brain that drove a lap on
//    the page's track is archived and sent, the service drives it on the
//    page's walls and gates (the same lap as the game's own simulation), its
//    fitness is then trusted in its context, and the Memory panel shows it
//    on the leaderboard;
// 6. race the cloud champion (X3): that brain, pulled back, is the
//    champion; the Memory panel's button starts its ghost, which drives the
//    same lap in the page, and stops it;
// 7. everyone's crash map (X4): a crash map A archives (with its gate
//    layout) is sent; B's next pull brings it back: the Memory panel's
//    toggle shows it under the cars, and adaptive gates get the layout.
//
//   npm run test:cloud-brain:browser     (needs the cloud-brain toolchain for part 4)
//   BROWSER=firefox (or webkit) runs it in that engine instead of Chromium.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as playwright from 'playwright';
import {waitForServer} from './helpers/server-ready.mjs';
import {startStaticServer} from './helpers/static-server.mjs';
import {createFakeCloudBrain, routeTo} from './helpers/cloud-brain-fake.mjs';
import {startDev} from './cloud-brain-dev.mjs';
import {DISCLOSURE, ARRIVAL_DISCLOSURE} from '../AI-Car-Racer/cloud/ui.js';
import * as wire from '../AI-Car-Racer/cloud/wire.js';

const out = 'test-results/cloud-brain'; await mkdir(out, {recursive: true});
const server = startStaticServer('8876');
const origin = 'http://127.0.0.1:8876';
const FAKE = 'http://127.0.0.1:8875', REAL_PORT = 8874, REAL = `http://127.0.0.1:${REAL_PORT}`;
let browser, stage = 'boot', dev = null, persist = null;
const VIEW = {viewport: {width: 1120, height: 800}};
const errors = [], report = {};

// A page of the app. A link that opens shared mode asks first (the answer:
// `consent`, yes by default).
async function openPage(context, {endpoint, fake = null, query = '', consent = true}) {
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', e => {
    // Declining a shared link reloads the page while it still loads its
    // Wasm: WebKit then rejects those fetches in the page being left ("Load
    // failed", or "<url> due to access control checks."). Counted, not an
    // error of the page's.
    if (stage === 'a link to shared mode' && /^(Load failed|.* due to access control checks\.)$/.test(e.message)) { report.loadsCut = (report.loadsCut || 0) + 1; return; }
    errors.push(`${stage}: ${e.message}`);
  });
  page.on('console', m => { if (process.env.DEBUG_CONSOLE && /cloud|rror/.test(m.text())) console.error('[console]', stage, m.text()); });
  if (query.includes('brain=shared')) page.once('dialog', d => (consent ? d.accept() : d.dismiss()));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin || url.origin === REAL ? route.continue() : route.abort();
  });
  await page.route('**/cloud/config.json', route => route.fulfill({json: {endpoint}}));
  if (fake) await page.route(`${FAKE}/**`, routeTo(fake, origin));
  await page.addInitScript(() => localStorage.setItem('vv.multiplayer', JSON.stringify({enabled: false})));
  await page.goto(`${origin}/AI-Car-Racer/${query}`);
  await page.waitForFunction(() => window.DriverLearning && window.__rvBridge?.info?.().ready, {}, {timeout: 90000});
  await page.evaluate(() => window.__rvBridge.ready());
  return page;
}
// The Memory row, in the control panel (opened as a user opens it).
const memoryRow = page => page.locator('[data-rv="memory"]');
const openPanel = async page => {
  if (await page.evaluate(() => document.getElementById('fullDisplay').classList.contains('panel-collapsed'))) await page.locator('#panelToggle').click();
};
// Choose a memory and press Switch (the radios alone change nothing).
const choose = async (page, value) => {
  await page.locator(`[data-rv="memory-${value}"]`).click();
  await page.locator('[data-rv="memory-switch"]').click();
};
// Starts training and returns the first generation's seed sources (read
// while generation 0 runs: each generation's start replaces them).
const firstSeeds = async page => {
  // The same settings as train(): the seconds are part of the learning context.
  await page.evaluate(() => { setN(16); setSeconds(4); setSimSpeed(5); });
  await page.locator('#ai-drive-toggle').click();
  await page.waitForFunction(() => window.__rvBridge.info().seedSources?.generation === 0 && window.__rvBridge.info().seedSources.total > 0, {}, {polling: 'raf', timeout: 60000});
  return page.evaluate(() => window.__rvBridge.info().seedSources);
};
// n more generations of AI training (started as a user starts it).
const train = async (page, n) => {
  const start = await page.evaluate(() => window.DriverLearning.coach.rounds);
  if (!(await page.evaluate(() => !!playerCar2?.aiDriving))) {
    await page.evaluate(() => { setN(16); setSeconds(4); setSimSpeed(5); });
    await page.locator('#ai-drive-toggle').click();
  }
  await page.waitForFunction(target => window.DriverLearning.coach.rounds >= target, start + n, {timeout: 240000});
};
// Every object store of an IndexedDB database, as JSON (typed arrays as lists).
const dump = (page, name) => page.evaluate(async name => {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const all = {};
  for (const store of Array.from(db.objectStoreNames).sort()) {
    all[store] = await new Promise((resolve, reject) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }
  db.close();
  return JSON.stringify(all, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
}, name);

try {
  await waitForServer(origin, server);
  const engine = process.env.BROWSER || 'chromium';
  browser = await playwright[engine].launch(engine === 'chromium' ? {headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']} : {headless: true});
  report.engine = engine;

  // ─── 1. the Memory control ──────────────────────────────────────────────
  stage = 'no service';
  {
    const context = await browser.newContext(VIEW);
    const page = await openPage(context, {endpoint: null});
    await page.waitForTimeout(1500);
    assert.equal(await memoryRow(page).count(), 0, 'hidden with no service');
    assert.equal(await page.evaluate(() => window.__rvBridge.brainMode()), 'local');
    await context.close();
  }
  stage = 'disclosure';
  {
    const fake = createFakeCloudBrain();
    const context = await browser.newContext(VIEW);
    const page = await openPage(context, {endpoint: FAKE, fake});
    await openPanel(page);
    await memoryRow(page).waitFor();
    assert.equal(await page.locator('[data-rv="memory-local"]').isChecked(), true);
    const dialogs = [];
    // A radio alone (arrow keys move through them) switches nothing.
    await page.locator('[data-rv="memory-shared"]').click();
    assert.equal(await page.locator('[data-rv="memory-switch"]').isVisible(), true);
    assert.equal(dialogs.length, 0);
    page.once('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await page.locator('[data-rv="memory-switch"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rv="memory-local"]').checked);
    assert.deepEqual(dialogs, [DISCLOSURE], 'what is sent, asked first');
    assert.equal(await page.evaluate(() => localStorage.getItem('vv.cloudBrain')), null, 'dismissed: nothing saved');
    page.once('dialog', d => d.accept());
    await Promise.all([page.waitForEvent('load'), choose(page, 'shared')]);
    await page.waitForFunction(() => window.__rvBridge?.info?.().ready, {}, {timeout: 90000});
    assert.equal(await page.evaluate(() => window.__rvBridge.brainMode()), 'shared', 'reloaded into shared mode');
    await openPanel(page);
    await memoryRow(page).waitFor();
    assert.equal(await page.locator('[data-rv="memory-shared"]').isChecked(), true);
    // And back: no question going local.
    await Promise.all([page.waitForEvent('load'), choose(page, 'local')]);
    await page.waitForFunction(() => window.__rvBridge?.info?.().ready, {}, {timeout: 90000});
    assert.equal(await page.evaluate(() => window.__rvBridge.brainMode()), 'local');
    await context.close();
  }
  stage = 'a link to shared mode';
  {
    // Declined: back to this browser's memory, nothing sent.
    const fake = createFakeCloudBrain();
    let context = await browser.newContext(VIEW);
    const asked = [];
    context.on('page', p => p.on('dialog', d => asked.push(d.message())));
    let page = await openPage(context, {endpoint: FAKE, fake, query: '?brain=shared', consent: false});
    await page.waitForFunction(() => window.__rvBridge?.brainMode?.() === 'local' && window.__rvBridge.info().ready, {}, {timeout: 90000});
    assert.deepEqual(asked, [ARRIVAL_DISCLOSURE]);
    assert.doesNotMatch(page.url(), /brain=/, 'the link does not decide again');
    assert.equal(fake.requests.filter(r => r.path !== '/v1/stats').length, 0, 'nothing sent');
    await context.close();
    // Accepted, then switched off from the control: it stays off (the link
    // is gone from the address).
    context = await browser.newContext(VIEW);
    page = await openPage(context, {endpoint: FAKE, fake, query: '?brain=shared'});
    assert.equal(await page.evaluate(() => window.__rvBridge.brainMode()), 'shared');
    assert.doesNotMatch(page.url(), /brain=/);
    await openPanel(page);
    await Promise.all([page.waitForEvent('load'), choose(page, 'local')]);
    await page.waitForFunction(() => window.__rvBridge?.info?.().ready, {}, {timeout: 90000});
    assert.equal(await page.evaluate(() => window.__rvBridge.brainMode()), 'local');
    await page.reload();
    await page.waitForFunction(() => window.__rvBridge?.info?.().ready, {}, {timeout: 90000});
    assert.equal(await page.evaluate(() => window.__rvBridge.brainMode()), 'local', 'still local after a reload');
    await context.close();
  }

  // ─── 2 and 3. shared mode on the fake, and isolation ────────────────────
  stage = 'shared on the fake';
  {
    const fake = createFakeCloudBrain();
    // Six brains someone else trained (no track the page knows: the fake
    // answers with every brain).
    await fake.seed(Array.from({length: 6}, (_, i) => ({
      vector: Float32Array.from({length: wire.DIMS.brain}, (_, j) => Math.sin(j * 0.3 + i) * 0.6), fitness: 20 + i,
      track: null, meta: {generation: 9, source: 'evolved'},
    })));
    const seeded = await Promise.all(Array.from({length: 6}, (_, i) => wire.brainId(Float32Array.from({length: wire.DIMS.brain}, (_, j) => Math.sin(j * 0.3 + i) * 0.6))));
    const context = await browser.newContext(VIEW);
    // This browser's own memory first: two local generations.
    let page = await openPage(context, {endpoint: FAKE, fake});
    await train(page, 2);
    const championsBefore = await page.evaluate(() => localStorage.getItem('vv.driverChampions'));
    await page.close();
    page = await openPage(context, {endpoint: FAKE, fake, query: '?brain=shared'});
    const localBefore = await dump(page, 'rv_car_learning');
    assert.ok(localBefore.length > 1000, 'the local memory has brains');
    // The pull on start fills the replica.
    await page.waitForFunction(() => window.__rvCloud?.accepted >= 6, {}, {timeout: 60000});
    const replica = await page.evaluate(() => window.__rvBridge.exportSnapshot().brains.map(b => b.meta.source));
    assert.ok(replica.filter(s => s === 'cloud').length >= 6, 'pulled brains are tagged cloud');
    await page.waitForFunction(() => /online/.test(document.querySelector('[data-rv="memory-status"]')?.textContent || ''));
    report.statusOnline = await page.locator('[data-rv="memory-status"]').textContent();
    // The first generation (0) is seeded from the pulled pool: the replica
    // held nothing else yet.
    const sources = await firstSeeds(page);
    assert.ok(sources.generation === 0 && sources.archive_recall > 0, JSON.stringify(sources));
    report.seedSources = sources;
    await train(page, 3);
    // Trained brains and offspring feedback are pushed. (A generation
    // archives a brain only when it beats what this page holds: after the
    // pulled pool's claims, 3 generations sometimes archive none; a few more.)
    const flushed = () => page.evaluate(async () => { await window.__rvCloud.settled(); await window.__rvCloud.client.flush(); });
    const pushedSoFar = () => fake.requests.filter(r => r.path === '/v1/contribute').flatMap(r => JSON.parse(r.body).brains).length;
    await flushed();
    for (let extra = 0; extra < 6 && !pushedSoFar(); extra++) { await train(page, 1); await flushed(); }
    const contributed = fake.requests.filter(r => r.path === '/v1/contribute').map(r => JSON.parse(r.body));
    const pushed = contributed.flatMap(b => b.brains);
    assert.ok(pushed.length >= 1, 'brains pushed: ' + JSON.stringify(fake.requests.map(r => r.path)));
    assert.ok(pushed.every(b => b.meta?.learning?.context && b.meta.source), 'with their context and source');
    const rows = contributed.flatMap(b => b.feedback);
    assert.ok(rows.length >= 1, 'offspring feedback pushed');
    assert.ok(seeded.some(id => [...fake.brains.get(id).feedback.values()].some(f => f.count > 0)), 'about the pulled brains');
    report.fake = {brains: fake.brains.size, contributions: contributed.length, pushedBrains: pushed.length, feedbackRows: rows.length};
    // The six were found on no near track, so the replica kept them without
    // one (unless training re-archived one on this track as an elite); a
    // pull that finds them on this track files them all here.
    const trackOf = () => page.evaluate(async ids => {
      const {brainId} = await import('./cloud/wire.js'), out = {};
      for (const b of window.__rvBridge.exportSnapshot().brains) {
        const id = await brainId(Float32Array.from(b.flat));
        if (ids.includes(id)) out[id] = b.meta.trackId || null;
      }
      return out;
    }, seeded);
    const before = await trackOf();
    assert.ok(Object.keys(before).length === 6 && Object.values(before).some(t => t === null), JSON.stringify(before));
    const here = await wire.brainId((await import('../AI-Car-Racer/cloud/session.js')).unit(Float32Array.from(await page.evaluate(() => Array.from(window.currentTrackVec)))));
    for (const id of seeded) fake.brains.get(id).track = here;
    await page.evaluate(() => window.__rvCloud.maybePull({force: true}));
    const after = await trackOf();
    assert.ok(Object.values(after).every(t => t !== null), 'filed on this track once found on it: ' + JSON.stringify(after));
    // CB4: a pulled brain takes the service's trusted fitness at every pull,
    // until this tab measures it (archives it again).
    const fitnessOf = () => page.evaluate(async ids => {
      const {brainId} = await import('./cloud/wire.js'), out = {};
      for (const b of window.__rvBridge.exportSnapshot().brains) {
        const id = await brainId(Float32Array.from(b.flat));
        if (ids.includes(id)) out[id] = {fitness: b.meta.fitness, served: b.meta.cloudFitness ?? null};
      }
      return out;
    }, seeded);
    const servedBefore = await fitnessOf();
    const unmeasured = seeded.filter(id => servedBefore[id].served !== null);
    assert.ok(unmeasured.length >= 1, JSON.stringify(servedBefore));
    for (const id of seeded) fake.brains.get(id).fitness = 77;
    await page.evaluate(() => window.__rvCloud.maybePull({force: true}));
    const servedAfter = await fitnessOf();
    for (const id of seeded) {
      const expect = unmeasured.includes(id) ? {fitness: 77, served: 77} : servedBefore[id];
      assert.deepEqual(servedAfter[id], expect, `${id}: ${JSON.stringify({before: servedBefore[id], after: servedAfter[id]})}`);
    }
    // Its offspring here are not measured against the served fitness (0
    // before corroboration would make every outcome +1): the first only sets
    // a baseline, as in another context.
    const firstOutcome = await page.evaluate(() => {
      const b = window.__rvBridge, ctx = b.info().learning.context;
      const vector = Float32Array.from({length: 244}, (_, i) => Math.cos(i * 0.21) * 0.5);
      b.acceptCloudPool([{vector, fitness: 0, meta: {generation: 1, learning: {context: ctx, styleScore: 0}}, trackSim: 1,
        feedback: {weight: 0, count: 0, contributors: 0}}], window.currentTrackVec, ctx);
      const row = b.exportSnapshot().brains.find(x => x.flat.every((v, i) => v === vector[i]));
      b.observeOffspring([{id: row.id, meanFitness: 50, count: 3}], ctx);
      return {served: row.meta.cloudFitness, track: ctx?.track || '', feedback: b.info().learning.feedback};
    });
    assert.ok(firstOutcome.track, 'a context with a track key (an exact match is possible)');
    assert.equal(firstOutcome.served, 0);
    assert.deepEqual(firstOutcome.feedback.map(f => f.feedback), [null], JSON.stringify(firstOutcome));
    // Pulled in its own context C, then measured here in context D (archived
    // again): in D its outcomes are measured against this tab's fitness; in
    // C still not against the served one, which a later pull refreshes.
    const measured = await page.evaluate(async () => {
      const b = window.__rvBridge, d = b.info().learning.context, c = {...d, profile: d.profile === 'calm' ? 'careful' : 'calm'};
      const {unflatten} = await import('./brainCodec.js');
      const vector = Float32Array.from({length: 244}, (_, i) => Math.sin(i * 0.17) * 0.45);
      const pull = fitness => b.acceptCloudPool([{vector, fitness, meta: {generation: 1, learning: {context: c, styleScore: 0}}, trackSim: 1,
        feedback: {weight: 0, count: 0, contributors: 0}}], window.currentTrackVec, d);
      const held = () => b.exportSnapshot().brains.find(x => x.flat.every((v, i) => v === vector[i]));
      pull(0);
      b.archiveBrain(unflatten(vector), 40, window.currentTrackVec, 2, [], undefined, undefined, {context: d, styleScore: 0});
      b.observeOffspring([{id: held().id, meanFitness: 50, count: 3}], c);
      const inC = b.info().learning.feedback.map(f => f.feedback);
      b.observeOffspring([{id: held().id, meanFitness: 50, count: 3}], d);
      const inD = b.info().learning.feedback.map(f => f.feedback);
      pull(7);
      const meta = held().meta;
      return {inC, inD, fitness: meta.fitness, mark: meta.cloudFitness ?? null,
        rows: meta.evaluations.map(r => [r.learningContext?.profile, r.fitness, r.cloudFitness ?? null]).sort()};
    });
    assert.deepEqual(measured.inC, [null], JSON.stringify(measured));
    assert.deepEqual(measured.inD, [0.25], JSON.stringify(measured));
    assert.equal(measured.fitness, 40, 'measured here: not refreshed');
    assert.equal(measured.mark, null);
    const [calmOrCareful] = measured.rows.filter(r => r[2] !== null);
    assert.deepEqual(calmOrCareful.slice(1), [7, 7], 'the evaluation it was pulled in is refreshed: ' + JSON.stringify(measured.rows));
    assert.equal(measured.rows.filter(r => r[2] === null).map(r => r[1]).join(), '40', 'this tab\'s own evaluation is not');
    // Offline: the banner, and the outbox keeps what waits.
    fake.down = 'offline';
    await page.evaluate(async () => {
      const s = window.__rvCloud;
      s.client.enqueueFeedback([{id: 'brain_' + '0'.repeat(32), context: {}, meanFitness: 1, count: 1}]);
      await s.client.flush();
    });
    await page.waitForFunction(() => document.querySelector('[data-rv="memory-status"]')?.classList.contains('rv-memory-offline'));
    report.statusOffline = await page.locator('[data-rv="memory-status"]').textContent();
    assert.match(report.statusOffline, /offline — training from the last copy/);
    assert.match(await page.locator('[data-rv="memory-text"]').textContent(), /^Shared brain offline/, 'the announced part');
    assert.doesNotMatch(await page.locator('[data-rv="memory-text"]').textContent(), /retrying/, 'the countdown is not announced');
    assert.equal(await page.locator('[data-rv="memory-pill"]').textContent(), 'Shared brain offline', 'seen with the panel collapsed too');
    fake.down = null;
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__rvCloud.client.flush());
    await page.waitForFunction(() => !document.querySelector('[data-rv="memory-status"]').classList.contains('rv-memory-offline'));
    assert.equal(await page.locator('[data-rv="memory-pill"]').count(), 0);
    // Isolation: the shared session did not touch this browser's memory.
    const localAfter = await dump(page, 'rv_car_learning');
    assert.equal(localAfter, localBefore, 'the local IndexedDB is unchanged');
    const names = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).sort());
    assert.ok(names.includes('rv_car_learning') && names.includes('rv_car_learning_shared'), names.join());
    await page.screenshot({path: `${out}/shared-fake.png`});
    const sharedOnly = await page.evaluate(() => window.__rvBridge.exportSnapshot().brains.map(b => b.flat.join(',')));
    // Back to this browser's memory: its training takes nothing from the
    // shared session (not its champion, not its saved car, not its brains).
    await openPanel(page);
    await Promise.all([page.waitForEvent('load'), choose(page, 'local')]);
    await page.waitForFunction(() => window.__rvBridge?.info?.().ready && window.__rvBridge.brainMode() === 'local', {}, {timeout: 90000});
    assert.equal(await page.evaluate(() => localStorage.getItem('vv.driverChampions')), championsBefore, 'the local champions are as they were');
    const localBrains = new Set(JSON.parse(localBefore).brains_10_16_4.map(b => Array.from(b.vector ?? b.vec ?? []).join(',')));
    await train(page, 1);
    const leaked = await page.evaluate(only => window.__rvBridge.exportSnapshot().brains.filter(b => only.includes(b.flat.join(','))).length,
      sharedOnly.filter(v => !localBrains.has(v)));
    assert.equal(leaked, 0, 'no shared brain in the local memory');
    await context.close();
  }

  stage = 'a clone of your driving is sent as one';
  {
    // One car, a clone of "your driving" in the protected slot (no champion
    // yet): the archived elite is the clone, and it is sent tagged so.
    const fake = createFakeCloudBrain();
    const context = await browser.newContext(VIEW);
    const page = await openPage(context, {endpoint: FAKE, fake, query: '?brain=shared'});
    await page.evaluate(() => { setN(1); setSeconds(2); setSimSpeed(5); });
    const offered = await page.evaluate(async () => {
      const {offerKey, demonstrationSeed} = await import('./learning/demonstrationSeed.js');
      // The context the run will have (main.js prepares it at the start).
      const ctx = window.DriverLearning.prepare({road, maxSpeed, traction, seconds, collisions: null}), vector = Float32Array.from({length: 244}, (_, i) => Math.sin(i * 0.11) * 0.4);
      window.DriverLearning.setDemonstration({key: offerKey(ctx), seed: demonstrationSeed(vector), seeding: true,
        report: {recordings: 1, seconds: 10, heldOut: 0.8, lag: 0, maxAbsWeight: 0.4, leavesStart: true, trainedAt: Date.now()}});
      return !!window.DriverLearning.demonstrationSeedFor(ctx);
    });
    assert.ok(offered, 'the clone is offered on this context');
    await page.locator('#ai-drive-toggle').click();
    await page.waitForFunction(() => window.DriverLearning.coach.rounds >= 1, {}, {timeout: 120000});
    await page.evaluate(async () => { await window.__rvCloud.settled(); await window.__rvCloud.client.flush(); });
    const local = await page.evaluate(() => window.__rvBridge.exportSnapshot().brains.map(b => b.meta.source || null));
    assert.ok(local.includes('demonstration'), JSON.stringify(local));
    const sent = fake.requests.filter(r => r.path === '/v1/contribute').flatMap(r => JSON.parse(r.body).brains).map(b => b.meta?.source);
    assert.ok(sent.includes('demonstration'), JSON.stringify(sent));
    report.demonstration = {archived: local, sent};
    await context.close();
  }

  // ─── 4. two profiles on the real local service ──────────────────────────
  stage = 'real service';
  {
    persist = await mkdtemp(path.join(os.tmpdir(), 'cloud-brain-browser-'));
    dev = await startDev({port: REAL_PORT, persist, vars: {ALLOW_LOCAL: 'true'}});
    const [contextA, contextB] = [await browser.newContext(VIEW), await browser.newContext(VIEW)];
    const a = await openPage(contextA, {endpoint: REAL, query: '?brain=shared'});
    await train(a, 3);
    await a.evaluate(async () => { await window.__rvCloud.settled(); await window.__rvCloud.client.flush(); });
    const statsA = await (await fetch(`${REAL}/v1/stats`, {headers: {Origin: origin}})).json();
    assert.ok(statsA.brains >= 1, JSON.stringify(statsA));
    // The leaderboard is read for the page's track (nothing verified yet).
    await a.waitForFunction(() => /No verified laps on this track yet/.test(document.querySelector('[data-rv="memory-board"]')?.textContent || ''));
    // B, fresh: its first generation is seeded from A's brains.
    const b = await openPage(contextB, {endpoint: REAL, query: '?brain=shared'});
    await b.waitForFunction(() => window.__rvCloud?.accepted >= 1, {}, {timeout: 60000});
    const seedsB = await firstSeeds(b);
    assert.ok(seedsB.generation === 0 && seedsB.archive_recall > 0, JSON.stringify(seedsB));
    // B's offspring feedback reaches A's pool. A's own reports about its own
    // brains are not evidence (CB4): before B, nobody's are counted.
    const contributorsBefore = await a.evaluate(async () => {
      const {unit} = await import('./cloud/session.js');
      const pool = await window.__rvCloud.client.recall({trackVec: unit(window.currentTrackVec), context: window.__rvBridge.info().learning.context || {}, k: 50});
      return Math.max(0, ...pool.map(p => p.feedback.contributors));
    });
    assert.equal(contributorsBefore, 0, 'only A so far, and A does not count for its own brains');
    await train(b, 3);
    await b.evaluate(async () => { await window.__rvCloud.settled(); await window.__rvCloud.client.flush(); });
    const poolA = await a.evaluate(async () => {
      const s = window.__rvCloud;
      const pool = await s.client.recall({trackVec: (await import('./cloud/session.js')).unit(window.currentTrackVec),
        context: window.__rvBridge.info().learning.context || {}, k: 50});
      return pool.map(p => ({fitness: p.fitness, feedback: p.feedback}));
    });
    assert.ok(poolA.some(p => p.feedback.contributors >= 1), JSON.stringify(poolA.slice(0, 5)));
    // One other contributor corroborates nothing yet: every claim is served as at most 0.
    assert.ok(poolA.every(p => p.fitness <= 0), JSON.stringify(poolA.slice(0, 5)));
    report.real = {statsA, seedsB, entriesWithFeedback: poolA.filter(p => p.feedback.contributors >= 1).length, pool: poolA.length};

    // ─── 5. a verified lap (X1) ──────────────────────────────────────────
    stage = 'a verified lap';
    // A brain the game's own learning loop evolved on the Rectangle, and the
    // lap the game's simulation drove with it (tests/fixtures/cloud-brain-sim).
    const traces = JSON.parse(await readFile('tests/fixtures/cloud-brain-sim/traces.json', 'utf8'));
    const lap = traces.cases.find(c => c.track === 'Rectangle' && c.outcome.laps > 0 && c.settings.seconds === 20 && c.settings.profile === 'balanced');
    assert.ok(lap && lap.settings.maxSpeed === 15 && lap.settings.traction === 0.5, 'a lapping case in the page\'s physics');
    const run = await a.evaluate(async ({vector, fitness}) => {
      const s = window.__rvCloud, {decodeF32} = await import('./cloud/wire.js'), {cleanContext} = await import('./learning/policy.js');
      const {geometryKey} = await import('./graphics/state.js');
      const ctx = cleanContext({profile: 'balanced', track: geometryKey(road), maxSpeed: 15, traction: 0.5, seconds: 20, collisions: null});
      const {unflatten} = await import('./brainCodec.js');
      s.verifications = [];
      // Archived as main.js archives an elite that drove a lap: the bridge's
      // hook queues it for a verification.
      window.__rvBridge.archiveBrain(unflatten(decodeF32(vector, 244)), fitness, window.currentTrackVec, 40, [], 16.6, undefined, {context: ctx, styleScore: 0});
      await s.settled();
      const waiting = s.verifications.length;
      // Sent, then verified: a backoff (A and B share one address and its
      // limits) or a busy service only delays it.
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let answer = null;
      for (let i = 0; i < 60 && !answer; i++) {
        while (!s.client.canTry('send')) await sleep(250);
        answer = await s.tick();
        if (!answer) await sleep(2000);
      }
      const pool = await s.client.recall({trackVec: (await import('./cloud/session.js')).unit(window.currentTrackVec), context: ctx, k: 50});
      return {answer, waiting, key: ctx.track, pageMaxSpeed: maxSpeed, pageTraction: traction,
        served: pool?.find(p => p.id === answer?.id)?.fitness ?? null, board: s.board,
        client: {status: s.client.status, backoff: s.client.backoff, pending: s.client.pending(), left: s.verifications.length}};
    }, {vector: lap.vector, fitness: 30});
    assert.equal(run.key, traces.tracks.Rectangle.key, 'the page\'s default track is the fixture\'s Rectangle');
    assert.equal(run.waiting, 1, 'queued for a verification');
    assert.ok(run.answer?.ok && run.answer.matched, JSON.stringify({answer: run.answer, client: run.client}));
    assert.deepEqual({fitness: run.answer.fitness, laps: run.answer.laps, lapFrames: run.answer.lapFrames, crashedAt: run.answer.crashedAt, frames: run.answer.frames},
      lap.outcome, 'the service drove the lap the game drove');
    assert.equal(run.served, lap.outcome.fitness, 'verified: its fitness is trusted, not quarantined (it claimed 30)');
    assert.ok(run.pageMaxSpeed === 15 && run.pageTraction === 0.5);
    assert.deepEqual(run.board.entries.map(e => [e.id, e.lapFrames]), [[run.answer.id, lap.outcome.lapFrames[0]]]);
    await openPanel(a);
    const line = await a.locator('[data-rv="memory-board"]').textContent();
    assert.equal(line, `Fastest verified laps here: 1. ${(lap.outcome.lapFrames[0] / 60).toFixed(2)} s (yours) · your last car verified: ${(lap.outcome.lapFrames[0] / 60).toFixed(2)} s`);
    await a.locator('[data-rv="memory"]').screenshot({path: `${out}/leaderboard.png`});
    // B sees it too (not as its own).
    const lineB = await b.evaluate(async () => { await window.__rvCloud.refreshBoard({force: true}); return document.querySelector('[data-rv="memory-board"]').textContent; });
    assert.equal(lineB, `Fastest verified laps here: 1. ${(lap.outcome.lapFrames[0] / 60).toFixed(2)} s`);
    report.verified = {answer: run.answer, served: run.served, line};

    // ─── 6. race the cloud champion (X3) ─────────────────────────────────
    stage = 'race the cloud champion';
    const race = () => a.evaluate(() => {
      const b = document.querySelector('[data-rv="memory-race"]'), s = window.__rvCloud;
      return {label: b.hidden ? null : b.textContent, pressed: b.getAttribute('aria-pressed'), enabled: window.CloudGhost.enabled,
        champion: s.champion && {id: s.champion.id, from: s.champion.from, lapFrames: s.champion.lapFrames}};
    });
    await a.evaluate(() => window.__rvCloud.maybePull({force: true}));
    let r = await race();
    assert.deepEqual(r.champion, {id: run.answer.id, from: 'leaderboard', lapFrames: lap.outcome.lapFrames[0]});
    assert.equal(r.label, `Race the cloud champion (${(lap.outcome.lapFrames[0] / 60).toFixed(2)} s lap)`);
    // Count what main.js does with it: steps, draws (flat view) and starts
    // over (a new run); the 3D view places its own car.
    await a.evaluate(() => {
      const g = window.CloudGhost, seen = window.__ghostSeen = {steps: 0, draws: 0, resets: 0};
      for (const name of ['step', 'draw', 'reset']) {
        const f = g[name].bind(g);
        g[name] = (...args) => { seen[name + 's'] += 1; const out = f(...args); seen.maxFrames = Math.max(seen.maxFrames || 0, g.frames); return out; };
      }
    });
    await a.locator('[data-rv="memory-race"]').click();
    r = await race();
    assert.deepEqual([r.enabled, r.pressed, r.label], [true, 'true', `Race the cloud champion (${(lap.outcome.lapFrames[0] / 60).toFixed(2)} s lap)`], 'one label, pressed');
    // main.js steps it with your cars and draws it (or the 3D view places
    // it); a new run (begin) starts it over with them.
    if (await a.evaluate(() => pause)) await a.locator('#pause').click();
    await a.waitForFunction(() => window.CloudGhost.frames > 60, {}, {timeout: 60000});
    const seen = await a.evaluate(() => ({...window.__ghostSeen, frames: window.CloudGhost.frames, studio: !!window.CircuitStudio?.cloudGhost?.visible,
      wrecked: window.CloudGhost.wrecked, damaged: window.CloudGhost.car?.damaged, laps: window.CloudGhost.lapFrames, champion: window.CloudGhost.champion?.id, profile: window.CloudGhost.car?.driverProfile,
      maxSpeed, traction, start: window.CloudGhost.start?.()}));
    assert.ok(seen.frames > 60, 'main.js steps it: ' + JSON.stringify(seen));
    assert.ok(seen.draws > 0 || seen.studio, 'drawn, or placed in the 3D view: ' + JSON.stringify(seen));
    const restarted = await a.evaluate(() => { const before = window.__ghostSeen.resets; begin(); return {resets: window.__ghostSeen.resets - before, frames: window.CloudGhost.frames}; });
    assert.deepEqual(restarted, {resets: 1, frames: 0}, 'a new run starts it over');
    // From a new start, its run is the champion's verified lap.
    const ghost = await a.evaluate(n => {
      const g = window.CloudGhost;
      g.reset();
      for (let i = 0; i < n; i++) g.step();
      return {status: g.status()};
    }, lap.settings.seconds * 60);
    assert.deepEqual(ghost.status.lapFrames, lap.outcome.lapFrames, JSON.stringify(ghost.status));
    await a.locator('[data-rv="memory-race"]').click();
    r = await race();
    assert.deepEqual([r.enabled, r.pressed], [false, 'false']);
    assert.equal(await a.evaluate(() => window.CloudGhost.pose()), null);
    report.race = {champion: r.champion, lapFrames: ghost.status.lapFrames, seen};

    // ─── 7. everyone's crash map (X4) ────────────────────────────────────
    stage = 'everyone\'s crash map';
    // A's training sends its own crash maps (main.js archives one each
    // generation; at most one a minute goes).
    await a.waitForFunction(() => window.__rvCloud.crashesSent > 0, {}, {timeout: 60000});
    // Here its cars crash in two cells; archived as adaptive gates archive
    // (the bridge's hook queues it), with a better layout than A's so far (a
    // contributor keeps their best), and sent without waiting out the
    // minute. Gates a generation did not drive (measured false) never go.
    const geometry = await a.evaluate(async () => {
      const m = new Float32Array(144); m[40] = Math.log1p(6); m[41] = Math.log1p(2);
      const n = Math.hypot(...m);
      const g = window.AdaptiveGates.wallSignature();
      const s = window.__rvCloud;
      const cps = [[{x: 1600, y: 300}, {x: 1600, y: 700}], [{x: 2450, y: 900}, {x: 3100, y: 900}], [{x: 1600, y: 1100}, {x: 1600, y: 1500}], [{x: 250, y: 900}, {x: 650, y: 900}]];
      // A's own send may be in flight (one at a time), or its send channel
      // backing off (A and B share one address and its write limit): after
      // that, archive and send in one step, so no training map replaces this
      // one in between.
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let attempt = 0; attempt < 30; attempt++) {
        while (s.crashSending || !s.client.canTry('send')) await sleep(250);
        s.crash = null;
        window.__rvBridge.archiveCrashMap(m.map(x => x / n), {survival: 0.99, nDeaths: 8, generation: 3, geometrySig: g, walls: g, cps, measured: false});
        if (s.crash !== null) throw new Error('an unmeasured layout was queued');
        window.__rvBridge.archiveCrashMap(m.map(x => x / n), {survival: 0.95, nDeaths: 8, generation: 3, geometrySig: g, walls: g, cps});
        s.crashSentAt = -Infinity;
        if (await s.sendCrash()) return g;
        await sleep(2000);
      }
      throw new Error(`the crash map was not sent: ${JSON.stringify(s.client.status)}`);
    });
    // B (same track) pulls: everyone's map and the layout for these walls.
    const crash = await b.evaluate(async () => {
      const s = window.__rvCloud;
      await s.maybePull({force: true});
      await s.settled();
      const shared = window.__rvBridge.sharedCrash();
      const m = new Float32Array(144); m[40] = 1;
      const hits = window.__rvBridge.recommendCrashLayouts(m, 5).filter(h => h.shared);
      const button = document.querySelector('[data-rv="memory-crashes"]');
      return {contributors: shared?.contributors, cell40: shared?.map?.[40], geometry: shared?.geometry, cosine: shared ? shared.map[40] : null,
        hits: hits.map(h => ({survival: h.survival, gates: h.cps.length, sim: h.similarity, sig: h.geometrySig})),
        label: button.hidden ? null : button.textContent};
    });
    assert.ok(crash.contributors >= 1 && crash.cell40 > 0, JSON.stringify(crash));
    assert.equal(crash.geometry, geometry, 'the same walls');
    assert.deepEqual(crash.hits.map(h => [h.survival, h.gates, h.sig])[0], [0.95, 4, geometry], JSON.stringify(crash.hits));
    assert.ok(Math.abs(crash.hits[0].sim - crash.cosine) < 1e-6 && crash.cosine > 0, 'as alike as this map is to everyone\'s');
    assert.match(crash.label, /^Show where everyone crashes here \(\d+ players?\)$/);
    // Shown under the cars (the flat view draws it), then hidden.
    await b.evaluate(() => { const o = window.SharedCrashOverlay, f = o.draw.bind(o); window.__drawn = 0; o.draw = (...x) => { if (o.shown) window.__drawn++; return f(...x); }; });
    await openPanel(b);
    await b.locator('[data-rv="memory-crashes"]').click();
    await b.waitForFunction(() => window.__drawn > 0, {}, {timeout: 20000});
    assert.equal(await b.locator('[data-rv="memory-crashes"]').getAttribute('aria-pressed'), 'true');
    await b.locator('[data-rv="memory-crashes"]').click();
    assert.equal(await b.evaluate(() => window.SharedCrashOverlay.shown), false);
    report.crashes = crash;
    await contextA.close(); await contextB.close();
  }

  assert.deepEqual(errors, []);
  await writeFile(`${out}/browser${report.engine === 'chromium' ? '' : '-' + report.engine}.json`, JSON.stringify(report, null, 1));
  console.log('cloud brain browser: ok', JSON.stringify(report));
} catch (e) {
  console.error(`cloud brain browser failed at ${stage}:`, e);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await dev?.stop();
  if (persist) await rm(persist, {recursive: true, force: true});
  server.kill();
}
