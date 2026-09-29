import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TrainerDirectory } from '../src/trainer-directory';

test('stores public trainer names and overlays them onto battle sides', () => {
  const trainers = new TrainerDirectory();
  trainers.set('wallet-a', { username: 'Kaktuss', spriteId: 'blue-gen3' });
  assert.equal(trainers.displayName('wallet-a'), 'Kaktuss');
  assert.equal(trainers.displayName('wallet-b'), undefined);

  const named = trainers.namedView({
    battleId: 'b1',
    sides: [
      { playerId: 'wallet-a', name: 'wallet-a' },
      { playerId: 'wallet-b', name: 'wallet-b' },
    ],
  });
  assert.equal(named?.sides[0].name, 'Kaktuss');
  assert.equal(named?.sides[1].name, 'wallet-b');
});

test('rejects empty or oversized usernames', () => {
  const trainers = new TrainerDirectory();
  assert.throws(() => trainers.set('wallet-a', { username: 'A', spriteId: 'blue-gen3' }));
  assert.throws(() => trainers.set('wallet-a', { username: 'this-name-is-way-too-long', spriteId: 'blue-gen3' }));
  assert.throws(() => trainers.set('wallet-a', { username: 'Red!', spriteId: 'blue-gen3' }));
  assert.throws(() => trainers.set('wallet-a', { username: 'Red', spriteId: 'Blue.png' }));
});
