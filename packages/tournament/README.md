# `@pokearena/tournament`

An in-memory tournament domain built around `@pokearena/battle-engine`.
There are no HTTP, database, wallet, token, prize, worker, or UI concerns in
this package.

## State machine

```text
draft → registration → ready → in-progress → completed
  └──────────────┬──────────────┬──────────────┘
                 └──────────────→ cancelled
```

- `draft` — tournament metadata exists.
- `registration` — eligible players can register or withdraw.
- `ready` — registration is closed and the persisted bracket exists.
- `in-progress` — matches can start and results can advance.
- `completed` — the final match has a winner.
- `cancelled` — no further tournament actions are accepted.

`startTournament` prepares the deterministic bracket and transitions
`registration → ready → in-progress`. `prepareTournament` is also available
when callers need to observe the ready state explicitly.

## Application-facing service

`TournamentService` exposes:

- `createTournament`
- `openRegistration`
- `registerPlayer`
- `withdrawPlayer`
- `prepareTournament`
- `startTournament`
- `getTournament`
- `getBracket`
- `startMatch`
- `getMatch`
- `getMatchState`
- `getMatchEvents`
- `submitChoice`
- `applyBattleResult`
- `forfeitExpiredMatch`
- `getTournamentResult`

The service owns tournament IDs, match IDs, and battle instance IDs. A
`BattleInstanceId` is generated independently from the `BattleEngine` session
ID and the tournament match ID.

The service passes typed choices to BattleEngine. It never constructs raw
Showdown commands. BattleEngine remains authoritative for the Pokémon result;
the tournament service verifies that the result belongs to the active match
and owns bracket advancement and finalization.

## Brackets

Single-elimination brackets support 4, 8, and 16 players. Registered order
plus `bracketSeed` determines a deterministic player order. The generated
matches are saved in the tournament repository and are not regenerated after
registration changes.

For four players, the persisted bracket contains two semifinal matches and one
final match. A completed semifinal fills one slot in the final; the final
becomes `ready` only after both winners have advanced.

## Timeout policy

Each tournament configures a match timeout passed to BattleEngine. The default
policy treats a timed-out match as a forfeit by player 1, advancing player 2.
`timeoutForfeitPlayer` can be configured on `TournamentService` for the
opposite deterministic policy.

There is no reconnect handling in this milestone. A later API layer can add
reconnect behavior without changing bracket or result ownership.

Completed BattleEngine sessions remain available in memory for five minutes so
the API can replay history to a reconnecting participant. After that retention
window, the session is removed; the persisted match/result model will become
the long-term history boundary when storage is added.

## Development

The package is currently consumed from the local compiled BattleEngine package.
Build the adapter first, then run this package’s checks:

```text
cd packages/battle-engine
npm run build
npm pack --pack-destination ..

cd ../tournament
npm install
npm run typecheck
npm test
```

The integration suite runs real BattleEngine simulations for a complete
four-player tournament. It also tests deterministic brackets, 8/16-player
bracket construction, registration rules, withdrawal, invalid transitions,
invalid results, duplicate result application, and timeout forfeits.

## PostgreSQL mapping later

The repository boundary is intentional:

- `tournaments` stores lifecycle, format, capacity, seed, timestamps, and
  winner.
- `tournament_players` stores tournament membership, registration order,
  eligibility snapshot, and team reference.
- `tournament_matches` stores round, bracket position, player slots, status,
  battle instance ID, result, winner, and timestamps.
- `battle_instances` stores the BattleEngine session/replay metadata.

Registration, bracket advancement, and result application should become
transactions with unique constraints on `(tournament_id, player_id)`,
`(tournament_id, round, bracket_position)`, and one final result per match.
The current service/repository boundary is the seam for that migration.
