# ADR-001: ruvector Audit Panel

- **Status**: accepted
- **Date**: 2026-05-29
- **Deciders**: @Tovli
- **Tags**: observability, ruvector, ui, presentation-layer

> Tracks GitHub issue [shaal/VrumVector#3 — "Adding ruvector audit panel"](https://github.com/shaal/VrumVector/issues/3).

## Context

VectorVroom is a teaching artifact as much as a game: people open it to *understand
what ruvector does on the edge*. Issue #3 asks for a panel that surfaces "all the
interactions the presentation layer has with ruvector," with the observation that
those interactions are essentially **search / store / vote**.

That observation is accurate. The entire presentation layer (`AI-Car-Racer/main.js`)
talks to ruvector through a single global handle, `window.__rvBridge`, which is the
module `AI-Car-Racer/ruvectorBridge.js`. The public surface the UI actually exercises
reduces to four primitives:

| Category | Bridge export | Call site | Vector-DB effect |
|----------|---------------|-----------|------------------|
| **embed**  | `embedTrack(imageData, w, h)`              | track snapshot | CNN → 512-dim track vector |
| **search** | `recommendSeeds(trackVec, k)`, `findSimilarCircuits(trackVec, k)` | `main.js:1068` | HNSW k-NN over the brain / track indexes |
| **store**  | `archiveBrain(brain, fitness, trackVec, …)` | `main.js:1293` | `insert()` into brain + track (+ dynamics) indexes |
| **vote**   | `observe(retrievedIds, outcomeFitness)`     | `main.js:1303` | EMA re-weighting that biases future rerank ordering |

Today this traffic is **invisible**. The existing **Vector Memory** panel
(`AI-Car-Racer/uiPanels.js`, mounted on `#rv-panel`) shows *aggregate state*
(`info()` / `getIndexStats()`: brain count, reranker mode, LoRA drift, SONA stats),
but never the *event stream* — you cannot watch a `search` fire, see which brains it
returned, or see the `vote` that followed. For a learning tool, the per-call timeline
is the most pedagogically valuable view and the one the issue is asking for.

A secondary motivation in the issue: the same search/store/vote vocabulary is what the
**server edition** of ruvector exposes, so making the edge interactions legible
doubles as a primer for the server API.

### Constraints from the existing architecture

- **No build step.** Pure static ES modules + vendored WASM. The solution must be
  plain JS with no new tooling.
- **Established "additive, fallback-safe, off-by-default" discipline.** Federation,
  cross-tab, dynamics, and hyperbolic indexing all follow the same pattern: a runtime
  flag, byte-identical behaviour when disabled, graceful degrade when a dependency is
  missing. A new feature should match this.
- **There is already a precedent for a UI observation hook**: `setFederationCapturer({ onSnapshot })`
  and `setCrosstabListeners({ onReceive, onPeerCount })` let the panel subscribe to
  bridge-internal events without the bridge knowing about the DOM. The audit tap should
  reuse this exact shape rather than invent a new one.

## Decision

Add an **audit tap inside `ruvectorBridge.js`** plus a **collapsible "Audit log"
section in the existing `#rv-panel`**, following the established capturer/listener
pattern.

**1. Instrument at the bridge boundary, not the call sites.** Wrap the four public
primitives (`recommendSeeds`, `findSimilarCircuits`, `archiveBrain`, `observe`; and
optionally `embedTrack`) so each appends one structured record to a bounded in-memory
ring buffer:

```js
// shape of one audit record
{ seq, t, op, args, result, raw, ms }
//   op: 'search' | 'store' | 'vote' | 'embed'
//   args:   compact, vector-free summary (e.g. { k, trackDim } / { fitness, generation })
//   result: compact summary (e.g. { returned: 5, topId, topScore } / { id })
//   raw:    string representation of the raw request payload (see Decision 2)
//   ms:     wall-clock duration of the call
```

Instrumenting at the bridge boundary (rather than at `main.js` call sites) means the
log also captures non-`main.js` callers — cross-tab `_onRemoteBrain` re-entry, snapshot
import, and test harnesses — giving a *complete* picture of edge traffic, which is the
issue's actual ask.

**2. Ring buffer, capped (e.g. last 200 events). Each record also carries a string
representation of the raw request** — the literal payload handed to ruvector, rendered
as a string (e.g. `JSON.stringify` of the call arguments, with Float32Array vectors
serialized as a bracketed, head-truncated preview such as
`Float32Array(512)[0.12, -0.03, 0.08, …]`). Seeing the actual request body is the
pedagogical core of the panel: it is what makes the edge API legible and maps directly
onto the request shape of the ruvector **server** edition. The compact scalar
`args`/`result` summaries are kept alongside it for the at-a-glance list view, with the
full raw-request string revealed on expand. Vector previews are head-truncated (not full
payloads) to bound buffer size; capturing full untruncated vectors stays an explicit,
off-by-default opt-in.

**3. Expose a subscription API mirroring `setFederationCapturer`:**

```js
export function subscribeAudit(fn)   // fn(record) called on each event; returns unsubscribe
export function getAuditLog()        // returns a copy of the ring buffer (for late mounts)
export function clearAuditLog()
```

When `_auditEnabled` is false, the wrappers short-circuit before touching
`_auditLog`, so the disabled state pays only one boolean check. When
`_auditEnabled` is true, `_recordAudit` appends to `_auditLog` even before
`subscribeAudit` attaches a listener; this preserves the late-mount/backfill
contract that `getAuditLog` exposes. With no subscribers, only the fan-out work is
skipped, matching the optional UI-hook shape used by `_federationCapturer` and
`_crosstabOnReceive`. `clearAuditLog` resets the in-memory buffer only.

**4. Render a collapsible "Audit log" section in `#rv-panel`** (uiPanels.js): a
reverse-chronological list of recent events with op badge, relative time, and the
arg/result summary; a small "search N · store N · vote N" counter header; and a Clear
button. Gated behind the existing 🧪 Experiments toggle group so it is discoverable but
not in the default view.

**5. Off by default; opt-in via the Experiments panel** (and optionally a `?audit=1`
URL flag, consistent with `?hhnsw=1` / `?crosstab=1`). When off, `subscribeAudit` is
never called and `recommendSeeds`/`archiveBrain` are byte-identical to today.

## Consequences

### Positive
- Makes the edge ruvector API legible exactly as issue #3 requests — search/store/vote
  become a watchable timeline, strong for the "learning tool" goal.
- Single chokepoint: instrumenting the bridge boundary captures *all* callers, not just
  `main.js`.
- Reuses the proven capturer/listener pattern, so it composes with federation,
  cross-tab, and consistency modes without special-casing.
- Zero new tooling; ships in the static no-build deploy.
- The audit-record vocabulary is a ready-made primer for the ruvector **server** API.

### Negative
- Adds a small wrapper layer on two hot-path functions (`recommendSeeds`,
  `archiveBrain`). Mitigated by the disabled-state short-circuit (one boolean check), and
  by building the raw-request string only while `_auditEnabled` is true with
  head-truncated vector previews so a record stays small.
- One more panel section to maintain in an already-dense `uiPanels.js`.
- The ring buffer is session-scoped and in-memory; events are lost on reload (an
  acceptable scope cut — persistence is explicitly out of scope for v1).

### Neutral
- **Alternative considered — instrument at `main.js` call sites.** Rejected: scatters
  logging logic and misses internal/cross-tab/import calls, so the log would be
  incomplete.
- **Alternative considered — a logging Proxy around `window.__rvBridge`.** Rejected:
  the bridge-internal tap is closer to existing conventions and naturally sees internal
  re-entry that never passes through the global handle.
- **Alternative considered — a separate `#rv-audit-panel` root.** Deferred in favour of
  a section inside `#rv-panel` to keep all vector-memory observability in one place; can
  be promoted to its own panel later if it grows.

## Links
- Issue: https://github.com/shaal/VrumVector/issues/3
- Bridge surface: `AI-Car-Racer/ruvectorBridge.js` (`recommendSeeds`, `archiveBrain`, `observe`, `embedTrack`)
- Existing UI-hook precedent: `setFederationCapturer`, `setCrosstabListeners` in `ruvectorBridge.js`
- Panel host: `AI-Car-Racer/uiPanels.js` (`#rv-panel`)
- Aggregate-state precedent: `info()`, `getIndexStats()` in `ruvectorBridge.js`
