import type {
  DurableTournament,
  DurableTournamentMatch,
  DurableTournamentPlayer,
  MatchOutcomeInput,
  RegisterTournamentPlayerInput,
  TournamentStore,
} from './tournament-store';

export class InMemoryTournamentStore implements TournamentStore {
  private readonly tournaments = new Map<string, DurableTournament>();
  private readonly matches = new Map<string, DurableTournamentMatch>();
  private readonly locks = new Map<string, Promise<void>>();

  async saveTournament(tournament: DurableTournament): Promise<void> {
    await this.withLock(tournament.id, () => {
      this.tournaments.set(tournament.id, structuredClone(tournament));
    });
  }

  async getTournament(id: string): Promise<DurableTournament | undefined> {
    const tournament = this.tournaments.get(id);
    return tournament ? structuredClone(tournament) : undefined;
  }

  async listTournaments(): Promise<DurableTournament[]> {
    return [...this.tournaments.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(tournament => structuredClone(tournament));
  }

  async saveMatch(match: DurableTournamentMatch): Promise<void> {
    await this.withLock(match.tournamentId, () => {
      const existing = this.matches.get(match.id);
      if (existing && isTerminal(existing.status) && !isTerminal(match.status)) {
        if (match.battleInstanceId && !existing.battleInstanceId) {
          existing.battleInstanceId = match.battleInstanceId;
        }
        return;
      }
      this.matches.set(match.id, structuredClone(match));
      const tournament = this.tournaments.get(match.tournamentId);
      if (tournament && !tournament.matchIds.includes(match.id)) {
        tournament.matchIds = [...tournament.matchIds, match.id];
      }
    });
  }

  async getMatch(id: string): Promise<DurableTournamentMatch | undefined> {
    const match = this.matches.get(id);
    return match ? structuredClone(match) : undefined;
  }

  async listMatches(tournamentId: string): Promise<DurableTournamentMatch[]> {
    return [...this.matches.values()]
      .filter(match => match.tournamentId === tournamentId)
      .sort((a, b) => a.round - b.round || a.bracketPosition - b.bracketPosition)
      .map(match => structuredClone(match));
  }

  async registerPlayer(input: RegisterTournamentPlayerInput): Promise<DurableTournamentPlayer> {
    return this.withLock(input.tournamentId, () => {
      const tournament = this.tournaments.get(input.tournamentId);
      if (!tournament) throw new Error(`Unknown tournament: ${input.tournamentId}`);
      if (tournament.status !== 'registration') {
        throw new Error('Tournament registration is closed.');
      }
      if (tournament.players.some(player => player.id === input.playerId)) {
        throw new Error(`Player is already registered: ${input.playerId}`);
      }
      if (tournament.players.filter(player => player.status === 'registered').length >= tournament.maxPlayers) {
        throw new Error('Tournament player limit has been reached.');
      }
      if (!input.displayName.trim() || !input.team.trim()) {
        throw new Error('Player display name and team are required.');
      }
      const player: DurableTournamentPlayer = {
        id: input.playerId,
        displayName: input.displayName,
        team: input.team,
        eligible: true,
        status: 'registered',
        registrationOrder: tournament.players.length,
      };
      tournament.players.push(player);
      tournament.updatedAt = Date.now();
      return structuredClone(player);
    });
  }

  async saveBracket(tournament: DurableTournament, matches: DurableTournamentMatch[]): Promise<void> {
    await this.withLock(tournament.id, () => {
      const current = this.tournaments.get(tournament.id);
      if (!current) throw new Error(`Unknown tournament: ${tournament.id}`);
      if (current.status === 'in-progress' && tournament.status === 'in-progress') return;
      if (current.status === 'ready' && tournament.status === 'ready') return;
      if (current.status !== 'registration' && !(current.status === 'ready' && tournament.status === 'in-progress')) {
        throw new Error(`Cannot prepare a tournament in the "${current.status}" state.`);
      }
      this.tournaments.set(tournament.id, structuredClone(tournament));
      for (const match of matches) this.matches.set(match.id, structuredClone(match));
    });
  }

  async beginMatchStart(matchId: string): Promise<DurableTournamentMatch> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new Error(`Unknown tournament match: ${matchId}`);
    return this.withLock(existing.tournamentId, () => {
      const match = this.matches.get(matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      const tournament = this.tournaments.get(match.tournamentId);
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
      return structuredClone(match);
    });
  }

  async attachBattleInstance(matchId: string, battleInstanceId: string): Promise<DurableTournamentMatch> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new Error(`Unknown tournament match: ${matchId}`);
    return this.withLock(existing.tournamentId, () => {
      const match = this.matches.get(matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      match.battleInstanceId = battleInstanceId;
      match.updatedAt = Date.now();
      return structuredClone(match);
    });
  }

  async markMatchActive(matchId: string): Promise<DurableTournamentMatch> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new Error(`Unknown tournament match: ${matchId}`);
    return this.withLock(existing.tournamentId, () => {
      const match = this.matches.get(matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      if (match.status === 'battle-created') {
        match.status = 'active';
        match.updatedAt = Date.now();
      }
      return structuredClone(match);
    });
  }

  async interruptMatch(matchId: string): Promise<DurableTournamentMatch> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new Error(`Unknown tournament match: ${matchId}`);
    return this.withLock(existing.tournamentId, () => {
      const match = this.matches.get(matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      if (match.status !== 'battle-created' && match.status !== 'active') {
        return structuredClone(match);
      }
      const timestamp = Date.now();
      delete match.winner;
      delete match.result;
      delete match.battleInstanceId;
      match.status = 'interrupted';
      match.completedAt = timestamp;
      match.updatedAt = timestamp;
      return structuredClone(match);
    });
  }

  async commitMatchOutcome(input: MatchOutcomeInput): Promise<DurableTournamentMatch> {
    return this.withLock(input.match.tournamentId, () => {
      const current = this.matches.get(input.match.id);
      if (!current) throw new Error(`Unknown tournament match: ${input.match.id}`);
      if (isTerminal(current.status)) {
        if (sameTerminal(current, input.match)) return structuredClone(current);
        throw new Error('A completed match cannot receive a different result.');
      }
      this.matches.set(input.match.id, structuredClone(input.match));
      if (input.nextMatch) this.matches.set(input.nextMatch.id, structuredClone(input.nextMatch));
      if (input.tournament) this.tournaments.set(input.tournament.id, structuredClone(input.tournament));
      return structuredClone(input.match);
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

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'forfeited' || status === 'tied';
}

function sameTerminal(left: DurableTournamentMatch, right: DurableTournamentMatch): boolean {
  return left.status === right.status
    && left.winner === right.winner
    && JSON.stringify(left.result) === JSON.stringify(right.result);
}
