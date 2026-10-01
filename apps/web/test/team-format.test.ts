import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyTeamProblems, teamLegalityTone } from '../lib/team';
import { customFormats, formatBuilderBlurb } from '../lib/tournament-formats';

test('builder formats expose each Gen cup and Gen 9 OU separately', () => {
  const formats = customFormats();
  assert.equal(formats.length, 10);
  assert.equal(formats[0]!.id, 'gen1cup');
  assert.equal(formats[3]!.id, 'gen4cup');
  assert.equal(formats[9]!.id, 'gen9ou');
  assert.match(formatBuilderBlurb('gen1cup'), /Gen 1-introduced species only/i);
  assert.match(formatBuilderBlurb('gen9ou'), /OU legal/i);
  assert.notEqual(formatBuilderBlurb('gen9cup'), formatBuilderBlurb('gen9ou'));
});

test('team legality tone and problem classification stay format-agnostic helpers', () => {
  assert.equal(teamLegalityTone(0, undefined, []), 'empty');
  assert.equal(teamLegalityTone(6, true, []), 'legal');
  assert.equal(teamLegalityTone(4, false, ['Garchomp is not a Gen 2-introduced Pokémon.']), 'illegal');
  const groups = classifyTeamProblems([
    'Garchomp is not a Gen 2-introduced Pokémon.',
    "Gengar can't learn Shadow Ball.",
    'Ability Solar Power is not available.',
    'Item Life Orb is not allowed.',
    'Your team has more than one of the same Pokémon.',
  ]);
  assert.equal(groups.pokemon.length, 1);
  assert.equal(groups.moves.length, 1);
  assert.equal(groups.abilities.length, 1);
  assert.equal(groups.items.length, 1);
  assert.equal(groups.other.length, 1);
});
