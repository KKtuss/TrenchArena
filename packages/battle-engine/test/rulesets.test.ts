import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dex } from 'pokemon-showdown';

import {
  GEN_CUP_BATTLE_FORMAT,
  getRuleset,
  listRulesets,
  searchTeamHits,
  searchTeamOptions,
  speciesAllowed,
  speciesIntroducedGeneration,
  validateRulesetTeam,
} from '../src';

test('generation cups only list base species introduced in that generation', () => {
  for (const generation of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const ruleset = getRuleset(`gen${generation}cup`);
    const catalog = searchTeamHits('species', '', undefined, ruleset.id);
    assert.ok(catalog.hits.length > 10, `gen ${generation} catalog`);
    for (const hit of catalog.hits) {
      assert.equal(speciesAllowed(ruleset, hit.name), true, hit.name);
      assert.equal(speciesIntroducedGeneration(hit.name), generation, hit.name);
      const species = Dex.species.get(hit.name);
      assert.equal(Boolean(species.forme), false, `forme leaked into catalog: ${hit.name}`);
    }
  }

  const gen1 = searchTeamOptions('species', '', undefined, 'gen1cup');
  assert.ok(gen1.includes('Charizard'));
  assert.ok(gen1.includes('Mewtwo'));
  assert.equal(gen1.includes('Tyranitar'), false);
  assert.equal(gen1.includes('Meowscarada'), false);

  const gen2 = searchTeamOptions('species', 'tyran', undefined, 'gen2cup');
  assert.ok(gen2.includes('Tyranitar'));
  assert.equal(gen2.includes('Charizard'), false);

  const gen4 = searchTeamOptions('species', '', undefined, 'gen4cup');
  assert.ok(gen4.includes('Lucario'));
  assert.equal(gen4.includes('Charizard'), false);
  assert.equal(gen4.includes('Tyranitar'), false);
  assert.equal(speciesAllowed(getRuleset('gen4cup'), 'Charizard'), false);
  assert.equal(speciesAllowed(getRuleset('gen4cup'), 'Infernape'), true);

  const gen9cup = searchTeamOptions('species', '', undefined, 'gen9cup');
  assert.ok(gen9cup.includes('Meowscarada'));
  assert.ok(gen9cup.includes('Great Tusk'));
  assert.equal(gen9cup.includes('Dragonite'), false);
  assert.equal(gen9cup.includes('Pikachu'), false);
});

test('Gen 6 cup is the full intro-gen pool (~72), independent of Gen 9 OU', () => {
  const gen6 = searchTeamOptions('species', '', undefined, 'gen6cup');
  assert.equal(gen6.length, 72);
  assert.ok(gen6.includes('Greninja'));
  assert.ok(gen6.includes('Bunnelby'));
  assert.ok(gen6.includes('Honedge'));
  assert.ok(gen6.includes('Xerneas'));
  assert.ok(gen6.includes('Vivillon'));
  assert.equal(gen6.some(name => Boolean(Dex.species.get(name).forme)), false);
  assert.equal(gen6.includes('Gengar'), false);
  assert.equal(gen6.includes('Arceus-Fairy'), false);
  assert.equal(speciesAllowed(getRuleset('gen6cup'), 'Vivillon-Fancy'), true);
  assert.equal(speciesAllowed(getRuleset('gen6cup'), 'Arceus-Fairy'), false);
  assert.equal(speciesAllowed(getRuleset('gen6cup'), 'Gengar'), false);

  assert.equal(searchTeamOptions('species', 'gengar', undefined, 'gen6cup').length, 0);
  assert.ok(searchTeamOptions('species', 'greninja', undefined, 'gen6cup').includes('Greninja'));

  const ou = searchTeamOptions('species', '', undefined, 'gen9ou');
  assert.ok(ou.includes('Dragonite'));
  assert.equal(ou.includes('Bunnelby'), false);
  assert.notEqual(ou.length, gen6.length);
});

test('Gen 9 OU search stays on the existing OU pool', () => {
  const ou = searchTeamOptions('species', '', undefined, 'gen9ou');
  const implicit = searchTeamOptions('species', '');
  assert.deepEqual(ou, implicit);
  assert.ok(ou.includes('Great Tusk'));
  assert.ok(ou.includes('Dragonite'));
  assert.equal(ou.includes('Mewtwo'), false);
  assert.equal(speciesAllowed(getRuleset('gen9ou'), 'Dragonite'), true);
  assert.equal(speciesAllowed(getRuleset('gen9ou'), 'Mewtwo'), false);
});

test('generation cups hide later moves, abilities, and items', () => {
  const moves = searchTeamOptions('move', '', 'Charizard', 'gen1cup');
  assert.ok(moves.includes('Flamethrower'));
  assert.equal(moves.includes('Flare Blitz'), false);
  assert.equal(moves.includes('Roost'), false);

  const abilities = searchTeamOptions('ability', '', 'Charizard', 'gen1cup');
  assert.deepEqual(abilities, ['Blaze']);

  const items = searchTeamOptions('item', 'boots', 'Charizard', 'gen1cup');
  assert.equal(items.includes('Heavy-Duty Boots'), false);

  const gen4Items = searchTeamOptions('item', 'life', 'Lucario', 'gen4cup');
  assert.ok(gen4Items.includes('Life Orb'));

  const illegal = Array.from({ length: 6 }, () => `
Charizard @ Heavy-Duty Boots
Ability: Solar Power
Tera Type: Fire
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Flare Blitz
- Roost
- Earthquake
- Slash
`.trim()).join('\n\n');
  assert.throws(() => validateRulesetTeam(illegal, 'gen1cup'), /not legal|not a Gen/i);
});

test('Past Gen 6 species validate under National Dex cup rules, not OU', () => {
  const sets = `
Bunnelby @ Leftovers
Ability: Pickup
EVs: 252 HP / 4 Atk / 252 Spe
Jolly Nature
- Earthquake
- Return
- Quick Attack
- Swords Dance

Diggersby @ Life Orb
Ability: Huge Power
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Earthquake
- Return
- Quick Attack
- Swords Dance

Honedge @ Eviolite
Ability: No Guard
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Sacred Sword
- Shadow Sneak
- Swords Dance
- Iron Head

Doublade @ Eviolite
Ability: No Guard
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Sacred Sword
- Shadow Sneak
- Swords Dance
- Iron Head

Aegislash @ Leftovers
Ability: Stance Change
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Sacred Sword
- Shadow Sneak
- Swords Dance
- Iron Head

Talonflame @ Leftovers
Ability: Gale Wings
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Brave Bird
- Flare Blitz
- Roost
- U-turn
`.trim();
  const packed = validateRulesetTeam(sets, 'gen6cup');
  assert.ok(packed.length > 10);
  assert.equal(getRuleset('gen6cup').showdownFormatId, GEN_CUP_BATTLE_FORMAT);
});

test('every generation has a cup and a matching casual ruleset', () => {
  const ids = listRulesets().map(ruleset => ruleset.id);
  assert.ok(ids.includes('gen9ou'));
  for (const generation of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const cup = getRuleset(`gen${generation}cup`);
    const casual = getRuleset(`gen${generation}casual`);
    assert.equal(cup.introducedIn, generation);
    assert.equal(casual.introducedIn, generation);
    assert.equal(cup.teamMode, 'custom');
    assert.equal(casual.teamMode, 'preset-6-choose-3');
    assert.equal(casual.presetId, `gen${generation}-casual`);
    assert.equal(cup.mechanics, 'gen9');
    assert.equal(cup.battleFormat, GEN_CUP_BATTLE_FORMAT);
    assert.equal(cup.showdownFormatId, GEN_CUP_BATTLE_FORMAT);
  }
  assert.equal(getRuleset('gen9ou').showdownFormatId, 'gen9ou');
});
