import { Dex } from 'pokemon-showdown';

/**
 * Tournament legality sits on top of the Gen 9 battle simulator.
 *
 * Historical generation battle mechanics are not implemented. Generation cups
 * narrow which species, moves, abilities, and items may be chosen, then the
 * existing Gen 9 OU engine resolves the fight. Abilities did not exist before
 * generation 3; earlier cups still allow each species' earliest ability so a
 * set can start under the current engine. That is not a reconstructed
 * Generation 1 ruleset.
 */
export const GEN9_BATTLE_FORMAT = 'gen9ou' as const;

/**
 * Generation cups include species that left SV (Showdown `Past`).
 * National Dex keeps Gen 9 battle mechanics without the SV dex cut.
 * Gen 9 OU continues to use {@link GEN9_BATTLE_FORMAT} unchanged.
 */
export const GEN_CUP_BATTLE_FORMAT = 'gen9nationaldex' as const;

/** 1v1 Arena Casual rooms — still Gen 9 OU legality. */
export const CASUAL_BATTLE_FORMAT_ID =
  'gen9ou@@@Min Team Size = 3,Max Team Size = 3,!Team Preview,Terastal Clause';

/** Tournament Casual Gen X — National Dex so Past intro-gen species can battle. */
export const GEN_CASUAL_BATTLE_FORMAT_ID =
  `${GEN_CUP_BATTLE_FORMAT}@@@Min Team Size = 3,Max Team Size = 3,!Team Preview,Terastal Clause`;

export const ABILITY_ENGINE_FLOOR = 3;

const GENERATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const RULESET_IDS = [
  'gen9ou',
  ...GENERATIONS.flatMap(generation => [`gen${generation}cup`, `gen${generation}casual`] as const),
] as const;

export type RulesetId = (typeof RULESET_IDS)[number];
export type RulesetTeamMode = 'custom' | 'preset-6-choose-3';

export interface RulesetDefinition {
  id: RulesetId;
  generation: number;
  kind: 'ou' | 'cup' | 'casual';
  /** Species must be introduced in this generation. Absent for Gen 9 OU. */
  introducedIn?: number;
  /**
   * Moves and items introduced after this generation are illegal.
   * Absent for Gen 9 OU, which keeps the stock validator.
   */
  assetGenerationCap?: number;
  teamMode: RulesetTeamMode;
  /** Pokémon stored when a player registers. */
  registerTeamSize: 3 | 6;
  /** Pokémon sent to the battle simulator. */
  battleTeamSize: 3 | 6;
  /** Logical format family (`gen9ou` for OU; cups still report gen9 mechanics). */
  battleFormat: typeof GEN9_BATTLE_FORMAT | typeof GEN_CUP_BATTLE_FORMAT;
  showdownFormatId: string;
  presetId?: string;
  mechanics: 'gen9';
}

const OU_BANNED_TIERS = new Set(['Uber', 'AG', 'Illegal', 'Unreleased']);

function cup(generation: number): RulesetDefinition {
  return {
    id: `gen${generation}cup` as RulesetId,
    generation,
    kind: 'cup',
    introducedIn: generation,
    assetGenerationCap: generation,
    teamMode: 'custom',
    registerTeamSize: 6,
    battleTeamSize: 6,
    battleFormat: GEN_CUP_BATTLE_FORMAT,
    showdownFormatId: GEN_CUP_BATTLE_FORMAT,
    mechanics: 'gen9',
  };
}

function casual(generation: number): RulesetDefinition {
  return {
    id: `gen${generation}casual` as RulesetId,
    generation,
    kind: 'casual',
    introducedIn: generation,
    assetGenerationCap: generation,
    teamMode: 'preset-6-choose-3',
    registerTeamSize: 6,
    battleTeamSize: 3,
    battleFormat: GEN_CUP_BATTLE_FORMAT,
    showdownFormatId: GEN_CASUAL_BATTLE_FORMAT_ID,
    presetId: `gen${generation}-casual`,
    mechanics: 'gen9',
  };
}

const RULESETS: Record<RulesetId, RulesetDefinition> = {
  gen9ou: {
    id: 'gen9ou',
    generation: 9,
    kind: 'ou',
    teamMode: 'custom',
    registerTeamSize: 6,
    battleTeamSize: 6,
    battleFormat: GEN9_BATTLE_FORMAT,
    showdownFormatId: GEN9_BATTLE_FORMAT,
    mechanics: 'gen9',
  },
  ...Object.fromEntries(GENERATIONS.flatMap(generation => [
    [cup(generation).id, cup(generation)],
    [casual(generation).id, casual(generation)],
  ])),
} as Record<RulesetId, RulesetDefinition>;

export function isRulesetId(value: string): value is RulesetId {
  return Object.prototype.hasOwnProperty.call(RULESETS, value);
}

export function getRuleset(id?: string): RulesetDefinition {
  if (!id || id === 'gen9ou') return RULESETS.gen9ou;
  if (!isRulesetId(id)) throw new Error(`Unknown ruleset: ${id}`);
  return RULESETS[id];
}

export function listRulesets(): readonly RulesetDefinition[] {
  return RULESET_IDS.map(id => RULESETS[id]);
}

type SpeciesLike = {
  exists: boolean;
  num: number;
  name: string;
  gen: number;
  baseSpecies?: string;
  forme?: string;
  isNonstandard?: string | null;
  battleOnly?: string | string[] | boolean;
  tier?: string;
};

export function isGen9OuSpecies(species: SpeciesLike): boolean {
  if (!species.exists || species.num <= 0 || species.isNonstandard || species.battleOnly) return false;
  const tier = species.tier ?? '';
  return !OU_BANNED_TIERS.has(tier) && !/^CAP/i.test(tier);
}

/** Original introduction generation of the base species (formes inherit the base). */
export function speciesIntroducedGeneration(speciesName: string): number | null {
  const species = Dex.species.get(speciesName);
  if (!species?.exists || species.num <= 0) return null;
  const base = species.baseSpecies && species.baseSpecies !== species.name
    ? Dex.species.get(species.baseSpecies)
    : species;
  if (!base?.exists || base.num <= 0) return null;
  return base.gen;
}

function generationCupSpeciesOk(species: SpeciesLike): boolean {
  if (!species.exists || species.num <= 0 || species.battleOnly) return false;
  // SV cut flags (`Past`) must NOT exclude generation-cup species.
  const nonstd = species.isNonstandard;
  if (nonstd && nonstd !== 'Past') return false;
  const tier = species.tier ?? '';
  return !/^CAP/i.test(tier);
}

export function speciesAllowed(ruleset: RulesetDefinition, speciesName: string): boolean {
  const species = Dex.species.get(speciesName);
  if (!species?.exists) return false;
  if (ruleset.introducedIn == null) return isGen9OuSpecies(species);
  if (!generationCupSpeciesOk(species)) return false;
  const introduced = speciesIntroducedGeneration(speciesName);
  return introduced === ruleset.introducedIn;
}

/** Picker catalog: one row per base species (no Vivillon patterns, megas, etc.). */
export function speciesCatalogEntry(ruleset: RulesetDefinition, species: SpeciesLike): boolean {
  if (species.forme) return false;
  return speciesAllowed(ruleset, species.name);
}

export function moveWithinGeneration(moveName: string, ruleset: RulesetDefinition): boolean {
  if (ruleset.assetGenerationCap == null) return true;
  const move = Dex.moves.get(moveName);
  if (!move?.exists || move.isZ || move.isMax) return false;
  if (move.isNonstandard && move.isNonstandard !== 'Past') return false;
  return move.gen <= ruleset.assetGenerationCap;
}

export function itemWithinGeneration(itemName: string, ruleset: RulesetDefinition): boolean {
  if (!itemName.trim()) return true;
  if (ruleset.assetGenerationCap == null) return true;
  const item = Dex.items.get(itemName);
  if (!item?.exists) return false;
  if (item.isNonstandard && item.isNonstandard !== 'Past') return false;
  return item.gen <= ruleset.assetGenerationCap;
}

export function abilityWithinGeneration(
  speciesName: string,
  abilityName: string,
  ruleset: RulesetDefinition,
): boolean {
  const species = Dex.species.get(speciesName);
  const ability = Dex.abilities.get(abilityName);
  if (!species?.exists || !ability?.exists) return false;
  if (ability.isNonstandard && (ruleset.assetGenerationCap == null || ability.isNonstandard !== 'Past')) {
    return false;
  }
  const owned = Object.values(species.abilities)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  if (!owned.some(name => Dex.abilities.get(name).id === ability.id)) return false;
  if (ruleset.assetGenerationCap == null) return true;
  if (ability.gen <= ruleset.assetGenerationCap) return true;
  if (ruleset.assetGenerationCap >= ABILITY_ENGINE_FLOOR) return false;
  const earliest = Math.min(...owned.map(name => Dex.abilities.get(name).gen));
  return ability.gen === earliest;
}
