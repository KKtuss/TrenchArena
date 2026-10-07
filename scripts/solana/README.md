# Solana programs

| Role | Implementation | Deployment |
| --- | --- | --- |
| Production | `programs/arena-escrow-pinocchio` | `scripts/solana/deploy-pinocchio-mainnet.sh` deploys `target/deploy/arena_escrow_pinocchio.so` to mainnet |
| Parity / oracle | `programs/arena-escrow` and `Anchor.toml` | Reference builds and comparison campaigns only. Do not `anchor deploy` it. |
| Local testing | Either `.so`, selected by the script below | `solana-test-validator` only |

Production program ID: `41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W`.

The local path exercises **real** SOL and SPL POKE transactions against
`solana-test-validator`. It is not the mainnet deployment.

## Prerequisites

- Rust + Solana CLI (Agave) in WSL or Linux (`cargo-build-sbf`, `solana-test-validator`)
- Node 22.18+ on the host (for `packages/solana-client` and `init-config.mjs`)
- PostgreSQL when `POKEARENA_ECONOMICS=postgres`

## Quick start

```bash
# 0) Build the Anchor oracle for local comparison (WSL). This is not the mainnet artifact.
cargo-build-sbf --manifest-path programs/arena-escrow/Cargo.toml --arch v0

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

## Pinocchio production build

```bash
cargo-build-sbf --manifest-path programs/arena-escrow-pinocchio/Cargo.toml --arch v0
```

Artifact: `target/deploy/arena_escrow_pinocchio.so`.

Mainnet deployment is explicit and confirmation-gated:

```bash
export POKEARENA_SOLANA_CLUSTER=mainnet-beta
export POKEARENA_SOLANA_RPC=https://REPLACE_WITH_MAINNET_RPC
export POKEARENA_DEPLOY_KEYPAIR=/absolute/path/to/deployer.json
export POKEARENA_PROGRAM_KEYPAIR=/absolute/path/to/pokearena-mainnet-program-v2.json
./scripts/solana/deploy-pinocchio-mainnet.sh
./scripts/solana/deploy-pinocchio-mainnet.sh --confirm-mainnet
```

The deployer keypair pays for deployment and remains the upgrade authority.
The program keypair is supplied through `POKEARENA_PROGRAM_KEYPAIR` and must
live outside `scripts/solana/keys`. The script refuses devnet, testnet, and
localnet, and it does not deploy
`target/deploy/arena_escrow.so`.

## Mainnet initialization

Run this only after the program account exists. It is not a deploy, and it
does not use `init-config.mjs`.

```bash
export POKEARENA_SOLANA_CLUSTER=mainnet-beta
export POKEARENA_SOLANA_RPC=https://REPLACE_WITH_MAINNET_RPC
export POKEARENA_PROGRAM_ID=41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W
export POKEARENA_AUTHORITY_KEYPAIR=/absolute/path/to/config-authority.json
export POKEARENA_KEEPER=<production keeper public key>
export POKEARENA_QUOTE_AUTHORITY=<quote authority public key>
export POKEARENA_POKE_MINT=<6-decimal SPL mint>
export POKEARENA_BUYBACK_BPS=0
export POKEARENA_MIN_BUYBACK_LAMPORTS=50000000
node scripts/solana/init-pinocchio-mainnet.mjs
node scripts/solana/init-pinocchio-mainnet.mjs --confirm-mainnet
```

Create the keeper keypair yourself and pass only its public key. Do not point
this command at `scripts/solana/keys`. The first run prints every account and
stops. `--confirm-mainnet` sends `initialize_config` when the accounts are
absent. A matching rerun sends nothing.

## Pinocchio local parity

`run-pinocchio-parity.sh` loads the Pinocchio `.so` into a local validator
under the shared Program ID. It does not deploy to mainnet.

```bash
./scripts/solana/run-pinocchio-parity.sh
```

Offline ABI fixtures: `packages/solana-client/test/pinocchio-abi-parity.test.ts`.
Anchor-vs-Pinocchio campaigns remain in `run-parity-campaign.sh` and
`run-hardening-campaign.ps1`.

## Promotion

| Stage | RPC | What runs |
| --- | --- | --- |
| Local testing | `http://127.0.0.1:8899` | Validator scripts and `.local.env` |
| Mainnet program | explicit mainnet HTTPS RPC | `deploy-pinocchio-mainnet.sh` |
| Mainnet API | production RPC | `/etc/pokearena/api.env` only |
