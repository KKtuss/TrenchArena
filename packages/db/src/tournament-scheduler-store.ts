import type { Pool, PoolClient } from 'pg';

export const TOURNAMENT_SCHEDULE_INTERVAL_MS = 30 * 60 * 1000;

export interface TournamentSchedulerState {
  enabled: boolean;
  nextTournamentStartAt?: number;
  nextRotationIndex: number;
}

export interface TournamentSchedulerStore {
  getState(): Promise<TournamentSchedulerState>;
  activate(now: number): Promise<TournamentSchedulerState>;
  disable(): Promise<TournamentSchedulerState>;
  withSchedulerLock<T>(work: (state: TournamentSchedulerState) => Promise<T>): Promise<T>;
  runDueStart<T>(
    now: number,
    work: (state: TournamentSchedulerState) => Promise<T>,
  ): Promise<T | undefined>;
  completeDueStart(rotationIndex: number): Promise<TournamentSchedulerState>;
}

const DEFAULT_STATE: TournamentSchedulerState = {
  enabled: false,
  nextRotationIndex: 0,
};

export class InMemoryTournamentSchedulerStore implements TournamentSchedulerStore {
  private state: TournamentSchedulerState = { ...DEFAULT_STATE };
  private lock: Promise<void> = Promise.resolve();

  async getState(): Promise<TournamentSchedulerState> {
    return { ...this.state };
  }

  async activate(now: number): Promise<TournamentSchedulerState> {
    return this.withSchedulerLock(async state => {
      if (state.enabled && state.nextTournamentStartAt !== undefined) return state;
      this.state = {
        ...state,
        enabled: true,
        nextTournamentStartAt: now + TOURNAMENT_SCHEDULE_INTERVAL_MS,
        nextRotationIndex: 0,
      };
      return { ...this.state };
    });
  }

  async disable(): Promise<TournamentSchedulerState> {
    return this.withSchedulerLock(async state => {
      this.state = { ...state, enabled: false, nextTournamentStartAt: undefined };
      return { ...this.state };
    });
  }

  async withSchedulerLock<T>(work: (state: TournamentSchedulerState) => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await work({ ...this.state });
    } finally {
      release();
    }
  }

  async runDueStart<T>(
    now: number,
    work: (state: TournamentSchedulerState) => Promise<T>,
  ): Promise<T | undefined> {
    return this.withSchedulerLock(async state => {
      if (
        !state.enabled
        || state.nextTournamentStartAt === undefined
        || state.nextTournamentStartAt > now
      ) {
        return undefined;
      }
      const result = await work(state);
      this.state = {
        ...state,
        nextTournamentStartAt: undefined,
        nextRotationIndex: state.nextRotationIndex + 1,
      };
      return result;
    });
  }

  async completeDueStart(rotationIndex: number): Promise<TournamentSchedulerState> {
    return this.withSchedulerLock(async state => {
      if (state.nextRotationIndex !== rotationIndex) {
        throw new Error('Tournament scheduler rotation changed while starting.');
      }
      this.state = {
        ...state,
        nextTournamentStartAt: undefined,
        nextRotationIndex: rotationIndex + 1,
      };
      return { ...this.state };
    });
  }

}

export class PostgresTournamentSchedulerStore implements TournamentSchedulerStore {
  private activeClient: PoolClient | undefined;

  constructor(private readonly pool: Pool) {}

  async getState(): Promise<TournamentSchedulerState> {
    return this.withClient(async client => {
      await this.ensureRow(client);
      return this.load(client);
    });
  }

  async activate(now: number): Promise<TournamentSchedulerState> {
    return this.withSchedulerLock(async state => {
      if (state.enabled && state.nextTournamentStartAt !== undefined) return state;
      const next = {
        ...state,
        enabled: true,
        nextTournamentStartAt: now + TOURNAMENT_SCHEDULE_INTERVAL_MS,
        nextRotationIndex: 0,
      };
      await this.update(next);
      return next;
    });
  }

  async disable(): Promise<TournamentSchedulerState> {
    return this.withSchedulerLock(async state => {
      const next = { ...state, enabled: false, nextTournamentStartAt: undefined };
      await this.update(next);
      return next;
    });
  }

  async withSchedulerLock<T>(work: (state: TournamentSchedulerState) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['pokearena:tournament-scheduler']);
      await this.ensureRow(client);
      const state = await this.load(client);
      this.activeClient = client;
      return await work(state);
    } finally {
      this.activeClient = undefined;
      await client.query(
        'SELECT pg_advisory_unlock(hashtext($1))',
        ['pokearena:tournament-scheduler'],
      ).catch(() => undefined);
      client.release();
    }
  }

  async completeDueStart(rotationIndex: number): Promise<TournamentSchedulerState> {
    return this.withSchedulerLock(async state => {
      if (state.nextRotationIndex !== rotationIndex) {
        throw new Error('Tournament scheduler rotation changed while starting.');
      }
      const next = {
        ...state,
        nextTournamentStartAt: undefined,
        nextRotationIndex: rotationIndex + 1,
      };
      await this.update(next);
      return next;
    });
  }

  async runDueStart<T>(
    now: number,
    work: (state: TournamentSchedulerState) => Promise<T>,
  ): Promise<T | undefined> {
    return this.withSchedulerLock(async state => {
      if (
        !state.enabled
        || state.nextTournamentStartAt === undefined
        || state.nextTournamentStartAt > now
      ) {
        return undefined;
      }
      const result = await work(state);
      const next = {
        ...state,
        nextTournamentStartAt: undefined,
        nextRotationIndex: state.nextRotationIndex + 1,
      };
      await this.update(next);
      return result;
    });
  }

  private async update(state: TournamentSchedulerState): Promise<void> {
    const queryClient = this.activeClient ?? this.pool;
    await queryClient.query(
      `UPDATE tournament_scheduler
       SET enabled = $1,
           next_tournament_start_at = $2,
           next_rotation_index = $3,
           updated_at = now()
       WHERE id = 1`,
      [
        state.enabled,
        state.nextTournamentStartAt === undefined ? null : new Date(state.nextTournamentStartAt),
        state.nextRotationIndex,
      ],
    );
  }

  private async ensureRow(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }): Promise<void> {
    await client.query(
      `INSERT INTO tournament_scheduler (id, enabled, next_tournament_start_at, next_rotation_index)
       VALUES (1, false, NULL, 0)
       ON CONFLICT (id) DO NOTHING`,
    );
  }

  private async load(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }): Promise<TournamentSchedulerState> {
    const result = await client.query(
      `SELECT enabled, next_tournament_start_at, next_rotation_index
       FROM tournament_scheduler WHERE id = 1`,
    );
    const row = result.rows[0];
    if (!row) return { ...DEFAULT_STATE };
    const date = row.next_tournament_start_at as Date | string | null;
    const timestamp = date === null ? undefined : new Date(date).getTime();
    return {
      enabled: row.enabled === true,
      ...(timestamp === undefined ? {} : { nextTournamentStartAt: timestamp }),
      nextRotationIndex: Number(row.next_rotation_index ?? 0),
    };
  }

  private async withClient<T>(work: (client: { query: (text: string, values?: unknown[]) => Promise<any> }) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
}
