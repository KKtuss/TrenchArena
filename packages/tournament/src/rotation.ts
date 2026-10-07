export type RotationAccent = 'cup' | 'casual' | 'ou';
export type RotationTeamMode = 'custom' | 'preset-6-choose-3';

export interface TournamentRotationDefinition {
  id: string;
  title: string;
  region: string;
  restriction: string;
  teamMode: RotationTeamMode;
  teamModeLabel: string;
  generation: number;
  trainer: string;
  pokemon: readonly string[];
  accent: RotationAccent;
  maxPlayers: 16 | 32;
}

const REGIONS = ['KANTO', 'JOHTO', 'HOENN', 'SINNOH', 'UNOVA', 'KALOS', 'ALOLA', 'GALAR', 'PALDEA'] as const;
const TRAINERS = ['red-gen1', 'ethan', 'brendan-gen3', 'lucas', 'hilbert', 'calem', 'elio', 'victor', 'penny'] as const;
const CUP_POKEMON: readonly (readonly string[])[] = [
  ['Charizard', 'Venusaur', 'Blastoise', 'Pikachu'],
  ['Typhlosion', 'Ampharos', 'Scizor', 'Umbreon'],
  ['Blaziken', 'Swampert', 'Sceptile', 'Gardevoir'],
  ['Infernape', 'Lucario', 'Garchomp', 'Staraptor'],
  ['Excadrill', 'Chandelure', 'Krookodile', 'Lilligant'],
  ['Greninja', 'Sylveon', 'Talonflame', 'Delphox'],
  ['Incineroar', 'Decidueye', 'Mimikyu', 'Primarina'],
  ['Corviknight', 'Rillaboom', 'Cinderace', 'Dragapult'],
  ['Meowscarada', 'Skeledirge', 'Quaquaval', 'Tinkaton'],
];
const CASUAL_POKEMON: readonly (readonly string[])[] = [
  ['Venusaur', 'Charizard', 'Blastoise', 'Hypno'],
  ['Typhlosion', 'Feraligatr', 'Meganium', 'Scizor'],
  ['Sceptile', 'Blaziken', 'Swampert', 'Gardevoir'],
  ['Infernape', 'Empoleon', 'Lucario', 'Leafeon'],
  ['Excadrill', 'Chandelure', 'Conkeldurr', 'Alomomola'],
  ['Delphox', 'Chesnaught', 'Clawitzer', 'Hawlucha'],
  ['Decidueye', 'Primarina', 'Mimikyu', 'Toxapex'],
  ['Rillaboom', 'Cinderace', 'Corviknight', 'Toxtricity'],
  ['Meowscarada', 'Skeledirge', 'Quaquaval', 'Tinkaton'],
];
const SCHEDULE_SLOT_COUNT = 27;

function cup(generation: number): TournamentRotationDefinition {
  const index = generation - 1;
  return {
    id: `gen${generation}cup`,
    title: `GEN ${generation} CUP`,
    region: REGIONS[index]!,
    restriction: `GEN ${generation} ONLY`,
    teamMode: 'custom',
    teamModeLabel: 'CUSTOM TEAM',
    generation,
    trainer: TRAINERS[index]!,
    pokemon: CUP_POKEMON[index]!,
    accent: 'cup',
    maxPlayers: generation === 1 ? 16 : 32,
  };
}

function casual(generation: number): TournamentRotationDefinition {
  const index = generation - 1;
  return {
    id: `gen${generation}casual`,
    title: `GEN ${generation} CASUAL`,
    region: REGIONS[index]!,
    restriction: 'SAME 6 FOR BOTH',
    teamMode: 'preset-6-choose-3',
    teamModeLabel: '6→3 PRESET',
    generation,
    trainer: TRAINERS[index]!,
    pokemon: CASUAL_POKEMON[index]!,
    accent: 'casual',
    maxPlayers: generation === 1 ? 16 : 32,
  };
}

const GEN9_OU: TournamentRotationDefinition = {
  id: 'gen9ou',
  title: 'GEN 9 OU',
  region: 'SV OU',
  restriction: 'OU LEGAL',
  teamMode: 'custom',
  teamModeLabel: 'CUSTOM TEAM',
  generation: 9,
  trainer: 'penny',
  pokemon: ['Great Tusk', 'Kingambit', 'Gholdengo', 'Dragapult'],
  accent: 'ou',
  maxPlayers: 16,
};

export function tournamentRotationEvent(slotIndex: number): TournamentRotationDefinition {
  const position = ((slotIndex % SCHEDULE_SLOT_COUNT) + SCHEDULE_SLOT_COUNT) % SCHEDULE_SLOT_COUNT;
  const generation = Math.floor(position / 3) + 1;
  const phase = position % 3;
  if (phase === 0) return casual(generation);
  if (phase === 1) return cup(generation);
  return { ...GEN9_OU, maxPlayers: position === 2 ? 16 : 32 };
}

export function tournamentRotationCapacity(slotIndex: number): 16 | 32 {
  return tournamentRotationEvent(slotIndex).maxPlayers;
}
