# Chain economy (POKE passport / SOL wagers / CARDS treasury)

Production-shaped Solana rails. Local validator runs the same instructions as
Devnet and mainnet. Postgres mirrors intents and receipts; chain balances are
authoritative for SOL and SPL POKE.

## Product rules

| Asset | Role |
| --- | --- |
| **POKE** | Passport: liquid wallet value ≥ **$20** unlocks Arena play. Not wagered. Cup entry ~**$5** escrowed then **burned** at bracket lock. |
| **SOL** | Casual collateral and tournament prizes. **2%** fee once at match start. |
| **CARDS** | Creator-reward source (external). Realized SOL deposits split **90% treasury / 10% operator**. |

## Packages

- `programs/arena-escrow` — Anchor program (escrow, fee, burn, treasury, prize, buyback)
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

## Launch blockers (configured, not rewritten)

- Production POKE mint, RPC, program id, vaults, authorities
- Oracle provider for the on-chain passport quote (env quote works for local).
  USD holding checks for an arbitrary SPL mint use Jupiter Price API v3;
  see `docs/play-token-oracle.md`. `PLAY_TOKEN_MINT` stays unset until that mint exists.
- CARDS claim/swap adapter (treasury accepts realized SOL deposits now)
- Buyback bps (`POKEARENA_BUYBACK_BPS`)
