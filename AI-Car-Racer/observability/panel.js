// observability/panel.js — Phase 3A (F7) "Where the time goes" UI.
//
// mountObservabilityPanel(containerEl, getStats) renders a collapsible
// panel with:
//   * header toggle (⏱ label + expand/collapse)
//   * a stacked horizontal bar (plain DOM, % widths) of stage avgMs
//   * a numeric table: stage · count · avgMs · p95Ms · %
//
// Poll cadence is rAF-gated at ~10Hz so the panel is cheap even when the
// sim is idle. getStats() may return null (bridge not ready) — we render
// a "waiting for bridge" placeholder and keep polling.
//
// Inline CSS is scoped to `.rv-obs-*` classes so it can't collide with
// the main panel stylesheet.

// Stages we explicitly colour. Anything else falls into "misc" for the
// bar but still shows in the numeric table with its own row.
const STAGE_COLOURS = {
  retrieve: '#4c9ffe',
  federate: '#5eb3f9',
  rerank:   '#9775fa',
  adapt:    '#ffa94d',
  dynamics: '#51cf66',
  misc:     '#adb5bd',
};

const STAGE_ORDER = ['retrieve', 'federate', 'rerank', 'adapt', 'dynamics', 'misc'];

const STYLE = `
.rv-obs-panel {
  margin-top: .6em;
  padding: .45em .6em;
  border: 1px solid #d6d6dc;
  border-radius: 6px;
  background: #fafbfc;
  font: 12px/1.35 system-ui, -apple-system, sans-serif;
  color: #222;
}
.rv-obs-head {
  display: flex;
  align-items: center;
  gap: .4em;
  cursor: pointer;
  user-select: none;
  font-weight: 600;
}
.rv-obs-head-caret {
  display: inline-block;
  transition: transform 140ms ease;
  font-size: 10px;
  color: #666;
}
.rv-obs-panel.collapsed .rv-obs-head-caret { transform: rotate(-90deg); }
.rv-obs-panel.collapsed .rv-obs-body { display: none; }
.rv-obs-head-gen {
  margin-left: auto;
  font-weight: 400;
  font-size: 11px;
  color: #666;
}
.rv-obs-body { margin-top: .45em; }
.rv-obs-bar {
  display: flex;
  height: 14px;
  width: 100%;
  border-radius: 3px;
  overflow: hidden;
  background: #eceef2;
  margin-bottom: .45em;
}
.rv-obs-bar-seg {
  height: 100%;
  transition: width 160ms ease;
  min-width: 0;
}
.rv-obs-bar-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  color: #62666c;
  font-size: 11px;
}
.rv-obs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.rv-obs-table th, .rv-obs-table td {
  padding: 2px 6px;
  text-align: right;
  border-bottom: 1px solid #eceef2;
}
.rv-obs-table th:first-child, .rv-obs-table td:first-child { text-align: left; }
.rv-obs-swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: .35em;
  vertical-align: middle;
}
.rv-obs-footer {
  margin-top: .4em;
  font-size: 10.5px;
  color: #62666c;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.rv-obs-footer a { color: #1864ab; text-decoration: none; }
.rv-obs-footer a:hover { text-decoration: underline; }
`;

let _styleInjected = false;
function _ensureStyle() {
  if (_styleInjected) return;
  if (typeof document === 'undefined') return;
  const s = document.createElement('style');
  s.setAttribute('data-rv-obs-style', '1');
  s.textContent = STYLE;
  document.head.appendChild(s);
  _styleInjected = true;
}

function _fmtMs(ms) {
  if (!(ms > 0)) return '—';
  if (ms < 1) return ms.toFixed(2) + 'ms';
  if (ms < 10) return ms.toFixed(1) + 'ms';
  return Math.round(ms) + 'ms';
}

export function mountObservabilityPanel(containerEl, getStats) {
  if (!containerEl) return { destroy: () => {} };
  _ensureStyle();

  // Default-expanded: it's pure telemetry and the task prefers
  // discoverability. The header click toggles the `collapsed` class.
  containerEl.classList.add('rv-obs-panel');
  containerEl.innerHTML = [
    '<div class="rv-obs-head" data-obs="head">',
    '  <span class="rv-obs-head-caret">▼</span>',
    '  <span>⏱ Where the time goes</span>',
    '  <span class="rv-obs-head-gen" data-obs="gen"></span>',
    '</div>',
    '<div class="rv-obs-body" data-obs="body">',
    '  <div class="rv-obs-bar" data-obs="bar"></div>',
    '  <table class="rv-obs-table" data-obs="table">',
    '    <thead><tr><th>stage</th><th>count</th><th>avg</th><th>p95</th><th>%</th></tr></thead>',
    '    <tbody data-obs="tbody"></tbody>',
    '  </table>',
    '  <div class="rv-obs-footer">',
    '    <span data-obs="footer-info"></span>',
    '    <a href="#" data-obs="learn" data-eli15="where-the-time-goes">learn more</a>',
    '  </div>',
    '</div>',
  ].join('');

  const head   = containerEl.querySelector('[data-obs="head"]');
  const gen    = containerEl.querySelector('[data-obs="gen"]');
  const bar    = containerEl.querySelector('[data-obs="bar"]');
  const tbody  = containerEl.querySelector('[data-obs="tbody"]');
  const foot   = containerEl.querySelector('[data-obs="footer-info"]');
  const learn  = containerEl.querySelector('[data-obs="learn"]');

  head.addEventListener('click', () => {
    containerEl.classList.toggle('collapsed');
  });

  // The ELI15 tour is mounted elsewhere (eli15/index.js); we just fire
  // a custom event so the tour wiring can pick it up if present. Safe
  // no-op when the tour isn't live.
  learn.addEventListener('click', (e) => {
    e.preventDefault();
    try {
      const ev = new CustomEvent('eli15:open', { detail: { id: 'where-the-time-goes' }, bubbles: true });
      learn.dispatchEvent(ev);
      if (typeof window !== 'undefined' && window.ELI15 && typeof window.ELI15.openChapter === 'function') {
        window.ELI15.openChapter('where-the-time-goes');
      }
    } catch (_) { /* tour not loaded — ignore */ }
  });

  let _stopped = false;
  let _rafHandle = null;
  let _lastPaint = 0;
  const POLL_MIN_MS = 100; // 10Hz

  function _paint() {
    let stats = null;
    try { stats = getStats ? getStats() : null; } catch (_) { stats = null; }

    if (!stats) {
      bar.innerHTML = '<div class="rv-obs-bar-empty">waiting for bridge…</div>';
      tbody.innerHTML = '';
      gen.textContent = '';
      foot.textContent = 'timings will appear after the first generation';
      return;
    }

    const timings = stats.timings || { stages: {}, window: 0, lastGen: -1 };
    const stages = timings.stages || {};
    const stageNames = Object.keys(stages);

    gen.textContent = (timings.lastGen >= 0)
      ? `gen ${timings.lastGen} · window ${timings.window}`
      : `window ${timings.window}`;

    // Order: known stages first in STAGE_ORDER sequence, then any
    // novel stage names the bridge might emit (forwards-compat).
    const ordered = [];
    for (const n of STAGE_ORDER) if (stages[n]) ordered.push(n);
    for (const n of stageNames) if (!ordered.includes(n)) ordered.push(n);

    // Compute totals based on avgMs — the panel is showing "per-gen
    // average time", which is what a learner actually wants. Using
    // totalMs would weight whichever stage happens to have the most
    // samples in the window, which is noise.
    let totalAvg = 0;
    for (const n of ordered) totalAvg += stages[n].avgMs || 0;

    if (!(totalAvg > 0)) {
      bar.innerHTML = '<div class="rv-obs-bar-empty">no samples yet</div>';
    } else {
      const segs = [];
      for (const n of ordered) {
        const avg = stages[n].avgMs || 0;
        if (avg <= 0) continue;
        const pct = (avg / totalAvg) * 100;
        const colour = STAGE_COLOURS[n] || STAGE_COLOURS.misc;
        segs.push(
          `<div class="rv-obs-bar-seg" style="width:${pct.toFixed(2)}%;background:${colour}" ` +
          `title="${n}: ${_fmtMs(avg)} (${pct.toFixed(1)}%)"></div>`
        );
      }
      bar.innerHTML = segs.join('');
    }

    const rows = [];
    for (const n of ordered) {
      const s = stages[n];
      const pct = (totalAvg > 0) ? ((s.avgMs || 0) / totalAvg) * 100 : 0;
      const colour = STAGE_COLOURS[n] || STAGE_COLOURS.misc;
      rows.push(
        '<tr>' +
        `<td><span class="rv-obs-swatch" style="background:${colour}"></span>${n}</td>` +
        `<td>${s.count}</td>` +
        `<td>${_fmtMs(s.avgMs)}</td>` +
        `<td>${_fmtMs(s.p95Ms)}</td>` +
        `<td>${pct.toFixed(1)}%</td>` +
        '</tr>'
      );
    }
    tbody.innerHTML = rows.join('');

    const archive = stats.archive || {};
    const idx = stats.index || {};
    const parts = [];
    if (archive.brains != null) parts.push(`${archive.brains} brains`);
    if (idx.kind) parts.push(idx.kind);
    if (idx.hnsw && idx.hnsw.len != null) parts.push(`hnsw=${idx.hnsw.len}`);
    const fed = stats.federation;
    if (fed && fed.enabled) parts.push(`federation: ${fed.shards}× shards`);
    foot.textContent = parts.join(' · ') || 'ready';
  }

  function _loop(ts) {
    if (_stopped) return;
    if (ts - _lastPaint >= POLL_MIN_MS) {
      _paint();
      _lastPaint = ts;
    }
    _rafHandle = requestAnimationFrame(_loop);
  }

  _paint(); // initial paint so the panel isn't empty before first rAF tick
  if (typeof requestAnimationFrame === 'function') {
    _rafHandle = requestAnimationFrame(_loop);
  } else {
    // headless fallback — useful for unit tests that mount without rAF
    _rafHandle = setInterval(_paint, POLL_MIN_MS);
  }

  return {
    destroy() {
      _stopped = true;
      if (typeof cancelAnimationFrame === 'function' && _rafHandle != null) {
        cancelAnimationFrame(_rafHandle);
      } else if (_rafHandle != null) {
        clearInterval(_rafHandle);
      }
      _rafHandle = null;
    },
    _paintNow: _paint, // test-only — skip the rAF gate
  };
}
