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
  moves: [string, string, string, string];
}

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

export interface TeamInspection {
  format: string;
  sets: InspectedSet[];
  problems: string[];
  packed?: string;
  evTotal: number;
  threats: { attack: string; worst: number; exposed: string[]; covers: string[] }[];
  speeds: { species: string; speed: number }[];
}

export interface SavedTeam {
  name: string;
  paste: string;
  species: string[];
  validated: boolean;
}

const EMPTY_EVS: Record<StatId, number> = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

export function emptySet(): EditorSet {
  return {
    species: '',
    item: '',
    ability: '',
    teraType: '',
    nature: 'Serious',
    evs: { ...EMPTY_EVS },
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
      return [
        set.item.trim() ? `${set.species.trim()} @ ${set.item.trim()}` : set.species.trim(),
        set.ability.trim() ? `Ability: ${set.ability.trim()}` : '',
        set.teraType ? `Tera Type: ${set.teraType}` : '',
        evs.length ? `EVs: ${evs.join(' / ')}` : '',
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
    moves: [set.moves[0] ?? '', set.moves[1] ?? '', set.moves[2] ?? '', set.moves[3] ?? ''] as [string, string, string, string],
  }));
  while (slots.length < 6) slots.push(emptySet());
  return slots;
}

export function teamStorageKey(playerId: string): string {
  return `pokearena.team.${playerId}`;
}

export function readSavedTeam(playerId: string): SavedTeam | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(teamStorageKey(playerId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SavedTeam;
    if (!value || typeof value.paste !== 'string' || typeof value.name !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

export function writeSavedTeam(playerId: string, team: SavedTeam): void {
  window.localStorage.setItem(teamStorageKey(playerId), JSON.stringify(team));
}

export function battlePaste(playerId: string): string | undefined {
  const saved = readSavedTeam(playerId);
  if (!saved?.validated || !saved.paste.trim()) return undefined;
  return saved.paste;
}
