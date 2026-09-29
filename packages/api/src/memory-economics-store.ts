import {
  creatorHoldKey,
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
} from '@pokearena/db';

import { MockEconomics } from './mock-economics';

/**
 * Async adapter over the existing in-memory `MockEconomics`.
 * Used by tests and non-production processes.
 */
export class InMemoryEconomicsStore implements EconomicsStore {
  private readonly rooms = new Map<string, DurableCasualRoom>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly holdSnapshots = new Map<string, HoldSnapshot>();

  constructor(private readonly inner: MockEconomics = new MockEconomics()) {}

  async ensureWallet(playerId: string): Promise<WalletSnapshot> {
    return this.inner.ensureWallet(playerId);
  }

  async getWallet(playerId: string): Promise<WalletSnapshot> {
    return this.inner.getWallet(playerId);
  }

  async getBalance(playerId: string): Promise<number> {
    return this.inner.getBalance(playerId);
  }

  async hasHold(holdKey: string): Promise<boolean> {
    return this.inner.hasHold(holdKey);
  }

  async getHold(holdKey: string): Promise<HoldSnapshot | undefined> {
    const tracked = this.holdSnapshots.get(holdKey);
    if (tracked) return { ...tracked };
    const hold = this.inner.inspectHold(holdKey);
    if (!hold) return undefined;
    return { holdKey, playerId: hold.playerId, amount: hold.amount, status: 'reserved' };
  }

  async listHolds(): Promise<HoldSnapshot[]> {
    return [...this.holdSnapshots.values()].map(hold => ({ ...hold }));
  }

  async getSettlement(settlementKey: string): Promise<PayoutResult | undefined> {
    return this.inner.inspectSettlement(settlementKey);
  }

  async getCasualRoom(roomId: string): Promise<DurableCasualRoom | undefined> {
    const room = this.rooms.get(roomId);
    return room ? { ...room } : undefined;
  }

  async listCasualRooms(): Promise<DurableCasualRoom[]> {
    return [...this.rooms.values()].map(room => ({ ...room }));
  }

  async reserve(holdKey: string, playerId: string, amount: number): Promise<boolean> {
    const created = this.inner.reserve(holdKey, playerId, amount);
    if (created) this.holdSnapshots.set(holdKey, snapshotFromKey(holdKey, playerId, amount, 'reserved'));
    return created;
  }

  async reserveAll(entries: ReadonlyArray<ReserveEntry>): Promise<void> {
    this.inner.reserveAll(entries);
    for (const entry of entries) {
      this.holdSnapshots.set(
        entry.holdKey,
        snapshotFromKey(entry.holdKey, entry.playerId, entry.amount, 'reserved'),
      );
    }
  }

  async release(holdKey: string): Promise<number> {
    const amount = this.inner.release(holdKey);
    const existing = this.holdSnapshots.get(holdKey);
    if (existing && existing.status === 'reserved') {
      this.holdSnapshots.set(holdKey, { ...existing, status: 'released' });
    }
    return amount;
  }

  async consume(holdKey: string): Promise<void> {
    this.inner.consume(holdKey);
    const existing = this.holdSnapshots.get(holdKey);
    if (existing && existing.status === 'reserved') {
      this.holdSnapshots.set(holdKey, { ...existing, status: 'consumed' });
    }
  }

  async credit(playerId: string, amount: number): Promise<void> {
    this.inner.credit(playerId, amount);
  }

  async lockCollateral(playerId: string, amount: number): Promise<void> {
    this.inner.lockCollateral(playerId, amount);
  }

  async settleCasualWin(input: CasualWinInput): Promise<PayoutResult> {
    return this.inner.settleCasualWin(input);
  }

  async settleCasualTie(input: CasualTieInput): Promise<PayoutResult> {
    return this.inner.settleCasualTie(input);
  }

  async settleTournamentWin(input: TournamentWinInput): Promise<PayoutResult> {
    return this.inner.settleTournamentWin(input);
  }

  async createCasualRoomWithHold(input: CasualRoomCreateInput): Promise<void> {
    await this.withLock(input.id, async () => {
      const rail = input.rail ?? 'legacy_poke';
      if (rail !== 'sol_chain') {
        await this.reserve(creatorHoldKey(input.id), input.creatorId, input.collateral);
      }
      this.rooms.set(input.id, {
        id: input.id,
        matchId: input.matchId,
        roomType: input.roomType,
        battleSize: input.battleSize,
        creatorId: input.creatorId,
        ...(input.invitedPlayerId ? { invitedPlayerId: input.invitedPlayerId } : {}),
        collateral: input.collateral,
        status: rail === 'sol_chain' ? 'pending_deposit' : 'open',
        rail,
        ...(input.collateralLamports != null
          ? { collateralLamports: input.collateralLamports }
          : {}),
      });
    });
  }

  async acceptCasualRoomWithHold(input: CasualRoomAcceptInput): Promise<void> {
    await this.withLock(input.roomId, async () => {
      const room = this.rooms.get(input.roomId);
      if (!room) throw new Error(`Unknown casual room: ${input.roomId}`);
      if (room.status === 'full' && room.opponentId === input.opponentId) {
        if (this.inner.hasHold(opponentHoldKey(input.roomId))) return;
      }
      if (room.status !== 'open') throw new Error('This casual room is no longer open.');
      if (room.opponentId) throw new Error('This casual room is already full.');
      if (input.opponentId === room.creatorId) throw new Error('Creator already occupies this room.');
      if (room.invitedPlayerId && room.invitedPlayerId !== input.opponentId) {
        throw new Error('You were not invited to this private challenge.');
      }
      await this.reserve(opponentHoldKey(input.roomId), input.opponentId, input.collateral);
      room.opponentId = input.opponentId;
      room.status = 'full';
    });
  }

  async cancelCasualRoom(roomId: string): Promise<void> {
    await this.withLock(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown casual room: ${roomId}`);
      if (room.status === 'cancelled') {
        await this.release(creatorHoldKey(roomId));
        await this.release(opponentHoldKey(roomId));
        return;
      }
      if (room.status === 'starting' || room.status === 'battling' || room.status === 'completed') {
        throw new Error('Cannot cancel a room after battle start.');
      }
      await this.release(creatorHoldKey(roomId));
      await this.release(opponentHoldKey(roomId));
      room.status = 'cancelled';
    });
  }

  async abortCasualRoom(roomId: string): Promise<void> {
    await this.withLock(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown casual room: ${roomId}`);
      if (room.status === 'completed') return;
      await this.release(creatorHoldKey(roomId));
      await this.release(opponentHoldKey(roomId));
      room.status = 'cancelled';
    });
  }

  async completeCasualWin(input: CasualCompleteWinInput): Promise<PayoutResult> {
    return this.withLock(input.roomId, async () => {
      const room = this.rooms.get(input.roomId);
      if (room?.status === 'cancelled') throw new Error('This casual room is no longer open.');
      const settlementKey = `casual:${input.roomId}`;
      const existing = this.inner.inspectSettlement(settlementKey);
      await this.consume(creatorHoldKey(input.roomId));
      await this.consume(opponentHoldKey(input.roomId));
      const payout = this.inner.settleCasualWin({
        winnerId: input.winnerId,
        loserId: input.loserId,
        collateral: input.collateral,
        reason: input.reason,
        settlementKey,
      });
      if (room) {
        room.status = 'completed';
        room.winnerId = payout.winnerId;
        room.resultStatus = 'win';
        room.settlementKey = settlementKey;
      }
      return existing ?? payout;
    });
  }

  async completeCasualTie(input: CasualCompleteTieInput): Promise<PayoutResult> {
    return this.withLock(input.roomId, async () => {
      const room = this.rooms.get(input.roomId);
      if (room?.status === 'cancelled') throw new Error('This casual room is no longer open.');
      const settlementKey = `casual:${input.roomId}`;
      const existing = this.inner.inspectSettlement(settlementKey);
      await this.consume(creatorHoldKey(input.roomId));
      await this.consume(opponentHoldKey(input.roomId));
      const payout = this.inner.settleCasualTie({
        player1Id: input.player1Id,
        player2Id: input.player2Id,
        collateral: input.collateral,
        settlementKey,
      });
      if (room) {
        room.status = 'completed';
        delete room.winnerId;
        room.resultStatus = 'tie';
        room.settlementKey = settlementKey;
      }
      return existing ?? payout;
    });
  }

  async completeTournamentWin(input: TournamentCompleteInput): Promise<PayoutResult> {
    const lockKey = input.settlementKey ?? `tournament-win:${input.winnerId}`;
    return this.withLock(lockKey, async () => {
      const payout = this.inner.settleTournamentWin(input);
      for (const holdKey of input.holdKeys) await this.consume(holdKey);
      return payout;
    });
  }

  async setCasualRoomStatus(
    roomId: string,
    status: DurableCasualRoomStatus,
    extras: { battleInstanceId?: string } = {},
  ): Promise<void> {
    await this.withLock(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown casual room: ${roomId}`);
      if (room.status === 'completed' || room.status === 'cancelled') return;
      if (status === 'cancelled' || status === 'completed') {
        throw new Error('Use cancelCasualRoom or completeCasual* for terminal room state.');
      }
      room.status = status;
      if (extras.battleInstanceId) room.battleInstanceId = extras.battleInstanceId;
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

const TOURNAMENT_HOLD = /^tournament:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):(.+)$/;
const CASUAL_HOLD = /^casual:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):(creator|opponent)$/;

function snapshotFromKey(
  holdKey: string,
  playerId: string,
  amount: number,
  status: HoldSnapshot['status'],
): HoldSnapshot {
  const tournament = TOURNAMENT_HOLD.exec(holdKey);
  if (tournament) {
    return {
      holdKey,
      playerId,
      amount,
      status,
      purpose: 'tournament_entry',
      tournamentId: tournament[1].toLowerCase(),
    };
  }
  const casual = CASUAL_HOLD.exec(holdKey);
  if (casual) {
    return {
      holdKey,
      playerId,
      amount,
      status,
      purpose: casual[2] === 'creator' ? 'casual_creator' : 'casual_opponent',
      roomId: casual[1].toLowerCase(),
    };
  }
  return { holdKey, playerId, amount, status };
}
