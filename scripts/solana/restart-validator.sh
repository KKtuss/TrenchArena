#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEDGER=/tmp/pokearena-ledger
PROGRAM_SO="$ROOT/target/deploy/arena_escrow.so"
PROGRAM_ID=26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke

# Kill existing validator without matching this script.
while read -r pid; do
  [[ -n "$pid" ]] || continue
  kill "$pid" 2>/dev/null || true
done < <(ps -eo pid,args | awk '/solana-test-validator/ && !/awk/ && !/restart-validator/ {print $1}')
sleep 2
rm -rf "$LEDGER"
nohup solana-test-validator \
  --ledger "$LEDGER" \
  --reset \
  --bind-address 127.0.0.1 \
  --rpc-port 8899 \
  --bpf-program "$PROGRAM_ID" "$PROGRAM_SO" \
  > /tmp/pokearena-validator.log 2>&1 &
echo "validator pid $!"
for _ in $(seq 1 30); do
  if solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; then
    solana cluster-version --url http://127.0.0.1:8899
    exit 0
  fi
  sleep 1
done
echo "validator failed to become ready" >&2
tail -40 /tmp/pokearena-validator.log >&2 || true
exit 1
