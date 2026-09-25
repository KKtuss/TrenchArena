import { randomUUID } from 'node:crypto';

import {
  BattleEngine,
  type BattleResult,
  type BattleSession,
  type BattleState,
  type BattleTerminal,
  type BattleView,
  type ChoiceSubmission,
} from '@pokearena/battle-engine';

import { buildSingleEliminationBracket } from './bracket';
import {
  DuplicateRegistrationError,
  InsufficientPlayersError,
  InvalidBattleInstanceError,
  InvalidBracketSizeError,
  InvalidMatchResultError,
  InvalidMatchStateError,
  InvalidTournamentStateTransitionError,
  RegistrationClosedError,
  UnknownMatchError,
  UnknownTournamentError,
  TournamentError,
} from './errors';
import {
  InMemoryTournamentRepository,
  type TournamentRepository,
} from './repository';
import type {
  BattleInstanceId,
  CreateTournamentInput,
  RegisterPlayerInput,
  Tournament,
  TournamentChoiceSubmission,
  TournamentId,
  TournamentMatch,
  TournamentMatchEvents,
  TournamentMatchId,
  TournamentMatchView,
  TournamentPlayer,
  TournamentPlayerId,
  TournamentResult,
  TournamentStatus,
} from './types';

type TimeoutForfeitPlayer = 'player1' | 'player2';

interface ActiveBattle {
  battleInstanceId: BattleInstanceId;
  engineBattleId: string;
  matchId: TournamentMatchId;
  session: BattleSession;
  unsubscribe: () => void;
}

export type TournamentMatchListener = (match: TournamentMatch) => void;

export interface TournamentServiceOptions {
  battleEngine?: BattleEngine;
  repository?: TournamentRepository;
  now?: () => number;
  timeoutForfeitPlayer?: TimeoutForfeitPlayer;
}

const DEFAULT_MATCH_TIMEOUT_MS = 15_000;
const COMPLETED_BATTLE_RETENTION_MS = 5 * 60 * 1000;

export class TournamentService {
  private readonly battleEngine: BattleEngine;
  private readonly repository: TournamentRepository;
  private readonly now: () => number;
  private readonly timeoutForfeitPlayer: TimeoutForfeitPlayer;
  private readonly activeBattles = new Map<BattleInstanceId, ActiveBattle>();
  private readonly matchListeners = new Map<TournamentMatchId, Set<TournamentMatchListener>>();
  private readonly cleanupTimers = new Map<BattleInstanceId, NodeJS.Timeout>();

  constructor(options: TournamentServiceOptions = {}) {
    this.battleEngine = options.battleEngine ?? new BattleEngine();
    this.repository = options.repository ?? new InMemoryTournamentRepository();
    this.now = options.now ?? Date.now;
    this.timeoutForfeitPlayer = options.timeoutForfeitPlayer ?? 'player1';
  }

  createTournament(input: CreateTournamentInput): Tournament {
    if (!input.title.trim()) throw new TournamentError('Tournament title is required.');
    if (![4, 8, 16].includes(input.maxPlayers)) {
      throw new TournamentError('maxPlayers must be 4, 8, or 16.');
    }
    if (
      input.matchTimeoutMs !== undefined &&
      (!Number.isFinite(input.matchTimeoutMs) || input.matchTimeoutMs <= 0)
    ) {
      throw new TournamentError('matchTimeoutMs must be a positive finite number.');
    }

    const timestamp = this.now();
    const tournament: Tournament = {
      id: randomUUID() as TournamentId,
      title: input.title,
      format: input.format,
      maxPlayers: input.maxPlayers,
      bracketSeed: input.bracketSeed ?? 'default',
      matchTimeoutMs: input.matchTimeoutMs ?? DEFAULT_MATCH_TIMEOUT_MS,
      status: 'draft',
      players: [],
      matchIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.repository.saveTournament(tournament);
    return tournament;
  }

  openRegistration(tournamentId: TournamentId): Tournament {
    const tournament = this.requireTournament(tournamentId);
    transitionTournament(tournament, 'registration', 'open registration', this.now());
    this.repository.saveTournament(tournament);
    return tournament;
  }

  registerPlayer(
    tournamentId: TournamentId,
    input: RegisterPlayerInput,
  ): TournamentPlayer {
    const tournament = this.requireTournament(tournamentId);
    if (tournament.status !== 'registration') {
      throw new RegistrationClosedError();
    }
    if (tournament.players.some(player => player.id === input.playerId)) {
      throw new DuplicateRegistrationError(input.playerId);
    }
    if (tournament.players.filter(player => player.status === 'registered').length >= tournament.maxPlayers) {
      throw new TournamentError('Tournament player limit has been reached.');
    }
    if (!input.displayName.trim() || !input.team.trim()) {
      throw new TournamentError('Player display name and team are required.');
    }

    const player: TournamentPlayer = {
      id: input.playerId,
      displayName: input.displayName,
      team: input.team,
      eligible: true,
      status: 'registered',
      registrationOrder: tournament.players.length,
    };
    tournament.players.push(player);
    tournament.updatedAt = this.now();
    this.repository.saveTournament(tournament);
    return player;
  }

  withdrawPlayer(
    tournamentId: TournamentId,
    playerId: TournamentPlayerId,
  ): Tournament {
    const tournament = this.requireTournament(tournamentId);
    if (tournament.status !== 'registration') {
      throw new RegistrationClosedError();
    }
    const player = tournament.players.find(candidate => candidate.id === playerId);
    if (!player || player.status !== 'registered') {
      throw new TournamentError(`Player is not registered: ${playerId}`);
    }
    player.status = 'withdrawn';
    tournament.updatedAt = this.now();
    this.repository.saveTournament(tournament);
    return tournament;
  }

  prepareTournament(tournamentId: TournamentId): Tournament {
    const tournament = this.requireTournament(tournamentId);
    if (tournament.status !== 'registration') {
      throw new InvalidTournamentStateTransitionError(tournament.status, 'prepare tournament');
    }

    const registered = tournament.players
      .filter(player => player.status === 'registered' && player.eligible)
      .sort((a, b) => a.registrationOrder - b.registrationOrder);
    validateBracketPlayerCount(registered.length);

    const matches = buildSingleEliminationBracket(
      tournament.id,
      registered.map(player => player.id),
      tournament.bracketSeed,
      this.now(),
      () => randomUUID() as TournamentMatchId,
    );
    tournament.matchIds = matches.map(match => match.id);
    tournament.status = 'ready';
    tournament.updatedAt = this.now();
    for (const match of matches) this.repository.saveMatch(match);
    this.repository.saveTournament(tournament);
    return tournament;
  }

  startTournament(tournamentId: TournamentId): Tournament {
    let tournament = this.requireTournament(tournamentId);
    if (tournament.status === 'registration') {
      tournament = this.prepareTournament(tournamentId);
    }
    transitionTournament(tournament, 'in-progress', 'start tournament', this.now());
    tournament.startedAt = this.now();
    this.repository.saveTournament(tournament);
    return tournament;
  }

  cancelTournament(tournamentId: TournamentId): Tournament {
    const tournament = this.requireTournament(tournamentId);
    if (!['draft', 'registration', 'ready', 'in-progress'].includes(tournament.status)) {
      throw new InvalidTournamentStateTransitionError(tournament.status, 'cancel tournament');
    }
    tournament.status = 'cancelled';
    tournament.updatedAt = this.now();
    this.repository.saveTournament(tournament);
    return tournament;
  }

  getTournament(tournamentId: TournamentId): Tournament {
    const tournament = this.requireTournament(tournamentId);
    return tournament;
  }

  listTournaments(): Tournament[] {
    return this.repository.listTournaments();
  }

  getBracket(tournamentId: TournamentId): TournamentMatch[] {
    const tournament = this.requireTournament(tournamentId);
    return this.repository.listMatches(tournament.id);
  }

  async startMatch(matchId: TournamentMatchId): Promise<TournamentMatch> {
    const match = this.requireMatch(matchId);
    const tournament = this.requireTournament(match.tournamentId);
    if (tournament.status !== 'in-progress') {
      throw new InvalidTournamentStateTransitionError(tournament.status, 'start match');
    }
    if (match.status !== 'ready') {
      throw new InvalidMatchStateError(match.id, match.status, 'start');
    }
    if (!match.player1 || !match.player2) {
      throw new TournamentError('Match is missing a player.');
    }

    const player1 = this.requireRegisteredPlayer(tournament, match.player1);
    const player2 = this.requireRegisteredPlayer(tournament, match.player2);
    const session = await this.battleEngine.createBattle({
      format: tournament.format,
      players: [
        { id: player1.id, name: player1.displayName },
        { id: player2.id, name: player2.displayName },
      ],
      teams: [player1.team, player2.team],
      seed: matchSeed(tournament.bracketSeed, match.round, match.bracketPosition),
      timeoutMs: tournament.matchTimeoutMs,
    });

    const battleInstanceId = randomUUID() as BattleInstanceId;
    const activeBattle: ActiveBattle = {
      battleInstanceId,
      engineBattleId: session.id,
      matchId: match.id,
      session,
      unsubscribe: () => undefined,
    };
    activeBattle.unsubscribe = session.subscribe(terminal => {
      this.handleBattleTerminal(match.id, battleInstanceId, terminal);
    });
    this.activeBattles.set(battleInstanceId, activeBattle);
    match.battleInstanceId = battleInstanceId;
    match.status = 'battle-created';
    match.startedAt = this.now();
    match.updatedAt = this.now();
    this.repository.saveMatch(match);

    try {
      await session.start();
      match.status = 'active';
      match.updatedAt = this.now();
      this.repository.saveMatch(match);
    } catch (error) {
      if (
        session.getState().failure?.code === 'timeout' &&
        match.status === 'battle-created'
      ) {
        this.completeByForfeit(match);
      }
      if (match.status === 'battle-created') throw error;
    }
    return match;
  }

  async submitChoice(submission: TournamentChoiceSubmission): Promise<TournamentMatch> {
    const match = this.requireMatch(submission.matchId);
    if (match.status !== 'active' || !match.battleInstanceId) {
      throw new InvalidMatchStateError(match.id, match.status, 'submit a choice to');
    }
    if (match.battleInstanceId !== submission.battleInstanceId) {
      throw new InvalidBattleInstanceError();
    }
    if (submission.playerId !== match.player1 && submission.playerId !== match.player2) {
      throw new InvalidMatchResultError('Player is not registered in this match.');
    }

    const activeBattle = this.requireActiveBattle(match.battleInstanceId);
    const battleSubmission: ChoiceSubmission = {
      battleId: activeBattle.engineBattleId,
      playerId: submission.playerId,
      revision: submission.revision,
      choice: submission.choice,
    };
    await activeBattle.session.submitChoice(battleSubmission);
    return match;
  }

  applyBattleResult(
    matchId: TournamentMatchId,
    battleInstanceId: BattleInstanceId,
    result: BattleResult,
  ): TournamentMatch {
    const match = this.requireMatch(matchId);
    if (match.status === 'completed' || match.status === 'forfeited') {
      if (sameResult(match.result?.kind === 'battle' ? match.result.battleResult : undefined, result)) {
        return match;
      }
      throw new InvalidMatchResultError('A completed match cannot receive a different result.');
    }
    if (match.status !== 'active' || match.battleInstanceId !== battleInstanceId) {
      throw new InvalidMatchStateError(match.id, match.status, 'apply a result to');
    }

    const activeBattle = this.requireActiveBattle(battleInstanceId);
    const authoritative = activeBattle.session.getResult();
    if (!authoritative || !sameResult(authoritative, result)) {
      throw new InvalidMatchResultError('Result does not match BattleEngine authority.');
    }

    this.completeWithBattleResult(match, result);
    return match;
  }

  forfeitExpiredMatch(matchId: TournamentMatchId): TournamentMatch {
    const match = this.requireMatch(matchId);
    if (match.status === 'forfeited' || match.status === 'completed') return match;
    if (!match.battleInstanceId) {
      throw new InvalidMatchStateError(match.id, match.status, 'forfeit');
    }
    const activeBattle = this.requireActiveBattle(match.battleInstanceId);
    if (activeBattle.session.getState().failure?.code !== 'timeout') {
      throw new InvalidMatchResultError('Match has not expired under the timeout policy.');
    }
    this.completeByForfeit(match);
    return match;
  }

  getMatch(matchId: TournamentMatchId): TournamentMatchView {
    const match = this.requireMatch(matchId);
    const battle = match.battleInstanceId
      ? this.activeBattles.get(match.battleInstanceId)
      : undefined;
    return {
      match,
      ...(battle ? { battleState: battle.session.getState() } : {}),
    };
  }

  getMatchState(
    matchId: TournamentMatchId,
    viewer: TournamentPlayerId | 'spectator',
  ): BattleState | undefined {
    const match = this.requireMatch(matchId);
    if (!match.battleInstanceId) return undefined;
    const activeBattle = this.requireActiveBattle(match.battleInstanceId);
    return activeBattle.session.getState(viewer === 'spectator' ? 'spectator' : viewer);
  }

  getMatchEvents(
    matchId: TournamentMatchId,
    viewer: TournamentPlayerId | 'spectator',
  ): TournamentMatchEvents {
    const match = this.requireMatch(matchId);
    if (!match.battleInstanceId) return { matchId, events: [] };
    const activeBattle = this.requireActiveBattle(match.battleInstanceId);
    return {
      matchId,
      events: activeBattle.session.getEvents(viewer === 'spectator' ? 'spectator' : viewer),
    };
  }

  getMatchView(
    matchId: TournamentMatchId,
    viewer: TournamentPlayerId | 'spectator',
  ): BattleView | undefined {
    const match = this.requireMatch(matchId);
    if (!match.battleInstanceId) return undefined;
    const activeBattle = this.requireActiveBattle(match.battleInstanceId);
    return activeBattle.session.getView(viewer === 'spectator' ? 'spectator' : viewer);
  }

  subscribeMatch(
    matchId: TournamentMatchId,
    listener: TournamentMatchListener,
  ): () => void {
    const match = this.requireMatch(matchId);
    let listeners = this.matchListeners.get(matchId);
    if (!listeners) {
      listeners = new Set();
      this.matchListeners.set(matchId, listeners);
    }
    listeners.add(listener);
    const activeBattle = match.battleInstanceId
      ? this.activeBattles.get(match.battleInstanceId)
      : undefined;
    const unsubscribeEvents = activeBattle
      ? activeBattle.session.subscribeEvents(() => queueMicrotask(() => listener(match)))
      : () => undefined;
    if (match.status === 'completed' || match.status === 'forfeited') {
      queueMicrotask(() => listener(match));
    }
    return () => {
      listeners?.delete(listener);
      unsubscribeEvents();
      if (listeners?.size === 0) this.matchListeners.delete(matchId);
    };
  }

  getTournamentResult(tournamentId: TournamentId): TournamentResult | undefined {
    const tournament = this.requireTournament(tournamentId);
    if (tournament.status !== 'completed' || !tournament.winner) return undefined;
    const finalMatch = this.repository.listMatches(tournament.id)
      .find(match => match.round === Math.max(...this.repository.listMatches(tournament.id).map(item => item.round)));
    if (!finalMatch) throw new TournamentError('Completed tournament has no final match.');
    return {
      tournamentId: tournament.id,
      winner: tournament.winner,
      finalMatchId: finalMatch.id,
      completedAt: tournament.completedAt!,
    };
  }

  private handleBattleTerminal(
    matchId: TournamentMatchId,
    battleInstanceId: BattleInstanceId,
    terminal: BattleTerminal,
  ): void {
    const match = this.requireMatch(matchId);
    if (match.battleInstanceId !== battleInstanceId) return;
    if (terminal.type === 'completed') {
      this.completeWithBattleResult(match, terminal.result);
    } else if (terminal.failure.code === 'timeout') {
      this.completeByForfeit(match);
    }
  }

  private completeWithBattleResult(match: TournamentMatch, result: BattleResult): void {
    if (match.status === 'completed' || match.status === 'forfeited') return;
    if (!match.player1 || !match.player2) {
      throw new InvalidMatchResultError('Match has no two players.');
    }
    const winner = result.status === 'tie'
      ? match.player1
      : result.winner as TournamentPlayerId | undefined;
    if (winner !== match.player1 && winner !== match.player2) {
      throw new InvalidMatchResultError('Battle winner is not a player in this match.');
    }
    this.completeMatch(match, winner, {
      kind: 'battle',
      battleResult: result,
    }, 'completed');
  }

  private completeByForfeit(match: TournamentMatch): void {
    if (match.status === 'completed' || match.status === 'forfeited') return;
    const loser = this.timeoutForfeitPlayer === 'player1' ? match.player1 : match.player2;
    const winner = loser === match.player1 ? match.player2 : match.player1;
    if (!loser || !winner) throw new InvalidMatchResultError('Cannot forfeit a match without two players.');
    this.completeMatch(match, winner, { kind: 'forfeit', reason: 'timeout' }, 'forfeited');
  }

  private completeMatch(
    match: TournamentMatch,
    winner: TournamentPlayerId,
    result: TournamentMatch['result'],
    status: 'completed' | 'forfeited',
  ): void {
    if (match.status === 'completed' || match.status === 'forfeited') return;
    const timestamp = this.now();
    match.winner = winner;
    match.result = result;
    match.status = status;
    match.completedAt = timestamp;
    match.updatedAt = timestamp;
    this.repository.saveMatch(match);
    this.notifyMatchListeners(match);
    this.matchListeners.delete(match.id);
    this.scheduleBattleCleanup(match.battleInstanceId);

    const tournament = this.requireTournament(match.tournamentId);
    const finalRound = Math.max(
      ...this.repository.listMatches(tournament.id).map(candidate => candidate.round),
    );
    if (match.round === finalRound) {
      tournament.winner = winner;
      tournament.completedAt = timestamp;
      transitionTournament(tournament, 'completed', 'complete tournament', timestamp);
      this.repository.saveTournament(tournament);
      return;
    }

    const nextMatch = this.repository.listMatches(tournament.id).find(candidate => (
      candidate.round === match.round + 1 &&
      candidate.bracketPosition === Math.floor(match.bracketPosition / 2)
    ));
    if (!nextMatch) throw new TournamentError('Could not find the next bracket match.');
    if (match.bracketPosition % 2 === 0) nextMatch.player1 = winner;
    else nextMatch.player2 = winner;
    if (nextMatch.player1 && nextMatch.player2 && nextMatch.status === 'pending') {
      nextMatch.status = 'ready';
    }
    nextMatch.updatedAt = timestamp;
    this.repository.saveMatch(nextMatch);
  }

  private notifyMatchListeners(match: TournamentMatch): void {
    for (const listener of this.matchListeners.get(match.id) ?? []) {
      queueMicrotask(() => listener(match));
    }
  }

  private scheduleBattleCleanup(battleInstanceId: BattleInstanceId | undefined): void {
    if (!battleInstanceId || this.cleanupTimers.has(battleInstanceId)) return;
    const timer = setTimeout(() => {
      const activeBattle = this.activeBattles.get(battleInstanceId);
      activeBattle?.unsubscribe();
      this.activeBattles.delete(battleInstanceId);
      this.cleanupTimers.delete(battleInstanceId);
    }, COMPLETED_BATTLE_RETENTION_MS);
    timer.unref?.();
    this.cleanupTimers.set(battleInstanceId, timer);
  }

  private requireTournament(id: TournamentId): Tournament {
    const tournament = this.repository.getTournament(id);
    if (!tournament) throw new UnknownTournamentError(id);
    return tournament;
  }

  private requireMatch(id: TournamentMatchId): TournamentMatch {
    const match = this.repository.getMatch(id);
    if (!match) throw new UnknownMatchError(id);
    return match;
  }

  private requireRegisteredPlayer(
    tournament: Tournament,
    playerId: TournamentPlayerId,
  ): TournamentPlayer {
    const player = tournament.players.find(candidate => (
      candidate.id === playerId && candidate.status === 'registered' && candidate.eligible
    ));
    if (!player) throw new TournamentError(`Player is not active in tournament: ${playerId}`);
    return player;
  }

  private requireActiveBattle(battleInstanceId: BattleInstanceId): ActiveBattle {
    const battle = this.activeBattles.get(battleInstanceId);
    if (!battle) throw new InvalidBattleInstanceError();
    return battle;
  }
}

function transitionTournament(
  tournament: Tournament,
  target: TournamentStatus,
  action: string,
  timestamp: number,
): void {
  const allowed: Record<TournamentStatus, readonly TournamentStatus[]> = {
    draft: ['registration', 'cancelled'],
    registration: ['ready', 'cancelled'],
    ready: ['in-progress', 'cancelled'],
    'in-progress': ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  if (!allowed[tournament.status].includes(target)) {
    throw new InvalidTournamentStateTransitionError(tournament.status, action);
  }
  tournament.status = target;
  tournament.updatedAt = timestamp;
}

function validateBracketPlayerCount(count: number): void {
  if (count < 2) throw new InsufficientPlayersError(count);
  if ((count & (count - 1)) !== 0) throw new InvalidBracketSizeError(count);
}

function matchSeed(seed: string, round: number, position: number): string {
  const base = hash(`${seed}:${round}:${position}`);
  return `${base},${base ^ 0x9E3779B9},${base + round},${base + position}`;
}

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function sameResult(left: BattleResult | undefined, right: BattleResult): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}
