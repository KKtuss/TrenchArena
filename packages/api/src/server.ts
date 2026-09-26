import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';

import { inspectTeam, searchTeamOptions, validateAndPackTeam } from '@pokearena/battle-engine';
import {
  type BattleInstanceId,
} from '@pokearena/tournament';
import {
  createTournamentPlayerId,
  TournamentService,
  type TournamentId,
  type TournamentMatchId,
  type TournamentPlayerId,
} from '@pokearena/tournament';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';

import { CasualRoomService } from './casual-service';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from './demo-teams';
import {
  DEFAULT_TOURNAMENT_ENTRY_POKE,
  MockEconomics,
} from './mock-economics';
import {
  parseClientMessage,
  type ArenaSnapshot,
  type ClientMessage,
  type ServerMessage,
  type TournamentSummary,
} from './protocol';

interface ClientConnection {
  socket: WebSocket;
  playerId?: TournamentPlayerId;
  tournamentIds: Set<TournamentId>;
  matchIds: Set<string>;
  casualRoomIds: Set<string>;
}

const publicDirectory = join(__dirname, '../../public');

export class ApiServer {
  readonly tournaments: TournamentService;
  readonly economics: MockEconomics;
  readonly casual: CasualRoomService;
  private readonly tournamentEntryFees = new Map<TournamentId, number>();
  private readonly tournamentPayouts = new Map<TournamentId, ReturnType<MockEconomics['settleTournamentWin']>>();
  private readonly httpServer: Server;
  private readonly webSockets: WebSocketServer;
  private readonly connections = new Map<WebSocket, ClientConnection>();
  private readonly upgradeSockets = new Set<Duplex>();
  private readonly matchUnsubscribers = new Map<string, () => void>();
  private readonly casualUnsubscribers = new Map<string, () => void>();
  private readonly pendingMatchBroadcasts = new Set<string>();

  constructor(
    tournaments = new TournamentService(),
    economics = new MockEconomics(),
    casual = new CasualRoomService({ economics }),
  ) {
    this.tournaments = tournaments;
    this.economics = economics;
    this.casual = casual;
    this.httpServer = createServer((request, response) => this.handleHttp(request, response));
    this.webSockets = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (request, socket, head) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.upgradeSockets.add(socket);
      socket.once('close', () => this.upgradeSockets.delete(socket));
      this.webSockets.handleUpgrade(request, socket, head, client => {
        this.webSockets.emit('connection', client, request);
      });
    });
    this.webSockets.on('connection', socket => this.handleConnection(socket));
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, '127.0.0.1', () => resolve());
    });
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Server did not expose a port.');
    return address.port;
  }

  async close(): Promise<void> {
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
  }

  private handleConnection(socket: WebSocket): void {
    const connection: ClientConnection = {
      socket,
      tournamentIds: new Set(),
      matchIds: new Set(),
      casualRoomIds: new Set(),
    };
    this.connections.set(socket, connection);
    this.send(connection, { type: 'ready', playerId: '' });

    socket.on('message', raw => {
      void this.handleMessage(connection, raw);
    });
    socket.on('close', () => this.connections.delete(socket));
  }

  private async handleMessage(connection: ClientConnection, raw: RawData): Promise<void> {
    const requestId = extractRequestId(raw.toString());
    try {
      const message = parseClientMessage(raw.toString());
      await this.route(connection, message);
    } catch (error) {
      this.send(connection, {
        type: 'error',
        code: error instanceof Error ? error.name : 'ProtocolError',
        message: error instanceof Error ? error.message : String(error),
      }, requestId);
    }
  }

  private async route(connection: ClientConnection, message: ClientMessage): Promise<void> {
    if (message.type === 'identify') {
      if (!/^demo-player-[12]$/.test(message.playerId)) {
        throw new Error('That trainer profile is not on this stadium.');
      }
      connection.playerId = createTournamentPlayerId(message.playerId);
      this.send(connection, { type: 'ready', playerId: message.playerId }, message.requestId);
      this.send(connection, {
        type: 'arena.snapshot',
        snapshot: this.buildArenaSnapshot(message.playerId),
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
          snapshot: this.buildArenaSnapshot(playerId),
        }, message.requestId);
        return;
      case 'casual.create': {
        const room = this.casual.createRoom({
          creatorId: playerId,
          roomType: message.roomType,
          battleSize: message.battleSize,
          collateral: message.collateral,
          invitedPlayerId: message.invitedPlayerId,
        });
        connection.casualRoomIds.add(room.id);
        this.ensureCasualSubscription(room.id);
        this.send(connection, { type: 'casual.created', room }, message.requestId);
        this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.list':
        this.send(connection, {
          type: 'casual.list',
          rooms: this.casual.listOpenRooms(),
          recentResults: this.casual.listRecentResults(),
        }, message.requestId);
        return;
      case 'casual.preview':
        this.send(connection, {
          type: 'casual.preview',
          economics: this.economics.previewCasual(message.collateral),
        }, message.requestId);
        return;
      case 'casual.accept': {
        const room = this.casual.acceptRoom(message.roomId, playerId);
        connection.casualRoomIds.add(room.id);
        this.ensureCasualSubscription(room.id);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.ready': {
        const room = this.casual.setReady(message.roomId, playerId, message.ready, message.team);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        return;
      }
      case 'casual.start': {
        const room = await this.casual.startBattle(message.roomId, playerId, message.team);
        connection.matchIds.add(room.matchId);
        this.ensureCasualSubscription(room.id);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        if (room.status === 'battling') {
          this.broadcastCasualMatch(room.matchId);
        }
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
        this.broadcastArenaSnapshots();
        return;
      }
      case 'casual.cancel': {
        const room = this.casual.cancelRoom(message.roomId, playerId);
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        this.broadcastCasual(room.id);
        this.broadcastArenaSnapshots();
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
        this.send(connection, { type: 'casual.state', room }, message.requestId);
        return;
      }
      case 'tournament.create': {
        const tournament = this.tournaments.createTournament({
          title: message.title ?? 'PokeArena Open',
          format: 'gen9ou',
          maxPlayers: message.maxPlayers ?? 4,
          matchTimeoutMs: 300_000,
        });
        this.tournaments.openRegistration(tournament.id);
        this.tournamentEntryFees.set(
          tournament.id,
          message.entryFee ?? DEFAULT_TOURNAMENT_ENTRY_POKE,
        );
        connection.tournamentIds.add(tournament.id);
        this.send(connection, { type: 'tournament.created', tournament: this.serializeTournament(tournament.id) }, message.requestId);
        this.broadcastArenaSnapshots();
        return;
      }
      case 'tournament.list':
        this.send(connection, {
          type: 'tournament.list',
          tournaments: this.listTournamentSummaries(),
        }, message.requestId);
        return;
      case 'tournament.join': {
        const tournamentId = message.tournamentId as TournamentId;
        const entryFee = this.tournamentEntryFees.get(tournamentId) ?? DEFAULT_TOURNAMENT_ENTRY_POKE;
        this.economics.assertAffordable(playerId, entryFee);
        const team = message.team ?? (playerId === 'demo-player-1' ? DEMO_TEAM_ONE : DEMO_TEAM_TWO);
        validateAndPackTeam(team, 'gen9ou');
        this.tournaments.registerPlayer(tournamentId, {
          playerId,
          displayName: playerId,
          team,
        });
        this.economics.lockCollateral(playerId, entryFee);
        connection.tournamentIds.add(tournamentId);
        this.send(connection, {
          type: 'tournament.state',
          tournament: this.serializeTournament(tournamentId),
        }, message.requestId);
        this.broadcastTournament(tournamentId);
        this.broadcastArenaSnapshots();
        return;
      }
      case 'tournament.start': {
        this.requireTournamentAccess(connection, message.tournamentId);
        const tournament = this.tournaments.startTournament(message.tournamentId as TournamentId);
        await this.startReadyMatches(tournament.id);
        this.broadcastTournament(tournament.id);
        this.send(connection, {
          type: 'tournament.state',
          tournament: this.serializeTournament(tournament.id),
        }, message.requestId);
        return;
      }
      case 'tournament.subscribe': {
        const tournamentId = message.tournamentId as TournamentId;
        connection.tournamentIds.add(tournamentId);
        this.send(connection, {
          type: 'tournament.state',
          tournament: this.serializeTournament(tournamentId),
        }, message.requestId);
        return;
      }
      case 'match.subscribe': {
        const matchId = message.matchId;
        const casualRoom = this.casual.getRoomByMatchId(matchId);
        if (casualRoom) {
          if (casualRoom.creatorId !== playerId && casualRoom.opponentId !== playerId) {
            throw new Error('You are not a player in this casual match.');
          }
          if (casualRoom.status === 'ready' || casualRoom.status === 'full') {
            await this.casual.startBattle(casualRoom.id, playerId);
          }
          connection.matchIds.add(matchId);
          connection.casualRoomIds.add(casualRoom.id);
          this.ensureCasualSubscription(casualRoom.id);
          this.sendCasualMatch(connection, matchId, 'match.subscribed', message.requestId);
          return;
        }

        const tournamentMatchId = matchId as TournamentMatchId;
        const view = this.tournaments.getMatch(tournamentMatchId);
        if (view.match.player1 !== playerId && view.match.player2 !== playerId) {
          throw new Error('You are not a player in this match.');
        }
        if (view.match.status === 'ready') await this.tournaments.startMatch(tournamentMatchId);
        connection.matchIds.add(matchId);
        this.ensureMatchSubscription(tournamentMatchId);
        this.sendTournamentMatch(connection, tournamentMatchId, 'match.subscribed', message.requestId);
        return;
      }
      case 'team.starter':
        this.send(connection, {
          type: 'team.starter',
          name: 'Circuit Six',
          paste: (playerId === 'demo-player-1' ? DEMO_TEAM_ONE : DEMO_TEAM_TWO).trim(),
        }, message.requestId);
        return;
      case 'team.inspect':
        this.send(connection, {
          type: 'team.inspect',
          inspection: inspectTeam(message.team, 'gen9ou'),
        }, message.requestId);
        return;
      case 'team.search':
        this.send(connection, {
          type: 'team.search',
          results: searchTeamOptions(message.kind, message.query, message.species),
        }, message.requestId);
        return;
      case 'match.choice': {
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
        const view = this.tournaments.getMatch(tournamentMatchId);
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
      default:
        throw new Error('Unhandled client message.');
    }
  }

  private buildArenaSnapshot(playerId: string): ArenaSnapshot {
    return {
      wallet: this.economics.getWallet(playerId),
      tournaments: this.listTournamentSummaries(),
      openCasualRooms: this.casual.listOpenRooms(),
      myCasualRooms: this.casual.listRoomsForPlayer(playerId),
      recentCasualResults: this.casual.listRecentResults(),
    };
  }

  private listTournamentSummaries(): TournamentSummary[] {
    return this.tournaments.listTournaments().map(tournament => {
      const entryFee = this.tournamentEntryFees.get(tournament.id) ?? DEFAULT_TOURNAMENT_ENTRY_POKE;
      const playerCount = tournament.players.filter(player => player.status === 'registered').length;
      return {
        id: tournament.id,
        title: tournament.title,
        format: tournament.format,
        maxPlayers: tournament.maxPlayers,
        status: tournament.status,
        playerCount,
        entryFee,
        economics: this.economics.previewTournament(entryFee, Math.max(playerCount, tournament.maxPlayers)),
        ...(tournament.winner ? { winner: tournament.winner } : {}),
      };
    });
  }

  private serializeTournament(tournamentId: TournamentId): unknown {
    const tournament = this.tournaments.getTournament(tournamentId);
    const entryFee = this.tournamentEntryFees.get(tournamentId) ?? DEFAULT_TOURNAMENT_ENTRY_POKE;
    const playerCount = tournament.players.filter(player => player.status === 'registered').length;
    return {
      ...tournament,
      bracket: this.tournaments.getBracket(tournamentId),
      entryFee,
      economics: this.economics.previewTournament(entryFee, Math.max(playerCount, 1)),
      payout: this.tournamentPayouts.get(tournamentId),
    };
  }

  private async startReadyMatches(tournamentId: TournamentId): Promise<void> {
    for (const match of this.tournaments.getBracket(tournamentId)) {
      if (match.status !== 'ready') continue;
      await this.tournaments.startMatch(match.id);
      this.ensureMatchSubscription(match.id);
      this.broadcastTournamentMatch(match.id);
    }
  }

  private ensureMatchSubscription(matchId: TournamentMatchId): void {
    if (this.matchUnsubscribers.has(matchId)) return;
    const unsubscribe = this.tournaments.subscribeMatch(matchId, match => {
      this.scheduleMatchBroadcast(match.id);
      if (match.status === 'completed' || match.status === 'forfeited') {
        void this.startReadyMatches(match.tournamentId).catch(error => {
          this.broadcastError(match.tournamentId, error);
        });
        this.maybeSettleTournament(match.tournamentId);
        this.broadcastTournament(match.tournamentId);
      }
    });
    this.matchUnsubscribers.set(matchId, unsubscribe);
  }

  private ensureCasualSubscription(roomId: string): void {
    if (this.casualUnsubscribers.has(roomId)) return;
    const unsubscribe = this.casual.subscribe(roomId, room => {
      this.broadcastCasual(room.id);
      if (room.status === 'battling' || room.status === 'completed') {
        this.scheduleMatchBroadcast(room.matchId);
      }
      if (room.status === 'completed' && room.payout) {
        this.broadcastCasualResult(room.id);
        this.broadcastArenaSnapshots();
      }
    });
    this.casualUnsubscribers.set(roomId, unsubscribe);
  }

  private maybeSettleTournament(tournamentId: TournamentId): void {
    const result = this.tournaments.getTournamentResult(tournamentId);
    if (!result || this.tournamentPayouts.has(tournamentId)) return;
    const entryFee = this.tournamentEntryFees.get(tournamentId) ?? DEFAULT_TOURNAMENT_ENTRY_POKE;
    const tournament = this.tournaments.getTournament(tournamentId);
    const playerCount = tournament.players.filter(player => player.status === 'registered').length;
    const payout = this.economics.settleTournamentWin({
      winnerId: result.winner,
      entryFee,
      playerCount,
    });
    this.tournamentPayouts.set(tournamentId, payout);
    for (const connection of this.connections.values()) {
      if (!connection.tournamentIds.has(tournamentId)) continue;
      this.send(connection, {
        type: 'tournament.result',
        tournament: this.serializeTournament(tournamentId),
        payout,
      });
    }
    this.broadcastArenaSnapshots();
  }

  private broadcastTournamentMatch(matchId: TournamentMatchId): void {
    for (const connection of this.connections.values()) {
      if (!connection.matchIds.has(matchId) || !connection.playerId) continue;
      this.sendTournamentMatch(connection, matchId, 'match.update');
    }
  }

  private broadcastCasualMatch(matchId: string): void {
    for (const connection of this.connections.values()) {
      if (!connection.matchIds.has(matchId) || !connection.playerId) continue;
      this.sendCasualMatch(connection, matchId, 'match.update');
    }
  }

  private scheduleMatchBroadcast(matchId: string): void {
    if (this.pendingMatchBroadcasts.has(matchId)) return;
    this.pendingMatchBroadcasts.add(matchId);
    setImmediate(() => {
      this.pendingMatchBroadcasts.delete(matchId);
      if (this.casual.getRoomByMatchId(matchId)) {
        this.broadcastCasualMatch(matchId);
      } else {
        this.broadcastTournamentMatch(matchId as TournamentMatchId);
      }
    });
  }

  private sendTournamentMatch(
    connection: ClientConnection,
    matchId: TournamentMatchId,
    type: 'match.update' | 'match.subscribed',
    requestId?: string,
  ): void {
    if (!connection.playerId) throw new Error('Identify before subscribing to a match.');
    const view = this.tournaments.getMatch(matchId);
    const state = this.tournaments.getMatchState(matchId, connection.playerId);
    const eventLog = this.tournaments.getMatchEvents(matchId, connection.playerId);
    const battleView = this.tournaments.getMatchView(matchId, connection.playerId);
    this.send(connection, {
      type,
      match: view.match,
      state,
      events: eventLog.events as unknown[],
      view: battleView,
      source: 'tournament',
    }, requestId);
  }

  private sendCasualMatch(
    connection: ClientConnection,
    matchId: string,
    type: 'match.update' | 'match.subscribed',
    requestId?: string,
  ): void {
    if (!connection.playerId) throw new Error('Identify before subscribing to a match.');
    const room = this.casual.getRoomByMatchId(matchId);
    if (!room) throw new Error(`Unknown casual match: ${matchId}`);
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
      view: battleView,
      source: 'casual',
    }, requestId);
  }

  private broadcastTournament(tournamentId: TournamentId): void {
    const state = this.serializeTournament(tournamentId);
    for (const connection of this.connections.values()) {
      if (connection.tournamentIds.has(tournamentId)) {
        this.send(connection, { type: 'tournament.state', tournament: state });
      }
    }
  }

  private broadcastCasual(roomId: string): void {
    const room = this.casual.getRoom(roomId);
    for (const connection of this.connections.values()) {
      if (connection.casualRoomIds.has(roomId)) {
        this.send(connection, { type: 'casual.state', room });
      }
    }
  }

  private broadcastCasualResult(roomId: string): void {
    const room = this.casual.getRoom(roomId);
    for (const connection of this.connections.values()) {
      if (connection.casualRoomIds.has(roomId)) {
        this.send(connection, { type: 'casual.result', room, payout: room.payout });
      }
    }
  }

  private broadcastArenaSnapshots(): void {
    for (const connection of this.connections.values()) {
      if (!connection.playerId) continue;
      this.send(connection, {
        type: 'arena.snapshot',
        snapshot: this.buildArenaSnapshot(connection.playerId),
      });
    }
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

  private requireIdentity(connection: ClientConnection): TournamentPlayerId {
    if (!connection.playerId) throw new Error('Identify before using the application API.');
    return connection.playerId;
  }

  private requireTournamentAccess(connection: ClientConnection, tournamentId: string): void {
    if (!connection.tournamentIds.has(tournamentId as TournamentId)) {
      throw new Error('Join this tournament before starting it.');
    }
  }

  private send(connection: ClientConnection, message: ServerMessage, requestId?: string): void {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify({
        ...message,
        ...(requestId ? { requestId } : {}),
      }));
    }
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(JSON.stringify({ ok: true }));
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

if (require.main === module) {
  const server = new ApiServer();
  void server.listen(Number(process.env.PORT ?? 3000)).then(port => {
    console.log(`PokeArena development API listening on http://127.0.0.1:${port}`);
  });
}
