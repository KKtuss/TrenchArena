#!/bin/bash
set -euo pipefail
export PATH="/root/node-v22.18.0-linux-x64/bin:$PATH"
cd /mnt/d/CursorProj/PokeArena/packages/solana-client
npm run build
node --test dist/test/cards-rail.test.js dist/test/sol-without-mint.test.js dist/test/pinocchio-abi-parity.test.js
