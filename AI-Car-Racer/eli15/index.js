// eli15/index.js — teaching-drawer framework.
//
// Loaded as a classic <script> (matches the rest of the app's no-build
// pattern); chapters are lazy-loaded ES modules via dynamic import().
//
// Public surface (window.ELI15):
//   .openChapter(id)  — show the drawer with chapter `id` loaded
//   .closeDrawer()    — hide the drawer
//   .toggleDrawer()   — toggle with the last-viewed chapter (defaults to welcome)
//   .register(id, descriptor)  — add a chapter entry at runtime (for later phases)
//   .listChapters()   — return the registry (id → {title, oneLiner})
//
// Badge pattern: any element with [data-eli15="chapter-id"] becomes a clickable
// help badge. We attach one delegated listener on document rather than per-badge
// so later phases can inject badges into dynamically-rendered panels (e.g.
// rv-panel tick) without having to re-bind.

(function () {
  if (typeof window === 'undefined' || window.ELI15) return;

  // ─── registry ──────────────────────────────────────────────────────────
  // Static map — edit one line here + drop one file in chapters/ to add a
  // chapter. `loader` returns a Promise<{default: ChapterBody}>; the import
  // is deferred until the user actually opens the chapter.
  // Registry ordering is pedagogical (Phase 3B): Foundations → Vector memory
  // basics → Lineage & reasoning → Geometry choice → RuLake-inspired
  // extensions. The tour.js playlist follows the same arc. See
  // docs/plan/rulake-inspired-features.md §3B.
  const REGISTRY = {
    // ─── Foundations ───────────────────────────────────────────────────────
    'what-is-this-project': {
      title: 'What is this project even doing?',
      oneLiner: 'A browser-based genetic-algorithm racer with a vector-memory bridge.',
      loader: function () { return import('./chapters/what-is-this-project.js'); },
    },
    'sensors': {
      title: 'The car\'s eyes are seven invisible rays',
      oneLiner: 'Ray-cast sensors feed a number per ray into the neural network.',
      loader: function () { return import('./chapters/sensors.js'); },
    },
    'neural-network': {
      title: 'A brain made of 244 numbers',
      oneLiner: 'Ten sensor inputs → sixteen hidden neurons → four pedal/steer outputs.',
      loader: function () { return import('./chapters/neural-network.js'); },
    },
    'why-cars-crash': {
      title: 'Why your car keeps driving into walls',
      oneLiner: 'Four reasons: frozen reflexes, random gen-0, elite lock-in, and physics.',
      loader: function () { return import('./chapters/why-cars-crash.js'); },
    },
    'pure-local-experiment': {
      title: 'Pure local signals vs track hints',
      oneLiner: 'What happens when we remove the "next checkpoint" features and force the brain to drive from raw sensors only?',
      loader: function () { return import('./chapters/pure-local-experiment.js'); },
    },
    'genetic-algorithm': {
      title: 'Breeding brains instead of training them',
      oneLiner: 'Copy the winners, nudge their weights, discard the losers. Repeat.',
      loader: function () { return import('./chapters/genetic-algorithm.js'); },
    },
    'fitness-function': {
      title: 'How we decide which car is "best"',
      oneLiner: 'Checkpoints passed + completed laps × track length.',
      loader: function () { return import('./chapters/fitness-function.js'); },
    },

    // ─── Vector memory basics ──────────────────────────────────────────────
    'cnn-embedder': {
      title: 'Turning a track picture into 512 numbers',
      oneLiner: 'A tiny CNN squashes a track drawing into a fixed-length vector we can compare.',
      loader: function () { return import('./chapters/cnn-embedder.js'); },
    },
    'vectordb-hnsw': {
      title: 'Nearest-neighbour search that doesn\'t scan everything',
      oneLiner: 'HNSW builds a multi-layer graph so queries only touch log(N) vectors.',
      loader: function () { return import('./chapters/vectordb-hnsw.js'); },
    },
    'track-similarity': {
      title: 'Not starting from scratch on every new track',
      oneLiner: 'Use brains that did well on similar-shaped past tracks as starting seeds.',
      loader: function () { return import('./chapters/track-similarity.js'); },
    },
    'ema-reranker': {
      title: 'Learning which recommendations actually help',
      oneLiner: 'An EMA per retrieved brain nudges future rankings toward ones that paid off.',
      loader: function () { return import('./chapters/ema-reranker.js'); },
    },

    // ─── Lineage & reasoning ───────────────────────────────────────────────
    'lineage': {
      title: 'Every brain has parents',
      oneLiner: 'parentIds + getLineage() reconstruct a brain\'s family tree on demand.',
      loader: function () { return import('./chapters/lineage.js'); },
    },
    'lineage-dag': {
      title: 'Lineage as a DAG — a family tree with no time-loops',
      oneLiner: 'Parents point to children; cycles rejected at insert. Powers the 🌳 Lineage viewer.',
      loader: function () { return import('./chapters/lineage-dag.js'); },
    },
    'gnn': {
      title: 'GNN reranker — like EMA, but with peer pressure',
      oneLiner: 'A tiny graph neural network that lets parent brains\' scores nudge their children\'s.',
      loader: function () { return import('./chapters/gnn.js'); },
    },
    'lora': {
      title: 'LoRA — a tiny matrix that bends the embedding',
      oneLiner: 'Two skinny matrices learn to nudge the 512-number track vector toward better-retrieving arrangements.',
      loader: function () { return import('./chapters/lora.js'); },
    },
    'sona-trajectory': {
      title: 'SONA trajectories — framing a whole session\'s worth of driving',
      oneLiner: 'A trajectory is the tape recording of one training run — steps of (what the car saw, how well it did).',
      loader: function () { return import('./chapters/trajectory.js'); },
    },
    'reasoningbank': {
      title: 'ReasoningBank — clusters of "situations that looked alike"',
      oneLiner: 'k-means over trajectory embeddings turns many generations of driving into a handful of reusable patterns.',
      loader: function () { return import('./chapters/reasoningbank.js'); },
    },
    'ewc': {
      title: 'EWC++ — learning new tracks without forgetting old ones',
      oneLiner: 'A penalty term that pins "important" weights so fine-tuning on a new track doesn\'t clobber prior skills.',
      loader: function () { return import('./chapters/ewc.js'); },
    },
    'dynamics-embedding': {
      title: 'Dynamics embedding — how the car drove, not just what it saw',
      oneLiner: 'Squash a whole lap of sensor+control readings into a single 64-number vector we can search on.',
      loader: function () { return import('./chapters/dynamics-embedding.js'); },
    },

    // ─── Geometry choice ───────────────────────────────────────────────────
    'hyperbolic-space': {
      title: 'Hyperbolic HNSW — why trees fit better on a saddle',
      oneLiner: 'Swap the flat-space neighbour graph for a Poincaré-ball one; trees embed with less distortion.',
      loader: function () { return import('./chapters/hyperbolic-space.js'); },
    },

    // ─── RuLake-inspired extensions (Phase 1/2/3 per
    //     docs/plan/rulake-inspired-features.md). Ordered so that the
    //     dedup/hash primitive (F5) lands before the features that compose
    //     with it: quantization (archive size claim), warm-restart (hash-
    //     keyed lineage), consistency (hash-stable freeze), federation (hash
    //     de-duplicates the cross-shard union), cross-tab (hash-indexed wire
    //     convergence), and the observability panel last. ─────────────────
    'content-addressing': {
      title: 'Giving every brain a fingerprint',
      oneLiner: 'ID brains by hash of their weights; duplicates collide, the DAG stops double-counting, cross-tab sync becomes free.',
      related: ['lineage-dag', 'warm-restart'],
      loader: function () { return import('./chapters/content-addressing.js'); },
    },
    'quantization': {
      title: 'Throwing away 31/32 bits and still finding the right neighbour',
      oneLiner: 'RaBitQ + Hadamard: shrink the archive 32× without losing recall.',
      related: ['vectordb-hnsw', 'federation'],
      loader: function () { return import('./chapters/quantization.js'); },
    },
    'warm-restart': {
      title: 'Saving and reopening the whole brain archive',
      oneLiner: 'A brain archive is a museum — you can save it, reopen it tomorrow, or give it to a friend.',
      related: ['lineage-dag', 'content-addressing'],
      loader: function () { return import('./chapters/warm-restart.js'); },
    },
    'consistency-modes': {
      title: 'Fresh / Eventual / Frozen — three ways training looks at the archive',
      oneLiner: 'Re-query every generation, periodically, or lock in a snapshot. Three modes, one radio row.',
      related: ['warm-restart', 'track-similarity'],
      loader: function () { return import('./chapters/consistency-modes.js'); },
    },
    'federation': {
      title: 'Asking two different maps of brain-space at once',
      oneLiner: 'Query Euclidean + Hyperbolic in parallel; over-request k\' = k + ⌈√(k ln S)⌉; GNN reranks the union.',
      related: ['vectordb-hnsw', 'hyperbolic-space', 'gnn'],
      loader: function () { return import('./chapters/federation.js'); },
    },
    'cross-tab-federation': {
      title: 'Two browser tabs training in sync',
      oneLiner: 'BroadcastChannel + content-addressing = lockless cross-tab archive convergence.',
      related: ['content-addressing', 'warm-restart'],
      loader: function () { return import('./chapters/cross-tab-federation.js'); },
    },
    'where-the-time-goes': {
      title: 'Where each generation\'s milliseconds actually go',
      oneLiner: 'Per-stage timings: HNSW / rerank / LoRA / sensor embed / GA. Observability as a teaching tool.',
      related: ['federation', 'gnn', 'cnn-embedder'],
      loader: function () { return import('./chapters/where-the-time-goes.js'); },
    },
  };

  // In-memory chapter body cache: once loaded, reuse on subsequent opens.
  const BODY_CACHE = new Map();
  let lastChapterId = null;

  // ─── drawer DOM ────────────────────────────────────────────────────────
  let drawerEl = null;
  let titleEl = null;
  let oneLinerEl = null;
  let bodyEl = null;
  let diagramEl = null;
  let relatedEl = null;
  let backdropEl = null;
  let fabEl = null;

  // ─── popover DOM (anchored to badges) ───────────────────────────────────
  // Single-badge clicks show this lightweight card next to the anchor so the
  // element the user clicked stays visible. The heavier drawer is reserved
  // for the "Read full chapter" escalation.
  let popoverEl = null;
  let popoverTitleEl = null;
  let popoverOneLinerEl = null;
  let popoverMoreBtn = null;
  let popoverRingEl = null;
  let popoverActiveId = null;
  let popoverActiveAnchor = null;

  function ensureDrawer() {
    if (drawerEl) return;

    backdropEl = document.createElement('div');
    backdropEl.className = 'eli15-backdrop';
    backdropEl.addEventListener('click', closeDrawer);

    drawerEl = document.createElement('aside');
    drawerEl.className = 'eli15-drawer';
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'true');
    drawerEl.setAttribute('aria-labelledby', 'eli15-title');
    drawerEl.setAttribute('aria-hidden', 'true');
    drawerEl.innerHTML = [
      '<header class="eli15-header">',
      '  <div class="eli15-header-text">',
      '    <div class="eli15-kicker">🎓 ELI15 — explain like I\'m fifteen</div>',
      '    <h2 id="eli15-title" class="eli15-title"></h2>',
      '    <p class="eli15-oneliner"></p>',
      '  </div>',
      '  <button class="eli15-close" type="button" aria-label="Close ELI15 drawer">×</button>',
      '</header>',
      '<div class="eli15-body"></div>',
      '<div class="eli15-diagram" hidden></div>',
      '<div class="eli15-related" hidden>',
      '  <div class="eli15-related-label">Related chapters</div>',
      '  <ul class="eli15-related-list"></ul>',
      '</div>',
    ].join('');

    titleEl = drawerEl.querySelector('.eli15-title');
    oneLinerEl = drawerEl.querySelector('.eli15-oneliner');
    bodyEl = drawerEl.querySelector('.eli15-body');
    diagramEl = drawerEl.querySelector('.eli15-diagram');
    relatedEl = drawerEl.querySelector('.eli15-related');

    drawerEl.querySelector('.eli15-close').addEventListener('click', closeDrawer);

    // Floating 🎓 button — always-available entry point. Plan P0.A calls for
    // "? key or 🎓 button in the phase bar". We don't have a dedicated phase
    // bar element, so a fixed-position FAB anchors to the viewport corner.
    fabEl = document.createElement('button');
    fabEl.type = 'button';
    fabEl.className = 'eli15-fab';
    fabEl.setAttribute('aria-label', 'Open ELI15 teaching drawer (shortcut: ?)');
    fabEl.title = 'ELI15 — explain like I\'m 15  (?)';
    // Pill with an emoji icon + text label on desktop; mobile CSS shrinks
    // this back to an emoji-only circle via .eli15-fab-label { display:none }.
    fabEl.innerHTML = '<span class="eli15-fab-icon" aria-hidden="true">🎓</span>'
                    + '<span class="eli15-fab-label">Explain anything</span>';
    fabEl.addEventListener('click', toggleDrawer);

    document.body.appendChild(backdropEl);
    document.body.appendChild(drawerEl);
    document.body.appendChild(fabEl);
  }

  function openDrawer() {
    ensureDrawer();
    drawerEl.classList.add('eli15-drawer-open');
    backdropEl.classList.add('eli15-backdrop-open');
    drawerEl.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    if (!drawerEl) return;
    drawerEl.classList.remove('eli15-drawer-open');
    backdropEl.classList.remove('eli15-backdrop-open');
    drawerEl.setAttribute('aria-hidden', 'true');
  }

  function toggleDrawer() {
    ensureDrawer();
    const isOpen = drawerEl.classList.contains('eli15-drawer-open');
    if (isOpen) {
      closeDrawer();
    } else {
      openChapter(lastChapterId || 'what-is-this-project');
    }
  }

  // ─── anchored popover ──────────────────────────────────────────────────
  function ensurePopover() {
    if (popoverEl) return;
    popoverEl = document.createElement('div');
    popoverEl.className = 'eli15-popover';
    popoverEl.hidden = true;
    popoverEl.setAttribute('role', 'dialog');
    popoverEl.innerHTML = [
      '<button type="button" class="eli15-popover-close" aria-label="Close">×</button>',
      '<h3 class="eli15-popover-title"></h3>',
      '<p class="eli15-popover-oneliner"></p>',
      '<div class="eli15-popover-actions">',
      '  <button type="button" class="eli15-popover-more">Read full chapter →</button>',
      '</div>',
    ].join('');
    popoverTitleEl = popoverEl.querySelector('.eli15-popover-title');
    popoverOneLinerEl = popoverEl.querySelector('.eli15-popover-oneliner');
    popoverMoreBtn = popoverEl.querySelector('.eli15-popover-more');
    popoverEl.querySelector('.eli15-popover-close').addEventListener('click', hidePopover);
    popoverMoreBtn.addEventListener('click', function () {
      const id = popoverActiveId;
      hidePopover();
      if (id) openChapter(id);
    });

    // Reuse the tour-ring visual styling to highlight the anchor.
    popoverRingEl = document.createElement('div');
    popoverRingEl.className = 'eli15-tour-ring';
    popoverRingEl.hidden = true;

    document.body.appendChild(popoverRingEl);
    document.body.appendChild(popoverEl);
  }

  function positionPopover(anchor) {
    const ar = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 10;

    // Ring: snap to the anchor with a small inflate so the highlight reads
    // as a glow around the badge rather than a tight border.
    const ringPad = 4;
    popoverRingEl.hidden = false;
    popoverRingEl.style.left   = (ar.left - ringPad) + 'px';
    popoverRingEl.style.top    = (ar.top - ringPad) + 'px';
    popoverRingEl.style.width  = (ar.width + ringPad * 2) + 'px';
    popoverRingEl.style.height = (ar.height + ringPad * 2) + 'px';

    // Popover: measure, then prefer to the LEFT of the anchor when the anchor
    // sits in the right half of the viewport (e.g. inside #rightPanel); else
    // go below. Clamp to viewport.
    popoverEl.hidden = false;
    popoverEl.style.visibility = 'hidden';  // measure without flicker
    popoverEl.style.left = '0px';
    popoverEl.style.top = '0px';
    const pr = popoverEl.getBoundingClientRect();
    const pw = pr.width;
    const ph = pr.height;

    let x, y;
    const anchorInRightHalf = (ar.left + ar.width / 2) > vw / 2;
    if (anchorInRightHalf && ar.left - pw - pad > pad) {
      x = ar.left - pw - pad;
      y = ar.top + ar.height / 2 - ph / 2;
    } else if (!anchorInRightHalf && ar.right + pw + pad < vw - pad) {
      x = ar.right + pad;
      y = ar.top + ar.height / 2 - ph / 2;
    } else if (ar.bottom + ph + pad < vh - pad) {
      x = ar.left + ar.width / 2 - pw / 2;
      y = ar.bottom + pad;
    } else {
      x = ar.left + ar.width / 2 - pw / 2;
      y = ar.top - ph - pad;
    }
    x = Math.max(pad, Math.min(x, vw - pw - pad));
    y = Math.max(pad, Math.min(y, vh - ph - pad));

    popoverEl.style.left = x + 'px';
    popoverEl.style.top = y + 'px';
    popoverEl.style.visibility = 'visible';
  }

  function showPopover(id, anchor) {
    ensurePopover();
    const entry = REGISTRY[id];
    if (!entry) return;
    popoverActiveId = id;
    popoverActiveAnchor = anchor;
    popoverTitleEl.textContent = entry.title;
    popoverOneLinerEl.textContent = entry.oneLiner || '';
    positionPopover(anchor);
    // Move focus to the CTA so keyboard users can press Enter for full chapter.
    try { popoverMoreBtn.focus({ preventScroll: true }); } catch (e) { /* Safari preventScroll */ }
  }

  function hidePopover() {
    if (!popoverEl) return;
    popoverEl.hidden = true;
    if (popoverRingEl) popoverRingEl.hidden = true;
    popoverActiveId = null;
    popoverActiveAnchor = null;
  }

  // ─── chapter load + render ─────────────────────────────────────────────

  function openChapter(id) {
    ensureDrawer();
    const entry = REGISTRY[id];
    if (!entry) {
      renderError(id, 'Chapter not found. Check eli15/registry.');
      openDrawer();
      return;
    }
    lastChapterId = id;
    openDrawer();

    // Show a loading state immediately so the drawer doesn't look frozen on
    // first open (the dynamic import adds a round-trip even for already-cached
    // modules on slow disks).
    titleEl.textContent = entry.title;
    oneLinerEl.textContent = entry.oneLiner || '';
    bodyEl.innerHTML = '<p class="eli15-loading">Loading…</p>';
    diagramEl.hidden = true;
    relatedEl.hidden = true;

    const cached = BODY_CACHE.get(id);
    if (cached) {
      renderBody(id, cached);
      return;
    }

    entry.loader().then(function (mod) {
      const body = (mod && mod.default) ? mod.default : mod;
      BODY_CACHE.set(id, body);
      // User may have navigated away before the import resolved; only render
      // if this chapter is still the active one.
      if (lastChapterId === id) renderBody(id, body);
    }).catch(function (err) {
      console.error('[eli15] failed to load chapter "' + id + '"', err);
      if (lastChapterId === id) renderError(id, String(err && err.message || err));
    });
  }

  function renderBody(id, body) {
    // Chapters ship authored HTML strings. They are *not* user input — we
    // trust them the same way we trust any other file in the repo — so
    // assignment is fine. If you ever expose chapter content to untrusted
    // authors, switch to a sanitiser here.
    bodyEl.innerHTML = (body && body.body) || '<p>(chapter has no body)</p>';
    if (body && body.diagram) {
      diagramEl.innerHTML = body.diagram;
      diagramEl.hidden = false;
    } else {
      diagramEl.hidden = true;
    }
    renderRelated(body && body.related);
  }

  function renderRelated(relatedIds) {
    if (!Array.isArray(relatedIds) || relatedIds.length === 0) {
      relatedEl.hidden = true;
      return;
    }
    const list = relatedEl.querySelector('.eli15-related-list');
    list.innerHTML = '';
    let rendered = 0;
    for (const rid of relatedIds) {
      const entry = REGISTRY[rid];
      if (!entry) continue; // quietly skip forward-references to unshipped chapters
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'eli15-related-link';
      a.textContent = entry.title;
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        openChapter(rid);
      });
      li.appendChild(a);
      list.appendChild(li);
      rendered += 1;
    }
    relatedEl.hidden = (rendered === 0);
  }

  function renderError(id, msg) {
    titleEl.textContent = 'Chapter not available';
    oneLinerEl.textContent = id;
    bodyEl.innerHTML =
      '<p class="eli15-error">Could not load chapter <code>' + escapeHtml(id) +
      '</code>.</p><pre class="eli15-error-detail">' + escapeHtml(msg) + '</pre>';
    diagramEl.hidden = true;
    relatedEl.hidden = true;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return (
        c === '&' ? '&amp;' :
        c === '<' ? '&lt;' :
        c === '>' ? '&gt;' :
        c === '"' ? '&quot;' : '&#39;'
      );
    });
  }

  // ─── input handlers ────────────────────────────────────────────────────

  function isTypingContext(ev) {
    const t = ev.target;
    if (!t) return false;
    const tag = (t.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    return false;
  }

  document.addEventListener('keydown', function (ev) {
    // `?` is Shift+/ on US layouts. Modern browsers deliver ev.key === '?'.
    // We skip when the user is typing or combining with Ctrl/Meta so we don't
    // eat browser shortcuts.
    if (isTypingContext(ev)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === '?') {
      ev.preventDefault();
      toggleDrawer();
      return;
    }
    if (ev.key === 'Escape') {
      // Dismiss popover first (it's the lighter layer), then drawer. Lets the
      // user escape a quick glance without blowing away the full chapter if
      // both happen to be stacked.
      if (popoverEl && !popoverEl.hidden) {
        ev.preventDefault();
        hidePopover();
        return;
      }
      if (drawerEl && drawerEl.classList.contains('eli15-drawer-open')) {
        ev.preventDefault();
        closeDrawer();
      }
    }
  });

  // Delegated click: badge clicks open the anchored popover (progressive
  // disclosure — summary first, "Read full chapter" escalates to the drawer).
  // A click anywhere else while the popover is open dismisses it, as long as
  // the click wasn't inside the popover or on another badge.
  document.addEventListener('click', function (ev) {
    const t = ev.target;
    const badge = t && t.closest && t.closest('[data-eli15]');
    if (badge) {
      const id = badge.getAttribute('data-eli15');
      if (!id) return;
      ev.preventDefault();
      // Click the same badge a second time → dismiss (toggle).
      if (popoverActiveAnchor === badge && popoverEl && !popoverEl.hidden) {
        hidePopover();
      } else {
        showPopover(id, badge);
      }
      return;
    }
    // Outside-click dismiss. Ignore clicks inside the popover itself so the
    // "Read full chapter" button and the × button can do their thing.
    if (popoverEl && !popoverEl.hidden && !(t && popoverEl.contains(t))) {
      hidePopover();
    }
  });

  // Reposition on viewport changes so the popover stays anchored if the
  // right panel or #liveData resizes (happens during phase transitions and
  // when the user resizes the window).
  window.addEventListener('resize', function () {
    if (popoverActiveAnchor && popoverEl && !popoverEl.hidden) {
      positionPopover(popoverActiveAnchor);
    }
  });
  window.addEventListener('scroll', function () {
    if (popoverActiveAnchor && popoverEl && !popoverEl.hidden) {
      positionPopover(popoverActiveAnchor);
    }
  }, true /* capture — catch scrolls inside #rightPanel too */);

  // ─── public API ────────────────────────────────────────────────────────

  window.ELI15 = {
    openChapter: openChapter,
    closeDrawer: closeDrawer,
    toggleDrawer: toggleDrawer,
    register: function (id, descriptor) { REGISTRY[id] = descriptor; },
    listChapters: function () {
      const out = {};
      for (const k of Object.keys(REGISTRY)) {
        out[k] = { title: REGISTRY[k].title, oneLiner: REGISTRY[k].oneLiner };
      }
      return out;
    },
  };

  // Build the drawer eagerly so the FAB is available before the user presses
  // anything. Cheap — creates ~200 bytes of DOM and attaches three listeners.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureDrawer, { once: true });
  } else {
    ensureDrawer();
  }
})();
