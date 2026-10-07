import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

import { mapPgError } from './pg-errors';

export type ChainAsset = 'SOL' | 'POKE' | 'CARDS';
export type ChainIntentKind =
  | 'sol_wager_deposit'
  | 'sol_wager_refund'
  | 'sol_match_fee'
  | 'sol_match_win'
  | 'sol_match_tie'
  | 'poke_entry_deposit'
  | 'poke_entry_refund'
  | 'poke_entry_burn'
  | 'treasury_deposit'
  | 'prize_reserve'
  | 'prize_pay'
  | 'prize_release'
  | 'cards_prize_fund'
  | 'cards_prize_pay'
  | 'cards_prize_release'
  | 'buyback_burn';

export type ChainIntentStatus =
  | 'created'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type ChainTxStatus = 'pending' | 'confirmed' | 'failed' | 'expired';

export interface PokeQuoteRow {
  quoteId: string;
  priceMicroUsd: number;
  decimals: number;
  observedAt: Date;
  source: string;
  confidenceBps: number;
}

export interface ChainIntentRow {
  id: string;
  kind: ChainIntentKind;
  scopeId: string;
  playerId?: string;
  asset: ChainAsset;
  amount: number;
  quoteId?: string;
  status: ChainIntentStatus;
  idempotencyKey: string;
  roomId?: string;
  tournamentId?: string;
  metadata: Record<string, unknown>;
}

export interface TreasuryDepositRow {
  id: string;
  claimKey: string;
  source: string;
  grossLamports: number;
  treasuryLamports: number;
  operatorLamports: number;
  signature?: string;
  createdAt: Date;
}

export interface CreateIntentInput {
  kind: ChainIntentKind;
  scopeId: string;
  playerId?: string;
  asset: ChainAsset;
  amount: number;
  quoteId?: string;
  idempotencyKey: string;
  roomId?: string;
  tournamentId?: string;
  metadata?: Record<string, unknown>;
}

function pokeToPg(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Amount must be a non-negative safe integer.');
  }
  return String(value);
}

function pokeFromPg(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  throw new Error('Invalid numeric amount from postgres.');
}

export class PostgresChainStore {
  constructor(private readonly pool: Pool) {}

  async withAdvisoryLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      return await work();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
      client.release();
    }
  }

  async saveQuote(quote: {
    quoteId: string;
    priceMicroUsd: number;
    decimals: number;
    observedAt: number | Date;
    source: string;
    confidenceBps: number;
  }): Promise<PokeQuoteRow> {
    return this.withMapped(async client => {
      await client.query(
        `INSERT INTO poke_quotes (
           quote_id, price_micro_usd, decimals, observed_at, source, confidence_bps
         ) VALUES ($1, $2::bigint, $3, $4, $5, $6)
         ON CONFLICT (quote_id) DO NOTHING`,
        [
          quote.quoteId,
          pokeToPg(quote.priceMicroUsd),
          quote.decimals,
          new Date(quote.observedAt),
          quote.source,
          quote.confidenceBps,
        ],
      );
      return {
        quoteId: quote.quoteId,
        priceMicroUsd: quote.priceMicroUsd,
        decimals: quote.decimals,
        observedAt: new Date(quote.observedAt),
        source: quote.source,
        confidenceBps: quote.confidenceBps,
      };
    });
  }

  async createIntent(input: CreateIntentInput): Promise<ChainIntentRow> {
    return this.withMapped(async client => {
      const existing = await client.query(
        `SELECT * FROM chain_intents WHERE kind = $1 AND scope_id = $2`,
        [input.kind, input.scopeId],
      );
      if (existing.rows[0]) return mapIntent(existing.rows[0]);

      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO chain_intents (
           id, kind, scope_id, player_id, asset, amount, quote_id, status,
           idempotency_key, room_id, tournament_id, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6::bigint, $7, 'created', $8, $9, $10, $11::jsonb
         )
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
         RETURNING *`,
        [
          id,
          input.kind,
          input.scopeId,
          input.playerId ?? null,
          input.asset,
          pokeToPg(input.amount),
          input.quoteId ?? null,
          input.idempotencyKey,
          input.roomId ?? null,
          input.tournamentId ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return mapIntent(result.rows[0]);
    });
  }

  async getIntent(id: string): Promise<ChainIntentRow | undefined> {
    return this.withMapped(async client => {
      const result = await client.query(`SELECT * FROM chain_intents WHERE id = $1`, [id]);
      return result.rows[0] ? mapIntent(result.rows[0]) : undefined;
    });
  }

  async getIntentByScope(kind: ChainIntentKind, scopeId: string): Promise<ChainIntentRow | undefined> {
    return this.withMapped(async client => {
      const result = await client.query(
        `SELECT * FROM chain_intents WHERE kind = $1 AND scope_id = $2`,
        [kind, scopeId],
      );
      return result.rows[0] ? mapIntent(result.rows[0]) : undefined;
    });
  }

  async mergeIntentMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<ChainIntentRow> {
    return this.withMapped(async client => {
      const result = await client.query(
        `UPDATE chain_intents
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, JSON.stringify(patch)],
      );
      if (!result.rows[0]) throw new Error(`Unknown chain intent: ${id}`);
      return mapIntent(result.rows[0]);
    });
  }

  /**
   * One keeper submission for a match operation, across API processes.
   * The session advisory lock is held on this connection until `run` finishes,
   * including the chain read and the send. A second process waits, then
   * observes the intent the first process already recorded.
   */
  async withMatchOperation<T>(
    operation: string,
    roomId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const key = `${operation}:${roomId}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      try {
        return await run();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Record a signature that must not become the canonical receipt.
   * A confirmed chain_tx row is left untouched.
   */
  async appendChainTx(input: {
    intentId: string;
    signature: string;
    status: ChainTxStatus;
    slot?: number;
    error?: string;
  }): Promise<void> {
    await this.transact(async client => {
      const canonical = await client.query<{ signature: string }>(
        `SELECT signature
         FROM chain_txs
         WHERE intent_id = $1 AND status = 'confirmed' AND signature IS NOT NULL
         LIMIT 1`,
        [input.intentId],
      );
      if (canonical.rows[0]?.signature === input.signature && input.status !== 'confirmed') return;
      await client.query(
        `INSERT INTO chain_txs (id, intent_id, signature, slot, status, error, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'confirmed' THEN now() ELSE NULL END)
         ON CONFLICT (signature) DO UPDATE
           SET status = EXCLUDED.status,
               slot = COALESCE(EXCLUDED.slot, chain_txs.slot),
               error = EXCLUDED.error,
               confirmed_at = CASE
                 WHEN EXCLUDED.status = 'confirmed' THEN now()
                 ELSE chain_txs.confirmed_at
               END
           WHERE chain_txs.status IS DISTINCT FROM 'confirmed'`,
        [
          randomUUID(),
          input.intentId,
          input.signature,
          input.slot ?? null,
          input.status,
          input.error ?? null,
        ],
      );
    });
  }

  async setIntentStatus(
    id: string,
    status: ChainIntentStatus,
    extras: { signature?: string; slot?: number; error?: string } = {},
  ): Promise<ChainIntentRow> {
    return this.transact(async client => {
      const current = await client.query<{ status: ChainIntentStatus }>(
        `SELECT status FROM chain_intents WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!current.rows[0]) throw new Error(`Unknown chain intent: ${id}`);
      const currentStatus = current.rows[0].status;
      if (currentStatus === 'confirmed' && extras.signature) {
        const canonical = await client.query<{ signature: string }>(
          `SELECT signature
           FROM chain_txs
           WHERE intent_id = $1 AND status = 'confirmed' AND signature IS NOT NULL
           LIMIT 1`,
          [id],
        );
        if (canonical.rows[0] && canonical.rows[0].signature !== extras.signature) {
          if (status !== 'confirmed') {
            await insertChainTx(client, id, extras, chainTxStatus(status));
          }
          const existing = await client.query(`SELECT * FROM chain_intents WHERE id = $1`, [id]);
          return mapIntent(existing.rows[0]);
        }
      }
      const retryable = status === 'confirmed' || status === 'pending';
      if (
        currentStatus === 'confirmed'
        || currentStatus === 'cancelled'
        || ((currentStatus === 'failed' || currentStatus === 'expired') && !retryable)
      ) {
        if (extras.signature && status !== 'confirmed' && currentStatus === 'confirmed') {
          await insertChainTx(client, id, extras, chainTxStatus(status));
        }
        const existing = await client.query(`SELECT * FROM chain_intents WHERE id = $1`, [id]);
        return mapIntent(existing.rows[0]);
      }
      const result = await client.query(
        `UPDATE chain_intents
         SET status = $2, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, status],
      );
      if (!result.rows[0]) throw new Error(`Unknown chain intent: ${id}`);
      const txStatus = chainTxStatus(status);
      if (extras.signature || txStatus === 'pending' || txStatus === 'confirmed' || txStatus === 'failed') {
        await insertChainTx(client, id, extras, txStatus);
      }
      return mapIntent(result.rows[0]);
    });
  }

  async recordTreasuryDeposit(input: {
    claimKey: string;
    source?: string;
    grossLamports: number;
    treasuryLamports: number;
    operatorLamports: number;
    intentId?: string;
    signature?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TreasuryDepositRow> {
    return this.withMapped(async client => {
      const existing = await client.query(
        `SELECT * FROM treasury_deposits WHERE claim_key = $1`,
        [input.claimKey],
      );
      if (existing.rows[0]) return mapTreasury(existing.rows[0]);
      const result = await client.query(
        `INSERT INTO treasury_deposits (
           id, claim_key, source, gross_lamports, treasury_lamports, operator_lamports,
           treasury_bps, operator_bps, intent_id, signature, metadata
         ) VALUES (
           $1, $2, $3, $4::bigint, $5::bigint, $6::bigint, 9000, 1000, $7, $8, $9::jsonb
         ) RETURNING *`,
        [
          randomUUID(),
          input.claimKey,
          input.source ?? 'creator_rewards',
          pokeToPg(input.grossLamports),
          pokeToPg(input.treasuryLamports),
          pokeToPg(input.operatorLamports),
          input.intentId ?? null,
          input.signature ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return mapTreasury(result.rows[0]);
    });
  }

  async listTreasuryDeposits(limit = 50): Promise<TreasuryDepositRow[]> {
    return this.withMapped(async client => {
      const result = await client.query(
        `SELECT * FROM treasury_deposits ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map(mapTreasury);
    });
  }

  async upsertEntryEscrow(input: {
    tournamentId: string;
    playerId: string;
    amountAtoms: number;
    quoteId: string;
    status: 'pending' | 'reserved' | 'burned' | 'refunded';
    depositIntentId?: string;
    terminalIntentId?: string;
  }): Promise<void> {
    await this.withMapped(async client => {
      await client.query(
        `INSERT INTO entry_escrows (
           id, tournament_id, player_id, amount_atoms, quote_id, status,
           deposit_intent_id, terminal_intent_id
         ) VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8)
         ON CONFLICT (tournament_id, player_id) DO UPDATE SET
           status = EXCLUDED.status,
           terminal_intent_id = COALESCE(EXCLUDED.terminal_intent_id, entry_escrows.terminal_intent_id),
           updated_at = now()`,
        [
          randomUUID(),
          input.tournamentId,
          input.playerId,
          pokeToPg(input.amountAtoms),
          input.quoteId,
          input.status,
          input.depositIntentId ?? null,
          input.terminalIntentId ?? null,
        ],
      );
    });
  }

  async markEntryBurned(tournamentId: string, playerId: string): Promise<void> {
    await this.withMapped(async client => {
      await client.query(
        `UPDATE entry_escrows
         SET status = 'burned', updated_at = now()
         WHERE tournament_id = $1 AND player_id = $2 AND status = 'reserved'`,
        [tournamentId, playerId],
      );
    });
  }

  async markEntryReserved(tournamentId: string, playerId: string): Promise<void> {
    await this.withMapped(async client => {
      await client.query(
        `UPDATE entry_escrows
         SET status = 'reserved', updated_at = now()
         WHERE tournament_id = $1 AND player_id = $2 AND status = 'pending'`,
        [tournamentId, playerId],
      );
    });
  }

  async markEntryRefunded(tournamentId: string, playerId: string): Promise<void> {
    await this.withMapped(async client => {
      await client.query(
        `UPDATE entry_escrows
         SET status = 'refunded', updated_at = now()
         WHERE tournament_id = $1 AND player_id = $2
           AND status IN ('pending', 'reserved')`,
        [tournamentId, playerId],
      );
    });
  }

  async recordPrizeReserve(input: {
    tournamentId: string;
    amountCardsRaw: number;
    status: 'reserved' | 'paid' | 'released';
    reserveIntentId?: string;
    settleIntentId?: string;
    winnerId?: string;
  }): Promise<void> {
    await this.withMapped(async client => {
      await client.query(
        `INSERT INTO prize_reserves (
           id, tournament_id, prize_cards_raw, status, reserve_intent_id,
           settle_intent_id, winner_id
         ) VALUES ($1, $2, $3::bigint, $4, $5, $6, $7)
         ON CONFLICT (tournament_id) DO UPDATE SET
           prize_cards_raw = EXCLUDED.prize_cards_raw,
           status = EXCLUDED.status,
           reserve_intent_id = COALESCE(EXCLUDED.reserve_intent_id, prize_reserves.reserve_intent_id),
           settle_intent_id = COALESCE(EXCLUDED.settle_intent_id, prize_reserves.settle_intent_id),
           winner_id = COALESCE(EXCLUDED.winner_id, prize_reserves.winner_id),
           updated_at = now()`,
        [
          randomUUID(),
          input.tournamentId,
          pokeToPg(input.amountCardsRaw),
          input.status,
          input.reserveIntentId ?? null,
          input.settleIntentId ?? null,
          input.winnerId ?? null,
        ],
      );
    });
  }

  async sumReservedEntryAtoms(playerId: string): Promise<number> {
    return this.withMapped(async client => {
      const result = await client.query<{ sum: string | null }>(
        `SELECT COALESCE(SUM(amount_atoms), 0)::text AS sum
         FROM entry_escrows
         WHERE player_id = $1 AND status IN ('pending', 'reserved')`,
        [playerId],
      );
      return pokeFromPg(result.rows[0]?.sum ?? '0');
    });
  }

  async listPendingIntents(): Promise<ChainIntentRow[]> {
    return this.withMapped(async client => {
      const result = await client.query(
        `SELECT * FROM chain_intents
         WHERE status IN ('created', 'pending')
         ORDER BY created_at`,
      );
      return result.rows.map(mapIntent);
    });
  }

  private async withMapped<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(client);
    } catch (error) {
      throw mapPgError(error);
    } finally {
      client.release();
    }
  }

  private async transact<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw mapPgError(error);
    } finally {
      client.release();
    }
  }
}

function chainTxStatus(status: ChainIntentStatus): ChainTxStatus {
  if (status === 'confirmed' || status === 'failed' || status === 'expired' || status === 'pending') return status;
  return 'pending';
}

async function insertChainTx(
  client: PoolClient,
  intentId: string,
  extras: { signature?: string; slot?: number; error?: string },
  txStatus: ChainTxStatus,
): Promise<void> {
  if (!extras.signature) {
    await client.query(
      `INSERT INTO chain_txs (id, intent_id, signature, slot, status, error, confirmed_at)
       VALUES ($1, $2, NULL, $3, $4, $5, CASE WHEN $4 = 'confirmed' THEN now() ELSE NULL END)`,
      [randomUUID(), intentId, extras.slot ?? null, txStatus, extras.error ?? null],
    );
    return;
  }
  await client.query(
    `INSERT INTO chain_txs (id, intent_id, signature, slot, status, error, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'confirmed' THEN now() ELSE NULL END)
     ON CONFLICT (signature) DO UPDATE
       SET status = EXCLUDED.status,
           slot = COALESCE(EXCLUDED.slot, chain_txs.slot),
           error = EXCLUDED.error,
           confirmed_at = CASE
             WHEN EXCLUDED.status = 'confirmed' THEN now()
             ELSE chain_txs.confirmed_at
           END
       WHERE chain_txs.status IS DISTINCT FROM 'confirmed' OR EXCLUDED.status = 'confirmed'`,
    [
      randomUUID(),
      intentId,
      extras.signature,
      extras.slot ?? null,
      txStatus,
      extras.error ?? null,
    ],
  );
}

function mapIntent(row: Record<string, unknown>): ChainIntentRow {
  return {
    id: String(row.id),
    kind: row.kind as ChainIntentKind,
    scopeId: String(row.scope_id),
    ...(row.player_id ? { playerId: String(row.player_id) } : {}),
    asset: row.asset as ChainAsset,
    amount: pokeFromPg(row.amount),
    ...(row.quote_id ? { quoteId: String(row.quote_id) } : {}),
    status: row.status as ChainIntentStatus,
    idempotencyKey: String(row.idempotency_key),
    ...(row.room_id ? { roomId: String(row.room_id) } : {}),
    ...(row.tournament_id ? { tournamentId: String(row.tournament_id) } : {}),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

function mapTreasury(row: Record<string, unknown>): TreasuryDepositRow {
  return {
    id: String(row.id),
    claimKey: String(row.claim_key),
    source: String(row.source),
    grossLamports: pokeFromPg(row.gross_lamports),
    treasuryLamports: pokeFromPg(row.treasury_lamports),
    operatorLamports: pokeFromPg(row.operator_lamports),
    ...(row.signature ? { signature: String(row.signature) } : {}),
    createdAt: new Date(String(row.created_at)),
  };
}
