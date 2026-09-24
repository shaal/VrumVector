# ruvector upstream patches — workflow concerns

**Status:** Option 3 shipped 2026-04-21 — the repo is now reproducible on
its own. Option 1 (upstream PR) is the outstanding next step; that
requires pushing to `shaal/ruvector` and opening a PR against
`ruvnet/ruvector`, so it's gated on explicit user approval rather than
sitting in the backlog forever. See "Decision needed" at the bottom.

**Update 2026-09-24:** SONA is rebuilt on upstream `5356a84e2` (CI, Rust
1.85.0, wasm-pack 0.13.1). Upstream #481 fixed the `get_patterns` stub, so
`sona-find-patterns.patch` now only adds `find_patterns(query, k)` and its
`findPatterns` binding. An upstream PR would now carry `find_patterns` and the
checkpoint bindings only. Upstream also rewrote its `main` history: the old
base `d5d3296cd` is no longer an ancestor of `origin/main`.

---

## What this document is

A placeholder for figuring out how we apply, track, and publish fixes to
`@ruvector/sona` (and its siblings under `ruvnet/ruvector`) when we find
bugs that block our work. The ruvector repo is not ours; we consume it as
vendored WASM artifacts. When we need a fix, the current workflow is
informal and reproducibility-hostile.

Not a design doc yet. A list of concerns, options, and trade-offs so that
a future conversation (this one or a later one) can pick it up cold.

---

## Current state (what actually exists on disk)

1. **Consumer repo (this one, `car-learning`):**
   - Imports WASM via `import initSona, { WasmEphemeralAgent } from '../../vendor/ruvector/sona/ruvector_sona.js'`.
   - Vendored artifacts live under `vendor/ruvector/<crate>/` and are
     committed to git. End users never rebuild them.
   - `scripts/vendor-ruvector.sh` is a maintainer-only script that runs
     `wasm-pack build` against a ruvector crate and copies the resulting
     `pkg/` contents into `vendor/ruvector/<crate>/`. Takes a crate path
     as its first arg.
   - `vendor/ruvector/sona/VENDORED.md` records the upstream commit SHA
     and `git describe` output at build time.

2. **Upstream source (not ours):**
   - Lives at `~/code/utilities/ruvector/` on the current machine. It's a
     checkout of `git@github.com:ruvnet/ruvector.git`.
   - Has uncommitted local edits applied during P2.A — see the "Patch
     currently carried locally" section below.

3. **The coupling:**
   - The vendor script calls `wasm-pack` against that local checkout.
     Whatever state that checkout is in (clean, dirty, on a fork branch,
     at some random SHA) is baked into the committed WASM.
   - `VENDORED.md` transparently records it as, e.g.,
     `v2.2.0-21-gd5d3296c-dirty` — the `-dirty` suffix is the only signal
     that our build included uncommitted work.

---

## Patch currently carried locally (as of 2026-04-21)

Two files edited in `~/code/utilities/ruvector/crates/sona/src/`:

1. **`training/federated.rs`** (around line 234):
   - `EphemeralAgent::get_patterns()` was calling
     `self.engine.find_patterns(&[], 0)` — an empty-query/k=0 lookup that
     always returns an empty `Vec`. This was almost certainly a
     stub-that-compiles left over from scaffolding.
   - Replaced with `self.engine.get_all_patterns()` so consumers actually
     get the learned patterns back.
   - Also added a new method `find_patterns(query, k)` that delegates to
     `self.engine.find_patterns(query, k)`, so callers can ask the
     reasoning bank for a cosine-ranked top-k directly.

2. **`wasm.rs`** (around line 525, inside `impl WasmEphemeralAgent`):
   - Added a `#[wasm_bindgen(js_name = findPatterns)]` binding that
     exposes the new `find_patterns(query, k)` method to JS.

The binding is what `AI-Car-Racer/sona/engine.js` :: `findPatterns(trackVec, k)`
calls to populate the "Similar circuits" side panel.

---

## The concern, stated plainly

**Reproducibility is fragile.** If another contributor — or this same
machine after a clean `git clean -xfd` in the upstream tree — re-runs
`scripts/vendor-ruvector.sh` against mainline ruvector:

- `WasmEphemeralAgent.findPatterns` will disappear from the binding.
- `EphemeralAgent::get_patterns` will return empty again. *(No longer
  true since upstream #481; the rest of this list still applies.)*
- The "Similar circuits" panel will silently regress to hidden.
- `info.sona.patterns` will still show counts (that reads `getStats`,
  which works), so nobody looking at the stats row will notice.

This isn't hypothetical: it's exactly the state this repo was in before
the patch. The bug was hidden for most of a P2.A ship cycle because the
symptoms looked like "empty panel, maybe nothing to show."

**Informal fix management doesn't scale.** We got lucky this time — one
small patch, two files. The next time a ruvector bug blocks us, we may
end up with three or four patches layered across multiple crates, and no
durable record of what was changed or why.

---

## Options (roughly in order of effort)

### Option 1 — Push the fix upstream

Open a PR against `ruvnet/ruvector`, get the `get_patterns`/`findPatterns`
change merged, then re-vendor from a clean mainline commit.

**Pros.** Cleanest end state. `VENDORED.md` records a real tagged SHA, no
`-dirty`. Other ruvector consumers benefit.

**Cons.** Depends on upstream responsiveness. If the project is slow or
inactive, we're blocked. Also: the upstream maintainers may prefer a
different fix (e.g. removing `get_patterns` entirely and only exposing
`find_patterns`). Useful conversation to have regardless, but it blocks
our ability to ship until they weigh in.

**When to pick this.** When the fix is clearly "this is a bug" (the P2.A
fix qualifies) AND the upstream project is healthy enough to review PRs
on a reasonable timescale.

---

### Option 2 — Fork on GitHub, pin our vendor script to our fork

Fork `ruvnet/ruvector` to our org/account, apply our patches on a branch
there (e.g. `car-learning-patches`), and change `scripts/vendor-ruvector.sh`
to build from that fork rather than whatever happens to be in
`~/code/utilities/ruvector/`.

**Pros.** Fully reproducible. Any contributor who can run `cargo` and
`wasm-pack` can rebuild the vendored WASM without having a particular
working tree on their laptop. We keep the ability to cherry-pick upstream
changes into our fork. Good pressure to still send upstream PRs.

**Cons.** Fork drift. Every time upstream updates, we rebase our fork.
Requires us to own a public (or private) repo for the fork.

**When to pick this.** When we're accumulating more than 1–2 patches and
upstream is either slow or philosophically divergent. This is the
"serious" answer.

---

### Option 3 — Keep a patch file in this repo, apply it in the vendor script

Commit a `scripts/ruvector-patches/sona-find-patterns.patch` file
(output of `git diff` against whatever SHA we pin). Modify
`scripts/vendor-ruvector.sh` to:

1. `git checkout <pinned-sha>` inside the upstream working tree.
2. `git apply scripts/ruvector-patches/*.patch`.
3. Build.
4. Reset the upstream tree so the patch doesn't linger.

**Pros.** Self-contained. The car-learning repo alone is enough to
reproduce the build (given a ruvector checkout pointed at the right SHA).
No fork repo to maintain. The patches are reviewable in PRs here.

**Cons.** The vendor script gets more complex. Patch files rot — if
upstream moves on, rebasing each patch is manual. Easy to forget to
update the patch when we fix a second bug in the same file. Also: acting
on someone else's repo from our script feels off; it requires a ruvector
tree on-disk and assumes it's idempotent to mutate.

**When to pick this.** When we want the reproducibility of a fork but
don't want to run a fork. Good stepping-stone before committing to a
fork.

---

### Option 4 — Vendor the ruvector source into this repo

Pull the relevant ruvector crate's Rust source into `vendor/ruvector-src/`
and build from that. The vendored source is the source of truth for our
WASM.

**Pros.** Zero external dependency. Fully hermetic. Patches live in a
normal file edit, like any other vendor dir (e.g. `vendor/` in some
Go/Ruby projects).

**Cons.** Heaviest. We'd be carrying a meaningful chunk of ruvector
source, including tests, benches, and crates we don't need. Updates mean
re-vendoring the source tree, not just the artifact. Probably overkill
for the scale of patches we have.

**When to pick this.** If upstream becomes hostile, stale, or
disappears — the emergency bunker option.

---

## Decision (2026-09-24): patches plus fork-held sources

The trigger in "Decision needed" (more than two patches, none upstreamed) is
met: three patch files, plus the HNSW backend branch. Upstream also rewrote
`main`, which orphaned the old base. Decision: keep Option 3 for patches, and
use the fork only to preserve sources that upstream no longer serves. Do not
maintain a patched fork branch (full Option 2): the patches still apply to
upstream `main` with small rebases, and a fork branch would add rebase work
without adding reproducibility.

- `scripts/build-learning-wasm.sh` and `scripts/build-gnn-wasm.sh` build from
  upstream `5356a84e2` plus the patch files. If upstream stops serving a SHA,
  they fetch it from `shaal/ruvector`.
- `shaal/ruvector` tags the clean source commits of these builds and of the
  HNSW backend (older April packages record a `-dirty` tree; see T9):
  `vv/vendored-base-d5d3296c`, `vv/sona-gnn-base-5356a84e`, and
  `vv/hnsw-wasm-backend-5f2a9a75` (the HNSW backend, also on branch
  `feat/hnsw-wasm-backend`). Never delete `vv/*` tags.
- Both scripts remap the build folder and the Cargo home in panic strings, so
  a build carries no local paths and repeats byte for byte on one host. CI is
  the reference build.
- Option 1 (upstream PRs for `find_patterns`, the checkpoint bindings, the
  online GNN, and the HNSW backend) is still open and still needs the
  user's approval, because it posts to a third-party repository.

## What shipped (2026-04-21)

**Option 3 is live.** `scripts/ruvector-patches/sona-find-patterns.patch`
holds the 40-line diff; `scripts/vendor-ruvector.sh` applies it before
each build and reverts it on exit (idempotent: re-running against an
already-patched tree detects the state via `git apply -R --check` and
skips). `VENDORED.md` now lists applied patches in its own section, so
any future reader of a vendored crate can tell at a glance what we
diverge from upstream on. `scripts/ruvector-patches/README.md` documents
the workflow for adding a second patch.

Why Option 3 first rather than jumping straight to Option 1 or 2:
- **Option 3 is fully local.** No coordination with upstream, no GitHub
  push, no fork-drift maintenance. Solves the reproducibility concern
  *today*.
- **Option 1 isn't a substitute** — it has PR-review latency and the
  maintainers might want the fix reshaped. While that conversation
  runs, Option 3 keeps us unblocked.
- **Option 2 (fork-pin)** was tempting because the user already has
  `shaal/ruvector` as a fork remote, but the fork's `main` is ahead of
  `ruvnet/ruvector` by unrelated NAPI-binary bot commits. Branching
  our patch on that head would entangle us with commits that weren't
  user-written. A direct PR against origin is cleaner when we do go
  external.

Verified end-to-end with a round-trip test on the upstream tree:
clean → apply → dirty → reverse → clean, with five unrelated dirty
files (`mcp-brain-server/*`, `learning-wasm/lora.rs`,
`docs/research/...`) preserved untouched throughout.

---

## Decision needed (now that Option 3 is in place)

**Blocking today:** nothing. Repo is reproducible on its own.

**Next step pending user approval — Option 1 (upstream PR):**
- Target: `ruvnet/ruvector`, against `main` (upstream is active; most
  recent commit is days old as of this doc).
- Push branch: `shaal/ruvector` (fork already configured as `fork`
  remote in `~/code/utilities/ruvector/`).
- *(2026-09-24: upstream #481 fixed `get_patterns`, so the PR now only
  needs `find_patterns(query, k)` and its binding; the title and body below
  predate that.)*
- Suggested branch name: `fix/sona-ephemeral-get-patterns`.
- Suggested PR title: "fix(sona): `EphemeralAgent::get_patterns` returned
  empty; expose `find_patterns(query, k)` + wasm binding".
- PR body should lead with: the stub-shape nature of the bug
  (`find_patterns(&[], 0)` always returns empty), the resulting invisible
  regression (panels populate only via `getStats`, so empty is silent),
  and the minimal surface-area fix (delegate to `get_all_patterns()`;
  add public `find_patterns(query, k)` method + `wasm_bindgen` binding).

Gate: this step requires pushing to `shaal/ruvector` and opening a
public PR, so a future session should surface this checklist to the
user and wait for explicit approval before running `git push fork …`
or `gh pr create`. Once the PR merges, delete
`scripts/ruvector-patches/sona-find-patterns.patch`, bump the vendored
commit, and retire this doc.

**Soft trigger for re-visiting:** any session that needs to patch
ruvector *again* should add a second patch under
`scripts/ruvector-patches/` rather than leaving the upstream tree
dirty — Option 3 is scaled for that case. But >2 patches starts to
feel heavy; at that point, re-evaluate Option 2 (fork-pin) as the
maintenance model.

---

## Quick reference — what to tell a future session

If a future Claude Code session picks this up, the minimum context it
needs:

- **Option 3 is shipped** (patch file + vendor-script integration +
  VENDORED.md footer). The repo is reproducible; the local ruvector
  tree's dirty state no longer matters for build correctness.
- The patch file `scripts/ruvector-patches/sona-find-patterns.patch`
  is the authoritative record of what we carry over upstream.
- **Option 1 (upstream PR) is staged but not executed** — wait for
  user approval to push and open. See "Decision needed" above for
  the PR-ready checklist.
- If a *second* ruvector bug needs fixing, add a second `.patch` file
  to `scripts/ruvector-patches/` following the workflow in that
  directory's `README.md`. Don't re-introduce a dirty-tree dependency.
