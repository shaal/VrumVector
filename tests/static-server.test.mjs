// scripts/static-server.py: the browser tests' static server. The stock
// `python3 -m http.server` listens with a queue of 5 and resets connections
// when a page load's burst of module requests arrives on a busy machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startStaticServer} from './helpers/static-server.mjs';
import {waitForServer} from './helpers/server-ready.mjs';

const PORT = 8962, origin = `http://127.0.0.1:${PORT}`;

// 100 at once: below the kernel's cap on any listen queue (128 on macOS);
// the stock server resets some of them on a busy machine.
test('the static server takes a burst of 100 simultaneous requests without a reset', async () => {
  const server = startStaticServer(PORT);
  try {
    await waitForServer(origin, server);
    const results = await Promise.allSettled(Array.from({length: 100}, (_, i) =>
      fetch(`${origin}/AI-Car-Racer/main.js?burst=${i}`).then(async r => ({status: r.status, bytes: (await r.arrayBuffer()).byteLength}))));
    const main = await readFile(new URL('../AI-Car-Racer/main.js', import.meta.url));
    const failed = results.filter(r => r.status === 'rejected' || r.value.status !== 200 || r.value.bytes !== main.byteLength);
    assert.equal(failed.length, 0, failed.slice(0, 3).map(r => r.reason?.cause?.code || r.reason?.message || JSON.stringify(r.value)).join(', '));
  } finally {
    server.kill();
  }
});

test('it serves the repo root with the types the app needs', async () => {
  const server = startStaticServer(PORT + 1);
  try {
    const at = `http://127.0.0.1:${PORT + 1}`;
    await waitForServer(at, server);
    for (const [path, type] of [['/AI-Car-Racer/index.html', /^text\/html/], ['/AI-Car-Racer/main.js', /javascript/],
      ['/vendor/ruvector/ruvector_wasm/ruvector_wasm_bg.wasm', /^application\/wasm/], ['/package.json', /json/]]) {
      const response = await fetch(at + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), type, path);
      await response.arrayBuffer();
    }
    assert.equal((await fetch(at + '/no-such-file')).status, 404);
  } finally {
    server.kill();
  }
});
