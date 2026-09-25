import assert from 'node:assert/strict';
import { test } from 'node:test';

import { choiceFromAvailable, formatPoke } from '../lib/api-client';

test('formats mocked POKE values', () => {
  assert.equal(formatPoke(1000000), '1,000,000 POKE');
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
