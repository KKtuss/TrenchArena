# Local Solana validator (production-shaped)

This path exercises **real** SOL and SPL POKE transactions against
`solana-test-validator`. The same program IDL and TypeScript client are used
for Devnet and mainnet; only env values change.

## Prerequisites

- Rust + Solana CLI (Agave) in WSL or Linux (`cargo-build-sbf`, `solana-test-validator`)
- Node 22.18+ on the host (for `packages/solana-client` and `init-config.mjs`)
- PostgreSQL when `POKEARENA_ECONOMICS=postgres`

## Quick start

```bash
# 0) Build the program (WSL)
cargo build-sbf --manifest-path programs/arena-escrow/Cargo.toml --arch v0

# 1) Terminal A — validator (loads .so at genesis; ledger under /tmp)
./scripts/solana/restart-validator.sh
# or: ./scripts/solana/start-validator.sh

# 2) Terminal B — mint POKE + write scripts/solana/.local.env
./scripts/solana/bootstrap-local.sh

# 3) Host (Windows/macOS/Linux with Node) — initialize_config + treasury seed
#    Fill vault PDAs if bootstrap ran without Node:
npm --prefix packages/solana-client run build
# derive + write vaults into .local.env, then:
set -a; source scripts/solana/.local.env; set +a
export POKEARENA_SOLANA_KEYS="$PWD/scripts/solana/keys"
node scripts/solana/init-config.mjs

# 4) App
export POKEARENA_CHAIN_ECONOMY=true
export POKEARENA_ECONOMICS=postgres   # recommended with chain intents
pnpm --filter @pokearena/solana-client test   # includes real-tx tests when env is set
pnpm --filter @pokearena/api dev
pnpm --filter @pokearena/web dev
```

## What bootstrap creates

- Unlimited local SOL airdrops to test wallets
- SPL POKE mint (6 decimals) and ATAs
- Fee / treasury / operator **program PDAs** (created by `initialize_config`)
- Optional treasury seed deposit (90/10) simulating realized creator rewards
- Writes `scripts/solana/.local.env` (gitignored) with all addresses

## Promotion

| Stage | RPC | Secrets |
| --- | --- | --- |
| Local | `http://127.0.0.1:8899` | `.local.env` |
| Devnet | public Devnet RPC | same keys pattern, funded wallets |
| Mainnet | production RPC | `/etc/pokearena/api.env` only |

No business-logic rewrite between stages.
