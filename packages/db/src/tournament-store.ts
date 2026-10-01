export interface DurableTournamentPlayer {
  id: string;
  displayName: string;
  team: string;
  eligible: true;
  status: 'registered' | 'withdrawn';
  registrationOrder: number;
  teamLocked?: boolean;
}

export interface DurableTournamentMatch {
  id: string;
  tournamentId: string;
  round: number;
  bracketPosition: number;
  player1?: string;
  player2?: string;
  status: string;
  battleInstanceId?: string;
  winner?: string;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface DurableTournament {
  id: string;
  title: string;
  format: string;
  ruleset?: string;
  maxPlayers: 4 | 8 | 16 | 32;
  bracketSeed: string;
  matchTimeoutMs: number;
  status: string;
  hostId: string;
  entryFee: number;
  rail?: 'legacy_poke' | 'sol_chain';
  entryAtoms?: number;
  entryQuoteId?: string;
  prizeLamports?: number;
  players: DurableTournamentPlayer[];
  matchIds: string[];
  winner?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  finalizesAt?: number;
}

export interface RegisterTournamentPlayerInput {
  tournamentId: string;
  playerId: string;
  displayName: string;
  team: string;
}

export interface MatchOutcomeInput {
  match: DurableTournamentMatch;
  nextMatch?: DurableTournamentMatch;
  tournament?: DurableTournament;
}

/**
 * Async tournament persistence including hostId and entryFee.
 * Registration reserves the entry hold in the same transaction as the
 * `tournament_players` row. Live Showdown streams are not stored.
 */
export interface TournamentStore {
  saveTournament(tournament: DurableTournament): Promise<void>;
  getTournament(id: string): Promise<DurableTournament | undefined>;
  listTournaments(): Promise<DurableTournament[]>;
  saveMatch(match: DurableTournamentMatch): Promise<void>;
  getMatch(id: string): Promise<DurableTournamentMatch | undefined>;
  listMatches(tournamentId: string): Promise<DurableTournamentMatch[]>;
  registerPlayer(input: RegisterTournamentPlayerInput): Promise<DurableTournamentPlayer>;
  saveBracket(tournament: DurableTournament, matches: DurableTournamentMatch[]): Promise<void>;
  beginMatchStart(matchId: string): Promise<DurableTournamentMatch>;
  attachBattleInstance(matchId: string, battleInstanceId: string): Promise<DurableTournamentMatch>;
  markMatchActive(matchId: string): Promise<DurableTournamentMatch>;
  interruptMatch(matchId: string): Promise<DurableTournamentMatch>;
  commitMatchOutcome(input: MatchOutcomeInput): Promise<DurableTournamentMatch>;
}
