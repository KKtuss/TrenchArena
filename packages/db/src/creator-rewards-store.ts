import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type CreatorRewardOperationKind = 'claim_cards' | 'sweep_cards' | 'fund_tournament' | 'operator_claim';
export type CreatorRewardOperationStatus = 'pending' | 'unknown' | 'confirmed' | 'failed';

export interface CreatorRewardOperation {
  id: string;
  operationKey: string;
  kind: CreatorRewardOperationKind;
  status: CreatorRewardOperationStatus;
  signature?: string;
  amountRaw: number;
  metadata: Record<string, unknown>;
}

export interface CreatorRewardLedger {
  cardsMint: string;
  grossRaw: number;
  tournamentAllocatedRaw: number;
  operatorAllocatedRaw: number;
  operatorClaimedRaw: number;
  tournamentCommittedRaw: number;
}

export interface CreatorRewardCreditInput {
  operationKey: string;
  cardsMint: string;
  grossRaw: number;
  tournamentRaw: number;
  operatorRaw: number;
}

export interface CreatorRewardReservationInput {
  operationKey: string;
  cardsMint: string;
  tournamentId: string;
  amountRaw: number;
  metadata?: Record<string, unknown>;
}

export interface CreatorRewardOperatorClaimInput {
  cardsMint: string;
  destination: string;
  metadata?: Record<string, unknown>;
}

export interface CreatorRewardsStore {
  getOpen(): Promise<CreatorRewardOperation | undefined>;
  listOpen(): Promise<CreatorRewardOperation[]>;
  getByKey(operationKey: string): Promise<CreatorRewardOperation | undefined>;
  getLedger(cardsMint: string): Promise<CreatorRewardLedger | undefined>;
  withOperation?<T>(key: string, run: () => Promise<T>): Promise<T>;
  create(input: {
    operationKey: string;
    kind: CreatorRewardOperationKind;
    amountRaw: number;
    metadata?: Record<string, unknown>;
  }): Promise<CreatorRewardOperation>;
  update(
    operationKey: string,
    patch: {
      status?: CreatorRewardOperationStatus;
      signature?: string;
      amountRaw?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CreatorRewardOperation>;
  creditConfirmedClaim(input: CreatorRewardCreditInput): Promise<CreatorRewardLedger>;
  reserveTournamentFunding(input: CreatorRewardReservationInput): Promise<CreatorRewardOperation>;
  failFunding(operationKey: string): Promise<CreatorRewardOperation>;
  reserveOperatorClaim(
    input: CreatorRewardOperatorClaimInput,
  ): Promise<CreatorRewardOperation | undefined>;
  confirmOperatorClaim(operationKey: string, signature: string): Promise<CreatorRewardOperation>;
}

function amountToPg(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Creator reward amount must be a non-negative safe integer.');
  }
  return String(value);
}

function mapLedger(row: Record<string, unknown>): CreatorRewardLedger {
  return {
    cardsMint: String(row.cards_mint),
    grossRaw: Number(row.gross_raw),
    tournamentAllocatedRaw: Number(row.tournament_allocated_raw),
    operatorAllocatedRaw: Number(row.operator_allocated_raw),
    operatorClaimedRaw: Number(row.operator_claimed_raw ?? 0),
    tournamentCommittedRaw: Number(row.tournament_committed_raw),
  };
}

function assertSplit(input: CreatorRewardCreditInput): void {
  if (input.tournamentRaw + input.operatorRaw !== input.grossRaw) {
    throw new Error('Creator reward allocation must add up to the gross amount.');
  }
}

function mapRow(row: Record<string, unknown>): CreatorRewardOperation {
  return {
    id: String(row.id),
    operationKey: String(row.operation_key),
    kind: row.kind as CreatorRewardOperationKind,
    status: row.status as CreatorRewardOperationStatus,
    ...(typeof row.signature === 'string' ? { signature: row.signature } : {}),
    amountRaw: Number(row.amount_raw),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

export class PostgresCreatorRewardsStore implements CreatorRewardsStore {
  constructor(private readonly pool: Pool) {}

  async withOperation<T>(key: string, run: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`creator_rewards:${key}`]);
      try {
        return await run();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`creator_rewards:${key}`]);
      }
    } finally {
      client.release();
    }
  }

  async getOpen(): Promise<CreatorRewardOperation | undefined> {
    const open = await this.listOpen();
    return open[0];
  }

  async listOpen(): Promise<CreatorRewardOperation[]> {
    const result = await this.pool.query(
      `SELECT * FROM creator_reward_operations
       WHERE status IN ('pending', 'unknown')
       ORDER BY created_at ASC`,
    );
    return result.rows.map(row => mapRow(row));
  }

  async getByKey(operationKey: string): Promise<CreatorRewardOperation | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM creator_reward_operations WHERE operation_key = $1`,
      [operationKey],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async create(input: {
    operationKey: string;
    kind: CreatorRewardOperationKind;
    amountRaw: number;
    metadata?: Record<string, unknown>;
  }): Promise<CreatorRewardOperation> {
    const result = await this.pool.query(
      `INSERT INTO creator_reward_operations (
         id, operation_key, kind, status, amount_raw, metadata
       ) VALUES ($1, $2, $3, 'pending', $4::bigint, $5::jsonb)
       ON CONFLICT (operation_key) DO UPDATE SET operation_key = EXCLUDED.operation_key
       RETURNING *`,
      [
        randomUUID(),
        input.operationKey,
        input.kind,
        amountToPg(input.amountRaw),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapRow(result.rows[0]);
  }

  async update(
    operationKey: string,
    patch: {
      status?: CreatorRewardOperationStatus;
      signature?: string;
      amountRaw?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CreatorRewardOperation> {
    const current = await this.getByKey(operationKey);
    if (!current) throw new Error(`Unknown creator reward operation: ${operationKey}`);
    const metadata = patch.metadata
      ? { ...current.metadata, ...patch.metadata }
      : current.metadata;
    const result = await this.pool.query(
      `UPDATE creator_reward_operations
       SET status = $2,
           signature = COALESCE($3, signature),
           amount_raw = $4::bigint,
           metadata = $5::jsonb,
           updated_at = now()
       WHERE operation_key = $1
       RETURNING *`,
      [
        operationKey,
        patch.status ?? current.status,
        patch.signature ?? null,
        amountToPg(patch.amountRaw ?? current.amountRaw),
        JSON.stringify(metadata),
      ],
    );
    return mapRow(result.rows[0]);
  }

  async getLedger(cardsMint: string): Promise<CreatorRewardLedger | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM creator_reward_ledger WHERE cards_mint = $1`,
      [cardsMint],
    );
    return result.rows[0] ? mapLedger(result.rows[0]) : undefined;
  }

  async creditConfirmedClaim(input: CreatorRewardCreditInput): Promise<CreatorRewardLedger> {
    assertSplit(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO creator_reward_credits (
           operation_key, cards_mint, gross_raw, tournament_raw, operator_raw
         ) VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [
          input.operationKey,
          input.cardsMint,
          amountToPg(input.grossRaw),
          amountToPg(input.tournamentRaw),
          amountToPg(input.operatorRaw),
        ],
      );
      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO creator_reward_ledger (
             cards_mint, gross_raw, tournament_allocated_raw, operator_allocated_raw, tournament_committed_raw
           ) VALUES ($1, $2::bigint, $3::bigint, $4::bigint, 0)
           ON CONFLICT (cards_mint) DO UPDATE SET
             gross_raw = creator_reward_ledger.gross_raw + EXCLUDED.gross_raw,
             tournament_allocated_raw = creator_reward_ledger.tournament_allocated_raw + EXCLUDED.tournament_allocated_raw,
             operator_allocated_raw = creator_reward_ledger.operator_allocated_raw + EXCLUDED.operator_allocated_raw,
             updated_at = now()`,
          [
            input.cardsMint,
            amountToPg(input.grossRaw),
            amountToPg(input.tournamentRaw),
            amountToPg(input.operatorRaw),
          ],
        );
      }
      const ledger = await client.query(
        `SELECT * FROM creator_reward_ledger WHERE cards_mint = $1`,
        [input.cardsMint],
      );
      await client.query('COMMIT');
      if (!ledger.rows[0]) throw new Error('Creator reward ledger is missing after credit.');
      return mapLedger(ledger.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveTournamentFunding(input: CreatorRewardReservationInput): Promise<CreatorRewardOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM creator_reward_operations WHERE operation_key = $1 FOR UPDATE`,
        [input.operationKey],
      );
      if (existing.rows[0]) {
        const operation = mapRow(existing.rows[0]);
        if (operation.status === 'failed') {
          throw new Error('Creator-reward transfer already failed and was not resent.');
        }
        await client.query('COMMIT');
        return operation;
      }
      const ledger = await client.query(
        `SELECT * FROM creator_reward_ledger WHERE cards_mint = $1 FOR UPDATE`,
        [input.cardsMint],
      );
      const row = ledger.rows[0] ? mapLedger(ledger.rows[0]) : undefined;
      const remaining = row ? row.tournamentAllocatedRaw - row.tournamentCommittedRaw : 0;
      if (!row || remaining < input.amountRaw) {
        throw new Error('Insufficient tournament CARDS allocation.');
      }
      await client.query(
        `UPDATE creator_reward_ledger
         SET tournament_committed_raw = tournament_committed_raw + $2::bigint,
             updated_at = now()
         WHERE cards_mint = $1
           AND tournament_allocated_raw - tournament_committed_raw >= $2::bigint`,
        [input.cardsMint, amountToPg(input.amountRaw)],
      );
      const created = await client.query(
        `INSERT INTO creator_reward_operations (
           id, operation_key, kind, status, amount_raw, metadata
         ) VALUES ($1, $2, 'fund_tournament', 'pending', $3::bigint, $4::jsonb)
         RETURNING *`,
        [
          randomUUID(),
          input.operationKey,
          amountToPg(input.amountRaw),
          JSON.stringify({
            ...(input.metadata ?? {}),
            cardsMint: input.cardsMint,
            tournamentId: input.tournamentId,
            amountRaw: input.amountRaw,
            reservationReleased: false,
          }),
        ],
      );
      await client.query('COMMIT');
      return mapRow(created.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      const pg = error as { code?: string };
      if (pg.code === '23505') {
        const raced = await this.getByKey(input.operationKey);
        if (raced && raced.status !== 'failed') return raced;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async failFunding(operationKey: string): Promise<CreatorRewardOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM creator_reward_operations WHERE operation_key = $1 FOR UPDATE`,
        [operationKey],
      );
      if (!existing.rows[0]) throw new Error(`Unknown creator reward operation: ${operationKey}`);
      const operation = mapRow(existing.rows[0]);
      if (operation.kind !== 'fund_tournament') {
        throw new Error('Only a tournament funding transfer can release a creator-reward reservation.');
      }
      if (operation.metadata.reservationReleased !== true) {
        const cardsMint = String(operation.metadata.cardsMint ?? '');
        const amount = Number(operation.metadata.amountRaw ?? operation.amountRaw);
        await client.query(
          `UPDATE creator_reward_ledger
           SET tournament_committed_raw = tournament_committed_raw - $2::bigint,
               updated_at = now()
           WHERE cards_mint = $1
             AND tournament_committed_raw >= $2::bigint`,
          [cardsMint, amountToPg(amount)],
        );
      }
      const metadata = { ...operation.metadata, reservationReleased: true };
      const result = await client.query(
        `UPDATE creator_reward_operations
         SET status = 'failed', metadata = $2::jsonb, updated_at = now()
         WHERE operation_key = $1
         RETURNING *`,
        [operationKey, JSON.stringify(metadata)],
      );
      await client.query('COMMIT');
      return mapRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveOperatorClaim(
    input: CreatorRewardOperatorClaimInput,
  ): Promise<CreatorRewardOperation | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ledgerResult = await client.query(
        `SELECT * FROM creator_reward_ledger WHERE cards_mint = $1 FOR UPDATE`,
        [input.cardsMint],
      );
      const ledger = ledgerResult.rows[0] ? mapLedger(ledgerResult.rows[0]) : undefined;
      const claimable = ledger
        ? ledger.operatorAllocatedRaw - ledger.operatorClaimedRaw
        : 0;
      if (!ledger || claimable <= 0) {
        await client.query('COMMIT');
        return undefined;
      }
      const operationKey = `operator-claim:${input.cardsMint}:${claimable}:${ledger.operatorClaimedRaw}`;
      const existing = await client.query(
        `SELECT * FROM creator_reward_operations WHERE operation_key = $1 FOR UPDATE`,
        [operationKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return mapRow(existing.rows[0]);
      }
      const created = await client.query(
        `INSERT INTO creator_reward_operations (
           id, operation_key, kind, status, amount_raw, metadata
         ) VALUES ($1, $2, 'operator_claim', 'pending', $3::bigint, $4::jsonb)
         RETURNING *`,
        [
          randomUUID(),
          operationKey,
          amountToPg(claimable),
          JSON.stringify({
            ...(input.metadata ?? {}),
            cardsMint: input.cardsMint,
            destination: input.destination,
            amountRaw: claimable,
            operatorClaimedBeforeRaw: ledger.operatorClaimedRaw,
          }),
        ],
      );
      await client.query('COMMIT');
      return mapRow(created.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async confirmOperatorClaim(operationKey: string, signature: string): Promise<CreatorRewardOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const operationResult = await client.query(
        `SELECT * FROM creator_reward_operations WHERE operation_key = $1 FOR UPDATE`,
        [operationKey],
      );
      if (!operationResult.rows[0]) {
        throw new Error(`Unknown creator reward operation: ${operationKey}`);
      }
      const operation = mapRow(operationResult.rows[0]);
      if (operation.kind !== 'operator_claim') {
        throw new Error('Only an operator claim can update operator allocation accounting.');
      }
      if (operation.status !== 'confirmed') {
        const cardsMint = String(operation.metadata.cardsMint ?? '');
        const amount = operation.amountRaw;
        const updated = await client.query(
          `UPDATE creator_reward_ledger
           SET operator_claimed_raw = operator_claimed_raw + $2::bigint,
               updated_at = now()
           WHERE cards_mint = $1
             AND operator_allocated_raw - operator_claimed_raw >= $2::bigint
           RETURNING *`,
          [cardsMint, amountToPg(amount)],
        );
        if (!updated.rows[0]) {
          throw new Error('Operator allocation is already claimed or insufficient.');
        }
        const result = await client.query(
          `UPDATE creator_reward_operations
           SET status = 'confirmed',
               signature = COALESCE(signature, $2),
               updated_at = now()
           WHERE operation_key = $1
           RETURNING *`,
          [operationKey, signature],
        );
        await client.query('COMMIT');
        return mapRow(result.rows[0]);
      }
      await client.query('COMMIT');
      return operation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class InMemoryCreatorRewardsStore implements CreatorRewardsStore {
  private readonly operations = new Map<string, CreatorRewardOperation>();
  private readonly ledgers = new Map<string, CreatorRewardLedger>();
  private readonly credits = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  private exclusive<T>(work: () => T): Promise<T> {
    const run = this.tail.then(() => work());
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async withOperation<T>(_key: string, run: () => Promise<T>): Promise<T> {
    // The worker owns the in-process queue. Re-entering `exclusive` here
    // would deadlock because the operation itself updates the in-memory
    // store through methods that already use that queue.
    return run();
  }

  async getOpen(): Promise<CreatorRewardOperation | undefined> {
    return [...this.operations.values()].find(operation => (
      operation.status === 'pending' || operation.status === 'unknown'
    ));
  }

  async listOpen(): Promise<CreatorRewardOperation[]> {
    return [...this.operations.values()].filter(operation => (
      operation.status === 'pending' || operation.status === 'unknown'
    ));
  }

  async getByKey(operationKey: string): Promise<CreatorRewardOperation | undefined> {
    return this.operations.get(operationKey);
  }

  async create(input: {
    operationKey: string;
    kind: CreatorRewardOperationKind;
    amountRaw: number;
    metadata?: Record<string, unknown>;
  }): Promise<CreatorRewardOperation> {
    const existing = this.operations.get(input.operationKey);
    if (existing) return existing;
    const operation: CreatorRewardOperation = {
      id: randomUUID(),
      operationKey: input.operationKey,
      kind: input.kind,
      status: 'pending',
      amountRaw: input.amountRaw,
      metadata: input.metadata ?? {},
    };
    this.operations.set(input.operationKey, operation);
    return operation;
  }

  async update(
    operationKey: string,
    patch: {
      status?: CreatorRewardOperationStatus;
      signature?: string;
      amountRaw?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CreatorRewardOperation> {
    const current = this.operations.get(operationKey);
    if (!current) throw new Error(`Unknown creator reward operation: ${operationKey}`);
    Object.assign(current, {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.signature ? { signature: patch.signature } : {}),
      ...(patch.amountRaw !== undefined ? { amountRaw: patch.amountRaw } : {}),
      ...(patch.metadata ? { metadata: { ...current.metadata, ...patch.metadata } } : {}),
    });
    return current;
  }

  async getLedger(cardsMint: string): Promise<CreatorRewardLedger | undefined> {
    const ledger = this.ledgers.get(cardsMint);
    return ledger ? { ...ledger } : undefined;
  }

  async creditConfirmedClaim(input: CreatorRewardCreditInput): Promise<CreatorRewardLedger> {
    assertSplit(input);
    return this.exclusive(() => {
      if (!this.credits.has(input.operationKey)) {
        this.credits.add(input.operationKey);
        const current = this.ledgers.get(input.cardsMint) ?? {
          cardsMint: input.cardsMint,
          grossRaw: 0,
          tournamentAllocatedRaw: 0,
          operatorAllocatedRaw: 0,
          operatorClaimedRaw: 0,
          tournamentCommittedRaw: 0,
        };
        current.grossRaw += input.grossRaw;
        current.tournamentAllocatedRaw += input.tournamentRaw;
        current.operatorAllocatedRaw += input.operatorRaw;
        this.ledgers.set(input.cardsMint, current);
      }
      const ledger = this.ledgers.get(input.cardsMint);
      if (!ledger) throw new Error('Creator reward ledger is missing after credit.');
      return { ...ledger };
    });
  }

  async reserveTournamentFunding(input: CreatorRewardReservationInput): Promise<CreatorRewardOperation> {
    return this.exclusive(() => {
      const existing = this.operations.get(input.operationKey);
      if (existing) {
        if (existing.status === 'failed') {
          throw new Error('Creator-reward transfer already failed and was not resent.');
        }
        return existing;
      }
      const ledger = this.ledgers.get(input.cardsMint);
      const remaining = ledger ? ledger.tournamentAllocatedRaw - ledger.tournamentCommittedRaw : 0;
      if (!ledger || remaining < input.amountRaw) {
        throw new Error('Insufficient tournament CARDS allocation.');
      }
      ledger.tournamentCommittedRaw += input.amountRaw;
      const operation: CreatorRewardOperation = {
        id: randomUUID(),
        operationKey: input.operationKey,
        kind: 'fund_tournament',
        status: 'pending',
        amountRaw: input.amountRaw,
        metadata: {
          ...(input.metadata ?? {}),
          cardsMint: input.cardsMint,
          tournamentId: input.tournamentId,
          amountRaw: input.amountRaw,
          reservationReleased: false,
        },
      };
      this.operations.set(input.operationKey, operation);
      return operation;
    });
  }

  async failFunding(operationKey: string): Promise<CreatorRewardOperation> {
    return this.exclusive(() => {
      const current = this.operations.get(operationKey);
      if (!current) throw new Error(`Unknown creator reward operation: ${operationKey}`);
      if (current.kind !== 'fund_tournament') {
        throw new Error('Only a tournament funding transfer can release a creator-reward reservation.');
      }
      if (current.metadata.reservationReleased !== true) {
        const cardsMint = String(current.metadata.cardsMint ?? '');
        const amount = Number(current.metadata.amountRaw ?? current.amountRaw);
        const ledger = this.ledgers.get(cardsMint);
        if (!ledger || ledger.tournamentCommittedRaw < amount) {
          throw new Error('Creator reward commitment went negative.');
        }
        ledger.tournamentCommittedRaw -= amount;
        current.metadata = { ...current.metadata, reservationReleased: true };
      }
      current.status = 'failed';
      return current;
    });
  }

  async reserveOperatorClaim(
    input: CreatorRewardOperatorClaimInput,
  ): Promise<CreatorRewardOperation | undefined> {
    return this.exclusive(() => {
      const ledger = this.ledgers.get(input.cardsMint);
      const claimable = ledger
        ? ledger.operatorAllocatedRaw - ledger.operatorClaimedRaw
        : 0;
      if (!ledger || claimable <= 0) return undefined;
      const operationKey = `operator-claim:${input.cardsMint}:${claimable}:${ledger.operatorClaimedRaw}`;
      const existing = this.operations.get(operationKey);
      if (existing) return existing;
      const operation: CreatorRewardOperation = {
        id: randomUUID(),
        operationKey,
        kind: 'operator_claim',
        status: 'pending',
        amountRaw: claimable,
        metadata: {
          ...(input.metadata ?? {}),
          cardsMint: input.cardsMint,
          destination: input.destination,
          amountRaw: claimable,
          operatorClaimedBeforeRaw: ledger.operatorClaimedRaw,
        },
      };
      this.operations.set(operationKey, operation);
      return operation;
    });
  }

  async confirmOperatorClaim(operationKey: string, signature: string): Promise<CreatorRewardOperation> {
    return this.exclusive(() => {
      const operation = this.operations.get(operationKey);
      if (!operation) throw new Error(`Unknown creator reward operation: ${operationKey}`);
      if (operation.kind !== 'operator_claim') {
        throw new Error('Only an operator claim can update operator allocation accounting.');
      }
      if (operation.status === 'confirmed') return operation;
      const cardsMint = String(operation.metadata.cardsMint ?? '');
      const ledger = this.ledgers.get(cardsMint);
      if (!ledger || ledger.operatorAllocatedRaw - ledger.operatorClaimedRaw < operation.amountRaw) {
        throw new Error('Operator allocation is already claimed or insufficient.');
      }
      ledger.operatorClaimedRaw += operation.amountRaw;
      operation.status = 'confirmed';
      operation.signature ??= signature;
      return operation;
    });
  }
}
