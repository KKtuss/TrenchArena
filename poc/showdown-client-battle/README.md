# Showdown Client Battle POC

Investigation + proof-of-concept for embedding the Pokémon Showdown battle
client as PokeArena's battle renderer, without moving authority out of
BattleEngine / API.

## 1. Showdown client version / commit

| Layer | Pin |
| --- | --- |
| Simulator npm | `pokemon-showdown@0.11.11` |
| Simulator git | `739a5e1fee432ad80ff7136d70cca993be358b59` (2026-07-28 version bump) |
| Client git (best temporal match) | `c24f883a5b505aea79f07037110fac315e3bda7e` (2026-07-27/28 Preact batch 45) |
| Local sparse checkout | `poc/vendor/pokemon-showdown-client` |
| Browser CDN used by POC UI | `https://play.pokemonshowdown.com/js/battle.js` (+ dex/data/css) |

There is no npm package that publishes the client battle MIT modules alone.
The client repo is `smogon/pokemon-showdown-client`. The MIT battle engine
(`battle-*.ts`) is designed to be embeddable (see replay-embed.js).

## 2. Relevant battle-client modules

From `play.pokemonshowdown.com/src/` at `c24f883`:

| Concern | Module |
| --- | --- |
| Battle state + protocol parsing | `battle.ts` (`Battle`, `Side`, `Pokemon`) |
| Scene / sprites / HP bars / anims | `battle-animations.ts` (`BattleScene`) |
| Scene no-op for headless | `battle-scene-stub.ts` |
| Battle log + text | `battle-log.ts`, `battle-text-parser.ts` |
| Dex / sprites / moves data | `battle-dex.ts`, `battle-dex-data.ts` |
| Tooltips | `battle-tooltips.ts` |
| Sound | `battle-sound.ts` |
| Requests + choice builder | `battle-choices.ts` (`BattleChoiceBuilder`) |
| Full PS room chrome + Preact controls | `panel-battle.tsx` (AGPL app shell; not required for MIT renderer) |

Licensing note (for later legal review, not blocking this POC): PS documents
`battle-*.ts` as MIT and the full client as AGPL.

## 3. How the client receives battle state / events

```text
protocol lines  →  battle.add(line)  →  stepQueue  →  Battle.run*()
                                              ↓
                                         BattleScene animations
                                              ↓
                                         BattleLog
```

- Constructor can take an initial `log: string[]` (replay mode).
- Live updates call `battle.add('|switch|…')` / `battle.add('|turn|3')` etc.
- Choice UI is **not** driven by public log lines. It is driven by private
  `|request|{json}` payloads (`panel-battle.receiveRequest`).
- `BattleChoiceBuilder.fixRequest(request, battle)` syncs side/team info
  from the request into the `Battle` object for tooltips / switches.

## 4. How its choice system works

```text
|request|{…moves with names/PP…}
        ↓
BattleChoiceBuilder
        ↓
UI clicks → addChoice("move 1") / ("switch 3") / ("move 1 terastallize")
        ↓
builder.toString() → "move 1"
        ↓
PS sends `/choose move 1` to the PS server
```

For PokeArena we intercept **before** `/choose` leaves the browser:

```text
Showdown UI intent ("move 1")
        ↓
showdownChoiceToPlayerChoice()
        ↓
typed PlayerChoice
        ↓
match.choice over PokeArena WebSocket
        ↓
BattleEngine validates revision + legality
        ↓
BattleStream
```

Raw Showdown command strings are never accepted by the API.

## 5. Proposed integration architecture

```text
PokeArena shell (wallet, casual, tournaments, bracket, nav)
        ↓
/battle/:matchId hosts Showdown MIT renderer (Battle + BattleScene)
        ↓
ShowdownClientAdapter
   events (player-filtered) → public protocol lines + private request JSON
   Showdown choice string   → typed PlayerChoice
        ↓
existing ArenaApiClient / WebSocket
        ↓
ApiServer → Casual/Tournament → BattleEngine → BattleStream
```

Keep outside the renderer: identity, economics, brackets, match ownership,
winner settlement, reconnect policy.

**Important:** our typed `AvailableChoice` drops move names. The Showdown UI
needs the raw `|request|` JSON (already present in private BattleEngine
events). The adapter must forward those payloads for presentation while the
server continues to authorize only typed choices + revisions.

## 6. POC implementation status

Implemented in `poc/showdown-client-battle`:

- [x] Adapter: `eventsToShowdownFeed`, `showdownChoiceToPlayerChoice`
- [x] Unit tests for adapter
- [x] BattleEngine round-trip test (events → adapter → typed choice → submit)
- [x] Browser page loading real Showdown `Battle` / `BattleScene` from CDN
- [x] Choice panel using request move names + translation to `match.choice`
- [x] POC server hosting API + auto `demo-player-2` bot
- [x] Visual verification: sprites, HP bars, log, named moves/switches, turn 1→2 after Headlong Rush round-trip via PokeArena WS
- [ ] Full Preact `panel-battle.tsx` chrome (intentionally not vendored yet)
- [ ] Production wiring into `apps/web/app/battle/[matchId]` (STOPPED per brief)

### Run the visual POC

```powershell
cd packages/api
npm run build

cd ../../poc/showdown-client-battle
npm install
npm start
# open the printed http://127.0.0.1:<port>/
# Click Create → wait for bot accept → Ready → Start → click a named move
```

Refresh the sparse client checkout (optional, for source inspection):

```powershell
cd poc
git clone --filter=blob:none --sparse https://github.com/smogon/pokemon-showdown-client.git vendor/pokemon-showdown-client
cd vendor/pokemon-showdown-client
git fetch --depth 1 origin c24f883a5b505aea79f07037110fac315e3bda7e
git checkout c24f883a5b505aea79f07037110fac315e3bda7e
git sparse-checkout set play.pokemonshowdown.com/src play.pokemonshowdown.com/style
```

## 7. Files changed / added

- `poc/showdown-client-battle/**` (new POC package)
- `poc/vendor/pokemon-showdown-client/**` (local sparse clone; inspect-only)
- No changes to BattleEngine / Tournament / API authority paths
- Existing `apps/web` battle UI left untouched

## 8. Tests / typechecks

```powershell
cd poc/showdown-client-battle
npm test
npm run typecheck
```

Also re-run existing package suites as needed; this POC does not modify them.

## 9. Technical blockers / follow-ups

1. **Client packaging:** MIT battle modules are TypeScript + Dex data + jQuery.
   Production should vendor/build `c24f883` (or npm-publish a thin package),
   not rely on live CDN forever.
2. **AGPL boundary:** `panel-battle.tsx` is part of the AGPL app shell.
   Prefer MIT `Battle`/`BattleScene`/`BattleChoiceBuilder` + a thin PokeArena
   controls host (as this POC does).
3. **Request presentation vs typed choices:** keep shipping private `|request|`
   JSON to the authenticated player for UI; never accept browser-supplied
   request JSON or raw commands as authoritative.
4. **Version drift:** CDN `battle.js` tracks live PS, not exactly `c24f883`.
   Final integration should build from the pinned client commit.
5. **Assets:** sprites/audio are loaded from `play.pokemonshowdown.com`;
   production may need mirroring or self-hosting.
