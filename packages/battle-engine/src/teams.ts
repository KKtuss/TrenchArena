import { Dex, TeamValidator, Teams } from 'pokemon-showdown';

import {
  SUPPORTED_FORMATS,
  type SupportedFormat,
} from './types';
import { TeamValidationError, UnsupportedFormatError } from './errors';

export const SHOWDOWN_VERSION = '0.11.11';
export const SHOWDOWN_GIT_HEAD = '739a5e1fee432ad80ff7136d70cca993be358b59';
export const DEFAULT_SEED = '1,2,3,4';

const FORMAT_RULES: Record<SupportedFormat, readonly string[]> = {
  gen9ou: [],
};

export function assertSupportedFormat(format: string): asserts format is SupportedFormat {
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(format)) {
    throw new UnsupportedFormatError(format);
  }
}

export function formatRules(format: SupportedFormat): readonly string[] {
  return FORMAT_RULES[format];
}

export function teamSpeciesList(teamText: string): string[] {
  const team = Teams.import(teamText);
  if (!team?.length) return [];
  return team
    .slice(0, 6)
    .map(set => (typeof set.species === 'string' ? set.species.trim() : ''))
    .filter(Boolean);
}

export function validateAndPackTeam(
  teamText: string,
  format: SupportedFormat,
): string {
  const team = Teams.import(teamText);
  if (!team || team.length !== 6) {
    throw new TeamValidationError(
      `A ${format} team must contain exactly six valid Pokémon sets.`,
    );
  }

  const problems = new TeamValidator(format).validateTeam(team);
  if (problems?.length) {
    throw new TeamValidationError(
      `Team is invalid for ${format}:\n- ${problems.join('\n- ')}`,
    );
  }

  return Teams.pack(team);
}

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
type StatId = (typeof STATS)[number];

const NATURES: Record<string, { up?: StatId; down?: StatId }> = {
  Adamant: { up: 'atk', down: 'spa' },
  Bashful: {},
  Bold: { up: 'def', down: 'atk' },
  Brave: { up: 'atk', down: 'spe' },
  Calm: { up: 'spd', down: 'atk' },
  Careful: { up: 'spd', down: 'spa' },
  Docile: {},
  Gentle: { up: 'spd', down: 'def' },
  Hardy: {},
  Hasty: { up: 'spe', down: 'def' },
  Impish: { up: 'def', down: 'spa' },
  Jolly: { up: 'spe', down: 'spa' },
  Lax: { up: 'def', down: 'spd' },
  Lonely: { up: 'atk', down: 'def' },
  Mild: { up: 'spa', down: 'def' },
  Modest: { up: 'spa', down: 'atk' },
  Naive: { up: 'spe', down: 'spd' },
  Naughty: { up: 'atk', down: 'spd' },
  Quiet: { up: 'spa', down: 'spe' },
  Quirky: {},
  Rash: { up: 'spa', down: 'spd' },
  Relaxed: { up: 'def', down: 'spe' },
  Sassy: { up: 'spd', down: 'spe' },
  Serious: {},
  Timid: { up: 'spe', down: 'atk' },
};

const ATTACK_TYPES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison',
  'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
] as const;

export interface InspectedStat {
  stat: StatId;
  base: number;
  ev: number;
  value: number;
  nature: 'up' | 'down' | 'neutral';
}

export interface InspectedMove {
  name: string;
  type: string;
  category: string;
  basePower: number;
  accuracy: number | null;
  pp: number;
}

export interface InspectedSet {
  species: string;
  item: string;
  ability: string;
  nature: string;
  teraType: string;
  level: number;
  moves: string[];
  evs: Record<StatId, number>;
  types: string[];
  dexNum: number | null;
  heightM: number | null;
  weightKg: number | null;
  abilities: string[];
  stats: InspectedStat[];
  moveDetails: InspectedMove[];
  physicalBulk: number | null;
  specialBulk: number | null;
  exists: boolean;
}

export interface TeamThreat {
  attack: string;
  worst: number;
  exposed: string[];
  covers: string[];
}

export interface TeamSpeed {
  species: string;
  speed: number;
}

export interface TeamInspection {
  format: SupportedFormat;
  sets: InspectedSet[];
  problems: string[];
  packed?: string;
  evTotal: number;
  threats: TeamThreat[];
  speeds: TeamSpeed[];
}

export type TeamSearchKind = 'species' | 'move' | 'item' | 'ability';

type ImportedSet = {
  species: string;
  item?: string;
  ability?: string;
  nature?: string;
  teraType?: string;
  level?: number;
  moves?: string[];
  evs?: Partial<Record<StatId, number>>;
  ivs?: Partial<Record<StatId, number>>;
};

export function inspectTeam(teamText: string, format: SupportedFormat): TeamInspection {
  assertSupportedFormat(format);
  const imported = Teams.import(teamText) as ImportedSet[] | null;
  const sets = (imported ?? []).slice(0, 6).map(inspectSet);
  const problems = collectProblems(imported, format);
  let packed: string | undefined;
  try {
    packed = validateAndPackTeam(teamText, format);
  } catch {
    packed = undefined;
  }
  const realSets = sets.filter(set => set.exists);
  return {
    format,
    sets,
    problems,
    ...(packed ? { packed } : {}),
    evTotal: sets.reduce((sum, set) => sum + Object.values(set.evs).reduce((evSum, ev) => evSum + ev, 0), 0),
    threats: realSets.length ? teamThreats(realSets) : [],
    speeds: realSets
      .map(set => ({
        species: set.species,
        speed: set.stats.find(stat => stat.stat === 'spe')?.value ?? 0,
      }))
      .sort((a, b) => b.speed - a.speed),
  };
}

export function searchTeamOptions(
  kind: TeamSearchKind,
  query: string,
  speciesName?: string,
): string[] {
  const needle = query.trim().toLowerCase();
  if (kind === 'ability' && speciesName) {
    const species = Dex.species.get(speciesName);
    const abilities = species?.exists
      ? Object.values(species.abilities).filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [];
    return (needle ? abilities.filter(name => name.toLowerCase().includes(needle)) : abilities).slice(0, 8);
  }
  if (!needle) return [];
  if (kind === 'species') {
    return Dex.species.all()
      .filter(species => (
        species.exists
        && species.num > 0
        && !species.isNonstandard
        && species.name.toLowerCase().includes(needle)
      ))
      .slice(0, 8)
      .map(species => species.name);
  }
  if (kind === 'move') {
    return Dex.moves.all()
      .filter(move => (
        move.exists
        && !move.isNonstandard
        && !move.isZ
        && !move.isMax
        && move.name.toLowerCase().includes(needle)
      ))
      .slice(0, 8)
      .map(move => move.name);
  }
  if (kind === 'item') {
    return Dex.items.all()
      .filter(item => item.exists && !item.isNonstandard && item.name.toLowerCase().includes(needle))
      .slice(0, 8)
      .map(item => item.name);
  }
  return Dex.abilities.all()
    .filter(ability => ability.exists && !ability.isNonstandard && ability.name.toLowerCase().includes(needle))
    .slice(0, 8)
    .map(ability => ability.name);
}

function inspectSet(set: ImportedSet): InspectedSet {
  const species = Dex.species.get(set.species);
  const exists = Boolean(species?.exists);
  const evs = emptyEvs();
  for (const stat of STATS) evs[stat] = clampEv(set.evs?.[stat] ?? 0);
  const natureName = set.nature && NATURES[set.nature] ? set.nature : 'Serious';
  const nature = NATURES[natureName] ?? {};
  const level = set.level || 100;
  const stats: InspectedStat[] = exists
    ? STATS.map(stat => {
      const iv = set.ivs?.[stat] ?? 31;
      const natureTone = nature.up === stat ? 'up' : nature.down === stat ? 'down' : 'neutral';
      const multiplier = natureTone === 'up' ? 1.1 : natureTone === 'down' ? 0.9 : 1;
      return {
        stat,
        base: species.baseStats[stat],
        ev: evs[stat],
        value: calcStat(stat, species.baseStats[stat], iv, evs[stat], level, multiplier),
        nature: natureTone,
      };
    })
    : [];
  const hp = stats.find(stat => stat.stat === 'hp')?.value ?? 0;
  const def = stats.find(stat => stat.stat === 'def')?.value ?? 0;
  const spd = stats.find(stat => stat.stat === 'spd')?.value ?? 0;
  const moves = (set.moves ?? []).slice(0, 4);
  return {
    species: exists ? species.name : set.species,
    item: set.item ?? '',
    ability: set.ability ?? '',
    nature: natureName,
    teraType: set.teraType ?? '',
    level,
    moves,
    evs,
    types: exists ? [...species.types] : [],
    dexNum: exists ? species.num : null,
    heightM: exists ? species.heightm : null,
    weightKg: exists ? species.weightkg : null,
    abilities: exists
      ? Object.values(species.abilities).filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [],
    stats,
    moveDetails: moves.map(inspectMove).filter((move): move is InspectedMove => move !== null),
    physicalBulk: exists ? hp * def : null,
    specialBulk: exists ? hp * spd : null,
    exists,
  };
}

function inspectMove(name: string): InspectedMove | null {
  const move = Dex.moves.get(name);
  if (!move?.exists) return { name, type: '', category: '', basePower: 0, accuracy: null, pp: 0 };
  return {
    name: move.name,
    type: move.type,
    category: move.category,
    basePower: move.basePower,
    accuracy: move.accuracy === true ? null : move.accuracy,
    pp: move.pp,
  };
}

function collectProblems(imported: ImportedSet[] | null, format: SupportedFormat): string[] {
  if (!imported?.length) return ['Paste at least one Pokémon set.'];
  let problems: string[] = [];
  try {
    problems = new TeamValidator(format).validateTeam(imported as never) ?? [];
  } catch (error) {
    problems = [error instanceof Error ? error.message : 'Team could not be validated.'];
  }
  if (imported.length !== 6) {
    return [`A ${format} team must contain exactly six valid Pokémon sets.`, ...problems];
  }
  return problems;
}

function teamThreats(sets: InspectedSet[]): TeamThreat[] {
  const threats: TeamThreat[] = [];
  for (const attack of ATTACK_TYPES) {
    const ratings = sets.map(set => ({
      species: set.species,
      multiplier: effectiveness(attack, set.types),
    }));
    const worst = Math.max(...ratings.map(rating => rating.multiplier));
    if (worst < 2) continue;
    threats.push({
      attack,
      worst,
      exposed: ratings.filter(rating => rating.multiplier >= 2).map(rating => rating.species),
      covers: ratings.filter(rating => rating.multiplier <= 0.5).map(rating => rating.species),
    });
  }
  return threats.sort((a, b) => b.worst - a.worst).slice(0, 6);
}

function effectiveness(attack: string, defenderTypes: readonly string[]): number {
  let modifier = 1;
  for (const defending of defenderTypes) {
    const taken = Dex.types.get(defending).damageTaken[attack];
    if (taken === 1) modifier *= 2;
    else if (taken === 2) modifier *= 0.5;
    else if (taken === 3) return 0;
  }
  return modifier;
}

function calcStat(stat: StatId, base: number, iv: number, ev: number, level: number, nature: number): number {
  if (stat === 'hp') {
    if (base === 1) return 1;
    return Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + level + 10;
  }
  const raw = Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5;
  return Math.floor(raw * nature);
}

function emptyEvs(): Record<StatId, number> {
  return { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
}

function clampEv(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(252, Math.floor(value)));
}
