import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fullSpriteId, pokemonIconOffset, speciesId } from '../lib/showdown-visuals';

test('maps vendored gen5 sprites and icon-sheet positions', () => {
  assert.equal(speciesId('Great Tusk'), 'greattusk');
  assert.equal(fullSpriteId('Great Tusk'), 'greattusk');
  assert.equal(fullSpriteId('Rotom-Wash'), 'rotom-wash');
  assert.equal(fullSpriteId('Iron Valiant'), 'ironvaliant');
  assert.equal(fullSpriteId('Pikachu'), null);
  assert.deepEqual(pokemonIconOffset('Great Tusk'), { left: 0, top: 2460 });
  assert.deepEqual(pokemonIconOffset(''), { left: 0, top: 0 });
});
