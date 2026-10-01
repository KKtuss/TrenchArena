/**
 * A player already in a started fight should land in the battle, not on a
 * lobby button. The ready countdown stays on the room page until the fight
 * actually starts.
 */
export function shouldEnterLiveBattle(
  room: {
    status: string;
    matchId?: string;
    battleSize?: string;
    creatorId?: string;
    opponentId?: string | null;
  } | null | undefined,
  playerId: string | null | undefined,
): boolean {
  if (!room || !playerId || !room.matchId) return false;
  if (room.battleSize === '2v2') return false;
  if (room.creatorId !== playerId && room.opponentId !== playerId) return false;
  return room.status === 'battling' || room.status === 'starting';
}
