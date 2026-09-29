import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  filterItemHits,
  filterMoveHits,
  filterSpeciesHits,
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
