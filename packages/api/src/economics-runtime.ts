import {
  migrate,
  Pool,
  PostgresChainStore,
  PostgresEconomicsStore,
  PostgresTournamentStore,
} from '@pokearena/db';

export type EconomicsBackend = 'memory' | 'postgres';

export class EconomicsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EconomicsUnavailableError';
  }
}

export function resolveEconomicsBackend(
  env: NodeJS.ProcessEnv = process.env,
): EconomicsBackend {
  const explicit = env.POKEARENA_ECONOMICS;
  if (explicit === 'postgres') return 'postgres';
  if (explicit === 'memory') {
    if (env.NODE_ENV === 'production') {
      throw new EconomicsUnavailableError(
        'POKEARENA_ECONOMICS=memory is not allowed when NODE_ENV=production. Refusing in-memory economics.',
      );
    }
    return 'memory';
  }
  if (explicit) {
    throw new EconomicsUnavailableError(`Unknown POKEARENA_ECONOMICS value: ${explicit}`);
  }
  if (env.NODE_ENV === 'production') return 'postgres';
  return 'memory';
}

export function isPostgresEconomicsRequired(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveEconomicsBackend(env) === 'postgres';
}

export async function connectPostgresEconomics(env: NodeJS.ProcessEnv = process.env): Promise<{
  store: PostgresEconomicsStore;
  tournaments: PostgresTournamentStore;
  chain: PostgresChainStore;
  pool: Pool;
}> {
  const url = env.POKEARENA_DATABASE_URL ?? env.DATABASE_URL;
  if (!url) {
    throw new EconomicsUnavailableError(
      'POKEARENA_DATABASE_URL is required when PostgreSQL economics is enabled.',
    );
  }
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end().catch(() => undefined);
    throw new EconomicsUnavailableError(
      'PostgreSQL is required for production economics but is unavailable.',
    );
  }

  try {
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new EconomicsUnavailableError(
      `PokeArena database migrations could not be applied: ${detail}`,
    );
  }

  return {
    store: new PostgresEconomicsStore(pool),
    tournaments: new PostgresTournamentStore(pool),
    chain: new PostgresChainStore(pool),
    pool,
  };
}
