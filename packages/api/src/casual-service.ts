import { randomUUID } from 'node:crypto';

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

import { previewCasual } from '@pokearena/db';
import type { EconomicsStore, PayoutResult } from '@pokearena/db';

import {
  getCasualPreset,
  pickCreatorPresetId,
  pickOpponentPresetId,
  type CasualPresetMon,
} from './casual-presets';
import { InMemoryEconomicsStore } from './memory-economics-store';
import {
  MockEconomics,
  type CasualEconomicsPreview,
  type ChainPayoutResult,
} from './mock-economics';

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
  teamPreview?: CasualTeamPreview[];
  countdownEndsAt?: number;
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
  private readonly countdownTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  };

  constructor(options: {
    battleEngine?: BattleEngine;
    economics?: EconomicsStore | MockEconomics;
    now?: () => number;
    countdownMs?: number;
    allowDemoAuth?: boolean;
    matchTimeoutMs?: number;
    chainSettlement?: CasualRoomService['chainSettlement'];
  } = {}) {
    this.battleEngine = options.battleEngine ?? new BattleEngine();
    this.economics = toEconomicsStore(options.economics);
    this.now = options.now ?? Date.now;
    this.countdownMs = options.countdownMs ?? 0;
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
    const rail = input.rail ?? 'legacy_poke';
    const economics = rail === 'sol_chain'
      ? {
          symbol: 'POKE' as const,
          collateral: input.collateral,
          totalPot: input.collateral * 2,
          protocolFee: Math.floor((input.collateral * 2 * 200) / 10_000),
          feeRateBps: 200,
          winnerPayout: input.collateral * 2 - Math.floor((input.collateral * 2 * 200) / 10_000),
        }
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
      status: rail === 'sol_chain' ? 'pending_deposit' : 'open',
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
      .filter(room => room.roomType === 'open' && (room.status === 'open' || room.status === 'full'))
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

  getRoom(roomId: string, viewerId?: string): CasualRoom {
    return this.serializeRoom(this.requireRoom(roomId), viewerId);
  }

  getRoomByMatchId(matchId: string, viewerId?: string): CasualRoom | undefined {
    const roomId = this.roomsByMatchId.get(matchId as CasualMatchId);
    if (!roomId) return undefined;
    const room = this.rooms.get(roomId);
    return room ? this.serializeRoom(room, viewerId) : undefined;
  }

  async acceptRoom(roomId: string, playerId: string): Promise<CasualRoom> {
    const room = this.requireRoom(roomId);
    const joinable = room.status === 'open'
      || (room.rail === 'sol_chain' && room.status === 'pending_deposit');
    if (!joinable) throw new Error('This casual room is no longer open.');
    if (room.opponentId) throw new Error('This casual room is already full.');
    if (playerId === room.creatorId) throw new Error('Creator already occupies this room.');
    if (room.roomType === 'private' && room.invitedPlayerId && room.invitedPlayerId !== playerId) {
      throw new Error('You were not invited to this private challenge.');
    }
    if (room.rail !== 'sol_chain') {
      await this.economics.acceptCasualRoomWithHold({
        roomId: room.id,
        opponentId: playerId,
        collateral: room.collateral,
      });
    } else {
      await this.economics.setCasualRoomStatus(room.id, 'full');
    }
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
      throw new CasualSelectionError('Waiting for the ready countdown before team selection.');
    }
    if (!this.assignedPresets.has(selectionKey(room.id, playerId))) {
      throw new CasualSelectionError('No Casual preset is assigned to this player.');
    }

    const normalized = normalizeSlots(slots, confirm);
    const key = selectionKey(room.id, playerId);
    const current = this.selections.get(key);

    if (current?.confirmed && confirm && sameSlots(current.slots, normalized)) {
      room.ready[playerId] = true;
      this.syncReadyStatus(room);
      room.updatedAt = this.now();
      this.notify(room);
      return this.serializeRoom(room, playerId);
    }
    if (current?.confirmed && confirm && !sameSlots(current.slots, normalized)) {
      throw new CasualSelectionError('Unconfirm before changing a locked selection.');
    }

    this.selections.set(key, {
      slots: normalized,
      confirmed: confirm,
    });
    room.ready[playerId] = confirm;
    this.syncReadyStatus(room);
    room.updatedAt = this.now();
    this.notify(room);
    return this.serializeRoom(room, playerId);
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
    delete room.countdownEndsAt;
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
    this.clearCountdownTimer(room.id);
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
    const unsubscribe = session.subscribe(terminal => {
      this.enqueueTerminal(room.id, terminal);
    });
    session.subscribeEvents(() => {
      queueMicrotask(() => this.notify(this.requireRoom(room.id)));
    });
    this.activeBattles.set(battleInstanceId, { battleInstanceId, session, unsubscribe });
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
    void next.catch(() => undefined);
    return next;
  }

  private async flushTerminal(roomId: CasualRoomId): Promise<void> {
    const job = this.terminalJobs.get(roomId);
    if (job) await job;
  }

  private async handleTerminal(roomId: CasualRoomId, terminal: BattleTerminal): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || room.status === 'completed' || room.status === 'cancelled') return;

    if (terminal.type === 'failed') {
      await this.abortRoom(room);
      return;
    }

    let chainPayout: ChainPayoutResult | undefined;
    if (room.rail === 'sol_chain' && !this.chainSettlement) {
      throw new Error('Chain settlement is not configured for a SOL room.');
    }
    if (room.rail === 'sol_chain' && room.opponentId && this.chainSettlement) {
      chainPayout = await this.chainSettlement.settle({
        roomId: room.id,
        creatorId: room.creatorId,
        opponentId: room.opponentId,
        ...(terminal.result.status === 'win' && terminal.result.winner
          ? { winnerId: terminal.result.winner }
          : {}),
      });
    }

    if (terminal.result.status === 'win' && terminal.result.winner && room.opponentId) {
      room.winnerId = terminal.result.winner;
      room.payout = chainPayout ?? await this.economics.completeCasualWin({
          roomId: room.id,
          winnerId: terminal.result.winner,
          loserId: terminal.result.winner === room.creatorId ? room.opponentId : room.creatorId,
          collateral: room.collateral,
          reason: this.forfeitedRooms.has(room.id) || terminal.result.endedBy === 'timeout'
            ? 'casual-forfeit'
            : 'casual-win',
        });
    } else if (room.opponentId) {
      delete room.winnerId;
      room.payout = chainPayout ?? await this.economics.completeCasualTie({
          roomId: room.id,
          player1Id: room.creatorId,
          player2Id: room.opponentId,
          collateral: room.collateral,
        });
    } else {
      await this.abortRoom(room);
      return;
    }
    room.result = terminal.result;
    room.completedAt = this.now();
    room.updatedAt = room.completedAt;
    room.status = 'completed';
    if (room.battleInstanceId) {
      const battle = this.activeBattles.get(room.battleInstanceId);
      if (battle) {
        room.rosters = battle.session.getView('spectator').sides.map(side => ({
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

  private async abortRoom(room: CasualRoom): Promise<void> {
    if (room.status === 'completed' || room.status === 'cancelled') return;
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
  }

  private assignCasualPresets(room: CasualRoom): void {
    if (!room.opponentId) return;
    const creatorKey = selectionKey(room.id, room.creatorId);
    const opponentKey = selectionKey(room.id, room.opponentId);
    const creatorPreset = this.assignedPresets.get(creatorKey) ?? pickCreatorPresetId();
    this.assignedPresets.set(creatorKey, creatorPreset);
    if (!this.assignedPresets.has(opponentKey)) {
      this.assignedPresets.set(opponentKey, pickOpponentPresetId(creatorPreset));
    }
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
    const bothConfirmed = playerIds.length === 2
      && playerIds.every(playerId => this.selections.get(selectionKey(room.id, playerId))?.confirmed);
    const revealed = bothConfirmed
      || room.status === 'starting'
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

  private syncReadyStatus(room: CasualRoom): void {
    const opponentId = room.opponentId;
    const bothReady = Boolean(opponentId)
      && room.ready[room.creatorId]
      && Boolean(opponentId && room.ready[opponentId]);
    if (room.status === 'full' || room.status === 'ready') {
      room.status = bothReady ? 'ready' : 'full';
    }
    if (bothReady && room.battleSize === '1v1' && (room.status === 'ready' || room.status === 'drafting')) {
      if (isCasualSelectRoom(room) && room.status === 'ready') {
        if (this.countdownMs <= 0) {
          delete room.countdownEndsAt;
          this.clearCountdownTimer(room.id);
          this.dealCasualDraft(room);
        } else {
          room.countdownEndsAt ??= this.now() + this.countdownMs;
          this.armCountdown(room);
        }
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
    const timer = setTimeout(() => {
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

function isCasualSelectRoom(room: CasualRoom): boolean {
  return room.ruleset === 'casual' && room.battleSize === '1v1';
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
