# Showdown BattleStream POC

This is the first PokeArena milestone. It proves that the application can run
real Pokémon battles locally without using the Pokémon Showdown website, server,
rooms, or official client.

## Pinned dependency

The POC uses:

- npm package: `pokemon-showdown@0.11.11`
- published package Git head: `739a5e1fee432ad80ff7136d70cca993be358b59`
- npm integrity: recorded in `package-lock.json`
- license: MIT

The installed package was inspected before implementation. Its actual public
entry point exports `BattleStream`, `getPlayerStreams`, `Teams`, and
`TeamValidator`. The POC uses the installed `sim/battle-stream` and
`sim/team-validator` implementations directly through those exports.

## What it does

1. Imports and validates two fixed Gen 9 OU teams with Showdown.
2. Packs the validated teams using `Teams.pack`.
3. Creates a `BattleStream` and splits it with `getPlayerStreams`.
4. Starts a real `gen9ou` battle for deterministic local players Alice and Bob.
5. Consumes only each player’s private stream and responds to choice requests.
6. Selects the first available legal move, switch, or team-preview choice.
7. Records raw simulator messages, routed event streams, accepted choices, and
   the terminal input log.
8. Reads the terminal `end` message and cross-checks its winner/tie against the
   omniscient protocol stream.
9. Re-runs the complete input log in a fresh `BattleStream`.
10. Verifies that the replay has the same winner, score, turn count, and player
    names.

The `ChoiceController` is intentionally narrow. It demonstrates the request
revision and server-side choice checks that a future WebSocket gateway must
perform. It rejects stale revisions and choices that do not match the
deterministic player’s currently available choice.

The public spectator stream is recorded separately and is checked for request
or split messages. Player-private requests are never taken from that stream.
The omniscient stream and the complete input log are test artifacts only; they
must not be sent to a browser in a future application.

## Run it

From this directory:

```text
npm install
npm run typecheck
npm test
npm start
```

`npm start` prints a short JSON summary after the live battle and replay both
finish successfully.

## Tests

The test suite covers:

- valid team validation and packing
- invalid team rejection before simulation
- malformed choice rejection
- stale choice revision rejection
- live battle completion
- winner/tie protocol consistency
- input and event log capture
- player-private request routing
- spectator stream privacy
- replay result equality
- replay reproducibility across 25 deterministic seeds

This is an engine integration proof, not a production battle service. It does
not implement WebSockets, persistence, reconnects, timers, tournament
brackets, wallets, Solana, StonkFun, token balances, or prizes.

## Important assumptions for the next milestone

- BattleStream is an upstream simulator API marked as not finalized in its
  source. The exact package version must remain part of every persisted battle
  record.
- The simulator input log contains private team and choice information. It
  requires access control before it can be treated as a replay artifact.
- Direct BattleStream has no network reconnect or durable state semantics. A
  future backend must persist accepted inputs and normalized events, assign its
  own request revisions, and define disconnect behavior.
- The deterministic driver only proves legal automated choices. It is not a
  player strategy, anti-cheat system, or frontend choice validator.
- `npm audit --omit=dev` currently reports 11 upstream dependency advisories
  in the pinned package tree, including optional Showdown server dependencies.
  They were not auto-fixed because doing so would change the pinned simulator
  dependency. This POC is not a production deployment; dependency trimming or
  a reviewed source build is required before exposing a service.
