import type { BattleView, PlayerChoice } from '@pokearena/battle-engine';

import type { CasualRoom } from './casual-service';
import type {
  CasualEconomicsPreview,
  MockPayoutResult,
  TournamentEconomicsPreview,
  WalletSnapshot,
} from './mock-economics';

export type ClientMessage =
  | { type: 'identify'; requestId: string; playerId: string }
  | { type: 'arena.snapshot'; requestId: string }
  | {
      type: 'casual.create';
      requestId: string;
      roomType: 'private' | 'open';
      battleSize: '1v1' | '2v2';
      collateral: number;
      invitedPlayerId?: string;
    }
  | { type: 'casual.list'; requestId: string }
  | { type: 'casual.accept'; requestId: string; roomId: string }
  | { type: 'casual.ready'; requestId: string; roomId: string; ready: boolean }
  | { type: 'casual.start'; requestId: string; roomId: string }
  | { type: 'casual.cancel'; requestId: string; roomId: string }
  | { type: 'casual.subscribe'; requestId: string; roomId: string }
  | { type: 'casual.preview'; requestId: string; collateral: number }
  | { type: 'tournament.create'; requestId: string; title?: string; maxPlayers?: 4 | 8 | 16; entryFee?: number }
  | { type: 'tournament.list'; requestId: string }
  | { type: 'tournament.join'; requestId: string; tournamentId: string }
  | { type: 'tournament.start'; requestId: string; tournamentId: string }
  | { type: 'tournament.subscribe'; requestId: string; tournamentId: string }
  | { type: 'match.subscribe'; requestId: string; matchId: string }
  | {
      type: 'match.choice';
      requestId: string;
      matchId: string;
      battleInstanceId: string;
      requestRevision: number;
      choice: PlayerChoice;
    }
  | { type: 'ping'; requestId: string };

export interface TournamentSummary {
  id: string;
  title: string;
  format: string;
  maxPlayers: number;
  status: string;
  playerCount: number;
  entryFee: number;
  economics: TournamentEconomicsPreview;
  winner?: string;
}

export interface ArenaSnapshot {
  wallet: WalletSnapshot;
  tournaments: TournamentSummary[];
  openCasualRooms: CasualRoom[];
  myCasualRooms: CasualRoom[];
  recentCasualResults: CasualRoom[];
}

export type ServerMessage = { requestId?: string } & (
  | { type: 'ready'; playerId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | { type: 'arena.snapshot'; snapshot: ArenaSnapshot }
  | { type: 'casual.created'; room: CasualRoom }
  | { type: 'casual.list'; rooms: CasualRoom[]; recentResults: CasualRoom[] }
  | { type: 'casual.state'; room: CasualRoom }
  | { type: 'casual.preview'; economics: CasualEconomicsPreview }
  | { type: 'casual.result'; room: CasualRoom; payout?: MockPayoutResult }
  | { type: 'tournament.created'; tournament: unknown }
  | { type: 'tournament.list'; tournaments: TournamentSummary[] }
  | { type: 'tournament.state'; tournament: unknown }
  | { type: 'tournament.result'; tournament: unknown; payout?: MockPayoutResult }
  | {
      type: 'match.update';
      match: unknown;
      state: unknown;
      events: unknown[];
      view?: BattleView;
      source: 'tournament' | 'casual';
    }
  | {
      type: 'match.subscribed';
      match: unknown;
      state: unknown;
      events: unknown[];
      view?: BattleView;
      source: 'tournament' | 'casual';
    }
  | { type: 'match.choice.accepted'; matchId: string }
);

export function parseClientMessage(raw: string): ClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Message must be valid JSON.');
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Message must contain a string type.');
  }
  requireString(value, 'requestId');

  switch (value.type) {
    case 'identify':
      requireString(value, 'playerId');
      return { type: 'identify', requestId: value.requestId as string, playerId: value.playerId as string };
    case 'arena.snapshot':
    case 'casual.list':
    case 'tournament.list':
    case 'ping':
      return { type: value.type, requestId: value.requestId as string };
    case 'casual.create': {
      if (value.roomType !== 'private' && value.roomType !== 'open') {
        throw new Error('roomType must be private or open.');
      }
      if (value.battleSize !== '1v1' && value.battleSize !== '2v2') {
        throw new Error('battleSize must be 1v1 or 2v2.');
      }
      if (!Number.isInteger(value.collateral)) {
        throw new Error('collateral must be an integer.');
      }
      if (value.invitedPlayerId !== undefined) requireString(value, 'invitedPlayerId');
      return {
        type: 'casual.create',
        requestId: value.requestId as string,
        roomType: value.roomType,
        battleSize: value.battleSize,
        collateral: value.collateral as number,
        ...(value.invitedPlayerId !== undefined
          ? { invitedPlayerId: value.invitedPlayerId as string }
          : {}),
      };
    }
    case 'casual.accept':
    case 'casual.cancel':
    case 'casual.subscribe':
    case 'casual.start':
      requireString(value, 'roomId');
      return {
        type: value.type,
        requestId: value.requestId as string,
        roomId: value.roomId as string,
      };
    case 'casual.ready':
      requireString(value, 'roomId');
      if (typeof value.ready !== 'boolean') throw new Error('ready must be a boolean.');
      return {
        type: 'casual.ready',
        requestId: value.requestId as string,
        roomId: value.roomId as string,
        ready: value.ready,
      };
    case 'casual.preview':
      if (!Number.isInteger(value.collateral)) {
        throw new Error('collateral must be an integer.');
      }
      return {
        type: 'casual.preview',
        requestId: value.requestId as string,
        collateral: value.collateral as number,
      };
    case 'tournament.create':
      if (value.title !== undefined) requireString(value, 'title');
      if (
        value.maxPlayers !== undefined &&
        value.maxPlayers !== 4 &&
        value.maxPlayers !== 8 &&
        value.maxPlayers !== 16
      ) {
        throw new Error('maxPlayers must be 4, 8, or 16.');
      }
      if (value.entryFee !== undefined && !Number.isInteger(value.entryFee)) {
        throw new Error('entryFee must be an integer.');
      }
      return {
        type: 'tournament.create',
        requestId: value.requestId as string,
        ...(value.title !== undefined ? { title: value.title as string } : {}),
        ...(value.maxPlayers !== undefined ? { maxPlayers: value.maxPlayers as 4 | 8 | 16 } : {}),
        ...(value.entryFee !== undefined ? { entryFee: value.entryFee as number } : {}),
      };
    case 'tournament.join':
    case 'tournament.start':
    case 'tournament.subscribe':
      requireString(value, 'tournamentId');
      return {
        type: value.type,
        requestId: value.requestId as string,
        tournamentId: value.tournamentId as string,
      };
    case 'match.subscribe':
      requireString(value, 'matchId');
      return { type: value.type, requestId: value.requestId as string, matchId: value.matchId as string };
    case 'match.choice':
      requireString(value, 'matchId');
      requireString(value, 'battleInstanceId');
      if (value.playerId !== undefined) {
        throw new Error('playerId is derived from the connection identity.');
      }
      if (!Number.isInteger(value.requestRevision)) {
        throw new Error('requestRevision must be an integer.');
      }
      return {
        type: value.type,
        requestId: value.requestId as string,
        matchId: value.matchId as string,
        battleInstanceId: value.battleInstanceId as string,
        requestRevision: value.requestRevision as number,
        choice: parseChoice(value.choice),
      };
    default:
      throw new Error(`Unsupported message type: ${value.type}`);
  }
}

function parseChoice(value: unknown): PlayerChoice {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('choice must be a typed object.');
  }
  switch (value.type) {
    case 'team-preview':
    case 'pass':
      return { type: value.type };
    case 'move':
      if (!Number.isInteger(value.slot)) throw new Error('move.slot must be an integer.');
      if (value.target !== undefined && !Number.isInteger(value.target)) {
        throw new Error('move.target must be an integer.');
      }
      if (value.terastallize !== undefined && typeof value.terastallize !== 'boolean') {
        throw new Error('move.terastallize must be boolean.');
      }
      return {
        type: 'move',
        slot: value.slot as number,
        ...(value.target !== undefined ? { target: value.target as number } : {}),
        ...(value.terastallize !== undefined
          ? { terastallize: value.terastallize as boolean }
          : {}),
      };
    case 'switch':
      if (!Number.isInteger(value.slot)) throw new Error('switch.slot must be an integer.');
      return { type: 'switch', slot: value.slot as number };
    default:
      throw new Error(`Unsupported choice type: ${value.type}`);
  }
}

function requireString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== 'string' || !value[key]) {
    throw new Error(`${key} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
