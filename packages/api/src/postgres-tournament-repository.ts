import { PostgresEconomicsStore } from '@pokearena/db';
import type {
  DurableTournament,
  DurableTournamentMatch,
  DurableTournamentPlayer,
  TournamentStore,
} from '@pokearena/db';
import {
  DuplicateRegistrationError,
  InvalidMatchResultError,
  InvalidMatchStateError,
  InvalidTournamentStateTransitionError,
  RegistrationClosedError,
  UnknownMatchError,
  UnknownTournamentError,
  TournamentError,
  type AsyncTournamentRepository,
  type MatchOutcomeInput,
  type RegisterPlayerInput,
  type Tournament,
  type TournamentId,
  type TournamentMatch,
  type TournamentMatchId,
  type TournamentPlayer,
  type TournamentPlayerId,
  type TournamentStatus,
} from '@pokearena/tournament';
import type { SupportedFormat } from '@pokearena/battle-engine';

export class PostgresTournamentRepository implements AsyncTournamentRepository {
  readonly backend = 'postgres' as const;

  constructor(private readonly store: TournamentStore) {}

  async saveTournament(tournament: Tournament): Promise<void> {
    await this.mapErrors(() => this.store.saveTournament(toDurableTournament(tournament)));
  }

  async getTournament(id: TournamentId): Promise<Tournament | undefined> {
    const tournament = await this.mapErrors(() => this.store.getTournament(id));
    return tournament ? fromDurableTournament(tournament) : undefined;
  }

  async listTournaments(): Promise<Tournament[]> {
    const listed = await this.mapErrors(() => this.store.listTournaments());
    return listed.map(fromDurableTournament);
  }

  async saveMatch(match: TournamentMatch): Promise<void> {
    await this.mapErrors(() => this.store.saveMatch(toDurableMatch(match)));
  }

  async getMatch(id: TournamentMatchId): Promise<TournamentMatch | undefined> {
    const match = await this.mapErrors(() => this.store.getMatch(id));
    return match ? fromDurableMatch(match) : undefined;
  }

  async listMatches(tournamentId: TournamentId): Promise<TournamentMatch[]> {
    const matches = await this.mapErrors(() => this.store.listMatches(tournamentId));
    return matches.map(fromDurableMatch);
  }

  async registerPlayer(
    tournamentId: TournamentId,
    input: RegisterPlayerInput,
  ): Promise<TournamentPlayer> {
    const player = await this.mapErrors(
      () => this.store.registerPlayer({
        tournamentId,
        playerId: input.playerId,
        displayName: input.displayName,
        team: input.team,
      }),
      input.playerId,
    );
    return fromDurablePlayer(player);
  }

  async saveBracket(tournament: Tournament, matches: TournamentMatch[]): Promise<void> {
    await this.mapErrors(() => this.store.saveBracket(
      toDurableTournament(tournament),
      matches.map(toDurableMatch),
    ));
  }

  async beginMatchStart(matchId: TournamentMatchId): Promise<TournamentMatch> {
    const match = await this.mapErrors(() => this.store.beginMatchStart(matchId));
    return fromDurableMatch(match);
  }

  async attachBattleInstance(
    matchId: TournamentMatchId,
    battleInstanceId: string,
  ): Promise<TournamentMatch> {
    const match = await this.mapErrors(
      () => this.store.attachBattleInstance(matchId, battleInstanceId),
    );
    return fromDurableMatch(match);
  }

  async markMatchActive(matchId: TournamentMatchId): Promise<TournamentMatch> {
    const match = await this.mapErrors(() => this.store.markMatchActive(matchId));
    return fromDurableMatch(match);
  }

  async interruptMatch(matchId: TournamentMatchId): Promise<TournamentMatch> {
    const match = await this.mapErrors(() => this.store.interruptMatch(matchId));
    return fromDurableMatch(match);
  }

  async commitMatchOutcome(input: MatchOutcomeInput): Promise<TournamentMatch> {
    const match = await this.mapErrors(() => this.store.commitMatchOutcome({
      match: toDurableMatch(input.match),
      ...(input.nextMatch ? { nextMatch: toDurableMatch(input.nextMatch) } : {}),
      ...(input.tournament ? { tournament: toDurableTournament(input.tournament) } : {}),
    }));
    return fromDurableMatch(match);
  }

  private async mapErrors<T>(work: () => Promise<T>, playerId?: string): Promise<T> {
    try {
      return await work();
    } catch (error) {
      remap(error, playerId);
    }
  }
}

export function isPostgresTournamentRepository(
  value: AsyncTournamentRepository,
): value is PostgresTournamentRepository {
  return value instanceof PostgresTournamentRepository;
}

export function assertTournamentBackendMatchesEconomics(
  economics: unknown,
  repository: AsyncTournamentRepository,
): void {
  if (economics instanceof PostgresEconomicsStore && !isPostgresTournamentRepository(repository)) {
    throw new Error(
      'PostgreSQL economics requires PostgreSQL tournament persistence. Use createApiServer().',
    );
  }
}

function toDurableTournament(tournament: Tournament): DurableTournament {
  return {
    id: tournament.id,
    title: tournament.title,
    format: tournament.format,
    ruleset: tournament.ruleset ?? 'gen9ou',
    maxPlayers: tournament.maxPlayers,
    bracketSeed: tournament.bracketSeed,
    matchTimeoutMs: tournament.matchTimeoutMs,
    status: tournament.status,
    hostId: tournament.hostId,
    entryFee: tournament.entryFee,
    ...(tournament.rail === undefined ? {} : { rail: tournament.rail }),
    ...(tournament.entryAtoms === undefined ? {} : { entryAtoms: tournament.entryAtoms }),
    ...(tournament.entryQuoteId === undefined ? {} : { entryQuoteId: tournament.entryQuoteId }),
    ...(tournament.prizeLamports === undefined ? {} : { prizeLamports: tournament.prizeLamports }),
    players: tournament.players.map(toDurablePlayer),
    matchIds: [...tournament.matchIds],
    ...(tournament.winner ? { winner: tournament.winner } : {}),
    createdAt: tournament.createdAt,
    updatedAt: tournament.updatedAt,
    ...(tournament.startedAt === undefined ? {} : { startedAt: tournament.startedAt }),
    ...(tournament.completedAt === undefined ? {} : { completedAt: tournament.completedAt }),
    ...(tournament.finalizesAt === undefined ? {} : { finalizesAt: tournament.finalizesAt }),
    ...(tournament.paymentEndsAt === undefined ? {} : { paymentEndsAt: tournament.paymentEndsAt }),
    ...(tournament.paymentPlayerId === undefined ? {} : { paymentPlayerId: tournament.paymentPlayerId }),
  };
}

function fromDurableTournament(tournament: DurableTournament): Tournament {
  return {
    id: tournament.id as TournamentId,
    title: tournament.title,
    format: tournament.format as SupportedFormat,
    ruleset: tournament.ruleset ?? 'gen9ou',
    maxPlayers: tournament.maxPlayers,
    bracketSeed: tournament.bracketSeed,
    matchTimeoutMs: tournament.matchTimeoutMs,
    status: tournament.status as TournamentStatus,
    hostId: tournament.hostId,
    entryFee: tournament.entryFee,
    ...(tournament.rail === undefined ? {} : { rail: tournament.rail }),
    ...(tournament.entryAtoms === undefined ? {} : { entryAtoms: tournament.entryAtoms }),
    ...(tournament.entryQuoteId === undefined ? {} : { entryQuoteId: tournament.entryQuoteId }),
    ...(tournament.prizeLamports === undefined ? {} : { prizeLamports: tournament.prizeLamports }),
    players: tournament.players.map(fromDurablePlayer),
    matchIds: tournament.matchIds.map(id => id as TournamentMatchId),
    ...(tournament.winner ? { winner: tournament.winner as TournamentPlayerId } : {}),
    createdAt: tournament.createdAt,
    updatedAt: tournament.updatedAt,
    ...(tournament.startedAt === undefined ? {} : { startedAt: tournament.startedAt }),
    ...(tournament.completedAt === undefined ? {} : { completedAt: tournament.completedAt }),
    ...(tournament.finalizesAt === undefined ? {} : { finalizesAt: tournament.finalizesAt }),
    ...(tournament.paymentEndsAt === undefined ? {} : { paymentEndsAt: tournament.paymentEndsAt }),
    ...(tournament.paymentPlayerId === undefined ? {} : { paymentPlayerId: tournament.paymentPlayerId as TournamentPlayerId }),
  };
}

function toDurablePlayer(player: TournamentPlayer): DurableTournamentPlayer {
  return {
    id: player.id,
    displayName: player.displayName,
    team: player.team,
    eligible: true,
    status: player.status,
    registrationOrder: player.registrationOrder,
    ...(player.teamLocked ? { teamLocked: true } : {}),
    ...(player.burnFeePaid ? { burnFeePaid: true } : {}),
  };
}

function fromDurablePlayer(player: DurableTournamentPlayer): TournamentPlayer {
  return {
    id: player.id as TournamentPlayerId,
    displayName: player.displayName,
    team: player.team,
    eligible: true,
    status: player.status,
    registrationOrder: player.registrationOrder,
    ...(player.teamLocked ? { teamLocked: true } : {}),
    ...(player.burnFeePaid ? { burnFeePaid: true } : {}),
  };
}

function toDurableMatch(match: TournamentMatch): DurableTournamentMatch {
  return {
    id: match.id,
    tournamentId: match.tournamentId,
    round: match.round,
    bracketPosition: match.bracketPosition,
    ...(match.player1 ? { player1: match.player1 } : {}),
    ...(match.player2 ? { player2: match.player2 } : {}),
    status: match.status,
    ...(match.battleInstanceId ? { battleInstanceId: match.battleInstanceId } : {}),
    ...(match.winner ? { winner: match.winner } : {}),
    ...(match.result ? { result: match.result } : {}),
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    ...(match.startedAt === undefined ? {} : { startedAt: match.startedAt }),
    ...(match.completedAt === undefined ? {} : { completedAt: match.completedAt }),
  };
}

function fromDurableMatch(match: DurableTournamentMatch): TournamentMatch {
  return {
    id: match.id as TournamentMatchId,
    tournamentId: match.tournamentId as TournamentId,
    round: match.round,
    bracketPosition: match.bracketPosition,
    ...(match.player1 ? { player1: match.player1 as TournamentPlayerId } : {}),
    ...(match.player2 ? { player2: match.player2 as TournamentPlayerId } : {}),
    status: match.status as TournamentMatch['status'],
    ...(match.battleInstanceId ? { battleInstanceId: match.battleInstanceId as TournamentMatch['battleInstanceId'] } : {}),
    ...(match.winner ? { winner: match.winner as TournamentPlayerId } : {}),
    ...(match.result ? { result: match.result as TournamentMatch['result'] } : {}),
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    ...(match.startedAt === undefined ? {} : { startedAt: match.startedAt }),
    ...(match.completedAt === undefined ? {} : { completedAt: match.completedAt }),
  };
}

function remap(error: unknown, playerId?: string): never {
  if (error instanceof TournamentError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/already registered/i.test(message)) {
    throw new DuplicateRegistrationError(playerId ?? '');
  }
  if (/registration is closed/i.test(message)) throw new RegistrationClosedError();
  if (/player limit/i.test(message)) {
    throw new TournamentError('Tournament player limit has been reached.');
  }
  const matchState = /^Cannot (.+) match (.+) in the "(.+)" state\.$/.exec(message);
  if (matchState) {
    throw new InvalidMatchStateError(matchState[2], matchState[3], matchState[1]);
  }
  const tournamentState = /^Cannot (.+) a tournament in the "(.+)" state\.$/.exec(message);
  if (tournamentState) {
    throw new InvalidTournamentStateTransitionError(tournamentState[2], tournamentState[1]);
  }
  if (message.startsWith('Unknown tournament match:')) {
    throw new UnknownMatchError(message.slice('Unknown tournament match: '.length));
  }
  if (message.startsWith('Unknown tournament:')) {
    throw new UnknownTournamentError(message.slice('Unknown tournament: '.length));
  }
  if (/different result/i.test(message)) {
    throw new InvalidMatchResultError('A completed match cannot receive a different result.');
  }
  if (error instanceof Error) throw error;
  throw new TournamentError('Request could not be processed.');
}
