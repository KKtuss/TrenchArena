/**
 * Development playtest log for Casual 6→3. Records the dealt presets, the
 * locked trios, and how the battle ended. It does not change teams or rules.
 */

export const PLAYTEST_REASONS = [
  'type advantage',
  'speed',
  'defensive answer',
  'offensive pressure',
  'ability',
  'item',
  'familiar Pokémon',
  'guessed opponent choice',
  'other',
] as const;

export type PlaytestReason = (typeof PLAYTEST_REASONS)[number];
export type PlaytestEndReason = 'normal' | 'timeout' | 'forfeit';

export interface PlaytestSide {
  playerId: string;
  presetId: string;
  presetName: string;
  /** Final slot order. This is the order the player clicked. */
  slots: number[];
  species: string[];
  confirmed: boolean;
  /**
   * True when the locked trio is the first three they assembled and they
   * did not unlock or replace it afterward.
   */
  confirmedWithoutChange: boolean;
  /** Milliseconds from the sixes being shown to the final lock. */
  previewToLockMs?: number;
  reasons: PlaytestReason[];
}

export interface PlaytestMatch {
  roomId: string;
  status: 'selecting' | 'battling' | 'completed';
  playerA: PlaytestSide;
  playerB: PlaytestSide;
  winnerId?: string;
  loserId?: string;
  result?: 'win' | 'tie';
  endReason?: PlaytestEndReason;
  durationMs?: number;
  turns?: number;
}

const PRESET_ALIASES: Record<string, string> = {
  classic: 'classic-balance',
  'classic-balance': 'classic-balance',
  kanto: 'kanto-johto-classics',
  'kanto-johto-classics': 'kanto-johto-classics',
  modern: 'modern-classics',
  'modern-classics': 'modern-classics',
  rival: 'rivals-team',
  rivals: 'rivals-team',
  'rivals-team': 'rivals-team',
};

const REASON_ALIASES: Record<string, PlaytestReason> = {
  type: 'type advantage',
  'type advantage': 'type advantage',
  speed: 'speed',
  defense: 'defensive answer',
  defensive: 'defensive answer',
  'defensive answer': 'defensive answer',
  offense: 'offensive pressure',
  offensive: 'offensive pressure',
  'offensive pressure': 'offensive pressure',
  ability: 'ability',
  item: 'item',
  familiar: 'familiar Pokémon',
  'familiar pokemon': 'familiar Pokémon',
  'familiar pokémon': 'familiar Pokémon',
  guess: 'guessed opponent choice',
  guessed: 'guessed opponent choice',
  'guessed opponent choice': 'guessed opponent choice',
  other: 'other',
};

export function resolvePlaytestPresetId(value: string): string {
  const presetId = PRESET_ALIASES[value.trim().toLowerCase()];
  if (!presetId) {
    throw new Error('Preset must be classic, kanto, modern, or rival.');
  }
  return presetId;
}

export function parsePlaytestReasons(value: string): PlaytestReason[] {
  const parts = value.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new Error('At least one playtest reason is required.');
  const reasons: PlaytestReason[] = [];
  for (const part of parts) {
    const reason = REASON_ALIASES[part];
    if (!reason) {
      throw new Error(
        `Unknown playtest reason "${part}". Use type, speed, defense, offense, ability, item, familiar, guess, or other.`,
      );
    }
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

export function formatPlaytestMatch(match: PlaytestMatch): string {
  const pending = match.status !== 'completed';
  const lines = [
    `MATCHUP ${match.playerA.presetId} vs ${match.playerB.presetId}`,
    `PLAYER A PRESET ${match.playerA.presetName}`,
    `PLAYER B PRESET ${match.playerB.presetName}`,
    `PLAYER A TRIO ${formatTrio(match.playerA)}`,
    `PLAYER B TRIO ${formatTrio(match.playerB)}`,
    `WINNER ${match.winnerId ?? (pending ? 'pending' : 'none')}`,
    `LOSER ${match.loserId ?? (pending ? 'pending' : 'none')}`,
    `END REASON ${match.endReason ?? 'pending'}${match.result === 'tie' ? ' (tie)' : ''}`,
    `DURATION ${match.durationMs === undefined ? 'pending' : `${match.durationMs}ms`}`,
    `PLAYER A LOCK ${match.playerA.confirmedWithoutChange ? 'unchanged' : 'revised'}`,
    `PLAYER B LOCK ${match.playerB.confirmedWithoutChange ? 'unchanged' : 'revised'}`,
  ];
  if (match.playerA.previewToLockMs !== undefined) {
    lines.push(`PLAYER A PREVIEW_TO_LOCK ${match.playerA.previewToLockMs}ms`);
  }
  if (match.playerB.previewToLockMs !== undefined) {
    lines.push(`PLAYER B PREVIEW_TO_LOCK ${match.playerB.previewToLockMs}ms`);
  }
  if (match.playerA.reasons.length) lines.push(`PLAYER A REASONS ${match.playerA.reasons.join(', ')}`);
  if (match.playerB.reasons.length) lines.push(`PLAYER B REASONS ${match.playerB.reasons.join(', ')}`);
  if (match.turns !== undefined) lines.push(`TURNS ${match.turns}`);
  return lines.join('\n');
}

export function emptyPlaytestSide(playerId: string, presetId: string, presetName: string): PlaytestSide {
  return {
    playerId,
    presetId,
    presetName,
    slots: [],
    species: [],
    confirmed: false,
    confirmedWithoutChange: false,
    reasons: [],
  };
}

export function clonePlaytestMatch(match: PlaytestMatch): PlaytestMatch {
  return {
    ...match,
    playerA: { ...match.playerA, slots: [...match.playerA.slots], species: [...match.playerA.species], reasons: [...match.playerA.reasons] },
    playerB: { ...match.playerB, slots: [...match.playerB.slots], species: [...match.playerB.species], reasons: [...match.playerB.reasons] },
  };
}

export function formatPlaytestLog(matches: readonly PlaytestMatch[]): string {
  if (!matches.length) return 'No Casual playtest matches yet.';
  return matches.map(formatPlaytestMatch).join('\n\n');
}

function formatTrio(side: PlaytestSide): string {
  if (!side.species.length) return side.confirmed ? 'none' : 'unlocked';
  return side.species.join(', ');
}
