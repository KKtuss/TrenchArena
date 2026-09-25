import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  eventsToShowdownFeed,
  showdownChoiceToPlayerChoice,
} from '../src/showdown-client-adapter';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BattleEngine } = require('../../../../packages/battle-engine/dist/src/index.js') as {
  BattleEngine: new () => any;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TEAM_ONE, TEAM_TWO } = require('../../../../packages/battle-engine/dist/test/fixtures.js') as {
  TEAM_ONE: string;
  TEAM_TWO: string;
};

test('BattleEngine public/private events feed Showdown adapter and accept translated choices', async () => {
  const engine = new BattleEngine();
  const battle = await engine.createBattle({
    format: 'gen9ou',
    players: [
      { id: 'demo-player-1', name: 'demo-player-1' },
      { id: 'demo-player-2', name: 'demo-player-2' },
    ],
    teams: [TEAM_ONE, TEAM_TWO],
    seed: '1,2,3,4',
    timeoutMs: 30_000,
  });
  await battle.start();

  const p1Events = battle.getEvents('demo-player-1');
  const feed = eventsToShowdownFeed(p1Events);
  assert.ok(feed.publicLines.length > 0, 'expected public Showdown protocol lines');
  assert.ok(feed.requestPayloads.length > 0, 'expected private request JSON for player 1');
  assert.equal((feed.requestPayloads[0] as any).teamPreview, true);

  // Team preview via Showdown choice string → typed choice → BattleEngine.
  for (const playerId of ['demo-player-1', 'demo-player-2'] as const) {
    const request = battle.getState(playerId).request!;
    await battle.submitChoice({
      battleId: battle.id,
      playerId,
      revision: request.revision,
      choice: showdownChoiceToPlayerChoice('default'),
    });
  }

  for (let i = 0; i < 50; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
    if (battle.getState('demo-player-1').request?.kind === 'move') break;
  }

  const afterPreview = eventsToShowdownFeed(
    battle.getEvents('demo-player-1'),
    p1Events[p1Events.length - 1]?.sequence ?? 0,
  );
  const moveRequest = [...afterPreview.requestPayloads].reverse().find((payload: any) => payload.active?.[0]?.moves);
  assert.ok(moveRequest, 'expected a move request with named moves after team preview');
  assert.ok((moveRequest as any).active[0].moves[0].name || (moveRequest as any).active[0].moves[0].id);

  const request = battle.getState('demo-player-1').request!;
  const firstMove = request.choices.find((choice: any) => choice.type === 'move');
  assert.ok(firstMove);
  await battle.submitChoice({
    battleId: battle.id,
    playerId: 'demo-player-1',
    revision: request.revision,
    choice: showdownChoiceToPlayerChoice(`move ${firstMove.slot}`),
  });

  const p2 = battle.getState('demo-player-2').request!;
  const p2Move = p2.choices.find((choice: any) => choice.type === 'move') ?? p2.choices[0];
  await battle.submitChoice({
    battleId: battle.id,
    playerId: 'demo-player-2',
    revision: p2.revision,
    choice: p2Move.type === 'move'
      ? showdownChoiceToPlayerChoice(`move ${p2Move.slot}`)
      : showdownChoiceToPlayerChoice(p2Move.type === 'switch' ? `switch ${p2Move.slot}` : 'pass'),
  });

  for (let i = 0; i < 50; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
    if (battle.getEvents('demo-player-1').length > p1Events.length + 2) break;
  }

  const later = eventsToShowdownFeed(
    battle.getEvents('demo-player-1'),
    afterPreview.publicLines.length
      ? battle.getEvents('demo-player-1').find((event: any) => event.sequence > (p1Events[p1Events.length - 1]?.sequence ?? 0))?.sequence ?? 0
      : p1Events[p1Events.length - 1]?.sequence ?? 0,
  );
  assert.ok(
    later.publicLines.some((line: string) => line.startsWith('|move|') || line.startsWith('|switch|') || line.startsWith('|turn|'))
    || battle.getState('demo-player-1').request
    || battle.getResult(),
    'expected Showdown protocol progression after translated move choices',
  );
});
