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
  InMemoryAsyncTournamentRepository,
  type AsyncTournamentRepository,
} from './tournament-store';
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
  repository?: AsyncTournamentRepository;
  now?: () => number;
}

const DEFAULT_MATCH_TIMEOUT_MS = 15_000;
const COMPLETED_BATTLE_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_HOST_ID = 'test-host';

export class TournamentService {
  private readonly battleEngine: BattleEngine;
  private readonly repository: AsyncTournamentRepository;
  private readonly now: () => number;
  private readonly activeBattles = new Map<BattleInstanceId, ActiveBattle>();
  private readonly matchListeners = new Map<TournamentMatchId, Set<TournamentMatchListener>>();
  private readonly cleanupTimers = new Map<BattleInstanceId, NodeJS.Timeout>();
  private readonly terminalJobs = new Map<TournamentMatchId, Promise<void>>();

  constructor(options: TournamentServiceOptions = {}) {
    this.battleEngine = options.battleEngine ?? new BattleEngine();
    this.repository = options.repository ?? new InMemoryAsyncTournamentRepository();
    this.now = options.now ?? Date.now;
  }

  async createTournament(input: CreateTournamentInput): Promise<Tournament> {
    if (!input.title.trim()) throw new TournamentError('Tournament title is required.');
    if (![4, 8, 16, 32].includes(input.maxPlayers)) {
      throw new TournamentError('maxPlayers must be 4, 8, 16, or 32.');
    }
    if (
      input.matchTimeoutMs !== undefined &&
      (!Number.isFinite(input.matchTimeoutMs) || input.matchTimeoutMs <= 0)
    ) {
      throw new TournamentError('matchTimeoutMs must be a positive finite number.');
    }
    const hostId = input.hostId ?? DEFAULT_HOST_ID;
    if (!hostId.trim()) throw new TournamentError('Tournament host is required.');
    const entryFee = input.entryFee ?? 0;
    if (!Number.isInteger(entryFee) || entryFee < 0) {
      throw new TournamentError('entryFee must be a non-negative integer.');
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
      hostId,
      entryFee,
      ...(input.rail ? { rail: input.rail } : {}),
      ...(input.entryAtoms !== undefined ? { entryAtoms: input.entryAtoms } : {}),
      ...(input.entryQuoteId ? { entryQuoteId: input.entryQuoteId } : {}),
      ...(input.prizeLamports !== undefined ? { prizeLamports: input.prizeLamports } : {}),
      players: [],
      matchIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.saveTournament(tournament);
    return tournament;
  }

  async openRegistration(tournamentId: TournamentId): Promise<Tournament> {
    const tournament = await this.requireTournament(tournamentId);
    transitionTournament(tournament, 'registration', 'open registration', this.now());
    await this.repository.saveTournament(tournament);
    return tournament;
  }

  async registerPlayer(
    tournamentId: TournamentId,
    input: RegisterPlayerInput,
  ): Promise<TournamentPlayer> {
    if (!input.displayName.trim() || !input.team.trim()) {
      throw new TournamentError('Player display name and team are required.');
    }
    try {
      return await this.repository.registerPlayer(tournamentId, input);
    } catch (error) {
      remapPersistenceError(error, input.playerId);
    }
  }

  async withdrawPlayer(
    tournamentId: TournamentId,
    playerId: TournamentPlayerId,
  ): Promise<Tournament> {
    const tournament = await this.requireTournament(tournamentId);
    if (tournament.status !== 'registration') {
      throw new RegistrationClosedError();
    }
    const player = tournament.players.find(candidate => candidate.id === playerId);
    if (!player || player.status !== 'registered') {
      throw new TournamentError(`Player is not registered: ${playerId}`);
    }
    player.status = 'withdrawn';
    tournament.updatedAt = this.now();
    await this.repository.saveTournament(tournament);
    return tournament;
  }

  async prepareTournament(tournamentId: TournamentId): Promise<Tournament> {
    const tournament = await this.requireTournament(tournamentId);
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
    try {
      await this.repository.saveBracket(tournament, matches);
    } catch (error) {
      remapPersistenceError(error);
    }
    return (await this.requireTournament(tournamentId));
  }

  async startTournament(tournamentId: TournamentId): Promise<Tournament> {
    let tournament = await this.requireTournament(tournamentId);
    if (tournament.status === 'in-progress') return tournament;
    if (tournament.status === 'registration') {
      try {
        tournament = await this.prepareTournament(tournamentId);
      } catch (error) {
        const raced = await this.requireTournament(tournamentId);
        if (raced.status !== 'ready' && raced.status !== 'in-progress') throw error;
        tournament = raced;
      }
    }
    if (tournament.status === 'in-progress') return tournament;
    transitionTournament(tournament, 'in-progress', 'start tournament', this.now());
    tournament.startedAt = this.now();
    try {
      const matches = await this.repository.listMatches(tournament.id);
      await this.repository.saveBracket(tournament, matches);
    } catch (error) {
      const raced = await this.requireTournament(tournamentId);
      if (raced.status === 'in-progress') return raced;
      remapPersistenceError(error);
    }
    return this.requireTournament(tournamentId);
  }

  async cancelTournament(tournamentId: TournamentId): Promise<Tournament> {
    const tournament = await this.requireTournament(tournamentId);
    if (!['draft', 'registration', 'ready', 'in-progress'].includes(tournament.status)) {
      throw new InvalidTournamentStateTransitionError(tournament.status, 'cancel tournament');
    }
    tournament.status = 'cancelled';
    tournament.updatedAt = this.now();
    await this.repository.saveTournament(tournament);
    return tournament;
  }

  async getTournament(tournamentId: TournamentId): Promise<Tournament> {
    return this.requireTournament(tournamentId);
  }

  async listTournaments(): Promise<Tournament[]> {
    return this.repository.listTournaments();
  }

  async getBracket(tournamentId: TournamentId): Promise<TournamentMatch[]> {
    await this.requireTournament(tournamentId);
    return this.repository.listMatches(tournamentId);
  }

  async startMatch(matchId: TournamentMatchId): Promise<TournamentMatch> {
    let match: TournamentMatch;
    try {
      match = await this.repository.beginMatchStart(matchId);
    } catch (error) {
      remapPersistenceError(error);
    }
    const tournament = await this.requireTournament(match.tournamentId);
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
    try {
      match = await this.repository.attachBattleInstance(match.id, battleInstanceId);
    } catch (error) {
      remapPersistenceError(error);
    }

    const activeBattle: ActiveBattle = {
      battleInstanceId,
      engineBattleId: session.id,
      matchId: match.id,
      session,
      unsubscribe: () => undefined,
    };
    activeBattle.unsubscribe = session.subscribe(terminal => {
      void this.enqueueTerminal(match.id, battleInstanceId, terminal);
    });
    this.activeBattles.set(battleInstanceId, activeBattle);

    try {
      await session.start();
      await this.flushTerminal(match.id);
      const latest = await this.requireMatch(match.id);
      if (isSettledMatch(latest)) return latest;
      return this.repository.markMatchActive(match.id);
    } catch (error) {
      await this.flushTerminal(match.id);
      const latest = await this.requireMatch(match.id);
      if (isSettledMatch(latest)) return latest;
      if (latest.status === 'battle-created') throw error;
      return latest;
    }
  }

  async submitChoice(submission: TournamentChoiceSubmission): Promise<TournamentMatch> {
    const match = await this.requireMatch(submission.matchId);
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

  async applyBattleResult(
    matchId: TournamentMatchId,
    battleInstanceId: BattleInstanceId,
    result: BattleResult,
  ): Promise<TournamentMatch> {
    const match = await this.requireMatch(matchId);
    if (isSettledMatch(match)) {
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

    await this.completeWithBattleResult(match, result);
    return this.requireMatch(matchId);
  }

  async forfeitExpiredMatch(matchId: TournamentMatchId): Promise<TournamentMatch> {
    const match = await this.requireMatch(matchId);
    if (isSettledMatch(match)) return match;
    if (!match.battleInstanceId) {
      throw new InvalidMatchStateError(match.id, match.status, 'forfeit');
    }
    const activeBattle = this.requireActiveBattle(match.battleInstanceId);
    const result = activeBattle.session.getResult();
    if (result) {
      await this.completeWithBattleResult(match, result);
      return this.requireMatch(matchId);
    }
    if (activeBattle.session.getState().failure?.code !== 'timeout') {
      throw new InvalidMatchResultError('Match has not expired under the timeout policy.');
    }
    throw new InvalidMatchResultError('Timeout did not identify an inactive player.');
  }

  async forfeit(matchId: TournamentMatchId, playerId: string): Promise<TournamentMatch> {
    const match = await this.requireMatch(matchId);
    if (isSettledMatch(match)) return match;
    if (playerId !== match.player1 && playerId !== match.player2) {
      throw new InvalidMatchResultError('Player is not registered in this match.');
    }
    if (!match.battleInstanceId || (match.status !== 'active' && match.status !== 'battle-created')) {
      throw new InvalidMatchStateError(match.id, match.status, 'forfeit');
    }
    const activeBattle = this.requireActiveBattle(match.battleInstanceId);
    await activeBattle.session.forfeit(playerId);
    for (let attempt = 0; attempt < 10 && !isSettledMatch(await this.requireMatch(matchId)); attempt += 1) {
      await this.flushTerminal(matchId);
      await new Promise(resolve => setImmediate(resolve));
    }
    await this.flushTerminal(matchId);
    const settled = await this.requireMatch(matchId);
    if (!isSettledMatch(settled)) {
      throw new InvalidMatchResultError('Forfeit did not end the fight.');
    }
    return settled;
  }

  async getMatch(matchId: TournamentMatchId): Promise<TournamentMatchView> {
    const match = await this.requireMatch(matchId);
    const battle = match.battleInstanceId
      ? this.activeBattles.get(match.battleInstanceId)
      : undefined;
    return {
      match,
      ...(battle ? { battleState: battle.session.getState() } : {}),
    };
  }

  async getMatchState(
    matchId: TournamentMatchId,
    viewer: TournamentPlayerId | 'spectator',
  ): Promise<BattleState | undefined> {
    const match = await this.requireMatch(matchId);
    if (!match.battleInstanceId) return undefined;
    const activeBattle = this.activeBattles.get(match.battleInstanceId);
    if (!activeBattle) return undefined;
    return activeBattle.session.getState(viewer === 'spectator' ? 'spectator' : viewer);
  }

  async getMatchEvents(
    matchId: TournamentMatchId,
    viewer: TournamentPlayerId | 'spectator',
  ): Promise<TournamentMatchEvents> {
    const match = await this.requireMatch(matchId);
    if (!match.battleInstanceId) return { matchId, events: [] };
    const activeBattle = this.activeBattles.get(match.battleInstanceId);
    if (!activeBattle) return { matchId, events: [] };
    return {
      matchId,
      events: activeBattle.session.getEvents(viewer === 'spectator' ? 'spectator' : viewer),
    };
  }

  async getMatchView(
    matchId: TournamentMatchId,
    viewer: TournamentPlayerId | 'spectator',
  ): Promise<BattleView | undefined> {
    const match = await this.requireMatch(matchId);
    if (!match.battleInstanceId) return undefined;
    const activeBattle = this.activeBattles.get(match.battleInstanceId);
    if (!activeBattle) return undefined;
    return activeBattle.session.getView(viewer === 'spectator' ? 'spectator' : viewer);
  }

  async subscribeMatch(
    matchId: TournamentMatchId,
    listener: TournamentMatchListener,
  ): Promise<() => void> {
    const match = await this.requireMatch(matchId);
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
      ? activeBattle.session.subscribeEvents(() => {
        void this.requireMatch(matchId)
          .then(current => listener(current))
          .catch(() => undefined);
      })
      : () => undefined;
    if (isSettledMatch(match)) {
      queueMicrotask(() => listener(match));
    }
    return () => {
      listeners?.delete(listener);
      unsubscribeEvents();
      if (listeners?.size === 0) this.matchListeners.delete(matchId);
    };
  }

  async getTournamentResult(tournamentId: TournamentId): Promise<TournamentResult | undefined> {
    const tournament = await this.requireTournament(tournamentId);
    if (tournament.status !== 'completed' || !tournament.winner) return undefined;
    const matches = await this.repository.listMatches(tournament.id);
    const finalMatch = matches.find(match => (
      match.round === Math.max(...matches.map(item => item.round))
    ));
    if (!finalMatch) throw new TournamentError('Completed tournament has no final match.');
    return {
      tournamentId: tournament.id,
      winner: tournament.winner,
      finalMatchId: finalMatch.id,
      completedAt: tournament.completedAt!,
    };
  }

  private enqueueTerminal(
    matchId: TournamentMatchId,
    battleInstanceId: BattleInstanceId,
    terminal: BattleTerminal,
  ): Promise<void> {
    const previous = this.terminalJobs.get(matchId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handleBattleTerminal(matchId, battleInstanceId, terminal));
    this.terminalJobs.set(matchId, next);
    void next.catch(() => undefined);
    return next;
  }

  private async flushTerminal(matchId: TournamentMatchId): Promise<void> {
    const job = this.terminalJobs.get(matchId);
    if (job) await job;
  }

  private async handleBattleTerminal(
    matchId: TournamentMatchId,
    battleInstanceId: BattleInstanceId,
    terminal: BattleTerminal,
  ): Promise<void> {
    const match = await this.requireMatch(matchId);
    if (match.battleInstanceId && match.battleInstanceId !== battleInstanceId) return;
    if (terminal.type === 'completed') {
      await this.completeWithBattleResult(match, terminal.result);
    }
  }

  private async completeWithBattleResult(match: TournamentMatch, result: BattleResult): Promise<void> {
    const current = await this.requireMatch(match.id);
    if (isSettledMatch(current)) return;
    if (!current.player1 || !current.player2) {
      throw new InvalidMatchResultError('Match has no two players.');
    }
    if (result.status === 'tie' || !result.winner) {
      await this.completeAsTie(current, result);
      return;
    }
    if (result.winner !== current.player1 && result.winner !== current.player2) {
      throw new InvalidMatchResultError('Battle winner is not a player in this match.');
    }
    await this.completeMatch(current, result.winner as TournamentPlayerId, {
      kind: 'battle',
      battleResult: result,
    }, result.endedBy === 'timeout' ? 'forfeited' : 'completed');
  }

  private async completeAsTie(match: TournamentMatch, result: BattleResult): Promise<void> {
    const current = await this.requireMatch(match.id);
    if (isSettledMatch(current)) return;
    const timestamp = this.now();
    delete current.winner;
    current.result = { kind: 'battle', battleResult: result };
    current.status = 'tied';
    current.completedAt = timestamp;
    current.updatedAt = timestamp;
    try {
      await this.repository.commitMatchOutcome({ match: current });
    } catch (error) {
      remapPersistenceError(error);
    }
    const stored = await this.requireMatch(current.id);
    this.notifyMatchListeners(stored);
    this.matchListeners.delete(stored.id);
    this.scheduleBattleCleanup(stored.battleInstanceId);
  }

  private async completeMatch(
    match: TournamentMatch,
    winner: TournamentPlayerId,
    result: TournamentMatch['result'],
    status: 'completed' | 'forfeited',
  ): Promise<void> {
    const current = await this.requireMatch(match.id);
    if (isSettledMatch(current)) return;
    const timestamp = this.now();
    current.winner = winner;
    current.result = result;
    current.status = status;
    current.completedAt = timestamp;
    current.updatedAt = timestamp;

    const tournament = await this.requireTournament(current.tournamentId);
    const matches = await this.repository.listMatches(tournament.id);
    const finalRound = Math.max(...matches.map(candidate => candidate.round));
    let nextMatch: TournamentMatch | undefined;
    let completedTournament: Tournament | undefined;
    if (current.round === finalRound) {
      tournament.winner = winner;
      tournament.completedAt = timestamp;
      transitionTournament(tournament, 'completed', 'complete tournament', timestamp);
      completedTournament = tournament;
    } else {
      nextMatch = matches.find(candidate => (
        candidate.round === current.round + 1 &&
        candidate.bracketPosition === Math.floor(current.bracketPosition / 2)
      ));
      if (!nextMatch) throw new TournamentError('Could not find the next bracket match.');
      if (current.bracketPosition % 2 === 0) nextMatch.player1 = winner;
      else nextMatch.player2 = winner;
      if (nextMatch.player1 && nextMatch.player2 && nextMatch.status === 'pending') {
        nextMatch.status = 'ready';
      }
      nextMatch.updatedAt = timestamp;
    }

    try {
      await this.repository.commitMatchOutcome({
        match: current,
        ...(nextMatch ? { nextMatch } : {}),
        ...(completedTournament ? { tournament: completedTournament } : {}),
      });
    } catch (error) {
      remapPersistenceError(error);
    }
    const stored = await this.requireMatch(current.id);
    this.notifyMatchListeners(stored);
    this.matchListeners.delete(stored.id);
    this.scheduleBattleCleanup(stored.battleInstanceId);
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

  private async requireTournament(id: TournamentId): Promise<Tournament> {
    const tournament = await this.repository.getTournament(id);
    if (!tournament) throw new UnknownTournamentError(id);
    return tournament;
  }

  private async requireMatch(id: TournamentMatchId): Promise<TournamentMatch> {
    const match = await this.repository.getMatch(id);
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

function isSettledMatch(match: TournamentMatch): boolean {
  return match.status === 'completed' || match.status === 'forfeited' || match.status === 'tied';
}

function sameResult(left: BattleResult | undefined, right: BattleResult): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function remapPersistenceError(error: unknown, playerId?: string): never {
  if (
    error instanceof TournamentError
    || error instanceof DuplicateRegistrationError
  ) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/already registered/i.test(message)) {
    throw new DuplicateRegistrationError(playerId ?? extractSuffix(message));
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

function extractSuffix(message: string): string {
  const index = message.lastIndexOf(': ');
  return index === -1 ? '' : message.slice(index + 2);
}
