import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CASUAL_SHOWDOWN_FORMAT_ID,
  CASUAL_TEAM_SIZE,
  inspectTeam,
  searchTeamHits,
  searchTeamOptions,
  sliceTeamText,
  validateAndPackTeam,
} from '../src';
import { TEAM_ONE } from './fixtures';

test('inspects a legal Gen 9 OU team and packs it', () => {
  const inspection = inspectTeam(TEAM_ONE, 'gen9ou');
  assert.equal(inspection.sets.length, 6);
  assert.equal(inspection.sets[0]?.species, 'Great Tusk');
  assert.equal(inspection.problems.length, 0);
  assert.ok(inspection.packed);
  assert.ok(inspection.speeds[0]!.speed >= inspection.speeds.at(-1)!.speed);
  const tusk = inspection.sets[0]!;
  assert.deepEqual(tusk.types, ['Ground', 'Fighting']);
  assert.ok(tusk.stats.find(stat => stat.stat === 'def' && stat.nature === 'up'));
});

test('reports an illegal move without packing the team', () => {
  const inspection = inspectTeam(TEAM_ONE.replace('Headlong Rush', 'DefinitelyNotAMove'), 'gen9ou');
  assert.equal(inspection.packed, undefined);
  assert.ok(inspection.problems.length > 0);
});

test('searches species, moves, and a species ability list', () => {
  assert.ok(searchTeamOptions('species', 'peli').includes('Pelipper'));
  assert.ok(searchTeamOptions('move', 'hydro').includes('Hydro Pump'));
  assert.deepEqual(searchTeamOptions('ability', '', 'Pelipper'), ['Keen Eye', 'Drizzle', 'Rain Dish']);
  assert.ok(searchTeamOptions('move', 'hydro', 'Pelipper').includes('Hydro Pump'));
  assert.equal(searchTeamOptions('move', 'flamethrower', 'Pelipper').includes('Flamethrower'), false);
  const hydro = searchTeamHits('move', 'hydro', 'Pelipper');
  const pump = hydro.hits.find(hit => hit.name === 'Hydro Pump');
  assert.equal(hydro.scoped, true);
  assert.equal(pump?.type, 'Water');
  assert.equal(pump?.category, 'Special');
  assert.ok(pump?.description);
  assert.ok(searchTeamHits('species', 'peli').hits.find(hit => hit.name === 'Pelipper')?.types?.includes('Flying'));
});

test('empty species and item queries return Gen 9 OU catalogs and skip Ubers', () => {
  const species = searchTeamHits('species', '');
  assert.ok(species.hits.length > 400);
  assert.ok(species.hits.find(hit => hit.name === 'Great Tusk'));
  assert.ok(species.hits.find(hit => hit.name === 'Pelipper'));
  assert.equal(species.hits.some(hit => hit.name === 'Koraidon'), false);
  assert.equal(species.hits.some(hit => hit.name === 'Miraidon'), false);
  assert.equal(species.hits.some(hit => hit.name.startsWith('Arceus')), false);
  const items = searchTeamHits('item', '');
  assert.ok(items.hits.length > 100);
  assert.ok(items.hits.find(hit => hit.name === 'Leftovers'));
  const learnset = searchTeamHits('move', '', 'Pelipper');
  assert.equal(learnset.scoped, true);
  assert.ok(learnset.hits.length > 20);
  const hurricane = learnset.hits.find(hit => hit.name === 'Hurricane');
  assert.equal(hurricane?.type, 'Flying');
  assert.equal(hurricane?.category, 'Special');
  assert.ok((hurricane?.power ?? 0) > 0);
});

test('search result metadata supports picker filters', () => {
  const items = searchTeamHits('item', 'choice').hits;
  assert.ok(items.some(hit => hit.name === 'Choice Scarf'));

  const waterMoves = searchTeamHits('move', 'water', 'Pelipper');
  assert.equal(waterMoves.scoped, true);
  assert.ok(waterMoves.hits.length > 0);
  assert.ok(waterMoves.hits.every(hit => hit.type === 'Water' || hit.name.toLowerCase().includes('water')));
  assert.ok(waterMoves.hits.every(hit => hit.category && hit.power !== undefined));
});

test('Levitate removes a Ground weakness from the threat list', () => {
  const inspection = inspectTeam([
    'Rotom-Wash @ Leftovers',
    'Ability: Levitate',
    'EVs: 252 HP / 252 Def',
    'Bold Nature',
    '- Hydro Pump',
    '- Volt Switch',
    '- Will-O-Wisp',
    '- Pain Split',
  ].join('\n'), 'gen9ou');
  const ground = inspection.threats.find(threat => threat.attack === 'Ground');
  assert.equal(ground?.exposed.includes('Rotom-Wash') ?? false, false);
});

test('slices and packs a 3-mon Casual battle team', () => {
  const sliced = sliceTeamText(TEAM_ONE, [0, 2, 4]);
  assert.match(sliced, /Great Tusk/);
  assert.match(sliced, /Kingambit/);
  assert.match(sliced, /Rotom-Wash/);
  assert.doesNotMatch(sliced, /Gholdengo/);
  const packed = validateAndPackTeam(sliced, 'gen9ou', {
    size: CASUAL_TEAM_SIZE,
    showdownFormatId: CASUAL_SHOWDOWN_FORMAT_ID,
  });
  assert.ok(packed.includes('Great Tusk') || packed.includes('greattusk'));
});
