// `wrangler dev` for the cloud brain Worker (cloud-brain/), for tests: its
// own process group and state folder, ready when the port accepts a TCP
// connection and wrangler has settled. No Cloudflare account is needed.
import {spawn} from 'node:child_process';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const dir = fileURLToPath(new URL('../cloud-brain/', import.meta.url));
const wrangler = fileURLToPath(new URL('../cloud-brain/node_modules/.bin/wrangler', import.meta.url));

const listening = port => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
export async function until(what, test, ms) {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Starts the Worker; `vars` become --var NAME:value. Returns {origin, stop, log}. */
export async function startDev({port, persist, vars = {}, env = {}, settleMs = 3000, logLevel = 'warn'}) {
  await until(`port ${port} free`, async () => !(await listening(port)), 15_000);
  const args = ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--log-level', logLevel];
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`);
  const dev = spawn(wrangler, args, {cwd: dir, detached: true, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  dev.stdout.on('data', d => { log += d; });
  dev.stderr.on('data', d => { log += d; });
  await until('wrangler dev listening', async () => {
    if (dev.exitCode !== null) throw new Error(`wrangler dev exited:\n${log.slice(-2000)}`);
    return listening(port);
  }, 600_000);
  await new Promise(r => setTimeout(r, settleMs));
  if (dev.exitCode !== null) throw new Error(`wrangler dev exited:\n${log.slice(-2000)}`);
  async function stop() {
    const exited = new Promise(r => dev.once('exit', r));
    try { process.kill(-dev.pid, 'SIGINT'); } catch { /* already gone */ }
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    try { process.kill(-dev.pid, 'SIGKILL'); } catch { /* already gone */ }
    await until(`port ${port} closed`, async () => !(await listening(port)), 15_000);
  }
  return {origin: `http://127.0.0.1:${port}`, stop, log: () => log};
}
