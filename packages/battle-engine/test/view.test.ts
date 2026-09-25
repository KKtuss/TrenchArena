import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BattleViewModel } from '../src/view';

test('BattleViewModel parses switch, turn, damage, status, and faint lines', () => {
  const model = new BattleViewModel([
    { id: 'demo-player-1', name: 'demo-player-1' },
    { id: 'demo-player-2', name: 'demo-player-2' },
  ]);

  model.ingestProtocolChunk([
    '|player|p1|demo-player-1',
    '|player|p2|demo-player-2',
    '|switch|p1a: Great Tusk|Great Tusk, L100|100/100',
    '|switch|p2a: Kingambit|Kingambit, L100|100/100',
    '|turn|1',
    '|-damage|p2a: Kingambit|72/100',
    '|-status|p2a: Kingambit|brn',
  ].join('\n'));

  let view = model.snapshot('battle-1', 'awaiting-choice', 'gen9ou', 'demo-player-1', undefined, undefined, undefined);
  assert.equal(view.turn, 1);
  assert.equal(view.sides[0].active?.species, 'Great Tusk');
  assert.equal(view.sides[1].active?.hpPercent, 72);
  assert.equal(view.sides[1].active?.status, 'brn');
  assert.equal(view.request, undefined);

  model.ingestProtocolChunk('|faint|p2a: Kingambit');
  view = model.snapshot(
    'battle-1',
    'ended',
    'gen9ou',
    'demo-player-1',
    { playerId: 'demo-player-1', revision: 2, kind: 'move', choices: [{ type: 'move', slot: 1, terastallize: false }] },
    { status: 'win', winner: 'demo-player-1', score: [1, 0], turns: 1 },
    undefined,
  );
  assert.equal(view.sides[1].active?.fainted, true);
  assert.equal(view.request?.revision, 2);
  assert.equal(view.result?.winner, 'demo-player-1');

  const spectator = model.snapshot('battle-1', 'ended', 'gen9ou', 'spectator', view.request, view.result, undefined);
  assert.equal(spectator.request, undefined);
  assert.equal(spectator.result?.winner, 'demo-player-1');
});
