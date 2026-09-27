export const POKE_SYMBOL = 'POKE' as const;
export const CASUAL_FEE_BPS = 200;
export const TOURNAMENT_TREASURY_BPS = 9000;
export const TOURNAMENT_DEV_OPS_BPS = 1000;

export interface CasualEconomicsPreview {
  symbol: typeof POKE_SYMBOL;
  collateral: number;
  totalPot: number;
  protocolFee: number;
  feeRateBps: number;
  winnerPayout: number;
}

export interface TournamentEconomicsPreview {
  symbol: typeof POKE_SYMBOL;
  entryFee: number;
  playerCount: number;
  totalEntries: number;
  treasuryShare: number;
  treasuryBps: number;
  devOpsShare: number;
  devOpsBps: number;
  prizePool: number;
}

/** Same integer fee math as `MockEconomics.previewCasual`. */
export function previewCasual(collateral: number): CasualEconomicsPreview {
  if (!Number.isInteger(collateral) || collateral <= 0) {
    throw new Error('Collateral must be a positive integer POKE value.');
  }
  const totalPot = collateral * 2;
  const protocolFee = Math.floor((totalPot * CASUAL_FEE_BPS) / 10_000);
  const winnerPayout = totalPot - protocolFee;
  return {
    symbol: POKE_SYMBOL,
    collateral,
    totalPot,
    protocolFee,
    feeRateBps: CASUAL_FEE_BPS,
    winnerPayout,
  };
}

/** Same integer fee math as `MockEconomics.previewTournament`. */
export function previewTournament(entryFee: number, playerCount: number): TournamentEconomicsPreview {
  if (!Number.isInteger(entryFee) || entryFee < 0) {
    throw new Error('Tournament entry fee must be a non-negative integer.');
  }
  if (!Number.isInteger(playerCount) || playerCount < 0) {
    throw new Error('Tournament player count must be a non-negative integer.');
  }
  const totalEntries = entryFee * playerCount;
  const treasuryShare = Math.floor((totalEntries * TOURNAMENT_TREASURY_BPS) / 10_000);
  const devOpsShare = totalEntries - treasuryShare;
  return {
    symbol: POKE_SYMBOL,
    entryFee,
    playerCount,
    totalEntries,
    treasuryShare,
    treasuryBps: TOURNAMENT_TREASURY_BPS,
    devOpsShare,
    devOpsBps: TOURNAMENT_DEV_OPS_BPS,
    prizePool: treasuryShare,
  };
}
