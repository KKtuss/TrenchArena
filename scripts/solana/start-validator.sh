#!/usr/bin/env bash
# Local solana-test-validator only. Not a mainnet deployment path.
# The default .so is the Anchor oracle artifact. Pinocchio local runs set
# POKEARENA_PROGRAM_SO. Mainnet uses scripts/solana/deploy-pinocchio-mainnet.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Prefer a native Linux path in WSL — ledgers on /mnt/<drive> often hit PermissionDenied.
LEDGER="${POKEARENA_TEST_LEDGER:-/tmp/pokearena-ledger}"
PROGRAM_SO="${POKEARENA_PROGRAM_SO:-$ROOT/target/deploy/arena_escrow.so}"
PROGRAM_ID="${POKEARENA_PROGRAM_ID:-41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W}"
mkdir -p "$LEDGER"

ARGS=(
  --ledger "$LEDGER"
  --reset
  --bind-address 127.0.0.1
  --rpc-port 8899
)
# Load the program at genesis to avoid upgradeable-loader SBPF version mismatches.
if [[ -f "$PROGRAM_SO" ]]; then
  ARGS+=(--bpf-program "$PROGRAM_ID" "$PROGRAM_SO")
fi
exec solana-test-validator "${ARGS[@]}"
