# Chain economy (POKE passport / SOL wagers / CARDS treasury)

Production-shaped Solana rails. Local validator runs the same instructions as
Devnet and mainnet. Postgres mirrors intents and receipts; chain balances are
authoritative for SOL and SPL POKE.

## Product rules

| Asset | Role |
| --- | --- |
| **POKE** | Passport: liquid wallet value ≥ **$20** unlocks Arena play. Chain tournament registration is free; after a 32-player field fills, each final roster player deposits exactly **10,000 POKE** (10,000,000,000 raw atoms on the 6-decimal mint), which is burned when the roster locks. A full field burns **320,000 POKE** (320,000,000,000 raw atoms). |
| **SOL** | Casual collateral and tournament prizes. **2%** fee once at match start. |
| **CARDS** | Creator-reward source (external). Realized SOL deposits split **90% treasury / 10% operator**. |

## Exact economic formulas

There are two deliberate rails. Legacy/mock tournaments use POKE accounting;
production-shaped chain tournaments use a fixed POKE burn plus a SOL prize
funded by the treasury.

| Flow | Gross input | Allocations | Exact remainder |
| --- | --- | --- | --- |
| Legacy/mock casual win | `2 × collateral` POKE | `fee = floor(gross × 200 / 10,000)`; winner receives `gross − fee` | Fee is not credited to a wallet; it is destroyed in mock accounting |
| Legacy/mock casual tie | `2 × collateral` POKE | Players receive `floor(gross / 2)` and `gross − floor(gross / 2)` | No fee is charged on a tie |
| Legacy/mock tournament | `playerCount × entryFee` POKE | Champion receives `floor(gross × 9,000 / 10,000)` | The 10% dev-ops remainder is not credited in the legacy mock rail |
| Chain casual win | `2 × collateral` lamports | `fee = floor(gross × 200 / 10,000)` goes to `fee_vault`; winner receives the remaining vault balance above rent | Transaction fees and the vault's rent reserve are separate from wager economics |
| Chain casual tie | `2 × collateral` lamports | Before fee charge, both deposits are refunded; after fee charge, the remaining vault is split `floor(remaining / 2)` and remainder to the opponent | The fee is charged at most once |
| Chain tournament entry | `playerCount × 10,000 POKE` | Each final player deposits exactly `10,000,000,000` raw atoms; the keeper burns each entry at lock | No POKE prize or POKE treasury allocation |
| Realized treasury deposit | `gross` lamports | `treasury = floor(gross × 9,000 / 10,000)`; `operator = gross − treasury` | Operator receives the integer remainder |
| Chain tournament prize | `prizeLamports` from treasury | Reserve moves the configured amount to the prize vault; payout moves exactly that amount to the stored winner | No new SOL is minted |
| Optional buyback/burn | Requested `solAmount` and configured `buybackBps` | `spend = floor(solAmount × buybackBps / 10,000)` from `fee_vault`; `minPokeOut` is burned | Slippage, minimum spend, funds, mint, and replay checks can reject the operation |

The authoritative server-side legacy math is
`packages/db/src/economics-math.ts`. Chain fee/split previews and fixed
denominations mirror the program rules in `packages/solana-client/src`, while
the Pinocchio program in `programs/arena-escrow-pinocchio/src` is authoritative
for on-chain movement and replay enforcement. The frontend uses the shared
Solana-client preview for display projections; it does not recalculate the
legacy tournament split itself.

## Packages

- `programs/arena-escrow-pinocchio` — production implementation
- `programs/arena-escrow` — Anchor parity/oracle reference (escrow, fee, burn, treasury, prize, buyback)
- `packages/solana-client` — config, quotes, passport math, instruction builders, RPC client
- `packages/db` migrations `005`–`007` — intents, quotes, treasury ledger, entry escrows
- `packages/api` — `ChainEconomyService`, WS messages, passport gates

## Deployment roles

| Role | What to use |
| --- | --- |
| Production program | Pinocchio artifact `target/deploy/arena_escrow_pinocchio.so` |
| Mainnet deployment | `scripts/solana/deploy-pinocchio-mainnet.sh` |
| Mainnet initialization | `scripts/solana/init-pinocchio-mainnet.mjs` after the program is deployed |
| Parity / oracle | Anchor program, `Anchor.toml`, parity campaigns, and Anchor-based tests |
| Local validator | `scripts/solana/*validator*` and `bootstrap-local.sh` — testing only |

Program ID for both builds: `41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W`.
The mainnet script refuses devnet and localnet. See
[`docs/deployment.md`](deployment.md) for the required deployer keypair, RPC,
and confirmation flag.

## Feature flag

```text
POKEARENA_CHAIN_ECONOMY=true
```

Default **false**. When off, legacy mock POKE economics remain (grandfathered).

## Local path

See [`scripts/solana/README.md`](../scripts/solana/README.md).

```text
Local validator (testing) → production env → mainnet Pinocchio deploy
```

## Chain tournament lifecycle

`tournament.join` creates only a durable provisional registration. When 32
players are registered, the server opens a two-minute payment window. Players
pay exactly 10,000 POKE (10,000,000,000 raw atoms) through `tournament.payBurnFee`; unpaid players are
removed and eligible waitlisted players are promoted in registration order,
with a fresh two-minute window for each replacement. The keeper reserves the
configured SOL prize and burns all 32 entries only after the final roster is
complete and every player is paid. Chain tournaments cannot be cancelled once
this finalization window opens.

## Launch blockers (configured, not rewritten)

- Mainnet Pinocchio deployment has its own funded deployer keypair, explicit
  mainnet RPC, and `--confirm-mainnet` confirmation. The program ID is fixed;
  the script does not generate wallets or revoke upgrade authority.
- Mainnet initialization is a second command,
  `node scripts/solana/init-pinocchio-mainnet.mjs`. It creates the config and
  three vault PDAs only after the program is deployed. The production mint,
  keeper public key, quote authority, and buyback values must be supplied.
  It does not create wallets or deposit the local treasury seed.
- `POKEARENA_TOURNAMENT_PRIZE_LAMPORTS` must be set to a funded prize reserve.
  Fund the treasury with an explicit deposit after initialization. A 0.1 SOL
  prize needs at least 111,111,112 lamports gross because 90% reaches the
  treasury vault.
- Oracle provider for the on-chain passport quote (env quote works for local).
  USD holding checks for an arbitrary SPL mint use Jupiter Price API v3;
  see `docs/play-token-oracle.md`. `PLAY_TOKEN_MINT` stays unset until that mint exists.
- CARDS claim/swap adapter (treasury accepts realized SOL deposits now)
- Buyback bps (`POKEARENA_BUYBACK_BPS`)
