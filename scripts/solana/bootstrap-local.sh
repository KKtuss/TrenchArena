#!/usr/bin/env bash
# Bootstrap a local validator with POKE mint, vaults, and arena-escrow config.
# Local validator testing only. Mainnet program deployment is
# scripts/solana/deploy-pinocchio-mainnet.sh, which deploys the Pinocchio artifact.
# Requires: solana, spl-token, solana-keygen, node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/scripts/solana/.local.env"
RPC="${POKEARENA_SOLANA_RPC:-http://127.0.0.1:8899}"
if [[ ! "$RPC" =~ ^https?://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/?$ ]]; then
  echo "bootstrap-local.sh is local-validator testing only and will not use $RPC." >&2
  echo "Mainnet Pinocchio deployment: scripts/solana/deploy-pinocchio-mainnet.sh" >&2
  exit 1
fi
KEYDIR="${POKEARENA_SOLANA_KEYS:-$ROOT/scripts/solana/keys}"
mkdir -p "$KEYDIR"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"

need_key() {
  local name="$1"
  local path="$KEYDIR/$name.json"
  if [[ ! -f "$path" ]]; then
    solana-keygen new --no-bip39-passphrase -o "$path" --force >/dev/null
  fi
  echo "$path"
}

AUTHORITY="$(need_key authority)"
KEEPER="$(need_key keeper)"
PLAYER1="$(need_key player1)"
PLAYER2="$(need_key player2)"
solana config set --url "$RPC" --keypair "$AUTHORITY" >/dev/null

for k in "$AUTHORITY" "$KEEPER" "$PLAYER1" "$PLAYER2"; do
  solana airdrop 100 "$(solana-keygen pubkey "$k")" --url "$RPC" >/dev/null || true
done

# Local Anchor oracle artifact only. Production mainnet deploy must not use this file.
PROGRAM_SO="$ROOT/target/deploy/arena_escrow.so"
PROGRAM_ID="${POKEARENA_PROGRAM_ID:-41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W}"
PROGRAM_KEYPAIR="${POKEARENA_PROGRAM_KEYPAIR:-}"
if [[ "${POKEARENA_FORCE_DEPLOY:-}" == "1" && -f "$PROGRAM_SO" ]]; then
  [[ -n "$PROGRAM_KEYPAIR" && -f "$PROGRAM_KEYPAIR" ]] || {
    echo "POKEARENA_FORCE_DEPLOY=1 requires POKEARENA_PROGRAM_KEYPAIR for the new program ID." >&2
    exit 1
  }
  [[ "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" == "$PROGRAM_ID" ]] || {
    echo "POKEARENA_PROGRAM_KEYPAIR does not match POKEARENA_PROGRAM_ID." >&2
    exit 1
  }
  echo "Force-deploying arena_escrow…"
  solana program deploy "$PROGRAM_SO" --url "$RPC" --keypair "$AUTHORITY" \
    --program-id "$PROGRAM_KEYPAIR" || true
elif solana program show "$PROGRAM_ID" --url "$RPC" >/dev/null 2>&1; then
  echo "Program $PROGRAM_ID already present (genesis or prior deploy)."
elif [[ -f "$PROGRAM_SO" ]]; then
  echo "WARN: program not loaded. Restart validator via scripts/solana/start-validator.sh"
  echo "      (loads $PROGRAM_SO at genesis) or set POKEARENA_FORCE_DEPLOY=1."
else
  echo "WARN: $PROGRAM_SO missing. Run cargo build-sbf first."
fi

# Create POKE mint (6 decimals)
MINT_KP="$(need_key poke_mint)"
if ! spl-token display "$(solana-keygen pubkey "$MINT_KP")" --url "$RPC" >/dev/null 2>&1; then
  spl-token create-token --decimals 6 --mint-authority "$AUTHORITY" --fee-payer "$AUTHORITY" "$MINT_KP" --url "$RPC"
fi
POKE_MINT="$(solana-keygen pubkey "$MINT_KP")"

for player in "$PLAYER1" "$PLAYER2"; do
  spl-token create-account "$POKE_MINT" \
    --owner "$(solana-keygen pubkey "$player")" \
    --fee-payer "$AUTHORITY" \
    --url "$RPC" >/dev/null 2>&1 || true
  spl-token mint "$POKE_MINT" 1000000 \
    --recipient-owner "$(solana-keygen pubkey "$player")" \
    --mint-authority "$AUTHORITY" \
    --fee-payer "$AUTHORITY" \
    --url "$RPC" >/dev/null
done

# $0.40 / POKE → 50 POKE = $20, 12.5 POKE = $5
PRICE_MICRO_USD=400000

# Derive program vault PDAs via node (or leave blank for init-config to print).
FEE_VAULT=""
TREASURY_VAULT=""
OPERATOR_VAULT=""
if command -v node >/dev/null 2>&1; then
  read -r FEE_VAULT TREASURY_VAULT OPERATOR_VAULT < <(node -e "
    const {PublicKey}=require('$ROOT/packages/solana-client/node_modules/@solana/web3.js');
    const pid=new PublicKey('$PROGRAM_ID');
    const fee=PublicKey.findProgramAddressSync([Buffer.from('fee_vault')], pid)[0].toBase58();
    const tre=PublicKey.findProgramAddressSync([Buffer.from('treasury_vault')], pid)[0].toBase58();
    const op=PublicKey.findProgramAddressSync([Buffer.from('operator_vault')], pid)[0].toBase58();
    process.stdout.write(fee+' '+tre+' '+op);
  ")
fi

cat > "$OUT" <<EOF
POKEARENA_CHAIN_ECONOMY=true
POKEARENA_SOLANA_CLUSTER=localnet
POKEARENA_SOLANA_RPC=$RPC
POKEARENA_SOLANA_COMMITMENT=confirmed
POKEARENA_PROGRAM_ID=$PROGRAM_ID
POKEARENA_POKE_MINT=$POKE_MINT
POKEARENA_FEE_VAULT=$FEE_VAULT
POKEARENA_TREASURY_VAULT=$TREASURY_VAULT
POKEARENA_OPERATOR_VAULT=$OPERATOR_VAULT
POKEARENA_QUOTE_AUTHORITY=$(solana-keygen pubkey "$AUTHORITY")
POKEARENA_KEEPER=$(solana-keygen pubkey "$KEEPER")
POKEARENA_AUTHORITY=$(solana-keygen pubkey "$AUTHORITY")
POKEARENA_BUYBACK_BPS=2500
POKEARENA_MIN_BUYBACK_LAMPORTS=50000000
POKEARENA_POKE_PRICE_MICRO_USD=$PRICE_MICRO_USD
POKEARENA_POKE_DECIMALS=6
POKEARENA_POKE_PRICE_CONFIDENCE_BPS=0
POKEARENA_POKE_QUOTE_ID=local-bootstrap
NEXT_PUBLIC_SOLANA_RPC=$RPC
EOF

echo "Wrote $OUT"
echo "Source it with: set -a; source $OUT; set +a"
cat "$OUT"

# Build client + initialize on-chain config (and optional treasury seed).
# Host/WSL hybrid runners can set POKEARENA_SKIP_INIT=1 and run init-config on the host.
if [[ "${POKEARENA_SKIP_INIT:-}" == "1" ]]; then
  echo "Skipping initialize_config (POKEARENA_SKIP_INIT=1)."
elif [[ -f "$PROGRAM_SO" ]]; then
  (
    cd "$ROOT/packages/solana-client"
    npm run build >/dev/null
  )
  set -a
  # shellcheck disable=SC1090
  source "$OUT"
  set +a
  if command -v node >/dev/null 2>&1; then
    node "$ROOT/scripts/solana/init-config.mjs"
  else
    echo "Node not in PATH (common in bare WSL). From Windows/host run:"
    echo "  set -a; source scripts/solana/.local.env; set +a"
    echo "  node scripts/solana/init-config.mjs"
  fi
else
  echo "Skipping initialize_config (program .so not deployed)."
fi
