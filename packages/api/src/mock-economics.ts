export const POKE_SYMBOL = 'POKE';
export const CASUAL_FEE_BPS = 200;
export const TOURNAMENT_TREASURY_BPS = 9000;
export const TOURNAMENT_DEV_OPS_BPS = 1000;
export const DEFAULT_TOURNAMENT_ENTRY_POKE = 100_000;
export const DEFAULT_DEV_BALANCE_POKE = 10_000_000;

export type DemoPlayerId = 'demo-player-1' | 'demo-player-2';

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

export interface MockPayoutResult {
  symbol: typeof POKE_SYMBOL;
  mocked: true;
  winnerId?: string;
  amount: number;
  protocolFee?: number;
  reason: 'casual-win' | 'casual-tie' | 'tournament-win' | 'refund';
}

export interface WalletSnapshot {
  playerId: DemoPlayerId;
  symbol: typeof POKE_SYMBOL;
  balance: number;
  eligible: boolean;
}

export class MockEconomics {
  private readonly balances = new Map<string, number>([
    ['demo-player-1', DEFAULT_DEV_BALANCE_POKE],
    ['demo-player-2', DEFAULT_DEV_BALANCE_POKE],
  ]);

  getWallet(playerId: string): WalletSnapshot {
    const balance = this.balances.get(playerId) ?? 0;
    return {
      playerId: playerId as DemoPlayerId,
      symbol: POKE_SYMBOL,
      balance,
      eligible: balance > 0 && /^demo-player-[12]$/.test(playerId),
    };
  }

  getBalance(playerId: string): number {
    return this.balances.get(playerId) ?? 0;
  }

  assertAffordable(playerId: string, amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Amount must be a positive integer POKE value.');
    }
    if (this.getBalance(playerId) < amount) {
      throw new Error('Collateral exceeds development POKE balance.');
    }
  }

  previewCasual(collateral: number): CasualEconomicsPreview {
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

  previewTournament(entryFee: number, playerCount: number): TournamentEconomicsPreview {
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

  lockCollateral(playerId: string, amount: number): void {
    this.assertAffordable(playerId, amount);
    this.balances.set(playerId, this.getBalance(playerId) - amount);
  }

  credit(playerId: string, amount: number): void {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error('Credit amount must be a non-negative integer.');
    }
    this.balances.set(playerId, this.getBalance(playerId) + amount);
  }

  settleCasualWin(input: {
    winnerId: string;
    loserId: string;
    collateral: number;
  }): MockPayoutResult {
    const preview = this.previewCasual(input.collateral);
    this.credit(input.winnerId, preview.winnerPayout);
    return {
      symbol: POKE_SYMBOL,
      mocked: true,
      winnerId: input.winnerId,
      amount: preview.winnerPayout,
      protocolFee: preview.protocolFee,
      reason: 'casual-win',
    };
  }

  settleCasualTie(input: {
    player1Id: string;
    player2Id: string;
    collateral: number;
  }): MockPayoutResult {
    const preview = this.previewCasual(input.collateral);
    const refundEach = Math.floor(preview.totalPot / 2);
    this.credit(input.player1Id, refundEach);
    this.credit(input.player2Id, preview.totalPot - refundEach);
    return {
      symbol: POKE_SYMBOL,
      mocked: true,
      amount: refundEach,
      protocolFee: 0,
      reason: 'casual-tie',
    };
  }

  settleTournamentWin(input: {
    winnerId: string;
    entryFee: number;
    playerCount: number;
  }): MockPayoutResult {
    const preview = this.previewTournament(input.entryFee, input.playerCount);
    this.credit(input.winnerId, preview.prizePool);
    return {
      symbol: POKE_SYMBOL,
      mocked: true,
      winnerId: input.winnerId,
      amount: preview.prizePool,
      reason: 'tournament-win',
    };
  }
}
