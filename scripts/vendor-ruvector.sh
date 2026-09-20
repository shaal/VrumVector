#!/usr/bin/env bash
# vendor-ruvector.sh — rebuild + commit a ruvector WASM crate into this repo.
#
# Usage:
#   scripts/vendor-ruvector.sh CRATE_DIR [VENDOR_NAME]
#
#   CRATE_DIR     Path to a ruvector crate source directory (contains Cargo.toml).
#                 Example: ~/code/ruvector/crates/ruvector-cnn-wasm
#   VENDOR_NAME   Optional. Output subdirectory name under vendor/ruvector/.
#                 Defaults to the Cargo package name with dashes → underscores,
#                 matching the existing convention (ruvector_cnn_wasm, ruvector_wasm).
#
# Optional env:
#   WASM_FEATURES Space-separated cargo feature flags to pass as
#                 `--features "$WASM_FEATURES"`. Needed for crates whose WASM
#                 bindings live behind a non-default feature (e.g. sona → "wasm").
#
# What it does:
#   1. runs   wasm-pack build --target web --release [--features …]   inside
#      the crate directory (wasm-pack's default pkg/ output, which it manages)
#   2. copies the resulting pkg/ contents into vendor/ruvector/$VENDOR_NAME/
#   3. writes VENDORED.md recording the upstream commit SHA, date, and host
#
# End users never need this script — the vendored artifacts under
# vendor/ruvector/ are committed to the repo. Maintainers run it when they
# want to pull a newer ruvector revision.

set -euo pipefail

# ─── arg parsing ─────────────────────────────────────────────────────────
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 CRATE_DIR [VENDOR_NAME]" >&2
  exit 2
fi

CRATE_DIR="$1"
VENDOR_NAME="${2:-}"

if [[ ! -d "$CRATE_DIR" ]]; then
  echo "error: crate dir not found: $CRATE_DIR" >&2
  exit 2
fi
if [[ ! -f "$CRATE_DIR/Cargo.toml" ]]; then
  echo "error: $CRATE_DIR has no Cargo.toml" >&2
  exit 2
fi

# ─── tool check ──────────────────────────────────────────────────────────
if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack not on PATH. Install: https://rustwasm.github.io/wasm-pack/" >&2
  exit 2
fi

# ─── resolve absolute paths ──────────────────────────────────────────────
# Portable abs-path: `cd -P` into the dir and use $PWD. Avoids realpath,
# which is missing on some BSD-ish macOS setups.
CRATE_ABS="$(cd -P "$CRATE_DIR" && pwd)"

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_ROOT="$REPO_ROOT/vendor/ruvector"

# ─── derive vendor dir name if not provided ──────────────────────────────
if [[ -z "$VENDOR_NAME" ]]; then
  # Prefer the Cargo package name (authoritative); fall back to the crate
  # directory's basename if parsing fails.
  PKG_NAME="$(awk -F'"' '/^\s*name\s*=\s*"/ { print $2; exit }' "$CRATE_ABS/Cargo.toml" || true)"
  if [[ -z "${PKG_NAME:-}" ]]; then
    PKG_NAME="$(basename "$CRATE_ABS")"
  fi
  VENDOR_NAME="${PKG_NAME//-/_}"
fi

VENDOR_DIR="$VENDOR_ROOT/$VENDOR_NAME"

# ─── apply upstream patches (optional) ───────────────────────────────────
# Fixes we carry locally because they're not upstream yet live under
# scripts/ruvector-patches/*.patch. They're applied against the ruvector
# repo root (not the crate dir), built against, then reverted on exit so
# the upstream tree never holds our changes persistently. Idempotent —
# re-runs detect an already-applied patch via `git apply -R --check`.
PATCH_DIR="$REPO_ROOT/scripts/ruvector-patches"
UPSTREAM_ROOT=""
APPLIED_PATCHES=()
APPLIED_PATCH_NAMES=()
BUILD_PKG="$CRATE_ABS/pkg"

cleanup() {
  # Revert patches we applied this run (leave already-applied ones alone —
  # they were the caller's pre-existing state). Then wipe the in-crate
  # pkg/ dir so the upstream tree stays tidy.
  if [[ -n "$UPSTREAM_ROOT" ]]; then
    for (( i=${#APPLIED_PATCHES[@]}-1; i>=0; i-- )); do
      p="${APPLIED_PATCHES[i]}"
      git -C "$UPSTREAM_ROOT" apply -R "$p" 2>/dev/null || true
    done
  fi
  rm -rf "$BUILD_PKG"
}
trap cleanup EXIT

if [[ -d "$PATCH_DIR" ]] && compgen -G "$PATCH_DIR/*.patch" > /dev/null; then
  UPSTREAM_ROOT="$(git -C "$CRATE_ABS" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$UPSTREAM_ROOT" ]]; then
    echo "error: $PATCH_DIR has patches, but $CRATE_ABS is not in a git repo" >&2
    exit 2
  fi
  echo "[vendor-ruvector] applying patches from scripts/ruvector-patches/"
  for p in "$PATCH_DIR"/*.patch; do
    name="$(basename "$p")"
    if git -C "$UPSTREAM_ROOT" apply --check "$p" 2>/dev/null; then
      git -C "$UPSTREAM_ROOT" apply "$p"
      APPLIED_PATCHES+=("$p")
      APPLIED_PATCH_NAMES+=("$name")
      echo "  → $name (applied)"
    elif git -C "$UPSTREAM_ROOT" apply --check -R "$p" 2>/dev/null; then
      APPLIED_PATCH_NAMES+=("$name (pre-applied)")
      echo "  → $name (already applied; leaving as-is)"
    else
      echo "error: patch does not apply cleanly: $p" >&2
      echo "       upstream has likely drifted. Regenerate the patch against the current HEAD." >&2
      exit 1
    fi
  done
fi

# ─── build ───────────────────────────────────────────────────────────────
# wasm-pack 0.13+ forwards `--out-dir` to `cargo build` as an unstable flag,
# which breaks on stable toolchains. Let wasm-pack use its default `pkg/`
# directory inside the crate, and copy from there.
echo "[vendor-ruvector] building $CRATE_ABS (features='${WASM_FEATURES:-<default>}') → $BUILD_PKG"

rm -rf "$BUILD_PKG"

# --target web produces browser-ready glue (no bundler needed); --release
# turns on optimisations so the .wasm matches what end users download.
# Feature flags (optional) let us build crates whose WASM bindings live behind
# a non-default feature (e.g. ruvector-sona's `wasm` feature).
WASM_PACK_ARGS=("build" "$CRATE_ABS" "--target" "web" "--release")
if [[ -n "${WASM_FEATURES:-}" ]]; then
  WASM_PACK_ARGS+=("--features" "$WASM_FEATURES")
fi
wasm-pack "${WASM_PACK_ARGS[@]}"

if [[ ! -d "$BUILD_PKG" ]]; then
  echo "error: wasm-pack did not produce $BUILD_PKG" >&2
  exit 1
fi

# ─── copy into vendor/ ───────────────────────────────────────────────────
mkdir -p "$VENDOR_DIR"

# Wipe the destination so files removed upstream don't linger in the vendor
# dir. We keep VENDORED.md (rewritten below) outside the wipe target.
find "$VENDOR_DIR" -mindepth 1 -maxdepth 1 ! -name 'VENDORED.md' -exec rm -rf {} +

# Copy every pkg/ artifact (.wasm, .js, .d.ts, package.json, README.md, …)
# except .gitignore (wasm-pack emits one that would hide the vendored files).
cp -R "$BUILD_PKG/." "$VENDOR_DIR/"
rm -f "$VENDOR_DIR/.gitignore"

# ─── write VENDORED.md ───────────────────────────────────────────────────
if git -C "$CRATE_ABS" rev-parse HEAD >/dev/null 2>&1; then
  UPSTREAM_SHA="$(git -C "$CRATE_ABS" rev-parse HEAD)"
  UPSTREAM_DESC="$(git -C "$CRATE_ABS" describe --always --dirty 2>/dev/null || echo "$UPSTREAM_SHA")"
  UPSTREAM_REMOTE="$(git -C "$CRATE_ABS" remote get-url origin 2>/dev/null || echo "(no origin)")"
else
  UPSTREAM_SHA="(not a git repo)"
  UPSTREAM_DESC="(not a git repo)"
  UPSTREAM_REMOTE="(not a git repo)"
fi

VENDORED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HOST_INFO="$(uname -srm)"
WASM_PACK_VERSION="$(wasm-pack --version 2>/dev/null | head -n1 || echo 'unknown')"

# ─── format applied-patch list for VENDORED.md ──────────────────────────
if [[ ${#APPLIED_PATCH_NAMES[@]} -eq 0 ]]; then
  PATCH_SECTION="_None._ Vendored straight from the upstream commit above."
else
  PATCH_SECTION="The following patches from \`scripts/ruvector-patches/\` were applied before build. See that directory's \`README.md\` for the rationale of each."
  PATCH_SECTION="$PATCH_SECTION"$'\n\n'
  for name in "${APPLIED_PATCH_NAMES[@]}"; do
    PATCH_SECTION="$PATCH_SECTION- \`$name\`"$'\n'
  done
fi

cat > "$VENDOR_DIR/VENDORED.md" <<EOF
# Vendored: $VENDOR_NAME

This directory is generated by \`scripts/vendor-ruvector.sh\`. Do not edit by hand.

| Field | Value |
|-------|-------|
| Upstream crate path | \`$CRATE_ABS\` |
| Upstream remote | $UPSTREAM_REMOTE |
| Upstream commit | \`$UPSTREAM_SHA\` |
| Upstream describe | \`$UPSTREAM_DESC\` |
| Vendored at (UTC) | $VENDORED_AT |
| Built with | $WASM_PACK_VERSION |
| Host | $HOST_INFO |

## Patches applied

$PATCH_SECTION

## To re-vendor

\`\`\`
scripts/vendor-ruvector.sh $CRATE_DIR $VENDOR_NAME
\`\`\`
EOF

echo "[vendor-ruvector] done. Contents of $VENDOR_DIR:"
ls -1 "$VENDOR_DIR"
