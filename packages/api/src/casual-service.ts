import { randomUUID } from 'node:crypto';
import { setTimeout as scheduleTimeout } from 'node:timers';

import {
  BattleEngine,
  CASUAL_SHOWDOWN_FORMAT_ID,
  CASUAL_TEAM_SIZE,
  sliceTeamText,
  validateAndPackTeam,
  type BattleEvent,
  type BattleResult,
  type BattleSession,
  type BattleState,
  type BattleTerminal,
  type BattleView,
  type PlayerChoice,
} from '@pokearena/battle-engine';

import { isRetryableRpcError, previewSolCasual } from '@pokearena/solana-client';

import { previewCasual } from '@pokearena/db';
import type { DurableCasualRoom, EconomicsStore, PayoutResult } from '@pokearena/db';

import {
  getCasualPreset,
  pickCreatorPresetId,
  type CasualPresetMon,
} from './casual-presets';
import { SettlementUnknownError } from './chain-economy';
import { InMemoryEconomicsStore } from './memory-economics-store';
import {
  MockEconomics,
  type CasualEconomicsPreview,
  type ChainPayoutResult,
} from './mock-economics';

function solCasualEconomics(collateralLamports: number): CasualEconomicsPreview {
  const preview = previewSolCasual(collateralLamports);
  return {
    symbol: 'SOL',
    collateral: preview.collateralLamports,
    totalPot: preview.totalPotLamports,
    protocolFee: preview.protocolFeeLamports,
    feeRateBps: preview.feeRateBps,
    winnerPayout: preview.winnerPayoutLamports,
  };
}

export interface CasualRosterMon {
  species: string;
  fainted: boolean;
}

export interface CasualRoster {
  playerId: string;
  pokemon: CasualRosterMon[];
}

export interface CasualTeamPreview {
  playerId: string;
  presetId: string;
  presetName: string;
  pokemon: CasualPresetMon[];
  confirmed: boolean;
  selectedSlots?: number[];
}

export type CasualRoomId = string & { readonly __brand: 'CasualRoomId' };
export type CasualMatchId = string & { readonly __brand: 'CasualMatchId' };
export type CasualBattleInstanceId = string & { readonly __brand: 'CasualBattleInstanceId' };

export type CasualRoomType = 'private' | 'open';
export type CasualBattleSize = '1v1' | '2v2';
export type CasualRuleset = 'casual' | 'competitive';
export type CasualRoomStatus =
  | 'pending_deposit'
  | 'open'
  | 'full'
  | 'ready'
  | 'drafting'
  | 'starting'
  | 'battling'
  | 'completed'
  | 'cancelled';

export interface CasualRoom {
  id: CasualRoomId;
  matchId: CasualMatchId;
  roomType: CasualRoomType;
  battleSize: CasualBattleSize;
  format: 'gen9ou';
  ruleset: CasualRuleset;
  creatorId: string;
  opponentId?: string;
  invitedPlayerId?: string;
  collateral: number;
  economics: CasualEconomicsPreview;
  status: CasualRoomStatus;
  ready: Record<string, boolean>;
  battleInstanceId?: CasualBattleInstanceId;
  winnerId?: string;
  result?: BattleResult;
  rosters?: CasualRoster[];
  payout?: PayoutResult | ChainPayoutResult;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  rail?: 'legacy_poke' | 'sol_chain';
  /** Confirmed on-chain deposits. Server-owned; clients cannot set this. */
  deposits?: { creator?: boolean; opponent?: boolean };
  teamPreview?: CasualTeamPreview[];
  countdownEndsAt?: number;
  /** Server clock for the private 6→3 phase. Absent outside drafting. */
  selectionEndsAt?: number;
}

/** Completed-fight fields safe to show the participant. No teams or selections. */
export interface CasualFightRecord {
  id: string;
  matchId: string;
  ruleset: CasualRuleset;
  creatorId: string;
  opponentId: string;
  collateral: number;
  rail?: 'legacy_poke' | 'sol_chain';
  winnerId?: string;
  resultStatus?: 'win' | 'tie';
  endedBy?: string;
  payoutAmount?: number;
  payoutSymbol?: 'POKE' | 'SOL';
  payoutReason?: string;
  protocolFee?: number;
  completedAt: number;
  settled: boolean;
}

export interface CreateCasualRoomInput {
  creatorId: string;
  roomType: CasualRoomType;
  battleSize: CasualBattleSize;
  collateral: number;
  invitedPlayerId?: string;
  rail?: 'legacy_poke' | 'sol_chain';
  ruleset?: CasualRuleset;
}

export const CASUAL_START_COUNTDOWN_MS = 5_000;
/** Private 6→3 window. A stall auto-locks a full trio and the battle can start. */
export const CASUAL_SELECTION_MS = 120_000;

export class CasualNotReadyError extends Error {
  constructor() {
    super('Both players must be ready before the battle can start.');
    this.name = 'CasualNotReadyError';
  }
}

export class CasualTeamRequiredError extends Error {
  constructor() {
    super('Both players must lock a valid team before the battle can start.');
    this.name = 'CasualTeamRequiredError';
  }
}

export class CasualSelectionRequiredError extends Error {
  constructor() {
    super('Both players must confirm three Pokémon before the battle can start.');
    this.name = 'CasualSelectionRequiredError';
  }
}

export class CasualSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasualSelectionError';
  }
}

export class CasualCustomTeamRejectedError extends Error {
  constructor() {
    super('Casual rooms use curated presets. Custom teams are not accepted.');
    this.name = 'CasualCustomTeamRejectedError';
  }
}

export type CasualRoomListener = (room: CasualRoom) => void;

interface ActiveCasualBattle {
  battleInstanceId: CasualBattleInstanceId;
  session: BattleSession;
  unsubscribe: () => void;
}

export class CasualRoomService {
  private readonly rooms = new Map<CasualRoomId, CasualRoom>();
  private readonly roomsByMatchId = new Map<CasualMatchId, CasualRoomId>();
  private readonly activeBattles = new Map<CasualBattleInstanceId, ActiveCasualBattle>();
  private readonly assignedPresets = new Map<string, string>();
  private readonly customTeams = new Map<string, string>();
  private readonly selections = new Map<string, { slots: number[]; confirmed: boolean }>();
  private readonly listeners = new Map<CasualRoomId, Set<CasualRoomListener>>();
  private readonly recentResults: CasualRoom[] = [];
  private readonly forfeitedRooms = new Set<CasualRoomId>();
  private readonly battleStarts = new Map<CasualRoomId, Promise<CasualRoom>>();
  private readonly terminalJobs = new Map<CasualRoomId, Promise<void>>();
  private readonly battleEngine: BattleEngine;
  private readonly economics: EconomicsStore;
  private readonly now: () => number;
  private readonly countdownMs: number;
  private readonly selectionMs: number;
  private readonly countdownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly selectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly allowDemoAuth: boolean;
  private readonly matchTimeoutMs: number;
  private readonly chainSettlement?: {
    settle(input: {
      roomId: string;
      creatorId: string;
      opponentId: string;
      winnerId?: string;
    }): Promise<ChainPayoutResult>;
    refund(roomId: string, creatorId: string, opponentId?: string): Promise<void>;
    depositStillLive?(roomId: string): Promise<boolean>;
  };

  constructor(options: {
    battleEngine?: BattleEngine;
    economics?: EconomicsStore | MockEconomics;
    now?: () => number;
    countdownMs?: number;
    selectionMs?: number;
    allowDemoAuth?: boolean;
    matchTimeoutMs?: number;
    chainSettlement?: CasualRoomService['chainSettlement'];
  } = {}) {
    this.battleEngine = options.battleEngine ?? new BattleEngine();
    this.economics = toEconomicsStore(options.economics);
    this.now = options.now ?? Date.now;
    this.countdownMs = options.countdownMs ?? 0;
    this.selectionMs = options.selectionMs ?? CASUAL_SELECTION_MS;
    this.allowDemoAuth = options.allowDemoAuth ?? false;
    this.matchTimeoutMs = options.matchTimeoutMs ?? 300_000;
    this.chainSettlement = options.chainSettlement;
  }

  async createRoom(input: CreateCasualRoomInput): Promise<CasualRoom> {
    if (input.battleSize !== '1v1' && input.battleSize !== '2v2') {
      throw new Error('battleSize must be 1v1 or 2v2.');
    }
    if (input.roomType !== 'private' && input.roomType !== 'open') {
      throw new Error('roomType must be private or open.');
    }
    const ruleset = input.ruleset ?? 'casual';
    if (ruleset !== 'casual' && ruleset !== 'competitive') {
      throw new Error('ruleset must be casual or competitive.');
    }
    if (input.roomType === 'private' && !input.invitedPlayerId) {
      throw new Error('Private challenges require an invited player.');
    }
    if (input.invitedPlayerId && input.invitedPlayerId === input.creatorId) {
      throw new Error('Cannot challenge yourself.');
    }
    await this.abandonUnfundedSolRooms(input.creatorId);
    const activePlayers = [input.creatorId, input.invitedPlayerId].filter(
      (playerId): playerId is string => Boolean(playerId),
    );
    if (activePlayers.some(playerId => this.playerOccupiesActiveRoom(playerId))) {
      throw new Error('Each player may only have one active casual room.');
    }
    const rail = input.rail ?? 'legacy_poke';
    const economics = rail === 'sol_chain'
      ? solCasualEconomics(input.collateral)
      : previewCasual(input.collateral);
    const timestamp = this.now();
    const id = randomUUID() as CasualRoomId;
    const matchId = `casual-${id}` as CasualMatchId;
    await this.economics.createCasualRoomWithHold({
      id,
      matchId,
      roomType: input.roomType,
      battleSize: input.battleSize,
      creatorId: input.creatorId,
      ...(input.invitedPlayerId ? { invitedPlayerId: input.invitedPlayerId } : {}),
      collateral: input.collateral,
      rail,
      ...(rail === 'sol_chain' ? { collateralLamports: input.collateral } : {}),
    });
    const status: CasualRoomStatus = rail === 'sol_chain' ? 'pending_deposit' : 'open';
    if (rail === 'sol_chain') {
      // Keep the durable room hidden until the creator's escrow/deposit lands.
      // The API starts that transaction immediately after returning the room.
      await this.economics.setCasualRoomStatus(id, status);
    }
    const room: CasualRoom = {
      id,
      matchId,
      roomType: input.roomType,
      battleSize: input.battleSize,
      format: 'gen9ou',
      ruleset,
      creatorId: input.creatorId,
      ...(input.invitedPlayerId ? { invitedPlayerId: input.invitedPlayerId } : {}),
      collateral: input.collateral,
      economics,
      // SOL rooms are not discoverable/joinable until the creator deposit is
      // confirmed. The server starts the creator transaction immediately.
      status,
      ready: { [input.creatorId]: false },
      createdAt: timestamp,
      updatedAt: timestamp,
      rail,
    };
    this.rooms.set(id, room);
    this.roomsByMatchId.set(matchId, id);
    return this.serializeRoom(room);
  }

  listOpenRooms(viewerId?: string): CasualRoom[] {
    return [...this.rooms.values()]
      .filter(room => (
        (room.roomType === 'open' || room.invitedPlayerId === viewerId)
        && (
          (room.status === 'open' && (
            room.rail !== 'sol_chain' || Boolean(room.deposits?.creator)
          ))
          || room.status === 'full'
          || (room.rail === 'sol_chain'
            && room.status === 'pending_deposit'
            && Boolean(room.deposits?.creator))
        )
      ))
      .map(room => this.serializeRoom(room, viewerId))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listLiveBattles(): CasualRoom[] {
    return [...this.rooms.values()]
      .filter(room => room.roomType === 'open' && room.status === 'battling' && Boolean(room.opponentId))
      .map(room => this.serializeRoom(room))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listRoomsForPlayer(playerId: string): CasualRoom[] {
    return [...this.rooms.values()]
      .filter(room => (
        room.creatorId === playerId
        || room.opponentId === playerId
        || room.invitedPlayerId === playerId
      ))
      .map(room => this.serializeRoom(room, playerId))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listRecentResults(limit = 10, viewerId?: string): CasualRoom[] {
    return this.recentResults.slice(0, limit).map(room => this.serializeRoom(room, viewerId));
  }

  /** SOL returned to arena players. Ties store one side's share, so both sides are counted. */
  settledArenaSolLamports(): number {
    return this.listAllCompletedFightRecords().reduce((sum, record) => {
      if (record.payoutSymbol !== 'SOL' && record.rail !== 'sol_chain') return sum;
      const amount = record.payoutAmount ?? 0;
      if (!amount) return sum;
      return sum + (record.resultStatus === 'tie' ? amount * 2 : amount);
    }, 0);
  }

  /**
   * Completed casual and competitive rooms this player fought.
   * Reads the live room plus its settlement payout. Does not include
   * open, battling, or cancelled rooms.
   */
  listCompletedFightRecords(playerId: string): CasualFightRecord[] {
    return this.listAllCompletedFightRecords()
      .filter(record => record.creatorId === playerId || record.opponentId === playerId);
  }

  listAllCompletedFightRecords(): CasualFightRecord[] {
    return [...this.rooms.values()]
      .filter((room): room is CasualRoom & { opponentId: string } => (
        room.status === 'completed'
        && typeof room.opponentId === 'string'
      ))
      .map(room => this.fightRecord(room))
      .sort((a, b) => b.completedAt - a.completedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  getRoom(roomId: string, viewerId?: string): CasualRoom {
    return this.serializeRoom(this.requireRoom(roomId), viewerId);
  }

  /**
   * Rehydrate a durable room after a process restart. Live battle/team state is
   * intentionally not reconstructed here; durable SOL room state is enough to
   * keep a funded lobby joinable until both players reconnect.
   */
  restoreRoom(input: DurableCasualRoom, deposits?: { creator?: boolean; opponent?: boolean }): CasualRoom {
    const id = input.id as CasualRoomId;
    const matchId = input.matchId as CasualMatchId;
    const existing = this.rooms.get(id);
    if (existing) {
      if (deposits) existing.deposits = deposits;
      this.advanceFundedSolCasualLobby(existing);
      return this.serializeRoom(existing);
    }
    const rail = input.rail ?? 'legacy_poke';
    const restoredStatus = (
      rail === 'sol_chain'
      && input.status === 'pending_deposit'
      && Boolean(deposits?.creator)
      && !input.opponentId
    )
      ? 'open'
      : input.status;
    if (restoredStatus !== input.status) {
      void this.economics.setCasualRoomStatus(id, restoredStatus as DurableCasualRoom['status']).catch(() => {
        // The confirmed escrow/deposit is authoritative if persistence lags.
      });
    }
    const economics: CasualEconomicsPreview = input.rail === 'sol_chain'
      ? solCasualEconomics(input.collateralLamports ?? input.collateral)
      : previewCasual(input.collateral);
    const timestamp = this.now();
    const room: CasualRoom = {
      id,
      matchId,
      roomType: input.roomType,
      battleSize: input.battleSize,
      format: 'gen9ou',
      ruleset: 'casual',
      creatorId: input.creatorId,
      ...(input.opponentId ? { opponentId: input.opponentId } : {}),
      ...(input.invitedPlayerId ? { invitedPlayerId: input.invitedPlayerId } : {}),
      collateral: input.collateral,
      economics,
      status: restoredStatus as CasualRoomStatus,
      ready: {
        [input.creatorId]: false,
        ...(input.opponentId ? { [input.opponentId]: false } : {}),
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      rail,
      ...(deposits ? { deposits } : {}),
      ...(input.winnerId ? { winnerId: input.winnerId } : {}),
      ...(input.battleInstanceId
        ? { battleInstanceId: input.battleInstanceId as CasualBattleInstanceId }
        : {}),
    };
    this.rooms.set(id, room);
    this.roomsByMatchId.set(matchId, id);
    this.advanceFundedSolCasualLobby(room);
    return this.serializeRoom(room);
  }

  markSolDeposit(roomId: string, side: 'creator' | 'opponent'): CasualRoom {
    const room = this.requireRoom(roomId);
    if (room.rail !== 'sol_chain') {
      throw new Error('This room is not a real-stake match.');
    }
    if (room.status === 'cancelled' || room.status === 'completed') {
      return this.serializeRoom(room);
    }
    room.deposits = {
      creator: side === 'creator' ? true : Boolean(room.deposits?.creator),
      opponent: side === 'opponent' ? true : Boolean(room.deposits?.opponent),
    };
    if (
      side === 'creator'
      && room.status === 'pending_deposit'
      && !room.opponentId
    ) {
      room.status = 'open';
      // The in-memory transition is immediate for connected clients. Persist
      // it asynchronously so a restart also restores the public open state.
      void this.economics.setCasualRoomStatus(room.id, 'open').catch(() => {
        // On-chain confirmation remains authoritative; boot recovery can
        // reconstruct the room from the escrow if persistence briefly fails.
      });
    }
    this.advanceFundedSolCasualLobby(room);
    room.updatedAt = this.now();
    this.notify(room);
    return this.serializeRoom(room);
  }

  /**
   * Undo a deposit the signature path already accepted when a later escrow
   * read contradicts the room. A live or finished battle is left alone.
   */
  revokeUnmatchedSolDeposit(
    roomId: string,
    side: 'creator' | 'opponent',
    reason: string,
  ): CasualRoom {
    const room = this.requireRoom(roomId);
    if (
      room.status === 'starting'
      || room.status === 'battling'
      || room.status === 'completed'
      || room.status === 'cancelled'
    ) {
      console.warn('[pokearena-deposit]', {
        roomId,
        side,
        escrow: 'mismatch',
        lobby: 'left-open',
        reason: `${reason}; room is ${room.status}`,
      });
      return this.serializeRoom(room);
    }
    room.deposits = {
      creator: side === 'creator' ? false : Boolean(room.deposits?.creator),
      opponent: side === 'opponent' ? false : Boolean(room.deposits?.opponent),
    };
    room.ready[room.creatorId] = false;
    if (room.opponentId) room.ready[room.opponentId] = false;
    this.clearSelectionTimer(room.id);
    this.clearCountdownTimer(room.id);
    delete room.selectionEndsAt;
    delete room.countdownEndsAt;
    if (room.opponentId) room.status = 'full';
    else if (room.deposits.creator) room.status = 'open';
    else room.status = 'pending_deposit';
    void this.economics.setCasualRoomStatus(room.id, room.status).catch(() => {
      // The in-memory correction is what connected clients see immediately.
    });
    room.updatedAt = this.now();
    this.notify(room);
    console.warn('[pokearena-deposit]', {
      roomId,
      side,
      escrow: 'mismatch',
      lobby: room.status,
      reason,
    });
    return this.serializeRoom(room);
  }

  getRoomByMatchId(matchId: string, viewerId?: string): CasualRoom | undefined {
    const roomId = this.roomsByMatchId.get(matchId as CasualMatchId);
    if (!roomId) return undefined;
    const room = this.rooms.get(roomId);
    return room ? this.serializeRoom(room, viewerId) : undefined;
  }

  async acceptRoom(roomId: string, playerId: string): Promise<CasualRoom> {
    const room = this.requireRoom(roomId);
    if (
      room.rail === 'sol_chain'
      && room.opponentId === playerId
      && (room.status === 'full' || room.status === 'ready' || room.status === 'drafting')
    ) {
      return this.serializeRoom(room, playerId);
    }
    const joinable = room.rail === 'sol_chain'
      ? Boolean(room.deposits?.creator)
        && (room.status === 'open' || room.status === 'pending_deposit')
      : room.status === 'open';
    if (!joinable) throw new Error('This casual room is no longer open.');
    if (room.opponentId) throw new Error('This casual room is already full.');
    if (playerId === room.creatorId) throw new Error('Creator already occupies this room.');
    if (room.roomType === 'private' && room.invitedPlayerId && room.invitedPlayerId !== playerId) {
      throw new Error('You were not invited to this private challenge.');
    }
    if (this.playerOccupiesActiveRoom(playerId, room.id)) {
      throw new Error('Each player may only have one active casual room.');
    }
    await this.economics.acceptCasualRoomWithHold({
      roomId: room.id,
      opponentId: playerId,
      collateral: room.collateral,
    });
    room.opponentId = playerId;
    room.ready[playerId] = false;
    room.status = 'full';
    room.updatedAt = this.now();
    this.notify(room);
    return this.serializeRoom(room, playerId);
  }

  setReady(roomId: string, playerId: string, ready: boolean, team?: string): CasualRoom {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (
      isCasualSelectRoom(room)
      && room.status === 'drafting'
      && ready
    ) {
      return this.serializeRoom(room, playerId);
    }
    if (room.status !== 'full' && room.status !== 'ready') {
      throw new Error('Room is not ready for readiness changes.');
    }
    if (isCasualSelectRoom(room)) {
      if (team) throw new CasualCustomTeamRejectedError();
      if (room.status !== 'full' && room.status !== 'ready') {
        throw new Error('Room is not ready for readiness changes.');
      }
      room.ready[playerId] = ready;
      this.syncReadyStatus(room);
      room.updatedAt = this.now();
      this.notify(room);
      return this.serializeRoom(room, playerId);
    }
    if (isCompetitiveRoom(room)) {
      return this.lockCompetitiveTeam(room, playerId, ready, team);
    }
    if (team) throw new CasualCustomTeamRejectedError();
    room.ready[playerId] = ready;
    const opponentId = room.opponentId;
    const bothReady = Boolean(opponentId)
      && room.ready[room.creatorId]
      && Boolean(opponentId && room.ready[opponentId]);
    room.status = bothReady ? 'ready' : 'full';
    room.updatedAt = this.now();
    this.notify(room);
    return this.serializeRoom(room, playerId);
  }

  advanceReadyCountdown(roomId: string, viewerId?: string): CasualRoom {
    const room = this.requireRoom(roomId);
    if (isCasualSelectRoom(room) && room.status === 'drafting') {
      return this.serializeRoom(room, viewerId);
    }
    if (room.status !== 'ready' || !room.opponentId) {
      throw new CasualNotReadyError();
    }
    if (room.countdownEndsAt && this.now() < room.countdownEndsAt) {
      throw new Error('Wait for the countdown to finish.');
    }
    this.clearCountdownTimer(room.id);
    delete room.countdownEndsAt;
    if (isCasualSelectRoom(room)) {
      this.dealCasualDraft(room);
    }
    room.updatedAt = this.now();
    this.notify(room);
    return this.serializeRoom(room, viewerId);
  }

  selectTeam(
    roomId: string,
    playerId: string,
    slots: readonly number[],
    confirm = false,
  ): CasualRoom {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (!isCasualSelectRoom(room)) {
      throw new CasualSelectionError('Team selection is only available for Casual 6 → 3 battles.');
    }
    if (room.status === 'starting' || room.status === 'battling' || room.status === 'completed') {
      const current = this.selections.get(selectionKey(room.id, playerId));
      if (
        confirm
        && current?.confirmed
        && sameSlots(current.slots, normalizeSlots(slots, true))
      ) {
        return this.serializeRoom(room, playerId);
      }
      throw new CasualSelectionError('Team selection is locked after battle start.');
    }
    if (room.status !== 'drafting') {
      throw new CasualSelectionError('Waiting for both players to ready up before team selection.');
    }
    if (!this.assignedPresets.has(selectionKey(room.id, playerId))) {
      throw new CasualSelectionError('No Casual preset is assigned to this player.');
    }

    const normalized = normalizeSlots(slots, confirm);
    const key = selectionKey(room.id, playerId);
    const current = this.selections.get(key);

    if (current?.confirmed) {
      if (confirm && sameSlots(current.slots, normalized)) {
        room.ready[playerId] = true;
        this.syncReadyStatus(room);
        room.updatedAt = this.now();
        this.notify(room);
        return this.serializeRoom(room, playerId);
      }
      throw new CasualSelectionError('Selection is locked.');
    }

    this.selections.set(key, {
      slots: normalized,
      confirmed: confirm,
    });
    room.ready[playerId] = confirm;
    this.syncReadyStatus(room);
    if (this.selectionsLocked(room.id)) this.clearSelectionTimer(room.id);
    room.updatedAt = this.now();
    this.notify(room);
    return this.serializeRoom(room, playerId);
  }

  /** True once both players have locked a trio. Does not expose which slots. */
  selectionsLocked(roomId: string): boolean {
    const room = this.rooms.get(roomId as CasualRoomId);
    if (!room?.opponentId || room.status !== 'drafting') return false;
    const creator = this.selections.get(selectionKey(room.id, room.creatorId));
    const opponent = this.selections.get(selectionKey(room.id, room.opponentId));
    return Boolean(creator?.confirmed && opponent?.confirmed);
  }

  /**
   * A SOL room is persisted before the wallet signs. If that signature never
   * lands, the creator has no visible fight and no escrow, but the record still
   * occupies the one-room cap. Replace only that unfunded attempt.
   */
  private async abandonUnfundedSolRooms(creatorId: string): Promise<void> {
    const stale = [...this.rooms.values()].filter(room => (
      room.creatorId === creatorId
      && room.rail === 'sol_chain'
      && room.status === 'pending_deposit'
      && !room.opponentId
      && !room.deposits?.creator
      && !room.deposits?.opponent
    ));
    for (const room of stale) {
      if (await this.chainSettlement?.depositStillLive?.(room.id)) continue;
      if (this.chainSettlement) {
        await this.chainSettlement.refund(room.id, room.creatorId, room.opponentId);
      }
      const current = this.rooms.get(room.id);
      if (
        !current
        || current.status !== 'pending_deposit'
        || current.deposits?.creator
        || current.deposits?.opponent
        || current.opponentId
      ) {
        continue;
      }
      await this.economics.cancelCasualRoom(current.id);
      current.status = 'cancelled';
      current.updatedAt = this.now();
      this.notify(current);
    }
  }

  private playerOccupiesActiveRoom(playerId: string, excludeRoomId?: string): boolean {
    return [...this.rooms.values()].some(room => (
      room.id !== excludeRoomId
      && isActiveRoomStatus(room.status)
      && (room.creatorId === playerId || room.opponentId === playerId)
    ));
  }

  async cancelRoom(roomId: string, playerId: string): Promise<CasualRoom> {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (room.status === 'starting' || room.status === 'battling' || room.status === 'completed') {
      throw new Error('Cannot cancel a room after battle start.');
    }
    if (room.status === 'cancelled') return this.serializeRoom(room, playerId);
    this.clearCountdownTimer(room.id);
    this.clearSelectionTimer(room.id);
    delete room.countdownEndsAt;
    delete room.selectionEndsAt;
    if (room.rail === 'sol_chain' && !this.chainSettlement) {
      throw new Error('Chain settlement is not configured for a SOL room.');
    }
    if (room.rail === 'sol_chain' && this.chainSettlement) {
      await this.chainSettlement.refund(room.id, room.creatorId, room.opponentId);
    }
    await this.economics.cancelCasualRoom(room.id);
    room.status = 'cancelled';
    room.updatedAt = this.now();
    this.notify(room);
    return this.serializeRoom(room, playerId);
  }

  async forfeit(roomId: string, playerId: string): Promise<CasualRoom> {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (room.status === 'completed') return this.serializeRoom(room, playerId);
    if (room.status !== 'battling' || !room.battleInstanceId) {
      throw new Error('This fight is not live.');
    }
    const battle = this.requireActiveBattle(room.battleInstanceId);
    this.forfeitedRooms.add(room.id);
    try {
      await battle.session.forfeit(playerId);
    } catch (error) {
      this.forfeitedRooms.delete(room.id);
      throw error;
    }
    for (let attempt = 0; attempt < 10 && this.requireRoom(roomId).status === 'battling'; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    await this.flushTerminal(room.id);
    const settled = this.requireRoom(roomId);
    if (settled.status !== 'completed') {
      throw new Error('Forfeit did not end the fight.');
    }
    return this.serializeRoom(settled, playerId);
  }

  async startBattle(roomId: string, playerId: string, team?: string): Promise<CasualRoom> {
    if (team) throw new CasualCustomTeamRejectedError();
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (!room.opponentId) throw new Error('Waiting for an opponent before battle start.');
    if (room.battleSize === '2v2') {
      throw new Error('2v2 battles are not supported yet. Configure the room, but start is unavailable.');
    }
    if (room.status === 'battling' && room.battleInstanceId) return this.serializeRoom(room, playerId);
    const inflight = this.battleStarts.get(room.id);
    if (inflight) return inflight.then(started => this.serializeRoom(started, playerId));
    if (this.advanceFundedSolCasualLobby(room) && room.status === 'drafting') {
      return this.serializeRoom(room, playerId);
    }
    if (isCasualSelectRoom(room) && room.status === 'ready') {
      return this.advanceReadyCountdown(room.id, playerId);
    }
    if (isCasualSelectRoom(room) && room.status === 'drafting') {
      const draftCreator = this.battleTeamFor(room, room.creatorId);
      const draftOpponent = this.battleTeamFor(room, room.opponentId);
      if (!draftCreator || !draftOpponent) {
        return this.serializeRoom(room, playerId);
      }
    }
    if (room.status !== 'ready' && room.status !== 'drafting') {
      throw new CasualNotReadyError();
    }
    if (isCasualSelectRoom(room) && room.status !== 'drafting') {
      throw new CasualNotReadyError();
    }
    const creatorTeam = this.battleTeamFor(room, room.creatorId);
    const opponentTeam = this.battleTeamFor(room, room.opponentId);
    if (!creatorTeam || !opponentTeam) {
      throw isCompetitiveRoom(room) ? new CasualTeamRequiredError() : new CasualSelectionRequiredError();
    }
    const teams = [creatorTeam, opponentTeam] as const;
    const battleOptions = battleOptionsFor(room);
    validateAndPackTeam(teams[0], 'gen9ou', battleOptions);
    validateAndPackTeam(teams[1], 'gen9ou', battleOptions);

    delete room.countdownEndsAt;
    delete room.selectionEndsAt;
    this.clearCountdownTimer(room.id);
    this.clearSelectionTimer(room.id);
    room.status = 'starting';
    room.updatedAt = this.now();
    const run = (async () => {
      try {
        await this.economics.setCasualRoomStatus(room.id, 'starting');
      } catch (error) {
        room.status = 'ready';
        throw error;
      }
      return this.launchBattle(room, teams, battleOptions);
    })();
    this.battleStarts.set(room.id, run);
    try {
      const started = await run;
      return this.serializeRoom(started, playerId);
    } finally {
      this.battleStarts.delete(room.id);
    }
  }

  getMatchState(matchId: string, viewer: string | 'spectator'): BattleState | undefined {
    const room = this.requireRoomByMatchId(matchId);
    if (!room.battleInstanceId) return undefined;
    const battle = this.requireActiveBattle(room.battleInstanceId);
    return battle.session.getState(viewer === 'spectator' ? 'spectator' : viewer);
  }

  getMatchView(matchId: string, viewer: string | 'spectator'): BattleView | undefined {
    const room = this.requireRoomByMatchId(matchId);
    if (!room.battleInstanceId) return undefined;
    const battle = this.requireActiveBattle(room.battleInstanceId);
    return battle.session.getView(viewer === 'spectator' ? 'spectator' : viewer);
  }

  getMatchEvents(matchId: string, viewer: string | 'spectator'): readonly BattleEvent[] {
    const room = this.requireRoomByMatchId(matchId);
    if (!room.battleInstanceId) return [];
    const battle = this.requireActiveBattle(room.battleInstanceId);
    return battle.session.getEvents(viewer === 'spectator' ? 'spectator' : viewer);
  }

  async submitChoice(input: {
    matchId: string;
    battleInstanceId: string;
    playerId: string;
    revision: number;
    choice: PlayerChoice;
  }): Promise<void> {
    const room = this.requireRoomByMatchId(input.matchId);
    if (room.creatorId !== input.playerId && room.opponentId !== input.playerId) {
      throw new Error('You are not a player in this casual match.');
    }
    if (room.battleInstanceId !== input.battleInstanceId) {
      throw new Error('Battle instance does not match this casual room.');
    }
    const battle = this.requireActiveBattle(input.battleInstanceId as CasualBattleInstanceId);
    await battle.session.submitChoice({
      battleId: battle.session.id,
      playerId: input.playerId,
      revision: input.revision,
      choice: input.choice,
    });
  }

  subscribe(roomId: string, listener: CasualRoomListener): () => void {
    const room = this.requireRoom(roomId);
    let listeners = this.listeners.get(room.id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(room.id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(room.id);
    };
  }

  private async launchBattle(
    room: CasualRoom,
    teams: readonly [string, string],
    battleOptions: { size: number; showdownFormatId: string },
  ): Promise<CasualRoom> {
    const opponentId = room.opponentId;
    if (!opponentId) throw new Error('Waiting for an opponent before battle start.');
    let session: BattleSession;
    try {
      session = await this.battleEngine.createBattle({
        format: 'gen9ou',
        showdownFormatId: battleOptions.showdownFormatId,
        teamSize: battleOptions.size,
        players: [
          { id: room.creatorId, name: room.creatorId },
          { id: opponentId, name: opponentId },
        ],
        teams,
        timeoutMs: this.matchTimeoutMs,
      });
      await session.start();
    } catch (error) {
      await this.abortRoom(room);
      throw error;
    }

    const battleInstanceId = session.id as CasualBattleInstanceId;
    room.battleInstanceId = battleInstanceId;
    room.status = 'battling';
    room.updatedAt = this.now();
    await this.economics.setCasualRoomStatus(room.id, 'battling', { battleInstanceId });
    const active: ActiveCasualBattle = {
      battleInstanceId,
      session,
      unsubscribe: () => undefined,
    };
    this.activeBattles.set(battleInstanceId, active);
    active.unsubscribe = session.subscribe(terminal => {
      this.enqueueTerminal(room.id, terminal);
    });
    session.subscribeEvents(() => {
      queueMicrotask(() => this.notify(this.requireRoom(room.id)));
    });
    await this.flushTerminal(room.id);
    if (room.status === 'battling') this.notify(room);
    return room;
  }

  private enqueueTerminal(roomId: CasualRoomId, terminal: BattleTerminal): Promise<void> {
    const previous = this.terminalJobs.get(roomId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handleTerminal(roomId, terminal));
    this.terminalJobs.set(roomId, next);
    void next.catch(error => {
      if (error instanceof SettlementUnknownError || isRetryableRpcError(error)) {
        console.info('[pokearena-settlement]', {
          roomId,
          operation: 'settleCasual',
          classified: 'retryable',
          retryInMs: error instanceof SettlementUnknownError ? error.retryInMs : 8_000,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      console.error('[pokearena] casual settlement failed', roomId, error);
    });
    return next;
  }

  /**
   * Run the terminal handler again after a retryable RPC failure. The battle
   * subscription already fired, so reconciliation has to ask the session for
   * the result it still holds.
   */
  async resumeSolSettlement(roomId: CasualRoomId): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'battling' || room.rail !== 'sol_chain' || !room.battleInstanceId) return;
    const battle = this.activeBattles.get(room.battleInstanceId);
    if (!battle) return;
    const readResult = battle.session.getResult;
    if (typeof readResult !== 'function') return;
    const result = readResult.call(battle.session);
    if (!result || (result.status !== 'win' && result.status !== 'tie')) return;
    await this.enqueueTerminal(roomId, { type: 'completed', result });
  }

  solSettlementRooms(): Array<{
    id: CasualRoomId;
    status: CasualRoom['status'];
    creatorId: string;
    opponentId?: string;
    rail: CasualRoom['rail'];
  }> {
    return [...this.rooms.values()]
      .filter(room => (
        room.rail === 'sol_chain'
        && (room.status === 'battling' || room.status === 'completed')
        && Boolean(room.opponentId)
      ))
      .map(room => ({
        id: room.id,
        status: room.status,
        creatorId: room.creatorId,
        ...(room.opponentId ? { opponentId: room.opponentId } : {}),
        rail: room.rail,
      }));
  }

  private async flushTerminal(roomId: CasualRoomId): Promise<void> {
    const job = this.terminalJobs.get(roomId);
    if (job) await job;
  }

  private async handleTerminal(roomId: CasualRoomId, terminal: BattleTerminal): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || room.status === 'completed' || room.status === 'cancelled') return;

    if (terminal.type === 'failed') {
      if (!this.failureIsAuthoritative(room, terminal)) return;
      await this.abortRoom(room);
      return;
    }

    const result = this.confirmedTerminalResult(room, terminal.result);
    if (!result) return;

    let chainPayout: ChainPayoutResult | undefined;
    if (room.rail === 'sol_chain' && !this.chainSettlement) {
      throw new Error('Chain settlement is not configured for a SOL room.');
    }
    if (room.rail === 'sol_chain' && room.opponentId && this.chainSettlement) {
      try {
        chainPayout = await this.chainSettlement.settle({
          roomId: room.id,
          creatorId: room.creatorId,
          opponentId: room.opponentId,
          ...(result.status === 'win' && result.winner
            ? { winnerId: result.winner }
            : {}),
        });
      } catch (error) {
        if (error instanceof SettlementUnknownError || isRetryableRpcError(error)) {
          console.info('[pokearena-settlement]', {
            roomId: room.id,
            operation: 'settleCasual',
            classified: 'retryable',
            retryInMs: error instanceof SettlementUnknownError ? error.retryInMs : 8_000,
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        throw error;
      }
    }

    if (result.status === 'win' && result.winner && room.opponentId) {
      room.winnerId = result.winner;
      const recorded = await this.economics.completeCasualWin({
        roomId: room.id,
        winnerId: result.winner,
        loserId: result.winner === room.creatorId ? room.opponentId : room.creatorId,
        collateral: room.collateral,
        reason: this.forfeitedRooms.has(room.id) || result.endedBy === 'timeout'
          ? 'casual-forfeit'
          : 'casual-win',
      });
      room.payout = chainPayout ?? recorded;
    } else if (room.opponentId) {
      delete room.winnerId;
      const recorded = await this.economics.completeCasualTie({
        roomId: room.id,
        player1Id: room.creatorId,
        player2Id: room.opponentId,
        collateral: room.collateral,
      });
      room.payout = chainPayout ?? recorded;
    } else {
      await this.abortRoom(room);
      return;
    }
    room.result = result;
    room.completedAt = this.now();
    room.updatedAt = room.completedAt;
    room.status = 'completed';
    if (room.battleInstanceId) {
      const battle = this.activeBattles.get(room.battleInstanceId);
      const readView = battle?.session.getView;
      const sides = battle && typeof readView === 'function'
        ? readView.call(battle.session, 'spectator').sides
        : undefined;
      if (sides) {
        room.rosters = sides.map(side => ({
          playerId: side.playerId,
          pokemon: side.party.map(mon => ({
            species: mon.species,
            fainted: Boolean(mon.fainted),
          })),
        }));
      }
    }

    this.recentResults.unshift(cloneRoom(room));
    if (this.recentResults.length > 25) this.recentResults.pop();
    this.notify(room);
  }

  /**
   * Settlement is allowed only when this room's battle session has already
   * ended and its stored result is the claimed terminal. An active fight,
   * a faint, or a mismatched event returns undefined and must not be paid.
   */
  private confirmedTerminalResult(room: CasualRoom, claimed: BattleResult): BattleResult | undefined {
    if (!room.battleInstanceId) return undefined;
    const battle = this.activeBattles.get(room.battleInstanceId);
    if (!battle || typeof battle.session.getResult !== 'function' || typeof battle.session.getState !== 'function') {
      return undefined;
    }
    const authoritative = battle.session.getResult();
    if (!authoritative || battle.session.getState().lifecycle !== 'ended') return undefined;
    if (!sameBattleResult(authoritative, claimed)) return undefined;
    return authoritative;
  }

  private failureIsAuthoritative(
    room: CasualRoom,
    terminal: Extract<BattleTerminal, { type: 'failed' }>,
  ): boolean {
    if (!room.battleInstanceId) return false;
    const battle = this.activeBattles.get(room.battleInstanceId);
    if (!battle || typeof battle.session.getState !== 'function') return false;
    const state = battle.session.getState();
    return state.lifecycle === 'failed' && state.failure?.code === terminal.failure.code;
  }

  /**
   * Return a SOL stake when Showdown never became a live result, then mark
   * the room cancelled. Chain settlement runs before the database write.
   */
  async releaseUnstartedSolRoom(roomId: string, playerId: string): Promise<CasualRoom> {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (room.status === 'battling' || room.status === 'completed') {
      return this.serializeRoom(room, playerId);
    }
    await this.abortRoom(room);
    return this.serializeRoom(this.requireRoom(roomId), playerId);
  }

  private async abortRoom(room: CasualRoom): Promise<void> {
    if (room.status === 'completed' || room.status === 'cancelled') return;
    if (room.rail === 'sol_chain') {
      if (!this.chainSettlement) {
        throw new Error('Chain settlement is not configured for a SOL room.');
      }
      await this.chainSettlement.refund(room.id, room.creatorId, room.opponentId);
    }
    await this.economics.abortCasualRoom(room.id);
    room.status = 'cancelled';
    room.updatedAt = this.now();
    this.notify(room);
  }

  private notify(room: CasualRoom): void {
    const listeners = this.listeners.get(room.id);
    if (!listeners) return;
    const snapshot = this.serializeRoom(room);
    for (const listener of listeners) {
      queueMicrotask(() => {
        try {
          listener(snapshot);
        } catch {
          // Room observers must not corrupt casual room state.
        }
      });
    }
  }

  private battleTeamFor(room: CasualRoom, playerId: string): string | undefined {
    const key = selectionKey(room.id, playerId);
    if (isCompetitiveRoom(room)) {
      return room.ready[playerId] ? this.customTeams.get(key) : undefined;
    }
    const selection = this.selections.get(key);
    const presetId = this.assignedPresets.get(key);
    if (!selection?.confirmed || selection.slots.length !== CASUAL_TEAM_SIZE || !presetId) {
      return undefined;
    }
    return sliceTeamText(getCasualPreset(presetId).paste, selection.slots);
  }

  private dealCasualDraft(room: CasualRoom): void {
    this.assignCasualPresets(room);
    room.status = 'drafting';
    room.ready[room.creatorId] = false;
    if (room.opponentId) room.ready[room.opponentId] = false;
    delete room.countdownEndsAt;
    if (this.selectionMs > 0) {
      room.selectionEndsAt = this.now() + this.selectionMs;
      this.armSelection(room);
    } else {
      delete room.selectionEndsAt;
    }
  }

  /**
   * When the selection clock expires, lock each player into three slots.
   * An unfinished trio is filled from the remaining shared six in slot order.
   */
  sealSelection(roomId: string, viewerId?: string): CasualRoom {
    const room = this.requireRoom(roomId);
    if (room.status !== 'drafting') return this.serializeRoom(room, viewerId);
    if (room.selectionEndsAt != null && this.now() < room.selectionEndsAt) {
      throw new CasualSelectionError('Selection timer is still running.');
    }
    this.applySelectionTimeout(room);
    return this.serializeRoom(room, viewerId);
  }

  private applySelectionTimeout(room: CasualRoom): void {
    if (room.status !== 'drafting' || !room.opponentId) return;
    this.clearSelectionTimer(room.id);
    for (const playerId of [room.creatorId, room.opponentId]) {
      const key = selectionKey(room.id, playerId);
      const current = this.selections.get(key);
      if (current?.confirmed && current.slots.length === CASUAL_TEAM_SIZE) {
        room.ready[playerId] = true;
        continue;
      }
      const slots = fillSelectionSlots(current?.slots ?? []);
      this.selections.set(key, { slots, confirmed: true });
      room.ready[playerId] = true;
    }
    room.updatedAt = this.now();
    this.notify(room);
  }

  private armSelection(room: CasualRoom): void {
    this.clearSelectionTimer(room.id);
    const endsAt = room.selectionEndsAt;
    if (!endsAt) return;
    const delay = Math.max(0, endsAt - this.now());
    const timer = scheduleTimeout(() => {
      this.selectionTimers.delete(room.id);
      try {
        const current = this.rooms.get(room.id);
        if (!current || current.status !== 'drafting') return;
        if (current.selectionEndsAt != null && this.now() < current.selectionEndsAt) return;
        this.applySelectionTimeout(current);
      } catch {
        // Selection may already be locked or the room cancelled.
      }
    }, delay);
    timer.unref?.();
    this.selectionTimers.set(room.id, timer);
  }

  private clearSelectionTimer(roomId: string): void {
    const timer = this.selectionTimers.get(roomId);
    if (!timer) return;
    clearTimeout(timer);
    this.selectionTimers.delete(roomId);
  }

  private assignCasualPresets(room: CasualRoom): void {
    if (!room.opponentId) return;
    const creatorKey = selectionKey(room.id, room.creatorId);
    const opponentKey = selectionKey(room.id, room.opponentId);
    const presetId = this.assignedPresets.get(creatorKey)
      ?? this.assignedPresets.get(opponentKey)
      ?? pickCreatorPresetId();
    this.assignedPresets.set(creatorKey, presetId);
    this.assignedPresets.set(opponentKey, presetId);
  }

  private lockCompetitiveTeam(
    room: CasualRoom,
    playerId: string,
    ready: boolean,
    team?: string,
  ): CasualRoom {
    const key = selectionKey(room.id, playerId);
    if (ready) {
      const paste = team?.trim();
      if (!paste) throw new CasualTeamRequiredError();
      validateAndPackTeam(paste, 'gen9ou');
      this.customTeams.set(key, paste);
    }
    room.ready[playerId] = ready;
    this.syncReadyStatus(room);
    room.updatedAt = this.now();
    this.notify(room);
    return this.serializeRoom(room, playerId);
  }

  private fightRecord(room: CasualRoom & { opponentId: string }): CasualFightRecord {
    const payout = room.payout;
    const resultStatus = room.result?.status === 'win' || room.result?.status === 'tie'
      ? room.result.status
      : undefined;
    return {
      id: room.id,
      matchId: room.matchId,
      ruleset: room.ruleset,
      creatorId: room.creatorId,
      opponentId: room.opponentId,
      collateral: room.collateral,
      ...(room.rail ? { rail: room.rail } : {}),
      ...(room.winnerId ? { winnerId: room.winnerId } : {}),
      ...(resultStatus ? { resultStatus } : {}),
      ...(room.result?.endedBy ? { endedBy: room.result.endedBy } : {}),
      ...(payout
        ? {
            payoutAmount: payout.amount,
            payoutSymbol: payout.symbol,
            ...(payout.reason ? { payoutReason: payout.reason } : {}),
            ...(payout.protocolFee !== undefined ? { protocolFee: payout.protocolFee } : {}),
          }
        : {}),
      completedAt: room.completedAt ?? room.updatedAt,
      settled: payout !== undefined,
    };
  }

  private serializeRoom(room: CasualRoom, viewerId?: string): CasualRoom {
    const snapshot = cloneRoom(room);
    const teamPreview = this.previewForRoom(room, viewerId);
    if (teamPreview.length) snapshot.teamPreview = teamPreview;
    else delete snapshot.teamPreview;
    return snapshot;
  }

  private previewForRoom(room: CasualRoom, viewerId?: string): CasualTeamPreview[] {
    if (!isCasualSelectRoom(room) || !room.opponentId) return [];
    if (room.status !== 'drafting' && room.status !== 'starting' && room.status !== 'battling' && room.status !== 'completed') {
      return [];
    }
    const isPlayer = viewerId === room.creatorId || viewerId === room.opponentId;
    const playerIds = [room.creatorId, room.opponentId].filter((id): id is string => Boolean(id));
    const revealed = room.status === 'starting'
      || room.status === 'battling'
      || room.status === 'completed';
    if (!isPlayer && !revealed) return [];
    return playerIds.flatMap(playerId => {
      const presetId = this.assignedPresets.get(selectionKey(room.id, playerId));
      if (!presetId) return [];
      const preset = getCasualPreset(presetId);
      const selection = this.selections.get(selectionKey(room.id, playerId));
      const showSlots = revealed || viewerId === playerId;
      return [{
        playerId,
        presetId: preset.id,
        presetName: preset.name,
        pokemon: preset.pokemon.map(mon => ({ ...mon, moves: [...mon.moves], types: [...mon.types] })),
        confirmed: Boolean(selection?.confirmed),
        ...(showSlots && selection?.slots.length ? { selectedSlots: [...selection.slots] } : {}),
      }];
    });
  }

  /**
   * Real SOL casual 1v1 rooms hide the ready control. Once both stakes confirm,
   * treat the lobby as ready and deal the shared six immediately.
   */
  private advanceFundedSolCasualLobby(room: CasualRoom): boolean {
    if (room.rail !== 'sol_chain' || !isCasualSelectRoom(room) || !room.opponentId) {
      return false;
    }
    if (!(room.deposits?.creator && room.deposits.opponent)) return false;
    if (
      room.status !== 'pending_deposit'
      && room.status !== 'open'
      && room.status !== 'full'
      && room.status !== 'ready'
    ) {
      return false;
    }
    room.ready[room.creatorId] = true;
    room.ready[room.opponentId] = true;
    this.syncReadyStatus(room);
    void this.economics.setCasualRoomStatus(room.id, 'ready').catch(() => {
      // In-memory draft is enough for connected clients; boot recovery can
      // reopen the lobby from the confirmed deposits.
    });
    return true;
  }

  private syncReadyStatus(room: CasualRoom): void {
    const opponentId = room.opponentId;
    const bothReady = Boolean(opponentId)
      && room.ready[room.creatorId]
      && Boolean(opponentId && room.ready[opponentId]);
    if (room.status === 'full' || room.status === 'ready') {
      room.status = bothReady ? 'ready' : 'full';
    }
    if (
      bothReady
      && room.rail === 'sol_chain'
      && !(room.deposits?.creator && room.deposits.opponent)
    ) {
      // Real SOL rooms stay in `ready` while the wallet funding flow runs.
      // The server advances to drafting only after both deposits reconcile.
      return;
    }
    if (bothReady && room.battleSize === '1v1' && (room.status === 'ready' || room.status === 'drafting')) {
      if (isCasualSelectRoom(room) && room.status === 'ready') {
        // Casual 6 → 3 has its own selection clock; a second ready countdown
        // only delays the useful part of the match.
        delete room.countdownEndsAt;
        this.clearCountdownTimer(room.id);
        this.dealCasualDraft(room);
      } else if (!isCasualSelectRoom(room) && room.status === 'ready') {
        room.countdownEndsAt ??= this.now() + (this.countdownMs > 0 ? this.countdownMs : CASUAL_START_COUNTDOWN_MS);
      }
    } else if (room.status === 'full' || room.status === 'ready') {
      delete room.countdownEndsAt;
      this.clearCountdownTimer(room.id);
    }
  }

  private armCountdown(room: CasualRoom): void {
    this.clearCountdownTimer(room.id);
    const endsAt = room.countdownEndsAt;
    if (!endsAt) return;
    const delay = Math.max(0, endsAt - this.now());
    const timer = scheduleTimeout(() => {
      this.countdownTimers.delete(room.id);
      try {
        this.advanceReadyCountdown(room.id);
      } catch {
        // Countdown may have been aborted or already consumed.
      }
    }, delay);
    timer.unref?.();
    this.countdownTimers.set(room.id, timer);
  }

  private clearCountdownTimer(roomId: string): void {
    const timer = this.countdownTimers.get(roomId);
    if (!timer) return;
    clearTimeout(timer);
    this.countdownTimers.delete(roomId);
  }

  private requireRoom(roomId: string): CasualRoom {
    const room = this.rooms.get(roomId as CasualRoomId);
    if (!room) throw new Error(`Unknown casual room: ${roomId}`);
    return room;
  }

  private requireRoomByMatchId(matchId: string): CasualRoom {
    const roomId = this.roomsByMatchId.get(matchId as CasualMatchId);
    if (!roomId) throw new Error(`Unknown casual match: ${matchId}`);
    return this.requireRoom(roomId);
  }

  private requireActiveBattle(battleInstanceId: CasualBattleInstanceId): ActiveCasualBattle {
    const battle = this.activeBattles.get(battleInstanceId);
    if (!battle) throw new Error(`Unknown casual battle instance: ${battleInstanceId}`);
    return battle;
  }
}

function cloneRoom(room: CasualRoom): CasualRoom {
  return {
    ...room,
    economics: { ...room.economics },
    ready: { ...room.ready },
    ...(room.result ? { result: { ...room.result, score: [...room.result.score] } } : {}),
    ...(room.rosters ? {
      rosters: room.rosters.map(roster => ({
        playerId: roster.playerId,
        pokemon: roster.pokemon.map(mon => ({ ...mon })),
      })),
    } : {}),
    ...(room.payout ? { payout: { ...room.payout } } : {}),
    ...(room.teamPreview ? {
      teamPreview: room.teamPreview.map(preview => ({
        ...preview,
        pokemon: preview.pokemon.map(mon => ({ ...mon, moves: [...mon.moves], types: [...mon.types] })),
        ...(preview.selectedSlots ? { selectedSlots: [...preview.selectedSlots] } : {}),
      })),
    } : {}),
  };
}

function sameBattleResult(left: BattleResult, right: BattleResult): boolean {
  return left.status === right.status
    && left.winner === right.winner
    && left.turns === right.turns
    && left.endedBy === right.endedBy
    && left.score.length === right.score.length
    && left.score.every((value, index) => value === right.score[index]);
}

function isCasualSelectRoom(room: CasualRoom): boolean {
  return room.ruleset === 'casual' && room.battleSize === '1v1';
}

function isActiveRoomStatus(status: CasualRoomStatus): boolean {
  return status !== 'completed' && status !== 'cancelled';
}

function isCompetitiveRoom(room: CasualRoom): boolean {
  return room.ruleset === 'competitive' && room.battleSize === '1v1';
}

function battleOptionsFor(room: CasualRoom): { size: number; showdownFormatId: string } {
  if (isCompetitiveRoom(room)) {
    return { size: 6, showdownFormatId: 'gen9ou@@@!Team Preview' };
  }
  return { size: CASUAL_TEAM_SIZE, showdownFormatId: CASUAL_SHOWDOWN_FORMAT_ID };
}

function selectionKey(roomId: string, playerId: string): string {
  return `${roomId}:${playerId}`;
}

function fillSelectionSlots(current: readonly number[]): number[] {
  const unique: number[] = [];
  for (const slot of current) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 5 || unique.includes(slot)) continue;
    unique.push(slot);
  }
  for (let slot = 0; unique.length < CASUAL_TEAM_SIZE && slot < 6; slot += 1) {
    if (!unique.includes(slot)) unique.push(slot);
  }
  return unique.slice(0, CASUAL_TEAM_SIZE);
}

function normalizeSlots(slots: readonly number[], confirm: boolean): number[] {
  if (!Array.isArray(slots) || slots.some(slot => !Number.isInteger(slot))) {
    throw new CasualSelectionError('Selected slots must be integers.');
  }
  if (slots.some(slot => slot < 0 || slot > 5)) {
    throw new CasualSelectionError('Selected slots must be between 0 and 5.');
  }
  if (new Set(slots).size !== slots.length) {
    throw new CasualSelectionError('Selected slots must be unique.');
  }
  if (confirm && slots.length !== CASUAL_TEAM_SIZE) {
    throw new CasualSelectionError('Confirm exactly three Pokémon.');
  }
  if (!confirm && slots.length > CASUAL_TEAM_SIZE) {
    throw new CasualSelectionError('Select at most three Pokémon.');
  }
  return [...slots];
}

function sameSlots(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((slot, index) => slot === right[index]);
}

function toEconomicsStore(value: EconomicsStore | MockEconomics | undefined): EconomicsStore {
  if (!value) return new InMemoryEconomicsStore();
  if (value instanceof MockEconomics) return new InMemoryEconomicsStore(value);
  return value;
}
