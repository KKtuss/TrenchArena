import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';

import { getRuleset, inspectTeam, isRulesetId, searchTeamHits, sliceTeamText, validateRulesetTeam } from '@pokearena/battle-engine';
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
  TOURNAMENT_BURN_FEE_ATOMS,
  uuidToBytes,
  type ArenaChainClient,
} from '@pokearena/solana-client';

import {
  previewCasual,
  previewTournament,
  recoverDurableState,
  RecoveryFailedError,
  type ChainIntentRow,
  type EconomicsStore,
  type PayoutResult,
  type Pool,
  type PostgresChainStore,
} from '@pokearena/db';

import { CASUAL_SELECTION_MS, CASUAL_START_COUNTDOWN_MS, CasualRoomService } from './casual-service';
import { getGenerationPreset } from './generation-presets';
import { casualFightEntry, pageFightHistory, tournamentFightEntry, type FightHistoryCursor } from './fight-history';
import { pickLiveFight, spectatorBattleView, spectatorEvents, type LiveFight } from './live-fights';
import { assessDepositEscrow, ChainEconomyService, depositEscrowFollowUp } from './chain-economy';
import {
  createPlayTokenEligibilityService,
  type PlayTokenCheckResult,
  type PlayTokenEligibilityService,
} from './play-token';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from './demo-teams';
import {
  connectPostgresEconomics,
  EconomicsUnavailableError,
  isPostgresEconomicsRequired,
  resolveEconomicsBackend,
} from './economics-runtime';
import { InMemoryEconomicsStore } from './memory-economics-store';
import {
  DEFAULT_DEV_BALANCE_POKE,
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
  type TxIntentPayload,
  type TournamentSummary,
  type TournamentSelectionView,
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
  isDevFaucetEnabled,
  isDemoPlayerId,
  isSolanaAddress,
  type AuthChallenge,
  verifySolanaSignature,
} from './wallet-auth';

export interface ApiServerOptions {
  /** Defaults to POKEARENA_ALLOW_DEMO_AUTH, which is off unless set true. */
  allowDemoAuth?: boolean;
  /** Local-only test override for tournament schedule and finalization gates. */
  localTestMode?: boolean;
  /** Defaults to POKEARENA_DEV_FAUCET (or demo auth). Tops wallets to DEFAULT_DEV_BALANCE_POKE. */
  devFaucet?: boolean;
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
  /** Passed through to casual battles. Defaults to the service timeout. */
  matchTimeoutMs?: number;
  economics?: EconomicsStore;
  casual?: CasualRoomService;
  tournaments?: TournamentService;
  tournamentRepository?: AsyncTournamentRepository;
  chainStore?: PostgresChainStore | null;
  chainEconomy?: ChainEconomyService;
  /** Injected holding checker. Defaults to the Jupiter-backed service. */
  playToken?: PlayTokenEligibilityService;
  /**
   * Enables POST/GET /dev/token-holding. Forced off when nodeEnv is production.
   * Defaults to PLAY_TOKEN_ELIGIBILITY_DEBUG.
   */
  playTokenDebug?: boolean;
  /** Overrides NODE_ENV for the debug-route guard. */
  nodeEnv?: string;
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

type TournamentSelectionState = {
  round: number;
  presetId: string;
  presetName: string;
  pokemon: TournamentSelectionView['pokemon'];
  selectionEndsAt: number;
  picks: Map<string, { slots: number[]; confirmed: boolean }>;
};

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
  private readonly solFundingJobs = new Map<string, Promise<TxIntentPayload | undefined>>();
  private readonly solReconciliationJobs = new Map<string, Promise<boolean>>();
  private readonly depositEscrowChecks = new Set<string>();
  private readonly pendingMatchBroadcasts = new Set<string>();
  private readonly pendingChallenges = new Map<string, StoredChallenge>();
  private readonly challengeByConnection = new Map<ClientConnection, string>();
  private readonly consumedNonces = new Map<string, number>();
  private readonly sessionsByPlayer = new Map<string, ClientConnection>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly trainers = new TrainerDirectory();
  private lastAuthenticatedPlayerId: string | null = null;
  private readonly allowDemoAuth: boolean;
  private readonly localTestMode: boolean;
  private readonly devFaucet: boolean;
  private readonly playToken: PlayTokenEligibilityService;
  private readonly playTokenDebug: boolean;
  private readonly nodeEnv: string;
  private readonly disconnectGraceMs: number;
  private readonly network: NetworkPolicy;
  private readonly rateLimiter: ProtocolRateLimiter;
  private readonly challengeCleanupTimer: NodeJS.Timeout;
  private readonly finalizationTimer: NodeJS.Timeout;
  private readonly sealingTournaments = new Set<string>();
  private readonly tournamentSelections = new Map<string, TournamentSelectionState>();
  private readonly tournamentSelectionTimers = new Map<string, NodeJS.Timeout>();
  private readonly startingTournamentMatches = new Set<string>();
  private readonly tournamentMutationLocks = new Map<string, Promise<void>>();
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
      this.localTestMode = options.localTestMode ?? envFlag(process.env.POKEARENA_LOCAL_TEST_MODE);
      this.devFaucet = options.devFaucet ?? (this.allowDemoAuth || isDevFaucetEnabled());
      this.disconnectGraceMs = options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
      injectedTournaments = options.tournaments;
      economics = options.economics ?? economics;
      casual = options.casual ?? casual;
    } else {
      this.allowDemoAuth = isDemoAuthEnabled();
      this.localTestMode = envFlag(process.env.POKEARENA_LOCAL_TEST_MODE);
      this.devFaucet = this.allowDemoAuth || isDevFaucetEnabled();
      this.disconnectGraceMs = DEFAULT_DISCONNECT_GRACE_MS;
      injectedTournaments = tournamentsOrOptions;
    }
    this.network = resolveNetworkPolicy(options);
    this.bindHost = this.network.bindHost;
    this.rateLimiter = new ProtocolRateLimiter(resolveRateLimitConfig(options.rateLimits));
    this.nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
    if (
      this.nodeEnv === 'production'
      && (this.allowDemoAuth || this.localTestMode || this.devFaucet)
    ) {
      throw new Error(
        'Demo auth, local test mode, and the development faucet must be disabled in production.',
      );
    }
    if (this.network.originMode === 'strict' && this.network.allowedOrigins.length === 0) {
      throw new Error('POKEARENA_ALLOWED_ORIGINS is required when origin validation is strict.');
    }
    if (!economics && isPostgresEconomicsRequired()) {
      throw new Error(
        'PostgreSQL economics is required. Use createApiServer(). In-memory economics is not used as a fallback.',
      );
    }
    this.economics = toServerEconomics(economics, this.devFaucet);
    const repository = options.tournamentRepository
      ?? new InMemoryAsyncTournamentRepository(undefined, this.economics);
    if (!injectedTournaments) {
      assertTournamentBackendMatchesEconomics(this.economics, repository);
    }
    this.tournaments = injectedTournaments ?? new TournamentService({ repository });
    this.chainEconomy = options.chainEconomy
      ?? new ChainEconomyService({ chainStore: options.chainStore ?? null });
    this.playTokenDebug = options.playTokenDebug ?? envFlag(process.env.PLAY_TOKEN_ELIGIBILITY_DEBUG);
    this.playToken = options.playToken ?? createPlayTokenEligibilityService({
      env: process.env,
      connection: this.chainEconomy.client?.connection ?? null,
    });
    this.casual = casual ?? new CasualRoomService({
      economics: this.economics,
      allowDemoAuth: this.allowDemoAuth,
      countdownMs: options.countdownMs ?? CASUAL_START_COUNTDOWN_MS,
      ...(options.matchTimeoutMs !== undefined ? { matchTimeoutMs: options.matchTimeoutMs } : {}),
      ...(this.chainEconomy.enabled
        ? {
            chainSettlement: {
              settle: input => this.chainEconomy.settleCasual(input),
              refund: (roomId, creatorId, opponentId) => (
                this.chainEconomy.refundCasual(roomId, creatorId, opponentId)
              ),
              depositStillLive: roomId => this.chainEconomy.depositStillLive(roomId),
            },
          }
        : {}),
    });
    this.chainEconomy.setSolDepositResolved((intent, outcome) => {
      if (outcome.status !== 'confirmed' || intent.kind !== 'sol_wager_deposit' || !intent.roomId) return;
      return this.applyConfirmedSolDeposit(intent, outcome.signature);
    });
    void this.chainEconomy.resumePendingDeposits();
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
    this.finalizationTimer = setInterval(() => {
      void this.sealDueFinalizations();
    }, 1000);
    this.finalizationTimer.unref?.();
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
    const chainEconomy = new ChainEconomyService({ chainStore: chain });
    try {
      await recoverDurableState({
        economics: store,
        tournaments,
        recoverSolCasualRoom: async room => {
          if (!chainEconomy.enabled) {
            throw new Error(`SOL room ${room.id} cannot be recovered while chain economy is disabled.`);
          }
          await chainEconomy.recoverCasualRoom(room, store);
        },
      });
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
      chainEconomy,
    });
    server.attachEconomicsPool(pool);
    await server.restoreDurableCasualRooms(store);
    return server;
  }

  private async restoreDurableCasualRooms(store: EconomicsStore): Promise<void> {
    for (const room of await store.listCasualRooms()) {
      let deposits: { creator?: boolean; opponent?: boolean } | undefined;
      if (room.rail === 'sol_chain' && this.chainEconomy.client) {
        try {
          const state = await this.chainEconomy.client.getMatchEscrowState(uuidToBytes(room.id));
          deposits = {
            creator: state.creatorDeposited,
            opponent: state.opponentDeposited,
          };
        } catch {
          // A missing or temporarily unavailable escrow remains represented by
          // the durable room; boot recovery owns any refund decision.
        }
      }
      this.casual.restoreRoom(room, deposits);
    }
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
    clearInterval(this.finalizationTimer);
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
    this.send(connection, this.readyMessage(''));

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
      this.send(connection, this.readyMessage(message.playerId), message.requestId);
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
      this.lastAuthenticatedPlayerId = message.address;
      if (this.devFaucet) {
        await this.topUpDevBalance(message.address);
      }
      this.send(connection, { type: 'auth.verified', playerId: message.address }, message.requestId);
      this.send(connection, this.readyMessage(message.address), message.requestId);
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
        if (!this.chainEconomy.pokeConfigured) {
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
            chainEconomyEnabled: this.chainEconomy.enabled,
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
          ...(message.signedTransaction ? { signedTransaction: message.signedTransaction } : {}),
        });
        this.send(connection, {
          type: 'tx.update',
          intentId: message.intentId,
          status: result.status,
          signature: message.signature,
          ...(result.error ? { error: result.error } : {}),
        }, message.requestId);
        if (result.status === 'confirmed' && intent.kind === 'poke_entry_deposit') {
          try {
            if (!intent.tournamentId) throw new Error('Tournament payment intent is missing its tournament.');
            await this.withTournamentMutationLock(intent.tournamentId, () => (
              this.tournaments.markBurnFeePaid(
                intent.tournamentId as TournamentId,
                playerId as TournamentPlayerId,
              )
            ));
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
        if (result.status === 'confirmed' && intent.kind === 'sol_wager_deposit' && intent.roomId) {
          await this.applyConfirmedSolDeposit(intent, message.signature);
        } else if (intent.kind === 'sol_wager_deposit') {
          console.info('[pokearena-deposit]', {
            signature: message.signature,
            intentId: intent.id,
            roomId: intent.roomId,
            lobby: result.status,
            source: 'signature-status',
          });
        }
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.create': {
        this.rateLimiter.take(this.rateLimiter.casualCreate, `player:${playerId}:casual.create`);
        const stake = message.stake ?? 'mock';
        if (stake === 'real') {
          if (!this.chainEconomy.enabled) {
            throw new Error('Real stake is unavailable. Chain economy is not enabled on this server.');
          }
          if (this.chainEconomy.pokeConfigured) {
            await this.chainEconomy.assertCanPlay(playerId);
          }
          const lamports = message.collateralLamports ?? message.collateral;
          if (!Number.isSafeInteger(lamports) || lamports <= 0) {
            throw new Error('Real stake must be a positive lamport amount.');
          }
          const room = await this.casual.createRoom({
            creatorId: playerId,
            roomType: message.roomType,
            battleSize: message.battleSize,
            collateral: lamports,
            invitedPlayerId: message.invitedPlayerId,
            rail: 'sol_chain',
            ruleset: message.ruleset ?? 'casual',
          });
          connection.casualRoomIds.add(room.id);
          this.ensureCasualSubscription(room.id);
          const intent = room.rail === 'sol_chain'
            ? await this.beginSolFunding(room.id, false)
            : undefined;
          this.send(connection, {
            type: 'casual.created',
            room: this.casual.getRoom(room.id, playerId),
            ...(intent ? { intent } : {}),
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
        void this.reconcileSolRoomsForPlayer(playerId);
        this.send(connection, {
          type: 'casual.list',
          rooms: this.casual.listOpenRooms(playerId),
          recentResults: this.casual.listRecentResults(10, playerId),
        }, message.requestId);
        return;
      case 'history.list': {
        const cursor: FightHistoryCursor | undefined = message.beforeCompletedAt !== undefined && message.beforeId
          ? { completedAt: message.beforeCompletedAt, id: message.beforeId }
          : undefined;
        const page = await this.fightHistory(playerId, message.limit ?? 20, cursor);
        this.send(connection, { type: 'history.list', ...page }, message.requestId);
        return;
      }
      case 'casual.preview':
        this.send(connection, {
          type: 'casual.preview',
          economics: message.stake === 'real' && this.chainEconomy.enabled
            ? { ...this.chainEconomy.previewCasual(message.collateral) }
            : previewCasual(message.collateral),
        }, message.requestId);
        return;
      case 'casual.accept': {
        const existing = this.casual.getRoom(message.roomId);
        if (existing.rail === 'sol_chain') {
          if (!this.chainEconomy.enabled) {
            throw new Error('Real stake is unavailable. Chain economy is not enabled on this server.');
          }
          if (this.chainEconomy.pokeConfigured) {
            await this.chainEconomy.assertCanPlay(playerId);
          }
        }
        let room = await this.casual.acceptRoom(message.roomId, playerId);
        connection.casualRoomIds.add(room.id);
        this.ensureCasualSubscription(room.id);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        if (room.rail === 'sol_chain') {
          await this.beginSolFunding(room.id);
        }
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.stake': {
        const room = this.casual.getRoom(message.roomId, playerId);
        if (room.rail !== 'sol_chain') {
          throw new Error('This challenge is a mock fight. No stake can be locked.');
        }
        if (!this.chainEconomy.enabled) {
          throw new Error('Real stake is unavailable. Chain economy is not enabled on this server.');
        }
        if (room.status === 'cancelled' || room.status === 'completed' || room.status === 'battling') {
          throw new Error('This match can no longer lock a stake.');
        }
        const side = room.creatorId === playerId ? 0 : room.opponentId === playerId ? 1 : null;
        if (side === null) throw new Error('Accept the challenge before locking a stake.');
        if (side === 0 && room.deposits?.creator) throw new Error('Your stake is already locked.');
        if (side === 1 && room.deposits?.opponent) throw new Error('Your stake is already locked.');
        await this.assertSolStakeAvailable(playerId, room.collateral);
        const intent = await this.chainEconomy.createSolWagerDepositIntent({
          roomId: room.id,
          playerId,
          side,
          collateralLamports: room.collateral,
        });
        if (intent.serializedTx.length) {
          this.send(connection, {
            type: 'tx.intent',
            intent: {
              intentId: intent.intentId,
              serializedTx: intent.serializedTx,
              kind: 'sol_wager_deposit',
              economics: intent.economics,
            },
          }, message.requestId);
        } else {
          this.casual.markSolDeposit(room.id, side === 0 ? 'creator' : 'opponent');
          const current = this.casual.getRoom(room.id, playerId);
          this.send(connection, { type: 'casual.state', room: current }, message.requestId);
          this.broadcastCasual(room.id);
        }
        return;
      }
      case 'casual.ready': {
        const room = this.casual.setReady(message.roomId, playerId, message.ready, message.team);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        if (
          room.rail === 'sol_chain'
          && room.status === 'ready'
          && room.opponentId
        ) {
          await this.beginSolFunding(room.id);
        }
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
        void this.reconcileSolRoom(room.id);
        const current = this.casual.getRoom(room.id);
        if (
          current.rail === 'sol_chain'
          && (
            (!current.deposits?.creator && current.creatorId === playerId)
            || (current.deposits?.creator && current.opponentId === playerId && !current.deposits?.opponent)
          )
        ) {
          await this.beginSolFunding(current.id);
        }
        return;
      }
      case 'tournament.create': {
        this.rateLimiter.take(this.rateLimiter.tournamentCreate, `player:${playerId}:tournament.create`);
        // Chain cups use quoted ~$5 POKE atoms (not host-chosen POKE). Legacy path keeps entryFee.
        let entryFee = message.entryFee ?? DEFAULT_TOURNAMENT_ENTRY_POKE;
        let chainEntryAtoms: number | undefined;
        let chainQuoteId: string | undefined;
        if (this.chainEconomy.pokeConfigured) {
          if ((message.maxPlayers ?? 32) !== 32) {
            throw new Error('Chain tournaments use a fixed 32-player field.');
          }
          const quote = this.chainEconomy.resolveQuote();
          await this.chainEconomy.persistQuote(quote);
          chainEntryAtoms = TOURNAMENT_BURN_FEE_ATOMS;
          chainQuoteId = quote.quoteId;
          entryFee = 0;
        }
        const rulesetId = message.ruleset ?? 'gen9ou';
        if (!isRulesetId(rulesetId)) throw new Error('Unknown tournament ruleset.');
        const tournament = await this.tournaments.createTournament({
          title: message.title ?? 'PokeArena Open',
          format: 'gen9ou',
          ruleset: rulesetId,
          maxPlayers: this.chainEconomy.pokeConfigured ? 32 : (message.maxPlayers ?? 4),
          matchTimeoutMs: 300_000,
          hostId: playerId,
          entryFee,
          ...(this.chainEconomy.pokeConfigured
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
      case 'tournament.payBurnFee': {
        if (!this.chainEconomy.pokeConfigured) {
          throw new Error('POKE economy is not configured. POKEARENA_POKE_MINT is unset.');
        }
        const tournamentId = message.tournamentId as TournamentId;
        const tournament = await this.tournaments.getTournament(tournamentId);
        if (
          tournament.rail !== 'sol_chain'
          || tournament.status !== 'registration'
          || tournament.finalizesAt === undefined
        ) {
          throw new Error('The POKE burn-fee payment window is not open.');
        }
        const player = tournament.players.find(candidate => candidate.id === playerId);
        if (!player || player.status !== 'registered') {
          throw new Error('Only a registered tournament player can pay the burn fee.');
        }
        if (player.burnFeePaid) {
          this.send(connection, {
            type: 'tournament.state',
            tournament: await this.serializeTournament(tournamentId, playerId),
          }, message.requestId);
          return;
        }
        const entry = await this.chainEconomy.createPokeEntryDepositIntent({
          tournamentId,
          playerId,
          ...(message.playerPokeAta ? { playerPokeAta: message.playerPokeAta } : {}),
          team: player.team,
          entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
          ...(tournament.entryQuoteId ? { quoteId: tournament.entryQuoteId } : {}),
          fixedBurnFee: true,
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
        return;
      }
      case 'tournament.join': {
        const tournamentId = message.tournamentId as TournamentId;
        const targetTournament = await this.tournaments.getTournament(tournamentId);
        if (this.chainEconomy.pokeConfigured && targetTournament.rail === 'sol_chain' && targetTournament.maxPlayers !== 32) {
          throw new Error('Chain tournaments must use a 32-player field.');
        }
        const ruleset = getRuleset(targetTournament.ruleset);
        const team = ruleset.teamMode === 'preset-6-choose-3'
          ? this.presetTeamForJoin(ruleset.presetId)
          : this.customTeamForJoin(playerId, message.team, ruleset.id);
        validateRulesetTeam(team, ruleset.id);
        if (this.chainEconomy.pokeConfigured && targetTournament.rail === 'sol_chain') {
          await this.chainEconomy.assertCanPlay(playerId);
        }
        await this.tournaments.registerPlayer(tournamentId, {
          playerId,
          displayName: playerId,
          team,
        });
        await this.maybeBeginFinalization(tournamentId);
        connection.tournamentIds.add(tournamentId);
        this.send(connection, {
          type: 'tournament.state',
          tournament: await this.serializeTournament(tournamentId, playerId),
        }, message.requestId);
        await this.broadcastTournament(tournamentId);
        void this.broadcastArenaSnapshots();
        return;
      }
      case 'tournament.select': {
        const tournamentMatchId = message.matchId as TournamentMatchId;
        await this.submitTournamentSelection(
          tournamentMatchId,
          playerId,
          message.slots,
          message.confirm === true,
        );
        connection.matchIds.add(tournamentMatchId);
        this.ensureMatchSubscription(tournamentMatchId);
        await this.sendTournamentMatchAsync(connection, tournamentMatchId, 'match.subscribed', message.requestId);
        this.broadcastTournamentMatch(tournamentMatchId);
        return;
      }
      case 'tournament.updateTeam': {
        const tournamentId = message.tournamentId as TournamentId;
        const tournament = await this.tournaments.getTournament(tournamentId);
        const ruleset = getRuleset(tournament.ruleset);
        if (ruleset.teamMode !== 'custom') {
          throw new Error('This tournament uses the shared preset, not a custom team.');
        }
        validateRulesetTeam(message.team, ruleset.id);
        await this.tournaments.updateRegisteredTeam(tournamentId, playerId, message.team);
        this.send(connection, {
          type: 'tournament.state',
          tournament: await this.serializeTournament(tournamentId, playerId),
        }, message.requestId);
        await this.broadcastTournament(tournamentId);
        return;
      }
      case 'tournament.lockTeam': {
        const tournamentId = message.tournamentId as TournamentId;
        await this.tournaments.lockRegisteredTeam(tournamentId, playerId);
        this.send(connection, {
          type: 'tournament.state',
          tournament: await this.serializeTournament(tournamentId, playerId),
        }, message.requestId);
        await this.broadcastTournament(tournamentId);
        return;
      }
      case 'tournament.leave': {
        const tournamentId = message.tournamentId as TournamentId;
        const tournament = await this.tournaments.getTournament(tournamentId);
        if (tournament.finalizesAt !== undefined && Date.now() >= tournament.finalizesAt) {
          throw new Error('Team finalization has already closed.');
        }
        const participant = tournament.players.find(candidate => candidate.id === playerId);
        if (
          tournament.rail === 'sol_chain'
          && participant?.status === 'registered'
          && tournament.finalizesAt !== undefined
        ) {
          throw new Error('Players cannot leave while the burn-fee roster is finalizing.');
        }
        if (tournament.rail === 'sol_chain' && participant?.burnFeePaid) {
          await this.refundChainBurnFee(tournamentId, playerId);
        }
        await this.tournaments.withdrawPlayer(tournamentId, playerId);
        await this.releaseTournamentEntry(tournament, playerId);
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
        if (!this.localTestMode && beforeStart.finalizesAt !== undefined && Date.now() < beforeStart.finalizesAt) {
          throw new Error('Team finalization is still open.');
        }
        if (this.chainEconomy.pokeConfigured) {
          if (beforeStart.rail !== 'sol_chain' || beforeStart.finalizesAt === undefined) {
            throw new Error('Chain tournaments start only after the full payment window has closed.');
          }
          await this.sealFinalization(tournamentId);
          const current = await this.tournaments.getTournament(tournamentId);
          this.send(connection, {
            type: 'tournament.state',
            tournament: await this.serializeTournament(current.id, playerId),
          }, message.requestId);
          return;
        }
        const tournament = await this.tournaments.startTournament(tournamentId, {
          ignoreFinalization: this.localTestMode,
        });
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
        if (tournament.rail === 'sol_chain') {
          await this.cancelChainTournament(tournamentId);
          this.send(connection, {
            type: 'tournament.state',
            tournament: await this.serializeTournament(tournamentId, playerId),
          }, message.requestId);
          this.broadcastTournament(tournamentId);
          void this.broadcastArenaSnapshots();
          return;
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
              const chargeFee = (casualRoom.ruleset ?? 'casual') !== 'casual' && this.chainEconomy.enabled;
              await this.startChargedCasualBattle(casualRoom.id, playerId, chargeFee);
            }
          } else if (casualRoom.status === 'drafting') {
            const bothPicked = Boolean(
              casualRoom.teamPreview?.length === 2
              && casualRoom.teamPreview.every(preview => preview.confirmed),
            );
            if (bothPicked) {
              await this.startChargedCasualBattle(casualRoom.id, playerId, this.chainEconomy.enabled);
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
        const selection = await this.ensureTournamentSelection(tournamentMatchId);
        if (!selection && (view.match.status === 'ready' || view.match.status === 'tied' || view.match.status === 'interrupted')) {
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
        if (message.ruleset && !isRulesetId(message.ruleset)) throw new Error('Unknown ruleset.');
        this.send(connection, {
          type: 'team.inspect',
          inspection: inspectTeam(message.team, 'gen9ou', message.ruleset),
        }, message.requestId);
        return;
      case 'team.search': {
        this.rateLimiter.take(this.rateLimiter.teamSearch, `player:${playerId}:team.search`);
        if (message.ruleset && !isRulesetId(message.ruleset)) throw new Error('Unknown ruleset.');
        const found = searchTeamHits(message.kind, message.query, message.species, message.ruleset);
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

  private async assertSolStakeAvailable(playerId: string, lamports: number): Promise<void> {
    if (!this.chainEconomy.client) {
      throw new Error('Real stake is unavailable. The chain client is not configured.');
    }
    const { PublicKey } = await import('@solana/web3.js');
    const free = await this.chainEconomy.client.getSolBalance(new PublicKey(playerId));
    const needed = BigInt(lamports) + 10_000n;
    if (free < needed) {
      throw new Error('Insufficient SOL balance for this stake.');
    }
  }

  private readyMessage(playerId: string): { type: 'ready'; playerId: string; chainEconomyEnabled: boolean } {
    return {
      type: 'ready',
      playerId,
      chainEconomyEnabled: this.chainEconomy.enabled,
    };
  }

  private async buildArenaSnapshot(playerId: string, reconcile = true): Promise<ArenaSnapshot> {
    if (reconcile) void this.reconcileSolRoomsForPlayer(playerId);
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
      const passport = this.chainEconomy.pokeConfigured
        ? await this.chainEconomy.getPassport(playerId)
        : undefined;
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

  private async applyConfirmedSolDeposit(intent: ChainIntentRow, signature: string): Promise<void> {
    if (!intent.roomId) return;
    const side = Number(intent.metadata?.side) === 1 ? 'opponent' : 'creator';
    try {
      this.casual.markSolDeposit(intent.roomId, side);
      this.broadcastCasual(intent.roomId);
      console.info('[pokearena-deposit]', {
        signature,
        intentId: intent.id,
        roomId: intent.roomId,
        lobby: 'opened',
        source: 'signature-status',
      });
      this.scheduleDepositEscrowCheck(intent.roomId, side, signature);
      const room = this.casual.getRoom(intent.roomId);
      if (room.rail === 'sol_chain' && room.deposits?.creator && room.deposits.opponent) {
        await this.casual.startBattle(intent.roomId, room.creatorId);
        this.broadcastCasual(intent.roomId);
      } else if (room.rail === 'sol_chain' && side === 'creator') {
        await this.beginSolFunding(intent.roomId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[pokearena-casual]', {
        operation: 'start_after_deposit',
        roomId: intent.roomId,
        message,
      });
    }
  }

  /**
   * One confirmed escrow read after the lobby is already open. A missing
   * account or a rate limit retries once, then stops. It never closes the lobby.
   */
  private scheduleDepositEscrowCheck(
    roomId: string,
    side: 'creator' | 'opponent',
    signature: string,
  ): void {
    const key = `${roomId}:${side}`;
    if (this.depositEscrowChecks.has(key)) return;
    this.depositEscrowChecks.add(key);
    void this.readDepositEscrow(roomId, side, signature, 0).finally(() => {
      this.depositEscrowChecks.delete(key);
    });
  }

  private async readDepositEscrow(
    roomId: string,
    side: 'creator' | 'opponent',
    signature: string,
    attempt: number,
  ): Promise<void> {
    const client = this.chainEconomy.client;
    if (!client) return;
    let room;
    try {
      room = this.casual.getRoom(roomId);
    } catch {
      return;
    }
    if (room.rail !== 'sol_chain') return;
    try {
      const state = await this.readEscrowOnce(roomId);
      const verdict = assessDepositEscrow({
        side,
        roomCreator: room.creatorId,
        ...(room.opponentId ? { roomOpponent: room.opponentId } : {}),
        roomCollateral: room.collateral,
        state,
      });
      console.info('[pokearena-deposit]', {
        signature,
        roomId,
        side,
        attempt,
        lobby: 'opened',
        source: 'signature-status',
        escrow: verdict,
      });
      if (depositEscrowFollowUp(verdict, attempt) === 'revoke') {
        this.casual.revokeUnmatchedSolDeposit(
          roomId,
          side,
          'Escrow account contradicts the confirmed deposit.',
        );
        this.broadcastCasual(roomId);
        return;
      }
      if (depositEscrowFollowUp(verdict, attempt) === 'retry') {
        await waitForEscrowRetry();
        return this.readDepositEscrow(roomId, side, signature, 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.info('[pokearena-deposit]', {
        signature,
        roomId,
        side,
        attempt,
        lobby: 'opened',
        source: 'signature-status',
        escrow: 'unread',
        reason: message,
      });
      if (depositEscrowFollowUp('unread', attempt) === 'retry') {
        await waitForEscrowRetry();
        return this.readDepositEscrow(roomId, side, signature, 1);
      }
    }
  }

  private readEscrowOnce(roomId: string) {
    const client = this.chainEconomy.client;
    if (!client) throw new Error('Chain client is required.');
    if (client.getMatchEscrowStateOnce) {
      return client.getMatchEscrowStateOnce(uuidToBytes(roomId), 'confirmed');
    }
    return client.getMatchEscrowState(uuidToBytes(roomId), 'confirmed');
  }

  /**
   * The wallet confirmation callback is not the source of truth for a SOL
   * wager. A wallet can land a transaction while the browser disconnects
   * before tx.confirm reaches this process. Re-read the escrow whenever a
   * player opens a room or refreshes the arena so cached room state converges
   * to the confirmed on-chain deposit flags.
   */
  private async reconcileSolRoomsForPlayer(playerId: string): Promise<void> {
    const rooms = this.casual.listRoomsForPlayer(playerId)
      .filter(room => room.status !== 'cancelled' && room.status !== 'completed');
    await Promise.all(rooms.map(room => this.reconcileSolRoom(room.id)));
  }

  private async reconcileSolRoom(roomId: string): Promise<boolean> {
    const existing = this.solReconciliationJobs.get(roomId);
    if (existing) return existing;

    const job = this.reconcileSolRoomOnce(roomId).finally(() => {
      this.solReconciliationJobs.delete(roomId);
    });
    this.solReconciliationJobs.set(roomId, job);
    return job;
  }

  private async reconcileSolRoomOnce(roomId: string): Promise<boolean> {
    if (!this.chainEconomy.enabled || !this.chainEconomy.client) return false;
    let room;
    try {
      room = this.casual.getRoom(roomId);
    } catch {
      return false;
    }
    if (room.rail !== 'sol_chain') return false;
    if (room.status === 'cancelled' || room.status === 'completed') return false;

    let state: Awaited<ReturnType<ArenaChainClient['getMatchEscrowState']>>;
    try {
      state = await this.readEscrowOnce(roomId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found/i.test(message)) {
        console.warn('[pokearena-reconciliation]', {
          operation: 'read_match_escrow',
          roomId,
          message,
        });
      }
      // No escrow yet is normal for a newly created or cancelled room.
      return false;
    }

    let changed = false;
    const creatorEscrow = assessDepositEscrow({
      side: 'creator',
      roomCreator: room.creatorId,
      ...(room.opponentId ? { roomOpponent: room.opponentId } : {}),
      roomCollateral: room.collateral,
      state,
    });
    const opponentEscrow = assessDepositEscrow({
      side: 'opponent',
      roomCreator: room.creatorId,
      ...(room.opponentId ? { roomOpponent: room.opponentId } : {}),
      roomCollateral: room.collateral,
      state,
    });
    if (creatorEscrow === 'mismatch' && room.deposits?.creator) {
      this.casual.revokeUnmatchedSolDeposit(roomId, 'creator', 'Escrow account contradicts the creator deposit.');
      changed = true;
    } else if (creatorEscrow === 'matched' && !room.deposits?.creator) {
      await this.chainEconomy.adoptEscrowDeposit(roomId, 'creator');
      this.casual.markSolDeposit(roomId, 'creator');
      changed = true;
    }
    if (opponentEscrow === 'mismatch' && room.deposits?.opponent) {
      this.casual.revokeUnmatchedSolDeposit(roomId, 'opponent', 'Escrow account contradicts the opponent deposit.');
      changed = true;
    } else if (opponentEscrow === 'matched' && !room.deposits?.opponent) {
      await this.chainEconomy.adoptEscrowDeposit(roomId, 'opponent');
      this.casual.markSolDeposit(roomId, 'opponent');
      changed = true;
    }

    const current = this.casual.getRoom(roomId);
    if (
      current.deposits?.creator
      && current.deposits.opponent
      && current.opponentId
      && current.status !== 'battling'
      && current.status !== 'completed'
      && current.status !== 'cancelled'
    ) {
      try {
        if (current.rail === 'sol_chain') {
          await this.startChargedCasualBattle(roomId, current.creatorId, false);
        } else {
          await this.casual.startBattle(roomId, current.creatorId);
        }
        changed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[pokearena-casual]', {
          operation: 'start_after_reconciliation',
          roomId,
          message,
        });
      }
    }
    if (changed) {
      this.broadcastCasual(roomId);
      void this.broadcastArenaSnapshots(false);
    }
    return changed;
  }

  private async fightHistory(playerId: string, limit: number, before?: FightHistoryCursor) {
    const casual = this.casual.listCompletedFightRecords(playerId)
      .map(record => casualFightEntry(record, playerId));
    const cups = await this.tournamentHistory(playerId);
    return pageFightHistory([...casual, ...cups], limit, before);
  }

  private async tournamentHistory(playerId: string) {
    const tournaments = await this.tournaments.listTournaments();
    const entries = [];
    for (const tournament of tournaments) {
      const playing = tournament.players.some(player => player.id === playerId && player.status === 'registered');
      if (!playing) continue;
      const matches = await this.tournaments.getBracket(tournament.id);
      const mine = matches.filter(match => (
        (match.player1 === playerId || match.player2 === playerId)
        && (match.status === 'completed' || match.status === 'forfeited' || match.status === 'tied')
        && typeof match.completedAt === 'number'
      ));
      const last = [...mine].sort((a, b) => (
        b.round - a.round || (b.completedAt ?? 0) - (a.completedAt ?? 0)
      ))[0];
      const cupSettled = tournament.status === 'completed' && typeof tournament.winner === 'string';
      const symbol = tournament.rail === 'sol_chain' ? 'SOL' as const : 'POKE' as const;
      const prize = symbol === 'SOL'
        ? (tournament.prizeLamports ?? 0)
        : previewTournament(tournament.entryFee, tournament.players.length).prizePool;
      for (const match of mine) {
        const opponentId = match.player1 === playerId ? match.player2 : match.player1;
        if (!opponentId || match.completedAt === undefined) continue;
        if (match.status !== 'completed' && match.status !== 'forfeited' && match.status !== 'tied') continue;
        entries.push(tournamentFightEntry({
          playerId,
          matchId: match.id,
          tournamentId: tournament.id,
          opponentId,
          status: match.status,
          ...(match.winner ? { winnerId: match.winner } : {}),
          completedAt: match.completedAt,
          entryFee: symbol === 'SOL' ? (tournament.entryAtoms ?? tournament.entryFee) : tournament.entryFee,
          prize,
          symbol,
          carriesCupBalance: cupSettled && last?.id === match.id,
          playerWonCup: tournament.winner === playerId,
        }));
      }
    }
    return entries;
  }

  private async listTournamentSummaries(): Promise<TournamentSummary[]> {
    const tournaments = await this.tournaments.listTournaments();
    return tournaments.map(tournament => {
      const playerCount = tournament.players.filter(player => player.status === 'registered').length;
      return {
        id: tournament.id,
        title: tournament.title,
        format: tournament.format,
        ruleset: tournament.ruleset ?? 'gen9ou',
        createdAt: tournament.createdAt,
        ...(tournament.finalizesAt === undefined ? {} : { finalizesAt: tournament.finalizesAt }),
        maxPlayers: tournament.maxPlayers,
        status: tournament.status,
        playerCount,
        entryFee: tournament.entryFee,
        ...(tournament.rail ? { rail: tournament.rail } : {}),
        ...(tournament.entryAtoms !== undefined ? { entryAtoms: tournament.entryAtoms } : {}),
        ...(tournament.prizeLamports !== undefined ? { prizeLamports: tournament.prizeLamports } : {}),
        ...(tournament.rail === 'sol_chain'
          ? {
              burnFeeAtoms: TOURNAMENT_BURN_FEE_ATOMS,
              ...(tournament.prizeLamports !== undefined
                ? { prizeLamports: tournament.prizeLamports }
                : {}),
              ...(tournament.paymentEndsAt !== undefined
                ? { paymentEndsAt: tournament.paymentEndsAt }
                : {}),
            }
          : {}),
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

  private async maybeBeginFinalization(tournamentId: TournamentId): Promise<void> {
    const tournament = await this.tournaments.getTournament(tournamentId);
    const ruleset = getRuleset(tournament.ruleset);
    if (ruleset.teamMode !== 'custom' && tournament.rail !== 'sol_chain') return;
    const registered = tournament.players.filter(player => player.status === 'registered').length;
    if (registered !== tournament.maxPlayers || tournament.finalizesAt !== undefined) return;
    await this.tournaments.beginTeamFinalization(tournamentId);
  }

  private async sealDueFinalizations(): Promise<void> {
    if (this.shuttingDown) return;
    const now = Date.now();
    let due: TournamentId[] = [];
    try {
      due = (await this.tournaments.listTournaments())
        .filter(tournament => (
          tournament.status === 'registration'
          && tournament.finalizesAt !== undefined
          && tournament.finalizesAt <= now
        ))
        .map(tournament => tournament.id);
    } catch {
      return;
    }
    for (const tournamentId of due) {
      await this.sealFinalization(tournamentId);
    }
  }

  private async sealFinalization(tournamentId: TournamentId): Promise<void> {
    if (this.sealingTournaments.has(tournamentId)) return;
    this.sealingTournaments.add(tournamentId);
    try {
      let tournament = await this.tournaments.getTournament(tournamentId);
      if (
        tournament.status !== 'registration'
        || tournament.finalizesAt === undefined
        || tournament.finalizesAt > Date.now()
      ) return;
      const ruleset = getRuleset(tournament.ruleset);
      for (const player of tournament.players.filter(candidate => candidate.status === 'registered')) {
        try {
          validateRulesetTeam(player.team, ruleset.id);
          if (!player.teamLocked) await this.tournaments.lockRegisteredTeam(tournamentId, player.id);
        } catch {
          await this.tournaments.withdrawPlayer(tournamentId, player.id, { keepFinalization: true });
          if (tournament.rail === 'sol_chain' && player.burnFeePaid) {
            await this.refundChainBurnFee(tournamentId, player.id);
          } else {
            await this.releaseTournamentEntry(tournament, player.id);
          }
        }
      }
      tournament = await this.tournaments.getTournament(tournamentId);

      if (tournament.rail === 'sol_chain') {
        await this.finalizeChainTournament(tournamentId);
        return;
      }

      const registered = tournament.players.filter(player => player.status === 'registered');
      const count = registered.length;
      const playable = count >= 2 && (count & (count - 1)) === 0;
      if (!playable) {
        if (this.chainEconomy.pokeConfigured) {
          for (const player of registered) {
            const intent = await this.chainEconomy.getIntentByScope(
              'poke_entry_deposit',
              `${tournamentId}:${player.id}`,
            );
            if (intent?.status === 'confirmed') {
              await this.chainEconomy.refundPokeEntry({
                tournamentId,
                playerId: player.id,
                playerPokeAta: String(intent.metadata.playerPokeAta),
              });
            }
          }
        }
        for (const player of registered) await this.releaseTournamentEntry(tournament, player.id);
        await this.tournaments.cancelTournament(tournamentId);
        await this.broadcastTournament(tournamentId);
        return;
      }
      const started = await this.tournaments.startTournament(tournamentId);
      await this.startReadyMatches(started.id);
      await this.broadcastTournament(started.id);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    } finally {
      this.sealingTournaments.delete(tournamentId);
    }
  }

  private async releaseTournamentEntry(tournament: { id: string; rail?: string; entryFee: number }, playerId: string): Promise<void> {
    if (tournament.rail === 'sol_chain' || tournament.entryFee <= 0) return;
    await this.economics.release(`tournament:${tournament.id}:${playerId}`);
  }

  private async refundChainBurnFee(tournamentId: string, playerId: string): Promise<void> {
    const intent = await this.chainEconomy.getIntentByScope(
      'poke_entry_deposit',
      `${tournamentId}:${playerId}`,
    );
    if (intent?.status !== 'confirmed') return;
    await this.chainEconomy.refundPokeEntry({
      tournamentId,
      playerId,
      playerPokeAta: String(intent.metadata.playerPokeAta),
    });
  }

  private async refundChainBurnFees(tournament: {
    id: string;
    players: Array<{ id: string; status: string; burnFeePaid?: boolean }>;
  }): Promise<void> {
    for (const player of tournament.players) {
      if (player.status === 'registered' && player.burnFeePaid) {
        await this.refundChainBurnFee(tournament.id, player.id);
      }
    }
  }

  private async cancelChainTournament(tournamentId: TournamentId) {
    return this.withTournamentMutationLock(tournamentId, async () => {
      const tournament = await this.tournaments.getTournament(tournamentId);
      if (tournament.status !== 'registration') {
        throw new Error('Chain tournaments cannot be cancelled after roster finalization.');
      }
      if (tournament.finalizesAt !== undefined) {
        throw new Error('Chain tournament finalization has already begun.');
      }
      for (const participant of tournament.players.filter(candidate => candidate.status === 'registered')) {
        await this.refundChainBurnFee(tournamentId, participant.id);
      }
      return this.tournaments.cancelTournament(tournamentId);
    });
  }

  private async finalizeChainTournament(tournamentId: TournamentId): Promise<void> {
    await this.withTournamentMutationLock(tournamentId, async () => {
      const advanced = await this.tournaments.advanceBurnFeeWindow(tournamentId);
      if (advanced.promotedPlayerId) {
        await this.broadcastTournament(tournamentId);
        return;
      }
      if (!advanced.readyToFinalize) {
        await this.refundChainBurnFees(advanced.tournament);
        await this.tournaments.cancelTournament(tournamentId);
        await this.broadcastTournament(tournamentId);
        return;
      }
      const registered = advanced.tournament.players
        .filter(player => player.status === 'registered')
        .map(player => player.id);
      if (advanced.tournament.prizeLamports === undefined) {
        throw new Error('Chain tournament prize is not configured.');
      }
      await this.chainEconomy.lockTournament({
        tournamentId,
        playerIds: registered,
        prizeLamports: advanced.tournament.prizeLamports,
      });
      const started = await this.tournaments.startTournament(tournamentId);
      await this.startReadyMatches(started.id);
      await this.broadcastTournament(started.id);
    });
  }

  private async withTournamentMutationLock<T>(
    tournamentId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tournamentMutationLocks.get(tournamentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.tournamentMutationLocks.set(tournamentId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tournamentMutationLocks.get(tournamentId) === queued) {
        this.tournamentMutationLocks.delete(tournamentId);
      }
    }
  }

  private async serializeTournament(tournamentId: TournamentId, viewerId: string): Promise<unknown> {
    const tournament = await this.tournaments.getTournament(tournamentId);
    const playerCount = tournament.players.filter(player => player.status === 'registered').length;
    const ruleset = getRuleset(tournament.ruleset);
    return {
      ...publicTournamentForViewer(tournament, viewerId),
      ruleset: ruleset.id,
      hostId: tournament.hostId,
      bracket: await this.tournaments.getBracket(tournamentId),
      entryFee: tournament.entryFee,
      ...(tournament.rail ? { rail: tournament.rail } : {}),
      ...(tournament.entryAtoms !== undefined ? { entryAtoms: tournament.entryAtoms } : {}),
      ...(tournament.rail === 'sol_chain'
        ? {
            burnFeeAtoms: TOURNAMENT_BURN_FEE_ATOMS,
            ...(tournament.paymentEndsAt !== undefined
              ? { paymentEndsAt: tournament.paymentEndsAt }
              : {}),
          }
        : {}),
      economics: previewTournament(tournament.entryFee, Math.max(playerCount, 1)),
      payout: this.tournamentPayouts.get(tournamentId)
        ?? await this.economics.getSettlement(`tournament:${tournamentId}`),
    };
  }

  private customTeamForJoin(playerId: string, team: string | undefined, rulesetId: string): string {
    if (rulesetId !== 'gen9ou' && !team?.trim()) {
      throw new Error('Bring a team built for this format.');
    }
    return this.teamForTournamentJoin(playerId, team);
  }

  private presetTeamForJoin(presetId: string | undefined): string {
    if (!presetId) throw new Error('This tournament has no shared preset.');
    return getGenerationPreset(presetId).paste;
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
      const selection = await this.ensureTournamentSelection(match.id);
      if (selection) {
        this.ensureMatchSubscription(match.id);
        this.broadcastTournamentMatch(match.id);
      } else {
        await this.tournaments.startMatch(match.id);
        this.ensureMatchSubscription(match.id);
        this.broadcastTournamentMatch(match.id);
      }
    }
  }

  private async ensureTournamentSelection(
    matchId: TournamentMatchId,
  ): Promise<TournamentSelectionState | undefined> {
    const existing = this.tournamentSelections.get(matchId);
    if (existing) return existing;
    const view = await this.tournaments.getMatch(matchId);
    if (!view.match.player1 || !view.match.player2) return undefined;
    if (view.match.status !== 'ready' && view.match.status !== 'tied') return undefined;
    const tournament = await this.tournaments.getTournament(view.match.tournamentId);
    const ruleset = getRuleset(tournament.ruleset);
    if (ruleset.teamMode !== 'preset-6-choose-3' || !ruleset.presetId) return undefined;
    const preset = getGenerationPreset(ruleset.presetId);
    const state: TournamentSelectionState = {
      round: view.match.round,
      presetId: preset.id,
      presetName: `${preset.name} · Round ${view.match.round}`,
      pokemon: preset.pokemon.map(mon => ({
        ...mon,
        moves: [...mon.moves],
        types: [...mon.types],
      })),
      selectionEndsAt: Date.now() + CASUAL_SELECTION_MS,
      picks: new Map(),
    };
    this.tournamentSelections.set(matchId, state);
    const timer = setTimeout(() => {
      void this.sealTournamentSelection(matchId);
    }, CASUAL_SELECTION_MS);
    timer.unref?.();
    this.tournamentSelectionTimers.set(matchId, timer);
    return state;
  }

  private async submitTournamentSelection(
    matchId: TournamentMatchId,
    playerId: string,
    slots: number[],
    confirm: boolean,
  ): Promise<void> {
    const state = await this.ensureTournamentSelection(matchId);
    if (!state) throw new Error('This tournament fight is not waiting for a Pokémon selection.');
    const view = await this.tournaments.getMatch(matchId);
    if (view.match.player1 !== playerId && view.match.player2 !== playerId) {
      throw new Error('You are not a player in this tournament fight.');
    }
    if (Date.now() >= state.selectionEndsAt) {
      await this.sealTournamentSelection(matchId);
      return;
    }
    if (
      slots.length > 3
      || new Set(slots).size !== slots.length
      || slots.some(slot => slot < 0 || slot >= 6)
      || (confirm && slots.length !== 3)
    ) {
      throw new Error(confirm
        ? 'Choose exactly three different Pokémon from the shared six.'
        : 'Choose up to three different Pokémon from the shared six.');
    }
    const current = state.picks.get(playerId) ?? { slots: [], confirmed: false };
    if (current.confirmed) throw new Error('Your tournament selection is already locked.');
    current.slots = [...slots];
    current.confirmed = confirm;
    state.picks.set(playerId, current);
    if (state.picks.size >= 2 && [...state.picks.values()].every(pick => pick.confirmed)) {
      await this.startTournamentSelection(matchId, state);
    }
  }

  private async sealTournamentSelection(matchId: TournamentMatchId): Promise<void> {
    const state = this.tournamentSelections.get(matchId);
    if (!state || Date.now() < state.selectionEndsAt) return;
    const view = await this.tournaments.getMatch(matchId);
    const playerIds = [view.match.player1, view.match.player2]
      .filter((id): id is TournamentPlayerId => Boolean(id));
    for (const playerId of playerIds) {
      const current = state.picks.get(playerId) ?? { slots: [], confirmed: false };
      const slots = [...current.slots];
      for (let slot = 0; slots.length < 3 && slot < 6; slot += 1) {
        if (!slots.includes(slot)) slots.push(slot);
      }
      state.picks.set(playerId, { slots, confirmed: true });
    }
    await this.startTournamentSelection(matchId, state);
  }

  private async startTournamentSelection(
    matchId: TournamentMatchId,
    state: TournamentSelectionState,
  ): Promise<void> {
    if (this.startingTournamentMatches.has(matchId)) return;
    const view = await this.tournaments.getMatch(matchId);
    const playerIds = [view.match.player1, view.match.player2];
    if (!playerIds[0] || !playerIds[1]) return;
    const first = state.picks.get(playerIds[0]);
    const second = state.picks.get(playerIds[1]);
    if (!first?.confirmed || !second?.confirmed) return;
    this.startingTournamentMatches.add(matchId);
    try {
      const tournament = await this.tournaments.getTournament(view.match.tournamentId);
      const preset = getGenerationPreset(state.presetId.replace(/-r\d+$/, ''));
      const teams: [string, string] = [
        sliceTeamText(preset.paste, first.slots),
        sliceTeamText(preset.paste, second.slots),
      ];
      await this.tournaments.startMatch(matchId, { teamOverrides: teams });
      this.clearTournamentSelection(matchId);
      this.broadcastTournamentMatch(matchId);
      void this.broadcastTournament(tournament.id);
    } finally {
      this.startingTournamentMatches.delete(matchId);
    }
  }

  private clearTournamentSelection(matchId: string): void {
    const timer = this.tournamentSelectionTimers.get(matchId);
    if (timer) clearTimeout(timer);
    this.tournamentSelectionTimers.delete(matchId);
    this.tournamentSelections.delete(matchId);
  }

  private tournamentSelectionForViewer(
    matchId: TournamentMatchId,
    viewerId: string,
    state: TournamentSelectionState,
  ): TournamentSelectionView {
    const selected = state.picks.get(viewerId);
    const rivalId = [...state.picks.keys()].find(id => id !== viewerId);
    return {
      round: state.round,
      presetId: state.presetId,
      presetName: state.presetName,
      pokemon: state.pokemon.map(mon => ({
        ...mon,
        moves: [...mon.moves],
        types: [...mon.types],
      })),
      selectionEndsAt: state.selectionEndsAt,
      selectedSlots: [...(selected?.slots ?? [])],
      confirmed: Boolean(selected?.confirmed),
      rivalConfirmed: Boolean(rivalId && state.picks.get(rivalId)?.confirmed),
    };
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
    if (this.chainEconomy.pokeConfigured && tournament.rail === 'sol_chain') {
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
    const selectionState = await this.ensureTournamentSelection(matchId);
    this.send(connection, {
      type,
      match: view.match,
      state,
      events: eventLog.events as unknown[],
      view: this.trainers.namedView(battleView),
      source: 'tournament',
      ...(selectionState
        ? { selection: this.tournamentSelectionForViewer(matchId, connection.playerId, selectionState) }
        : {}),
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

  /**
   * Charge the match fee only when `chargeFee` is set, then start.
   * A failure after that fee returns the vault. A failure before the fee
   * leaves the wager refundable.
   */
  private async beginSolFunding(roomId: string, notify = true): Promise<TxIntentPayload | undefined> {
    const existing = this.solFundingJobs.get(roomId);
    if (existing) return existing;

    const job = (async () => {
      for (let step = 0; step < 2; step += 1) {
        const room = this.casual.getRoom(roomId);
        if (
          room.rail !== 'sol_chain'
        ) return;
        if (room.deposits?.creator && room.deposits.opponent) {
          await this.casual.startBattle(roomId, room.creatorId);
          this.broadcastCasual(roomId);
          return;
        }

        // The creator funds first. Until that confirmation arrives the room
        // remains a private pending-deposit record and is not listed/joinable.
        // Once the creator deposit is confirmed, an opponent may join and the
        // server asks that opponent for the second deposit.
        if (!room.deposits?.creator) {
          if (room.opponentId) return;
          if (room.status !== 'pending_deposit') return;
        } else if (!room.opponentId) {
          return;
        }

        const side: 0 | 1 = room.deposits?.creator ? 1 : 0;
        const playerId = side === 0 ? room.creatorId : room.opponentId;
        if (!playerId) return;
        await this.assertSolStakeAvailable(playerId, room.collateral);
        const intent = await this.chainEconomy.createSolWagerDepositIntent({
          roomId,
          playerId,
          side,
          collateralLamports: room.collateral,
        });
        if (intent.serializedTx.length) {
          const target = this.sessionsByPlayer.get(playerId);
          const payload: TxIntentPayload = {
            intentId: intent.intentId,
            serializedTx: intent.serializedTx,
            kind: 'sol_wager_deposit',
            economics: intent.economics,
          };
          if (notify && target && !target.closed) {
            target.casualRoomIds.add(roomId);
            this.send(target, {
              type: 'tx.intent',
              intent: payload,
            });
          }
          return payload;
        }
        this.casual.markSolDeposit(roomId, side === 0 ? 'creator' : 'opponent');
      }
    })().finally(() => {
      this.solFundingJobs.delete(roomId);
    });
    this.solFundingJobs.set(roomId, job);
    return job;
  }

  private async startChargedCasualBattle(
    roomId: string,
    playerId: string,
    chargeFee: boolean,
    team?: string,
  ) {
    const before = this.casual.getRoom(roomId);
    const casualSelectionConfirmed = before.status === 'drafting'
      || before.status === 'ready'
      ? Boolean(
        before.teamPreview?.length === 2
        && before.teamPreview.every(preview => preview.confirmed),
      )
      : false;
    const shouldChargeFee = chargeFee
      || (before.rail === 'sol_chain' && casualSelectionConfirmed);
    if (shouldChargeFee) await this.chainEconomy.prepareCasualStart(roomId);
    try {
      return await this.casual.startBattle(roomId, playerId, team);
    } catch (error) {
      if (shouldChargeFee) {
        const latest = this.casual.getRoom(roomId);
        if (
          latest.rail === 'sol_chain'
          && latest.status !== 'battling'
          && latest.status !== 'completed'
        ) {
          try {
            await this.casual.releaseUnstartedSolRoom(roomId, playerId);
          } catch (releaseError) {
            const releaseMessage = releaseError instanceof Error ? releaseError.message : String(releaseError);
            const startMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`SOL stake release failed after battle start failed: ${releaseMessage}. Start error: ${startMessage}`);
          }
        }
      }
      throw error;
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
    if (
      before.rail === 'sol_chain'
      && (!before.deposits?.creator || !before.deposits.opponent)
    ) {
      this.send(connection, { type: 'casual.state', room: before }, requestId);
      return;
    }
    const launchingFight = before.status === 'battling'
      || ((before.ruleset ?? 'casual') === 'competitive' && before.status === 'ready')
      || (before.status === 'drafting' && Boolean(
        before.teamPreview?.length === 2
        && before.teamPreview.every(preview => preview.confirmed),
      ));
    const room = await this.startChargedCasualBattle(
      roomId,
      playerId,
      launchingFight && before.rail === 'sol_chain',
      team,
    );
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

  private async broadcastArenaSnapshots(reconcile = true): Promise<void> {
    await Promise.all([...this.connections.values()].map(async connection => {
      if (!connection.playerId || connection.closed) return;
      try {
        this.send(connection, {
          type: 'arena.snapshot',
          snapshot: await this.buildArenaSnapshot(connection.playerId, reconcile),
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
      this.send(connection, {
        type: 'casual.state',
        room: this.casual.getRoom(room.id, playerId),
      });
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
    let needsGrace = false;
    for (const room of this.casual.listRoomsForPlayer(playerId)) {
      if (
        room.status === 'pending_deposit'
        || room.status === 'open'
        || room.status === 'full'
        || room.status === 'ready'
        || room.status === 'drafting'
        || room.status === 'battling'
        || room.status === 'starting'
      ) {
        needsGrace = true;
      }
    }
    for (const tournament of await this.tournaments.listTournaments()) {
      if (tournament.status !== 'in-progress') continue;
      for (const match of await this.tournaments.getBracket(tournament.id)) {
        if (match.player1 !== playerId && match.player2 !== playerId) continue;
        if (match.status === 'active' || match.status === 'battle-created') {
          needsGrace = true;
        }
      }
    }
    if (needsGrace) this.scheduleDisconnectForfeit(playerId);
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
      if (
        room.status === 'pending_deposit'
        || room.status === 'open'
        || room.status === 'full'
        || room.status === 'ready'
        || room.status === 'drafting'
      ) {
        try {
          const cancelled = await this.casual.cancelRoom(room.id, playerId);
          this.broadcastCasual(cancelled.id);
          await this.broadcastArenaSnapshots();
        } catch {
          // Duplicate close must not refund twice or throw.
        }
        continue;
      }
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
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === '/dev/token-holding') {
      if (!this.playTokenDebugAllowed()) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      void this.handleTokenHoldingDebug(request, url, response);
      return;
    }
    if (!this.allowDemoAuth) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    if (pathname === '/dev/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        latest: this.lastAuthenticatedPlayerId,
        sessions: [...this.sessionsByPlayer.keys()],
      }));
      return;
    }
    if (pathname === '/dev/credit') {
      void this.handleDevCredit(url, response);
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

  private playTokenDebugAllowed(): boolean {
    return this.nodeEnv !== 'production' && this.playTokenDebug;
  }

  /**
   * Development/admin probe for an arbitrary mint. It only returns a calculation.
   * It does not authenticate a player, change a session, or grant Arena access.
   * Client-supplied price, balance, USD value, and eligibility are ignored.
   */
  private async handleTokenHoldingDebug(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Use GET or POST.' }));
        return;
      }
      const payload = request.method === 'POST'
        ? await readJsonBody(request)
        : Object.fromEntries(url.searchParams.entries());
      if (!isJsonRecord(payload)) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Expected a JSON object.' }));
        return;
      }
      const mint = typeof payload.mint === 'string' ? payload.mint : '';
      const wallet = typeof payload.wallet === 'string' ? payload.wallet : '';
      const minimumUsd = typeof payload.minimumUsd === 'number' || typeof payload.minimumUsd === 'string'
        ? payload.minimumUsd
        : '';
      const checked = await this.playToken.check({ mint, wallet, minimumUsd });
      const status = tokenHoldingHttpStatus(checked);
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(checked));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request could not be processed.';
      response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({
        status: 'invalid_request',
        eligible: false,
        error: message,
      }));
    }
  }

  private async handleDevCredit(url: URL, response: ServerResponse): Promise<void> {
    try {
      const playerId = (url.searchParams.get('playerId') || this.lastAuthenticatedPlayerId || '').trim();
      if (!playerId || (!isSolanaAddress(playerId) && !isDemoPlayerId(playerId))) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'playerId required (Solana address or demo player).' }));
        return;
      }
      const target = Number(url.searchParams.get('amount') ?? DEFAULT_DEV_BALANCE_POKE);
      const amount = Number.isFinite(target) && target > 0 ? Math.floor(target) : DEFAULT_DEV_BALANCE_POKE;
      const wallet = await this.topUpDevBalance(playerId, amount);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, wallet }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async topUpDevBalance(playerId: string, target = DEFAULT_DEV_BALANCE_POKE) {
    await this.economics.ensureWallet(playerId);
    const current = await this.economics.getBalance(playerId);
    if (current < target) {
      await this.economics.credit(playerId, target - current);
    }
    return this.economics.ensureWallet(playerId);
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

function waitForEscrowRetry(): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 1_000);
    timer.unref?.();
  });
}

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenHoldingHttpStatus(checked: PlayTokenCheckResult): number {
  if (checked.status === 'invalid_request') return 400;
  if (checked.status === 'rpc_error') return 503;
  return 200;
}

function readJsonBody(request: IncomingMessage, limit = 4_096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Request body must be JSON.'));
      }
    });
    request.on('error', () => reject(new Error('Request body could not be read.')));
  });
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
  devFaucet: boolean,
): EconomicsStore {
  if (!value) return new InMemoryEconomicsStore(new MockEconomics({ devFaucet }));
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
