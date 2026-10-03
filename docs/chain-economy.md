# Chain economy (POKE passport / SOL wagers / CARDS treasury)

Production-shaped Solana rails. Local validator runs the same instructions as
Devnet and mainnet. Postgres mirrors intents and receipts; chain balances are
authoritative for SOL and SPL POKE.

## Product rules

| Asset | Role |
| --- | --- |
| **POKE** | Passport: liquid wallet value ≥ **$20** unlocks Arena play. Chain tournament registration is free; after a 32-player field fills, each final roster player deposits exactly **10,000 POKE**, which is burned when the roster locks. |
| **SOL** | Casual collateral and tournament prizes. **2%** fee once at match start. |
| **CARDS** | Creator-reward source (external). Realized SOL deposits split **90% treasury / 10% operator**. |

## Packages

- `programs/arena-escrow-pinocchio` — production candidate (Anchor remains the reference/oracle)
- `programs/arena-escrow` — Anchor reference program (escrow, fee, burn, treasury, prize, buyback)
- `packages/solana-client` — config, quotes, passport math, instruction builders, RPC client
- `packages/db` migrations `005`–`007` — intents, quotes, treasury ledger, entry escrows
- `packages/api` — `ChainEconomyService`, WS messages, passport gates

## Feature flag

```text
POKEARENA_CHAIN_ECONOMY=true
```

Default **false**. When off, legacy mock POKE economics remain (grandfathered).

## Local path

See [`scripts/solana/README.md`](../scripts/solana/README.md).

```text
Local validator → real txs → Devnet → production env → mainnet
```

## Chain tournament lifecycle

`tournament.join` creates only a durable provisional registration. When 32
players are registered, the server opens a two-minute payment window. Players
pay exactly 10,000 POKE through `tournament.payBurnFee`; unpaid players are
removed and eligible waitlisted players are promoted in registration order,
with a fresh two-minute window for each replacement. The keeper reserves the
configured SOL prize and burns all 32 entries only after the final roster is
complete and every player is paid. Chain tournaments cannot be cancelled once
this finalization window opens.

## Launch blockers (configured, not rewritten)

- Production POKE mint, RPC, Pinocchio program id, vaults, authorities, and
  keeper keypair must be initialized/configured before chain tournaments can
  function.
- `POKEARENA_TOURNAMENT_PRIZE_LAMPORTS` must be set to a funded prize reserve.
- Oracle provider for the on-chain passport quote (env quote works for local).
  USD holding checks for an arbitrary SPL mint use Jupiter Price API v3;
  see `docs/play-token-oracle.md`. `PLAY_TOKEN_MINT` stays unset until that mint exists.
- CARDS claim/swap adapter (treasury accepts realized SOL deposits now)
- Buyback bps (`POKEARENA_BUYBACK_BPS`)
