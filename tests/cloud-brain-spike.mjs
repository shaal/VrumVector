// CB0 (docs/plan/cloud-brain.md): the cloud brain Worker, built for
// wasm32-unknown-emscripten with the `spike` routes, under `wrangler dev`
// (local workerd, no Cloudflare account). Proves the Durable Object's SQLite
// round trip and its persistence across a restart, and measures the cold
// start, a flat index of up to 50 000 random brains, and what a panic does
// to later requests. Writes test-results/cloud-brain/spike.json.
//
// Needs the toolchain in cloud-brain/ (beta Rust from rust-toolchain.toml,
// worker-build 0.8.7, `npm ci` in cloud-brain/):
//   node tests/cloud-brain-spike.mjs            (PORT=8880 for another port)
// CLOUD_BRAIN_DIR runs another copy of the Worker (the spike measured a
// wasm32-unknown-unknown copy that way), OUT names the report.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const dir = process.env.CLOUD_BRAIN_DIR || fileURLToPath(new URL('../cloud-brain/', import.meta.url));
const PORT = Number(process.env.PORT) || 8880, origin = `http://127.0.0.1:${PORT}`;
const out = fileURLToPath(new URL('../test-results/cloud-brain', import.meta.url)); await mkdir(out, {recursive: true});
const wrangler = fileURLToPath(new URL('../cloud-brain/node_modules/.bin/wrangler', import.meta.url));
const name = process.env.OUT || 'spike';
// Its own state folder, so two runs (on two ports) never share one.
const persist = fileURLToPath(new URL(`../test-results/cloud-brain/state-${PORT}`, import.meta.url));
const report = {date: new Date().toISOString(), machine: `${os.cpus()[0]?.model} (${os.cpus().length} threads)`, load: os.loadavg().map(x => +x.toFixed(1))};

let dev = null;
const listening = () => new Promise(resolve => {
  const socket = net.connect(PORT, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
const until = async (what, test, ms) => {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
};
// After the port opens, wrangler still holds requests until its runtime has
// finished loading; a request then would time wrangler's start-up, not the
// Worker's. COLD_SETTLE_MS waits that out (default 3 s).
const SETTLE_MS = Number(process.env.COLD_SETTLE_MS ?? 3000);
async function start(label) {
  // Never time or test a leftover server on this port.
  await until(`port ${PORT} free before ${label}`, async () => !(await listening()), 15_000);
  // Its own process group, so stop() ends wrangler, its CLI and workerd.
  dev = spawn(wrangler, ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--log-level', 'warn', '--var', 'CLOUD_BRAIN_SPIKE:1'],
    {cwd: dir, detached: true, env: {...process.env, CLOUD_BRAIN_FEATURES: 'spike', CLOUD_BRAIN_ALLOW_SPIKE: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  dev.stdout.on('data', d => { log += d; }); dev.stderr.on('data', d => { log += d; });
  // Ready when the port accepts a TCP connection: no HTTP request reaches the
  // Worker before the timed one below (any path would, /cdn-cgi/* included).
  await until(`wrangler dev listening (${label})`, async () => {
    if (dev.exitCode !== null) throw new Error(`wrangler dev exited (${label}):\n${log.slice(-2000)}`);
    return listening();
  }, 600_000);
  await new Promise(r => setTimeout(r, SETTLE_MS));
  if (dev.exitCode !== null) throw new Error(`wrangler dev exited (${label}):\n${log.slice(-2000)}`);
  // The first request loads the Worker's module and constructs the object:
  // the local cold start (instantiate, constructor, SQL schema, round trip).
  const t0 = performance.now();
  const health = await (await get('/health')).json();
  return {health, coldMs: +(performance.now() - t0).toFixed(1), log: () => log};
}
async function stop() {
  if (!dev) return;
  const group = -dev.pid, exited = new Promise(r => dev.once('exit', r));
  try { process.kill(group, 'SIGINT'); } catch { /* already gone */ }
  await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  try { process.kill(group, 'SIGKILL'); } catch { /* already gone */ }
  dev = null;
  await until(`port ${PORT} closed`, async () => !(await listening()), 15_000);
}
// Every request has a deadline, so a hang is a result, not a stuck test.
const get = (path, init = {}) => fetch(origin + path, {signal: AbortSignal.timeout(30_000), ...init});
const time = async (label, fn) => { const t0 = performance.now(); const value = await fn(); return {label, ms: +(performance.now() - t0).toFixed(1), value}; };

try {
  await rm(persist, {recursive: true, force: true});
  // COLD_ONLY=n: only the cold start, n restarts (for a paired comparison of
  // two builds under the same host load).
  if (process.env.COLD_ONLY) {
    report.coldStartMs = [];
    report.settleMs = SETTLE_MS;
    for (let i = 0; i < Number(process.env.COLD_ONLY); i++) {
      const run = await start('cold ' + i);
      report.target = run.health.build.target;
      report.coldStartMs.push(run.coldMs);
      await stop();
    }
    await writeFile(`${out}/${name}.json`, JSON.stringify(report, null, 2) + '\n');
    await rm(persist, {recursive: true, force: true});
    console.log(JSON.stringify(report.coldStartMs));
    process.exit(0);
  }
  const first = await start('first');
  assert.equal(first.health.build.spike, true);
  if (!process.env.CLOUD_BRAIN_DIR) assert.equal(first.health.build.target, 'wasm32-unknown-emscripten');
  report.target = first.health.build.target;
  report.settleMs = SETTLE_MS;
  report.coldStartMs = [first.coldMs];

  // SQL round trip.
  const put = await get('/spike/sql', {method: 'POST', body: JSON.stringify({key: 'spike', value: 'round trip'})});
  assert.equal(put.status, 200);
  assert.deepEqual(await (await get('/spike/sql?key=spike')).json(), {key: 'spike', value: 'round trip'});
  assert.equal((await get('/spike/sql?key=missing')).status, 404);
  report.sqlRoundTrip = true;

  // Flat index: n random 244-float brains, 10 exact cosine searches.
  report.index = [];
  for (const n of [5000, 20000, 50000]) {
    for (let run = 0; run < 3; run++) {
      const r = await time(`index ${n}`, async () => (await get(`/spike/index?n=${n}&q=10`, {method: 'POST'})).json());
      assert.equal(r.value.n, n);
      report.index.push({n, run, ms: r.ms, memoryMB: +(r.value.bytes / 2 ** 20).toFixed(1)});
    }
  }
  const memory = () => get('/spike/memory').then(async res => +((await res.json()).bytes / 2 ** 20).toFixed(1), e => String(e.cause?.code || e.name));
  // Module memory is a high-water mark (Wasm memory never shrinks): after
  // the 50 000-brain run it is that run's size.
  report.memoryAfterMB = await memory();

  // A panic (on Emscripten it unwinds by default; the wasm32-unknown-unknown
  // copy aborts): what happens to the request, and to the next ones.
  // Memory after it tells a surviving instance (still the high-water mark)
  // from a replaced one (a fresh, small module).
  report.panic = await get('/spike/panic').then(async res => ({status: res.status, body: (await res.text()).slice(0, 200)}), e => ({error: String(e.cause?.code || e.name)}));
  const after = [];
  for (let i = 0; i < 5; i++) {
    after.push(await get('/health').then(async res => ({status: res.status, body: (await res.text()).slice(0, 120)}), e => ({error: String(e.cause?.code || e.name)})));
    await new Promise(r => setTimeout(r, 200));
  }
  report.afterPanic = after;
  report.memoryAfterPanicMB = await memory();
  report.instanceAfterPanic = typeof report.memoryAfterPanicMB === 'number'
    ? (report.memoryAfterPanicMB < report.memoryAfterMB / 2 ? 'replaced' : 'survived') : 'unknown';
  report.sqlAfterPanic = await get('/spike/sql?key=spike').then(async res => ({status: res.status, body: (await res.text()).slice(0, 120)}), e => ({error: String(e.cause?.code || e.name)}));

  // Restart: the row survives in the object's SQLite; a second cold start.
  await stop();
  const second = await start('restart');
  report.coldStartMs.push(second.coldMs);
  assert.deepEqual(await (await get('/spike/sql?key=spike')).json(), {key: 'spike', value: 'round trip'}, 'the row survives a restart');
  report.persistsAcrossRestart = true;
  await stop();

  await writeFile(`${out}/${name}.json`, JSON.stringify(report, null, 2) + '\n');
  await rm(persist, {recursive: true, force: true});
  console.log(JSON.stringify(report, null, 2));
  console.log('cloud brain spike: ok');
} catch (error) {
  console.error(JSON.stringify(report, null, 2));
  throw error;
} finally {
  await stop();
}
