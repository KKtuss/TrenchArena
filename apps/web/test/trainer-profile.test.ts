import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TRAINER_SPRITE_ID,
  getTrainerSprite,
  isTrainerUsername,
  parseStoredTrainerProfile,
  publicTrainerName,
  publicTrainerSpriteId,
  searchTrainerSprites,
  shortenAddress,
  trainerProfileStorageKey,
  TRAINER_SPRITES,
} from '../lib/trainer-profile';

test('trainer catalog includes credited metadata and defaults', () => {
  assert.ok(TRAINER_SPRITES.length > 1000);
  const blue = getTrainerSprite('blue-gen3');
  assert.equal(blue.id, 'blue-gen3');
  assert.ok(blue.source.includes('blue-gen3.png'));
  const credited = TRAINER_SPRITES.find(entry => entry.credit);
  assert.ok(credited?.credit);
  assert.equal(getTrainerSprite('missing-sprite').id, DEFAULT_TRAINER_SPRITE_ID);
});

test('trainer search matches name and credit', () => {
  const byName = searchTrainerSprites('blue-gen3', 20);
  assert.ok(byName.some(entry => entry.id === 'blue-gen3'));
  const credited = TRAINER_SPRITES.find(entry => entry.credit);
  assert.ok(credited);
  const byCredit = searchTrainerSprites(credited!.credit!, 80);
  assert.ok(byCredit.some(entry => entry.credit === credited!.credit));
});

test('wallet-scoped trainer profile key is stable', () => {
  const address = '8qbHbw2BbbRYBWQyPgemYbUqueezHPYmEkFNmUgHEf3g';
  assert.equal(trainerProfileStorageKey(address), `pokearena.trainer.${address}`);
  assert.equal(trainerProfileStorageKey(` ${address} `), `pokearena.trainer.${address}`);
});

test('stored trainer profile keeps a username and accepts a legacy sprite id', () => {
  assert.deepEqual(
    parseStoredTrainerProfile(JSON.stringify({ username: 'Red', spriteId: 'red-gen1' })),
    { username: 'Red', spriteId: 'red-gen1' },
  );
  assert.deepEqual(parseStoredTrainerProfile('blue-gen3'), { username: '', spriteId: 'blue-gen3' });
  assert.equal(parseStoredTrainerProfile(null), null);
  assert.equal(isTrainerUsername('Red'), true);
  assert.equal(isTrainerUsername('A'), false);
  assert.equal(isTrainerUsername('name with spaces'), true);
});

test('public trainer names are visible for every wallet, not only self', () => {
  const walletA = '8qbHbw2BbbRYBWQyPgemYbUqueezHPYmEkFNmUgHEf3g';
  const walletB = '9qbHbw2BbbRYBWQyPgemYbUqueezHPYmEkFNmUgHEf3h';
  const trainers = {
    [walletA]: { username: 'Kaktuss', spriteId: 'blue-gen3' },
    [walletB]: { username: 'Red', spriteId: 'red-gen1' },
  };
  assert.equal(publicTrainerName(walletA, trainers), 'Kaktuss');
  assert.equal(
    publicTrainerName(walletB, trainers, { id: walletA, username: 'Kaktuss' }),
    'Red',
  );
  assert.equal(
    publicTrainerName(walletA, {}, { id: walletA, username: 'Kaktuss' }),
    'Kaktuss',
  );
  assert.equal(publicTrainerName(walletB, {}), shortenAddress(walletB));
  assert.equal(publicTrainerName(walletB, {}, undefined, 'Ash'), 'Ash');
  assert.equal(publicTrainerSpriteId(walletB, trainers), 'red-gen1');
  assert.equal(
    publicTrainerSpriteId(walletA, trainers, { id: walletA, spriteId: 'cynthia' }),
    'cynthia',
  );
});
