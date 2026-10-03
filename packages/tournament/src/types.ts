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

export type RegisteredPlayerStatus = 'registered' | 'withdrawn' | 'waitlisted';

/** Shared window after a custom field fills, before the bracket is built. */
export const TEAM_FINALIZATION_MS = 5 * 60 * 1000;
export const BURN_PAYMENT_WINDOW_MS = 2 * 60 * 1000;
export const CHAIN_TOURNAMENT_MAX_PLAYERS = 32;
export const TOURNAMENT_BURN_FEE_ATOMS = 10_000;

export interface TournamentPlayer {
  id: TournamentPlayerId;
  displayName: string;
  team: string;
  eligible: true;
  status: RegisteredPlayerStatus;
  registrationOrder: number;
  /** Set when the player locks early, or when the shared deadline locks everyone. */
  teamLocked?: boolean;
  burnFeePaid?: boolean;
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
  /** Legality and team mode. Battle simulation stays on `format` (Gen 9 OU). */
  ruleset?: string;
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
  /**
   * Custom tournaments only. Set once, when registration hits maxPlayers.
   * The bracket is built when this instant is reached, not when the lobby fills.
   */
  finalizesAt?: number;
  paymentEndsAt?: number;
  paymentPlayerId?: TournamentPlayerId;
}

export interface CreateTournamentInput {
  title: string;
  format: SupportedFormat;
  ruleset?: string;
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
