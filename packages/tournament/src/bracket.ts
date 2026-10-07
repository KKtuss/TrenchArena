import type {
  TournamentId,
  TournamentMatch,
  TournamentMatchId,
  TournamentPlayerId,
} from './types';

export interface BracketOutcomeMatch {
  round: number;
  bracketPosition: number;
  status: string;
  winner?: string;
}

/**
 * Locked-match view of whether 1st, 2nd, and 3rd are known. A tie is not a 3rd place.
 * `winner` here is the championship match winner. It becomes `tournament.winner`
 * only when `completed` is true.
 */
export function authoritativeTournamentOutcome(
  matches: readonly BracketOutcomeMatch[],
): { winner?: string; completed: boolean; hasThirdPlace: boolean; thirdDecided: boolean } {
  if (matches.length === 0) {
    return { completed: false, hasThirdPlace: false, thirdDecided: false };
  }
  const finalRound = Math.max(...matches.map(match => match.round));
  const finalMatch = matches.find(match => match.round === finalRound && match.bracketPosition === 0);
  const third = matches.find(match => match.round === finalRound && match.bracketPosition === 1);
  const decided = (match: BracketOutcomeMatch | undefined): boolean => Boolean(
    match?.winner && (match.status === 'completed' || match.status === 'forfeited'),
  );
  const hasThirdPlace = Boolean(third);
  if (!finalMatch || !decided(finalMatch)) {
    return { completed: false, hasThirdPlace, thirdDecided: Boolean(third && decided(third)) };
  }
  if (hasThirdPlace && !decided(third)) {
    return { winner: finalMatch.winner, completed: false, hasThirdPlace: true, thirdDecided: false };
  }
  return {
    winner: finalMatch.winner,
    completed: true,
    hasThirdPlace,
    thirdDecided: !hasThirdPlace || decided(third),
  };
}

export function nextTournamentAfterMatchCommit<T extends {
  status: string;
  winner?: string;
  completedAt?: number;
  updatedAt: number;
}>(tournament: T, matches: readonly BracketOutcomeMatch[], now: number): T | undefined {
  if (tournament.status !== 'in-progress' && tournament.status !== 'completed') return undefined;
  const outcome = authoritativeTournamentOutcome(matches);
  if (outcome.completed && outcome.winner) {
    if (
      tournament.status === 'completed'
      && tournament.winner === outcome.winner
      && tournament.completedAt !== undefined
    ) {
      return undefined;
    }
    return {
      ...tournament,
      status: 'completed',
      winner: outcome.winner,
      completedAt: tournament.completedAt ?? now,
      updatedAt: now,
    };
  }
  if (tournament.status !== 'in-progress' || tournament.winner !== undefined || tournament.completedAt !== undefined) {
    const next: T = { ...tournament, status: 'in-progress', updatedAt: now };
    delete next.completedAt;
    delete next.winner;
    return next;
  }
  return undefined;
}

export function isThirdPlaceMatch(
  match: Pick<TournamentMatch, 'round' | 'bracketPosition' | 'role'>,
  matches: readonly Pick<TournamentMatch, 'round' | 'bracketPosition'>[],
): boolean {
  if (match.role === 'third-place') return true;
  const finalRound = matches.reduce((max, item) => Math.max(max, item.round), 0);
  return match.round === finalRound
    && match.bracketPosition === 1
    && matches.some(item => item.round === finalRound && item.bracketPosition === 0);
}

export function buildSingleEliminationBracket(
  tournamentId: TournamentId,
  playerIds: readonly TournamentPlayerId[],
  seed: string,
  now: number,
  createMatchId: () => TournamentMatchId,
  options: { thirdPlace?: boolean } = {},
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
        role: 'elimination',
        ...(player1 ? { player1 } : {}),
        ...(player2 ? { player2 } : {}),
        status: round === 1 ? 'ready' : 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  if (options.thirdPlace && rounds >= 2) {
    matches.push({
      id: createMatchId(),
      tournamentId,
      round: rounds,
      bracketPosition: 1,
      role: 'third-place',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  return matches;
}

/**
 * 1st is the championship winner, 2nd is the championship loser, and 3rd is
 * the third-place match winner. Returns undefined until those matches have winners.
 */
export function readTournamentPlaces(
  matches: readonly Pick<
    TournamentMatch,
    'id' | 'round' | 'bracketPosition' | 'role' | 'player1' | 'player2' | 'winner' | 'status'
  >[],
): {
  firstId: TournamentPlayerId;
  secondId: TournamentPlayerId;
  thirdId?: TournamentPlayerId;
  finalMatchId: TournamentMatchId;
  thirdMatchId?: TournamentMatchId;
} | undefined {
  if (matches.length === 0) return undefined;
  const elimination = matches.filter(match => !isThirdPlaceMatch(match, matches));
  if (elimination.length === 0) return undefined;
  const finalRound = Math.max(...elimination.map(match => match.round));
  const finalMatch = matches.find(match => (
    match.round === finalRound && match.bracketPosition === 0 && !isThirdPlaceMatch(match, matches)
  ));
  if (!finalMatch?.winner || !finalMatch.player1 || !finalMatch.player2) return undefined;
  if (finalMatch.status !== 'completed' && finalMatch.status !== 'forfeited') return undefined;
  const secondId = finalMatch.winner === finalMatch.player1 ? finalMatch.player2 : finalMatch.player1;
  if (!secondId || secondId === finalMatch.winner) return undefined;
  const placement = matches.find(match => isThirdPlaceMatch(match, matches));
  if (!placement) {
    return {
      firstId: finalMatch.winner,
      secondId,
      finalMatchId: finalMatch.id,
    };
  }
  if (!placement.winner) return undefined;
  if (placement.status !== 'completed' && placement.status !== 'forfeited') return undefined;
  return {
    firstId: finalMatch.winner,
    secondId,
    thirdId: placement.winner,
    finalMatchId: finalMatch.id,
    thirdMatchId: placement.id,
  };
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
