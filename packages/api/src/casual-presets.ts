import { inspectTeam, validateAndPackTeam, type InspectedSet } from '@pokearena/battle-engine';

/**
 * Curated Casual 6-mon pastes.
 *
 * Legality is stock Gen 9 OU TeamValidator (no custom banlist).
 * Slot fixes after validation are listed at the bottom of this file.
 */
export interface CasualPresetMon {
  slot: number;
  species: string;
  item: string;
  ability: string;
  nature: string;
  moves: string[];
  types: string[];
}

export interface CasualPreset {
  id: string;
  name: string;
  paste: string;
  pokemon: CasualPresetMon[];
}

const CLASSIC_BALANCE = `
Charizard @ Heavy-Duty Boots
Ability: Blaze
Tera Type: Fire
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Flamethrower
- Air Slash
- Dragon Pulse
- Heat Wave

Gyarados @ Leftovers
Ability: Intimidate
Tera Type: Water
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Dragon Dance
- Waterfall
- Earthquake
- Ice Fang

Gengar @ Focus Sash
Ability: Cursed Body
Tera Type: Ghost
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Shadow Ball
- Sludge Bomb
- Focus Blast
- Nasty Plot

Lucario @ Life Orb
Ability: Inner Focus
Tera Type: Fighting
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Close Combat
- Meteor Mash
- Extreme Speed
- Swords Dance

Mamoswine @ Choice Band
Ability: Thick Fat
Tera Type: Ground
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Earthquake
- Icicle Crash
- Ice Shard
- Knock Off

Venusaur @ Black Sludge
Ability: Overgrow
Tera Type: Grass
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Sludge Bomb
- Giga Drain
- Earth Power
- Leech Seed
`;

const KANTO_JOHTO_CLASSICS = `
Pikachu @ Light Ball
Ability: Lightning Rod
Tera Type: Electric
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Thunderbolt
- Volt Switch
- Surf
- Nasty Plot

Arcanine @ Heavy-Duty Boots
Ability: Intimidate
Tera Type: Fire
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Flare Blitz
- Extreme Speed
- Morning Sun
- Play Rough

Gyarados @ Leftovers
Ability: Intimidate
Tera Type: Flying
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Waterfall
- Earthquake
- Ice Fang
- Dragon Dance

Venusaur @ Black Sludge
Ability: Overgrow
Tera Type: Grass
EVs: 252 SpA / 4 SpD / 252 Spe
Modest Nature
- Giga Drain
- Sludge Bomb
- Earth Power
- Leech Seed

Tyranitar @ Leftovers
Ability: Sand Stream
Tera Type: Rock
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Stone Edge
- Crunch
- Earthquake
- Ice Punch

Gengar @ Life Orb
Ability: Cursed Body
Tera Type: Ghost
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Shadow Ball
- Sludge Bomb
- Focus Blast
- Destiny Bond
`;

const MODERN_CLASSICS = `
Dragonite @ Heavy-Duty Boots
Ability: Multiscale
Tera Type: Normal
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Dragon Dance
- Extreme Speed
- Earthquake
- Roost

Lucario @ Life Orb
Ability: Inner Focus
Tera Type: Fighting
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Close Combat
- Meteor Mash
- Bullet Punch
- Swords Dance

Azumarill @ Assault Vest
Ability: Huge Power
Tera Type: Water
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Play Rough
- Liquidation
- Aqua Jet
- Knock Off

Gardevoir @ Choice Specs
Ability: Trace
Tera Type: Fairy
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Moonblast
- Psychic
- Shadow Ball
- Healing Wish

Lycanroc @ Life Orb
Ability: Sand Rush
Tera Type: Rock
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Accelerock
- Stone Edge
- Close Combat
- Crunch

Arcanine @ Leftovers
Ability: Intimidate
Tera Type: Fire
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Flare Blitz
- Extreme Speed
- Will-O-Wisp
- Morning Sun
`;

const RIVALS_TEAM = `
Dragonite @ Lum Berry
Ability: Multiscale
Tera Type: Normal
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Dragon Dance
- Extreme Speed
- Earthquake
- Fire Punch

Charizard @ Heavy-Duty Boots
Ability: Blaze
Tera Type: Fire
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Flamethrower
- Air Slash
- Focus Blast
- Heat Wave

Greninja @ Life Orb
Ability: Protean
Tera Type: Water
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Hydro Pump
- Dark Pulse
- Ice Beam
- U-turn

Tyranitar @ Assault Vest
Ability: Sand Stream
Tera Type: Dark
EVs: 252 Atk / 4 SpD / 252 Spe
Adamant Nature
- Stone Edge
- Crunch
- Earthquake
- Ice Punch

Jolteon @ Choice Specs
Ability: Volt Absorb
Tera Type: Electric
EVs: 252 SpA / 4 SpD / 252 Spe
Timid Nature
- Thunderbolt
- Volt Switch
- Shadow Ball
- Thunder Wave

Umbreon @ Leftovers
Ability: Synchronize
Tera Type: Dark
EVs: 252 HP / 4 Def / 252 SpD
Calm Nature
- Foul Play
- Wish
- Protect
- Toxic
`;

export const CASUAL_PRESETS: readonly CasualPreset[] = buildCatalog();

function buildCatalog(): CasualPreset[] {
  const specs: Array<{ id: string; name: string; paste: string }> = [
    { id: 'classic-balance', name: 'Classic Balance', paste: CLASSIC_BALANCE },
    { id: 'kanto-johto-classics', name: 'Kanto / Johto Classics', paste: KANTO_JOHTO_CLASSICS },
    { id: 'modern-classics', name: 'Modern Classics', paste: MODERN_CLASSICS },
    { id: 'rivals-team', name: "Rival's Team", paste: RIVALS_TEAM },
  ];
  const problems: string[] = [];
  const presets: CasualPreset[] = [];
  for (const spec of specs) {
    try {
      presets.push(buildPreset(spec.id, spec.name, spec.paste));
    } catch (error) {
      problems.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length) {
    throw new Error(`Casual presets failed Gen 9 legality:\n${problems.join('\n')}`);
  }
  return presets;
}

export function getCasualPreset(id: string): CasualPreset {
  const preset = CASUAL_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error(`Unknown Casual preset: ${id}`);
  return preset;
}

export function pickCreatorPresetId(): string {
  return CASUAL_PRESETS[Math.floor(Math.random() * CASUAL_PRESETS.length)]!.id;
}

export function pickOpponentPresetId(creatorPresetId: string): string {
  const others = CASUAL_PRESETS.filter(preset => preset.id !== creatorPresetId);
  const pool = others.length ? others : [...CASUAL_PRESETS];
  return pool[Math.floor(Math.random() * pool.length)]!.id;
}

function buildPreset(id: string, name: string, paste: string): CasualPreset {
  const trimmed = paste.trim();
  validateAndPackTeam(trimmed, 'gen9ou');
  const inspection = inspectTeam(trimmed, 'gen9ou');
  if (inspection.problems.length) {
    throw new Error(`${name} failed Gen 9 legality: ${inspection.problems.join('; ')}`);
  }
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

/*
 * Preset slot documentation
 *
 * Proposed catalog species were kept. Sets were authored as readable Gen 9
 * pastes and packed with TeamValidator('gen9ou') at module load.
 *
 * Known product-to-Showdown mappings (not custom bans):
 * - Gengar uses Cursed Body (Levitate is not a Gen 9 Gengar ability).
 * - Lycanroc is Midday Lycanroc with Sand Rush.
 * - Greninja uses Protean (not Battle Bond).
 * - Charizard uses Heat Wave instead of Roost (Roost is not a Gen 9 Charizard move).
 * - Roserade is not in the Gen 9 Pokédex; Classic Balance uses Venusaur in that grass slot.
 * - Venusaur uses Leech Seed instead of Sleep Powder (Sleep Moves Clause).
 * - Jolteon uses Thunder Wave instead of Tera Blast (Tera Blast is banned in Gen 9 OU).
 * - Tera Type lines are required by Gen 9 OU validation even if Casual battles
 *   later disable Terastallization via Showdown's Terastal Clause.
 */
