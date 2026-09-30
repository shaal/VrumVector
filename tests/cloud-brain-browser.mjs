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
//    offspring feedback reaches A's pool.
//
//   npm run test:cloud-brain:browser     (needs the cloud-brain toolchain for part 4)
//   BROWSER=firefox (or webkit) runs it in that engine instead of Chromium.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
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
  page.on('pageerror', e => errors.push(`${stage}: ${e.message}`));
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
    // Trained brains and offspring feedback are pushed.
    await page.evaluate(async () => { await window.__rvCloud.settled(); await window.__rvCloud.client.flush(); });
    const contributed = fake.requests.filter(r => r.path === '/v1/contribute').map(r => JSON.parse(r.body));
    const pushed = contributed.flatMap(b => b.brains);
    assert.ok(pushed.length >= 1, 'brains pushed');
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
    // B, fresh: its first generation is seeded from A's brains.
    const b = await openPage(contextB, {endpoint: REAL, query: '?brain=shared'});
    await b.waitForFunction(() => window.__rvCloud?.accepted >= 1, {}, {timeout: 60000});
    const seedsB = await firstSeeds(b);
    assert.ok(seedsB.generation === 0 && seedsB.archive_recall > 0, JSON.stringify(seedsB));
    // B's offspring feedback reaches A's pool: brains with a second contributor.
    const contributorsBefore = await a.evaluate(async () => {
      const {unit} = await import('./cloud/session.js');
      const pool = await window.__rvCloud.client.recall({trackVec: unit(window.currentTrackVec), context: window.__rvBridge.info().learning.context || {}, k: 50});
      return Math.max(0, ...pool.map(p => p.feedback.contributors));
    });
    assert.ok(contributorsBefore <= 1, 'only A so far');
    await train(b, 3);
    await b.evaluate(async () => { await window.__rvCloud.settled(); await window.__rvCloud.client.flush(); });
    const poolA = await a.evaluate(async () => {
      const s = window.__rvCloud;
      const pool = await s.client.recall({trackVec: (await import('./cloud/session.js')).unit(window.currentTrackVec),
        context: window.__rvBridge.info().learning.context || {}, k: 50});
      return pool.map(p => ({fitness: p.fitness, feedback: p.feedback}));
    });
    assert.ok(poolA.some(p => p.feedback.contributors >= 2), JSON.stringify(poolA.slice(0, 5)));
    report.real = {statsA, seedsB, entriesWithTwoContributors: poolA.filter(p => p.feedback.contributors >= 2).length, pool: poolA.length};
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
