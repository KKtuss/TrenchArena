import type { Tournament, TournamentPlayer } from '@pokearena/tournament';

/**
 * Gen 9 OU does not reveal a build, or even species, until team preview
 * inside the battle. Tournament lobby payloads stay at identity only.
 * The authenticated viewer still receives their own locked paste.
 */
export function publicTournamentPlayer(
  player: TournamentPlayer,
  viewerId: string,
): Omit<TournamentPlayer, 'team'> & { team?: string } {
  const visible = {
    id: player.id,
    displayName: player.displayName,
    eligible: player.eligible,
    status: player.status,
    registrationOrder: player.registrationOrder,
    ...(player.teamLocked ? { teamLocked: true } : {}),
  };
  if (player.id === viewerId) return { ...visible, team: player.team };
  return visible;
}

export function publicTournamentForViewer<T extends Tournament>(
  tournament: T,
  viewerId: string,
): Omit<T, 'players'> & { players: Array<Omit<TournamentPlayer, 'team'> & { team?: string }> } {
  return {
    ...tournament,
    players: tournament.players.map(player => publicTournamentPlayer(player, viewerId)),
  };
}
