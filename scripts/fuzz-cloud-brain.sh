#!/usr/bin/env bash
# Coverage-guided fuzzing of the cloud brain (docs/plan/cloud-brain.md, CB4),
# natively with cargo-fuzz (libFuzzer, AddressSanitizer):
#
#   wire    any bytes through the three request parsers; what one accepts
#           holds the wire format's promises (seeded with the CB1 fixtures)
#   brain   the brain driven by random requests from a few contributors,
#           with small caps and quotas; its invariants after every step
#
#   bash scripts/fuzz-cloud-brain.sh [seconds per target, 300 by default] [target...]
#
# Needs a nightly toolchain and cargo-fuzz (cloud-brain/README.md) and the
# ruvector sources (fetched here). A failure leaves its input in
# cloud-brain/core/fuzz/artifacts/<target>/ and exits non-zero.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NIGHTLY="${FUZZ_TOOLCHAIN:-nightly-2026-09-29}"
SECONDS_EACH="${1:-300}"
shift || true
TARGETS=("$@")
if (( ${#TARGETS[@]} == 0 )); then TARGETS=(wire brain); fi
bash "$ROOT/scripts/build-cloud-brain.sh" --fetch
cd "$ROOT/cloud-brain/core"
# The wire target starts from every fixture body (as bytes).
mkdir -p fuzz/corpus/wire
node -e '
const fs = require("fs"), path = require("path"), root = process.argv[1], out = process.argv[2];
for (const kind of ["valid", "invalid"]) for (const file of fs.readdirSync(path.join(root, kind))) {
  const f = JSON.parse(fs.readFileSync(path.join(root, kind, file), "utf8"));
  const body = "bodyBase64" in f ? Buffer.from(f.bodyBase64, "base64") : Buffer.from(f.body, "utf8");
  fs.writeFileSync(path.join(out, `${kind}-${file}`), body);
}' "$ROOT/tests/fixtures/cloud-brain" fuzz/corpus/wire
for target in "${TARGETS[@]}"; do
  # A request is at most 64 KB (and one byte over); the brain target's
  # input is a sequence of up to 64 small requests.
  case "$target" in
    wire) limit=(-max_len=65537) ;;
    *) limit=(-max_len=4096 -len_control=0) ;;
  esac
  echo "fuzz-cloud-brain: $target for ${SECONDS_EACH} s"
  cargo "+$NIGHTLY" fuzz run "$target" -- -max_total_time="$SECONDS_EACH" "${limit[@]}" -print_final_stats=1
done
