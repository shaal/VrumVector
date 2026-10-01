// cloud/mode.js — which memory this page learns into (docs/plan/cloud-brain.md,
// CB3): 'local' (this browser's IndexedDB, the default) or 'shared' (a
// replica of the shared cloud brain in its own IndexedDB). In the app the
// choice is fixed by cloud/scope.js, which index.html loads first
// (window.__vvBrainMode): it also removes ?brain= from the address and gives
// shared mode its own training-state keys. A page without it is local.
// Switching reloads the page, so nothing learned in one mode leaks into the
// other.
export const STORAGE_KEY = 'vv.cloudBrain';
/**
 * What a yes was given to: the version of what shared mode sends (cloud/ui.js
 * WHAT). 2: crash maps (X4). A yes to an earlier text (`true`, CB3 to X3) is
 * asked again before anything more is sent.
 */
export const CONSENT_VERSION = 2;

function read(storage) {
  try { return JSON.parse(storage?.getItem(STORAGE_KEY) || 'null') || null; } catch { return null; }
}

/**
 * 'shared' or 'local' for this page load. The arguments are for tests (Node):
 * without scope.js's answer and without a window, the URL wins and is saved,
 * else the saved choice; shared needs a secure context.
 */
export function brainMode({search = globalThis.location?.search || '', storage = globalThis.localStorage, secure = !!globalThis.crypto?.subtle && globalThis.isSecureContext !== false} = {}) {
  if (typeof globalThis.__vvBrainMode === 'string') return globalThis.__vvBrainMode === 'shared' ? 'shared' : 'local';
  if (globalThis.window) return 'local';
  let saved = read(storage);
  try {
    const asked = new URLSearchParams(search).get('brain');
    if (asked === 'shared' || asked === 'local') {
      saved = {mode: asked, consented: saved?.consented ?? false};
      storage?.setItem(STORAGE_KEY, JSON.stringify(saved));
    }
  } catch { saved = null; }
  return saved?.mode === 'shared' && secure ? 'shared' : 'local';
}

/** Whether the player agreed to an earlier text only (asked again, with what changed). */
export function consentedBefore(storage = globalThis.localStorage) {
  const yes = read(storage)?.consented;
  return !!yes && yes !== CONSENT_VERSION;
}

/** Whether the player agreed to what shared mode sends now (asked before any upload). */
export function consented(storage = globalThis.localStorage) {
  return read(storage)?.consented === CONSENT_VERSION;
}

/** Saves the choice for the next load (the caller reloads the page). */
export function saveBrainMode(mode, {consent} = {}, storage = globalThis.localStorage) {
  try {
    const was = read(storage);
    storage.setItem(STORAGE_KEY, JSON.stringify({mode: mode === 'shared' ? 'shared' : 'local', consented: consent === undefined ? was?.consented ?? false : consent ? CONSENT_VERSION : false}));
    return true;
  } catch { return false; }
}
