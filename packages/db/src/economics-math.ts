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
  if (!Number.isSafeInteger(collateral) || collateral <= 0) {
    throw new Error('Collateral must be a positive integer POKE value.');
  }
  const totalPotBig = BigInt(collateral) * 2n;
  if (totalPotBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Casual total pot exceeds safe integer range.');
  }
  const totalPot = Number(totalPotBig);
  const protocolFee = Number(
    (totalPotBig * BigInt(CASUAL_FEE_BPS)) / 10_000n,
  );
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

/**
 * Legacy POKE entry-fee preview. Kept for grandfathered tournaments only.
 * New chain tournaments must NOT use this to derive prizes — prizes come from
 * the SOL treasury via `previewTreasuryDeposit`.
 */
export function previewTournament(entryFee: number, playerCount: number): TournamentEconomicsPreview {
  if (!Number.isSafeInteger(entryFee) || entryFee < 0) {
    throw new Error('Tournament entry fee must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(playerCount) || playerCount < 0) {
    throw new Error('Tournament player count must be a non-negative integer.');
  }
  const totalEntriesBig = BigInt(entryFee) * BigInt(playerCount);
  if (totalEntriesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Tournament total entries exceed safe integer range.');
  }
  const totalEntries = Number(totalEntriesBig);
  const treasuryShare = Number(
    (totalEntriesBig * BigInt(TOURNAMENT_TREASURY_BPS)) / 10_000n,
  );
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

/** 90/10 split for realized creator-reward SOL deposits into the treasury. */
export function previewTreasuryDeposit(grossLamports: number): {
  symbol: 'SOL';
  grossLamports: number;
  treasuryLamports: number;
  treasuryBps: number;
  operatorLamports: number;
  operatorBps: number;
} {
  if (!Number.isSafeInteger(grossLamports) || grossLamports <= 0) {
    throw new Error('Gross treasury deposit must be a positive integer lamport amount.');
  }
  const grossBig = BigInt(grossLamports);
  const treasuryLamports = Number(
    (grossBig * BigInt(TOURNAMENT_TREASURY_BPS)) / 10_000n,
  );
  return {
    symbol: 'SOL',
    grossLamports,
    treasuryLamports,
    treasuryBps: TOURNAMENT_TREASURY_BPS,
    operatorLamports: grossLamports - treasuryLamports,
    operatorBps: TOURNAMENT_DEV_OPS_BPS,
  };
}
