const TRAINER_NAMES: Record<string, string> = {
  'demo-player-1': 'Aria Vale',
  'demo-player-2': 'Kai Ren',
};

export function trainerName(id?: string | null): string {
  if (!id) return '';
  return TRAINER_NAMES[id] ?? id;
}

/** Showdown protocol lines carry internal ids. Present trainer names in the battle client. */
export function presentShowdownLine(line: string): string {
  return line
    .replaceAll('demo-player-1', TRAINER_NAMES['demo-player-1'])
    .replaceAll('demo-player-2', TRAINER_NAMES['demo-player-2']);
}
