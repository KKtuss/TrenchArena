import type { CasualFightRecord } from './casual-service';

export type FightResultLabel = 'win' | 'loss' | 'tie' | 'forfeit';
export type FightMode = 'casual' | 'competitive' | 'tournament';

export interface FightHistoryEntry {
  id: string;
  matchId: string;
  mode: FightMode;
  opponentId: string;
  result: FightResultLabel;
  completedAt: number;
  symbol: 'POKE' | 'SOL' | 'CARDS';
  stake: number;
  payout: number;
  fee: number;
  /** Credit minus the stake this fight already locked. From the settlement, not the wallet. */
  net: number;
  /** False when the fight has a result but the economy has not paid it. */
  paid: boolean;
  detailPath: string;
}

export interface FightHistoryCursor {
  completedAt: number;
  id: string;
}

export interface TournamentFightInput {
  playerId: string;
  matchId: string;
  tournamentId: string;
  opponentId: string;
  status: 'completed' | 'forfeited' | 'tied';
  winnerId?: string;
  completedAt: number;
  entryFee: number;
  prize: number;
  symbol: 'POKE' | 'SOL' | 'CARDS';
  /** True only on the player's last match of a finished cup, so the prize is counted once. */
  carriesCupBalance: boolean;
  playerWonCup: boolean;
}

/**
 * Net from the casual settlement.
 * A win credits `winnerPayout` after the stake was consumed, so the change is
 * payout minus stake. A loss consumes the stake and credits nothing.
 * A tie credits each stake back (the tie fee is 0), so the change is 0.
 */
export function casualFightEntry(record: CasualFightRecord, playerId: string): FightHistoryEntry {
  const stake = record.collateral;
  const symbol = record.payoutSymbol === 'SOL' ? 'SOL' : 'POKE';
  const pot = stake * 2;
  const tie = record.resultStatus === 'tie' || record.payoutReason === 'casual-tie';
  const won = record.winnerId === playerId;
  const forfeited = !tie && !won && (
    record.payoutReason === 'casual-forfeit' || record.endedBy === 'timeout'
  );
  let payout = 0;
  let net = 0;
  if (record.settled && tie) {
    if (symbol === 'SOL') {
      payout = record.payoutAmount ?? 0;
      net = payout - stake;
    } else {
      const creatorCredit = Math.floor(pot / 2);
      payout = playerId === record.creatorId ? creatorCredit : pot - creatorCredit;
      net = payout - stake;
    }
  } else if (record.settled && won) {
    payout = record.payoutAmount ?? 0;
    net = payout - stake;
  } else if (record.settled) {
    payout = 0;
    net = -stake;
  }
  const result: FightResultLabel = tie ? 'tie' : forfeited ? 'forfeit' : won ? 'win' : 'loss';
  return {
    id: record.id,
    matchId: record.matchId,
    mode: record.ruleset === 'competitive' ? 'competitive' : 'casual',
    opponentId: record.opponentId === playerId ? record.creatorId : record.opponentId,
    result,
    completedAt: record.completedAt,
    symbol,
    stake: record.settled ? stake : 0,
    payout,
    fee: record.settled ? (record.protocolFee ?? 0) : 0,
    net,
    paid: record.settled,
    detailPath: `/result/${record.id}`,
  };
}

/**
 * A bracket match has no wager of its own. The cup entry and prize are applied
 * once, on the player's last match, and only after the cup itself is settled.
 */
export function tournamentFightEntry(input: TournamentFightInput): FightHistoryEntry {
  const tied = input.status === 'tied';
  const playerWon = !tied && input.winnerId === input.playerId;
  const forfeited = input.status === 'forfeited' && !playerWon;
  const paid = input.carriesCupBalance;
  const payout = paid && input.playerWonCup ? input.prize : 0;
  const stake = paid ? input.entryFee : 0;
  const net = paid ? payout - input.entryFee : 0;
  return {
    id: input.matchId,
    matchId: input.matchId,
    mode: 'tournament',
    opponentId: input.opponentId,
    result: tied ? 'tie' : forfeited ? 'forfeit' : playerWon ? 'win' : 'loss',
    completedAt: input.completedAt,
    symbol: input.symbol,
    stake,
    payout,
    fee: 0,
    net,
    paid,
    detailPath: `/tournament/${input.tournamentId}`,
  };
}

export function pageFightHistory(
  entries: readonly FightHistoryEntry[],
  limit: number,
  before?: FightHistoryCursor,
): { entries: FightHistoryEntry[]; nextCursor?: FightHistoryCursor } {
  const ordered = [...entries].sort((a, b) => (
    b.completedAt - a.completedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  ));
  const visible = before
    ? ordered.filter(entry => isOlderThan(entry, before))
    : ordered;
  const page = visible.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = last && visible.length > limit
    ? { completedAt: last.completedAt, id: last.id }
    : undefined;
  return { entries: page, ...(nextCursor ? { nextCursor } : {}) };
}

function isOlderThan(entry: FightHistoryEntry, cursor: FightHistoryCursor): boolean {
  if (entry.completedAt !== cursor.completedAt) return entry.completedAt < cursor.completedAt;
  return entry.id < cursor.id;
}
