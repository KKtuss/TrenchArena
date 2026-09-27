# PokeArena durability contract (Batch 6A, implemented through 6F)

This document started as the durable-state contract. Batches 6B–6F implemented
PostgreSQL persistence and boot recovery. Live Showdown streams remain
ephemeral.

Verified against:

- `packages/api/src/mock-economics.ts`
- `packages/api/src/casual-service.ts`
- `packages/api/src/server.ts`
- `packages/tournament/src/service.ts`
- `packages/tournament/src/repository.ts`
- `packages/tournament/src/types.ts`
- `packages/tournament/README.md` (future mapping notes only)

PostgreSQL, migrations, and application wiring belong to Batch 6B+.

---

## Persistence boundary

```text
Browser
  ↓ HTTPS
Next.js (localhost:3001)          presentation; localStorage teams/trainers
  ↓ same-origin wss /ws
Node API / WebSocket (localhost:3000)
  ├── ephemeral: sockets, sessions, challenges, rate limits, Showdown streams
  └── [durable persistence boundary]     ← not implemented yet
        ↓
PostgreSQL (localhost only)
  wallets, holds, settlements, casual rooms, tournaments
```

**Remain in the single API process (not made durable in this contract):**

- Pokémon Showdown `BattleStream` / `BattleSession`
- Live choice/request/event history for an in-flight fight
- WebSocket connections and `sessionsByPlayer`
- Disconnect-grace timers (10s)
- Auth challenges and consumed nonces
- In-memory rate-limit windows
- Per-IP / total connection counters
- Match/room broadcast subscriptions

The durable economic and tournament records are the **source of truth** after
restart. A live simulator is not.

Horizontal scaling is out of scope. Two API processes remain unsafe until
session and battle **ownership** exist (category C below).

---

## Current in-memory facts (verified)

### Economics (`MockEconomics`)

Three maps:

| Map | Meaning today |
| --- | --- |
| `balances` | Available POKE. Demo players start at 10_000_000; production wallets start at **0** (`devFaucet` follows demo auth). Missing key reads as 0. |
| `holds` | `{ playerId, amount }` keyed by hold id. **Deleted** on both `release` and `consume`. |
| `settlements` | `MockPayoutResult` keyed by optional `settlementKey`. |

Operations:

- `reserve(holdKey, playerId, amount)` — debit then insert hold. If the same
  key exists with the **same** player and amount, return `false` (idempotent
  no-op). Otherwise throw.
- `reserveAll` — all-or-nothing multi-hold (used in tests, not the live WS
  paths).
- `release` — if hold missing, return `0` (idempotent). Else delete hold and
  credit the amount back.
- `consume` — delete hold **without** crediting. Missing key is a silent no-op.
- `settleCasualWin` / `settleCasualTie` / `settleTournamentWin` — if
  `settlementKey` already exists, **return the stored result and do not
  credit again**.

`MockPayoutResult.reason` includes `'refund'`, but **no live path writes a
settlement for a refund**. Cancels and pre-live failures only `release`.

Casual protocol fee (2% of pot) and tournament “treasury / dev-ops” splits are
**preview math**. Settle credits the **winner (or tie refunds)** only. The fee
slice is **not** credited to a treasury wallet. Persistence must not invent
treasury accounts unless a later product decision says so.

Hold keys actually used:

- Casual creator: `casual:${roomId}:creator`
- Casual opponent: `casual:${roomId}:opponent`
- Tournament entry: `tournament:${tournamentId}:${playerId}`

Settlement keys actually used:

- Casual terminal: `casual:${roomId}`
- Tournament champion payout: `tournament:${tournamentId}`

**Ordering hazard (must become one transaction later):**

- Casual `handleTerminal` **consumes holds, then settles**. A crash between
  those steps today would drop the debit with no payout record.
- Tournament `maybeSettleTournament` **settles, then consumes** registered
  holds. A crash between those steps leaves holds in place after the winner
  was already credited — safe to retry **only if** the settlement row
  survives.

`lockCollateral` is a test helper (also used to empty a wallet in tests). It
is not a durable hold.

`assertAffordable` requires `amount > 0`. A tournament with `entryFee === 0`
cannot currently `reserve` on join.

There is **no** “one room per player” rule. A second casual reserve fails only
when the remaining **balance** cannot cover it.

### Casual rooms (`CasualRoomService`)

Rooms, `roomsByMatchId`, `lockedTeams`, `activeBattles`, `forfeitedRooms`,
`battleStarts`, and `recentResults` are all process-local.

Lifecycle:

1. `createRoom` — `reserve` creator hold, status `open`.
2. `acceptRoom` — `reserve` opponent hold, status `full`. Failed reserve does
   not seat the opponent (creator hold unchanged).
3. Ready/lock team — no economic change.
4. `cancelRoom` (status not starting/battling/completed) — `release` both
   holds, status `cancelled`.
5. `startBattle` / `launchBattle` — if `createBattle`/`start` throws:
   `release` both, status `cancelled`.
6. Live: status `battling`, Showdown in `activeBattles`.
7. Terminal `failed` — `release` both, status `cancelled`.
8. Terminal completed — consume both holds; `settleCasualWin` or
   `settleCasualTie` with `settlementKey = casual:${roomId}`; status
   `completed`. Timeout and explicit forfeit use reason `casual-forfeit`
   (`forfeitedRooms` or `endedBy === 'timeout'`).

API disconnect (`onPlayerDisconnected`):

- status `open` | `full` | `ready` → `cancelRoom` (refund).
- status `starting` | `battling` → 10s grace, then `casual.forfeit` (needs a
  **live** `BattleSession`).

### Tournaments

`TournamentService` persists through `AsyncTournamentRepository`:

```text
TournamentService → AsyncTournamentRepository → PostgresTournamentStore → PostgreSQL
```

Tests use `InMemoryAsyncTournamentRepository` (with an optional economics
ledger when `entryFee > 0`). Production pairs `PostgresTournamentStore` with
`PostgresEconomicsStore` on the **same pool**. In-memory tournaments are not
used as a fallback when PostgreSQL economics is selected.

`Tournament` stores `hostId` and `entryFee`. Those fields are the source of
truth for host authorization and join pricing. `ApiServer` no longer keeps
authoritative `tournamentHosts` / `tournamentEntryFees` maps.

- `tournamentPayouts` is a **presentation cache** of `PayoutResult`.
  `maybeSettleTournament` consults `EconomicsStore.getSettlement` /
  `completeTournamentWin` (`tournament:${id}`). The cache must not override
  the settlement row.

`TournamentService` also has `withdrawPlayer` and `cancelTournament`.
**Neither is on the WebSocket protocol.** Persistence still models
`withdrawn`. The API never refunds entry holds via withdraw/cancel.

Join path: `registerPlayer` is one database transaction (lock tournament,
verify capacity/duplicate/status, debit entry fee, insert hold, insert
`tournament_players`). There is no split `reserve` then `register` in
production. Duplicate registration throws and does **not** create a second
hold.

Entry holds stay until the **tournament** completes. Individual match
results do **not** consume or release them. Champion settle then consumes
every `registered` player’s hold (withdrawn players: consume is a no-op if
no hold — withdraw does not release either, which would **leak**
value if withdraw were ever wired without a refund).

Match lifecycle: `pending` → `ready` → `battle-created` → `active` →
`completed` | `forfeited` | `tied` | `interrupted`. A `tied` or
`interrupted` match may be started again (`beginMatchStart` clears
winner/result/battleInstanceId). `interrupted` means the live Showdown
stream died with the process; it is **not** a battle result. Casual ties
**complete** the room; there is no casual rematch.

Bracket advancement is `commitMatchOutcome`: write this match, then either
mark the tournament completed (final round) or slot the winner into the next
match, in one transaction. Duplicate terminal handling is idempotent when
the stored result matches.

Default `TournamentService` match timeout is 15s; **API create** sets
`matchTimeoutMs: 300_000`. Persist the value stored on the tournament, not
the service default.

Teams on `TournamentPlayer.team` are required to start matches. Viewer
privacy is `publicTournamentForViewer` (API serialization), not a reason to
drop teams from durable state.

**Crash window (not a distributed transaction):** tournament row
`completed`+winner is committed by `PostgresTournamentStore`. Champion
payout is a second transaction on `EconomicsStore.completeTournamentWin`.
Settlement is idempotent on `tournament:${id}`. If the process dies between
those commits, the tournament is completed but unpaid until 6F retries
unsettled completed tournaments. Live Showdown battles remain ephemeral.

### API-owned / process-local (non-tournament)

WebSockets, challenges, rate limits, connection slots, `matchUnsubscribers`,
`casualUnsubscribers`, `pendingMatchBroadcasts`. None of these are economic
source of truth.

---

## Durability classification

### A — MUST survive restart

Loss would destroy user value, double-pay, desync balances, break brackets,
or drop host/fee authorization.

| State | Why A |
| --- | --- |
| Wallet available balances | Restart must not zero or invent POKE. |
| Open holds (identity, player, amount) | A reserved debit with no row is stolen value; a row with no debit is free money. |
| Hold **terminal** status (reserved / released / consumed) | Today deletion makes “consumed” indistinguishable from “never existed” or “released”. Recovery and idempotency need the distinction. |
| Settlement rows keyed by the keys above | Prevents double credit on retry of `settle*`. |
| Casual **room** rows once a hold exists | A hold key alone cannot tell lobby vs live vs completed. Room `status` is required to apply recovery without guessing. |
| Casual collateral, creator, opponent, invited player | Required to know who is owed a release vs who already lost a consumed stake. |
| Tournament identity, status, config, `bracketSeed`, `matchTimeoutMs`, capacity, timestamps, winner | Competitive progression and payout inputs. |
| Tournament **hostId** | Host-only `tournament.start`. Persisted on `Tournament`. |
| Tournament **entryFee** | Join reserve amount. Persisted on `Tournament`. |
| Registered / withdrawn players, registration order, **teams** | Unique registration, startMatch team pastes, privacy still applied at serialize time. |
| Matches: round, bracket position, slots, status, winner, result summary, timestamps | Bracket advancement and tie rematch eligibility (`tied`). |
| Champion payout fact (settlement key `tournament:${id}`) | `maybeSettleTournament` must remain exactly-once. |

A **room existing** is not automatically A. An empty template with no hold
would be B; the current `createRoom` always reserves first, so every real
room that exists in the service is economically A.

A **live Showdown battle** is not A (cannot snapshot the stream). The
**economic obligation** attached to `status === 'battling'` (or tournament
`active` / `battle-created`) **is** A — see recovery cases C/F.

A **completed battle’s simulator log** is B. The **settlement** and room/
match terminal status are A.

### B — MAY be ephemeral

Disappears on restart without creating a ledger inconsistency **provided**
A-class rows are correct and boot recovery runs.

| State | Why B |
| --- | --- |
| WebSocket sockets, `ClientConnection`, subscriptions | Clients reconnect and `auth.verify` again. |
| `sessionsByPlayer` / session replacement | Re-derived on next login. |
| Auth challenges and consumed nonces | TTL; new challenge on next login. |
| Rate-limit sliding windows | Short-burst protection only; documented single-process. |
| Connection / per-IP counts | Recomputed from live sockets. |
| Showdown `BattleStream`, request revisions, event buffers | Cannot restore; see product decision for the stake. |
| 5-minute completed-battle retention / `activeBattles` | Reconnect-to-ended-fight convenience only. |
| Disconnect grace timers | After a crash there is no process to wait in. |
| `forfeitedRooms` | Only used to label payout reason while the terminal is in-flight. |
| `battleStarts` in-flight promises | Restart is a new process. |
| `recentResults` ring buffer | Display cache; can be rebuilt from completed room rows if those are stored. |
| `tournamentPayouts` API cache | Rebuild from settlement key + tournament result. |
| Casual ready flags if we **cancel** abandoned lobbies on boot | Current disconnect policy already cancels `open`/`full`/`ready`. If product later keeps lobbies alive, ready flags become A. |
| Browser `localStorage` teams/trainers | Client-owned; not API value. |

### C — future multi-process (not required for one VPS)

Keep in memory for the first deployment. Must not be copied naively across
processes later.

| State | Why C |
| --- | --- |
| Live Showdown ownership | One match cannot run in two processes. |
| WS session ownership (one wallet, one socket) | Batch 4 invariant is process-local. |
| Rate limits / connection caps | Would split or double-count. |
| Broadcast fan-out | Needs pubsub only when there are multiple API processes. |
| Disconnect grace | Must be owned by the process that has the battle. |

---

## Economic durability contract

### Balance invariant

For each `playerId`, available balance after restart equals the last
**committed** balance. `ensureWallet` may create a 0-balance wallet for a
known id (Solana address length ≥ 32, or demo ids). It must not grant the
dev faucet unless demo auth is on (current rule).

Conservation (mock POKE, single currency):

```text
sum(available balances) + sum(reserved hold amounts)
  + sum(consumed-but-not-yet-explained)   // must be 0 at rest
= sum(credits ever granted) - sum(fee burns from completed settlements)
```

At rest every hold is `reserved`, `released`, or `consumed`. Fee burns happen
only inside a committed settlement (casual winner gets pot − 2%; tournament
winner gets 90% of `entryFee * registeredCount`). Persistence does not add a
treasury ledger unless product asks.

### Hold invariant

Each hold has a durable identity (keep the current key strings).

Allowed transitions:

```text
(none) → reserved     // reserve
reserved → released   // release; credit amount back
reserved → consumed   // consume; no credit; must coincide with settlement
```

**Not allowed:** released and consumed both; consume then later release;
two reserved rows for one key; credit on consume; debit without reserved
row.

`release` and `consume` of a **already terminal** hold must be no-ops that
do not change balances (today: `release` missing → 0; `consume` missing →
delete nothing). After persistence, inspect status instead of treating
absence as both “released” and “consumed”.

### Settlement invariant

Every economically meaningful **payout or stake destruction** that is not a
simple `release` uses a settlement key:

| Event | Key | Effect |
| --- | --- | --- |
| Casual win / forfeit win | `casual:${roomId}` | Credit winner `winnerPayout`; holds consumed |
| Casual tie | `casual:${roomId}` | Credit each player half pot (current integer split); holds consumed |
| Tournament champion | `tournament:${tournamentId}` | Credit `prizePool`; consume remaining registered entry holds |

Retry with the same key returns the stored result and **must not** credit
again.

Cancels / pre-live failure / failed simulator **do not** currently write a
settlement; they `release`. That remains valid if `release` is idempotent
and room/match status is stored as `cancelled` (or equivalent).

### Atomicity (application terms, no SQL)

These must commit as **one** unit or not at all:

| Unit | Steps that must not be visible separately |
| --- | --- |
| Casual create | debit creator + insert `reserved` hold + insert room `open` |
| Casual accept | debit opponent + insert opponent hold + room `full` + opponentId |
| Casual cancel / pre-live fail / terminal `failed` | `release` each existing reserved hold + room `cancelled` |
| Casual completed win/tie/forfeit | both holds `consumed` + settlement row + room `completed` + payout fields |
| Tournament create | tournament row + **hostId** + **entryFee** + status `draft` then `registration` |
| Tournament join | lock tournament + debit + `reserved` hold + `tournament_players` row |
| Tournament join failure | ROLLBACK: no leftover hold and no leftover registration |
| Match completion + bracket advance | this match terminal status/winner **and** next match slot/status **or** tournament `completed`+winner |
| Tournament champion settle | settlement row + consume all remaining registered entry holds + cacheable payout fact |

Tournament join and champion settle use `EconomicsStore` semantics but are
**not** one distributed transaction with each other. Join is atomic inside
`PostgresTournamentStore`. Settle is atomic inside `EconomicsStore`. The
window between `commitMatchOutcome` (tournament completed) and
`completeTournamentWin` is a 6F retry concern.

`reserveAll` is already all-or-nothing in memory; if a live path starts using
it, it is the same class of transaction.

---

## Tournament durability contract

**Must survive**

- id, title, format, maxPlayers, bracketSeed, matchTimeoutMs
- status: `draft` \| `registration` \| `ready` \| `in-progress` \| `completed` \| `cancelled`
- hostId (on `Tournament`, persisted)
- entryFee (on `Tournament`, persisted)
- players: id, displayName, team, eligible, status `registered`\|`withdrawn`, registrationOrder
- matches: id, tournamentId, round, bracketPosition, player1/2, status, battleInstanceId (opaque id only), winner, result kind/summary, timestamps
- tournament winner + completedAt
- unique registration `(tournamentId, playerId)`
- unique bracket cell `(tournamentId, round, bracketPosition)`
- at most one **terminal** result per match, except `tied` which may be restarted by `startMatch` (clears winner/result/battleInstanceId and creates a **new** battle instance)

**May remain process-local**

- `activeBattles` / Showdown session
- match listeners / WS subscriptions
- `battleInstanceId` → live `BattleSession` mapping
- 5-minute cleanup timers
- `tournamentPayouts` map (derive from settlement)

**Interface note:** `TournamentService` uses async `AsyncTournamentRepository`.
Production selects `PostgresTournamentStore`. Tests use
`InMemoryAsyncTournamentRepository`. Live Showdown sessions remain in-process.

---

## Restart / recovery semantics (design only)

Boot recovery is Batch **6F**. This section is the contract 6F must satisfy.
It must **not** invent live Showdown restore.

### Case A — clean restart

No `reserved` holds. All rooms/tournaments are `completed` or `cancelled`,
or no rows exist.

Expected: load balances and historical rows; listen on loopback; no refunds;
no payouts. Users re-auth. Empty arena is valid.

### Case B — restart with an open hold (no live simulator)

Committed state includes `reserved` hold(s) and a casual room whose status
is `open`, `full`, or `ready` (or a tournament still in `registration` /
`ready` with entry holds — see E).

Determined from durable rows: hold key, player, amount, room/tournament
status. **Not** determined: whether a client thought they were still
connected.

Intended analog of **current disconnect policy** for casual non-live rooms:
`cancelRoom` → idempotent `release`. After a crash every player is gone, so
abandoned lobbies should be cancellable/refundable **once**.

Unresolved: whether a host would prefer lobbies to survive reboot (see
Decisions). The current application does **not** keep a disconnected
player’s lobby; it cancels it immediately.

### Case C — restart during a live battle

Durable: room `battling` / `starting`, or match `active` / `battle-created`;
holds still `reserved`; optional `battleInstanceId` string.

Not durable: `BattleStream`, choices, HP, timer.

The next process **cannot** call `session.forfeit` (no session). It **must
not** run `settleCasualWin` without an authoritative `BattleResult`.

**6F policy (implemented):** tournament matches in `battle-created` or
`active` become `interrupted` (no winner, no fabricated result). Casual
rooms in `starting`/`battling` are `abortCasualRoom` (release holds),
matching the closest existing simulator-`failed` analog. Do not reconstruct
Showdown.

### Case D — restart immediately after settlement

Durable settlement row exists for `casual:${roomId}` or
`tournament:${tournamentId}`.

Retry of settle returns the stored result. Holds must already be `consumed`
in the same transaction (casual) or consumed as part of the same tournament
settle unit. Room/match/tournament status already terminal.

`maybeSettleTournament` may run again; settlement key + tournament already
`completed` prevent double credit and double consume.

### Case E — restart during tournament registration

Durable: tournament `registration`, hostId, entryFee, player rows, one
`reserved` hold per registered player.

Join retry: `reserve` of the same key is a no-op; `registerPlayer` throws
duplicate — must not release.

If a hold is `reserved` but **no** player row (should not exist if join is
one transaction): 6F treats it as an orphan hold (release once). The reverse
(player row, no hold) is an invariant violation; 6F should refuse to start
the tournament and surface it rather than invent a debit.

Withdraw/cancel are not API-exposed; 6F must not withdraw players unless
product adds that operation.

### Case F — restart during tournament match settlement

If the match terminal **and** bracket advancement committed: load as Case A
for that match; `maybeSettleTournament` only if the tournament is
`completed` and no settlement row exists yet (exactly-once).

If the match is still `active` / `battle-created` and the stream is gone:
same as Case C. 6F marks the match `interrupted` and does **not** advance
the bracket. **Do not** pay the tournament prize. Entry holds stay
`reserved` until the tournament completes or an existing cancel/withdraw
policy applies.

A `tied` match with no live stream is **not** in-flight simulation; it is
eligible for `startMatch` again under current rules (new battle). Whether
boot should auto-start it is a product/ops choice; economically it is stable.

Double advancement is prevented by: match already `completed`/`forfeited`
must not accept a different result (`applyBattleResult` already enforces
this). Persistence must keep that uniqueness.

---

## Proposed persistence model (logical entities, not SQL)

Names follow current keys and the tournament README, adjusted for API-owned
fields the README omitted.

### `wallets`

- **Purpose:** available mock POKE.
- **Identity:** `player_id` (wallet address or demo id).
- **Fields:** `balance` (non-negative integer), `created_at`, `updated_at`.
- **Uniqueness:** primary `player_id`.
- **Immutable:** `player_id`.
- **Mutable:** `balance` only via transactional reserve/release/settle/credit.

### `holds`

- **Purpose:** reserved value with a single terminal outcome.
- **Identity:** `hold_key` (strings above).
- **Fields:** `player_id`, `amount`, `status` (`reserved` \| `released` \|
  `consumed`), `purpose` (`casual_creator` \| `casual_opponent` \|
  `tournament_entry`), `room_id` or `tournament_id` (nullable per purpose),
  timestamps.
- **Uniqueness:** primary `hold_key`.
- **Lifecycle:** none → reserved → released | consumed.
- **Immutable after reserve:** `hold_key`, `player_id`, `amount`, purpose,
  foreign ids.
- **Do not delete** terminal rows (unlike today’s `Map.delete`).

### `settlements`

- **Purpose:** exactly-once payout (and the only place fee burns are
  implied).
- **Identity:** `settlement_key` (`casual:${roomId}` or
  `tournament:${tournamentId}`).
- **Fields:** `kind` (`casual-win` \| `casual-forfeit` \| `casual-tie` \|
  `tournament-win`), `winner_id` nullable, `amount`, `protocol_fee`
  nullable, payload needed to re-render `MockPayoutResult`, timestamps.
- **Uniqueness:** primary `settlement_key`.
- **Immutable** once inserted.

### `casual_rooms`

- **Purpose:** interpret holds and apply recovery; list/history.
- **Identity:** `id` (UUID room id). `match_id` = `casual-${id}` as today.
- **Fields:** roomType, battleSize, format, creatorId, opponentId,
  invitedPlayerId, collateral, status, winnerId, completed result summary,
  settlement_key nullable, battleInstanceId nullable (opaque), timestamps.
- **Uniqueness:** primary `id`; unique `match_id`.
- **Lifecycle:** as `CasualRoomStatus`. Terminal: `completed` | `cancelled`.
- **Immutable:** `id`, `match_id`, `creatorId`, `collateral`, `roomType`,
  `battleSize` after create.
- Locked teams / ready flags: persist only if boot keeps pre-battle rooms;
  otherwise B (cancelled on boot). **Product decision.**

### `tournaments`

- **Purpose:** lifecycle + **hostId + entryFee** (move off `ApiServer` maps).
- **Identity:** `id`.
- **Fields:** title, format, maxPlayers, bracketSeed, matchTimeoutMs, status,
  host_id, entry_fee, winner, timestamps.
- **Uniqueness:** primary `id`.
- **Immutable after create:** id, format, maxPlayers, bracketSeed, host_id,
  entry_fee (current API never edits these).
- **Mutable:** status, winner, startedAt, completedAt, updatedAt.

### `tournament_players`

- **Purpose:** registration.
- **Identity:** `(tournament_id, player_id)`.
- **Fields:** displayName, team, eligible, status, registrationOrder.
- **Uniqueness:** `(tournament_id, player_id)`; registrationOrder unique per
  tournament recommended.
- **Immutable:** player_id, tournament_id, team, registrationOrder once
  registered (current code does not edit team after join).
- **Mutable:** status `registered` → `withdrawn` (domain exists; API unused).

### `tournament_matches`

- **Purpose:** bracket.
- **Identity:** `id`.
- **Fields:** tournament_id, round, bracketPosition, player1, player2,
  status, battle_instance_id (opaque, nullable), winner, result (structured
  summary, not Showdown log), timestamps.
- **Uniqueness:** primary `id`; unique `(tournament_id, round, bracket_position)`.
- **Lifecycle:** as `TournamentMatchStatus`. `tied` and `interrupted` may
  return to a new `battle-created`/`active` with a new `battle_instance_id`.
- **Immutable:** id, tournament_id, round, bracketPosition.

### Not a first-deploy entity

`battle_instances` as a live Showdown store — README mentioned it; **do not**
persist streams in 6A–6F. Storing the opaque id on the match/room is enough
history.

Treasury / fee recipient wallets — **not in current settle code**.

---

## Idempotency requirements

| Operation | Logical key | Retry behavior |
| --- | --- | --- |
| Create casual hold | `casual:${roomId}:creator` or `:opponent` | Same player+amount: no second debit. Conflict otherwise. |
| Release hold | hold key | If `released` or missing-as-released: credit 0 extra. If `consumed`: refuse (do not credit). |
| Consume hold | hold key | If already `consumed`: no-op. If `released`: refuse. |
| Casual settlement | `casual:${roomId}` | Return stored payout; no second credit. |
| Tournament settlement | `tournament:${tournamentId}` | Return stored payout; no second credit; consumes are no-ops. |
| Tournament register | `(tournamentId, playerId)` | Duplicate error; do not release existing hold. |
| Tournament create | tournament id (UUID) | Insert once. |
| Match complete / advance | match id terminal status | Second identical result: no-op (current `isSettledMatch` / `sameResult`). Different result: reject. |
| Casual cancel | room id | Second cancel: no-op (current `status === 'cancelled'` return). |
| Champion `maybeSettleTournament` | settlement key + tournament `completed` | Cache optional; key is authoritative. |

`reserve` returning `false` for an identical hold is part of join/create
retry safety and must be preserved.

---

## Boot recovery (Batch 6F)

Production `ApiServer.create` connects to PostgreSQL, runs migrations,
constructs `PostgresEconomicsStore` + `PostgresTournamentStore` on the same
pool, then runs `recoverDurableState` **before** `listen`. If recovery
throws, the pool is closed and the process does not accept traffic. There
is no in-memory fallback.

Order:

1. PostgreSQL connection + migrations
2. Verify persistence invariants (fail closed on ambiguous money state)
3. Settle completed tournaments that have a winner via
   `EconomicsStore.completeTournamentWin` (`tournament:${id}`)
4. Release only **reserved** orphan tournament/casual holds that have no
   matching player/room row
5. Mark `battle-created` / `active` matches `interrupted`
6. Cancel pre-battle casual rooms; abort in-flight casual rooms
7. Return. `TournamentService` reads the database; it has no tournament
   cache to rebuild. `activeBattles`, WebSocket subscriptions, replay
   timers, and `tournamentPayouts` stay empty.
8. `listen`

### Completed-but-unsettled tournaments

The 6E crash window is: `commitMatchOutcome` writes `completed` + winner,
then the process dies before `completeTournamentWin`. Detection is:

- tournament `status = completed`
- `winner` is set
- settlement key `tournament:${id}` is the authority (not
  `tournamentPayouts`)

Recovery calls the existing `completeTournamentWin` payout path. The
settlement row makes a second boot a no-op. Cancelled tournaments are never
paid. Tournaments that are not completed, or have no winner, are not paid.

### Registration / ready / in-progress holds

Reserved entry holds for a living tournament (`registration`, `ready`,
`in-progress`) are **kept**. A process restart is not a refund and not a
consume. Terminal holds (`released`, `consumed`) are never treated as
releasable again.

### Cancelled tournaments

`cancelTournament` still does not refund. Recovery preserves reserved
holds on cancelled tournaments and will not champion-pay them.

### Withdrawals

`withdrawPlayer` remains registration-only, does not release the entry
hold, and leaves the `tournament_players` row as `withdrawn`. Recovery
does not revive a withdrawn player.

### Interrupted live matches

`battle-created` and `active` become `interrupted` (migration `004`).
`tied` stays replayable. `completed` / `forfeited` stay terminal. Recovery
never writes a winner or a `BattleResult`. After restart, `startMatch` /
`match.subscribe` may create a **new** Showdown battle from `interrupted`,
the same way they already rematch `tied`. Boot does not auto-start those
battles and does not restore `BattleStream` or subscriptions.

### Orphans

After 6E, foreign keys make tournament entry holds and tournament
settlements require a real tournament, and tournament players require a
real tournament. Recovery does not delete those rows.

A **reserved** hold whose tournament exists but has no matching
`tournament_players` row is released once through `EconomicsStore.release`.
A registered player with `entryFee > 0` and no hold is an invariant
incident: recovery fails closed rather than inventing a debit.

### Ambiguous state

Unexpected combinations (consumed hold on a non-completed tournament,
settlement on a non-completed tournament, hold amount ≠ entry fee) fail
closed. Recovery logs a sanitized `phase` + ids. It does not guess a
compensating balance edit. Idempotent retries on the next boot are
preferred to invented refunds.

### Idempotency

`completeTournamentWin` is keyed by `tournament:${id}`. `interruptMatch` is
a no-op unless the match is `battle-created` or `active`. `release` of an
already-released hold credits 0. Running recovery twice must not
double-pay, double-refund, double-consume, or move a terminal match.

Showdown live battle state is **not** reconstructed.


---

## Decisions I still need to make

6F chose boot policies for crashes that already had an existing analog:

1. **VPS/API crash during a live casual battle** — abort the room and
   release both holds (closest to simulator `failed`). No forfeit without
   a live session. No fabricated winner.
2. **Crash during a live tournament match** — persist `interrupted`, do
   not advance, do not pay, do not refund all entries. Players may start a
   new battle the same way as `tied`.
3. **Interrupted lobby rooms after reboot** — cancel `open`/`full`/`ready`
   rooms (same as disconnect cancel). The in-memory casual lobby is not
   rebuilt.

Still open:

4. **How real wallets obtain mock POKE** once demo auth is off  
   Production `ensureWallet` starts at **0**. Persistence of zeros does not
   make casual/tournaments playable. Faucet, operator credit, free tables,
   or later on-chain POKE are all out of this contract.

5. **Acceptable backup loss (RPO)**  
   Nightly dump vs continuous WAL. Anything after the last good backup is
   gone; that includes holds and settlements.

6. **Should withdraw/cancel tournament be API features?**  
   Domain methods exist; WS protocol does not. Wiring them later requires
   `release` of that player’s entry hold in the same transaction — **today
   withdraw does not refund**.

7. **Fee destination**  
   Keep burning the 2% / 10% slices, or credit a treasury wallet?

---

## Explicitly out of scope for 6A–6F

- Restoring a live `BattleStream`
- Multi-process API / Redis / battle workers
- Real on-chain POKE
- Changing WebSocket protocol or battle rules

---

## Implemented schema (Batch 6B)

SQL and a versioned migrator live in `packages/db`. They are **not** wired
into the API. `MockEconomics` and `InMemoryTournamentRepository` remain the
runtime stores.

See `packages/db/README.md` for `createdb` + `pnpm --filter @pokearena/db migrate`.

Money is `BIGINT` (integer POKE, same as `Number.isInteger` in
`MockEconomics`). Hold and settlement **business keys are unchanged**.
`host_id` and `entry_fee` are columns on `tournaments`. Holds keep
`reserved` / `released` / `consumed` rows. There is no `battle_instances`
table and no treasury wallet.

---

## Implementation status

**6D economics and 6E tournament persistence are wired.** Production path:

```text
ApiServer → TournamentService → PostgresTournamentRepository
         → PostgresTournamentStore → PostgreSQL

ApiServer → EconomicsStore → PostgresEconomicsStore → PostgreSQL
```

Both stores share one `pg` pool. Tests use `InMemoryEconomicsStore` and
`InMemoryAsyncTournamentRepository`. `NODE_ENV=production` still fail-closes
if PostgreSQL is missing.

Batch **6F** boot recovery is wired: `recoverDurableState` runs after
stores are ready and before `listen`. Live Showdown `BattleStream`s are
not persisted and are not reconstructed.

