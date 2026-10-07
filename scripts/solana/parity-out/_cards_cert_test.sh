#!/bin/bash
set -euo pipefail
export PATH="/root/node-v22.18.0-linux-x64/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT/packages/solana-client"
npm run build
node --test \
  dist/test/instruction-surface.test.js \
  dist/test/cards-rail.test.js \
  dist/test/sol-without-mint.test.js \
  dist/test/pinocchio-abi-parity.test.js
export POKEARENA_CORRUPT_CLI=1
node dist/test/hardening-corrupt-fuzz.js
