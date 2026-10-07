# `@pokearena/api`

Minimal in-memory HTTP/WebSocket application boundary for the current
BattleEngine and tournament domain.

## Start

From the repository root:

```text
pnpm install
pnpm --filter @pokearena/api build
pnpm --filter @pokearena/api start
```

Open `http://127.0.0.1:3000/` in two browser windows. Use
`demo-player-1` and `demo-player-2`.

The development page can create a tournament, join it from both windows,
start it, subscribe to the match, render each player’s legal choices, and
submit typed choices. It intentionally has no production styling.

## Protocol

The WebSocket endpoint is `/ws`.

Client messages:

```json
{"type":"identify","requestId":"req-1","playerId":"demo-player-1"}
{"type":"tournament.create","requestId":"req-2","title":"Browser Demo Cup","maxPlayers":4}
{"type":"tournament.join","requestId":"req-3","tournamentId":"..."}
{"type":"tournament.start","requestId":"req-4","tournamentId":"..."}
{"type":"match.subscribe","requestId":"req-5","matchId":"..."}
{"type":"match.choice","requestId":"req-6","matchId":"...","battleInstanceId":"...","requestRevision":1,"choice":{"type":"move","slot":1}}
```

The server derives the application player identity from the connection. A
client cannot submit a choice as another player. Choices are parsed and
validated before reaching the tournament service; raw Showdown commands are
not part of the protocol. Responses to requests carry the originating
`requestId`; broadcast updates are correlated by match event sequence.

## Chain tournament payment lifecycle

Chain tournaments are fixed 32-player fields. `tournament.join` only creates a
database registration (or waitlist entry); it never transfers POKE. When the
field reaches 32 registered players, the server opens a two-minute payment
window. Each registered player separately sends:

```json
{"type":"tournament.payBurnFee","requestId":"req-5","tournamentId":"..."}
```

The returned transaction deposits exactly 10,000 POKE, encoded as
10,000,000,000 raw atoms for the 6-decimal mint. Unpaid
players are removed at the deadline and eligible waitlisted players are
promoted in registration order, each with a fresh two-minute window. Only
after a complete, fully paid final roster exists does the keeper reserve the
SOL prize and burn the 32 POKE entries. If a burn fails after earlier
players were burned, rerunning finalization continues with the reserved
entries and does not burn a player again. Successfully burned players are
not refunded.

Server messages include:

- `ready`
- `tournament.created`
- `tournament.state`
- `match.subscribed`
- `match.update`
- `error`

`match.subscribed` and `match.update` contain the match, the viewer-specific
BattleEngine state, and only the events visible to that player. The server
never sends the omniscient simulator stream.

## Event delivery and reconnect

The tournament service subscribes to BattleSession terminal notifications.
When a battle completes, the service finalizes the match once and advances
the bracket. The API registers one subscription per match and broadcasts the
updated match state to subscribed participants.

Reconnecting requires identifying again and subscribing to the match. The
server then replays the BattleEngine event history through the same
viewer-specific filter.

Battle subscriptions are removed from completed in-memory sessions after a
five-minute retention period. This leaves a deterministic reconnect window
without retaining completed battle listeners forever.

## Development limitations

- Demo identify is limited to `demo-player-1` and `demo-player-2` and is off
  unless `POKEARENA_ALLOW_DEMO_AUTH` is explicitly true.
- All state is in memory and disappears when the process exits.
- There is no PostgreSQL, real on-chain POKE, or multi-process session store.
- Public internet bind, Origin allowlisting, connection limits, payload
  limits, and in-memory rate limits are documented in `docs/deployment.md`.
- The event payload remains the BattleEngine’s opaque application-safe event
  payload. Raw simulator commands are never accepted from clients.
