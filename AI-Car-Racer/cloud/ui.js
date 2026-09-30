// cloud/ui.js — the Memory control in the Vector Memory panel
// (docs/plan/cloud-brain.md, CB3): "This browser" or "Shared (cloud, beta)",
// what shared mode sends (asked before the first switch), and the shared
// brain's status. Hidden where the service is not available, unless this
// page is already in shared mode (then it says why, and offers the way back).
//
// Choosing a radio does nothing by itself (keys move through radios): the
// Switch button, which says it reloads the page, switches.

const WHAT = [
  'Shared brain (beta): your cars learn from, and add to, one brain shared with everyone who turns this on.',
  '',
  'Sent: the network weights of your best cars (a copy of your own driving too, when you use "Use my driving", marked as such), with their fitness, lap times, generation and lineage; how they drove (driving summaries and a 64-number driving signature); the track\'s embedding and a fingerprint of its shape (not the shape itself); your learning settings; and the results of cars bred from shared brains.',
  'With them goes an anonymous random token made in this browser, which links your contributions to each other, not to you. The service sees your IP address while it answers and does not store it. Your recordings of driving are never sent.',
  '',
  'This browser\'s own memory and training are kept apart, unchanged.',
];
/** Asked before switching to shared mode from the Memory control. */
export const DISCLOSURE = [...WHAT, 'Switch now (the page reloads)?'].join('\n');
/** Asked when a link opened this page in shared mode: nothing is sent before a yes. */
export const ARRIVAL_DISCLOSURE = [...WHAT, 'This link opened the shared brain. Use it? (Cancel returns to this browser\'s own memory.)'].join('\n');

const STYLE = `
.rv-memory{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:6px 0 2px;font-size:12px}
.rv-memory-label{opacity:.8}
.rv-memory label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.rv-memory-switch{font:inherit;padding:2px 8px;cursor:pointer}
.rv-memory-status{flex-basis:100%;opacity:.85}
.rv-memory-status.rv-memory-offline{opacity:1;background:#6b3a12;color:#fff;border-radius:4px;padding:3px 6px}
.rv-memory-pill{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:1300;background:#6b3a12;color:#fff;border-radius:999px;padding:4px 12px;font:12px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3)}
@media (pointer:coarse){.rv-memory label,.rv-memory-switch{min-height:44px}}
`;

/** The status line: {text} (announced when it changes), {retry} (not announced), {offline}. */
export function describe(status, {secure = true, now = Date.now()} = {}) {
  const pending = status.pending ? status.pending.brains + status.pending.feedback : 0;
  const waiting = pending ? ` · ${pending} waiting to send` : '';
  switch (status.state) {
    case 'unavailable':
      return {text: secure ? 'The shared brain is not available on this site yet: training uses a separate local copy.' : 'The shared brain needs a secure (https) page: training uses a separate local copy.', retry: '', offline: true};
    case 'offline': {
      const wait = status.deadline ? Math.ceil((status.deadline - now) / 1000) : 0;
      return {text: `Shared brain offline — training from the last copy${waiting}`, retry: wait > 0 ? ` (retrying in ${wait} s)` : ' (retrying)', offline: true};
    }
    case 'outdated':
      return {text: `The shared brain refused this version of the page — reload to update. Training from the last copy${waiting}`, retry: '', offline: true};
    case 'disabled':
      return {text: `Shared brain paused — training from the last copy${waiting}`, retry: '', offline: true};
    case 'online':
    case 'idle': {
      const size = Number.isFinite(status.brains) ? ` · ${status.brains.toLocaleString()} brains` : '';
      return {text: `Shared brain ${status.state === 'online' ? 'online' : 'connecting'}${size}${waiting}`, retry: '', offline: false};
    }
    default:
      return {text: '', retry: '', offline: false};
  }
}

/** Waits for the panel header (uiPanels.js builds it), up to `ms`. */
async function panelHeader(doc, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const header = doc.querySelector('#rv-panel .rv-header');
    if (header) return header;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

/**
 * Mounts the control. Returns {setStatus, ready} (ready resolves to the row
 * element, or null when it is not shown).
 */
export function mountMemoryControl({mode, available, secure = true, onChoose, confirm: ask = text => globalThis.confirm?.(text) ?? false, doc = globalThis.document}) {
  let row = null, textEl = null, retryEl = null, statusEl = null, pill = null, last = null, ticker = null;
  const render = () => {
    if (!last) return;
    const {text, retry, offline} = describe(last, {secure});
    if (statusEl) {
      // Only the text is a live region: the countdown is not announced.
      if (textEl.textContent !== text) textEl.textContent = text;
      if (retryEl.textContent !== retry) retryEl.textContent = retry;
      statusEl.classList.toggle('rv-memory-offline', offline);
    }
    // Offline in shared mode: also a small notice outside the panel, which
    // is often collapsed (the panel's line is the one read out).
    if (doc && mode === 'shared') {
      if (offline && last.state !== 'unavailable') {
        if (!pill) {
          pill = doc.createElement('div');
          pill.className = 'rv-memory-pill';
          pill.setAttribute('aria-hidden', 'true');
          pill.dataset.rv = 'memory-pill';
          doc.body.appendChild(pill);
        }
        pill.textContent = last.state === 'outdated' ? 'Shared brain: reload to update' : last.state === 'disabled' ? 'Shared brain paused' : 'Shared brain offline';
      } else if (pill) { pill.remove(); pill = null; }
    }
  };
  const setStatus = status => {
    // The client's clock is its own: the retry becomes a deadline on this one.
    last = {...status, deadline: status.retryIn > 0 ? Date.now() + status.retryIn : 0};
    render();
    const waiting = () => last.state === 'offline' && last.deadline > Date.now();
    if (waiting() && !ticker) {
      ticker = setInterval(() => {
        render();
        if (!waiting()) { render(); clearInterval(ticker); ticker = null; }
      }, 1000);
    }
  };
  const ready = (async () => {
    if (!doc || (!available && mode !== 'shared')) return null;
    const header = await panelHeader(doc, 10_000);
    if (!header) return null;
    if (!doc.getElementById('rv-memory-style')) {
      const style = doc.createElement('style');
      style.id = 'rv-memory-style';
      style.textContent = STYLE;
      doc.head.appendChild(style);
    }
    row = doc.createElement('div');
    row.className = 'rv-memory';
    row.dataset.rv = 'memory';
    row.innerHTML = [
      '<span class="rv-memory-label" id="rv-memory-label">Memory:</span>',
      '<span role="radiogroup" aria-labelledby="rv-memory-label">',
      '<label><input type="radio" name="rv-memory" value="local" data-rv="memory-local"> This browser</label> ',
      `<label><input type="radio" name="rv-memory" value="shared" data-rv="memory-shared"${available ? '' : ' disabled'}> Shared (cloud, beta)</label>`,
      '</span>',
      '<button type="button" class="rv-memory-switch" data-rv="memory-switch" hidden>Switch (reloads the page)</button>',
      '<span class="rv-memory-status" data-rv="memory-status"><span data-rv="memory-text" role="status" aria-live="polite"></span><span data-rv="memory-retry" aria-hidden="true"></span></span>',
    ].join('');
    header.insertAdjacentElement('afterend', row);
    statusEl = row.querySelector('[data-rv="memory-status"]');
    textEl = row.querySelector('[data-rv="memory-text"]');
    retryEl = row.querySelector('[data-rv="memory-retry"]');
    const button = row.querySelector('[data-rv="memory-switch"]');
    const chosen = () => row.querySelector('input[name="rv-memory"]:checked')?.value || mode;
    for (const input of row.querySelectorAll('input[name="rv-memory"]')) {
      input.checked = input.value === mode;
      input.addEventListener('change', () => { button.hidden = chosen() === mode; });
    }
    button.addEventListener('click', () => {
      const choice = chosen();
      if (choice === mode) return;
      // Going shared: say what is sent first, every time.
      if (choice === 'shared' && !ask(DISCLOSURE)) {
        row.querySelector(`input[value="${mode}"]`).checked = true;
        button.hidden = true;
        return;
      }
      onChoose?.(choice);
    });
    if (last) render();
    return row;
  })();
  return {setStatus, ready};
}
