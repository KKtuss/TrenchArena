import type { BattleView, PlayerChoice } from '@pokearena/battle-engine';

import type { CasualRoom } from './casual-service';
import type { CasualPresetMon } from './casual-presets';
import type { FightHistoryCursor, FightHistoryEntry } from './fight-history';
import type { LiveFight } from './live-fights';
import type { PublicTrainerProfile } from './trainer-directory';
import type {
  CasualEconomicsPreview,
  MockPayoutResult,
  ChainPayoutResult,
  TournamentEconomicsPreview,
  WalletSnapshot,
} from './mock-economics';

export type ClientMessage =
  | { type: 'identify'; requestId: string; playerId: string }
  | { type: 'auth.challenge'; requestId: string; address: string }
  | {
      type: 'auth.verify';
      requestId: string;
      address: string;
      signature: string;
      nonce: string;
    }
  | { type: 'arena.snapshot'; requestId: string }
  | { type: 'passport.status'; requestId: string }
  | { type: 'treasury.snapshot'; requestId: string }
  | {
      type: 'tx.confirm';
      requestId: string;
      intentId: string;
      signature: string;
    }
  | {
      type: 'casual.create';
      requestId: string;
      roomType: 'private' | 'open';
      battleSize: '1v1' | '2v2';
      collateral: number;
      /** When set, collateral is interpreted as lamports (SOL rail). */
      collateralLamports?: number;
      invitedPlayerId?: string;
      ruleset?: 'casual' | 'competitive';
      /** `mock` is the default. `real` posts both stakes to the existing SOL escrow. */
      stake?: 'mock' | 'real';
    }
  | { type: 'casual.stake'; requestId: string; roomId: string }
  | { type: 'casual.list'; requestId: string }
  | {
      type: 'history.list';
      requestId: string;
      limit?: number;
      beforeCompletedAt?: number;
      beforeId?: string;
    }
  | { type: 'casual.accept'; requestId: string; roomId: string }
  | { type: 'casual.ready'; requestId: string; roomId: string; ready: boolean; team?: string }
  | {
      type: 'casual.select';
      requestId: string;
      roomId: string;
      slots: number[];
      confirm?: boolean;
    }
  | { type: 'casual.start'; requestId: string; roomId: string; team?: string }
  | { type: 'casual.cancel'; requestId: string; roomId: string }
  | { type: 'casual.forfeit'; requestId: string; roomId: string }
  | { type: 'casual.subscribe'; requestId: string; roomId: string }
  | { type: 'casual.preview'; requestId: string; collateral: number; stake?: 'mock' | 'real' }
  | { type: 'tournament.create'; requestId: string; title?: string; maxPlayers?: 4 | 8 | 16 | 32; entryFee?: number; ruleset?: string }
  | { type: 'tournament.list'; requestId: string }
  | {
      type: 'tournament.join';
      requestId: string;
      tournamentId: string;
      team?: string;
      slots?: number[];
    }
  | { type: 'tournament.payBurnFee'; requestId: string; tournamentId: string; playerPokeAta?: string }
  | {
      type: 'tournament.select';
      requestId: string;
      matchId: string;
      slots: number[];
      confirm?: boolean;
    }
  | { type: 'tournament.updateTeam'; requestId: string; tournamentId: string; team: string }
  | { type: 'tournament.lockTeam'; requestId: string; tournamentId: string }
  | { type: 'tournament.leave'; requestId: string; tournamentId: string }
  | { type: 'tournament.start'; requestId: string; tournamentId: string }
  | { type: 'tournament.cancel'; requestId: string; tournamentId: string }
  | { type: 'tournament.subscribe'; requestId: string; tournamentId: string }
  | { type: 'match.subscribe'; requestId: string; matchId: string }
  | { type: 'live.list'; requestId: string }
  | { type: 'live.watch'; requestId: string; matchId?: string }
  | { type: 'live.unwatch'; requestId: string }
  | {
      type: 'trainer.profile';
      requestId: string;
      username: string;
      spriteId: string;
    }
  | {
      type: 'match.choice';
      requestId: string;
      matchId: string;
      battleInstanceId: string;
      requestRevision: number;
      choice: PlayerChoice;
    }
  | { type: 'ping'; requestId: string }
  | { type: 'team.starter'; requestId: string }
  | { type: 'team.inspect'; requestId: string; team: string; ruleset?: string }
  | {
      type: 'team.search';
      requestId: string;
      kind: 'species' | 'move' | 'item' | 'ability';
      query: string;
      species?: string;
      ruleset?: string;
    };

export interface TournamentSummary {
  id: string;
  title: string;
  format: string;
  ruleset?: string;
  createdAt?: number;
  finalizesAt?: number;
  maxPlayers: number;
  status: string;
  playerCount: number;
  entryFee: number;
  entryAtoms?: number;
  rail?: 'legacy_poke' | 'sol_chain';
  burnFeeAtoms?: number;
  paymentEndsAt?: number;
  prizeLamports?: number;
  economics: TournamentEconomicsPreview;
  winner?: string;
}

export interface TournamentSelectionView {
  round: number;
  presetId: string;
  presetName: string;
  pokemon: CasualPresetMon[];
  selectionEndsAt: number;
  selectedSlots: number[];
  confirmed: boolean;
  rivalConfirmed: boolean;
}

export interface PassportSnapshot {
  eligible: boolean;
  liquidAtoms: string;
  heldEntryAtoms: string;
  qualifyingAtoms: string;
  usdCents: number;
  thresholdUsdCents: number;
  reason: string;
  shortfallAtoms: string;
  atomsForEntryAndPassport: string;
  quote: {
    priceMicroUsd: number;
    decimals: number;
    observedAt: number;
    source: string;
    confidenceBps: number;
    quoteId: string;
  };
}

export interface TxIntentPayload {
  intentId: string;
  serializedTx?: number[];
  kind?: string;
  entryAtoms?: string;
  economics?: unknown;
  passport?: PassportSnapshot;
  quote?: PassportSnapshot['quote'];
  burnKeys?: string[];
  instructionCount?: number;
}

export interface ArenaSnapshot {
  wallet: WalletSnapshot;
  tournaments: TournamentSummary[];
  openCasualRooms: CasualRoom[];
  myCasualRooms: CasualRoom[];
  recentCasualResults: CasualRoom[];
  chainEconomyEnabled?: boolean;
  passport?: PassportSnapshot;
  solBalances?: { freeLamports: string; treasuryLamports: string };
  trainers?: Record<string, PublicTrainerProfile>;
}

export type ServerMessage = { requestId?: string } & (
  | { type: 'ready'; playerId: string }
  | {
      type: 'auth.challenge';
      address: string;
      nonce: string;
      message: string;
      expiresAt: number;
    }
  | { type: 'auth.verified'; playerId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | { type: 'arena.snapshot'; snapshot: ArenaSnapshot }
  | { type: 'passport.status'; passport: PassportSnapshot; chainEconomyEnabled: boolean }
  | {
      type: 'treasury.snapshot';
      deposits: Array<{
        claimKey: string;
        source: string;
        grossLamports: number;
        treasuryLamports: number;
        operatorLamports: number;
        signature?: string;
        createdAt: string;
      }>;
      chainEconomyEnabled: boolean;
    }
  | { type: 'tx.intent'; intent: TxIntentPayload }
  | { type: 'tx.update'; intentId: string; status: string; signature?: string; error?: string }
  | { type: 'casual.created'; room: CasualRoom; intent?: TxIntentPayload }
  | { type: 'casual.list'; rooms: CasualRoom[]; recentResults: CasualRoom[] }
  | { type: 'history.list'; entries: FightHistoryEntry[]; nextCursor?: FightHistoryCursor }
  | { type: 'casual.state'; room: CasualRoom }
  | { type: 'casual.preview'; economics: CasualEconomicsPreview | Record<string, unknown> }
  | { type: 'casual.result'; room: CasualRoom; payout?: MockPayoutResult | ChainPayoutResult }
  | { type: 'tournament.created'; tournament: unknown }
  | { type: 'tournament.list'; tournaments: TournamentSummary[] }
  | { type: 'tournament.state'; tournament: unknown }
  | { type: 'tournament.result'; tournament: unknown; payout?: MockPayoutResult | ChainPayoutResult }
  | {
      type: 'match.update';
      match: unknown;
      state: unknown;
      events: unknown[];
      view?: BattleView;
      source: 'tournament' | 'casual';
      selection?: TournamentSelectionView;
    }
  | {
      type: 'match.subscribed';
      match: unknown;
      state: unknown;
      events: unknown[];
      view?: BattleView;
      source: 'tournament' | 'casual';
      selection?: TournamentSelectionView;
    }
  | { type: 'match.choice.accepted'; matchId: string }
  | { type: 'live.list'; fights: LiveFight[] }
  | { type: 'live.update'; fight?: LiveFight; view?: BattleView; events?: unknown[] }
  | { type: 'trainer.directory'; trainers: Record<string, PublicTrainerProfile> }
  | { type: 'trainer.profile'; playerId: string; profile: PublicTrainerProfile }
  | { type: 'team.starter'; name: string; paste: string }
  | { type: 'team.inspect'; inspection: import('@pokearena/battle-engine').TeamInspection }
  | {
      type: 'team.search';
      results: string[];
      hits?: import('@pokearena/battle-engine').TeamSearchHit[];
      scoped?: boolean;
    }
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
    case 'auth.challenge':
      requireString(value, 'address');
      return {
        type: 'auth.challenge',
        requestId: value.requestId as string,
        address: value.address as string,
      };
    case 'auth.verify':
      requireString(value, 'address');
      requireString(value, 'signature');
      requireString(value, 'nonce');
      return {
        type: 'auth.verify',
        requestId: value.requestId as string,
        address: value.address as string,
        signature: value.signature as string,
        nonce: value.nonce as string,
      };
    case 'arena.snapshot':
    case 'passport.status':
    case 'treasury.snapshot':
    case 'casual.list':
    case 'tournament.list':
    case 'live.list':
    case 'live.unwatch':
    case 'ping':
    case 'team.starter':
      return { type: value.type, requestId: value.requestId as string };
    case 'history.list': {
      const limit = value.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 25)) {
        throw new Error('limit must be an integer from 1 to 25.');
      }
      const beforeCompletedAt = value.beforeCompletedAt;
      if (beforeCompletedAt !== undefined && !Number.isInteger(beforeCompletedAt)) {
        throw new Error('beforeCompletedAt must be an integer.');
      }
      if (value.beforeId !== undefined) requireString(value, 'beforeId');
      return {
        type: 'history.list',
        requestId: value.requestId as string,
        ...(limit !== undefined ? { limit: limit as number } : {}),
        ...(beforeCompletedAt !== undefined ? { beforeCompletedAt: beforeCompletedAt as number } : {}),
        ...(value.beforeId !== undefined ? { beforeId: value.beforeId as string } : {}),
      };
    }
    case 'trainer.profile':
      requireString(value, 'username');
      requireString(value, 'spriteId');
      return {
        type: 'trainer.profile',
        requestId: value.requestId as string,
        username: value.username as string,
        spriteId: value.spriteId as string,
      };
    case 'tx.confirm':
      requireString(value, 'intentId');
      requireString(value, 'signature');
      return {
        type: 'tx.confirm',
        requestId: value.requestId as string,
        intentId: value.intentId as string,
        signature: value.signature as string,
      };
    case 'team.inspect':
      requireString(value, 'team');
      if ((value.team as string).length > 12_000) throw new Error('team paste is too long.');
      return {
        type: 'team.inspect',
        requestId: value.requestId as string,
        team: value.team as string,
        ...optionalRuleset(value),
      };
    case 'team.search': {
      if (value.kind !== 'species' && value.kind !== 'move' && value.kind !== 'item' && value.kind !== 'ability') {
        throw new Error('kind must be species, move, item, or ability.');
      }
      const query = value.query === undefined ? '' : value.query;
      if (typeof query !== 'string' || query.length > 40) throw new Error('query must be a string of at most 40 characters.');
      if (value.species !== undefined) requireString(value, 'species');
      return {
        type: 'team.search',
        requestId: value.requestId as string,
        kind: value.kind,
        query,
        ...(value.species !== undefined ? { species: value.species as string } : {}),
        ...optionalRuleset(value),
      };
    }
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
      if (value.collateralLamports !== undefined && !Number.isInteger(value.collateralLamports)) {
        throw new Error('collateralLamports must be an integer.');
      }
      if (value.invitedPlayerId !== undefined) requireString(value, 'invitedPlayerId');
      if (value.ruleset !== undefined && value.ruleset !== 'casual' && value.ruleset !== 'competitive') {
        throw new Error('ruleset must be casual or competitive.');
      }
      if (value.stake !== undefined && value.stake !== 'mock' && value.stake !== 'real') {
        throw new Error('stake must be mock or real.');
      }
      return {
        type: 'casual.create',
        requestId: value.requestId as string,
        roomType: value.roomType,
        battleSize: value.battleSize,
        collateral: value.collateral as number,
        ...(value.collateralLamports !== undefined
          ? { collateralLamports: value.collateralLamports as number }
          : {}),
        ...(value.invitedPlayerId !== undefined
          ? { invitedPlayerId: value.invitedPlayerId as string }
          : {}),
        ...(value.ruleset !== undefined ? { ruleset: value.ruleset } : {}),
        ...(value.stake !== undefined ? { stake: value.stake } : {}),
      };
    }
    case 'casual.accept':
    case 'casual.cancel':
    case 'casual.forfeit':
    case 'casual.subscribe':
    case 'casual.stake':
      requireString(value, 'roomId');
      return {
        type: value.type,
        requestId: value.requestId as string,
        roomId: value.roomId as string,
      };
    case 'casual.select': {
      requireString(value, 'roomId');
      if (!Array.isArray(value.slots) || value.slots.some(slot => !Number.isInteger(slot))) {
        throw new Error('slots must be an array of integers.');
      }
      if (value.confirm !== undefined && typeof value.confirm !== 'boolean') {
        throw new Error('confirm must be a boolean.');
      }
      return {
        type: 'casual.select',
        requestId: value.requestId as string,
        roomId: value.roomId as string,
        slots: value.slots as number[],
        ...(value.confirm !== undefined ? { confirm: value.confirm as boolean } : {}),
      };
    }
    case 'casual.start':
      requireString(value, 'roomId');
      return {
        type: 'casual.start',
        requestId: value.requestId as string,
        roomId: value.roomId as string,
        ...optionalTeam(value),
      };
    case 'casual.ready':
      requireString(value, 'roomId');
      if (typeof value.ready !== 'boolean') throw new Error('ready must be a boolean.');
      return {
        type: 'casual.ready',
        requestId: value.requestId as string,
        roomId: value.roomId as string,
        ready: value.ready,
        ...optionalTeam(value),
      };
    case 'casual.preview':
      if (!Number.isInteger(value.collateral)) {
        throw new Error('collateral must be an integer.');
      }
      if (value.stake !== undefined && value.stake !== 'mock' && value.stake !== 'real') {
        throw new Error('stake must be mock or real.');
      }
      return {
        type: 'casual.preview',
        requestId: value.requestId as string,
        collateral: value.collateral as number,
        ...(value.stake !== undefined ? { stake: value.stake } : {}),
      };
    case 'tournament.create':
      if (value.title !== undefined) requireString(value, 'title');
      if (
        value.maxPlayers !== undefined &&
        value.maxPlayers !== 4 &&
        value.maxPlayers !== 8 &&
        value.maxPlayers !== 16 &&
        value.maxPlayers !== 32
      ) {
        throw new Error('maxPlayers must be 4, 8, 16, or 32.');
      }
      if (value.entryFee !== undefined && !Number.isInteger(value.entryFee)) {
        throw new Error('entryFee must be an integer.');
      }
      return {
        type: 'tournament.create',
        requestId: value.requestId as string,
        ...(value.title !== undefined ? { title: value.title as string } : {}),
        ...(value.maxPlayers !== undefined ? { maxPlayers: value.maxPlayers as 4 | 8 | 16 | 32 } : {}),
        ...(value.entryFee !== undefined ? { entryFee: value.entryFee as number } : {}),
        ...optionalRuleset(value),
      };
    case 'tournament.start':
    case 'tournament.cancel':
    case 'tournament.subscribe':
      requireString(value, 'tournamentId');
      return {
        type: value.type,
        requestId: value.requestId as string,
        tournamentId: value.tournamentId as string,
      };
    case 'tournament.join':
      requireString(value, 'tournamentId');
      return {
        type: 'tournament.join',
        requestId: value.requestId as string,
        tournamentId: value.tournamentId as string,
        ...optionalTeam(value),
        ...optionalSlots(value),
      };
    case 'tournament.payBurnFee':
      requireString(value, 'tournamentId');
      if (value.playerPokeAta !== undefined) requireString(value, 'playerPokeAta');
      return {
        type: 'tournament.payBurnFee',
        requestId: value.requestId as string,
        tournamentId: value.tournamentId as string,
        ...(value.playerPokeAta !== undefined ? { playerPokeAta: value.playerPokeAta as string } : {}),
      };
    case 'tournament.select': {
      requireString(value, 'matchId');
      if (!Array.isArray(value.slots) || value.slots.some(slot => !Number.isInteger(slot))) {
        throw new Error('slots must be an array of integers.');
      }
      if (value.confirm !== undefined && typeof value.confirm !== 'boolean') {
        throw new Error('confirm must be a boolean.');
      }
      return {
        type: 'tournament.select',
        requestId: value.requestId as string,
        matchId: value.matchId as string,
        slots: value.slots as number[],
        ...(value.confirm !== undefined ? { confirm: value.confirm as boolean } : {}),
      };
    }
    case 'tournament.updateTeam':
      requireString(value, 'tournamentId');
      requireString(value, 'team');
      return {
        type: 'tournament.updateTeam',
        requestId: value.requestId as string,
        tournamentId: value.tournamentId as string,
        team: value.team as string,
      };
    case 'tournament.lockTeam':
    case 'tournament.leave':
      requireString(value, 'tournamentId');
      return {
        type: value.type,
        requestId: value.requestId as string,
        tournamentId: value.tournamentId as string,
      };
    case 'match.subscribe':
      requireString(value, 'matchId');
      return { type: value.type, requestId: value.requestId as string, matchId: value.matchId as string };
    case 'live.watch':
      if (value.matchId !== undefined) requireString(value, 'matchId');
      return {
        type: 'live.watch',
        requestId: value.requestId as string,
        ...(value.matchId !== undefined ? { matchId: value.matchId as string } : {}),
      };
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

function optionalRuleset(value: Record<string, unknown>): { ruleset?: string } {
  if (value.ruleset === undefined) return {};
  if (typeof value.ruleset !== 'string' || !value.ruleset.trim() || value.ruleset.length > 40) {
    throw new Error('ruleset must be a short string.');
  }
  return { ruleset: value.ruleset };
}

function optionalSlots(value: Record<string, unknown>): { slots?: number[] } {
  if (value.slots === undefined) return {};
  if (!Array.isArray(value.slots) || value.slots.length > 6 || value.slots.some(slot => !Number.isInteger(slot))) {
    throw new Error('slots must be a short list of integers.');
  }
  return { slots: value.slots as number[] };
}

function optionalTeam(value: Record<string, unknown>): { team?: string } {
  if (value.team === undefined) return {};
  if (typeof value.team !== 'string' || !value.team.trim()) {
    throw new Error('team must be a non-empty string.');
  }
  if (value.team.length > 12_000) throw new Error('team paste is too long.');
  return { team: value.team };
}

function requireString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== 'string' || !value[key]) {
    throw new Error(`${key} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
