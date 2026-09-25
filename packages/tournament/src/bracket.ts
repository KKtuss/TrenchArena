import type {
  TournamentId,
  TournamentMatch,
  TournamentMatchId,
  TournamentPlayerId,
} from './types';

export function buildSingleEliminationBracket(
  tournamentId: TournamentId,
  playerIds: readonly TournamentPlayerId[],
  seed: string,
  now: number,
  createMatchId: () => TournamentMatchId,
): TournamentMatch[] {
  const shuffled = deterministicOrder(playerIds, seed);
  const rounds = Math.log2(shuffled.length);
  const matches: TournamentMatch[] = [];

  for (let round = 1; round <= rounds; round += 1) {
    const matchCount = shuffled.length / (2 ** round);
    for (let bracketPosition = 0; bracketPosition < matchCount; bracketPosition += 1) {
      const player1 = round === 1 ? shuffled[bracketPosition * 2] : undefined;
      const player2 = round === 1 ? shuffled[bracketPosition * 2 + 1] : undefined;
      matches.push({
        id: createMatchId(),
        tournamentId,
        round,
        bracketPosition,
        ...(player1 ? { player1 } : {}),
        ...(player2 ? { player2 } : {}),
        status: round === 1 ? 'ready' : 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return matches;
}

function deterministicOrder(
  playerIds: readonly TournamentPlayerId[],
  seed: string,
): TournamentPlayerId[] {
  const output = [...playerIds];
  let state = hashSeed(seed);

  for (let index = output.length - 1; index > 0; index -= 1) {
    state = nextState(state);
    const swapIndex = state % (index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }

  return output;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextState(state: number): number {
  let next = state + 0x6D2B79F5;
  next = Math.imul(next ^ next >>> 15, next | 1);
  next ^= next + Math.imul(next ^ next >>> 7, next | 61);
  return (next ^ next >>> 14) >>> 0;
}
