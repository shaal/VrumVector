#!/usr/bin/env bash
# serve.sh — launch the dev static server from the repo root.
#
# Why this exists: AI-Car-Racer/ruvectorBridge.js and friends import the
# pre-built wasm tree via relative paths like `../vendor/ruvector/...`, which
# resolve above the server root when http.server is launched from inside
# AI-Car-Racer/. The resulting 404 shows up as "bridge not ready" in every
# vector-memory UI panel with no obvious cause. Always launch from repo root.
#
# Usage:
#   scripts/serve.sh            # port 8765 (default)
#   scripts/serve.sh 9000       # custom port

set -euo pipefail

PORT="${1:-8765}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
echo "serving $REPO_ROOT on :$PORT"
echo "  app:      http://localhost:$PORT/AI-Car-Racer/index.html"
echo "  bench:    http://localhost:$PORT/tests/bench-hnsw.html"
echo "  phase2:   http://localhost:$PORT/docs/validation/phase2-verify.html"
# http.server with a deeper listen queue (see scripts/static-server.py).
exec python3 scripts/static-server.py "$PORT" --bind 0.0.0.0
