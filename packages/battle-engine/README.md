# `@pokearena/battle-engine`

The first reusable application-facing boundary around Pokémon Showdown.
This package keeps battles in memory and intentionally does not know about
tournaments, users, wallets, databases, or prizes.

## Pinned simulator

- `pokemon-showdown@0.11.11`
- Git head: `739a5e1fee432ad80ff7136d70cca993be358b59`
- MIT licensed

The adapter uses the installed package’s actual `BattleStream`,
`getPlayerStreams`, `Teams`, and `TeamValidator` exports. The full Showdown
server, rooms, tournament implementation, and official client are not used.

## Public API

```ts
const engine = new BattleEngine();

const battle = await engine.createBattle({
  format: 'gen9ou',
  players: [
    { id: 'player-one', name: 'Alice' },
    { id: 'player-two', name: 'Bob' },
  ],
  teams: [aliceTeamExport, bobTeamExport],
  seed: '1,2,3,4',
});

await battle.start();

const state = battle.getState('player-one');
await battle.submitChoice({
  battleId: battle.id,
  playerId: 'player-one',
  revision: state.request!.revision,
  choice: { type: 'move', slot: 1 },
});
```

The lifecycle is:

```text
created → started → awaiting-choice → ended
                              └──────→ failed
```

`BattleEngine.createBattle` validates the supported format, player identity
fields, and both six-Pokémon teams before returning a `BattleSession`.
`BattleSession.start` creates the simulator stream and begins the battle.

Available session operations:

- `getState('spectator' | playerId)` returns public state; a player receives
  only that player’s current request.
- `getEvents('spectator' | playerId)` returns public events, or public events
  plus that player’s private request events.
- `submitChoice({ battleId, playerId, revision, choice })` accepts typed
  choices only.
- `getResult()` returns the normalized win/tie result after completion.
- `subscribe(listener)` receives one normalized terminal notification.
- `subscribeEvents(listener)` receives application-safe event-history
  notifications without exposing simulator streams.
- `getReplay()` returns the version, format, rules, seed, packed teams,
  accepted typed inputs, normalized event log, raw simulator input log, and
  final result.
- `engine.replay(replay)` reconstructs the battle from the recorded input log
  and rejects if the terminal result differs.

Supported choices are team preview, move, switch, and pass. Raw Showdown
commands are never accepted by the public API. Request revisions are
session-owned and reject stale submissions.

## Visibility model

The package internally uses Showdown’s omniscient stream only to route and
record simulator output. It is never returned by `getEvents`.

- `spectator` receives public protocol events only.
- `player-one` receives public events plus player one’s private request events.
- `player-two` receives public events plus player two’s private request events.

The event payload is currently an opaque Showdown protocol chunk. This keeps
the adapter small while preventing application code from obtaining stream
objects or sending arbitrary simulator commands.

## Development

From this directory:

```text
npm install
npm run typecheck
npm test
```

The tests cover lifecycle transitions, invalid transitions, typed-choice
validation, wrong-battle and unknown-player rejection, stale revisions,
player/spectator isolation, duplicate finalization, timeout failure,
deterministic replay, concurrent independent sessions, and 25 deterministic
seeds.

## Future API/WebSocket boundary

The future API layer should:

1. Create a battle through `BattleEngine`.
2. Store the application’s own match ID separately from `battle.id`.
3. Call `start` once and subscribe clients to `getEvents(viewer)`.
4. Convert incoming JSON into `ChoiceSubmission` with the authenticated
   player ID, battle ID, and current request revision.
5. Return only typed validation errors and visible events to the client.
6. Persist `getReplay()` when the battle ends, once a database exists.

The WebSocket layer should not know how to format `>p1`, `>p2`, `>start`, or
any other Showdown command.

## Remaining Showdown-specific assumptions

- Only `gen9ou` is enabled; arbitrary client formats and custom rules are
  rejected.
- Choice normalization currently targets singles battles. Targeting is
  represented minimally and doubles/multi-battle semantics are not implemented.
- Event payloads are still Showdown protocol chunks and will eventually need a
  versioned application event schema for a stable frontend contract.
- The replay artifact includes packed teams and the raw Showdown input log.
  It contains private information and must be access-controlled.
- Timeout behavior belongs to this adapter. Showdown’s server-side room
  timers and disconnect policies are not reused.
- Battle sessions are in-memory. A process restart loses active sessions;
  replay data is the recovery boundary for the next persistence milestone.
- `BattleStream` is explicitly marked not finalized upstream, so the pinned
  version and source revision must remain part of every persisted replay.
