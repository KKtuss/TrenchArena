import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import {
  enrichMove,
  formatSwitchMeta,
  lookupMoveDex,
  moveDexId,
  parsePokemonCondition,
} from '../lib/fight-moves';

const require = createRequire(import.meta.url);
const { BattleMovedex } = require('../public/showdown/data/moves.js') as {
  BattleMovedex: Record<string, {
    type?: string;
    category?: string;
    basePower?: number;
    accuracy?: number | true;
    shortDesc?: string;
    pp?: number;
  }>;
};

test('normalizes Showdown move ids', () => {
  assert.equal(moveDexId('Shadow Ball'), 'shadowball');
  assert.equal(moveDexId('10,000,000 Volt Thunderbolt'), '10000000voltthunderbolt');
});

test('enriches damaging and status moves from BattleMovedex', () => {
  const shadow = enrichMove('Shadow Ball', { pp: 24, maxpp: 24, dex: BattleMovedex });
  assert.equal(shadow.type, 'Ghost');
  assert.equal(shadow.category, 'Special');
  assert.equal(shadow.powerLabel, '80');
  assert.equal(shadow.accuracyLabel, '100%');
  assert.equal(shadow.ppLabel, '24/24 PP');
  assert.match(shadow.shortDesc ?? '', /Sp\. Def/i);

  const destiny = enrichMove('Destiny Bond', { pp: 7, maxpp: 8, dex: BattleMovedex });
  assert.equal(destiny.type, 'Ghost');
  assert.equal(destiny.category, 'Status');
  assert.equal(destiny.powerLabel, '—');
  assert.equal(destiny.accuracyLabel, 'Always');
  assert.match(destiny.shortDesc ?? '', /faint/i);

  const dance = lookupMoveDex('Dragon Dance', BattleMovedex);
  assert.equal(dance?.category, 'Status');
  assert.equal(dance?.basePower, 0);
});

test('falls back cleanly when a move is unknown', () => {
  const unknown = enrichMove('Made Up Beam', { pp: 1, maxpp: 1, dex: {} });
  assert.equal(unknown.name, 'Made Up Beam');
  assert.equal(unknown.powerLabel, '—');
  assert.equal(unknown.accuracyLabel, '—');
  assert.equal(unknown.ppLabel, '1/1 PP');
  assert.equal(unknown.shortDesc, undefined);
});

test('parses Showdown condition strings for switch tiles', () => {
  assert.deepEqual(parsePokemonCondition('248/248'), {
    hp: 248,
    maxhp: 248,
    percent: 100,
    status: null,
    fainted: false,
  });
  assert.equal(parsePokemonCondition('124/248 par').status, 'PAR');
  assert.equal(parsePokemonCondition('124/248 par').percent, 50);
  assert.equal(parsePokemonCondition('0/248 fnt').fainted, true);
  assert.equal(formatSwitchMeta('168/248 brn'), '68% HP · BRN');
  assert.equal(formatSwitchMeta('0/100 fnt'), 'Fainted');
  assert.equal(formatSwitchMeta(undefined), 'Ready');
});
