#!/usr/bin/env bash
# READ-ONLY validation campaign: run the same local scenario matrix against
# Anchor then Pinocchio binaries under isolated ledgers, then diff outcomes.
#
# Does NOT modify Anchor sources, Anchor.toml production mapping, or deploy to
# Devnet/Mainnet. Uses local validator + airdropped test SOL only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"

PROGRAM_ID="${POKEARENA_PROGRAM_ID:-26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke}"
ANCHOR_SO="$ROOT/target/deploy/arena_escrow.so"
PINOCCHIO_SO="$ROOT/target/deploy/arena_escrow_pinocchio.so"
OUT_DIR="${POKEARENA_PARITY_DIR:-$ROOT/scripts/solana/parity-out}"
RPC="${POKEARENA_SOLANA_RPC:-http://127.0.0.1:8899}"
mkdir -p "$OUT_DIR"

# Prefer host Node when WSL has none. Windows node.exe cannot open /mnt/<drive>/...
# paths, so convert those to D:/... form for all Node/npm invocations.
to_host_path() {
  local p="$1"
  if [[ "$p" =~ ^/mnt/([a-zA-Z])/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1]}"
    local rest="${BASH_REMATCH[2]}"
    echo "${drive^^}:/${rest}"
  else
    echo "$p"
  fi
}

NODE_BIN="$(command -v node || true)"
NODE_IS_WIN=0
if [[ -z "$NODE_BIN" ]]; then
  for candidate in \
    /mnt/c/Program\ Files/nodejs/node.exe \
    /mnt/c/Program\ Files\ \(x86\)/nodejs/node.exe
  do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      NODE_IS_WIN=1
      break
    fi
  done
elif [[ "$NODE_BIN" == *.exe ]]; then
  NODE_IS_WIN=1
fi
if [[ -z "${NODE_BIN:-}" ]]; then
  echo "ERROR: node binary not found" >&2
  exit 1
fi

NPM_BIN="$(command -v npm || true)"
if [[ -z "$NPM_BIN" ]]; then
  for candidate in \
    /mnt/c/Program\ Files/nodejs/npm.cmd \
    /mnt/c/Program\ Files\ \(x86\)/nodejs/npm.cmd
  do
    if [[ -f "$candidate" ]]; then
      NPM_BIN="$candidate"
      NODE_IS_WIN=1
      break
    fi
  done
fi

host_path() {
  if [[ "$NODE_IS_WIN" == "1" ]]; then
    to_host_path "$1"
  else
    echo "$1"
  fi
}

ROOT_HOST="$(host_path "$ROOT")"
OUT_DIR_HOST="$(host_path "$OUT_DIR")"
CLIENT_DIR_HOST="$(host_path "$ROOT/packages/solana-client")"
API_DIR_HOST="$(host_path "$ROOT/packages/api")"

kill_validators() {
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null || true
  done < <(ps -eo pid,args | awk '/solana-test-validator/ && !/awk/ && !/run-parity-campaign/ {print $1}')
  sleep 1
}

wait_rpc() {
  for _ in $(seq 1 60); do
    if solana cluster-version --url "$RPC" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_bins() {
  if [[ ! -f "$ANCHOR_SO" ]]; then
    echo "==> Building Anchor reference binary"
    cargo-build-sbf --manifest-path "$ROOT/programs/arena-escrow/Cargo.toml" --arch v0
  fi
  if [[ ! -f "$PINOCCHIO_SO" ]]; then
    echo "==> Building Pinocchio parity binary"
    cargo-build-sbf --manifest-path "$ROOT/programs/arena-escrow-pinocchio/Cargo.toml" --arch v0
  fi
  echo "Anchor SO:    $(wc -c < "$ANCHOR_SO" | tr -d ' ') bytes"
  echo "Pinocchio SO: $(wc -c < "$PINOCCHIO_SO" | tr -d ' ') bytes"
}

run_against() {
  local impl="$1"
  local so="$2"
  local ledger="$3"
  local report="$4"
  local log="/tmp/pokearena-parity-${impl}.log"

  echo ""
  echo "============================================================"
  echo "==> Campaign against ${impl}"
  echo "    so=$so"
  echo "    ledger=$ledger"
  echo "============================================================"

  kill_validators
  rm -rf "$ledger"

  nohup solana-test-validator \
    --ledger "$ledger" \
    --reset \
    --bind-address 127.0.0.1 \
    --rpc-port 8899 \
    --bpf-program "$PROGRAM_ID" "$so" \
    >"$log" 2>&1 &
  echo "validator pid $!"

  if ! wait_rpc; then
    echo "validator failed ($impl)" >&2
    tail -60 "$log" >&2 || true
    exit 1
  fi

  export POKEARENA_PROGRAM_ID="$PROGRAM_ID"
  export POKEARENA_PROGRAM_SO="$so"
  export POKEARENA_SOLANA_RPC="$RPC"
  unset POKEARENA_FORCE_DEPLOY || true
  "$ROOT/scripts/solana/bootstrap-local.sh"

  set -a
  # shellcheck disable=SC1091
  source "$ROOT/scripts/solana/.local.env"
  set +a
  export POKEARENA_CHAIN_ECONOMY=true
  export POKEARENA_SOLANA_KEYS="${POKEARENA_SOLANA_KEYS:-$ROOT/scripts/solana/keys}"
  export POKEARENA_PARITY_IMPL="$impl"
  export POKEARENA_PARITY_OUT="$report"

  # Mint a small POKE balance to authority ATA so buyback success can run.
  if command -v spl-token >/dev/null 2>&1; then
    AUTH_PUB="$(solana-keygen pubkey "$POKEARENA_SOLANA_KEYS/authority.json")"
    spl-token create-account "$POKEARENA_POKE_MINT" \
      --owner "$AUTH_PUB" \
      --fee-payer "$POKEARENA_SOLANA_KEYS/authority.json" \
      --url "$RPC" >/dev/null 2>&1 || true
    spl-token mint "$POKEARENA_POKE_MINT" 1000 \
      --recipient-owner "$AUTH_PUB" \
      --mint-authority "$POKEARENA_SOLANA_KEYS/authority.json" \
      --fee-payer "$POKEARENA_SOLANA_KEYS/authority.json" \
      --url "$RPC" >/dev/null 2>&1 || true
  fi

  REPORT_HOST="$(host_path "$report")"
  KEYS_HOST="$(host_path "$POKEARENA_SOLANA_KEYS")"
  WEB3_HOST="$(host_path "$ROOT/packages/solana-client/node_modules/@solana/web3.js")"
  INIT_HOST="$(host_path "$ROOT/scripts/solana/init-config.mjs")"

  (
    cd "$ROOT/packages/solana-client"
    if [[ -n "${NPM_BIN:-}" ]]; then
      # npm.cmd needs a Windows cwd when invoked from WSL.
      if [[ "$NPM_BIN" == *.cmd ]]; then
        cmd.exe /c "cd /d $(host_path "$ROOT/packages/solana-client") && npm run build" >/dev/null
      else
        "$NPM_BIN" run build >/dev/null
      fi
    else
      "$NODE_BIN" "$(host_path "$ROOT/packages/solana-client/node_modules/typescript/bin/tsc")" -p "$(host_path "$ROOT/packages/solana-client/tsconfig.json")"
    fi
  )

  "$NODE_BIN" "$INIT_HOST"

  set -a
  # shellcheck disable=SC1091
  source "$ROOT/scripts/solana/.local.env"
  set +a

  if [[ -z "${POKEARENA_FEE_VAULT:-}" ]]; then
    eval "$("$NODE_BIN" -e "
      const {PublicKey}=require('$WEB3_HOST');
      const pid=new PublicKey('$PROGRAM_ID');
      const fee=PublicKey.findProgramAddressSync([Buffer.from('fee_vault')], pid)[0].toBase58();
      const tre=PublicKey.findProgramAddressSync([Buffer.from('treasury_vault')], pid)[0].toBase58();
      const op=PublicKey.findProgramAddressSync([Buffer.from('operator_vault')], pid)[0].toBase58();
      console.log('export POKEARENA_FEE_VAULT='+fee);
      console.log('export POKEARENA_TREASURY_VAULT='+tre);
      console.log('export POKEARENA_OPERATOR_VAULT='+op);
    ")"
  fi

  echo "==> Running solana-client suite + parity campaign ($impl)"
  export POKEARENA_CHAIN_ECONOMY=true
  export POKEARENA_SOLANA_RPC="$RPC"
  export POKEARENA_PROGRAM_ID="$PROGRAM_ID"
  export POKEARENA_POKE_MINT="${POKEARENA_POKE_MINT:-}"
  export POKEARENA_FEE_VAULT="${POKEARENA_FEE_VAULT:-}"
  export POKEARENA_TREASURY_VAULT="${POKEARENA_TREASURY_VAULT:-}"
  export POKEARENA_OPERATOR_VAULT="${POKEARENA_OPERATOR_VAULT:-}"
  export POKEARENA_SOLANA_KEYS="$KEYS_HOST"
  export POKEARENA_PARITY_IMPL="$impl"
  export POKEARENA_PARITY_OUT="$REPORT_HOST"
  if [[ -n "${NPM_BIN:-}" && "$NPM_BIN" == *.cmd ]]; then
    cmd.exe /c "cd /d $CLIENT_DIR_HOST && set POKEARENA_CHAIN_ECONOMY=true&& set POKEARENA_SOLANA_RPC=$RPC&& set POKEARENA_PROGRAM_ID=$PROGRAM_ID&& set POKEARENA_POKE_MINT=$POKEARENA_POKE_MINT&& set POKEARENA_FEE_VAULT=$POKEARENA_FEE_VAULT&& set POKEARENA_TREASURY_VAULT=$POKEARENA_TREASURY_VAULT&& set POKEARENA_OPERATOR_VAULT=$POKEARENA_OPERATOR_VAULT&& set POKEARENA_SOLANA_KEYS=$KEYS_HOST&& set POKEARENA_PARITY_IMPL=$impl&& set POKEARENA_PARITY_OUT=$REPORT_HOST&& npm test"
  elif [[ -n "${NPM_BIN:-}" ]]; then
    (
      cd "$ROOT/packages/solana-client"
      "$NPM_BIN" test
    )
  else
    (
      cd "$ROOT/packages/solana-client"
      "$NODE_BIN" --test dist/test/**/*.test.js
    )
  fi

  echo "==> $impl campaign report: $report"
}

ensure_bins
run_against "anchor" "$ANCHOR_SO" "/tmp/pokearena-parity-anchor-ledger" "$OUT_DIR/anchor-report.json"
run_against "pinocchio" "$PINOCCHIO_SO" "/tmp/pokearena-parity-pinocchio-ledger" "$OUT_DIR/pinocchio-report.json"

echo ""
echo "==> Diffing Anchor vs Pinocchio campaign reports"
"$NODE_BIN" "$(host_path "$ROOT/scripts/solana/compare-parity-reports.cjs")" \
  "$(host_path "$OUT_DIR/anchor-report.json")" \
  "$(host_path "$OUT_DIR/pinocchio-report.json")" \
  "$(host_path "$OUT_DIR/diff-report.json")"

# API mock-ledger suite (does not load either .so; still required for client/service safety).
if [[ -f "$ROOT/packages/api/package.json" ]]; then
  echo "==> Running @pokearena/api test suite (mock ledger / service safety)"
  if [[ -n "${NPM_BIN:-}" && "$NPM_BIN" == *.cmd ]]; then
    cmd.exe /c "cd /d $API_DIR_HOST && npm test" | tee "$OUT_DIR/api-test.log"
  elif [[ -n "${NPM_BIN:-}" ]]; then
    (
      cd "$ROOT/packages/api"
      "$NPM_BIN" test
    ) | tee "$OUT_DIR/api-test.log"
  fi
fi

echo ""
echo "Parity campaign complete."
echo "Reports: $OUT_DIR"
ls -la "$OUT_DIR"
