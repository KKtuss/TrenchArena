# PokeArena boundary architecture

```text
Browser (apps/web)
  ↓ typed JSON over WebSocket
API/WebSocket (packages/api)
  ↓ casual rooms + mock POKE economics + tournament gateway
Tournament / Casual
  ↓ typed choices and terminal subscriptions
BattleEngine
  ↓ BattleStream adapter
Pokémon Showdown simulator
```

## Authority

- The browser owns presentation and user intent only.
- The API owns the connection identity, casual/tournament access checks,
  mock POKE economics, and protocol validation.
- The Tournament service owns registration, bracket state, match ownership,
  advancement, timeout forfeits, and idempotent tournament finalization.
- The Casual room service owns private/open rooms, readiness, 1v1 battle start,
  and mocked collateral settlement (2% one-time fee on total pot).
- BattleEngine owns team validation, legal choice validation, battle state,
  normalized `BattleView`, and the authoritative Pokémon `BattleResult`.
- Showdown is never an application identity or tournament ID source.

## Product modes

- Casual: 1v1 Gen 9 OU is playable; 2v2 is configurable but start is rejected.
- Tournaments: single-elimination brackets via `TournamentService`.
- Economics: development balances for `demo-player-1` / `demo-player-2` only.
  No Solana, wallets, escrow, or persistence in this slice.

## Choice and revision flow

The API derives the player from the WebSocket connection. A browser message
contains a match ID, BattleEngine instance ID, request revision, and typed
`PlayerChoice`. The API verifies the match/player relationship and passes the
choice to BattleEngine. BattleEngine rejects stale revisions, illegal choices,
completed battles, and raw commands.

Showdown commands such as `>p1 move 1` are created only inside BattleEngine.
They never cross the WebSocket boundary.

## Private event filtering

BattleEngine stores public and player-private events separately. The
Tournament/API/Casual layers request events for the authenticated player, so:

- public battle events are delivered to both participants;
- player 1 requests are delivered only to player 1;
- player 2 requests are delivered only to player 2;
- omniscient simulator output is never exposed.

`BattleView` is derived from public protocol lines plus the viewer's private
request. Spectators never receive request payloads.

## Reconnect and history

The fake identity is re-established with `identify`, then the client
resubscribes with `match.subscribe`. The API replays the in-memory
BattleEngine event history filtered for that player and includes the current
state/request/view. Completed battle sessions are retained for five minutes,
then their listeners and session references are cleaned up.

## Completion

BattleEngine emits a single terminal notification. Tournament and Casual
services apply that result once. API match subscriptions receive event updates
and terminal state changes. Duplicate terminal notifications or result
submissions are ignored or rejected without advancing a bracket twice or
paying out twice.

## Workspace limitation

The repository uses pnpm workspaces and `workspace:*` package dependencies.
On this Windows environment (external volume), dependency installation cannot
create symlinks (`Incorrect function`), and `fs.readlink` may return `EISDIR`
even for regular files. Workarounds in this repo:

- `scripts/sync-workspace-copies.ps1` copies built packages into dependent
  `node_modules/@pokearena/*` trees;
- `apps/web` production builds stage onto local NTFS temp storage before
  invoking `next build`;
- `next dev` works directly from the project volume.

The same workspace is expected to install and build normally on a
symlink-capable developer mode or CI environment.

## Public internet

The first public topology is documented in `docs/deployment.md`: HTTPS/Caddy
in front of Next.js and a **single** loopback Node API process. Live battle
state is in memory; two API processes cannot share a match. Default bind
address remains `127.0.0.1`.
