// The deployed cloud brain answers (docs/plan/cloud-brain.md, CB5): deploy.yml
// runs this right after `wrangler deploy`, and the runbook after any change.
//
//   node scripts/cloud-brain-health.mjs https://vectorvroom-brain.<subdomain>.workers.dev [commit]
//   (or http://127.0.0.1:8879 for `npm run dev` in cloud-brain/)
//
// With a commit (deploy.yml passes the one it built, CLOUD_BRAIN_COMMIT),
// /health must say that build answers: not the version before it.
//
// /health must say the schema opened (ok), the brain is on (no DISABLE_BRAIN),
// the per-address limits are bound and the protocol is the page's; /v1/stats
// and a recall must answer the site's origin with CORS. A fresh deploy can take a few
// seconds to answer everywhere: each check is tried for up to a minute.
// Exits 1 with the reason otherwise. Reads only: nothing is stored.
import {PROTOCOL, DIMS, recallBody} from '../AI-Car-Racer/cloud/wire.js';

const SITE = 'https://vv.shaal.dev';
const base = new URL(process.argv[2] || '');
const commit = process.argv[3] || null;
const local = base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname);
if (base.protocol !== 'https:' && !local) throw new Error(`not an https endpoint: ${process.argv[2]}`);

async function check(name, attempt) {
  let last = null;
  for (let tries = 0; tries < 12; tries++) {
    try {
      const why = await attempt();
      if (!why) {
        console.log(`ok: ${name}`);
        return true;
      }
      last = why;
    } catch (error) {
      last = String(error?.message || error);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.error(`::error::${name}: ${last}`);
  return false;
}

const health = await check('/health', async () => {
  const res = await fetch(new URL('/health', base), {signal: AbortSignal.timeout(15_000)});
  if (res.status !== 200) return `status ${res.status}`;
  const h = await res.json();
  console.log(JSON.stringify(h));
  if (h.ok !== true) return 'the schema did not open (ok: false)';
  if (h.brain !== true) return 'the brain is off (DISABLE_BRAIN)';
  if (h.limits !== true) return 'the per-address limits are not bound (limits: false)';
  if (h.protocol !== PROTOCOL) return `protocol ${h.protocol}, the page speaks ${PROTOCOL}`;
  if (commit && h.build?.commit !== commit) return `build ${h.build?.commit} answers, not ${commit} (still the version before?)`;
  return null;
});

const stats = health && await check(`/v1/stats for ${SITE}`, async () => {
  const res = await fetch(new URL('/v1/stats', base), {headers: {Origin: SITE}, signal: AbortSignal.timeout(15_000)});
  if (res.status !== 200) return `status ${res.status}`;
  if (res.headers.get('access-control-allow-origin') !== SITE) return `CORS: ${res.headers.get('access-control-allow-origin')}`;
  console.log(JSON.stringify(await res.json()));
  return null;
});

// A recall, as the page asks (a text/plain POST: no preflight): the body
// read, the object answering, CORS. Reads only.
const track = new Float32Array(DIMS.track);
track[0] = 1;
const recall = health && await check(`POST /v1/recall for ${SITE}`, async () => {
  const res = await fetch(new URL('/v1/recall', base), {method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: {Origin: SITE, 'Content-Type': 'text/plain'}, body: recallBody({trackVec: track, context: {}, k: 1})});
  if (res.status !== 200) return `status ${res.status}`;
  if (res.headers.get('access-control-allow-origin') !== SITE) return `CORS: ${res.headers.get('access-control-allow-origin')}`;
  return null;
});

process.exit(health && stats && recall ? 0 : 1);
