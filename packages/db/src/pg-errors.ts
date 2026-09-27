interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

function asPgError(error: unknown): PgErrorLike | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return error as PgErrorLike;
}

/**
 * Map driver errors to existing domain messages. Never return raw SQL or
 * constraint names to callers that might forward them to WebSocket clients.
 */
export function mapPgError(error: unknown): Error {
  const pg = asPgError(error);
  if (!pg?.code) {
    return error instanceof Error ? error : new Error('Request could not be processed.');
  }
  if (pg.code === '23505') {
    const constraint = pg.constraint ?? '';
    if (constraint.includes('holds') || constraint.includes('hold_key')) {
      return new Error('Collateral hold already exists.');
    }
    if (constraint.includes('settlement')) {
      return new Error('Settlement already exists.');
    }
    if (constraint.includes('tournament_players') || constraint.includes('player_id')) {
      return new Error('Player is already registered.');
    }
    if (constraint.includes('wallets')) {
      return new Error('Wallet already exists.');
    }
    return new Error('Duplicate record.');
  }
  if (pg.code === '23514') {
    const constraint = pg.constraint ?? '';
    if (constraint.includes('balance') || constraint.includes('wallets')) {
      return new Error('Collateral exceeds development POKE balance.');
    }
    if (constraint.includes('holds_key') || constraint.includes('holds_purpose')) {
      return new Error('Collateral hold already exists.');
    }
    return new Error('Request could not be processed.');
  }
  if (pg.code === '23503') {
    return new Error('Referenced record does not exist.');
  }
  return new Error('Request could not be processed.');
}
