export class BattleEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BattleEngineError';
  }
}

export class InvalidLifecycleTransitionError extends BattleEngineError {
  constructor(from: string, action: string) {
    super(`Cannot ${action} a battle in the "${from}" state.`);
    this.name = 'InvalidLifecycleTransitionError';
  }
}

export class UnknownBattleError extends BattleEngineError {
  constructor(battleId: string) {
    super(`Unknown battle: ${battleId}`);
    this.name = 'UnknownBattleError';
  }
}

export class UnknownPlayerError extends BattleEngineError {
  constructor(playerId: string) {
    super(`Unknown player: ${playerId}`);
    this.name = 'UnknownPlayerError';
  }
}

export class WrongBattleError extends BattleEngineError {
  constructor(battleId: string) {
    super(`Choice belongs to a different battle: ${battleId}`);
    this.name = 'WrongBattleError';
  }
}

export class StaleChoiceError extends BattleEngineError {
  constructor(playerId: string, revision: number) {
    super(`Choice revision ${revision} is stale for player ${playerId}.`);
    this.name = 'StaleChoiceError';
  }
}

export class InvalidChoiceError extends BattleEngineError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidChoiceError';
  }
}

export class UnsupportedFormatError extends BattleEngineError {
  constructor(format: string) {
    super(`Unsupported battle format: ${format}`);
    this.name = 'UnsupportedFormatError';
  }
}

export class TeamValidationError extends BattleEngineError {
  constructor(message: string) {
    super(message);
    this.name = 'TeamValidationError';
  }
}

export class BattleTimeoutError extends BattleEngineError {
  constructor(timeoutMs: number) {
    super(`Battle exceeded its ${timeoutMs}ms timeout.`);
    this.name = 'BattleTimeoutError';
  }
}

export class ReplayMismatchError extends BattleEngineError {
  constructor(expected: unknown, actual: unknown) {
    super([
      'Replay result differs from the recorded result.',
      `Expected: ${JSON.stringify(expected)}`,
      `Actual: ${JSON.stringify(actual)}`,
    ].join('\n'));
    this.name = 'ReplayMismatchError';
  }
}
