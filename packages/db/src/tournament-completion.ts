/**
 * Completion is derived from the matches visible inside the tournament row lock.
 * A third-place tie has no winner, so the cup stays in progress.
 * `tournament.winner` means the completed champion. A finished final does not
 * populate it while the third-place match is still open.
 */
export interface CompletionMatch {
  round: number;
  bracketPosition: number;
  status: string;
  winner?: string;
}

export interface TournamentOutcome {
  winner?: string;
  completed: boolean;
  hasThirdPlace: boolean;
  thirdDecided: boolean;
}

export function authoritativeTournamentOutcome(
  matches: readonly CompletionMatch[],
): TournamentOutcome {
  if (matches.length === 0) {
    return { completed: false, hasThirdPlace: false, thirdDecided: false };
  }
  const finalRound = Math.max(...matches.map(match => match.round));
  const finalMatch = matches.find(match => match.round === finalRound && match.bracketPosition === 0);
  const third = matches.find(match => match.round === finalRound && match.bracketPosition === 1);
  const decided = (match: CompletionMatch | undefined): boolean => Boolean(
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
}>(tournament: T, matches: readonly CompletionMatch[], now: number): T | undefined {
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
