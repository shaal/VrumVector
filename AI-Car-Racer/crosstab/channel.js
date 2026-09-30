// crosstab/channel.js
// Phase 2B — F6: Cross-tab live training.
//
// Thin wrapper over BroadcastChannel('vectorvroom-archive'). Each tab gets a
// random `senderId` at module load; peer-count is the number of distinct
// senderIds we've seen say hello. We drop any message whose senderId equals
// our own (BroadcastChannel is specified NOT to echo to the sender, but the
// guard costs nothing and protects future multi-channel setups).
//
// The wire protocol has three message types:
//   { type: 'hello', senderId }                    — broadcast on start
//   { type: 'bye',   senderId }                    — broadcast on beforeunload
//   { type: 'brain', senderId, payload }           — a single-brain delta; payload
//                                                    shape defined by ./wire.js
//
// Connect semantics: on `start()` we post a `hello` so any already-open peers
// can count us; existing peers post a `hello` back (because they re-emit on
// their own start — we also answer peer `hello` messages with our own so late
// joiners learn the full peer set without a separate roll-call). No archive
// sync on connect — the plan explicitly calls out "incrementally, not full
// archive rebuild" for F6. Only NEW archives post-connect get shared.
//
// The stats() snapshot is exposed for the smoke harness and for the UI pill
// (peer-count rendering). Re-entrant start() / stop() are safe.

const CHANNEL_NAME = 'vectorvroom-archive';

function randomSenderId() {
  // 8 hex chars is plenty for a per-tab transient id; collision across two
  // tabs open at once is ~1 in 4B which is acceptable for "is this my echo?".
  const rnd = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return rnd.toString(16).padStart(8, '0');
}

let _senderId = randomSenderId();
let _ch = null;
let _started = false;
let _onBrain = null;
let _onPeerCount = null;
let _sent = 0;
let _received = 0;
let _echoesDropped = 0;
// peerId -> timestamp of last seen. We keep the full set rather than a counter
// so a `bye` can drop a peer cleanly, and stale peers (tab crashed without
// posting bye) could be reaped via a future heartbeat — not needed for F6.
const _peers = new Map();
let _beforeUnloadHandler = null;

function notifyPeerCount() {
  if (typeof _onPeerCount === 'function') {
    try { _onPeerCount(_peers.size); }
    catch (e) { console.warn('[crosstab] onPeerCount callback failed', e); }
  }
}

function addPeer(id) {
  if (!id || id === _senderId) return;
  const had = _peers.has(id);
  _peers.set(id, Date.now());
  if (!had) notifyPeerCount();
}

function removePeer(id) {
  if (!id) return;
  const had = _peers.delete(id);
  if (had) notifyPeerCount();
}

function handleMessage(ev) {
  const msg = ev && ev.data;
  if (!msg || typeof msg !== 'object') return;
  const sid = msg.senderId;
  if (!sid) return;
  if (sid === _senderId) {
    // Defense-in-depth: BroadcastChannel shouldn't loop back, but a future
    // relay (e.g. SharedWorker fan-out) might.
    _echoesDropped += 1;
    return;
  }
  _received += 1;
  switch (msg.type) {
    case 'hello': {
      addPeer(sid);
      // Answer so the late joiner learns *we* exist too. This is the cheapest
      // way to get mutual visibility without a separate roll-call message.
      try {
        if (_ch) _ch.postMessage({ type: 'hello-ack', senderId: _senderId });
      } catch (_) { /* channel closed mid-handler */ }
      return;
    }
    case 'hello-ack': {
      addPeer(sid);
      return;
    }
    case 'bye': {
      removePeer(sid);
      return;
    }
    case 'brain': {
      addPeer(sid); // any brain traffic proves liveness
      if (typeof _onBrain === 'function' && msg.payload) {
        try { _onBrain(msg.payload, sid); }
        catch (e) { console.warn('[crosstab] onBrain callback failed', e); }
      }
      return;
    }
    default:
      // Forward-compat: unknown types are ignored.
      return;
  }
}

// Public API ------------------------------------------------------------------

export function start({ onBrain, onPeerCount, name = CHANNEL_NAME } = {}) {
  if (_started) return;
  if (typeof BroadcastChannel === 'undefined') {
    console.warn('[crosstab] BroadcastChannel unavailable in this environment');
    return;
  }
  _onBrain = typeof onBrain === 'function' ? onBrain : null;
  _onPeerCount = typeof onPeerCount === 'function' ? onPeerCount : null;
  try {
    _ch = new BroadcastChannel(name);
  } catch (e) {
    console.warn('[crosstab] failed to open BroadcastChannel', e);
    _ch = null;
    return;
  }
  _ch.addEventListener('message', handleMessage);
  _started = true;
  // Post hello. Existing tabs answer with hello-ack so peer-count is accurate
  // within one RTT of start.
  try { _ch.postMessage({ type: 'hello', senderId: _senderId }); }
  catch (e) { console.warn('[crosstab] initial hello failed', e); }
  // Emit an initial peer-count of 0 so the UI paints "no peers" rather than
  // showing its previous state across a stop→start.
  notifyPeerCount();
  // beforeunload: post `bye` so peers drop our entry immediately rather than
  // carrying us forever. Non-load-bearing (peers would heal on next hello),
  // but it makes the pill feel honest.
  if (typeof window !== 'undefined') {
    _beforeUnloadHandler = () => {
      try { if (_ch) _ch.postMessage({ type: 'bye', senderId: _senderId }); }
      catch (_) { /* tab is going away — nothing to do */ }
    };
    window.addEventListener('beforeunload', _beforeUnloadHandler);
  }
}

export function stop() {
  if (!_started) return;
  try { if (_ch) _ch.postMessage({ type: 'bye', senderId: _senderId }); } catch (_) {}
  if (_ch) {
    try { _ch.removeEventListener('message', handleMessage); } catch (_) {}
    try { _ch.close(); } catch (_) {}
  }
  if (typeof window !== 'undefined' && _beforeUnloadHandler) {
    try { window.removeEventListener('beforeunload', _beforeUnloadHandler); } catch (_) {}
  }
  _ch = null;
  _started = false;
  _onBrain = null;
  _onPeerCount = null;
  _peers.clear();
  _beforeUnloadHandler = null;
}

export function broadcastBrain(payload) {
  if (!_started || !_ch || !payload) return false;
  try {
    _ch.postMessage({ type: 'brain', senderId: _senderId, payload });
    _sent += 1;
    return true;
  } catch (e) {
    console.warn('[crosstab] broadcastBrain postMessage failed', e);
    return false;
  }
}

export function getPeerCount() {
  return _peers.size;
}

export function getSenderId() {
  return _senderId;
}

export function isStarted() {
  return _started;
}

export function stats() {
  return {
    started: _started,
    senderId: _senderId,
    peerCount: _peers.size,
    sent: _sent,
    received: _received,
    echoesDropped: _echoesDropped,
  };
}

// Test hook — wipes state so a harness can rebuild without a page reload.
export function _debugReset() {
  stop();
  _senderId = randomSenderId();
  _sent = 0;
  _received = 0;
  _echoesDropped = 0;
  _peers.clear();
}
