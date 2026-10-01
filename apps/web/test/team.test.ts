import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  baselineEvs,
  evsAreUntouched,
  fillMoveSlots,
  filterItemHits,
  itemGroup,
  filterMoveHits,
  filterSpeciesHits,
  pickStarterEvs,
  pickStarterMoves,
  pickStarterNature,
  sortItemHits,
  sortMoveHits,
  visibleTeamProblems,
} from '../lib/team';

test('filters species hits by name and type without mutating the catalog', () => {
  const hits = [
    { name: 'Pelipper', types: ['Water', 'Flying'] },
    { name: 'Rotom-Wash', types: ['Electric', 'Water'] },
    { name: 'Great Tusk', types: ['Ground', 'Fighting'] },
  ];

  assert.deepEqual(filterSpeciesHits(hits, 'pel', 'Water').map(hit => hit.name), ['Pelipper']);
  assert.deepEqual(filterSpeciesHits(hits, '', 'Water').map(hit => hit.name), ['Pelipper', 'Rotom-Wash']);
  assert.deepEqual(hits.map(hit => hit.name), ['Pelipper', 'Rotom-Wash', 'Great Tusk']);
});

test('filters items by name or description', () => {
  const hits = [
    { name: 'Leftovers', description: 'Restores a little HP every turn.' },
    { name: 'Choice Scarf', description: 'Raises Speed but locks the holder into one move.' },
  ];

  assert.deepEqual(filterItemHits(hits, 'speed').map(hit => hit.name), ['Choice Scarf']);
  assert.deepEqual(filterItemHits(hits, 'left').map(hit => hit.name), ['Leftovers']);
  assert.equal(filterItemHits(hits, 'does-not-exist').length, 0);
});

test('sorts held items into groups and filters by group', () => {
  const hits = [
    { name: 'Leftovers', description: 'Restores a little HP every turn.' },
    { name: 'Choice Scarf', description: 'Raises Speed but locks the holder into one move.' },
    { name: 'Aguav Berry', description: 'Restores HP when low.' },
    { name: 'Light Ball', description: 'If held by a Pikachu, its Attack and Sp. Atk are doubled.' },
    { name: 'Charcoal', description: "Holder's Fire-type attacks have 1.2x power." },
    { name: 'Flame Plate', category: 'Plate', description: 'Holder\'s Fire-type attacks have 1.2x power.' },
  ];

  assert.deepEqual(sortItemHits(hits).map(hit => hit.name), [
    'Light Ball', 'Choice Scarf', 'Charcoal', 'Aguav Berry', 'Flame Plate', 'Leftovers',
  ]);
  assert.deepEqual(filterItemHits(hits, '', 'Berry').map(hit => hit.name), ['Aguav Berry']);
  assert.deepEqual(filterItemHits(hits, 'fire', 'Type').map(hit => hit.name), ['Charcoal']);
  assert.equal(itemGroup({ name: 'Wellspring Mask', category: 'Species' }), 'Species');
});

test('hides unfinished-set move nags from the builder problem list', () => {
  assert.deepEqual(visibleTeamProblems([
    'A gen9ou team must contain exactly six valid Pokémon sets.',
    'Great Tusk has no moves (it must have at least one to be usable).',
    'Pelipper\'s item Flame Plate is banned.',
  ]), [
    'A gen9ou team must contain exactly six valid Pokémon sets.',
    'Pelipper\'s item Flame Plate is banned.',
  ]);
});

test('filters legal move hits by type, category, and searchable details', () => {
  const hits = [
    { name: 'Hydro Pump', type: 'Water', category: 'Special', description: 'A strong blast of water.' },
    { name: 'Liquidation', type: 'Water', category: 'Physical', description: 'Slams the target with water.' },
    { name: 'Roost', type: 'Flying', category: 'Status', description: 'Restores HP.' },
  ];

  assert.deepEqual(filterMoveHits(hits, '', 'Water', 'Special').map(hit => hit.name), ['Hydro Pump']);
  assert.deepEqual(filterMoveHits(hits, 'restores', '', '').map(hit => hit.name), ['Roost']);
  assert.deepEqual(filterMoveHits(hits, 'water', '', '').map(hit => hit.name), ['Hydro Pump', 'Liquidation']);
});

test('sorts legal move hits by name, power, accuracy, and type', () => {
  const hits = [
    { name: 'Roost', type: 'Flying', category: 'Status', power: 0, accuracy: null },
    { name: 'Hydro Pump', type: 'Water', category: 'Special', power: 110, accuracy: 80 },
    { name: 'Liquidation', type: 'Water', category: 'Physical', power: 85, accuracy: 100 },
  ];

  assert.deepEqual(sortMoveHits(hits, 'name').map(hit => hit.name), ['Hydro Pump', 'Liquidation', 'Roost']);
  assert.deepEqual(sortMoveHits(hits, 'power').map(hit => hit.name), ['Hydro Pump', 'Liquidation', 'Roost']);
  assert.deepEqual(sortMoveHits(hits, 'accuracy').map(hit => hit.name), ['Roost', 'Liquidation', 'Hydro Pump']);
  assert.deepEqual(sortMoveHits(hits, 'type').map(hit => hit.name), ['Roost', 'Hydro Pump', 'Liquidation']);
});

test('picks a usable starter set with a full 510 EV spread', () => {
  const hits = [
    { name: 'Giga Impact', type: 'Normal', category: 'Physical', power: 150 },
    { name: 'Hydro Pump', type: 'Water', category: 'Special', power: 110 },
    { name: 'Liquidation', type: 'Water', category: 'Physical', power: 85 },
    { name: 'Hurricane', type: 'Flying', category: 'Special', power: 110 },
    { name: 'Ice Beam', type: 'Ice', category: 'Special', power: 90 },
    { name: 'Roost', type: 'Flying', category: 'Status', power: 0 },
    { name: 'Protect', type: 'Normal', category: 'Status', power: 0 },
  ];
  const physicalHits = [
    ...hits,
    { name: 'Close Combat', type: 'Fighting', category: 'Physical', power: 120 },
    { name: 'Earthquake', type: 'Ground', category: 'Physical', power: 100 },
    { name: 'Ice Shard', type: 'Ice', category: 'Physical', power: 40 },
  ];

  const specialMoves = pickStarterMoves(hits, ['Water', 'Flying']);
  assert.deepEqual(specialMoves, ['Hurricane', 'Hydro Pump', 'Ice Beam', 'Liquidation']);
  assert.deepEqual(fillMoveSlots(['', 'Hurricane', '', ''], ['Hydro Pump', 'Hurricane', 'Ice Beam', 'Roost']), [
    'Hydro Pump', 'Hurricane', 'Ice Beam', 'Roost',
  ]);
  assert.deepEqual(pickStarterEvs(specialMoves, hits), { hp: 0, atk: 0, def: 0, spa: 252, spd: 6, spe: 252 });
  assert.equal(pickStarterNature(pickStarterEvs(specialMoves, hits), 'Serious'), 'Timid');
  assert.deepEqual(pickStarterEvs(['Close Combat', 'Earthquake', 'Ice Shard', 'Protect'], physicalHits), {
    hp: 0, atk: 252, def: 0, spa: 0, spd: 6, spe: 252,
  });
  assert.equal(pickStarterNature({ hp: 0, atk: 252, def: 0, spa: 0, spd: 6, spe: 252 }, ''), 'Jolly');
  assert.equal(pickStarterNature({ hp: 0, atk: 252, def: 0, spa: 0, spd: 6, spe: 252 }, 'Adamant'), 'Adamant');
  assert.equal(Object.values(pickStarterEvs(specialMoves, hits)).reduce((sum, ev) => sum + ev, 0), 510);
  assert.equal(evsAreUntouched({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }), true);
  assert.equal(evsAreUntouched(baselineEvs()), true);
  assert.equal(evsAreUntouched({ hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }), false);
});
