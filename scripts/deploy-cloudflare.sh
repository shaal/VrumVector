#!/usr/bin/env bash
# Deploy to Cloudflare Pages (project: vectorvroom).
#
# Why the staging step? `wrangler pages deploy .` follows the root
# `ruvector` dev symlink into the upstream rust build tree (tens of MB
# of compiled .o files that would exceed the 25 MiB per-file cap).
# `.assetsignore` is ignored for symlink traversal, so we rsync the
# runtime tree into /tmp first, excluding dev-only dirs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE_DIR="${TMPDIR:-/tmp}/vectorvroom-deploy"
PROJECT="vectorvroom"
BRANCH="${1:-main}"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler not on PATH — install via 'npm i -g wrangler' or 'brew install cloudflare-wrangler2'" >&2
  exit 1
fi

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# Leading `/` anchors the pattern to the repo root so `vendor/ruvector/`
# (the runtime WASM tree) is preserved while the top-level `ruvector`
# symlink is skipped.
rsync -a \
  --exclude='/.git' \
  --exclude='/.github' \
  --exclude='/.claude' \
  --exclude='/.vscode' \
  --exclude='.DS_Store' \
  --exclude='/ruvector' \
  --exclude='/cloud-brain' \
  --exclude='/docs' \
  --exclude='/scripts' \
  --exclude='/tests' \
  --exclude='node_modules' \
  "$REPO_ROOT/" "$STAGE_DIR/"

echo "Staged $(du -sh "$STAGE_DIR" | cut -f1) to $STAGE_DIR"

wrangler pages deploy "$STAGE_DIR" \
  --project-name="$PROJECT" \
  --branch="$BRANCH" \
  --commit-dirty=true
