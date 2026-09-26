import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectTeam, searchTeamOptions } from '../src';
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
});
