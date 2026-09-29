export type StatId = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';

export const STATS: { id: StatId; label: string }[] = [
  { id: 'hp', label: 'HP' },
  { id: 'atk', label: 'Atk' },
  { id: 'def', label: 'Def' },
  { id: 'spa', label: 'SpA' },
  { id: 'spd', label: 'SpD' },
  { id: 'spe', label: 'Spe' },
];

export const NATURES = [
  'Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle',
  'Hardy', 'Hasty', 'Impish', 'Jolly', 'Lax', 'Lonely', 'Mild', 'Modest',
  'Naive', 'Naughty', 'Quiet', 'Quirky', 'Rash', 'Relaxed', 'Sassy', 'Serious', 'Timid',
];

const NATURE_BIAS: Record<string, { up: StatId; down: StatId } | null> = {
  Adamant: { up: 'atk', down: 'spa' },
  Bashful: null,
  Bold: { up: 'def', down: 'atk' },
  Brave: { up: 'atk', down: 'spe' },
  Calm: { up: 'spd', down: 'atk' },
  Careful: { up: 'spd', down: 'spa' },
  Docile: null,
  Gentle: { up: 'spd', down: 'def' },
  Hardy: null,
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
  Quirky: null,
  Rash: { up: 'spa', down: 'spd' },
  Relaxed: { up: 'def', down: 'spe' },
  Sassy: { up: 'spd', down: 'spe' },
  Serious: null,
  Timid: { up: 'spe', down: 'atk' },
};

const STAT_SHORT: Record<StatId, string> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spa: 'SpA',
  spd: 'SpD',
  spe: 'Spe',
};

export function natureLabel(nature: string): string {
  const bias = NATURE_BIAS[nature];
  if (!bias) return `${nature} (neutral)`;
  return `${nature} (+${STAT_SHORT[bias.up]} −${STAT_SHORT[bias.down]})`;
}

export const TERA_TYPES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison',
  'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
];

export interface EditorSet {
  species: string;
  item: string;
  ability: string;
  teraType: string;
  nature: string;
  evs: Record<StatId, number>;
  ivs: Record<StatId, number>;
  moves: [string, string, string, string];
}

export interface InspectedStat {
  stat: StatId;
  base: number;
  iv: number;
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
  description?: string;
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
  ivs: Record<StatId, number>;
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

export interface TeamInspection {
  format: string;
  sets: InspectedSet[];
  problems: string[];
  packed?: string;
  evTotal: number;
  threats: { attack: string; worst: number; exposed: string[]; covers: string[] }[];
  speeds: { species: string; speed: number }[];
  benchmarks?: { label: string; speed: number }[];
}

export interface SavedTeam {
  id: string;
  name: string;
  paste: string;
  species: string[];
  validated: boolean;
}

export interface SavedRoster {
  activeId: string;
  teams: SavedTeam[];
}

export interface SearchableTeamHit {
  name: string;
  description?: string;
  type?: string;
  types?: string[];
  category?: string;
}

export function filterSpeciesHits<T extends SearchableTeamHit>(
  hits: T[],
  query: string,
  type = '',
): T[] {
  const needle = query.trim().toLowerCase();
  return hits.filter(hit => (
    (!type || (hit.types ?? []).includes(type))
    && (!needle || hit.name.toLowerCase().includes(needle))
  ));
}

export function filterItemHits<T extends SearchableTeamHit>(hits: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return hits.filter(hit => (
    !needle
    || hit.name.toLowerCase().includes(needle)
    || (hit.description ?? '').toLowerCase().includes(needle)
  ));
}

const DRAFT_MOVE_NAG = /has no moves \(it must have at least one to be usable\)/i;

export function visibleTeamProblems(problems: readonly string[]): string[] {
  return problems.filter(problem => !DRAFT_MOVE_NAG.test(problem));
}

export function filterMoveHits<T extends SearchableTeamHit>(
  hits: T[],
  query: string,
  type = '',
  category = '',
): T[] {
  const needle = query.trim().toLowerCase();
  return hits.filter(hit => (
    (!type || hit.type === type)
    && (!category || hit.category === category)
    && (!needle || (
      hit.name.toLowerCase().includes(needle)
      || (hit.type ?? '').toLowerCase().includes(needle)
      || (hit.description ?? '').toLowerCase().includes(needle)
    ))
  ));
}

export type MoveSort = 'name' | 'power' | 'accuracy' | 'type';

function moveAccuracyRank(hit: SearchableTeamHit): number {
  return hit.accuracy == null ? 101 : hit.accuracy;
}

export function sortMoveHits<T extends SearchableTeamHit>(hits: T[], sort: MoveSort): T[] {
  return [...hits].sort((left, right) => {
    if (sort === 'power') {
      return (right.power ?? -1) - (left.power ?? -1) || left.name.localeCompare(right.name);
    }
    if (sort === 'accuracy') {
      return moveAccuracyRank(right) - moveAccuracyRank(left) || left.name.localeCompare(right.name);
    }
    if (sort === 'type') {
      return (left.type ?? '').localeCompare(right.type ?? '') || left.name.localeCompare(right.name);
    }
    return left.name.localeCompare(right.name);
  });
}

const EMPTY_EVS: Record<StatId, number> = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const FULL_IVS: Record<StatId, number> = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

export function emptySet(): EditorSet {
  return {
    species: '',
    item: '',
    ability: '',
    teraType: '',
    nature: 'Serious',
    evs: { ...EMPTY_EVS },
    ivs: { ...FULL_IVS },
    moves: ['', '', '', ''],
  };
}

export function setsToPaste(sets: EditorSet[]): string {
  return sets
    .filter(set => set.species.trim())
    .map(set => {
      const evs = STATS
        .filter(stat => set.evs[stat.id] > 0)
        .map(stat => `${set.evs[stat.id]} ${stat.label}`);
      const ivs = STATS
        .filter(stat => set.ivs[stat.id] !== 31)
        .map(stat => `${set.ivs[stat.id]} ${stat.label}`);
      return [
        set.item.trim() ? `${set.species.trim()} @ ${set.item.trim()}` : set.species.trim(),
        set.ability.trim() ? `Ability: ${set.ability.trim()}` : '',
        set.teraType ? `Tera Type: ${set.teraType}` : '',
        evs.length ? `EVs: ${evs.join(' / ')}` : '',
        ivs.length ? `IVs: ${ivs.join(' / ')}` : '',
        set.nature ? `${set.nature} Nature` : '',
        ...set.moves.map(move => move.trim()).filter(Boolean).map(move => `- ${move}`),
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

export function setsFromInspection(inspection: TeamInspection): EditorSet[] {
  const slots = inspection.sets.slice(0, 6).map(set => ({
    species: set.species,
    item: set.item,
    ability: set.ability,
    teraType: set.teraType,
    nature: NATURES.includes(set.nature) ? set.nature : 'Serious',
    evs: { ...EMPTY_EVS, ...set.evs },
    ivs: { ...FULL_IVS, ...set.ivs },
    moves: [set.moves[0] ?? '', set.moves[1] ?? '', set.moves[2] ?? '', set.moves[3] ?? ''] as [string, string, string, string],
  }));
  while (slots.length < 6) slots.push(emptySet());
  return slots;
}

export function teamStorageKey(playerId: string): string {
  return `pokearena.team.${playerId}`;
}

function newTeamId(): string {
  return `team-${Date.now().toString(36)}`;
}

function asTeam(value: Partial<SavedTeam> | null | undefined, fallbackId: string): SavedTeam | null {
  if (!value || typeof value.paste !== 'string' || typeof value.name !== 'string') return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : fallbackId,
    name: value.name,
    paste: value.paste,
    species: Array.isArray(value.species) ? value.species.filter(item => typeof item === 'string') : [],
    validated: Boolean(value.validated),
  };
}

export function readRoster(playerId: string): SavedRoster {
  if (typeof window === 'undefined') return { activeId: '', teams: [] };
  const raw = window.localStorage.getItem(teamStorageKey(playerId));
  if (!raw) return { activeId: '', teams: [] };
  try {
    const value = JSON.parse(raw) as Partial<SavedRoster> & Partial<SavedTeam>;
    if (value && Array.isArray(value.teams)) {
      const teams = value.teams
        .map((team, index) => asTeam(team, `team-${index + 1}`))
        .filter((team): team is SavedTeam => team !== null);
      const activeId = teams.some(team => team.id === value.activeId) ? value.activeId! : (teams[0]?.id ?? '');
      return { activeId, teams };
    }
    const legacy = asTeam(value, 'legacy');
    return legacy ? { activeId: legacy.id, teams: [legacy] } : { activeId: '', teams: [] };
  } catch {
    return { activeId: '', teams: [] };
  }
}

export function writeRoster(playerId: string, roster: SavedRoster): void {
  window.localStorage.setItem(teamStorageKey(playerId), JSON.stringify(roster));
}

export function readSavedTeam(playerId: string): SavedTeam | null {
  const roster = readRoster(playerId);
  if (!roster.teams.length) return null;
  return roster.teams.find(team => team.id === roster.activeId) ?? roster.teams[0];
}

export function writeSavedTeam(playerId: string, team: SavedTeam): void {
  const roster = readRoster(playerId);
  const teams = roster.teams.some(item => item.id === team.id)
    ? roster.teams.map(item => item.id === team.id ? team : item)
    : [...roster.teams, team];
  writeRoster(playerId, { activeId: team.id, teams });
}

export function activateTeam(playerId: string, id: string): void {
  const roster = readRoster(playerId);
  if (!roster.teams.some(team => team.id === id)) return;
  writeRoster(playerId, { ...roster, activeId: id });
}

export function addBlankTeam(playerId: string): SavedTeam {
  const team: SavedTeam = {
    id: newTeamId(),
    name: 'New team',
    paste: '',
    species: [],
    validated: false,
  };
  const roster = readRoster(playerId);
  writeRoster(playerId, { activeId: team.id, teams: [...roster.teams, team] });
  return team;
}

export function clearSavedTeam(playerId: string): void {
  const current = readSavedTeam(playerId);
  if (!current) return;
  writeSavedTeam(playerId, {
    ...current,
    name: 'New team',
    paste: '',
    species: [],
    validated: false,
  });
}

export function battlePaste(playerId: string): string | undefined {
  const saved = readSavedTeam(playerId);
  if (!saved?.validated || !saved.paste.trim()) return undefined;
  return saved.paste;
}
