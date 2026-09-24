# ruvector upstream patches

Patches applied to the local ruvector working tree before `wasm-pack build`
runs. See `docs/plan/ruvector-upstream-patches.md` for the full rationale;
this file is just the quick reference.

## Contract

- Files named `*.patch` in this directory are applied to the ruvector repo
  root (derived from `CRATE_DIR` via `git rev-parse --show-toplevel`) by
  `scripts/vendor-ruvector.sh` before every vendor build.
- Apply is idempotent: re-running the script on an already-patched tree
  detects the applied state (`git apply -R --check`) and skips silently.
- Patches are unapplied automatically on script exit so the upstream tree
  ends in the same state it started in — dirty or clean, your other
  in-flight edits are preserved.
- If a patch fails to apply cleanly (upstream drift moved a context line),
  the script aborts with a clear error rather than silently building
  without the fix.

## Current patches

| File | Touches | Why it's carried here, not upstream (yet) |
|------|---------|-------------------------------------------|
| `sona-find-patterns.patch` | `crates/sona/src/training/federated.rs`, `crates/sona/src/wasm.rs` | Adds `EphemeralAgent::find_patterns(query, k)` and its `wasm_bindgen(js_name = findPatterns)` binding. Used by `AI-Car-Racer/sona/engine.js :: findPatterns`. The original stub fix for `get_patterns()` was dropped when the build moved to upstream `5356a84e2`, because upstream #481 made the same fix. Needs an upstream PR; tracked in `docs/plan/ruvector-upstream-patches.md`. |

## Exact browser checkpoint (#11)

`sona-state-checkpoint.patch` adds versioned `exportCheckpoint` / `importCheckpoint`
bindings. It preserves ReasoningBank trajectories and indexes, both LoRA layers,
pending gradients, EWC Fisher/task/gradient state, buffered trajectories, IDs,
metrics, and the remaining background timer. Import validates configuration,
dimensions, finite bounded values, capacities, and index consistency before an
atomic replacement. Export requires quiescent access (enforced by the synchronous
browser wrapper). Offline time does not advance the background learning timer.

Rebuild with `bash scripts/build-learning-wasm.sh`. The dedicated CI workflow
runs native continuation/rejection tests and actual WASM tests before committing
generated bindings. Run it from a `ship/*` or `codex/*` branch with
`gh workflow run learning-wasm.yml --ref <branch> -f target=sona`. Build in CI,
not locally: a local build embeds the absolute Cargo registry path (including
the home folder name) in panic strings of the public WASM. After a rebuild,
set the `?v=sona-…` query in `AI-Car-Racer/sona/engine.js` to the first 8 hex
digits of the new wasm SHA-256 (`npm run test:learning` fails until you do).
`tests/fixtures/sona-checkpoint-d5d3296c.json` is a checkpoint saved by the
previous build; `tests/learning-wasm.mjs` proves that it still restores. The pinned upstream SHA, Rust, wasm-pack, Cargo lockfile,
patch hashes, and binary hash are recorded. Legacy saves recover from the circuit
journal; unsupported/corrupt checkpoints never require deleting the brain archive.

## Adding a new patch

1. Apply your fix in the local ruvector tree (`~/code/utilities/ruvector/`).
2. `cd ~/code/utilities/ruvector && git diff <file> [<file>…] > scripts/ruvector-patches/<short-name>.patch`
   (pipe from the repo root; `git diff` produces the `a/... b/...` form
   that `git apply` expects).
3. Add a row to the table above explaining what it does and why it isn't
   upstream.
4. Re-run `scripts/vendor-ruvector.sh <crate-path>` to verify the patch
   applies cleanly and the build still succeeds. The script will also
   append the applied-patch list to the crate's `VENDORED.md`.
5. When a patch lands upstream, delete the file and bump the vendored
   commit; the VENDORED.md footer will automatically stop listing it.

## Trainable graph companion (#10)

`gnn-online-training.patch` adds a supervised graph layer with explicit seeded
initialization, weight setters, gradient updates, and optimizer checkpoints to
the upstream GNN source and browser bindings. `scripts/build-gnn-wasm.sh` builds
the two new modules as a lightweight companion WASM package; existing attention
bindings are retained. See `docs/validation/gnn-learning.md` for measured results
and why automatic ranking continues to use EMA.
