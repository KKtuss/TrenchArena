import type { Pool, PoolClient } from 'pg';

import { previewCasual, previewTournament, POKE_SYMBOL } from './economics-math';
import {
  creatorHoldKey,
  isKnownPlayerId,
  opponentHoldKey,
  type CasualCompleteTieInput,
  type CasualCompleteWinInput,
  type CasualRoomAcceptInput,
  type CasualRoomCreateInput,
  type CasualTieInput,
  type CasualWinInput,
  type DurableCasualRoom,
  type DurableCasualRoomStatus,
  type EconomicsStore,
  type HoldSnapshot,
  type PayoutResult,
  type ReserveEntry,
  type TournamentCompleteInput,
  type TournamentWinInput,
  type WalletSnapshot,
} from './economics-store';
import { mapPgError } from './pg-errors';
import { pokeFromPg, pokeToPg } from './poke';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const CASUAL_HOLD = new RegExp(`^casual:(${UUID}):(creator|opponent)$`);
const TOURNAMENT_HOLD = new RegExp(`^tournament:(${UUID}):(.+)$`);
const CASUAL_SETTLEMENT = new RegExp(`^casual:(${UUID})$`);
const TOURNAMENT_SETTLEMENT = new RegExp(`^tournament:(${UUID})$`);

export type InjectedEconomicsFailure = 'debit' | 'insertHold' | 'insertSettlement' | 'commit';

export interface PostgresEconomicsStoreOptions {
  beforeCommit?: () => Promise<void> | void;
  failNext?: InjectedEconomicsFailure;
}

interface HoldRef {
  purpose: 'casual_creator' | 'casual_opponent' | 'tournament_entry';
  roomId?: string;
  tournamentId?: string;
  playerId?: string;
}

function parseHoldKey(holdKey: string): HoldRef {
  const casual = CASUAL_HOLD.exec(holdKey);
  if (casual) {
    return {
      purpose: casual[2] === 'creator' ? 'casual_creator' : 'casual_opponent',
      roomId: casual[1].toLowerCase(),
    };
  }
  const tournament = TOURNAMENT_HOLD.exec(holdKey);
  if (tournament) {
    return {
      purpose: 'tournament_entry',
      tournamentId: tournament[1].toLowerCase(),
      playerId: tournament[2],
    };
  }
  throw new Error('Invalid hold key.');
}

function snapshot(playerId: string, balance: number): WalletSnapshot {
  return {
    playerId,
    symbol: POKE_SYMBOL,
    balance,
    eligible: balance > 0 && isKnownPlayerId(playerId),
  };
}

function payoutFromRow(row: {
  kind: string;
  winner_id: string | null;
  amount: unknown;
  protocol_fee: unknown;
}): PayoutResult {
  return {
    symbol: POKE_SYMBOL,
    mocked: true,
    ...(row.winner_id ? { winnerId: row.winner_id } : {}),
    amount: pokeFromPg(row.amount),
    ...(row.protocol_fee === null || row.protocol_fee === undefined
      ? {}
      : { protocolFee: pokeFromPg(row.protocol_fee) }),
    reason: row.kind as PayoutResult['reason'],
  };
}

function roomFromRow(row: {
  id: string;
  match_id: string;
  room_type: string;
  battle_size: string;
  creator_id: string;
  opponent_id: string | null;
  invited_player_id: string | null;
  collateral: string;
  status: string;
  winner_id: string | null;
  result_status: string | null;
  settlement_key: string | null;
  battle_instance_id: string | null;
}): DurableCasualRoom {
  return {
    id: row.id,
    matchId: row.match_id,
    roomType: row.room_type as DurableCasualRoom['roomType'],
    battleSize: row.battle_size as DurableCasualRoom['battleSize'],
    creatorId: row.creator_id,
    ...(row.opponent_id ? { opponentId: row.opponent_id } : {}),
    ...(row.invited_player_id ? { invitedPlayerId: row.invited_player_id } : {}),
    collateral: pokeFromPg(row.collateral),
    status: row.status as DurableCasualRoomStatus,
    ...(row.winner_id ? { winnerId: row.winner_id } : {}),
    ...(row.result_status === 'win' || row.result_status === 'tie'
      ? { resultStatus: row.result_status }
      : {}),
    ...(row.settlement_key ? { settlementKey: row.settlement_key } : {}),
    ...(row.battle_instance_id ? { battleInstanceId: row.battle_instance_id } : {}),
  };
}

function snapshotHold(row: {
  hold_key: string;
  player_id: string;
  amount: string;
  status: 'reserved' | 'released' | 'consumed';
  purpose: 'casual_creator' | 'casual_opponent' | 'tournament_entry';
  tournament_id: string | null;
  room_id: string | null;
}): HoldSnapshot {
  return {
    holdKey: row.hold_key,
    playerId: row.player_id,
    amount: pokeFromPg(row.amount),
    status: row.status,
    purpose: row.purpose,
    ...(row.tournament_id ? { tournamentId: row.tournament_id } : {}),
    ...(row.room_id ? { roomId: row.room_id } : {}),
  };
}

/**
 * PostgreSQL economics adapter. Production source of truth for balances,
 * holds, settlements, and casual-room economic state.
 */
export class PostgresEconomicsStore implements EconomicsStore {
  constructor(
    private readonly pool: Pool,
    private readonly hooks: PostgresEconomicsStoreOptions = {},
  ) {}

  async ensureWallet(playerId: string): Promise<WalletSnapshot> {
    if (isKnownPlayerId(playerId)) {
      await this.withMapped(client => this.upsertWallet(client, playerId, 0));
    }
    return this.getWallet(playerId);
  }

  async getWallet(playerId: string): Promise<WalletSnapshot> {
    return this.withMapped(async client => {
      const result = await client.query<{ balance: string }>(
        'SELECT balance FROM wallets WHERE player_id = $1',
        [playerId],
      );
      return snapshot(playerId, result.rows[0] ? pokeFromPg(result.rows[0].balance) : 0);
    });
  }

  async getBalance(playerId: string): Promise<number> {
    return (await this.getWallet(playerId)).balance;
  }

  async hasHold(holdKey: string): Promise<boolean> {
    const hold = await this.getHold(holdKey);
    return hold?.status === 'reserved';
  }

  async getHold(holdKey: string): Promise<HoldSnapshot | undefined> {
    return this.withMapped(async client => this.readHold(client, holdKey));
  }

  async getSettlement(settlementKey: string): Promise<PayoutResult | undefined> {
    return this.withMapped(client => this.findSettlement(client, settlementKey));
  }

  async getCasualRoom(roomId: string): Promise<DurableCasualRoom | undefined> {
    return this.withMapped(async client => {
      const result = await client.query({
        text: `SELECT id, match_id, room_type, battle_size, creator_id, opponent_id,
                      invited_player_id, collateral, status, winner_id, result_status,
                      settlement_key, battle_instance_id
               FROM casual_rooms WHERE id = $1`,
        values: [roomId],
      });
      return result.rows[0] ? roomFromRow(result.rows[0]) : undefined;
    });
  }

  async listCasualRooms(): Promise<DurableCasualRoom[]> {
    return this.withMapped(async client => {
      const result = await client.query(
        `SELECT id, match_id, room_type, battle_size, creator_id, opponent_id,
                invited_player_id, collateral, status, winner_id, result_status,
                settlement_key, battle_instance_id
         FROM casual_rooms
         ORDER BY created_at`,
      );
      return result.rows.map(row => roomFromRow(row));
    });
  }

  async listHolds(): Promise<HoldSnapshot[]> {
    return this.withMapped(async client => {
      const result = await client.query(
        `SELECT hold_key, player_id, amount, status, purpose, tournament_id, room_id
         FROM holds
         ORDER BY created_at`,
      );
      return result.rows.map(row => snapshotHold(row));
    });
  }

  async reserve(holdKey: string, playerId: string, amount: number): Promise<boolean> {
    const ref = parseHoldKey(holdKey);
    return this.transact(async client => this.reserveHold(client, holdKey, playerId, amount, ref));
  }

  async reserveAll(entries: ReadonlyArray<ReserveEntry>): Promise<void> {
    await this.transact(async client => {
      const seen = new Set<string>();
      for (const entry of entries) {
        parseHoldKey(entry.holdKey);
        if (seen.has(entry.holdKey)) throw new Error('Collateral hold already exists.');
        seen.add(entry.holdKey);
        if (!Number.isInteger(entry.amount) || entry.amount <= 0) {
          throw new Error('Amount must be a positive integer POKE value.');
        }
      }
      const needed = new Map<string, number>();
      for (const entry of entries) {
        needed.set(entry.playerId, (needed.get(entry.playerId) ?? 0) + entry.amount);
      }
      for (const [playerId, amount] of needed) {
        const balance = await this.balanceForUpdate(client, playerId);
        if (balance < amount) {
          throw new Error('Collateral exceeds development POKE balance.');
        }
      }
      for (const entry of entries) {
        const existing = await client.query(
          'SELECT status FROM holds WHERE hold_key = $1 FOR UPDATE',
          [entry.holdKey],
        );
        if (existing.rows[0] && existing.rows[0].status !== 'released') {
          throw new Error('Collateral hold already exists.');
        }
      }
      for (const [playerId, amount] of needed) {
        await this.debit(client, playerId, amount);
      }
      for (const entry of entries) {
        await this.upsertReservedHold(
          client,
          entry.holdKey,
          entry.playerId,
          entry.amount,
          parseHoldKey(entry.holdKey),
        );
      }
    });
  }

  async release(holdKey: string): Promise<number> {
    return this.transact(async client => this.releaseHold(client, holdKey));
  }

  async consume(holdKey: string): Promise<void> {
    await this.transact(async client => {
      await this.consumeHold(client, holdKey);
    });
  }

  async credit(playerId: string, amount: number): Promise<void> {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error('Credit amount must be a non-negative integer.');
    }
    await this.transact(client => this.addBalance(client, playerId, amount));
  }

  async lockCollateral(playerId: string, amount: number): Promise<void> {
    await this.transact(client => this.debit(client, playerId, amount));
  }

  async settleCasualWin(input: CasualWinInput): Promise<PayoutResult> {
    return this.transact(async client => {
      await this.lockSettlement(client, input.settlementKey);
      const existing = await this.findSettlement(client, input.settlementKey);
      if (existing) return existing;
      const preview = previewCasual(input.collateral);
      await this.addBalance(client, input.winnerId, preview.winnerPayout);
      return this.insertSettlement(client, {
        key: input.settlementKey,
        kind: input.reason ?? 'casual-win',
        winnerId: input.winnerId,
        amount: preview.winnerPayout,
        protocolFee: preview.protocolFee,
      });
    });
  }

  async settleCasualTie(input: CasualTieInput): Promise<PayoutResult> {
    return this.transact(async client => {
      await this.lockSettlement(client, input.settlementKey);
      const existing = await this.findSettlement(client, input.settlementKey);
      if (existing) return existing;
      const preview = previewCasual(input.collateral);
      const refundEach = Math.floor(preview.totalPot / 2);
      await this.addBalance(client, input.player1Id, refundEach);
      await this.addBalance(client, input.player2Id, preview.totalPot - refundEach);
      return this.insertSettlement(client, {
        key: input.settlementKey,
        kind: 'casual-tie',
        amount: refundEach,
        protocolFee: 0,
      });
    });
  }

  async settleTournamentWin(input: TournamentWinInput): Promise<PayoutResult> {
    return this.transact(async client => {
      await this.lockSettlement(client, input.settlementKey);
      const existing = await this.findSettlement(client, input.settlementKey);
      if (existing) return existing;
      const preview = previewTournament(input.entryFee, input.playerCount);
      await this.addBalance(client, input.winnerId, preview.prizePool);
      return this.insertSettlement(client, {
        key: input.settlementKey,
        kind: 'tournament-win',
        winnerId: input.winnerId,
        amount: preview.prizePool,
      });
    });
  }

  async createCasualRoomWithHold(input: CasualRoomCreateInput): Promise<void> {
    const holdKey = creatorHoldKey(input.id);
    await this.transact(async client => {
      await this.upsertWallet(client, input.creatorId, 0);
      if (input.invitedPlayerId) await this.upsertWallet(client, input.invitedPlayerId, 0);
      await client.query(
        `INSERT INTO casual_rooms (
           id, match_id, room_type, battle_size, format, creator_id, invited_player_id,
           collateral, status
         ) VALUES ($1, $2, $3, $4, 'gen9ou', $5, $6, $7::bigint, 'open')`,
        [
          input.id,
          input.matchId,
          input.roomType,
          input.battleSize,
          input.creatorId,
          input.invitedPlayerId ?? null,
          pokeToPg(input.collateral),
        ],
      );
      await this.debit(client, input.creatorId, input.collateral);
      await this.insertHold(client, holdKey, input.creatorId, input.collateral, {
        purpose: 'casual_creator',
        roomId: input.id,
      });
    });
  }

  async acceptCasualRoomWithHold(input: CasualRoomAcceptInput): Promise<void> {
    const holdKey = opponentHoldKey(input.roomId);
    await this.transact(async client => {
      const room = await this.lockRoom(client, input.roomId);
      if (!room) throw new Error(`Unknown casual room: ${input.roomId}`);
      if (room.status === 'full' && room.opponent_id === input.opponentId) {
        const hold = await this.readHold(client, holdKey);
        if (hold?.status === 'reserved' && hold.playerId === input.opponentId) return;
      }
      if (room.status !== 'open') throw new Error('This casual room is no longer open.');
      if (room.opponent_id) throw new Error('This casual room is already full.');
      if (input.opponentId === room.creator_id) throw new Error('Creator already occupies this room.');
      if (room.invited_player_id && room.invited_player_id !== input.opponentId) {
        throw new Error('You were not invited to this private challenge.');
      }
      await this.upsertWallet(client, input.opponentId, 0);
      await this.debit(client, input.opponentId, input.collateral);
      await this.insertHold(client, holdKey, input.opponentId, input.collateral, {
        purpose: 'casual_opponent',
        roomId: input.roomId,
      });
      await client.query(
        `UPDATE casual_rooms
         SET opponent_id = $2, status = 'full', updated_at = now()
         WHERE id = $1`,
        [input.roomId, input.opponentId],
      );
    });
  }

  async cancelCasualRoom(roomId: string): Promise<void> {
    await this.transact(async client => {
      const room = await this.lockRoom(client, roomId);
      if (!room) throw new Error(`Unknown casual room: ${roomId}`);
      if (room.status === 'cancelled') {
        await this.releaseHold(client, creatorHoldKey(roomId));
        await this.releaseHold(client, opponentHoldKey(roomId));
        return;
      }
      if (room.status === 'starting' || room.status === 'battling' || room.status === 'completed') {
        throw new Error('Cannot cancel a room after battle start.');
      }
      await this.releaseHold(client, creatorHoldKey(roomId));
      await this.releaseHold(client, opponentHoldKey(roomId));
      await this.markRoomCancelled(client, roomId);
    });
  }

  async abortCasualRoom(roomId: string): Promise<void> {
    await this.transact(async client => {
      const room = await this.lockRoom(client, roomId);
      if (!room) throw new Error(`Unknown casual room: ${roomId}`);
      if (room.status === 'completed') return;
      await this.releaseHold(client, creatorHoldKey(roomId));
      await this.releaseHold(client, opponentHoldKey(roomId));
      if (room.status !== 'cancelled') {
        await this.markRoomCancelled(client, roomId);
      }
    });
  }

  async completeCasualWin(input: CasualCompleteWinInput): Promise<PayoutResult> {
    const settlementKey = `casual:${input.roomId}`;
    return this.transact(async client => {
      const room = await this.lockRoom(client, input.roomId);
      if (!room) throw new Error(`Unknown casual room: ${input.roomId}`);
      if (room.status === 'completed') {
        const existing = await this.findSettlement(client, settlementKey);
        if (existing) return existing;
      }
      if (room.status === 'cancelled') throw new Error('This casual room is no longer open.');
      await this.lockHold(client, creatorHoldKey(input.roomId));
      await this.lockHold(client, opponentHoldKey(input.roomId));
      await this.consumeHold(client, creatorHoldKey(input.roomId));
      await this.consumeHold(client, opponentHoldKey(input.roomId));
      const preview = previewCasual(input.collateral);
      const existing = await this.findSettlement(client, settlementKey);
      if (existing) {
        await this.markRoomCompleted(client, input.roomId, {
          winnerId: existing.winnerId,
          resultStatus: 'win',
          settlementKey,
        });
        return existing;
      }
      await this.addBalance(client, input.winnerId, preview.winnerPayout);
      const payout = await this.insertSettlement(client, {
        key: settlementKey,
        kind: input.reason,
        winnerId: input.winnerId,
        amount: preview.winnerPayout,
        protocolFee: preview.protocolFee,
      });
      await this.markRoomCompleted(client, input.roomId, {
        winnerId: input.winnerId,
        resultStatus: 'win',
        settlementKey,
      });
      return payout;
    });
  }

  async completeCasualTie(input: CasualCompleteTieInput): Promise<PayoutResult> {
    const settlementKey = `casual:${input.roomId}`;
    return this.transact(async client => {
      const room = await this.lockRoom(client, input.roomId);
      if (!room) throw new Error(`Unknown casual room: ${input.roomId}`);
      if (room.status === 'completed') {
        const existing = await this.findSettlement(client, settlementKey);
        if (existing) return existing;
      }
      if (room.status === 'cancelled') throw new Error('This casual room is no longer open.');
      await this.lockHold(client, creatorHoldKey(input.roomId));
      await this.lockHold(client, opponentHoldKey(input.roomId));
      await this.consumeHold(client, creatorHoldKey(input.roomId));
      await this.consumeHold(client, opponentHoldKey(input.roomId));
      const preview = previewCasual(input.collateral);
      const refundEach = Math.floor(preview.totalPot / 2);
      const existing = await this.findSettlement(client, settlementKey);
      if (existing) {
        await this.markRoomCompleted(client, input.roomId, {
          resultStatus: 'tie',
          settlementKey,
        });
        return existing;
      }
      await this.addBalance(client, input.player1Id, refundEach);
      await this.addBalance(client, input.player2Id, preview.totalPot - refundEach);
      const payout = await this.insertSettlement(client, {
        key: settlementKey,
        kind: 'casual-tie',
        amount: refundEach,
        protocolFee: 0,
      });
      await this.markRoomCompleted(client, input.roomId, {
        resultStatus: 'tie',
        settlementKey,
      });
      return payout;
    });
  }

  async completeTournamentWin(input: TournamentCompleteInput): Promise<PayoutResult> {
    return this.transact(async client => {
      await this.lockSettlement(client, input.settlementKey);
      const existing = await this.findSettlement(client, input.settlementKey);
      if (existing) {
        for (const holdKey of input.holdKeys) await this.consumeHold(client, holdKey);
        return existing;
      }
      const keys = [...input.holdKeys].sort();
      for (const holdKey of keys) await this.lockHold(client, holdKey);
      const preview = previewTournament(input.entryFee, input.playerCount);
      await this.addBalance(client, input.winnerId, preview.prizePool);
      const payout = await this.insertSettlement(client, {
        key: input.settlementKey,
        kind: 'tournament-win',
        winnerId: input.winnerId,
        amount: preview.prizePool,
      });
      for (const holdKey of keys) await this.consumeHold(client, holdKey);
      return payout;
    });
  }

  async setCasualRoomStatus(
    roomId: string,
    status: DurableCasualRoomStatus,
    extras: { battleInstanceId?: string } = {},
  ): Promise<void> {
    await this.transact(async client => {
      const room = await this.lockRoom(client, roomId);
      if (!room) throw new Error(`Unknown casual room: ${roomId}`);
      if (room.status === 'completed' || room.status === 'cancelled') return;
      if (status === 'cancelled' || status === 'completed') {
        throw new Error('Use cancelCasualRoom or completeCasual* for terminal room state.');
      }
      await client.query(
        `UPDATE casual_rooms
         SET status = $2,
             battle_instance_id = COALESCE($3, battle_instance_id),
             updated_at = now()
         WHERE id = $1`,
        [roomId, status, extras.battleInstanceId ?? null],
      );
    });
  }

  private async transact<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await this.consumeFailHook('commit');
      if (this.hooks.beforeCommit) await this.hooks.beforeCommit();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is released even if rollback fails.
      }
      throw mapPgError(error);
    } finally {
      client.release();
    }
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

  private async consumeFailHook(kind: InjectedEconomicsFailure): Promise<void> {
    if (this.hooks.failNext !== kind) return;
    this.hooks.failNext = undefined;
    throw new Error(`injected ${kind} failure`);
  }

  private async upsertWallet(client: PoolClient, playerId: string, balance: number): Promise<void> {
    await client.query(
      `INSERT INTO wallets (player_id, balance) VALUES ($1, $2)
       ON CONFLICT (player_id) DO NOTHING`,
      [playerId, pokeToPg(balance)],
    );
  }

  private async balanceForUpdate(client: PoolClient, playerId: string): Promise<number> {
    const result = await client.query<{ balance: string }>(
      'SELECT balance FROM wallets WHERE player_id = $1 FOR UPDATE',
      [playerId],
    );
    if (!result.rows[0]) return 0;
    return pokeFromPg(result.rows[0].balance);
  }

  private async debit(client: PoolClient, playerId: string, amount: number): Promise<void> {
    await this.consumeFailHook('debit');
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Amount must be a positive integer POKE value.');
    }
    const updated = await client.query(
      `UPDATE wallets
       SET balance = balance - $2::bigint, updated_at = now()
       WHERE player_id = $1 AND balance >= $2::bigint`,
      [playerId, pokeToPg(amount)],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error('Collateral exceeds development POKE balance.');
    }
  }

  private async addBalance(client: PoolClient, playerId: string, amount: number): Promise<void> {
    pokeToPg(amount);
    await this.upsertWallet(client, playerId, 0);
    await client.query(
      `UPDATE wallets
       SET balance = balance + $2::bigint, updated_at = now()
       WHERE player_id = $1`,
      [playerId, pokeToPg(amount)],
    );
  }

  private async reserveHold(
    client: PoolClient,
    holdKey: string,
    playerId: string,
    amount: number,
    ref: HoldRef,
  ): Promise<boolean> {
    const existing = await client.query<{ player_id: string; amount: string; status: string }>(
      'SELECT player_id, amount, status FROM holds WHERE hold_key = $1 FOR UPDATE',
      [holdKey],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (
        row.status === 'reserved'
        && row.player_id === playerId
        && pokeFromPg(row.amount) === amount
      ) {
        return false;
      }
      if (row.status === 'released' && row.player_id === playerId) {
        await this.debit(client, playerId, amount);
        await client.query(
          `UPDATE holds
           SET amount = $2::bigint, status = 'reserved', terminal_at = NULL
           WHERE hold_key = $1`,
          [holdKey, pokeToPg(amount)],
        );
        return true;
      }
      throw new Error('Collateral hold already exists.');
    }
    await this.debit(client, playerId, amount);
    await this.insertHold(client, holdKey, playerId, amount, ref);
    return true;
  }

  private async upsertReservedHold(
    client: PoolClient,
    holdKey: string,
    playerId: string,
    amount: number,
    ref: HoldRef,
  ): Promise<void> {
    const existing = await client.query<{ status: string }>(
      'SELECT status FROM holds WHERE hold_key = $1 FOR UPDATE',
      [holdKey],
    );
    if (!existing.rows[0]) {
      await this.insertHold(client, holdKey, playerId, amount, ref);
      return;
    }
    if (existing.rows[0].status !== 'released') {
      throw new Error('Collateral hold already exists.');
    }
    await client.query(
      `UPDATE holds
       SET player_id = $2, amount = $3::bigint, status = 'reserved', terminal_at = NULL
       WHERE hold_key = $1`,
      [holdKey, playerId, pokeToPg(amount)],
    );
  }

  private async insertHold(
    client: PoolClient,
    holdKey: string,
    playerId: string,
    amount: number,
    ref: HoldRef,
  ): Promise<void> {
    await this.consumeFailHook('insertHold');
    await client.query(
      `INSERT INTO holds (
         hold_key, player_id, amount, purpose, status, room_id, tournament_id
       ) VALUES ($1, $2, $3::bigint, $4, 'reserved', $5, $6)`,
      [
        holdKey,
        playerId,
        pokeToPg(amount),
        ref.purpose,
        ref.roomId ?? null,
        ref.tournamentId ?? null,
      ],
    );
  }

  private async releaseHold(client: PoolClient, holdKey: string): Promise<number> {
    const existing = await client.query<{ player_id: string; amount: string; status: string }>(
      'SELECT player_id, amount, status FROM holds WHERE hold_key = $1 FOR UPDATE',
      [holdKey],
    );
    const row = existing.rows[0];
    if (!row || row.status !== 'reserved') return 0;
    const amount = pokeFromPg(row.amount);
    await client.query(
      `UPDATE holds SET status = 'released', terminal_at = now() WHERE hold_key = $1`,
      [holdKey],
    );
    await this.addBalance(client, row.player_id, amount);
    return amount;
  }

  private async consumeHold(client: PoolClient, holdKey: string): Promise<void> {
    const existing = await client.query<{ status: string }>(
      'SELECT status FROM holds WHERE hold_key = $1 FOR UPDATE',
      [holdKey],
    );
    if (!existing.rows[0] || existing.rows[0].status !== 'reserved') return;
    await client.query(
      `UPDATE holds SET status = 'consumed', terminal_at = now() WHERE hold_key = $1`,
      [holdKey],
    );
  }

  private async lockHold(client: PoolClient, holdKey: string): Promise<void> {
    await client.query('SELECT 1 FROM holds WHERE hold_key = $1 FOR UPDATE', [holdKey]);
  }

  private async lockRoom(client: PoolClient, roomId: string): Promise<{
    status: string;
    creator_id: string;
    opponent_id: string | null;
    invited_player_id: string | null;
    collateral: string;
  } | undefined> {
    const result = await client.query<{
      status: string;
      creator_id: string;
      opponent_id: string | null;
      invited_player_id: string | null;
      collateral: string;
    }>(
      `SELECT status, creator_id, opponent_id, invited_player_id, collateral
       FROM casual_rooms WHERE id = $1 FOR UPDATE`,
      [roomId],
    );
    return result.rows[0];
  }

  private async readHold(client: PoolClient, holdKey: string): Promise<HoldSnapshot | undefined> {
    const result = await client.query<{
      hold_key: string;
      player_id: string;
      amount: string;
      status: 'reserved' | 'released' | 'consumed';
      purpose: 'casual_creator' | 'casual_opponent' | 'tournament_entry';
      tournament_id: string | null;
      room_id: string | null;
    }>(
      `SELECT hold_key, player_id, amount, status, purpose, tournament_id, room_id
       FROM holds WHERE hold_key = $1`,
      [holdKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return snapshotHold(row);
  }

  private async lockSettlement(client: PoolClient, key: string | undefined): Promise<void> {
    if (!key) return;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }

  private async findSettlement(client: PoolClient, key: string | undefined): Promise<PayoutResult | undefined> {
    if (!key) return undefined;
    const result = await client.query<{
      kind: string;
      winner_id: string | null;
      amount: string;
      protocol_fee: string | null;
    }>(
      `SELECT kind, winner_id, amount, protocol_fee FROM settlements WHERE settlement_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? payoutFromRow(row) : undefined;
  }

  private async insertSettlement(client: PoolClient, input: {
    key?: string;
    kind: PayoutResult['reason'];
    winnerId?: string;
    amount: number;
    protocolFee?: number;
  }): Promise<PayoutResult> {
    await this.consumeFailHook('insertSettlement');
    const result: PayoutResult = {
      symbol: POKE_SYMBOL,
      mocked: true,
      ...(input.winnerId ? { winnerId: input.winnerId } : {}),
      amount: input.amount,
      ...(input.protocolFee === undefined ? {} : { protocolFee: input.protocolFee }),
      reason: input.kind,
    };
    if (!input.key) return result;
    const casual = CASUAL_SETTLEMENT.exec(input.key);
    const tournament = TOURNAMENT_SETTLEMENT.exec(input.key);
    await client.query(
      `INSERT INTO settlements (
         settlement_key, kind, winner_id, amount, protocol_fee, room_id, tournament_id
       ) VALUES ($1, $2, $3, $4::bigint, $5, $6, $7)`,
      [
        input.key,
        input.kind,
        input.winnerId ?? null,
        pokeToPg(input.amount),
        input.protocolFee === undefined ? null : pokeToPg(input.protocolFee),
        casual ? casual[1].toLowerCase() : null,
        tournament ? tournament[1].toLowerCase() : null,
      ],
    );
    return result;
  }

  private async markRoomCancelled(client: PoolClient, roomId: string): Promise<void> {
    await client.query(
      `UPDATE casual_rooms
       SET status = 'cancelled',
           completed_at = COALESCE(completed_at, now()),
           updated_at = now()
       WHERE id = $1 AND status <> 'completed'`,
      [roomId],
    );
  }

  private async markRoomCompleted(client: PoolClient, roomId: string, input: {
    winnerId?: string;
    resultStatus: 'win' | 'tie';
    settlementKey: string;
  }): Promise<void> {
    await client.query(
      `UPDATE casual_rooms
       SET status = 'completed',
           winner_id = $2,
           result_status = $3,
           settlement_key = $4,
           completed_at = COALESCE(completed_at, now()),
           updated_at = now()
       WHERE id = $1`,
      [roomId, input.winnerId ?? null, input.resultStatus, input.settlementKey],
    );
  }
}
