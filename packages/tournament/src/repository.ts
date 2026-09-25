import type {
  Tournament,
  TournamentId,
  TournamentMatch,
  TournamentMatchId,
} from './types';

export interface TournamentRepository {
  saveTournament(tournament: Tournament): void;
  getTournament(id: TournamentId): Tournament | undefined;
  listTournaments(): Tournament[];
  saveMatch(match: TournamentMatch): void;
  getMatch(id: TournamentMatchId): TournamentMatch | undefined;
  listMatches(tournamentId: TournamentId): TournamentMatch[];
}

export class InMemoryTournamentRepository implements TournamentRepository {
  private readonly tournaments = new Map<TournamentId, Tournament>();
  private readonly matches = new Map<TournamentMatchId, TournamentMatch>();

  saveTournament(tournament: Tournament): void {
    this.tournaments.set(tournament.id, tournament);
  }

  getTournament(id: TournamentId): Tournament | undefined {
    return this.tournaments.get(id);
  }

  listTournaments(): Tournament[] {
    return [...this.tournaments.values()]
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  saveMatch(match: TournamentMatch): void {
    this.matches.set(match.id, match);
  }

  getMatch(id: TournamentMatchId): TournamentMatch | undefined {
    return this.matches.get(id);
  }

  listMatches(tournamentId: TournamentId): TournamentMatch[] {
    return [...this.matches.values()]
      .filter(match => match.tournamentId === tournamentId)
      .sort((a, b) => a.round - b.round || a.bracketPosition - b.bracketPosition);
  }
}
