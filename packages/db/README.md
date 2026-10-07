# `@pokearena/db`

PostgreSQL schema and versioned migrations for PokeArena durable state.
This package does **not** connect the API, `MockEconomics`, or tournaments at
runtime. Batch 6C wires a data-access layer.

## Why this mechanism

There was no migrator or Postgres driver in the application packages. This
package adds `pg` only to run SQL files. There is no ORM.

Each `migrations/*.sql` file runs in its **own transaction**. On success the
filename and SHA-256 checksum are stored in `schema_migrations`. On failure
the transaction rolls back and the migration is **not** recorded. Re-running
skips identical checksums and aborts if a recorded file changed.

## Database setup

Create an empty database (localhost only in production):

```text
sudo -u postgres createuser pokearena
sudo -u postgres createdb -O pokearena pokearena
```

Set `POKEARENA_DATABASE_URL` (do not commit it):

```text
postgres://pokearena:PASSWORD@127.0.0.1:5432/pokearena
```

`DATABASE_URL` is accepted as a fallback. Default TCP target if neither is
set: `127.0.0.1:5432`, user/database `pokearena`.

## Migrate

From the repository root, after `pnpm install` (or `npm install` in this
package):

```text
pnpm --filter @pokearena/db migrate
```

Equivalent:

```text
cd packages/db
npm run migrate
```

Fresh database:

```text
createdb pokearena
pnpm --filter @pokearena/db migrate
```

`schema_migrations` should contain `001_initial.sql`. Tables in `public`:
`wallets`, `holds`, `settlements`, `casual_rooms`, `tournaments`,
`tournament_players`, `tournament_matches`.

## Tests

```text
pnpm --filter @pokearena/db test
```

Static tests always run. Live constraint tests run only when PostgreSQL
accepts a connection. They do not fake a pass when the database is down.

## Money representation

Available balances, holds, collateral, entry fees, settlement amounts, and
fees are `BIGINT`. That matches the current TypeScript `Number.isInteger`
POKE units. Do not use `REAL`/`DOUBLE PRECISION`/`MONEY`.

`pg` returns `BIGINT` as a string. Batch 6C must parse it to an integer.

## Adapters (Batch 6C)

`EconomicsStore` and `TournamentStore` live in this package. The API does
**not** construct `PostgresEconomicsStore` or `PostgresTournamentStore` yet.

In-memory async wrappers:

- `packages/api/src/memory-economics-store.ts` over `MockEconomics`
- `packages/tournament/src/tournament-store.ts` over `InMemoryTournamentRepository`

BIGINT conversion is `pokeFromPg` / `pokeToPg` in `src/poke.ts`.

## Future transactions (6D/6E)

These application operations must be single SQL transactions:

- casual create (wallet debit + room `open` + creator hold `reserved`)
- casual accept (debit + opponent hold + room `full`)
- casual cancel / pre-live fail / simulator `failed` (holds `released` + room `cancelled`)
- casual completion (holds `consumed` + settlement + room `completed`)
- tournament create (row including `host_id` and `entry_fee`)
- legacy tournament join (debit + entry hold + `tournament_players`)
- chain tournament join (provisional `tournament_players` row only; no POKE transfer)
- chain burn-fee payment/finalization (confirmed 10,000 POKE deposits, 10,000,000,000 raw atoms each, waitlist promotion, then keeper burns)
- match completion + bracket advance (or tournament completed)
- tournament champion settle (settlement + consume remaining entry holds)
