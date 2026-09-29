export const POKE_SYMBOL = 'POKE' as const;

export type PayoutReason =
  | 'casual-win'
  | 'casual-forfeit'
  | 'casual-tie'
  | 'tournament-win'
  | 'refund';

export interface PayoutResult {
  symbol: typeof POKE_SYMBOL;
  mocked: true;
  winnerId?: string;
  amount: number;
  protocolFee?: number;
  reason: PayoutReason;
}

export interface WalletSnapshot {
  playerId: string;
  symbol: typeof POKE_SYMBOL;
  balance: number;
  eligible: boolean;
}

export interface ReserveEntry {
  holdKey: string;
  playerId: string;
  amount: number;
}

export interface CasualWinInput {
  winnerId: string;
  loserId: string;
  collateral: number;
  reason?: 'casual-win' | 'casual-forfeit';
  settlementKey?: string;
}

export interface CasualTieInput {
  player1Id: string;
  player2Id: string;
  collateral: number;
  settlementKey?: string;
}

export interface TournamentWinInput {
  winnerId: string;
  entryFee: number;
  playerCount: number;
  settlementKey?: string;
}

export type DurableCasualRoomStatus =
  | 'pending_deposit'
  | 'open'
  | 'full'
  | 'ready'
  | 'starting'
  | 'battling'
  | 'completed'
  | 'cancelled';

export interface CasualRoomCreateInput {
  id: string;
  matchId: string;
  roomType: 'private' | 'open';
  battleSize: '1v1' | '2v2';
  creatorId: string;
  invitedPlayerId?: string;
  collateral: number;
  rail?: 'legacy_poke' | 'sol_chain';
  collateralLamports?: number;
}

export interface CasualRoomAcceptInput {
  roomId: string;
  opponentId: string;
  collateral: number;
}

export interface CasualCompleteWinInput {
  roomId: string;
  winnerId: string;
  loserId: string;
  collateral: number;
  reason: 'casual-win' | 'casual-forfeit';
}

export interface CasualCompleteTieInput {
  roomId: string;
  player1Id: string;
  player2Id: string;
  collateral: number;
}

export interface TournamentCompleteInput extends TournamentWinInput {
  holdKeys: ReadonlyArray<string>;
}

export interface HoldSnapshot {
  holdKey: string;
  playerId: string;
  amount: number;
  status: 'reserved' | 'released' | 'consumed';
  purpose?: 'casual_creator' | 'casual_opponent' | 'tournament_entry';
  tournamentId?: string;
  roomId?: string;
}

export interface DurableCasualRoom {
  id: string;
  matchId: string;
  roomType: 'private' | 'open';
  battleSize: '1v1' | '2v2';
  creatorId: string;
  opponentId?: string;
  invitedPlayerId?: string;
  collateral: number;
  status: DurableCasualRoomStatus;
  winnerId?: string;
  resultStatus?: 'win' | 'tie';
  settlementKey?: string;
  battleInstanceId?: string;
  /** `legacy_poke` (default) or `sol_chain`. */
  rail?: 'legacy_poke' | 'sol_chain';
  collateralLamports?: number;
}

/**
 * Async persistence boundary for mock-POKE economics.
 * Production selects PostgreSQL; tests/dev may use an in-memory adapter.
 */
export interface EconomicsStore {
  ensureWallet(playerId: string): Promise<WalletSnapshot>;
  getWallet(playerId: string): Promise<WalletSnapshot>;
  getBalance(playerId: string): Promise<number>;
  hasHold(holdKey: string): Promise<boolean>;
  getHold(holdKey: string): Promise<HoldSnapshot | undefined>;
  listHolds(): Promise<HoldSnapshot[]>;
  getSettlement(settlementKey: string): Promise<PayoutResult | undefined>;
  getCasualRoom(roomId: string): Promise<DurableCasualRoom | undefined>;
  listCasualRooms(): Promise<DurableCasualRoom[]>;
  reserve(holdKey: string, playerId: string, amount: number): Promise<boolean>;
  reserveAll(entries: ReadonlyArray<ReserveEntry>): Promise<void>;
  release(holdKey: string): Promise<number>;
  consume(holdKey: string): Promise<void>;
  credit(playerId: string, amount: number): Promise<void>;
  lockCollateral(playerId: string, amount: number): Promise<void>;
  settleCasualWin(input: CasualWinInput): Promise<PayoutResult>;
  settleCasualTie(input: CasualTieInput): Promise<PayoutResult>;
  settleTournamentWin(input: TournamentWinInput): Promise<PayoutResult>;
  createCasualRoomWithHold(input: CasualRoomCreateInput): Promise<void>;
  acceptCasualRoomWithHold(input: CasualRoomAcceptInput): Promise<void>;
  cancelCasualRoom(roomId: string): Promise<void>;
  abortCasualRoom(roomId: string): Promise<void>;
  completeCasualWin(input: CasualCompleteWinInput): Promise<PayoutResult>;
  completeCasualTie(input: CasualCompleteTieInput): Promise<PayoutResult>;
  completeTournamentWin(input: TournamentCompleteInput): Promise<PayoutResult>;
  setCasualRoomStatus(
    roomId: string,
    status: DurableCasualRoomStatus,
    extras?: { battleInstanceId?: string },
  ): Promise<void>;
}

export function isKnownPlayerId(playerId: string): boolean {
  return /^demo-player-[12]$/.test(playerId) || playerId.length >= 32;
}

export function creatorHoldKey(roomId: string): string {
  return `casual:${roomId}:creator`;
}

export function opponentHoldKey(roomId: string): string {
  return `casual:${roomId}:opponent`;
}
