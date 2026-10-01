// cloud/scope.js — loaded first (a classic script in index.html's <head>),
// before any code reads the training state (docs/plan/cloud-brain.md, CB3).
//
// 1. Fixes this page's memory mode, 'local' or 'shared' (window.__vvBrainMode,
//    which cloud/mode.js returns): ?brain=shared or ?brain=local is saved and
//    then removed from the address, so a reload or the Memory control is not
//    overridden by it; else the saved choice. Shared needs a secure context.
//    Arriving by a ?brain=shared link records no consent: cloud/session.js
//    asks before anything is sent.
// 2. In shared mode, gives the training state kept in localStorage its own
//    keys (name + '.shared'): the car saved each generation and used as a
//    prior seed, the driver champions, the transfer guards, the schema
//    version, the training count, lap records and the adaptive gates'
//    memory. So neither mode's training reaches the other's, whoever reads
//    or writes those keys. (Local mode skips '.shared' lap records.)
(function () {
  var KEY = 'vv.cloudBrain';
  var SCOPED = ['bestBrain', 'oldBestBrain', 'bestBrainLearningContext', 'oldBestBrainLearningContext',
    'progress', 'fastLap', 'rvAnnotations', 'vv.driverChampions', 'vv.transferGuard', 'brainSchemaVersion', 'trainCount'];
  // Keys by prefix: lap records per track, the adaptive gates' curriculum.
  var PREFIXES = ['vv_fastlap_', 'vv_adapt_gates_'];
  var mode = 'local';
  try {
    var saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
    var params = new URLSearchParams(window.location.search), asked = params.get('brain');
    if (asked === 'shared' || asked === 'local') {
      // The yes as given (cloud/mode.js CONSENT_VERSION: a version, not a flag).
      var yes = (saved && saved.consented) || false;
      saved = {mode: asked === 'shared' ? 'shared' : 'local', consented: yes};
      try { window.localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* this page only */ }
      params.delete('brain');
      var query = params.toString();
      try { window.history.replaceState(window.history.state, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash); } catch (e) { /* keep the address */ }
    }
    var secure = !!(window.crypto && window.crypto.subtle) && window.isSecureContext !== false;
    mode = saved && saved.mode === 'shared' && secure ? 'shared' : 'local';
  } catch (e) {
    mode = 'local';
  }
  window.__vvBrainMode = mode;
  if (mode !== 'shared' || typeof Storage === 'undefined') return;
  var proto = Storage.prototype, get = proto.getItem, set = proto.setItem, remove = proto.removeItem;
  function scoped(storage, key) {
    key = String(key);
    if (storage !== window.localStorage || /\.shared$/.test(key)) return key;
    if (SCOPED.indexOf(key) >= 0) return key + '.shared';
    for (var i = 0; i < PREFIXES.length; i++) if (key.indexOf(PREFIXES[i]) === 0) return key + '.shared';
    return key;
  }
  proto.getItem = function (key) { return get.call(this, scoped(this, key)); };
  proto.setItem = function (key, value) { return set.call(this, scoped(this, key), value); };
  proto.removeItem = function (key) { return remove.call(this, scoped(this, key)); };
  window.__vvScopedKeys = SCOPED.slice();
})();
