import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickLiveFight, spectatorEvents, type LiveFight } from '../src/live-fights';

function fight(source: LiveFight['source'], matchId: string, extra: Partial<LiveFight> = {}): LiveFight {
  return {
    matchId,
    source,
    title: source === 'tournament' ? 'Gen 1 Cup' : 'Casual 6 → 3',
    player1: extra.player1 ?? 'demo-player-1',
    player2: extra.player2 ?? 'demo-player-2',
    format: 'gen9ou',
    status: 'active',
    ...extra,
  };
}

test('live picker keeps a still-running preferred fight', () => {
  const fights = [fight('tournament', 'cup-1'), fight('casual', 'casual-1')];
  const picked = pickLiveFight(fights, 'watcher', 'casual-1', () => 0);
  assert.equal(picked?.matchId, 'casual-1');
});

test('live picker prefers tournament fights over casual', () => {
  const fights = [fight('casual', 'casual-1'), fight('tournament', 'cup-1'), fight('tournament', 'cup-2')];
  const first = pickLiveFight(fights, 'watcher', undefined, () => 0);
  const last = pickLiveFight(fights, 'watcher', undefined, () => 0.99);
  assert.equal(first?.source, 'tournament');
  assert.equal(last?.source, 'tournament');
  assert.notEqual(first?.matchId, last?.matchId);
});

test('spectator events drop private requests', () => {
  const events = spectatorEvents([
    { scope: 'public', data: '|turn|1' },
    { scope: 'private', data: '|request|{"wait":true}' },
    { scope: 'public', data: '|move|p1a: Charizard|Flamethrower' },
    { scope: 'public', data: '|request|{"wait":true}' },
  ]);
  assert.deepEqual(events.map(event => event.data), [
    '|turn|1',
    '|move|p1a: Charizard|Flamethrower',
  ]);
});

test('live picker avoids the viewer’s own fight when another is live', () => {
  const fights = [
    fight('tournament', 'mine', { player1: 'watcher', player2: 'demo-player-2' }),
    fight('casual', 'other', { player1: 'demo-player-1', player2: 'demo-player-2' }),
  ];
  const picked = pickLiveFight(fights, 'watcher', undefined, () => 0);
  assert.equal(picked?.matchId, 'other');
});
