// Runs the real classic worker scripts (sim-worker.js, learning/trial-worker.js)
// in a Node vm with a minimal worker scope, so tests can post messages to them
// and read what they post back.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const APP = new URL('../../AI-Car-Racer/', import.meta.url);
const channels = [];
class TrackedChannel extends MessageChannel { constructor() { super(); channels.push(this); } }
// Close every MessageChannel a worker opened, so the test process can exit.
export const closeChannels = () => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } };

// script: the worker's path under AI-Car-Racer/ (e.g. 'sim-worker.js'), and
// importScripts and import() resolve from there. source (optional) replaces
// the script's text, e.g. with a saved copy for before/after checks. random
// (optional) replaces Math.random inside the worker.
export function loadWorker(script, {source = null, random = null} = {}) {
  const url = new URL(script, APP), posted = [];
  const math = Object.create(Math);
  if (random) math.random = random;
  const scope = {performance, MessageChannel: TrackedChannel, console, Math: math, postMessage: m => posted.push(m)};
  scope.self = scope; scope.globalThis = scope;
  const context = vm.createContext(scope);
  scope.importScripts = (...files) => {
    for (const f of files) vm.runInContext(readFileSync(new URL(f, url), 'utf8'), context, {filename: f});
  };
  vm.runInContext(source ?? readFileSync(url, 'utf8'), context, {
    filename: fileURLToPath(url), importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const send = data => scope.onmessage({data});
  // Resolves with the first message matching `test` posted after `from`.
  const waitFor = (test, {from = 0, timeout = 60000} = {}) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      for (let i = from; i < posted.length; i++) if (test(posted[i])) return resolve(posted[i]);
      if (Date.now() - started > timeout) return reject(new Error('worker message timed out'));
      setTimeout(poll, 5);
    };
    poll();
  });
  return {scope, context, send, posted, waitFor};
}

// Plain values for comparing worker messages: typed arrays become arrays, and
// NaN / -0 survive (JSON would turn NaN into null). Everything is rebuilt in
// this realm, so values from two vm contexts compare equal.
export function plain(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value, v => (Number.isNaN(v) ? 'NaN' : Object.is(v, -0) ? '-0' : v));
  if (Array.isArray(value)) return Array.from(value, plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return value;
}
