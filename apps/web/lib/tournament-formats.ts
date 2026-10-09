import { tournamentRotationEvent } from '@pokearena/tournament/rotation';

export type FormatAccent = 'cup' | 'casual' | 'ou';
export type FormatTeamMode = 'custom' | 'preset-6-choose-3';

export interface FormatPresentation {
  id: string;
  title: string;
  region: string;
  restriction: string;
  teamMode: FormatTeamMode;
  teamModeLabel: string;
  generation: number;
  trainer: string;
  pokemon: readonly string[];
  accent: FormatAccent;
  /** Scenery behind the format's sprite stage. */
  backdrop: string;
}

const REGIONS = ['KANTO', 'JOHTO', 'HOENN', 'SINNOH', 'UNOVA', 'KALOS', 'ALOLA', 'GALAR', 'PALDEA'] as const;
const TRAINERS = ['red-gen1', 'ethan', 'brendan-gen3', 'lucas', 'hilbert', 'calem', 'elio', 'victor', 'penny'] as const;

function regionBackdrop(index: number): string {
  return `/stages/${REGIONS[index]!.toLowerCase()}.webp`;
}

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

/** Four of the shared Casual six. The full six is the preset, not this crop. */
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

function cup(generation: number): FormatPresentation {
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
    backdrop: regionBackdrop(index),
  };
}

function casual(generation: number): FormatPresentation {
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
    backdrop: regionBackdrop(index),
  };
}

const GEN9_OU: FormatPresentation = {
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
  backdrop: '/stages/gen9ou.webp',
};

const BY_ID = new Map<string, FormatPresentation>();
for (let generation = 1; generation <= 9; generation += 1) {
  const cupFormat = cup(generation);
  const casualFormat = casual(generation);
  BY_ID.set(cupFormat.id, cupFormat);
  BY_ID.set(casualFormat.id, casualFormat);
}
BY_ID.set(GEN9_OU.id, GEN9_OU);

export function formatById(id?: string): FormatPresentation | undefined {
  if (!id) return undefined;
  return BY_ID.get(id);
}

export function formatLabel(id?: string): string {
  return formatById(id)?.title ?? (id === 'gen9ou' || !id ? 'Gen 9 OU' : id.toUpperCase());
}

/** Casual Gen X, then that generation's cup, then Gen 9 OU. Repeats through Gen 9. */
export function rotationEvent(slotIndex: number): FormatPresentation {
  return formatById(tournamentRotationEvent(slotIndex).id) ?? GEN9_OU;
}

/** Custom formats a player can prepare ahead of time. Casual is not in this list. */
export function customFormats(): FormatPresentation[] {
  const formats: FormatPresentation[] = [];
  for (let generation = 1; generation <= 9; generation += 1) {
    formats.push(cup(generation));
  }
  formats.push(GEN9_OU);
  return formats;
}

/** Short legality line shown under the Team Builder format selector. */
export function formatBuilderBlurb(id?: string): string {
  const format = formatById(id);
  if (!format) return 'Choose a tournament format before picking Pokémon.';
  if (format.id === 'gen9ou') return 'Gen 9 OU legal Pokémon · SV OU bans apply';
  if (format.teamMode === 'preset-6-choose-3') {
    return `Shared ${format.generation} preset · no custom team required in Casual`;
  }
  return `Gen ${format.generation}-introduced species only · custom competitive team`;
}
