import type {
  RegisterPlayerInput,
  Tournament,
  TournamentId,
  TournamentMatch,
  TournamentMatchId,
  TournamentPlayer,
} from './types';

import { nextTournamentAfterMatchCommit } from './bracket';
import { InMemoryTournamentRepository, type TournamentRepository } from './repository';

/**
 * Optional entry-fee ledger used by the in-memory async repository so API
 * tests keep a hold beside the registration without PostgreSQL.
 * Production registration uses `PostgresTournamentStore.registerPlayer`.
 */
export interface TournamentEntryLedger {
  reserve(holdKey: string, playerId: string, amount: number): Promise<boolean>;
  release(holdKey: string): Promise<number>;
}

export interface MatchOutcomeInput {
  match: TournamentMatch;
  nextMatch?: TournamentMatch;
  placementMatch?: TournamentMatch;
  tournament?: Tournament;
}

/**
 * Async tournament persistence boundary.
 * Host and entry fee live on `Tournament`; they are not API-only maps.
 */
export interface AsyncTournamentRepository {
  saveTournament(tournament: Tournament): Promise<void>;
  getTournament(id: TournamentId): Promise<Tournament | undefined>;
  listTournaments(): Promise<Tournament[]>;
  saveMatch(match: TournamentMatch): Promise<void>;
  getMatch(id: TournamentMatchId): Promise<TournamentMatch | undefined>;
  listMatches(tournamentId: TournamentId): Promise<TournamentMatch[]>;
  registerPlayer(tournamentId: TournamentId, input: RegisterPlayerInput): Promise<TournamentPlayer>;
  saveBracket(tournament: Tournament, matches: TournamentMatch[]): Promise<void>;
  beginMatchStart(matchId: TournamentMatchId): Promise<TournamentMatch>;
  attachBattleInstance(matchId: TournamentMatchId, battleInstanceId: string): Promise<TournamentMatch>;
  markMatchActive(matchId: TournamentMatchId): Promise<TournamentMatch>;
  interruptMatch(matchId: TournamentMatchId): Promise<TournamentMatch>;
  commitMatchOutcome(input: MatchOutcomeInput): Promise<TournamentMatch>;
}

export class InMemoryAsyncTournamentRepository implements AsyncTournamentRepository {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly inner: TournamentRepository;

  constructor(
    inner?: TournamentRepository,
    private readonly ledger?: TournamentEntryLedger,
  ) {
    this.inner = inner ?? new InMemoryTournamentRepository();
  }

  async saveTournament(tournament: Tournament): Promise<void> {
    await this.withLock(tournament.id, () => {
      this.inner.saveTournament(clone(tournament));
    });
  }

  async getTournament(id: TournamentId): Promise<Tournament | undefined> {
    const tournament = this.inner.getTournament(id);
    return tournament ? clone(tournament) : undefined;
  }

  async listTournaments(): Promise<Tournament[]> {
    return this.inner.listTournaments().map(tournament => clone(tournament));
  }

  async saveMatch(match: TournamentMatch): Promise<void> {
    await this.withLock(match.tournamentId, () => {
      const existing = this.inner.getMatch(match.id);
      if (existing && isTerminalMatch(existing.status) && !isTerminalMatch(match.status)) {
        const kept = clone(existing);
        if (match.battleInstanceId && !kept.battleInstanceId) {
          kept.battleInstanceId = match.battleInstanceId;
          this.inner.saveMatch(kept);
        }
        return;
      }
      this.inner.saveMatch(clone(match));
    });
  }

  async getMatch(id: TournamentMatchId): Promise<TournamentMatch | undefined> {
    const match = this.inner.getMatch(id);
    return match ? clone(match) : undefined;
  }

  async listMatches(tournamentId: TournamentId): Promise<TournamentMatch[]> {
    return this.inner.listMatches(tournamentId).map(match => clone(match));
  }

  async registerPlayer(
    tournamentId: TournamentId,
    input: RegisterPlayerInput,
  ): Promise<TournamentPlayer> {
    return this.withLock(tournamentId, async () => {
      const current = this.inner.getTournament(tournamentId);
      if (!current) throw new Error(`Unknown tournament: ${tournamentId}`);
      const tournament = clone(current);
      if (tournament.status !== 'registration') {
        throw new Error('Tournament registration is closed.');
      }
      const existing = tournament.players.find(player => player.id === input.playerId);
      if (existing && existing.status !== 'withdrawn') {
        throw new Error(`Player is already registered: ${input.playerId}`);
      }
      const isFull = tournament.players.filter(player => player.status === 'registered').length >= tournament.maxPlayers;
      if (!input.displayName.trim() || !input.team.trim()) {
        throw new Error('Player display name and team are required.');
      }

      const holdKey = `tournament:${tournamentId}:${input.playerId}`;
      let createdHold = false;
      if (tournament.entryFee > 0 && !isFull) {
        if (!this.ledger) {
          throw new Error('Tournament entry fee requires an economics ledger.');
        }
        createdHold = await this.ledger.reserve(holdKey, input.playerId, tournament.entryFee);
      }

      const registrationOrder = tournament.players.reduce(
        (max, player) => Math.max(max, player.registrationOrder),
        -1,
      ) + 1;
      const player: TournamentPlayer = {
        id: input.playerId,
        displayName: input.displayName,
        team: input.team,
        eligible: true,
        status: isFull ? 'waitlisted' : 'registered',
        registrationOrder,
        teamLocked: false,
        burnFeePaid: false,
      };
      try {
        if (existing) {
          Object.assign(existing, player);
        } else {
          tournament.players.push(player);
        }
        tournament.updatedAt = Date.now();
        this.inner.saveTournament(tournament);
      } catch (error) {
        if (createdHold) await this.ledger?.release(holdKey);
        throw error;
      }
      return clone(player);
    });
  }

  async saveBracket(tournament: Tournament, matches: TournamentMatch[]): Promise<void> {
    await this.withLock(tournament.id, () => {
      const current = this.inner.getTournament(tournament.id);
      if (!current) throw new Error(`Unknown tournament: ${tournament.id}`);
      if (current.status === 'in-progress' && tournament.status === 'in-progress') {
        return;
      }
      if (current.status !== 'registration' && current.status !== 'ready') {
        throw new Error(`Cannot prepare a tournament in the "${current.status}" state.`);
      }
      if (current.status === 'ready' && this.inner.listMatches(tournament.id).length > 0
        && tournament.status !== 'in-progress' && tournament.status !== 'ready') {
        throw new Error(`Cannot prepare a tournament in the "${current.status}" state.`);
      }
      if (current.status === 'ready' && tournament.status === 'ready') {
        return;
      }
      for (const match of matches) this.inner.saveMatch(clone(match));
      this.inner.saveTournament(clone(tournament));
    });
  }

  async beginMatchStart(matchId: TournamentMatchId): Promise<TournamentMatch> {
    const existing = this.inner.getMatch(matchId);
    if (!existing) throw new Error(`Unknown tournament match: ${matchId}`);
    return this.withLock(existing.tournamentId, () => {
      const match = this.inner.getMatch(matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      const tournament = this.inner.getTournament(match.tournamentId);
      if (!tournament) throw new Error(`Unknown tournament: ${match.tournamentId}`);
      if (tournament.status !== 'in-progress') {
        throw new Error(`Cannot start a tournament in the "${tournament.status}" state.`);
      }
      if (match.status !== 'ready' && match.status !== 'tied' && match.status !== 'interrupted') {
        throw new Error(`Cannot start match ${match.id} in the "${match.status}" state.`);
      }
      const timestamp = Date.now();
      delete match.winner;
      delete match.result;
      delete match.completedAt;
      delete match.battleInstanceId;
      match.status = 'battle-created';
      match.startedAt = timestamp;
      match.updatedAt = timestamp;
      this.inner.saveMatch(clone(match));
      return clone(match);
    });
  }

  async attachBattleInstance(
    matchId: TournamentMatchId,
    battleInstanceId: string,
  ): Promise<TournamentMatch> {
    const existing = this.inner.getMatch(matchId);
    if (!existing) throw new Error(`Unknown tournament match: ${matchId}`);
    return this.withLock(existing.tournamentId, () => {
      const match = this.inner.getMatch(matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      match.battleInstanceId = battleInstanceId as TournamentMatch['battleInstanceId'];
      match.updatedAt = Date.now();
      this.inner.saveMatch(clone(match));
      return clone(match);
    });
  }

  async markMatchActive(matchId: TournamentMatchId): Promise<TournamentMatch> {
    const existing = this.inner.getMatch(matchId);
    if (!existing) throw new Error(`Unknown tournament match: ${matchId}`);
    return this.withLock(existing.tournamentId, () => {
      const match = this.inner.getMatch(matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      if (match.status === 'battle-created') {
        match.status = 'active';
        match.updatedAt = Date.now();
        this.inner.saveMatch(clone(match));
      }
      return clone(match);
    });
  }

  async interruptMatch(matchId: TournamentMatchId): Promise<TournamentMatch> {
    const existing = this.inner.getMatch(matchId);
    if (!existing) throw new Error(`Unknown tournament match: ${matchId}`);
    return this.withLock(existing.tournamentId, () => {
      const match = this.inner.getMatch(matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      if (match.status !== 'battle-created' && match.status !== 'active') {
        return clone(match);
      }
      const timestamp = Date.now();
      delete match.winner;
      delete match.result;
      delete match.battleInstanceId;
      match.status = 'interrupted';
      match.completedAt = timestamp;
      match.updatedAt = timestamp;
      this.inner.saveMatch(clone(match));
      return clone(match);
    });
  }

  async commitMatchOutcome(input: MatchOutcomeInput): Promise<TournamentMatch> {
    return this.withLock(input.match.tournamentId, () => {
      const current = this.inner.getMatch(input.match.id);
      if (!current) throw new Error(`Unknown tournament match: ${input.match.id}`);
      if (isTerminalMatch(current.status)) {
        if (sameTerminal(current, input.match)) return clone(current);
        throw new Error('A completed match cannot receive a different result.');
      }
      this.inner.saveMatch(clone(input.match));
      if (input.nextMatch) {
        const existing = this.inner.getMatch(input.nextMatch.id);
        if (!existing) throw new Error(`Unknown tournament match: ${input.nextMatch.id}`);
        this.inner.saveMatch(mergePlacement(existing, input.nextMatch));
      }
      if (input.placementMatch) {
        const existing = this.inner.getMatch(input.placementMatch.id);
        if (!existing) throw new Error(`Unknown tournament match: ${input.placementMatch.id}`);
        this.inner.saveMatch(mergePlacement(existing, input.placementMatch));
      }
      const tournament = this.inner.getTournament(input.match.tournamentId);
      if (tournament) {
        const matches = tournament.matchIds
          .map(id => this.inner.getMatch(id))
          .filter((match): match is TournamentMatch => Boolean(match));
        const next = nextTournamentAfterMatchCommit(tournament, matches, Date.now());
        if (next) this.inner.saveTournament(clone(next));
      }
      return clone(input.match);
    });
  }

  private async withLock<T>(key: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.locks.set(key, previous.then(() => current));
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mergePlacement(existing: TournamentMatch, incoming: TournamentMatch): TournamentMatch {
  if (isTerminalMatch(existing.status)) return clone(existing);
  const player1 = incoming.player1 ?? existing.player1;
  const player2 = incoming.player2 ?? existing.player2;
  return {
    ...existing,
    ...(player1 ? { player1 } : {}),
    ...(player2 ? { player2 } : {}),
    status: existing.status === 'pending' && player1 && player2 ? 'ready' : existing.status,
    updatedAt: incoming.updatedAt,
  };
}

function isTerminalMatch(status: string): boolean {
  return status === 'completed' || status === 'forfeited' || status === 'tied';
}

function sameTerminal(left: TournamentMatch, right: TournamentMatch): boolean {
  return left.status === right.status
    && left.winner === right.winner
    && JSON.stringify(left.result) === JSON.stringify(right.result);
}
