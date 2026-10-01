import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldEnterLiveBattle } from '../lib/battle-entry';

const room = {
  matchId: 'match-1',
  battleSize: '1v1',
  creatorId: 'player-a',
  opponentId: 'player-b',
};

test('a started fight opens for a player who is already in it', () => {
  assert.equal(shouldEnterLiveBattle({ ...room, status: 'battling' }, 'player-a'), true);
  assert.equal(shouldEnterLiveBattle({ ...room, status: 'starting' }, 'player-b'), true);
});

test('the ready lobby, a spectator, and a finished room stay put', () => {
  assert.equal(shouldEnterLiveBattle({ ...room, status: 'ready' }, 'player-a'), false);
  assert.equal(shouldEnterLiveBattle({ ...room, status: 'battling' }, 'player-c'), false);
  assert.equal(shouldEnterLiveBattle({ ...room, status: 'completed' }, 'player-a'), false);
  assert.equal(shouldEnterLiveBattle({ ...room, status: 'battling' }, null), false);
  assert.equal(shouldEnterLiveBattle({ ...room, status: 'battling', battleSize: '2v2' }, 'player-a'), false);
});
