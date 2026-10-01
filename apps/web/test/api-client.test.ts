import assert from 'node:assert/strict';
import { test } from 'node:test';

import { choiceFromAvailable, formatPoke, formatRoomAmount } from '../lib/api-client';

test('formats mocked POKE values', () => {
  assert.equal(formatPoke(1000000), '1,000,000 POKE');
});

test('room amounts use the room rail, never lamports as POKE', () => {
  assert.equal(formatRoomAmount(100_000, 'legacy_poke'), '100,000 POKE');
  assert.equal(formatRoomAmount(100_000), '100,000 POKE');
  assert.equal(formatRoomAmount(100_000_000, 'sol_chain'), '0.1 SOL');
  assert.equal(formatRoomAmount(196_000_000, 'sol_chain').includes('POKE'), false);
  assert.equal(formatRoomAmount(50_000_000, 'sol_chain'), '0.05 SOL');
});

test('serializes typed choices from available options', () => {
  assert.deepEqual(choiceFromAvailable({ type: 'team-preview' }), { type: 'team-preview' });
  assert.deepEqual(choiceFromAvailable({ type: 'move', slot: 2, terastallize: true }), {
    type: 'move',
    slot: 2,
    terastallize: true,
  });
  assert.deepEqual(choiceFromAvailable({ type: 'switch', slot: 3 }), { type: 'switch', slot: 3 });
  assert.deepEqual(choiceFromAvailable({ type: 'pass' }), { type: 'pass' });
});
