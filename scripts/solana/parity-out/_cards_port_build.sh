#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:/root/.cargo/bin:/usr/bin:$PATH"
echo "=== cargo test ==="
cargo test --manifest-path programs/arena-escrow-pinocchio/Cargo.toml --no-default-features -- --test-threads=8
echo "=== cargo-build-sbf ==="
cargo-build-sbf --manifest-path programs/arena-escrow-pinocchio/Cargo.toml --arch v0
SO=target/deploy/arena_escrow_pinocchio.so
ls -l "$SO"
sha256sum "$SO"
python3 - <<'PY'
import json
import os
import urllib.request

rpc = "https://api.mainnet-beta.solana.com"
size = os.path.getsize("target/deploy/arena_escrow_pinocchio.so")
programdata_len = size + 45

def rent(space):
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": space,
        "method": "getMinimumBalanceForRentExemption",
        "params": [space],
    }).encode()
    request = urllib.request.Request(
        rpc,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(result["error"])
    return int(result["result"])

program_account_len = 36
programdata_rent = rent(programdata_len)
program_account_rent = rent(program_account_len)
print(f"rent_rpc={rpc}")
print(f"elf={size}")
print(f"programdata={programdata_len}")
print(f"programdata_rent_lamports={programdata_rent}")
print(f"programdata_rent_sol={programdata_rent/1_000_000_000:.9f}")
print(f"program_account={program_account_len}")
print(f"program_account_rent_lamports={program_account_rent}")
print(f"program_account_rent_sol={program_account_rent/1_000_000_000:.9f}")
PY
