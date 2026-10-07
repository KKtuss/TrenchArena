import {
  CASUAL_FEE_BPS as DB_CASUAL_FEE_BPS,
  TOURNAMENT_DEV_OPS_BPS as DB_TOURNAMENT_DEV_OPS_BPS,
  TOURNAMENT_TREASURY_BPS as DB_TOURNAMENT_TREASURY_BPS,
  previewCasual as previewCasualMath,
  previewTournament as previewTournamentMath,
} from '@pokearena/db';

export const POKE_SYMBOL = 'POKE';
export const CASUAL_FEE_BPS = DB_CASUAL_FEE_BPS;
export const TOURNAMENT_TREASURY_BPS = DB_TOURNAMENT_TREASURY_BPS;
export const TOURNAMENT_DEV_OPS_BPS = DB_TOURNAMENT_DEV_OPS_BPS;
export const DEFAULT_TOURNAMENT_ENTRY_POKE = 50_000;
/** Test faucet top-up target for every wallet that authenticates when the faucet is on. */
export const DEFAULT_DEV_BALANCE_POKE = 10_000_000;
/** Seed balance for built-in demo-player-1/2 (tests and local identify). */
export const DEMO_PLAYER_STARTING_POKE = 10_000_000;

export type DemoPlayerId = 'demo-player-1' | 'demo-player-2';
export type PlayerId = string;

export interface CasualEconomicsPreview {
  symbol: typeof POKE_SYMBOL | 'SOL';
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
  reason: 'casual-win' | 'casual-forfeit' | 'casual-tie' | 'tournament-win' | 'refund';
}

/** SOL settlement result for the separate 1v1 wager rail. */
export interface ChainPayoutResult {
  symbol: 'SOL';
  rail: 'sol_chain';
  winnerId?: string;
  amount: number;
  mocked?: false;
  protocolFee?: number;
  reason?: 'casual-win' | 'casual-forfeit' | 'casual-tie' | 'tournament-win' | 'refund';
  settlementKey: string;
  settlementKeyHex: string;
}

export interface CardsPayoutResult {
  symbol: 'CARDS';
  rail: 'cards_chain';
  winnerId: string;
  amount: number;
  cardsAmountRaw: number;
  settlementKey: string;
  settlementKeyHex: string;
}

export interface WalletSnapshot {
  playerId: PlayerId;
  symbol: typeof POKE_SYMBOL;
  balance: number;
  eligible: boolean;
}

function isKnownPlayerId(playerId: string): boolean {
  return /^demo-player-[12]$/.test(playerId) || playerId.length >= 32;
}

export class MockEconomics {
  private readonly balances = new Map<string, number>([
    ['demo-player-1', DEMO_PLAYER_STARTING_POKE],
    ['demo-player-2', DEMO_PLAYER_STARTING_POKE],
  ]);
  private readonly holds = new Map<string, { playerId: string; amount: number }>();
  private readonly settlements = new Map<string, MockPayoutResult>();
  private readonly devFaucet: boolean;

  constructor(options: { devFaucet?: boolean } = {}) {
    this.devFaucet = options.devFaucet === true;
  }

  ensureWallet(playerId: string): WalletSnapshot {
    if (!this.balances.has(playerId) && isKnownPlayerId(playerId)) {
      this.balances.set(playerId, this.devFaucet ? DEFAULT_DEV_BALANCE_POKE : 0);
    }
    return this.getWallet(playerId);
  }

  getWallet(playerId: string): WalletSnapshot {
    const balance = this.balances.get(playerId) ?? 0;
    return {
      playerId,
      symbol: POKE_SYMBOL,
      balance,
      eligible: balance > 0 && isKnownPlayerId(playerId),
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
    return previewCasualMath(collateral);
  }

  previewTournament(entryFee: number, playerCount: number): TournamentEconomicsPreview {
    return previewTournamentMath(entryFee, playerCount);
  }

  lockCollateral(playerId: string, amount: number): void {
    this.assertAffordable(playerId, amount);
    this.balances.set(playerId, this.getBalance(playerId) - amount);
  }

  reserve(holdKey: string, playerId: string, amount: number): boolean {
    const existing = this.holds.get(holdKey);
    if (existing) {
      if (existing.playerId === playerId && existing.amount === amount) return false;
      throw new Error('Collateral hold already exists.');
    }
    this.lockCollateral(playerId, amount);
    this.holds.set(holdKey, { playerId, amount });
    return true;
  }

  reserveAll(entries: ReadonlyArray<{ holdKey: string; playerId: string; amount: number }>): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.holdKey) || this.holds.has(entry.holdKey)) {
        throw new Error('Collateral hold already exists.');
      }
      seen.add(entry.holdKey);
      if (!Number.isInteger(entry.amount) || entry.amount <= 0) {
        throw new Error('Amount must be a positive integer POKE value.');
      }
    }
    const needed = new Map<string, number>();
    for (const entry of entries) {
      needed.set(entry.playerId, (needed.get(entry.playerId) ?? 0) + entry.amount);
    }
    for (const [playerId, amount] of needed) {
      if (this.getBalance(playerId) < amount) {
        throw new Error('Collateral exceeds development POKE balance.');
      }
    }
    for (const entry of entries) {
      this.balances.set(entry.playerId, this.getBalance(entry.playerId) - entry.amount);
      this.holds.set(entry.holdKey, { playerId: entry.playerId, amount: entry.amount });
    }
  }

  hasHold(holdKey: string): boolean {
    return this.holds.has(holdKey);
  }

  release(holdKey: string): number {
    const hold = this.holds.get(holdKey);
    if (!hold) return 0;
    this.holds.delete(holdKey);
    this.credit(hold.playerId, hold.amount);
    return hold.amount;
  }

  consume(holdKey: string): void {
    this.holds.delete(holdKey);
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
    reason?: 'casual-win' | 'casual-forfeit';
    settlementKey?: string;
  }): MockPayoutResult {
    const existing = this.settled(input.settlementKey);
    if (existing) return existing;
    const preview = this.previewCasual(input.collateral);
    this.credit(input.winnerId, preview.winnerPayout);
    return this.remember(input.settlementKey, {
      symbol: POKE_SYMBOL,
      mocked: true,
      winnerId: input.winnerId,
      amount: preview.winnerPayout,
      protocolFee: preview.protocolFee,
      reason: input.reason ?? 'casual-win',
    });
  }

  settleCasualTie(input: {
    player1Id: string;
    player2Id: string;
    collateral: number;
    settlementKey?: string;
  }): MockPayoutResult {
    const existing = this.settled(input.settlementKey);
    if (existing) return existing;
    const preview = this.previewCasual(input.collateral);
    const refundEach = Math.floor(preview.totalPot / 2);
    this.credit(input.player1Id, refundEach);
    this.credit(input.player2Id, preview.totalPot - refundEach);
    return this.remember(input.settlementKey, {
      symbol: POKE_SYMBOL,
      mocked: true,
      amount: refundEach,
      protocolFee: 0,
      reason: 'casual-tie',
    });
  }

  settleTournamentWin(input: {
    winnerId: string;
    entryFee: number;
    playerCount: number;
    settlementKey?: string;
  }): MockPayoutResult {
    const existing = this.settled(input.settlementKey);
    if (existing) return existing;
    const preview = this.previewTournament(input.entryFee, input.playerCount);
    this.credit(input.winnerId, preview.prizePool);
    return this.remember(input.settlementKey, {
      symbol: POKE_SYMBOL,
      mocked: true,
      winnerId: input.winnerId,
      amount: preview.prizePool,
      reason: 'tournament-win',
    });
  }

  inspectHold(holdKey: string): { playerId: string; amount: number } | undefined {
    return this.holds.get(holdKey);
  }

  inspectSettlement(settlementKey: string): MockPayoutResult | undefined {
    return this.settlements.get(settlementKey);
  }

  private settled(settlementKey: string | undefined): MockPayoutResult | undefined {
    if (!settlementKey) return undefined;
    return this.settlements.get(settlementKey);
  }

  private remember(settlementKey: string | undefined, result: MockPayoutResult): MockPayoutResult {
    if (settlementKey) this.settlements.set(settlementKey, result);
    return result;
  }
}
