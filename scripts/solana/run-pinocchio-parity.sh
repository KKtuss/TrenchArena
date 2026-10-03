#!/usr/bin/env bash
# Build the Pinocchio experiment binary, load it on a fresh local validator
# under the same Program ID as Anchor, bootstrap, and run client integration tests.
#
# Does NOT modify the Anchor program or default deploy artifact path permanently.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"

PROGRAM_ID="${POKEARENA_PROGRAM_ID:-26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke}"
PINOCCHIO_SO="$ROOT/target/deploy/arena_escrow_pinocchio.so"
LEDGER="${POKEARENA_TEST_LEDGER:-/tmp/pokearena-pinocchio-ledger}"
RPC="${POKEARENA_SOLANA_RPC:-http://127.0.0.1:8899}"

echo "==> Building Pinocchio arena_escrow parity binary"
cargo-build-sbf --manifest-path "$ROOT/programs/arena-escrow-pinocchio/Cargo.toml" --arch v0

if [[ ! -f "$PINOCCHIO_SO" ]]; then
  echo "ERROR: missing $PINOCCHIO_SO" >&2
  exit 1
fi

BYTES="$(wc -c < "$PINOCCHIO_SO" | tr -d ' ')"
SHA="$(sha256sum "$PINOCCHIO_SO" | awk '{print $1}')"
echo "Pinocchio .so: $BYTES bytes"
echo "SHA256: $SHA"

# Stop any prior validator matching this ledger/port.
while read -r pid; do
  [[ -n "$pid" ]] || continue
  kill "$pid" 2>/dev/null || true
done < <(ps -eo pid,args | awk '/solana-test-validator/ && !/awk/ && !/run-pinocchio-parity/ {print $1}')
sleep 1
rm -rf "$LEDGER"

echo "==> Starting validator with Pinocchio binary at $PROGRAM_ID"
nohup solana-test-validator \
  --ledger "$LEDGER" \
  --reset \
  --bind-address 127.0.0.1 \
  --rpc-port 8899 \
  --bpf-program "$PROGRAM_ID" "$PINOCCHIO_SO" \
  > /tmp/pokearena-pinocchio-validator.log 2>&1 &
echo "validator pid $!"

for _ in $(seq 1 40); do
  if solana cluster-version --url "$RPC" >/dev/null 2>&1; then
    solana cluster-version --url "$RPC"
    break
  fi
  sleep 1
done

if ! solana cluster-version --url "$RPC" >/dev/null 2>&1; then
  echo "validator failed to become ready" >&2
  tail -40 /tmp/pokearena-pinocchio-validator.log >&2 || true
  exit 1
fi

echo "==> Bootstrapping local economy against Pinocchio program"
export POKEARENA_PROGRAM_ID="$PROGRAM_ID"
export POKEARENA_PROGRAM_SO="$PINOCCHIO_SO"
export POKEARENA_SOLANA_RPC="$RPC"
# Force redeploy path is unused: program is already genesis-loaded.
unset POKEARENA_FORCE_DEPLOY || true
"$ROOT/scripts/solana/bootstrap-local.sh"

set -a
# shellcheck disable=SC1091
source "$ROOT/scripts/solana/.local.env"
set +a
export POKEARENA_CHAIN_ECONOMY=true
export POKEARENA_SOLANA_KEYS="${POKEARENA_SOLANA_KEYS:-$ROOT/scripts/solana/keys}"

# Prefer a host Node binary when WSL has none (common on this repo's Windows+WSL setup).
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in \
    /mnt/c/Program\ Files/nodejs/node.exe \
    /mnt/c/Program\ Files\ \(x86\)/nodejs/node.exe \
    "$HOME/.nvm/versions/node"/*/bin/node
  do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -n "$NODE_BIN" ]]; then
  echo "==> Building client + initialize_config via $NODE_BIN"
  (
    cd "$ROOT/packages/solana-client"
    npm run build >/dev/null
  )
  "$NODE_BIN" "$ROOT/scripts/solana/init-config.mjs"
  # Refresh vault PDAs into env for tests.
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/scripts/solana/.local.env"
  set +a
  # init-config prints vaults but may not rewrite .local.env; derive if still blank.
  if [[ -z "${POKEARENA_FEE_VAULT:-}" ]]; then
    eval "$("$NODE_BIN" -e "
      const {PublicKey}=require('$ROOT/packages/solana-client/node_modules/@solana/web3.js');
      const pid=new PublicKey('$PROGRAM_ID');
      const fee=PublicKey.findProgramAddressSync([Buffer.from('fee_vault')], pid)[0].toBase58();
      const tre=PublicKey.findProgramAddressSync([Buffer.from('treasury_vault')], pid)[0].toBase58();
      const op=PublicKey.findProgramAddressSync([Buffer.from('operator_vault')], pid)[0].toBase58();
      console.log('export POKEARENA_FEE_VAULT='+fee);
      console.log('export POKEARENA_TREASURY_VAULT='+tre);
      console.log('export POKEARENA_OPERATOR_VAULT='+op);
    ")"
  fi
else
  echo "WARN: node not found in WSL; run on host before tests:"
  echo "  set -a; source scripts/solana/.local.env; set +a"
  echo "  node scripts/solana/init-config.mjs"
fi

echo "==> Running solana-client tests (includes program.integration when env set)"
export POKEARENA_CHAIN_ECONOMY=true
(
  cd "$ROOT/packages/solana-client"
  # Force-env for Windows npm interop cases that drop inherited vars.
  POKEARENA_CHAIN_ECONOMY=true \
  POKEARENA_SOLANA_RPC="$RPC" \
  POKEARENA_PROGRAM_ID="$PROGRAM_ID" \
  POKEARENA_POKE_MINT="${POKEARENA_POKE_MINT:-}" \
  POKEARENA_FEE_VAULT="${POKEARENA_FEE_VAULT:-}" \
  POKEARENA_TREASURY_VAULT="${POKEARENA_TREASURY_VAULT:-}" \
  POKEARENA_OPERATOR_VAULT="${POKEARENA_OPERATOR_VAULT:-}" \
  POKEARENA_SOLANA_KEYS="$POKEARENA_SOLANA_KEYS" \
  npm test
)

echo "==> Pinocchio parity run complete"
echo "Binary bytes: $BYTES"
echo "SHA256: $SHA"
ANCHOR_BYTES=419736
SAVED=$((ANCHOR_BYTES - BYTES))
# ProgramData rent: (bytes + 45 + 128) * 6960 lamports
PD_BEFORE=$(( (ANCHOR_BYTES + 45 + 128) * 6960 ))
PD_AFTER=$(( (BYTES + 45 + 128) * 6960 ))
SAVED_LAMPORTS=$(( PD_BEFORE - PD_AFTER ))
awk -v ab="$ANCHOR_BYTES" -v pb="$PD_BEFORE" -v bb="$BYTES" -v pa="$PD_AFTER" -v sb="$SAVED" -v sl="$SAVED_LAMPORTS" 'BEGIN {
  printf "Anchor baseline: %d bytes / %.8f SOL ProgramData rent\n", ab, pb/1e9;
  printf "Pinocchio:       %d bytes / %.8f SOL ProgramData rent\n", bb, pa/1e9;
  printf "Saved:           %d bytes / %.8f SOL\n", sb, sl/1e9;
}'
