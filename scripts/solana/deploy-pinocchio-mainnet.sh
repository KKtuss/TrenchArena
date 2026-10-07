#!/usr/bin/env bash
# Deploy the STAGING Pinocchio arena escrow program to Solana mainnet.
#
# Builds target/deploy/arena_escrow_pinocchio.so and never deploys the Anchor
# artifact. The four staging signers are explicit environment values. This
# script does not generate keypairs, fund wallets, or reuse the retired
# staging program and wallets. A closed ProgramData account is recognized
# and is not redeployed.
#
# No --confirm-mainnet means dry-run: the preflight reads accounts and prints
# the plan. It does not send a transaction, initialize config, or close an
# account. --confirm-mainnet deploys only when the preflight exit code is 0.
set -euo pipefail

EXPECTED_PROGRAM_ID="6dHMWQd1M2ZZSmrkQLGZcFpHnvHi8rcH68QqQJ4Kj4r8"
EXPECTED_ELF_BYTES=131408
EXPECTED_ELF_SHA256="03154ec42a2cfc75866a5cf28cd27254d2c7cf63ee03910d415096027ef04837"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PINOCCHIO_MANIFEST="$ROOT/programs/arena-escrow-pinocchio/Cargo.toml"
PINOCCHIO_SO="$ROOT/target/deploy/arena_escrow_pinocchio.so"
ANCHOR_SO="$ROOT/target/deploy/arena_escrow.so"
PREFLIGHT="$ROOT/scripts/solana/staging-deploy-preflight.mjs"
PROGRAM_KEYPAIR="${POKEARENA_PROGRAM_KEYPAIR:-}"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"

die() {
  echo "error: $*" >&2
  exit 1
}

require_clean_source() {
  command -v git >/dev/null 2>&1 || die "required command not found: git"
  [[ -z "$(git -C "$ROOT" -c core.autocrlf=true diff --name-only)" ]] \
    || die "source tree has unstaged changes. Commit the certified source first."
  [[ -z "$(git -C "$ROOT" -c core.autocrlf=true diff --cached --name-only)" ]] \
    || die "source tree has staged changes. Commit the certified source first."
  [[ -z "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]] \
    || die "source tree has uncommitted or untracked files. Use the clean certified commit."
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

CONFIRM=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --confirm-mainnet) CONFIRM=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) die "unknown argument: $arg" ;;
  esac
done
if [[ "$CONFIRM" -eq 1 && "$DRY_RUN" -eq 1 ]]; then
  die "--dry-run cannot be combined with --confirm-mainnet."
fi
require_clean_source

CLUSTER="$(printf '%s' "${POKEARENA_SOLANA_CLUSTER:-}" | tr '[:upper:]' '[:lower:]')"
RPC="${POKEARENA_SOLANA_RPC:-}"
DEPLOY_KEYPAIR="${POKEARENA_DEPLOY_KEYPAIR:-}"
CONFIGURED_PROGRAM_ID="${POKEARENA_PROGRAM_ID:-}"

[[ "${POKEARENA_STAGING:-}" == "true" ]] || die "set POKEARENA_STAGING=true. This script is staging-only."
[[ "$CONFIGURED_PROGRAM_ID" == "$EXPECTED_PROGRAM_ID" ]] \
  || die "POKEARENA_PROGRAM_ID must be the certified fresh program $EXPECTED_PROGRAM_ID."
case "$CONFIGURED_PROGRAM_ID" in
  6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98)
    die "refusing retired staging program 6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98. Generate a new program keypair."
    ;;
  54Ji1Z32wH4NfDqpd3WMTbSBeK119ptAMmYcQirCUmmU)
    die "refusing retired staging program 54Ji1Z32wH4NfDqpd3WMTbSBeK119ptAMmYcQirCUmmU. Generate a new program keypair."
    ;;
  41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W)
    die "refusing production program 41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W."
    ;;
esac
[[ "$CLUSTER" == "mainnet-beta" || "$CLUSTER" == "mainnet" ]] || die "set POKEARENA_SOLANA_CLUSTER=mainnet-beta. This script refuses devnet, testnet, and localnet."
[[ -n "$RPC" ]] || die "set POKEARENA_SOLANA_RPC to an explicit mainnet HTTPS URL."
[[ "$RPC" =~ ^https:// ]] || die "POKEARENA_SOLANA_RPC must be an explicit https URL, not a cluster nickname or local endpoint."

RPC_LOWER="$(printf '%s' "$RPC" | tr '[:upper:]' '[:lower:]')"
case "$RPC_LOWER" in
  *devnet*|*testnet*|*localnet*|*localhost*|*127.0.0.1*|*0.0.0.0*|*\[::1\]*)
    die "refusing non-mainnet RPC."
    ;;
esac

[[ -f "$PREFLIGHT" ]] || die "preflight module not found: $PREFLIGHT"
if [[ -n "$DEPLOY_KEYPAIR" && -n "$PROGRAM_KEYPAIR" && "$DEPLOY_KEYPAIR" -ef "$PROGRAM_KEYPAIR" ]]; then
  die "deployer and program keypairs must be different files."
fi

require_cmd cargo-build-sbf
require_cmd solana
require_cmd solana-keygen
require_cmd sha256sum
require_cmd python3

node_major() {
  "$1" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

NODE_BIN=""
if [[ "$(node_major node)" -ge 22 ]]; then
  NODE_BIN="node"
else
  WIN_NODE="/mnt/c/Program Files/nodejs/node.exe"
  if [[ -f "$WIN_NODE" && "$(node_major "$WIN_NODE")" -ge 22 ]]; then
    NODE_BIN="$WIN_NODE"
  fi
fi
[[ -n "$NODE_BIN" ]] || die "Node.js >= 22 is required for the staging preflight."

pubkey_of() {
  local file="$1"
  if [[ -n "$file" && -f "$file" ]]; then
    solana-keygen pubkey "$file"
  fi
}

PROGRAM_PUBKEY="$(pubkey_of "$PROGRAM_KEYPAIR")"
PAYER_PUBKEY="$(pubkey_of "$DEPLOY_KEYPAIR")"
AUTHORITY_PUBKEY="$(pubkey_of "${POKEARENA_AUTHORITY_KEYPAIR:-}")"
KEEPER_PUBKEY="$(pubkey_of "${POKEARENA_KEEPER_KEYPAIR:-}")"
export POKEARENA_PROGRAM_KEYPAIR_PUBKEY="$PROGRAM_PUBKEY"
export POKEARENA_DEPLOYER_PUBKEY="$PAYER_PUBKEY"
export POKEARENA_AUTHORITY_KEYPAIR_PUBKEY="$AUTHORITY_PUBKEY"
export POKEARENA_KEEPER_KEYPAIR_PUBKEY="$KEEPER_PUBKEY"
IDENTITIES_READY=1
[[ -n "$CONFIGURED_PROGRAM_ID" && -n "$PROGRAM_PUBKEY" && -n "$PAYER_PUBKEY" && -n "${POKEARENA_AUTHORITY:-}" && -n "${POKEARENA_KEEPER:-}" ]] || IDENTITIES_READY=0
if [[ "$NODE_BIN" == *.exe ]]; then
  export POKEARENA_ARTIFACT="$(wslpath -w "$PINOCCHIO_SO")"
  PREFLIGHT_PATH="$(wslpath -w "$PREFLIGHT")"
else
  export POKEARENA_ARTIFACT="$PINOCCHIO_SO"
  PREFLIGHT_PATH="$PREFLIGHT"
fi

if [[ "$IDENTITIES_READY" -eq 0 ]]; then
  echo "==> Fresh staging identities are not generated. Preflight will not build, deploy, or fund."
else
  echo "==> Building Pinocchio staging artifact"
  cargo-build-sbf --manifest-path "$PINOCCHIO_MANIFEST" --arch v0
fi

if [[ "$IDENTITIES_READY" -eq 1 ]]; then
  [[ -f "$PINOCCHIO_SO" ]] || die "build did not produce $PINOCCHIO_SO"
fi
[[ "$(basename "$PINOCCHIO_SO")" == "arena_escrow_pinocchio.so" ]] || die "unexpected artifact name."
if [[ -f "$ANCHOR_SO" && "$PINOCCHIO_SO" -ef "$ANCHOR_SO" ]]; then
  die "refusing to deploy the Anchor artifact $ANCHOR_SO"
fi
if [[ "$IDENTITIES_READY" -eq 1 ]]; then
  BYTES="$(wc -c < "$PINOCCHIO_SO" | tr -d '[:space:]')"
  SHA256="$(sha256sum "$PINOCCHIO_SO" | awk '{print $1}')"
  [[ "$BYTES" -eq "$EXPECTED_ELF_BYTES" ]] \
    || die "artifact size is $BYTES bytes, expected certified size $EXPECTED_ELF_BYTES."
  [[ "$SHA256" == "$EXPECTED_ELF_SHA256" ]] \
    || die "artifact SHA-256 is $SHA256, expected certified hash $EXPECTED_ELF_SHA256."
  python3 - "$PINOCCHIO_SO" "$PROGRAM_PUBKEY" <<'PY'
import pathlib, sys

alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
text = sys.argv[2]
value = 0
for char in text:
    value = value * 58 + alphabet.index(char)
pad = len(text) - len(text.lstrip("1"))
raw = value.to_bytes((value.bit_length() + 7) // 8, "big") if value else b""
raw = (b"\x00" * pad) + raw
if len(raw) != 32:
    sys.stderr.write(f"program pubkey did not decode to 32 bytes: {len(raw)}\n")
    raise SystemExit(1)
if raw not in pathlib.Path(sys.argv[1]).read_bytes():
    sys.stderr.write("built ELF does not contain the program keypair pubkey.\n")
    raise SystemExit(1)
PY
fi

PREFLIGHT_ARGS=()
if [[ "$CONFIRM" -eq 1 && "$IDENTITIES_READY" -eq 1 ]]; then
  PREFLIGHT_ARGS+=(--confirm-mainnet)
else
  PREFLIGHT_ARGS+=(--dry-run)
fi

set +e
if [[ "$NODE_BIN" == *.exe ]]; then
  export WSLENV='POKEARENA_STAGING:POKEARENA_SOLANA_CLUSTER:POKEARENA_SOLANA_RPC:POKEARENA_PROGRAM_ID:POKEARENA_AUTHORITY:POKEARENA_KEEPER:POKEARENA_CARDS_MINT:POKEARENA_POKE_MINT:POKEARENA_BUYBACK_BPS:POKEARENA_DEPLOYER:POKEARENA_DEPLOYER_PUBKEY:POKEARENA_PROGRAM_KEYPAIR_PUBKEY:POKEARENA_AUTHORITY_KEYPAIR_PUBKEY:POKEARENA_KEEPER_KEYPAIR_PUBKEY:POKEARENA_ARTIFACT'
fi
"$NODE_BIN" "$PREFLIGHT_PATH" "${PREFLIGHT_ARGS[@]}"
PREFLIGHT_STATUS=$?
set -e

if [[ "$CONFIRM" -ne 1 ]]; then
  if [[ "$PREFLIGHT_STATUS" -eq 0 ]]; then
    die "dry-run preflight returned a send status. Refusing to deploy."
  fi
  exit "$PREFLIGHT_STATUS"
fi

if [[ "$PREFLIGHT_STATUS" -ne 0 ]]; then
  exit "$PREFLIGHT_STATUS"
fi
[[ -n "$DEPLOY_KEYPAIR" && -f "$DEPLOY_KEYPAIR" ]] || die "deployer keypair is NOT GENERATED."
[[ -n "$PROGRAM_KEYPAIR" && -f "$PROGRAM_KEYPAIR" ]] || die "program keypair is NOT GENERATED."

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

echo "==> Deploying Pinocchio STAGING program. Upgrade authority remains $PAYER_PUBKEY."
solana "${DEPLOY_ARGS[@]}"
