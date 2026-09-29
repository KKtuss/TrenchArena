export interface LiveFight {
  matchId: string;
  source: 'tournament' | 'casual';
  title: string;
  player1: string;
  player2?: string;
  format: string;
  battleSize?: '1v1' | '2v2';
  roomId?: string;
  tournamentId?: string;
  status: string;
}

export function pickLiveFight(
  fights: readonly LiveFight[],
  playerId: string,
  preferred?: string,
  random: () => number = Math.random,
): LiveFight | undefined {
  if (preferred) {
    const keep = fights.find(fight => fight.matchId === preferred);
    if (keep) return keep;
  }
  const notMine = fights.filter(fight => fight.player1 !== playerId && fight.player2 !== playerId);
  const pool = notMine.length ? notMine : [...fights];
  const cups = pool.filter(fight => fight.source === 'tournament');
  const chosen = cups.length ? cups : pool;
  if (!chosen.length) return undefined;
  return chosen[Math.floor(random() * chosen.length)];
}

export function spectatorBattleView<T extends { request?: unknown }>(
  view: T | undefined,
): Omit<T, 'request'> | undefined {
  if (!view) return undefined;
  const { request: _request, ...safe } = view;
  return safe;
}

export function spectatorEvents<T extends { scope?: string; data?: string }>(
  events: readonly T[] | undefined,
): T[] {
  if (!events?.length) return [];
  return events.filter(event => (
    event.scope !== 'private' && !String(event.data ?? '').includes('|request|')
  ));
}
