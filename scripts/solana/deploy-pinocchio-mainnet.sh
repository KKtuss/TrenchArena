#!/usr/bin/env bash
# Deploy the production Pinocchio arena escrow program to Solana mainnet.
#
# This is the only production program-deploy path. It builds
# target/deploy/arena_escrow_pinocchio.so and never deploys the Anchor
# artifact target/deploy/arena_escrow.so. Anchor, parity campaigns, and the
# local validator scripts stay available for reference and testing.
#
# The script prints the plan and stops before sending a transaction unless
# --confirm-mainnet is present. It never generates keypairs and never passes
# --final, so a successful deploy keeps an upgrade authority.
set -euo pipefail

EXPECTED_PROGRAM_ID="41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W"
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
# Headroom for chunked upload fees and a modest priority fee. Rent is separate.
FEE_RESERVE_LAMPORTS=50000000
PROGRAM_ACCOUNT_DATA_LEN=36
PROGRAMDATA_METADATA_LEN=45

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PINOCCHIO_MANIFEST="$ROOT/programs/arena-escrow-pinocchio/Cargo.toml"
PINOCCHIO_SO="$ROOT/target/deploy/arena_escrow_pinocchio.so"
ANCHOR_SO="$ROOT/target/deploy/arena_escrow.so"
PROGRAM_KEYPAIR="${POKEARENA_PROGRAM_KEYPAIR:-}"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"

die() {
  echo "error: $*" >&2
  exit 1
}

sol_format() {
  awk -v lamports="$1" 'BEGIN { printf "%.9f", lamports / 1000000000 }'
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

CONFIRM=0
for arg in "$@"; do
  case "$arg" in
    --confirm-mainnet) CONFIRM=1 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

CLUSTER="$(printf '%s' "${POKEARENA_SOLANA_CLUSTER:-}" | tr '[:upper:]' '[:lower:]')"
RPC="${POKEARENA_SOLANA_RPC:-}"
DEPLOY_KEYPAIR="${POKEARENA_DEPLOY_KEYPAIR:-}"

[[ "$CLUSTER" == "mainnet-beta" || "$CLUSTER" == "mainnet" ]] || die "set POKEARENA_SOLANA_CLUSTER=mainnet-beta. This script refuses devnet, testnet, and localnet."
[[ -n "$RPC" ]] || die "set POKEARENA_SOLANA_RPC to an explicit mainnet HTTPS URL."
[[ "$RPC" =~ ^https:// ]] || die "POKEARENA_SOLANA_RPC must be an explicit https URL, not a cluster nickname or local endpoint."

RPC_LOWER="$(printf '%s' "$RPC" | tr '[:upper:]' '[:lower:]')"
case "$RPC_LOWER" in
  *devnet*|*testnet*|*localnet*|*localhost*|*127.0.0.1*|*0.0.0.0*|*\[::1\]*)
    die "refusing non-mainnet RPC: $RPC"
    ;;
esac

[[ -n "$DEPLOY_KEYPAIR" ]] || die "set POKEARENA_DEPLOY_KEYPAIR to the funded deployer keypair. This script does not choose or create one."
[[ -f "$DEPLOY_KEYPAIR" ]] || die "deployer keypair not found: $DEPLOY_KEYPAIR"
[[ -n "$PROGRAM_KEYPAIR" ]] || die "set POKEARENA_PROGRAM_KEYPAIR to the new program keypair. This script does not reuse or generate the old program keypair."
[[ -f "$PROGRAM_KEYPAIR" ]] || die "program keypair not found: $PROGRAM_KEYPAIR. Refusing to generate one."
if [[ "$DEPLOY_KEYPAIR" -ef "$PROGRAM_KEYPAIR" ]]; then
  die "deployer and program keypairs must be different files."
fi

require_cmd cargo-build-sbf
require_cmd solana
require_cmd solana-keygen
require_cmd sha256sum
require_cmd python3

PROGRAM_PUBKEY="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
PAYER_PUBKEY="$(solana-keygen pubkey "$DEPLOY_KEYPAIR")"
[[ "$PROGRAM_PUBKEY" == "$EXPECTED_PROGRAM_ID" ]] || die "program keypair pubkey is $PROGRAM_PUBKEY, expected $EXPECTED_PROGRAM_ID."
[[ "$PAYER_PUBKEY" != "$EXPECTED_PROGRAM_ID" ]] || die "deployer pubkey must not be the program ID."

rpc_result() {
  python3 - "$RPC" "$1" "$2" <<'PY'
import json, sys, urllib.request
url, method, params = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.dumps({
    "jsonrpc": "2.0",
    "id": 1,
    "method": method,
    "params": json.loads(params),
}).encode()
request = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
with urllib.request.urlopen(request, timeout=30) as response:
    payload = json.load(response)
if "error" in payload:
    sys.stderr.write(json.dumps(payload["error"]) + "\n")
    raise SystemExit(1)
json.dump(payload["result"], sys.stdout)
PY
}

echo "==> Checking mainnet genesis before build"
GENESIS="$(rpc_result getGenesisHash '[]')"
GENESIS="${GENESIS//\"/}"
[[ "$GENESIS" == "$MAINNET_GENESIS" ]] || die "RPC genesis is $GENESIS, not mainnet-beta ($MAINNET_GENESIS). Refusing to deploy."

echo "==> Building Pinocchio production artifact"
cargo-build-sbf --manifest-path "$PINOCCHIO_MANIFEST" --arch v0

[[ -f "$PINOCCHIO_SO" ]] || die "build did not produce $PINOCCHIO_SO"
[[ "$(basename "$PINOCCHIO_SO")" == "arena_escrow_pinocchio.so" ]] || die "unexpected artifact name."
if [[ -f "$ANCHOR_SO" && "$PINOCCHIO_SO" -ef "$ANCHOR_SO" ]]; then
  die "refusing to deploy the Anchor artifact $ANCHOR_SO"
fi

BYTES="$(wc -c < "$PINOCCHIO_SO" | tr -d '[:space:]')"
SHA256="$(sha256sum "$PINOCCHIO_SO" | awk '{print $1}')"
[[ "$BYTES" =~ ^[1-9][0-9]*$ ]] || die "artifact size is invalid: $BYTES"

PROGRAMDATA_LEN=$((BYTES + PROGRAMDATA_METADATA_LEN))
PROGRAM_ACCOUNT_RENT="$(rpc_result getMinimumBalanceForRentExemption "[$PROGRAM_ACCOUNT_DATA_LEN]")"
PROGRAMDATA_RENT="$(rpc_result getMinimumBalanceForRentExemption "[$PROGRAMDATA_LEN]")"
PROGRAM_ACCOUNT_RENT="${PROGRAM_ACCOUNT_RENT//[^0-9]/}"
PROGRAMDATA_RENT="${PROGRAMDATA_RENT//[^0-9]/}"
BALANCE_JSON="$(rpc_result getBalance "[\"$PAYER_PUBKEY\"]")"
BALANCE="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])' <<<"$BALANCE_JSON")"
BALANCE="${BALANCE//[^0-9]/}"

set +e
SHOW_OUTPUT="$(solana program show "$EXPECTED_PROGRAM_ID" --url "$RPC" 2>&1)"
SHOW_STATUS=$?
set -e

DEPLOY_MODE="initial"
if [[ "$SHOW_STATUS" -eq 0 ]]; then
  DEPLOY_MODE="upgrade"
  ONCHAIN_AUTHORITY="$(printf '%s\n' "$SHOW_OUTPUT" | awk -F': ' '/^Authority:/ {print $2; exit}')"
  [[ -n "$ONCHAIN_AUTHORITY" ]] || die "could not read the on-chain upgrade authority."
  [[ "$ONCHAIN_AUTHORITY" != "none" ]] || die "on-chain program has no upgrade authority. This script will not deploy or change authority."
  [[ "$ONCHAIN_AUTHORITY" == "$PAYER_PUBKEY" ]] || die "on-chain upgrade authority is $ONCHAIN_AUTHORITY; configured deployer is $PAYER_PUBKEY. Refusing to change authority."
  REQUIRED_LAMPORTS=$((PROGRAMDATA_RENT + FEE_RESERVE_LAMPORTS))
else
  case "$SHOW_OUTPUT" in
    *"not found"*|*"Not found"*|*"does not exist"*|*"AccountNotFound"*|*"unable to find"*|*"Unable to find"*)
      DEPLOY_MODE="initial"
      ;;
    *)
      echo "$SHOW_OUTPUT" >&2
      die "could not determine whether the program is already deployed."
      ;;
  esac
  REQUIRED_LAMPORTS=$((PROGRAM_ACCOUNT_RENT + PROGRAMDATA_RENT + FEE_RESERVE_LAMPORTS))
fi

echo
echo "Pinocchio mainnet deployment plan"
echo "  Artifact:          $PINOCCHIO_SO"
echo "  Size:              $BYTES bytes"
echo "  SHA-256:           $SHA256"
echo "  Program ID:        $EXPECTED_PROGRAM_ID"
echo "  Program keypair:   $PROGRAM_KEYPAIR"
echo "  Payer:             $PAYER_PUBKEY"
echo "  Payer keypair:     $DEPLOY_KEYPAIR"
echo "  Upgrade authority: $PAYER_PUBKEY"
echo "  Authority keypair: $DEPLOY_KEYPAIR"
echo "  RPC genesis:       $GENESIS"
echo "  Mode:              $DEPLOY_MODE"
echo "  Program rent:      $(sol_format "$PROGRAM_ACCOUNT_RENT") SOL"
echo "  Program data rent: $(sol_format "$PROGRAMDATA_RENT") SOL"
echo "  Fee reserve:       $(sol_format "$FEE_RESERVE_LAMPORTS") SOL"
echo "  Required balance:  $(sol_format "$REQUIRED_LAMPORTS") SOL"
echo "  Payer balance:     $(sol_format "$BALANCE") SOL"
if [[ "$DEPLOY_MODE" == "initial" ]]; then
  echo "  Rent stays in the new program and program-data accounts."
else
  echo "  Upgrade rent is the temporary buffer. It returns to the payer after a successful upgrade; fees do not."
fi
echo "  Upgrade authority is retained. This command does not pass --final."
echo
DEPLOY_ARGS=(
  program deploy "$PINOCCHIO_SO"
  --url "$RPC"
  --keypair "$DEPLOY_KEYPAIR"
  --program-id "$PROGRAM_KEYPAIR"
  --upgrade-authority "$DEPLOY_KEYPAIR"
)
for part in "${DEPLOY_ARGS[@]}"; do
  [[ "$part" != "--final" ]] || die "refusing an immutable deployment."
done

echo "Deployment command:"
echo "  solana program deploy \"$PINOCCHIO_SO\" \\"
echo "    --url \"$RPC\" \\"
echo "    --keypair \"$DEPLOY_KEYPAIR\" \\"
echo "    --program-id \"$PROGRAM_KEYPAIR\" \\"
echo "    --upgrade-authority \"$DEPLOY_KEYPAIR\""
echo

if (( BALANCE < REQUIRED_LAMPORTS )); then
  die "payer balance is below the printed requirement. No deployment was sent."
fi

if [[ "$CONFIRM" -ne 1 ]]; then
  echo "Refusing to deploy. Re-run with --confirm-mainnet after reviewing this plan." >&2
  echo "No funds were moved." >&2
  exit 2
fi

echo "==> Deploying Pinocchio program. Upgrade authority remains $PAYER_PUBKEY."
solana "${DEPLOY_ARGS[@]}"
