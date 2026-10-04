import { CASUAL_FEE_BPS, BPS_DENOM, OPERATOR_BPS, TREASURY_BPS } from './constants';

export interface SolCasualPreview {
  symbol: 'SOL';
  collateralLamports: number;
  totalPotLamports: number;
  protocolFeeLamports: number;
  feeRateBps: number;
  winnerPayoutLamports: number;
}

export interface TreasurySplitPreview {
  symbol: 'SOL';
  grossLamports: number;
  treasuryLamports: number;
  treasuryBps: number;
  operatorLamports: number;
  operatorBps: number;
}

function requireNonNegativeLamports(name: string, lamports: number): void {
  if (!Number.isSafeInteger(lamports) || lamports < 0) {
    throw new Error(`${name} must be a non-negative integer lamport amount.`);
  }
}

/**
 * Minimum balance for a creator whose create and deposit are separate
 * transactions. The creator pays both account rents, both transaction fees,
 * the wager, and must remain rent-exempt after the deposit.
 */
export function minimumSolCreatorFunding(
  collateralLamports: number,
  matchEscrowRentLamports: number,
  matchVaultRentLamports: number,
  transactionFeeLamports: number,
  payerRentReserveLamports: number,
): number {
  if (!Number.isSafeInteger(collateralLamports) || collateralLamports <= 0) {
    throw new Error('Collateral must be a positive integer lamport amount.');
  }
  requireNonNegativeLamports('Match escrow rent', matchEscrowRentLamports);
  requireNonNegativeLamports('Match vault rent', matchVaultRentLamports);
  requireNonNegativeLamports('Transaction fee', transactionFeeLamports);
  requireNonNegativeLamports('Payer rent reserve', payerRentReserveLamports);
  const total = collateralLamports
    + matchEscrowRentLamports
    + matchVaultRentLamports
    + (2 * transactionFeeLamports)
    + payerRentReserveLamports;
  if (!Number.isSafeInteger(total)) throw new Error('Funding requirement exceeds safe integer range.');
  return total;
}

/** Minimum balance required immediately before a separate SOL deposit. */
export function minimumSolDepositBalance(
  collateralLamports: number,
  transactionFeeLamports: number,
  payerRentReserveLamports: number,
): number {
  if (!Number.isSafeInteger(collateralLamports) || collateralLamports <= 0) {
    throw new Error('Collateral must be a positive integer lamport amount.');
  }
  requireNonNegativeLamports('Transaction fee', transactionFeeLamports);
  requireNonNegativeLamports('Payer rent reserve', payerRentReserveLamports);
  const total = collateralLamports + transactionFeeLamports + payerRentReserveLamports;
  if (!Number.isSafeInteger(total)) throw new Error('Deposit requirement exceeds safe integer range.');
  return total;
}

export function previewSolCasual(collateralLamports: number): SolCasualPreview {
  if (!Number.isSafeInteger(collateralLamports) || collateralLamports <= 0) {
    throw new Error('Collateral must be a positive integer lamport amount.');
  }
  const totalPotLamports = collateralLamports * 2;
  const protocolFeeLamports = Math.floor((totalPotLamports * CASUAL_FEE_BPS) / BPS_DENOM);
  return {
    symbol: 'SOL',
    collateralLamports,
    totalPotLamports,
    protocolFeeLamports,
    feeRateBps: CASUAL_FEE_BPS,
    winnerPayoutLamports: totalPotLamports - protocolFeeLamports,
  };
}

export function previewTreasurySplit(grossLamports: number): TreasurySplitPreview {
  if (!Number.isSafeInteger(grossLamports) || grossLamports <= 0) {
    throw new Error('Gross amount must be a positive integer lamport amount.');
  }
  const treasuryLamports = Math.floor((grossLamports * TREASURY_BPS) / BPS_DENOM);
  return {
    symbol: 'SOL',
    grossLamports,
    treasuryLamports,
    treasuryBps: TREASURY_BPS,
    operatorLamports: grossLamports - treasuryLamports,
    operatorBps: OPERATOR_BPS,
  };
}

export function formatSol(lamports: number | bigint): string {
  const value = typeof lamports === 'bigint' ? Number(lamports) : lamports;
  return `${(value / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`;
}

export function solToLamports(sol: number): number {
  if (!Number.isFinite(sol) || sol <= 0) throw new Error('SOL amount must be positive.');
  return Math.round(sol * 1e9);
}
