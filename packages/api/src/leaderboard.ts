import type { FightHistoryEntry } from './fight-history';
import type { PublicTrainerProfile } from './trainer-directory';

export const LEADERBOARD_MAX_ROWS = 200;

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  username: string;
  spriteId: string;
  fights: number;
  wins: number;
  losses: number;
  ties: number;
  winRateBps: number | null;
  solPnlLamports: number;
}

export type LeaderboardStats = Omit<LeaderboardRow, 'rank'>;

export function emptyLeaderboardStats(
  playerId: string,
  profile: PublicTrainerProfile,
): LeaderboardStats {
  return {
    playerId,
    username: profile.username,
    spriteId: profile.spriteId,
    fights: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    winRateBps: null,
    solPnlLamports: 0,
  };
}

export function applyFightToLeaderboard(stats: LeaderboardStats, entry: FightHistoryEntry): void {
  stats.fights += 1;
  if (entry.result === 'win') stats.wins += 1;
  else if (entry.result === 'tie') stats.ties += 1;
  else stats.losses += 1;
  if (entry.paid && entry.symbol === 'SOL') stats.solPnlLamports += entry.net;
  const decisive = stats.wins + stats.losses;
  stats.winRateBps = decisive === 0 ? null : Math.round((stats.wins / decisive) * 10_000);
}

export function rankLeaderboard(rows: readonly LeaderboardStats[]): LeaderboardRow[] {
  return [...rows]
    .sort(compareLeaderboard)
    .slice(0, LEADERBOARD_MAX_ROWS)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function compareLeaderboard(a: LeaderboardStats, b: LeaderboardStats): number {
  if (a.solPnlLamports !== b.solPnlLamports) return b.solPnlLamports - a.solPnlLamports;
  const aRate = a.winRateBps ?? -1;
  const bRate = b.winRateBps ?? -1;
  if (aRate !== bRate) return bRate - aRate;
  if (a.fights !== b.fights) return b.fights - a.fights;
  return a.username.localeCompare(b.username) || a.playerId.localeCompare(b.playerId);
}
