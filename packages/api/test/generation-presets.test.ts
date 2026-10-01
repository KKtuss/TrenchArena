import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Dex } from 'pokemon-showdown';

import { getRuleset, sliceTeamText, validateRulesetTeam } from '@pokearena/battle-engine';

import { GENERATION_CASUAL_PRESETS, getGenerationPreset } from '../src/generation-presets';

test('each Casual generation preset is the same six for every player', () => {
  assert.equal(GENERATION_CASUAL_PRESETS.length, 9);
  for (const generation of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const ruleset = getRuleset(`gen${generation}casual`);
    const preset = getGenerationPreset(ruleset.presetId!);
    assert.equal(preset.pokemon.length, 6);
    const species = preset.pokemon.map(mon => mon.species);
    assert.equal(new Set(species).size, 6, species.join(','));
    for (const mon of preset.pokemon) {
      const dex = Dex.species.get(mon.species);
      assert.equal(dex.gen, generation, mon.species);
      assert.equal(dex.exists, true);
    }
    validateRulesetTeam(preset.paste, ruleset.id, { size: 6 });
    const sliced = sliceTeamText(preset.paste, [0, 1, 2]);
    validateRulesetTeam(sliced, ruleset.id, { size: 3 });
    assert.equal(getGenerationPreset(ruleset.presetId!).paste, preset.paste);
  }
});
