import { randomUUID } from 'node:crypto';

import {
  BattleEngine,
  validateAndPackTeam,
  type BattleEvent,
  type BattleResult,
  type BattleSession,
  type BattleState,
  type BattleTerminal,
  type BattleView,
  type PlayerChoice,
} from '@pokearena/battle-engine';

import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from './demo-teams';
import {
  MockEconomics,
  type CasualEconomicsPreview,
  type MockPayoutResult,
} from './mock-economics';

export interface CasualRosterMon {
  species: string;
  fainted: boolean;
}

export interface CasualRoster {
  playerId: string;
  pokemon: CasualRosterMon[];
}

export type CasualRoomId = string & { readonly __brand: 'CasualRoomId' };
export type CasualMatchId = string & { readonly __brand: 'CasualMatchId' };
export type CasualBattleInstanceId = string & { readonly __brand: 'CasualBattleInstanceId' };

export type CasualRoomType = 'private' | 'open';
export type CasualBattleSize = '1v1' | '2v2';
export type CasualRoomStatus =
  | 'open'
  | 'full'
  | 'ready'
  | 'battling'
  | 'completed'
  | 'cancelled';

export interface CasualRoom {
  id: CasualRoomId;
  matchId: CasualMatchId;
  roomType: CasualRoomType;
  battleSize: CasualBattleSize;
  format: 'gen9ou';
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
  payout?: MockPayoutResult;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CreateCasualRoomInput {
  creatorId: string;
  roomType: CasualRoomType;
  battleSize: CasualBattleSize;
  collateral: number;
  invitedPlayerId?: string;
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
  private readonly lockedTeams = new Map<string, string>();
  private readonly listeners = new Map<CasualRoomId, Set<CasualRoomListener>>();
  private readonly recentResults: CasualRoom[] = [];
  private readonly battleEngine: BattleEngine;
  private readonly economics: MockEconomics;
  private readonly now: () => number;

  constructor(options: {
    battleEngine?: BattleEngine;
    economics?: MockEconomics;
    now?: () => number;
  } = {}) {
    this.battleEngine = options.battleEngine ?? new BattleEngine();
    this.economics = options.economics ?? new MockEconomics();
    this.now = options.now ?? Date.now;
  }

  createRoom(input: CreateCasualRoomInput): CasualRoom {
    if (input.battleSize !== '1v1' && input.battleSize !== '2v2') {
      throw new Error('battleSize must be 1v1 or 2v2.');
    }
    if (input.roomType !== 'private' && input.roomType !== 'open') {
      throw new Error('roomType must be private or open.');
    }
    if (input.roomType === 'private' && !input.invitedPlayerId) {
      throw new Error('Private challenges require an invited player.');
    }
    if (input.invitedPlayerId && input.invitedPlayerId === input.creatorId) {
      throw new Error('Cannot challenge yourself.');
    }
    this.economics.assertAffordable(input.creatorId, input.collateral);
    const economics = this.economics.previewCasual(input.collateral);
    const timestamp = this.now();
    const id = randomUUID() as CasualRoomId;
    const matchId = `casual-${id}` as CasualMatchId;
    const room: CasualRoom = {
      id,
      matchId,
      roomType: input.roomType,
      battleSize: input.battleSize,
      format: 'gen9ou',
      creatorId: input.creatorId,
      ...(input.invitedPlayerId ? { invitedPlayerId: input.invitedPlayerId } : {}),
      collateral: input.collateral,
      economics,
      status: 'open',
      ready: { [input.creatorId]: false },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.rooms.set(id, room);
    this.roomsByMatchId.set(matchId, id);
    return cloneRoom(room);
  }

  listOpenRooms(): CasualRoom[] {
    return [...this.rooms.values()]
      .filter(room => room.roomType === 'open' && (room.status === 'open' || room.status === 'full'))
      .map(cloneRoom)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listRoomsForPlayer(playerId: string): CasualRoom[] {
    return [...this.rooms.values()]
      .filter(room => (
        room.creatorId === playerId
        || room.opponentId === playerId
        || room.invitedPlayerId === playerId
      ))
      .map(cloneRoom)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listRecentResults(limit = 10): CasualRoom[] {
    return this.recentResults.slice(0, limit).map(cloneRoom);
  }

  getRoom(roomId: string): CasualRoom {
    const room = this.rooms.get(roomId as CasualRoomId);
    if (!room) throw new Error(`Unknown casual room: ${roomId}`);
    return cloneRoom(room);
  }

  getRoomByMatchId(matchId: string): CasualRoom | undefined {
    const roomId = this.roomsByMatchId.get(matchId as CasualMatchId);
    if (!roomId) return undefined;
    const room = this.rooms.get(roomId);
    return room ? cloneRoom(room) : undefined;
  }

  acceptRoom(roomId: string, playerId: string): CasualRoom {
    const room = this.requireRoom(roomId);
    if (room.status !== 'open') throw new Error('This casual room is no longer open.');
    if (room.opponentId) throw new Error('This casual room is already full.');
    if (playerId === room.creatorId) throw new Error('Creator already occupies this room.');
    if (room.roomType === 'private' && room.invitedPlayerId && room.invitedPlayerId !== playerId) {
      throw new Error('You were not invited to this private challenge.');
    }
    this.economics.assertAffordable(playerId, room.collateral);
    room.opponentId = playerId;
    room.ready[playerId] = false;
    room.status = 'full';
    room.updatedAt = this.now();
    this.notify(room);
    return cloneRoom(room);
  }

  setReady(roomId: string, playerId: string, ready: boolean, team?: string): CasualRoom {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (room.status !== 'full' && room.status !== 'ready') {
      throw new Error('Room is not ready for readiness changes.');
    }
    if (ready && team) this.lockTeam(room.id, playerId, team);
    room.ready[playerId] = ready;
    const opponentId = room.opponentId;
    const bothReady = Boolean(opponentId)
      && room.ready[room.creatorId]
      && Boolean(opponentId && room.ready[opponentId]);
    room.status = bothReady ? 'ready' : 'full';
    room.updatedAt = this.now();
    this.notify(room);
    return cloneRoom(room);
  }

  cancelRoom(roomId: string, playerId: string): CasualRoom {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (room.status === 'battling' || room.status === 'completed') {
      throw new Error('Cannot cancel a room after battle start.');
    }
    room.status = 'cancelled';
    room.updatedAt = this.now();
    this.notify(room);
    return cloneRoom(room);
  }

  async forfeit(roomId: string, playerId: string): Promise<CasualRoom> {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (room.status === 'completed') return cloneRoom(room);
    if (room.status !== 'battling' || !room.battleInstanceId) {
      throw new Error('This fight is not live.');
    }
    const battle = this.requireActiveBattle(room.battleInstanceId);
    await battle.session.forfeit(playerId);
    for (let attempt = 0; attempt < 10 && this.requireRoom(roomId).status === 'battling'; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const settled = this.requireRoom(roomId);
    if (settled.status !== 'completed') {
      throw new Error('Forfeit did not end the fight.');
    }
    return cloneRoom(settled);
  }

  async startBattle(roomId: string, playerId: string, team?: string): Promise<CasualRoom> {
    const room = this.requireRoom(roomId);
    if (playerId !== room.creatorId && playerId !== room.opponentId) {
      throw new Error('You are not a player in this casual room.');
    }
    if (!room.opponentId) throw new Error('Waiting for an opponent before battle start.');
    if (room.battleSize === '2v2') {
      throw new Error('2v2 battles are not supported yet. Configure the room, but start is unavailable.');
    }
    if (room.status === 'battling' && room.battleInstanceId) return cloneRoom(room);
    if (room.status !== 'ready' && room.status !== 'full') {
      throw new Error('Casual room is not ready to start.');
    }
    if (team) this.lockTeam(room.id, playerId, team);
    const teams = [
      this.teamFor(room.id, room.creatorId),
      this.teamFor(room.id, room.opponentId),
    ] as const;
    validateAndPackTeam(teams[0], 'gen9ou');
    validateAndPackTeam(teams[1], 'gen9ou');

    this.economics.lockCollateral(room.creatorId, room.collateral);
    this.economics.lockCollateral(room.opponentId, room.collateral);

    const session = await this.battleEngine.createBattle({
      format: 'gen9ou',
      players: [
        { id: room.creatorId, name: room.creatorId },
        { id: room.opponentId, name: room.opponentId },
      ],
      teams,
      timeoutMs: 300_000,
    });
    await session.start();

    const battleInstanceId = session.id as CasualBattleInstanceId;
    const unsubscribe = session.subscribe(terminal => {
      this.handleTerminal(room.id, terminal);
    });
    session.subscribeEvents(() => {
      queueMicrotask(() => this.notify(this.requireRoom(room.id)));
    });

    this.activeBattles.set(battleInstanceId, { battleInstanceId, session, unsubscribe });
    room.battleInstanceId = battleInstanceId;
    room.status = 'battling';
    room.updatedAt = this.now();
    this.notify(room);
    return cloneRoom(room);
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

  private handleTerminal(roomId: CasualRoomId, terminal: BattleTerminal): void {
    const room = this.rooms.get(roomId);
    if (!room || room.status === 'completed') return;

    if (terminal.type === 'failed') {
      room.status = 'cancelled';
      room.updatedAt = this.now();
      if (room.opponentId) {
        this.economics.credit(room.creatorId, room.collateral);
        this.economics.credit(room.opponentId, room.collateral);
      }
      this.notify(room);
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

    if (terminal.result.status === 'win' && terminal.result.winner && room.opponentId) {
      room.winnerId = terminal.result.winner;
      room.payout = this.economics.settleCasualWin({
        winnerId: terminal.result.winner,
        loserId: terminal.result.winner === room.creatorId ? room.opponentId : room.creatorId,
        collateral: room.collateral,
      });
    } else if (room.opponentId) {
      room.payout = this.economics.settleCasualTie({
        player1Id: room.creatorId,
        player2Id: room.opponentId,
        collateral: room.collateral,
      });
    }

    this.recentResults.unshift(cloneRoom(room));
    if (this.recentResults.length > 25) this.recentResults.pop();
    this.notify(room);
  }

  private notify(room: CasualRoom): void {
    const listeners = this.listeners.get(room.id);
    if (!listeners) return;
    const snapshot = cloneRoom(room);
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

  private lockTeam(roomId: string, playerId: string, team: string): void {
    validateAndPackTeam(team, 'gen9ou');
    this.lockedTeams.set(`${roomId}:${playerId}`, team);
  }

  private teamFor(roomId: string, playerId: string): string {
    return this.lockedTeams.get(`${roomId}:${playerId}`)
      ?? (playerId === 'demo-player-1' ? DEMO_TEAM_ONE : DEMO_TEAM_TWO);
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
  };
}
