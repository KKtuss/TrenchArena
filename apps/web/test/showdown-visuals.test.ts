import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SHOWDOWN_SPRITE_CDN,
  applyShowdownSpriteCdn,
  fullSpriteId,
  itemIconOffset,
  pokemonIconOffset,
  showdownSpriteSrc,
  typeIconSrc,
  speciesId,
} from '../lib/showdown-visuals';

test('maps Showdown gen5 sprite ids and icon-sheet positions', () => {
  assert.equal(speciesId('Great Tusk'), 'greattusk');
  assert.equal(fullSpriteId('Great Tusk'), 'greattusk');
  assert.equal(fullSpriteId('Rotom-Wash'), 'rotom-wash');
  assert.equal(fullSpriteId('Iron Valiant'), 'ironvaliant');
  assert.equal(fullSpriteId('Ho-Oh'), 'hooh');
  assert.equal(fullSpriteId('Porygon-Z'), 'porygonz');
  assert.equal(fullSpriteId('Jangmo-o'), 'jangmoo');
  assert.equal(fullSpriteId('Hakamo-o'), 'hakamoo');
  assert.equal(fullSpriteId('Kommo-o'), 'kommoo');
  assert.equal(fullSpriteId('Kommo-o-Totem'), 'kommoo');
  assert.equal(fullSpriteId('Wo-Chien'), 'wochien');
  assert.equal(fullSpriteId('Chien-Pao'), 'chienpao');
  assert.equal(fullSpriteId('Ting-Lu'), 'tinglu');
  assert.equal(fullSpriteId('Chi-Yu'), 'chiyu');
  assert.equal(fullSpriteId('Tauros-Paldea-Aqua'), 'tauros-paldeaaqua');
  assert.equal(fullSpriteId('Tauros-Paldea-Blaze'), 'tauros-paldeablaze');
  assert.equal(fullSpriteId('Tauros-Paldea-Combat'), 'tauros-paldeacombat');
  assert.equal(fullSpriteId('Basculin-White-Striped'), 'basculin-whitestriped');
  assert.equal(fullSpriteId('Greninja-Bond'), 'greninja-ash');
  assert.equal(fullSpriteId('Oricorio-Pom-Pom'), 'oricorio-pompom');
  assert.equal(fullSpriteId("Oricorio-Pa'u"), 'oricorio-pau');
  assert.equal(fullSpriteId('Toxtricity-Low-Key'), 'toxtricity-lowkey');
  assert.equal(fullSpriteId('Alcremie-Caramel-Swirl'), 'alcremie-caramelswirl');
  assert.equal(fullSpriteId('Dudunsparce-Three-Segment'), 'dudunsparce-threesegment');
  assert.equal(fullSpriteId('Rockruff-Dusk'), 'rockruff');
  assert.equal(fullSpriteId('Nidoran-F'), 'nidoranf');
  assert.equal(fullSpriteId('Charizard-Mega-X'), 'charizard-megax');
  assert.equal(fullSpriteId('Gyarados'), 'gyarados');
  assert.equal(fullSpriteId('Pikachu'), 'pikachu');
  assert.equal(
    showdownSpriteSrc('Venusaur'),
    `${SHOWDOWN_SPRITE_CDN}/sprites/gen5/venusaur.png`,
  );
  assert.equal(
    showdownSpriteSrc('Great Tusk'),
    `${SHOWDOWN_SPRITE_CDN}/sprites/gen5/greattusk.png`,
  );
  assert.equal(showdownSpriteSrc(''), null);
  assert.deepEqual(itemIconOffset('Leftovers'), { left: 48, top: 360 });
  assert.deepEqual(itemIconOffset('Heavy-Duty Boots'), { left: 264, top: 1056 });
  assert.deepEqual(itemIconOffset('Choice Specs'), { left: 144, top: 96 });
  assert.equal(itemIconOffset(''), null);
  assert.equal(itemIconOffset('Not An Item'), null);
  assert.deepEqual(pokemonIconOffset('Great Tusk'), { left: 0, top: 2460 });
  assert.deepEqual(pokemonIconOffset(''), { left: 0, top: 0 });
  assert.equal(
    typeIconSrc(' electric '),
    `${SHOWDOWN_SPRITE_CDN}/sprites/types/Electric.png`,
  );
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
