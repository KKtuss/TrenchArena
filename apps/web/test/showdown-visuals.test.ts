import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SHOWDOWN_SPRITE_CDN,
  applyShowdownSpriteCdn,
  fullSpriteId,
  pokemonIconOffset,
  speciesId,
} from '../lib/showdown-visuals';

test('maps Showdown gen5 sprite ids and icon-sheet positions', () => {
  assert.equal(speciesId('Great Tusk'), 'greattusk');
  assert.equal(fullSpriteId('Great Tusk'), 'greattusk');
  assert.equal(fullSpriteId('Rotom-Wash'), 'rotom-wash');
  assert.equal(fullSpriteId('Iron Valiant'), 'ironvaliant');
  assert.equal(fullSpriteId('Gyarados'), 'gyarados');
  assert.equal(fullSpriteId('Pikachu'), 'pikachu');
  assert.deepEqual(pokemonIconOffset('Great Tusk'), { left: 0, top: 2460 });
  assert.deepEqual(pokemonIconOffset(''), { left: 0, top: 0 });
});

test('points the Showdown dex at the sprite CDN', () => {
  const dex = {
    resourcePrefix: '/showdown/',
    fxPrefix: '/showdown/fx/',
    loadedSpriteData: { xy: 1, bw: 0 },
  };
  applyShowdownSpriteCdn(dex);
  assert.equal(dex.resourcePrefix, `${SHOWDOWN_SPRITE_CDN}/`);
  assert.equal(dex.fxPrefix, `${SHOWDOWN_SPRITE_CDN}/fx/`);
  assert.deepEqual(dex.loadedSpriteData, { xy: 1, bw: 1 });
  applyShowdownSpriteCdn(undefined);
});
