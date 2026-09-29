import type {
  BattleEvent,
  BattleResult,
  BattleState,
  PlayerChoice,
  SupportedFormat,
} from '@pokearena/battle-engine';

type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type TournamentId = Brand<string, 'TournamentId'>;
export type TournamentPlayerId = Brand<string, 'TournamentPlayerId'>;
export type TournamentMatchId = Brand<string, 'TournamentMatchId'>;
export type BattleInstanceId = Brand<string, 'BattleInstanceId'>;

export function createTournamentPlayerId(value: string): TournamentPlayerId {
  if (!value) throw new Error('Tournament player ID must not be empty.');
  return value as TournamentPlayerId;
}

export type TournamentStatus =
  | 'draft'
  | 'registration'
  | 'ready'
  | 'in-progress'
  | 'completed'
  | 'cancelled';

export type TournamentMatchStatus =
  | 'pending'
  | 'ready'
  | 'battle-created'
  | 'active'
  | 'completed'
  | 'forfeited'
  | 'tied'
  | 'interrupted';

export type RegisteredPlayerStatus = 'registered' | 'withdrawn';

export interface TournamentPlayer {
  id: TournamentPlayerId;
  displayName: string;
  team: string;
  eligible: true;
  status: RegisteredPlayerStatus;
  registrationOrder: number;
}

export interface BattleMatchResult {
  kind: 'battle';
  battleResult: BattleResult;
}

export interface ForfeitMatchResult {
  kind: 'forfeit';
  reason: 'timeout';
}

export type TournamentMatchResult = BattleMatchResult | ForfeitMatchResult;

export interface TournamentMatch {
  id: TournamentMatchId;
  tournamentId: TournamentId;
  round: number;
  bracketPosition: number;
  player1?: TournamentPlayerId;
  player2?: TournamentPlayerId;
  status: TournamentMatchStatus;
  battleInstanceId?: BattleInstanceId;
  winner?: TournamentPlayerId;
  result?: TournamentMatchResult;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface Tournament {
  id: TournamentId;
  title: string;
  format: SupportedFormat;
  maxPlayers: 4 | 8 | 16 | 32;
  bracketSeed: string;
  matchTimeoutMs: number;
  status: TournamentStatus;
  hostId: string;
  entryFee: number;
  rail?: 'legacy_poke' | 'sol_chain';
  entryAtoms?: number;
  entryQuoteId?: string;
  prizeLamports?: number;
  players: TournamentPlayer[];
  matchIds: TournamentMatchId[];
  winner?: TournamentPlayerId;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface CreateTournamentInput {
  title: string;
  format: SupportedFormat;
  maxPlayers: 4 | 8 | 16 | 32;
  bracketSeed?: string;
  matchTimeoutMs?: number;
  hostId?: string;
  entryFee?: number;
  rail?: 'legacy_poke' | 'sol_chain';
  entryAtoms?: number;
  entryQuoteId?: string;
  prizeLamports?: number;
}

export interface RegisterPlayerInput {
  playerId: TournamentPlayerId;
  displayName: string;
  team: string;
}

export interface TournamentChoiceSubmission {
  matchId: TournamentMatchId;
  battleInstanceId: BattleInstanceId;
  playerId: TournamentPlayerId;
  revision: number;
  choice: PlayerChoice;
}

export interface TournamentMatchView {
  match: TournamentMatch;
  battleState?: BattleState;
}

export interface TournamentMatchEvents {
  matchId: TournamentMatchId;
  events: readonly BattleEvent[];
}

export interface TournamentResult {
  tournamentId: TournamentId;
  winner: TournamentPlayerId;
  finalMatchId: TournamentMatchId;
  completedAt: number;
}
