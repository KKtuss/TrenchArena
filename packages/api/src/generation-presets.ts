import { inspectTeam, sliceTeamText, validateRulesetTeam, type InspectedSet } from '@pokearena/battle-engine';

import type { CasualPreset, CasualPresetMon } from './casual-presets';

/**
 * One shared six for each generation's Casual tournament.
 * Both players receive this paste. Change a generation here without
 * touching tournament or battle flow.
 *
 * Sets use the current Gen 9 battle engine, restricted to species introduced
 * in that generation and to moves, abilities, and items from that generation
 * (with the engine's ability floor for generations 1–2).
 */
const PASTES: Record<number, string> = {
  1: `
Venusaur
Ability: Overgrow
Tera Type: Grass
EVs: 252 HP / 4 SpA / 252 Spe
Timid Nature
- Solar Beam
- Toxic
- Razor Leaf
- Leech Seed

Charizard
Ability: Blaze
Tera Type: Fire
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Flamethrower
- Fire Blast
- Slash
- Earthquake

Blastoise
Ability: Torrent
Tera Type: Water
EVs: 252 HP / 4 SpA / 252 SpD
Modest Nature
- Surf
- Hydro Pump
- Ice Beam
- Earthquake

Hypno
Ability: Insomnia
Tera Type: Psychic
EVs: 252 HP / 252 SpD / 4 Spe
Calm Nature
- Psychic
- Disable
- Psybeam
- Thunder Wave

Jolteon
Ability: Volt Absorb
Tera Type: Electric
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Thunderbolt
- Thunder Wave
- Agility
- Pin Missile

Gengar
Ability: Cursed Body
Tera Type: Ghost
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Confuse Ray
- Dream Eater
- Night Shade
- Thunderbolt
`,
  2: `
Typhlosion @ Leftovers
Ability: Blaze
Tera Type: Fire
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Flamethrower
- Fire Blast
- Earthquake
- Swift

Feraligatr @ Leftovers
Ability: Torrent
Tera Type: Water
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Waterfall
- Earthquake
- Slash
- Surf

Meganium @ Leftovers
Ability: Overgrow
Tera Type: Grass
EVs: 252 HP / 4 SpA / 252 SpD
Bold Nature
- Razor Leaf
- Leech Seed
- Synthesis
- Body Slam

Scizor @ Leftovers
Ability: Swarm
Tera Type: Bug
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Metal Claw
- Agility
- Swords Dance
- Fury Cutter

Ampharos @ Leftovers
Ability: Static
Tera Type: Electric
EVs: 252 HP / 252 SpA / 4 SpD
Modest Nature
- Thunderbolt
- Thunder Wave
- Fire Punch
- Light Screen

Umbreon @ Leftovers
Ability: Synchronize
Tera Type: Dark
EVs: 252 HP / 4 Def / 252 SpD
Calm Nature
- Toxic
- Confuse Ray
- Moonlight
- Protect
`,
  3: `
Sceptile @ Leftovers
Ability: Overgrow
Tera Type: Grass
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Leaf Blade
- Giga Drain
- Quick Attack
- Dragon Claw

Blaziken @ Choice Band
Ability: Blaze
Tera Type: Fire
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Blaze Kick
- Brick Break
- Earthquake
- Rock Slide

Swampert @ Leftovers
Ability: Torrent
Tera Type: Water
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Earthquake
- Surf
- Ice Beam
- Protect

Gardevoir @ Leftovers
Ability: Trace
Tera Type: Psychic
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Psychic
- Thunderbolt
- Calm Mind
- Magical Leaf

Breloom @ Leftovers
Ability: Effect Spore
Tera Type: Grass
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Swords Dance
- Mach Punch
- Brick Break
- Leech Seed

Plusle @ Leftovers
Ability: Plus
Tera Type: Electric
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Thunderbolt
- Thunder Wave
- Agility
- Quick Attack
`,
  4: `
Infernape @ Life Orb
Ability: Blaze
Tera Type: Fire
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Close Combat
- Flare Blitz
- Earthquake
- Mach Punch

Empoleon @ Leftovers
Ability: Torrent
Tera Type: Water
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Surf
- Ice Beam
- Grass Knot
- Stealth Rock

Lucario @ Life Orb
Ability: Inner Focus
Tera Type: Fighting
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Close Combat
- Extreme Speed
- Earthquake
- Swords Dance

Leafeon @ Leftovers
Ability: Leaf Guard
Tera Type: Grass
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Leaf Blade
- Swords Dance
- X-Scissor
- Synthesis

Gliscor @ Leftovers
Ability: Hyper Cutter
Tera Type: Ground
EVs: 252 HP / 4 Atk / 252 Spe
Jolly Nature
- Earthquake
- Ice Fang
- Knock Off
- Toxic

Staraptor @ Choice Band
Ability: Intimidate
Tera Type: Flying
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Brave Bird
- Close Combat
- Double-Edge
- U-turn
`,
  5: `
Excadrill @ Life Orb
Ability: Sand Rush
Tera Type: Ground
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Earthquake
- Iron Head
- Rock Slide
- Swords Dance

Chandelure @ Choice Specs
Ability: Flash Fire
Tera Type: Ghost
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Shadow Ball
- Flamethrower
- Energy Ball
- Psychic

Conkeldurr @ Leftovers
Ability: Guts
Tera Type: Fighting
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Drain Punch
- Rock Slide
- Earthquake
- Ice Punch

Alomomola @ Leftovers
Ability: Healer
Tera Type: Water
EVs: 252 HP / 252 Def / 4 SpD
Bold Nature
- Scald
- Wish
- Protect
- Aqua Jet

Krookodile @ Choice Scarf
Ability: Intimidate
Tera Type: Ground
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Earthquake
- Crunch
- Stone Edge
- Outrage

Lilligant @ Life Orb
Ability: Chlorophyll
Tera Type: Grass
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Quiver Dance
- Giga Drain
- Petal Dance
- Energy Ball
`,
  6: `
Delphox @ Life Orb
Ability: Blaze
Tera Type: Fire
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Fire Blast
- Psychic
- Grass Knot
- Calm Mind

Chesnaught @ Leftovers
Ability: Overgrow
Tera Type: Grass
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Wood Hammer
- Hammer Arm
- Earthquake
- Spiky Shield

Clawitzer @ Choice Specs
Ability: Mega Launcher
Tera Type: Water
EVs: 252 HP / 252 SpA / 4 SpD
Modest Nature
- Water Pulse
- Aura Sphere
- Dark Pulse
- Ice Beam

Hawlucha @ Sitrus Berry
Ability: Unburden
Tera Type: Fighting
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Acrobatics
- Close Combat
- Stone Edge
- Swords Dance

Sylveon @ Leftovers
Ability: Pixilate
Tera Type: Fairy
EVs: 252 HP / 252 SpA / 4 SpD
Modest Nature
- Hyper Voice
- Moonblast
- Calm Mind
- Shadow Ball

Talonflame @ Leftovers
Ability: Gale Wings
Tera Type: Fire
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Brave Bird
- Flare Blitz
- Roost
- U-turn
`,
  7: `
Decidueye @ Leftovers
Ability: Overgrow
Tera Type: Grass
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Leaf Blade
- Spirit Shackle
- Brave Bird
- Swords Dance

Primarina @ Leftovers
Ability: Torrent
Tera Type: Water
EVs: 252 SpA / 4 SpD / 252 Spe
Modest Nature
- Moonblast
- Hydro Pump
- Psychic
- Ice Beam

Mimikyu @ Life Orb
Ability: Disguise
Tera Type: Ghost
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Play Rough
- Shadow Claw
- Swords Dance
- Shadow Sneak

Toxapex @ Black Sludge
Ability: Regenerator
Tera Type: Water
EVs: 252 HP / 252 Def / 4 SpD
Bold Nature
- Surf
- Recover
- Toxic
- Baneful Bunker

Lycanroc @ Life Orb
Ability: Sand Rush
Tera Type: Rock
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Accelerock
- Stone Edge
- Crunch
- Swords Dance

Salazzle @ Life Orb
Ability: Corrosion
Tera Type: Fire
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Fire Blast
- Sludge Bomb
- Toxic
- Nasty Plot
`,
  8: `
Rillaboom @ Leftovers
Ability: Grassy Surge
Tera Type: Grass
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Grassy Glide
- Wood Hammer
- Knock Off
- U-turn

Cinderace @ Heavy-Duty Boots
Ability: Libero
Tera Type: Fire
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Pyro Ball
- Flame Charge
- U-turn
- Court Change

Corviknight @ Leftovers
Ability: Pressure
Tera Type: Flying
EVs: 252 HP / 4 Def / 252 SpD
Impish Nature
- Brave Bird
- Iron Head
- Body Press
- U-turn

Toxtricity @ Choice Specs
Ability: Punk Rock
Tera Type: Electric
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Overdrive
- Boomburst
- Sludge Bomb
- Volt Switch

Grimmsnarl @ Light Clay
Ability: Prankster
Tera Type: Dark
EVs: 252 HP / 4 Def / 252 SpD
Careful Nature
- Reflect
- Light Screen
- Spirit Break
- Thunder Wave

Barraskewda @ Choice Band
Ability: Swift Swim
Tera Type: Water
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Liquidation
- Aqua Jet
- Close Combat
- Psychic Fangs
`,
  9: `
Meowscarada @ Heavy-Duty Boots
Ability: Protean
Tera Type: Grass
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Flower Trick
- Knock Off
- U-turn
- Play Rough

Skeledirge @ Leftovers
Ability: Unaware
Tera Type: Fire
EVs: 252 HP / 252 SpA / 4 SpD
Modest Nature
- Torch Song
- Shadow Ball
- Will-O-Wisp
- Flamethrower

Quaquaval @ Life Orb
Ability: Moxie
Tera Type: Water
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Aqua Step
- Close Combat
- Ice Spinner
- Swords Dance

Tinkaton @ Leftovers
Ability: Mold Breaker
Tera Type: Steel
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Gigaton Hammer
- Play Rough
- Knock Off
- Stealth Rock

Clodsire @ Black Sludge
Ability: Water Absorb
Tera Type: Poison
EVs: 252 HP / 4 Atk / 252 SpD
Careful Nature
- Earthquake
- Poison Jab
- Protect
- Toxic

Kilowattrel @ Choice Specs
Ability: Volt Absorb
Tera Type: Electric
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Thunderbolt
- Hurricane
- Volt Switch
- U-turn
`,
};

function buildPreset(generation: number, paste: string): CasualPreset {
  const id = `gen${generation}-casual`;
  const rulesetId = `gen${generation}casual`;
  const name = `Gen ${generation} Casual`;
  const trimmed = paste.trim();
  validateRulesetTeam(trimmed, rulesetId, { size: 6 });
  const inspection = inspectTeam(trimmed, 'gen9ou', rulesetId);
  if (inspection.problems.length) {
    throw new Error(`${name} failed format legality: ${inspection.problems.join('; ')}`);
  }
  const packedThree = validateRulesetTeam(sliceTeamText(trimmed, [0, 2, 4]), rulesetId, { size: 3 });
  if (!packedThree) throw new Error(`${name} could not slice to three.`);
  return {
    id,
    name,
    paste: trimmed,
    pokemon: inspection.sets.map(toPreviewMon),
  };
}

function toPreviewMon(set: InspectedSet, slot: number): CasualPresetMon {
  return {
    slot,
    species: set.species,
    item: set.item,
    ability: set.ability,
    nature: set.nature,
    moves: [...set.moves],
    types: [...set.types],
  };
}

function loadPresets(): CasualPreset[] {
  const problems: string[] = [];
  const presets: CasualPreset[] = [];
  for (const [generation, paste] of Object.entries(PASTES)) {
    try {
      presets.push(buildPreset(Number(generation), paste));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length) {
    throw new Error(`Generation Casual presets failed legality:\n${problems.join('\n')}`);
  }
  return presets;
}

export const GENERATION_CASUAL_PRESETS: readonly CasualPreset[] = loadPresets();

const BY_ID = new Map(GENERATION_CASUAL_PRESETS.map(preset => [preset.id, preset]));

export function getGenerationPreset(id: string): CasualPreset {
  const preset = BY_ID.get(id);
  if (!preset) throw new Error(`Unknown generation Casual preset: ${id}`);
  return preset;
}
