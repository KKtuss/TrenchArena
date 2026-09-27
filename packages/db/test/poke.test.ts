import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InvalidPokeAmountError,
  MAX_SAFE_POKE,
  pokeFromPg,
  pokeToPg,
} from '../src/poke';

test('pokeToPg accepts safe non-negative integers', () => {
  assert.equal(pokeToPg(0), '0');
  assert.equal(pokeToPg(10_000_000), '10000000');
  assert.equal(pokeToPg(50_000), '50000');
});

test('pokeFromPg converts pg BIGINT strings without rounding', () => {
  assert.equal(pokeFromPg('0'), 0);
  assert.equal(pokeFromPg('10000000'), 10_000_000);
  assert.equal(pokeFromPg(50_000), 50_000);
  assert.equal(pokeFromPg(10_000_000n), 10_000_000);
});

test('poke conversion rejects non-integers and unsafe magnitudes', () => {
  assert.throws(() => pokeToPg(1.5), InvalidPokeAmountError);
  assert.throws(() => pokeToPg(-1), InvalidPokeAmountError);
  assert.throws(() => pokeFromPg('10.5'), InvalidPokeAmountError);
  assert.throws(() => pokeFromPg('-1'), InvalidPokeAmountError);
  assert.throws(() => pokeFromPg(''), InvalidPokeAmountError);
  assert.throws(() => pokeFromPg(String(MAX_SAFE_POKE) + '0'), InvalidPokeAmountError);
  assert.doesNotThrow(() => pokeFromPg(String(MAX_SAFE_POKE)));
});
