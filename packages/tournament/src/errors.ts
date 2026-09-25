export class TournamentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TournamentError';
  }
}

export class UnknownTournamentError extends TournamentError {
  constructor(id: string) {
    super(`Unknown tournament: ${id}`);
    this.name = 'UnknownTournamentError';
  }
}

export class UnknownMatchError extends TournamentError {
  constructor(id: string) {
    super(`Unknown tournament match: ${id}`);
    this.name = 'UnknownMatchError';
  }
}

export class InvalidTournamentStateTransitionError extends TournamentError {
  constructor(from: string, action: string) {
    super(`Cannot ${action} a tournament in the "${from}" state.`);
    this.name = 'InvalidTournamentStateTransitionError';
  }
}

export class InvalidMatchStateError extends TournamentError {
  constructor(matchId: string, status: string, action: string) {
    super(`Cannot ${action} match ${matchId} in the "${status}" state.`);
    this.name = 'InvalidMatchStateError';
  }
}

export class DuplicateRegistrationError extends TournamentError {
  constructor(playerId: string) {
    super(`Player is already registered: ${playerId}`);
    this.name = 'DuplicateRegistrationError';
  }
}

export class RegistrationClosedError extends TournamentError {
  constructor() {
    super('Tournament registration is closed.');
    this.name = 'RegistrationClosedError';
  }
}

export class InsufficientPlayersError extends TournamentError {
  constructor(count: number) {
    super(`Tournament needs at least two players; received ${count}.`);
    this.name = 'InsufficientPlayersError';
  }
}

export class InvalidBracketSizeError extends TournamentError {
  constructor(count: number) {
    super(`Tournament player count must be a power of two; received ${count}.`);
    this.name = 'InvalidBracketSizeError';
  }
}

export class InvalidMatchResultError extends TournamentError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMatchResultError';
  }
}

export class InvalidBattleInstanceError extends TournamentError {
  constructor() {
    super('Battle instance does not belong to this match.');
    this.name = 'InvalidBattleInstanceError';
  }
}
