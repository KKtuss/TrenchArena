import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';

import { inspectTeam, searchTeamHits, validateAndPackTeam } from '@pokearena/battle-engine';
import {
  type BattleInstanceId,
} from '@pokearena/tournament';
import {
  createTournamentPlayerId,
  InMemoryAsyncTournamentRepository,
  TournamentService,
  type AsyncTournamentRepository,
  type TournamentId,
  type TournamentMatchId,
  type TournamentPlayerId,
} from '@pokearena/tournament';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';

import {
  previewCasual,
  previewTournament,
  recoverDurableState,
  RecoveryFailedError,
  type EconomicsStore,
  type PayoutResult,
  type Pool,
  type PostgresChainStore,
} from '@pokearena/db';

import { CASUAL_START_COUNTDOWN_MS, CasualRoomService } from './casual-service';
import { pickLiveFight, spectatorBattleView, spectatorEvents, type LiveFight } from './live-fights';
import { ChainEconomyService } from './chain-economy';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from './demo-teams';
import {
  connectPostgresEconomics,
  EconomicsUnavailableError,
  isPostgresEconomicsRequired,
  resolveEconomicsBackend,
} from './economics-runtime';
import { InMemoryEconomicsStore } from './memory-economics-store';
import {
  DEFAULT_TOURNAMENT_ENTRY_POKE,
  MockEconomics,
  type ChainPayoutResult,
} from './mock-economics';
import {
  authorizeOrigin,
  clientIp,
  rejectUpgrade,
  resolveNetworkPolicy,
  type NetworkPolicy,
  type OriginMode,
} from './network-policy';
import {
  parseClientMessage,
  type ArenaSnapshot,
  type ClientMessage,
  type ServerMessage,
  type TournamentSummary,
} from './protocol';
import { logInternalError, toPublicError } from './public-errors';
import {
  ProtocolRateLimiter,
  resolveRateLimitConfig,
  type RateLimitConfig,
} from './rate-limit';
import { publicTournamentForViewer } from './tournament-view';
import { TrainerDirectory } from './trainer-directory';
import {
  assertTournamentBackendMatchesEconomics,
  PostgresTournamentRepository,
} from './postgres-tournament-repository';
import {
  createAuthChallenge,
  DemoAuthDisabledError,
  isDemoAuthEnabled,
  isDemoPlayerId,
  isSolanaAddress,
  type AuthChallenge,
  verifySolanaSignature,
} from './wallet-auth';

export interface ApiServerOptions {
  /** Defaults to POKEARENA_ALLOW_DEMO_AUTH, which is off unless set true. */
  allowDemoAuth?: boolean;
  /** Time a disconnected player has to re-authenticate before a live fight is forfeited. */
  disconnectGraceMs?: number;
  bindHost?: string;
  originMode?: OriginMode;
  allowedOrigins?: string[];
  allowMissingOrigin?: boolean;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  maxPayloadBytes?: number;
  trustProxy?: boolean;
  authOrigin?: string;
  challengeTtlMs?: number;
  challengeCleanupMs?: number;
  rateLimits?: Partial<RateLimitConfig>;
  countdownMs?: number;
  economics?: EconomicsStore;
  casual?: CasualRoomService;
  tournaments?: TournamentService;
  tournamentRepository?: AsyncTournamentRepository;
  chainStore?: PostgresChainStore | null;
  chainEconomy?: ChainEconomyService;
}

export class TeamRequiredError extends Error {
  constructor() {
    super('A valid team is required.');
    this.name = 'TeamRequiredError';
  }
}

export class TournamentHostRequiredError extends Error {
  constructor() {
    super('Only the tournament host can start this tournament.');
    this.name = 'TournamentHostRequiredError';
  }
}

export class AlreadyAuthenticatedError extends Error {
  constructor() {
    super('This connection is already authenticated.');
    this.name = 'AlreadyAuthenticatedError';
  }
}

export class SessionReplacedError extends Error {
  constructor() {
    super('This wallet authenticated from another connection.');
    this.name = 'SessionReplacedError';
  }
}

interface StoredChallenge extends AuthChallenge {
  connection: ClientConnection;
}

interface ClientConnection {
  socket: WebSocket;
  playerId?: TournamentPlayerId;
  tournamentIds: Set<TournamentId>;
  matchIds: Set<string>;
  casualRoomIds: Set<string>;
  watchedMatchId?: string;
  closed: boolean;
  replaced: boolean;
  ip: string;
  origin: string | null;
}

const publicDirectory = join(__dirname, '../../public');
const DEFAULT_DISCONNECT_GRACE_MS = 10_000;

export class ApiServer {
  readonly tournaments: TournamentService;
  readonly economics: EconomicsStore;
  readonly casual: CasualRoomService;
  readonly chainEconomy: ChainEconomyService;
  readonly bindHost: string;
  /** Presentation cache of champion payouts. Settlement rows are authoritative. */
  private readonly tournamentPayouts = new Map<TournamentId, PayoutResult | ChainPayoutResult>();
  private readonly settlementJobs = new Map<TournamentId, Promise<void>>();
  private readonly httpServer: Server;
  private readonly webSockets: WebSocketServer;
  private readonly connections = new Map<WebSocket, ClientConnection>();
  private readonly connectionsByIp = new Map<string, number>();
  private readonly upgradeSockets = new Set<Duplex>();
  private readonly matchUnsubscribers = new Map<string, () => void>();
  private readonly casualUnsubscribers = new Map<string, () => void>();
  private readonly pendingMatchBroadcasts = new Set<string>();
  private readonly pendingChallenges = new Map<string, StoredChallenge>();
  private readonly challengeByConnection = new Map<ClientConnection, string>();
  private readonly consumedNonces = new Map<string, number>();
  private readonly sessionsByPlayer = new Map<string, ClientConnection>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly trainers = new TrainerDirectory();
  private readonly allowDemoAuth: boolean;
  private readonly disconnectGraceMs: number;
  private readonly network: NetworkPolicy;
  private readonly rateLimiter: ProtocolRateLimiter;
  private readonly challengeCleanupTimer: NodeJS.Timeout;
  private shuttingDown = false;
  private economicsPool: Pool | undefined;

  constructor(
    tournamentsOrOptions?: TournamentService | ApiServerOptions,
    economics?: EconomicsStore | MockEconomics,
    casual?: CasualRoomService,
  ) {
    let options: ApiServerOptions = {};
    let injectedTournaments: TournamentService | undefined;
    if (isApiServerOptions(tournamentsOrOptions)) {
      options = tournamentsOrOptions;
      this.allowDemoAuth = options.allowDemoAuth ?? isDemoAuthEnabled();
      this.disconnectGraceMs = options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
      injectedTournaments = options.tournaments;
      economics = options.economics ?? economics;
      casual = options.casual ?? casual;
    } else {
      this.allowDemoAuth = isDemoAuthEnabled();
      this.disconnectGraceMs = DEFAULT_DISCONNECT_GRACE_MS;
      injectedTournaments = tournamentsOrOptions;
    }
    this.network = resolveNetworkPolicy(options);
    this.bindHost = this.network.bindHost;
    this.rateLimiter = new ProtocolRateLimiter(resolveRateLimitConfig(options.rateLimits));
    if (this.network.originMode === 'strict' && this.network.allowedOrigins.length === 0) {
      throw new Error('POKEARENA_ALLOWED_ORIGINS is required when origin validation is strict.');
    }
    if (!economics && isPostgresEconomicsRequired()) {
      throw new Error(
        'PostgreSQL economics is required. Use createApiServer(). In-memory economics is not used as a fallback.',
      );
    }
    this.economics = toServerEconomics(economics, this.allowDemoAuth);
    const repository = options.tournamentRepository
      ?? new InMemoryAsyncTournamentRepository(undefined, this.economics);
    if (!injectedTournaments) {
      assertTournamentBackendMatchesEconomics(this.economics, repository);
    }
    this.tournaments = injectedTournaments ?? new TournamentService({ repository });
    this.chainEconomy = options.chainEconomy
      ?? new ChainEconomyService({ chainStore: options.chainStore ?? null });
    this.casual = casual ?? new CasualRoomService({
      economics: this.economics,
      allowDemoAuth: this.allowDemoAuth,
      countdownMs: options.countdownMs ?? CASUAL_START_COUNTDOWN_MS,
      ...(this.chainEconomy.enabled
        ? {
            chainSettlement: {
              settle: input => this.chainEconomy.settleCasual(input),
              refund: (roomId, creatorId, opponentId) => (
                this.chainEconomy.refundCasual(roomId, creatorId, opponentId)
              ),
            },
          }
        : {}),
    });
    this.httpServer = createServer((request, response) => this.handleHttp(request, response));
    this.webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: this.network.maxPayloadBytes,
    });
    this.httpServer.on('upgrade', (request, socket, head) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const decision = this.authorizeUpgrade(request);
      if (!decision.ok) {
        console.warn('ws upgrade rejected', decision.reason);
        rejectUpgrade(socket, decision.status);
        return;
      }
      this.upgradeSockets.add(socket);
      socket.once('close', () => this.upgradeSockets.delete(socket));
      this.webSockets.handleUpgrade(request, socket, head, client => {
        this.webSockets.emit('connection', client, request);
      });
    });
    this.webSockets.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.challengeCleanupTimer = setInterval(
      () => this.sweepAuthState(),
      this.network.challengeCleanupMs,
    );
    this.challengeCleanupTimer.unref?.();
  }

  attachEconomicsPool(pool: Pool): void {
    this.economicsPool = pool;
  }

  static async create(options: ApiServerOptions = {}): Promise<ApiServer> {
    if (options.economics) {
      return new ApiServer(options);
    }
    if (resolveEconomicsBackend() === 'memory') {
      return new ApiServer(options);
    }
    const { store, tournaments, chain, pool } = await connectPostgresEconomics();
    try {
      await recoverDurableState({ economics: store, tournaments });
    } catch (error) {
      await pool.end().catch(() => undefined);
      const detail = error instanceof RecoveryFailedError
        ? error.publicMessage
        : (error instanceof Error ? error.message : String(error));
      throw new EconomicsUnavailableError(`Boot recovery failed before listen: ${detail}`);
    }
    const server = new ApiServer({
      ...options,
      economics: store,
      tournamentRepository: new PostgresTournamentRepository(tournaments),
      chainStore: chain,
      chainEconomy: new ChainEconomyService({ chainStore: chain }),
    });
    server.attachEconomicsPool(pool);
    return server;
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, this.bindHost, () => resolve());
    });
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Server did not expose a port.');
    return address.port;
  }

  /** Visible for tests: live authenticated-or-anonymous WebSocket count. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Visible for tests: in-memory auth challenges that have not expired. */
  get pendingChallengeCount(): number {
    return this.pendingChallenges.size;
  }

  /** Visible for tests. */
  flushAuthStateForTests(now = Date.now()): void {
    this.sweepAuthState(now);
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.challengeCleanupTimer);
    this.rateLimiter.stop();
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    this.sessionsByPlayer.clear();
    this.pendingChallenges.clear();
    this.challengeByConnection.clear();
    this.consumedNonces.clear();
    this.connectionsByIp.clear();
    for (const unsubscribe of this.matchUnsubscribers.values()) unsubscribe();
    this.matchUnsubscribers.clear();
    for (const unsubscribe of this.casualUnsubscribers.values()) unsubscribe();
    this.casualUnsubscribers.clear();
    for (const connection of this.connections.values()) {
      connection.socket.terminate();
      (connection.socket as WebSocket & { _socket?: { destroy: () => void } })._socket?.destroy();
    }
    for (const client of this.webSockets.clients) {
      client.terminate();
      (client as WebSocket & { _socket?: { destroy: () => void } })._socket?.destroy();
    }
    for (const socket of this.upgradeSockets) socket.destroy();
    this.httpServer.closeAllConnections();
    this.httpServer.close(() => undefined);
    this.httpServer.unref();
    try {
      this.webSockets.close(() => undefined);
    } catch {
      // The development server may already be closed.
    }
    if (this.economicsPool) {
      await this.economicsPool.end().catch(() => undefined);
      this.economicsPool = undefined;
    }
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const ip = clientIp(request, this.network.trustProxy);
    const origin = authorizeOrigin(headerValue(request.headers.origin), this.network);
    const connection: ClientConnection = {
      socket,
      tournamentIds: new Set(),
      matchIds: new Set(),
      casualRoomIds: new Set(),
      closed: false,
      replaced: false,
      ip,
      origin: origin.ok ? origin.origin : null,
    };
    this.connections.set(socket, connection);
    this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) ?? 0) + 1);
    this.send(connection, { type: 'ready', playerId: '' });

    socket.on('message', raw => {
      void this.handleMessage(connection, raw);
    });
    socket.on('close', () => this.handleSocketClose(connection));
    socket.on('error', () => this.handleSocketClose(connection));
  }

  private async handleMessage(connection: ClientConnection, raw: RawData): Promise<void> {
    const requestId = extractRequestId(raw.toString());
    try {
      const message = parseClientMessage(raw.toString());
      await this.route(connection, message);
    } catch (error) {
      logInternalError(error);
      const publicError = toPublicError(error);
      this.send(connection, {
        type: 'error',
        code: publicError.code,
        message: publicError.message,
      }, requestId);
    }
  }

  private async route(connection: ClientConnection, message: ClientMessage): Promise<void> {
    if (message.type === 'identify') {
      if (!this.allowDemoAuth) throw new DemoAuthDisabledError();
      if (!isDemoPlayerId(message.playerId)) {
        throw new Error(
          'Use auth.challenge / auth.verify for wallet identities. Demo identify is limited to demo-player-1/2.',
        );
      }
      await this.claimSession(connection, message.playerId);
      this.send(connection, { type: 'ready', playerId: message.playerId }, message.requestId);
      this.send(connection, {
        type: 'arena.snapshot',
        snapshot: await this.buildArenaSnapshot(message.playerId),
      }, message.requestId);
      return;
    }

    if (message.type === 'auth.challenge') {
      this.rateLimiter.take(this.rateLimiter.authChallenge, `ip:${connection.ip}:auth.challenge`);
      if (!isSolanaAddress(message.address)) {
        throw new Error('address must be a valid Solana base58 public key.');
      }
      const origin = connection.origin ?? this.network.authOrigin;
      const challenge = this.storeAuthChallenge(connection, message.address, origin);
      this.send(connection, {
        type: 'auth.challenge',
        address: challenge.address,
        nonce: challenge.nonce,
        message: challenge.message,
        expiresAt: challenge.expiresAt,
      }, message.requestId);
      return;
    }

    if (message.type === 'auth.verify') {
      const key = `${message.address}:${message.nonce}`;
      const challenge = this.pendingChallenges.get(key);
      if (!challenge) {
        throw new Error('Unknown or expired authentication challenge.');
      }
      if (challenge.connection !== connection) {
        throw new Error('Authentication challenge belongs to another connection.');
      }
      this.forgetChallenge(key);
      if (Date.now() > challenge.expiresAt) {
        throw new Error('Authentication challenge expired.');
      }
      const consumedUntil = this.consumedNonces.get(challenge.nonce);
      if (consumedUntil && consumedUntil > Date.now()) {
        throw new Error('Authentication nonce already used.');
      }
      if (message.address !== challenge.address) {
        throw new Error('Address does not match challenge.');
      }
      const expectedOrigin = connection.origin ?? this.network.authOrigin;
      if (challenge.origin !== expectedOrigin) {
        throw new Error('Authentication challenge origin does not match this connection.');
      }
      const valid = verifySolanaSignature({
        address: message.address,
        message: challenge.message,
        signature: message.signature,
      });
      if (!valid) {
        throw new Error('Invalid wallet signature.');
      }
      this.consumedNonces.set(challenge.nonce, challenge.expiresAt);
      await this.claimSession(connection, message.address);
      this.send(connection, { type: 'auth.verified', playerId: message.address }, message.requestId);
      this.send(connection, { type: 'ready', playerId: message.address }, message.requestId);
      this.send(connection, {
        type: 'arena.snapshot',
        snapshot: await this.buildArenaSnapshot(message.address),
      }, message.requestId);
      return;
    }

    if (message.type === 'ping') {
      this.send(connection, { type: 'pong' }, message.requestId);
      return;
    }

    const playerId = this.requireIdentity(connection);
    switch (message.type) {
      case 'arena.snapshot':
        this.send(connection, {
          type: 'arena.snapshot',
          snapshot: await this.buildArenaSnapshot(playerId),
        }, message.requestId);
        return;
      case 'trainer.profile': {
        const profile = this.trainers.set(playerId, {
          username: message.username,
          spriteId: message.spriteId,
        });
        this.send(connection, {
          type: 'trainer.profile',
          playerId,
          profile,
        }, message.requestId);
        this.broadcastTrainerDirectory();
        return;
      }
      case 'passport.status': {
        if (!this.chainEconomy.enabled) {
          this.send(connection, {
            type: 'passport.status',
            passport: {
              eligible: false,
              liquidAtoms: '0',
              heldEntryAtoms: '0',
              qualifyingAtoms: '0',
              usdCents: 0,
              thresholdUsdCents: 2000,
              reason: 'wallet_unavailable',
              shortfallAtoms: '0',
              atomsForEntryAndPassport: '0',
              quote: {
                priceMicroUsd: 0,
                decimals: 6,
                observedAt: Date.now(),
                source: 'env',
                confidenceBps: 0,
                quoteId: 'disabled',
              },
            },
            chainEconomyEnabled: false,
          }, message.requestId);
          return;
        }
        const passport = await this.chainEconomy.getPassport(playerId);
        this.send(connection, {
          type: 'passport.status',
          passport,
          chainEconomyEnabled: true,
        }, message.requestId);
        return;
      }
      case 'treasury.snapshot': {
        const deposits = await this.chainEconomy.listTreasury();
        this.send(connection, {
          type: 'treasury.snapshot',
          deposits: deposits.map(row => ({
            claimKey: row.claimKey,
            source: row.source,
            grossLamports: row.grossLamports,
            treasuryLamports: row.treasuryLamports,
            operatorLamports: row.operatorLamports,
            ...(row.signature ? { signature: row.signature } : {}),
            createdAt: row.createdAt.toISOString(),
          })),
          chainEconomyEnabled: this.chainEconomy.enabled,
        }, message.requestId);
        return;
      }
      case 'tx.confirm': {
        if (!this.chainEconomy.enabled) {
          throw new Error('Chain economy is not enabled.');
        }
        const intent = await this.chainEconomy.getIntent(message.intentId);
        if (!intent) throw new Error('Unknown transaction intent.');
        if (intent.playerId && intent.playerId !== playerId) {
          throw new Error('This transaction intent belongs to another wallet.');
        }
        const result = await this.chainEconomy.confirmIntent({
          intentId: message.intentId,
          signature: message.signature,
        });
        this.send(connection, {
          type: 'tx.update',
          intentId: message.intentId,
          status: result.status,
          signature: message.signature,
        }, message.requestId);
        if (result.status === 'confirmed' && intent.kind === 'poke_entry_deposit') {
          try {
            await this.tournaments.registerPlayer(intent.tournamentId as TournamentId, {
              playerId: playerId as TournamentPlayerId,
              displayName: playerId,
              team: String(intent.metadata.team ?? ''),
            });
          } catch (error) {
            await this.chainEconomy.refundPokeEntry({
              tournamentId: intent.tournamentId!,
              playerId,
              playerPokeAta: String(intent.metadata.playerPokeAta),
            });
            throw error;
          }
          connection.tournamentIds.add(intent.tournamentId as TournamentId);
          this.send(connection, {
            type: 'tournament.state',
            tournament: await this.serializeTournament(intent.tournamentId as TournamentId, playerId),
          }, message.requestId);
        }
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.create': {
        this.rateLimiter.take(this.rateLimiter.casualCreate, `player:${playerId}:casual.create`);
        if (this.chainEconomy.enabled) {
          await this.chainEconomy.assertCanPlay(playerId);
          const lamports = message.collateralLamports ?? message.collateral;
          const room = await this.casual.createRoom({
            creatorId: playerId,
            roomType: message.roomType,
            battleSize: message.battleSize,
            collateral: lamports,
            invitedPlayerId: message.invitedPlayerId,
            rail: 'sol_chain',
            ruleset: message.ruleset ?? 'casual',
          });
          const intent = await this.chainEconomy.createSolWagerDepositIntent({
            roomId: room.id,
            playerId,
            side: 0,
            collateralLamports: lamports,
          });
          connection.casualRoomIds.add(room.id);
          this.ensureCasualSubscription(room.id);
          this.send(connection, {
            type: 'casual.created',
            room,
            intent: {
              intentId: intent.intentId,
              serializedTx: intent.serializedTx,
              kind: 'sol_wager_deposit',
              economics: intent.economics,
            },
          }, message.requestId);
          void this.broadcastArenaSnapshots();
          return;
        }
        const room = await this.casual.createRoom({
          creatorId: playerId,
          roomType: message.roomType,
          battleSize: message.battleSize,
          collateral: message.collateral,
          invitedPlayerId: message.invitedPlayerId,
          ruleset: message.ruleset ?? 'casual',
        });
        connection.casualRoomIds.add(room.id);
        this.ensureCasualSubscription(room.id);
        this.send(connection, { type: 'casual.created', room: this.casual.getRoom(room.id, playerId) }, message.requestId);
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.list':
        this.send(connection, {
          type: 'casual.list',
          rooms: this.casual.listOpenRooms(playerId),
          recentResults: this.casual.listRecentResults(10, playerId),
        }, message.requestId);
        return;
      case 'casual.preview':
        this.send(connection, {
          type: 'casual.preview',
          economics: this.chainEconomy.enabled
            ? { ...this.chainEconomy.previewCasual(message.collateral) }
            : previewCasual(message.collateral),
        }, message.requestId);
        return;
      case 'casual.accept': {
        if (this.chainEconomy.enabled) {
          await this.chainEconomy.assertCanPlay(playerId);
        }
        const room = await this.casual.acceptRoom(message.roomId, playerId);
        connection.casualRoomIds.add(room.id);
        this.ensureCasualSubscription(room.id);
        if (this.chainEconomy.enabled) {
          const intent = await this.chainEconomy.createSolWagerDepositIntent({
            roomId: room.id,
            playerId,
            side: 1,
            collateralLamports: room.collateral,
          });
          this.send(connection, {
            type: 'tx.intent',
            intent: {
              intentId: intent.intentId,
              serializedTx: intent.serializedTx,
              kind: 'sol_wager_deposit',
              economics: intent.economics,
            },
          }, message.requestId);
        }
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.ready': {
        const room = this.casual.setReady(message.roomId, playerId, message.ready, message.team);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        return;
      }
      case 'casual.select': {
        const room = this.casual.selectTeam(
          message.roomId,
          playerId,
          message.slots,
          message.confirm ?? false,
        );
        const confirmed = room.status === 'drafting'
          && room.teamPreview?.length === 2
          && room.teamPreview.every(preview => preview.confirmed);
        if (confirmed) {
          await this.startCasualBattle(connection, message.roomId, playerId, undefined, message.requestId);
        } else {
          this.send(connection, { type: 'casual.state', room }, message.requestId);
          this.broadcastCasual(room.id);
        }
        return;
      }
      case 'casual.start': {
        await this.startCasualBattle(connection, message.roomId, playerId, message.team, message.requestId);
        return;
      }
      case 'casual.forfeit': {
        const room = await this.casual.forfeit(message.roomId, playerId);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        if (room.status === 'completed') {
          this.broadcastCasualResult(room.id);
          this.scheduleMatchBroadcast(room.matchId);
        }
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.cancel': {
        const room = await this.casual.cancelRoom(message.roomId, playerId);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.subscribe': {
        const room = this.casual.getRoom(message.roomId);
        if (
          room.creatorId !== playerId
          && room.opponentId !== playerId
          && room.invitedPlayerId !== playerId
          && room.roomType !== 'open'
        ) {
          throw new Error('You cannot subscribe to this casual room.');
        }
        connection.casualRoomIds.add(room.id);
        this.ensureCasualSubscription(room.id);
        this.send(connection, { type: 'casual.state', room: this.casual.getRoom(room.id, playerId) }, message.requestId);
        return;
      }
      case 'tournament.create': {
        this.rateLimiter.take(this.rateLimiter.tournamentCreate, `player:${playerId}:tournament.create`);
        // Chain cups use quoted ~$5 POKE atoms (not host-chosen POKE). Legacy path keeps entryFee.
        let entryFee = message.entryFee ?? DEFAULT_TOURNAMENT_ENTRY_POKE;
        let chainEntryAtoms: number | undefined;
        let chainQuoteId: string | undefined;
        if (this.chainEconomy.enabled) {
          const quoted = this.chainEconomy.quotedEntryAtoms();
          await this.chainEconomy.persistQuote(quoted.quote);
          chainEntryAtoms = Number(quoted.atoms);
          chainQuoteId = quoted.quote.quoteId;
          entryFee = 0;
        }
        const tournament = await this.tournaments.createTournament({
          title: message.title ?? 'PokeArena Open',
          format: 'gen9ou',
          maxPlayers: message.maxPlayers ?? 4,
          matchTimeoutMs: 300_000,
          hostId: playerId,
          entryFee,
          ...(this.chainEconomy.enabled
            ? {
                rail: 'sol_chain' as const,
                entryAtoms: chainEntryAtoms,
                entryQuoteId: chainQuoteId,
                prizeLamports: Number(process.env.POKEARENA_TOURNAMENT_PRIZE_LAMPORTS ?? 100_000_000),
              }
            : {}),
        });
        await this.tournaments.openRegistration(tournament.id);
        connection.tournamentIds.add(tournament.id);
        this.send(connection, {
          type: 'tournament.created',
          tournament: await this.serializeTournament(tournament.id, playerId),
        }, message.requestId);
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'tournament.list':
        this.send(connection, {
          type: 'tournament.list',
          tournaments: await this.listTournamentSummaries(),
        }, message.requestId);
        return;
      case 'tournament.join': {
        const tournamentId = message.tournamentId as TournamentId;
        const targetTournament = await this.tournaments.getTournament(tournamentId);
        const team = this.teamForTournamentJoin(playerId, message.team);
        validateAndPackTeam(team, 'gen9ou');
        if (this.chainEconomy.enabled) {
          await this.chainEconomy.assertCanPlay(playerId);
          if (!message.playerPokeAta) {
            throw new Error('playerPokeAta is required for chain tournament entry.');
          }
          const entry = await this.chainEconomy.createPokeEntryDepositIntent({
            tournamentId,
            playerId,
            playerPokeAta: message.playerPokeAta,
            team,
            ...(targetTournament.entryAtoms !== undefined
              ? { entryAtoms: targetTournament.entryAtoms }
              : {}),
            ...(targetTournament.entryQuoteId
              ? { quoteId: targetTournament.entryQuoteId }
              : {}),
          });
          this.send(connection, {
            type: 'tx.intent',
            intent: {
              intentId: entry.intentId,
              serializedTx: entry.serializedTx,
              kind: 'poke_entry_deposit',
              entryAtoms: entry.entryAtoms,
              quote: entry.quote,
              passport: entry.passport,
            },
          }, message.requestId);
        }
        if (!this.chainEconomy.enabled) {
          await this.tournaments.registerPlayer(tournamentId, {
            playerId,
            displayName: playerId,
            team,
          });
        }
        connection.tournamentIds.add(tournamentId);
        this.send(connection, {
          type: 'tournament.state',
          tournament: await this.serializeTournament(tournamentId, playerId),
        }, message.requestId);
        await this.broadcastTournament(tournamentId);
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'tournament.start': {
        const tournamentId = message.tournamentId as TournamentId;
        await this.requireTournamentHost(playerId, tournamentId);
        const beforeStart = await this.tournaments.getTournament(tournamentId);
        if (this.chainEconomy.enabled) {
          const registered = beforeStart.players
            .filter(player => player.status === 'registered')
            .map(player => player.id);
          await this.chainEconomy.lockTournament({
            tournamentId,
            playerIds: registered,
            prizeLamports: Number(process.env.POKEARENA_TOURNAMENT_PRIZE_LAMPORTS ?? 100_000_000),
          });
        }
        const tournament = await this.tournaments.startTournament(tournamentId);
        await this.startReadyMatches(tournament.id);
        await this.broadcastTournament(tournament.id);
        this.send(connection, {
          type: 'tournament.state',
          tournament: await this.serializeTournament(tournament.id, playerId),
        }, message.requestId);
        return;
      }
      case 'tournament.cancel': {
        const tournamentId = message.tournamentId as TournamentId;
        await this.requireTournamentHost(playerId, tournamentId);
        const tournament = await this.tournaments.getTournament(tournamentId);
        if (this.chainEconomy.enabled) {
          for (const participant of tournament.players.filter(candidate => candidate.status === 'registered')) {
            const intent = await this.chainEconomy.getIntentByScope(
              'poke_entry_deposit',
              `${tournamentId}:${participant.id}`,
            );
            if (intent?.status === 'confirmed') {
              await this.chainEconomy.refundPokeEntry({
                tournamentId,
                playerId: participant.id,
                playerPokeAta: String(intent.metadata.playerPokeAta),
              });
            }
          }
        }
        const cancelled = await this.tournaments.cancelTournament(tournamentId);
        this.send(connection, {
          type: 'tournament.state',
          tournament: await this.serializeTournament(tournamentId, playerId),
        }, message.requestId);
        void cancelled;
        return;
      }
      case 'tournament.subscribe': {
        const tournamentId = message.tournamentId as TournamentId;
        await this.tournaments.getTournament(tournamentId);
        connection.tournamentIds.add(tournamentId);
        this.send(connection, {
          type: 'tournament.state',
          tournament: await this.serializeTournament(tournamentId, playerId),
        }, message.requestId);
        return;
      }
      case 'match.subscribe': {
        const matchId = message.matchId;
        const casualRoom = this.casual.getRoomByMatchId(matchId, playerId);
        if (casualRoom) {
          if (casualRoom.creatorId !== playerId && casualRoom.opponentId !== playerId) {
            throw new Error('You are not a player in this casual match.');
          }
          if (casualRoom.status === 'ready') {
            const waiting = Boolean(
              casualRoom.countdownEndsAt && Date.now() < casualRoom.countdownEndsAt,
            );
            if (!waiting) {
              if ((casualRoom.ruleset ?? 'casual') !== 'casual' && this.chainEconomy.enabled) {
                await this.chainEconomy.prepareCasualStart(casualRoom.id);
              }
              await this.casual.startBattle(casualRoom.id, playerId);
            }
          } else if (casualRoom.status === 'drafting') {
            const bothPicked = Boolean(
              casualRoom.teamPreview?.length === 2
              && casualRoom.teamPreview.every(preview => preview.confirmed),
            );
            if (bothPicked) {
              if (this.chainEconomy.enabled) {
                await this.chainEconomy.prepareCasualStart(casualRoom.id);
              }
              await this.casual.startBattle(casualRoom.id, playerId);
            }
          }
          connection.matchIds.add(matchId);
          connection.casualRoomIds.add(casualRoom.id);
          this.ensureCasualSubscription(casualRoom.id);
          this.sendCasualMatch(connection, matchId, 'match.subscribed', message.requestId);
          return;
        }

        const tournamentMatchId = matchId as TournamentMatchId;
        const view = await this.tournaments.getMatch(tournamentMatchId);
        if (view.match.player1 !== playerId && view.match.player2 !== playerId) {
          throw new Error('You are not a player in this match.');
        }
        if (view.match.status === 'ready' || view.match.status === 'tied' || view.match.status === 'interrupted') {
          await this.tournaments.startMatch(tournamentMatchId);
        }
        connection.matchIds.add(matchId);
        this.ensureMatchSubscription(tournamentMatchId);
        await this.sendTournamentMatchAsync(connection, tournamentMatchId, 'match.subscribed', message.requestId);
        return;
      }
      case 'team.starter':
        this.send(connection, {
          type: 'team.starter',
          name: 'Demo Circuit',
          paste: (playerId === 'demo-player-1' ? DEMO_TEAM_ONE : DEMO_TEAM_TWO).trim(),
        }, message.requestId);
        return;
      case 'team.inspect':
        this.rateLimiter.take(this.rateLimiter.teamInspect, `player:${playerId}:team.inspect`);
        this.send(connection, {
          type: 'team.inspect',
          inspection: inspectTeam(message.team, 'gen9ou'),
        }, message.requestId);
        return;
      case 'team.search': {
        this.rateLimiter.take(this.rateLimiter.teamSearch, `player:${playerId}:team.search`);
        const found = searchTeamHits(message.kind, message.query, message.species);
        this.send(connection, {
          type: 'team.search',
          results: found.hits.map(hit => hit.name),
          hits: found.hits,
          scoped: found.scoped,
        }, message.requestId);
        return;
      }
      case 'match.choice': {
        this.rateLimiter.take(this.rateLimiter.matchChoice, `player:${playerId}:match.choice`);
        const matchId = message.matchId;
        if (!connection.matchIds.has(matchId)) throw new Error('Subscribe to the match first.');
        const casualRoom = this.casual.getRoomByMatchId(matchId);
        if (casualRoom) {
          await this.casual.submitChoice({
            matchId,
            battleInstanceId: message.battleInstanceId,
            playerId,
            revision: message.requestRevision,
            choice: message.choice,
          });
          this.send(connection, { type: 'match.choice.accepted', matchId }, message.requestId);
          this.scheduleMatchBroadcast(matchId);
          return;
        }

        const tournamentMatchId = matchId as TournamentMatchId;
        const view = await this.tournaments.getMatch(tournamentMatchId);
        if (view.match.player1 !== playerId && view.match.player2 !== playerId) {
          throw new Error('You are not a player in this match.');
        }
        await this.tournaments.submitChoice({
          matchId: tournamentMatchId,
          battleInstanceId: message.battleInstanceId as BattleInstanceId,
          playerId,
          revision: message.requestRevision,
          choice: message.choice,
        });
        this.send(connection, { type: 'match.choice.accepted', matchId }, message.requestId);
        this.scheduleMatchBroadcast(matchId);
        return;
      }
      case 'live.list':
        this.send(connection, {
          type: 'live.list',
          fights: await this.listLiveFights(),
        }, message.requestId);
        return;
      case 'live.watch':
        await this.watchLiveFight(connection, playerId, message.matchId, message.requestId);
        return;
      case 'live.unwatch':
        connection.watchedMatchId = undefined;
        this.send(connection, { type: 'live.update' }, message.requestId);
        return;
      default:
        throw new Error('Unhandled client message.');
    }
  }

  private async buildArenaSnapshot(playerId: string): Promise<ArenaSnapshot> {
    const base: ArenaSnapshot = {
      wallet: await this.economics.ensureWallet(playerId),
      tournaments: await this.listTournamentSummaries(),
      openCasualRooms: this.casual.listOpenRooms(playerId),
      myCasualRooms: this.casual.listRoomsForPlayer(playerId),
      recentCasualResults: this.casual.listRecentResults(10, playerId),
      chainEconomyEnabled: this.chainEconomy.enabled,
      trainers: this.trainers.snapshot(),
    };
    if (!this.chainEconomy.enabled || !this.chainEconomy.client) return base;
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const owner = new PublicKey(playerId);
      const passport = await this.chainEconomy.getPassport(playerId);
      const freeLamports = await this.chainEconomy.client.getSolBalance(owner);
      const treasuryLamports = await this.chainEconomy.client.getTreasuryLamports();
      return {
        ...base,
        passport,
        solBalances: {
          freeLamports: freeLamports.toString(),
          treasuryLamports: treasuryLamports.toString(),
        },
      };
    } catch {
      return base;
    }
  }

  private async listTournamentSummaries(): Promise<TournamentSummary[]> {
    const tournaments = await this.tournaments.listTournaments();
    return tournaments.map(tournament => {
      const playerCount = tournament.players.filter(player => player.status === 'registered').length;
      return {
        id: tournament.id,
        title: tournament.title,
        format: tournament.format,
        maxPlayers: tournament.maxPlayers,
        status: tournament.status,
        playerCount,
        entryFee: tournament.entryFee,
        economics: previewTournament(tournament.entryFee, Math.max(playerCount, tournament.maxPlayers)),
        ...(tournament.winner ? { winner: tournament.winner } : {}),
      };
    });
  }

  private async listLiveFights(): Promise<LiveFight[]> {
    const fights: LiveFight[] = [];
    for (const tournament of await this.tournaments.listTournaments()) {
      if (tournament.status !== 'in-progress') continue;
      for (const match of await this.tournaments.getBracket(tournament.id)) {
        if (match.status !== 'active' && match.status !== 'battle-created') continue;
        if (!match.player1 || !match.player2) continue;
        fights.push({
          matchId: match.id,
          source: 'tournament',
          title: tournament.title,
          player1: match.player1,
          player2: match.player2,
          format: tournament.format,
          tournamentId: tournament.id,
          status: 'active',
        });
      }
    }
    for (const room of this.casual.listLiveBattles()) {
      if (!room.opponentId) continue;
      fights.push({
        matchId: room.matchId,
        source: 'casual',
        title: room.ruleset === 'competitive' ? 'Competitive · Gen 9 OU' : 'Casual 6 → 3',
        player1: room.creatorId,
        player2: room.opponentId,
        format: room.format,
        battleSize: room.battleSize,
        roomId: room.id,
        status: 'active',
      });
    }
    return fights;
  }

  private async watchLiveFight(
    connection: ClientConnection,
    playerId: string,
    matchId: string | undefined,
    requestId?: string,
  ): Promise<void> {
    const fights = await this.listLiveFights();
    const fight = matchId
      ? fights.find(item => item.matchId === matchId)
      : pickLiveFight(fights, playerId, connection.watchedMatchId);
    if (!fight) {
      connection.watchedMatchId = undefined;
      this.send(connection, { type: 'live.update' }, requestId);
      return;
    }
    connection.watchedMatchId = fight.matchId;
    if (fight.source === 'casual' && fight.roomId) this.ensureCasualSubscription(fight.roomId);
    if (fight.source === 'tournament') this.ensureMatchSubscription(fight.matchId as TournamentMatchId);
    await this.sendLiveUpdate(connection, fight, requestId);
  }

  private broadcastLiveWatchers(matchId: string): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.watchedMatchId !== matchId || !connection.playerId || connection.closed) continue;
      void this.sendLiveUpdate(connection).catch(() => {
        connection.watchedMatchId = undefined;
      });
    }
  }

  private async sendLiveUpdate(
    connection: ClientConnection,
    knownFight?: LiveFight,
    requestId?: string,
  ): Promise<void> {
    if (!connection.playerId || connection.closed) return;
    const matchId = knownFight?.matchId ?? connection.watchedMatchId;
    if (!matchId) {
      this.send(connection, { type: 'live.update' }, requestId);
      return;
    }
    const fights = knownFight ? [knownFight] : await this.listLiveFights();
    let fight = knownFight ?? fights.find(item => item.matchId === matchId);
    const casualRoom = this.casual.getRoomByMatchId(matchId);
    if (casualRoom) {
      if (casualRoom.roomType !== 'open') {
        connection.watchedMatchId = undefined;
        this.send(connection, { type: 'live.update' }, requestId);
        return;
      }
      fight = {
        matchId: casualRoom.matchId,
        source: 'casual',
        title: casualRoom.ruleset === 'competitive' ? 'Competitive · Gen 9 OU' : 'Casual 6 → 3',
        player1: casualRoom.creatorId,
        player2: casualRoom.opponentId,
        format: casualRoom.format,
        battleSize: casualRoom.battleSize,
        roomId: casualRoom.id,
        status: casualRoom.status === 'battling' ? 'active' : casualRoom.status,
      };
      const view = this.trainers.namedView(
        spectatorBattleView(this.casual.getMatchView(matchId, 'spectator')),
      );
      const events = spectatorEvents(this.casual.getMatchEvents(matchId, 'spectator'));
      this.send(connection, {
        type: 'live.update',
        fight,
        ...(view ? { view } : {}),
        events,
      }, requestId);
      return;
    }
    try {
      const tournamentMatch = await this.tournaments.getMatch(matchId as TournamentMatchId);
      const tournament = await this.tournaments.getTournament(tournamentMatch.match.tournamentId);
      fight = {
        matchId: tournamentMatch.match.id,
        source: 'tournament',
        title: tournament.title,
        player1: tournamentMatch.match.player1 ?? '',
        player2: tournamentMatch.match.player2,
        format: tournament.format,
        tournamentId: tournament.id,
        status: tournamentMatch.match.status === 'active' || tournamentMatch.match.status === 'battle-created'
          ? 'active'
          : tournamentMatch.match.status,
      };
      const view = this.trainers.namedView(spectatorBattleView(
        await this.tournaments.getMatchView(matchId as TournamentMatchId, 'spectator'),
      ));
      const eventLog = await this.tournaments.getMatchEvents(matchId as TournamentMatchId, 'spectator');
      this.send(connection, {
        type: 'live.update',
        fight,
        ...(view ? { view } : {}),
        events: spectatorEvents(eventLog.events),
      }, requestId);
    } catch {
      connection.watchedMatchId = undefined;
      this.send(connection, { type: 'live.update' }, requestId);
    }
  }

  private async serializeTournament(tournamentId: TournamentId, viewerId: string): Promise<unknown> {
    const tournament = await this.tournaments.getTournament(tournamentId);
    const playerCount = tournament.players.filter(player => player.status === 'registered').length;
    return {
      ...publicTournamentForViewer(tournament, viewerId),
      hostId: tournament.hostId,
      bracket: await this.tournaments.getBracket(tournamentId),
      entryFee: tournament.entryFee,
      economics: previewTournament(tournament.entryFee, Math.max(playerCount, 1)),
      payout: this.tournamentPayouts.get(tournamentId)
        ?? await this.economics.getSettlement(`tournament:${tournamentId}`),
    };
  }

  private teamForTournamentJoin(playerId: string, team: string | undefined): string {
    if (team) return team;
    if (this.allowDemoAuth && playerId === 'demo-player-1') return DEMO_TEAM_ONE;
    if (this.allowDemoAuth && playerId === 'demo-player-2') return DEMO_TEAM_TWO;
    throw new TeamRequiredError();
  }

  private async startReadyMatches(tournamentId: TournamentId): Promise<void> {
    for (const match of await this.tournaments.getBracket(tournamentId)) {
      if (match.status !== 'ready' && match.status !== 'tied') continue;
      await this.tournaments.startMatch(match.id);
      this.ensureMatchSubscription(match.id);
      this.broadcastTournamentMatch(match.id);
    }
  }

  private ensureMatchSubscription(matchId: TournamentMatchId): void {
    if (this.matchUnsubscribers.has(matchId)) return;
    this.matchUnsubscribers.set(matchId, () => undefined);
    void this.tournaments.subscribeMatch(matchId, match => {
      try {
        this.scheduleMatchBroadcast(match.id);
        if (match.status === 'completed' || match.status === 'forfeited') {
          void this.startReadyMatches(match.tournamentId).catch(error => {
            this.broadcastError(match.tournamentId, error);
          });
          void this.maybeSettleTournament(match.tournamentId).catch(() => undefined);
          void this.broadcastTournament(match.tournamentId).catch(() => undefined);
        }
      } catch {
        // Match observers must not crash the process.
      }
    }).then(unsubscribe => {
      this.matchUnsubscribers.set(matchId, unsubscribe);
    }).catch(() => {
      this.matchUnsubscribers.delete(matchId);
    });
  }

  private ensureCasualSubscription(roomId: string): void {
    if (this.casualUnsubscribers.has(roomId)) return;
    const unsubscribe = this.casual.subscribe(roomId, room => {
      try {
        this.broadcastCasual(room.id);
        if (room.status === 'battling' || room.status === 'completed') {
          this.scheduleMatchBroadcast(room.matchId);
        }
        if (room.status === 'completed' && room.payout) {
          this.broadcastCasualResult(room.id);
          void this.broadcastArenaSnapshots();
        }
      } catch {
        // Room observers must not crash the process.
      }
    });
    this.casualUnsubscribers.set(roomId, unsubscribe);
  }

  private async maybeSettleTournament(tournamentId: TournamentId): Promise<void> {
    const existing = this.settlementJobs.get(tournamentId);
    if (existing) return existing;
    const job = this.settleTournamentChampion(tournamentId).catch(() => undefined);
    this.settlementJobs.set(tournamentId, job);
    return job;
  }

  private async settleTournamentChampion(tournamentId: TournamentId): Promise<void> {
    const result = await this.tournaments.getTournamentResult(tournamentId);
    if (!result) return;
    const stored = await this.economics.getSettlement(`tournament:${tournamentId}`);
    if (stored) {
      this.tournamentPayouts.set(tournamentId, stored);
      return;
    }
    const tournament = await this.tournaments.getTournament(tournamentId);
    // Chain cups: champion prize is SOL via pay_prize (treasury reserve), not entry POKE.
    if (this.chainEconomy.enabled) {
      const payout = await this.chainEconomy.payTournamentPrize({
        tournamentId,
        winnerId: result.winner,
      });
      this.tournamentPayouts.set(tournamentId, payout);
      for (const connection of [...this.connections.values()]) {
        if (!connection.tournamentIds.has(tournamentId) || !connection.playerId || connection.closed) continue;
        try {
          this.send(connection, {
            type: 'tournament.result',
            tournament: await this.serializeTournament(tournamentId, connection.playerId),
            payout,
          });
        } catch {
          connection.tournamentIds.delete(tournamentId);
        }
      }
      await this.broadcastArenaSnapshots();
      return;
    }
    const playerCount = tournament.players.filter(player => player.status === 'registered').length;
    const holdKeys = tournament.players
      .filter(player => player.status === 'registered')
      .map(player => `tournament:${tournamentId}:${player.id}`);
    const payout = await this.economics.completeTournamentWin({
      winnerId: result.winner,
      entryFee: tournament.entryFee,
      playerCount,
      settlementKey: `tournament:${tournamentId}`,
      holdKeys,
    });
    this.tournamentPayouts.set(tournamentId, payout);
    for (const connection of [...this.connections.values()]) {
      if (!connection.tournamentIds.has(tournamentId) || !connection.playerId || connection.closed) continue;
      try {
        this.send(connection, {
          type: 'tournament.result',
          tournament: await this.serializeTournament(tournamentId, connection.playerId),
          payout,
        });
      } catch {
        connection.tournamentIds.delete(tournamentId);
      }
    }
    await this.broadcastArenaSnapshots();
  }

  private broadcastTournamentMatch(matchId: TournamentMatchId): void {
    for (const connection of [...this.connections.values()]) {
      if (!connection.matchIds.has(matchId) || !connection.playerId || connection.closed) continue;
      this.sendTournamentMatch(connection, matchId, 'match.update');
    }
  }

  private broadcastCasualMatch(matchId: string): void {
    for (const connection of [...this.connections.values()]) {
      if (!connection.matchIds.has(matchId) || !connection.playerId || connection.closed) continue;
      this.sendCasualMatch(connection, matchId, 'match.update');
    }
  }

  private scheduleMatchBroadcast(matchId: string): void {
    if (this.pendingMatchBroadcasts.has(matchId)) return;
    this.pendingMatchBroadcasts.add(matchId);
    setImmediate(() => {
      this.pendingMatchBroadcasts.delete(matchId);
      try {
        if (this.casual.getRoomByMatchId(matchId)) {
          this.broadcastCasualMatch(matchId);
        } else {
          this.broadcastTournamentMatch(matchId as TournamentMatchId);
        }
        this.broadcastLiveWatchers(matchId);
      } catch {
        // Stale match broadcasts must not crash the process.
      }
    });
  }

  private sendTournamentMatch(
    connection: ClientConnection,
    matchId: TournamentMatchId,
    type: 'match.update' | 'match.subscribed',
    requestId?: string,
  ): void {
    if (!connection.playerId || connection.closed) return;
    void this.sendTournamentMatchAsync(connection, matchId, type, requestId).catch(() => {
      connection.matchIds.delete(matchId);
    });
  }

  private async sendTournamentMatchAsync(
    connection: ClientConnection,
    matchId: TournamentMatchId,
    type: 'match.update' | 'match.subscribed',
    requestId?: string,
  ): Promise<void> {
    if (!connection.playerId || connection.closed) return;
    const view = await this.tournaments.getMatch(matchId);
    if (view.match.player1 !== connection.playerId && view.match.player2 !== connection.playerId) {
      connection.matchIds.delete(matchId);
      return;
    }
    const state = await this.tournaments.getMatchState(matchId, connection.playerId);
    const eventLog = await this.tournaments.getMatchEvents(matchId, connection.playerId);
    const battleView = await this.tournaments.getMatchView(matchId, connection.playerId);
    this.send(connection, {
      type,
      match: view.match,
      state,
      events: eventLog.events as unknown[],
      view: this.trainers.namedView(battleView),
      source: 'tournament',
    }, requestId);
  }

  private sendCasualMatch(
    connection: ClientConnection,
    matchId: string,
    type: 'match.update' | 'match.subscribed',
    requestId?: string,
  ): void {
    if (!connection.playerId || connection.closed) return;
    try {
      const room = this.casual.getRoomByMatchId(matchId);
      if (!room) {
        connection.matchIds.delete(matchId);
        return;
      }
      if (room.creatorId !== connection.playerId && room.opponentId !== connection.playerId) {
        connection.matchIds.delete(matchId);
        return;
      }
      const state = this.casual.getMatchState(matchId, connection.playerId);
      const events = this.casual.getMatchEvents(matchId, connection.playerId);
      const battleView = this.casual.getMatchView(matchId, connection.playerId);
      this.send(connection, {
        type,
        match: {
          id: room.matchId,
          roomId: room.id,
          status: room.status === 'completed' ? 'completed' : room.status === 'battling' ? 'active' : room.status,
          player1: room.creatorId,
          player2: room.opponentId,
          battleInstanceId: room.battleInstanceId,
          winner: room.winnerId,
          result: room.result ? { kind: 'battle', battleResult: room.result } : undefined,
        },
        state,
        events: events as unknown[],
        view: this.trainers.namedView(battleView),
        source: 'casual',
      }, requestId);
    } catch {
      connection.matchIds.delete(matchId);
    }
  }

  private async broadcastTournament(tournamentId: TournamentId): Promise<void> {
    const payloadByViewer = new Map<string, unknown>();
    for (const connection of [...this.connections.values()]) {
      if (!connection.tournamentIds.has(tournamentId) || !connection.playerId || connection.closed) continue;
      try {
        let payload = payloadByViewer.get(connection.playerId);
        if (!payload) {
          payload = await this.serializeTournament(tournamentId, connection.playerId);
          payloadByViewer.set(connection.playerId, payload);
        }
        this.send(connection, {
          type: 'tournament.state',
          tournament: payload,
        });
      } catch {
        connection.tournamentIds.delete(tournamentId);
      }
    }
  }

  private broadcastCasual(roomId: string): void {
    try {
      for (const connection of [...this.connections.values()]) {
        if (!connection.casualRoomIds.has(roomId) || connection.closed) continue;
        this.send(connection, {
          type: 'casual.state',
          room: this.casual.getRoom(roomId, connection.playerId),
        });
      }
    } catch {
      // Unknown rooms are dropped rather than crashing a broadcast.
    }
  }

  private async startCasualBattle(
    connection: ClientConnection,
    roomId: string,
    playerId: string,
    team?: string,
    requestId?: string,
  ): Promise<void> {
    const before = this.casual.getRoom(roomId, playerId);
    const launchingFight = before.status === 'battling'
      || ((before.ruleset ?? 'casual') === 'competitive' && before.status === 'ready')
      || (before.status === 'drafting' && Boolean(
        before.teamPreview?.length === 2
        && before.teamPreview.every(preview => preview.confirmed),
      ));
    if (this.chainEconomy.enabled && launchingFight) {
      await this.chainEconomy.prepareCasualStart(roomId);
    }
    const room = await this.casual.startBattle(roomId, playerId, team);
    if (room.status === 'battling') {
      connection.matchIds.add(room.matchId);
    }
    this.ensureCasualSubscription(room.id);
    this.send(connection, { type: 'casual.state', room }, requestId);
    this.broadcastCasual(room.id);
    if (room.status === 'battling') {
      this.broadcastCasualMatch(room.matchId);
    }
  }

  private broadcastCasualResult(roomId: string): void {
    try {
      for (const connection of [...this.connections.values()]) {
        if (!connection.casualRoomIds.has(roomId) || connection.closed) continue;
        const room = this.casual.getRoom(roomId, connection.playerId);
        this.send(connection, { type: 'casual.result', room, payout: room.payout });
      }
    } catch {
      // Unknown rooms are dropped rather than crashing a broadcast.
    }
  }

  private async broadcastArenaSnapshots(): Promise<void> {
    await Promise.all([...this.connections.values()].map(async connection => {
      if (!connection.playerId || connection.closed) return;
      try {
        this.send(connection, {
          type: 'arena.snapshot',
          snapshot: await this.buildArenaSnapshot(connection.playerId),
        });
      } catch {
        // A stale wallet snapshot must not crash other clients.
      }
    }));
  }

  private broadcastError(tournamentId: TournamentId, error: unknown): void {
    for (const connection of this.connections.values()) {
      if (connection.tournamentIds.has(tournamentId)) {
        this.send(connection, {
          type: 'error',
          code: 'TournamentBroadcastError',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private broadcastTrainerDirectory(): void {
    const trainers = this.trainers.snapshot();
    for (const connection of this.connections.values()) {
      if (!connection.playerId || connection.closed) continue;
      this.send(connection, { type: 'trainer.directory', trainers });
    }
  }

  private async bindIdentity(connection: ClientConnection, playerId: string): Promise<void> {
    connection.playerId = createTournamentPlayerId(playerId);
    await this.economics.ensureWallet(playerId);
  }

  private async claimSession(connection: ClientConnection, playerId: string): Promise<void> {
    if (connection.playerId) {
      throw new AlreadyAuthenticatedError();
    }
    const existing = this.sessionsByPlayer.get(playerId);
    if (existing && existing !== connection && !existing.closed) {
      existing.replaced = true;
      this.send(existing, {
        type: 'error',
        code: 'SessionReplacedError',
        message: new SessionReplacedError().message,
      });
      try {
        existing.socket.close();
      } catch {
        existing.socket.terminate();
      }
    }
    await this.bindIdentity(connection, playerId);
    this.sessionsByPlayer.set(playerId, connection);
    this.clearDisconnectGrace(playerId);
    await this.restoreLiveSubscriptions(connection);
  }

  private async restoreLiveSubscriptions(connection: ClientConnection): Promise<void> {
    const playerId = connection.playerId;
    if (!playerId) return;
    for (const room of this.casual.listRoomsForPlayer(playerId)) {
      if (room.status === 'cancelled' || room.status === 'completed') continue;
      connection.casualRoomIds.add(room.id);
      this.ensureCasualSubscription(room.id);
      if (room.status === 'battling' || room.status === 'starting') {
        connection.matchIds.add(room.matchId);
      }
    }
    for (const tournament of await this.tournaments.listTournaments()) {
      const isMember = tournament.players.some(player => player.id === playerId);
      const isHost = tournament.hostId === playerId;
      if (!isMember && !isHost) continue;
      connection.tournamentIds.add(tournament.id);
      for (const match of await this.tournaments.getBracket(tournament.id)) {
        if (match.player1 !== playerId && match.player2 !== playerId) continue;
        if (
          match.status === 'active'
          || match.status === 'battle-created'
          || match.status === 'ready'
          || match.status === 'tied'
          || match.status === 'interrupted'
        ) {
          connection.matchIds.add(match.id);
          if (match.status === 'active' || match.status === 'battle-created') {
            this.ensureMatchSubscription(match.id);
          }
        }
      }
    }
  }

  private handleSocketClose(connection: ClientConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection.socket);
    this.releaseConnectionSlot(connection);
    this.dropConnectionChallenge(connection);
    const playerId = connection.playerId;
    if (playerId && this.sessionsByPlayer.get(playerId) === connection) {
      this.sessionsByPlayer.delete(playerId);
    }
    if (this.shuttingDown || connection.replaced || !playerId) return;
    void this.onPlayerDisconnected(playerId).catch(() => undefined);
  }

  private authorizeUpgrade(request: IncomingMessage): {
    ok: true;
  } | { ok: false; status: number; reason: 'origin' | 'limit' | 'per-ip' } {
    const origin = authorizeOrigin(headerValue(request.headers.origin), this.network);
    if (!origin.ok) return { ok: false, status: 403, reason: 'origin' };
    if (this.connections.size >= this.network.maxConnections) {
      return { ok: false, status: 429, reason: 'limit' };
    }
    const ip = clientIp(request, this.network.trustProxy);
    if ((this.connectionsByIp.get(ip) ?? 0) >= this.network.maxConnectionsPerIp) {
      return { ok: false, status: 429, reason: 'per-ip' };
    }
    return { ok: true };
  }

  private storeAuthChallenge(connection: ClientConnection, address: string, origin: string): StoredChallenge {
    this.dropConnectionChallenge(connection);
    const challenge = {
      ...createAuthChallenge(address, Date.now(), origin, this.network.challengeTtlMs),
      connection,
    };
    const key = `${challenge.address}:${challenge.nonce}`;
    this.pendingChallenges.set(key, challenge);
    this.challengeByConnection.set(connection, key);
    return challenge;
  }

  private forgetChallenge(key: string): void {
    const challenge = this.pendingChallenges.get(key);
    this.pendingChallenges.delete(key);
    if (challenge) this.challengeByConnection.delete(challenge.connection);
  }

  private dropConnectionChallenge(connection: ClientConnection): void {
    const key = this.challengeByConnection.get(connection);
    if (!key) return;
    this.pendingChallenges.delete(key);
    this.challengeByConnection.delete(connection);
  }

  private sweepAuthState(now = Date.now()): void {
    for (const [key, challenge] of this.pendingChallenges) {
      if (challenge.expiresAt <= now) this.forgetChallenge(key);
    }
    for (const [nonce, expiresAt] of this.consumedNonces) {
      if (expiresAt <= now) this.consumedNonces.delete(nonce);
    }
    this.rateLimiter.prune(now);
  }

  private releaseConnectionSlot(connection: ClientConnection): void {
    const current = this.connectionsByIp.get(connection.ip) ?? 0;
    if (current <= 1) this.connectionsByIp.delete(connection.ip);
    else this.connectionsByIp.set(connection.ip, current - 1);
  }

  private async onPlayerDisconnected(playerId: string): Promise<void> {
    let liveFight = false;
    for (const room of this.casual.listRoomsForPlayer(playerId)) {
      if (room.status === 'open' || room.status === 'full' || room.status === 'ready' || room.status === 'drafting') {
        try {
          await this.casual.cancelRoom(room.id, playerId);
          this.broadcastCasual(room.id);
          await this.broadcastArenaSnapshots();
        } catch {
          // Duplicate close must not refund twice or throw.
        }
      } else if (room.status === 'battling' || room.status === 'starting') {
        liveFight = true;
      }
    }
    for (const tournament of await this.tournaments.listTournaments()) {
      if (tournament.status !== 'in-progress') continue;
      for (const match of await this.tournaments.getBracket(tournament.id)) {
        if (match.player1 !== playerId && match.player2 !== playerId) continue;
        if (match.status === 'active' || match.status === 'battle-created') {
          liveFight = true;
        }
      }
    }
    if (liveFight) this.scheduleDisconnectForfeit(playerId);
  }

  private scheduleDisconnectForfeit(playerId: string): void {
    if (this.disconnectTimers.has(playerId) || this.sessionsByPlayer.has(playerId)) return;
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(playerId);
      void this.settleDisconnectForfeit(playerId).catch(() => undefined);
    }, this.disconnectGraceMs);
    timer.unref?.();
    this.disconnectTimers.set(playerId, timer);
  }

  private clearDisconnectGrace(playerId: string): void {
    const timer = this.disconnectTimers.get(playerId);
    if (!timer) return;
    clearTimeout(timer);
    this.disconnectTimers.delete(playerId);
  }

  private async settleDisconnectForfeit(playerId: string): Promise<void> {
    if (this.sessionsByPlayer.has(playerId) || this.shuttingDown) return;
    for (const room of this.casual.listRoomsForPlayer(playerId)) {
      let current = room;
      if (current.status === 'starting') {
        for (let attempt = 0; attempt < 20 && current.status === 'starting'; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
          current = this.casual.getRoom(room.id);
        }
      }
      if (current.status !== 'battling') continue;
      try {
        const settled = await this.casual.forfeit(current.id, playerId);
        this.broadcastCasual(settled.id);
        if (settled.status === 'completed') {
          this.broadcastCasualResult(settled.id);
          this.scheduleMatchBroadcast(settled.matchId);
        }
        await this.broadcastArenaSnapshots();
      } catch {
        // Already settled by timeout, forfeit, or a duplicate close.
      }
    }
    for (const tournament of await this.tournaments.listTournaments()) {
      if (tournament.status !== 'in-progress') continue;
      for (const match of await this.tournaments.getBracket(tournament.id)) {
        if (match.player1 !== playerId && match.player2 !== playerId) continue;
        if (match.status !== 'active' && match.status !== 'battle-created') continue;
        try {
          await this.tournaments.forfeit(match.id, playerId);
          await this.broadcastTournament(tournament.id);
          this.scheduleMatchBroadcast(match.id);
          await this.maybeSettleTournament(tournament.id);
        } catch {
          // Already settled; do not advance twice.
        }
      }
    }
  }

  private requireIdentity(connection: ClientConnection): TournamentPlayerId {
    if (!connection.playerId) {
      throw new Error(this.allowDemoAuth
        ? 'Authenticate with a wallet or identify as a demo player first.'
        : 'Authenticate with a wallet first.');
    }
    return connection.playerId;
  }

  private async requireTournamentHost(playerId: string, tournamentId: TournamentId): Promise<void> {
    const tournament = await this.tournaments.getTournament(tournamentId);
    if (tournament.hostId !== playerId) {
      throw new TournamentHostRequiredError();
    }
  }

  private send(connection: ClientConnection, message: ServerMessage, requestId?: string): void {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) return;
    try {
      connection.socket.send(JSON.stringify({
        ...message,
        ...(requestId ? { requestId } : {}),
      }));
    } catch {
      // A closed or half-open socket must not crash a broadcast.
    }
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!this.allowDemoAuth) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      this.sendStatic(response, 'index.html', 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/client.js') {
      this.sendStatic(response, 'client.js', 'text/javascript; charset=utf-8');
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  }

  private sendStatic(response: ServerResponse, file: string, contentType: string): void {
    try {
      response.writeHead(200, { 'content-type': contentType });
      response.end(readFileSync(join(publicDirectory, file)));
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isApiServerOptions(
  value: TournamentService | ApiServerOptions | undefined,
): value is ApiServerOptions {
  return typeof value === 'object' && value !== null && !(value instanceof TournamentService);
}

function toServerEconomics(
  value: EconomicsStore | MockEconomics | undefined,
  allowDemoAuth: boolean,
): EconomicsStore {
  if (!value) return new InMemoryEconomicsStore(new MockEconomics({ devFaucet: allowDemoAuth }));
  if (value instanceof MockEconomics) return new InMemoryEconomicsStore(value);
  return value;
}

function extractRequestId(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      'requestId' in value &&
      typeof value.requestId === 'string'
    ) {
      return value.requestId;
    }
  } catch {
    // Parsing errors are returned as uncorrelated protocol errors.
  }
  return undefined;
}

export async function createApiServer(options: ApiServerOptions = {}): Promise<ApiServer> {
  return ApiServer.create(options);
}

if (require.main === module) {
  void createApiServer()
    .then(server => server.listen(Number(process.env.PORT ?? 3000)).then(port => {
      console.log(`PokeArena API listening on http://${server.bindHost}:${port}`);
    }))
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
