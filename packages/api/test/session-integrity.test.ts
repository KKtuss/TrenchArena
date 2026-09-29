import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { DEFAULT_DEV_BALANCE_POKE } from '../src/mock-economics';
import { ApiServer } from '../src/server';
import { encodeBase58 } from '../src/wallet-auth';

function createSolanaKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublic = Buffer.from(spki.subarray(spki.length - 32));
  return { address: encodeBase58(rawPublic), privateKey };
}

function signMessage(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  message: string,
): string {
  return encodeBase58(sign(null, Buffer.from(message, 'utf8'), privateKey as any));
}

class TestClient {
  readonly socket: WebSocket;
  private readonly messages: any[] = [];
  private readonly waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
  }> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const waiter = this.waiters.find(item => item.predicate(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ requestId: randomUUID(), ...message }));
  }

  async waitFor<T = any>(predicate: (message: any) => boolean, timeoutMs = 8_000): Promise<T> {
    const existing = this.messages.find(predicate);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return existing as T;
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiter = this.waiters.find(item => item.resolve === resolve);
        if (waiter) this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('Timed out waiting for WebSocket message.'));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: message => {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
  }

  close(): Promise<void> {
    this.socket.terminate();
    return Promise.resolve();
  }
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function identify(client: TestClient, playerId: 'demo-player-1' | 'demo-player-2'): Promise<void> {
  client.send({ type: 'identify', playerId });
  await client.waitFor(message => message.type === 'ready' && message.playerId === playerId);
}

async function authenticate(client: TestClient, keypair: ReturnType<typeof createSolanaKeypair>): Promise<void> {
  client.send({ type: 'auth.challenge', address: keypair.address });
  const challenge = await client.waitFor<any>(message => (
    message.type === 'auth.challenge' && message.address === keypair.address
  ));
  client.send({
    type: 'auth.verify',
    address: keypair.address,
    signature: signMessage(keypair.privateKey, challenge.message),
    nonce: challenge.nonce,
  });
  await client.waitFor(message => message.type === 'auth.verified' && message.playerId === keypair.address);
}

test('an authenticated socket cannot authenticate or identify again', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const client = new TestClient(port);
  const keypair = createSolanaKeypair();
  try {
    await client.open();
    await authenticate(client, keypair);
    client.send({ type: 'auth.challenge', address: keypair.address });
    const challenge = await client.waitFor<any>(message => message.type === 'auth.challenge');
    client.send({
      type: 'auth.verify',
      address: keypair.address,
      signature: signMessage(keypair.privateKey, challenge.message),
      nonce: challenge.nonce,
    });
    const repeated = await client.waitFor<any>(message => message.type === 'error');
    assert.equal(repeated.code, 'AlreadyAuthenticatedError');

    client.send({ type: 'identify', playerId: 'demo-player-2' });
    const swapped = await client.waitFor<any>(message => message.type === 'error');
    assert.equal(swapped.code, 'AlreadyAuthenticatedError');

    client.send({ type: 'arena.snapshot' });
    const snapshot = await client.waitFor<any>(message => message.type === 'arena.snapshot');
    assert.equal(snapshot.snapshot.wallet.playerId, keypair.address);
  } finally {
    await client.close();
    await server.close();
  }
});

test('rejected re-auth keeps subscriptions and does not crash the process', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  try {
    await Promise.all([creator.open(), opponent.open()]);
    await identify(creator, 'demo-player-1');
    await identify(opponent, 'demo-player-2');

    creator.send({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: 1_000,
    });
    const created = await creator.waitFor<any>(message => message.type === 'casual.created');
    const roomId = created.room.id;
    opponent.send({ type: 'casual.accept', roomId });
    await opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'full');
    creator.send({ type: 'casual.ready', roomId, ready: true });
    opponent.send({ type: 'casual.ready', roomId, ready: true });
    await Promise.all([
      creator.waitFor(message => message.type === 'casual.state' && message.room.status === 'drafting'),
      opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'drafting'),
    ]);
    creator.send({ type: 'casual.select', roomId, slots: [0, 1, 2], confirm: true });
    opponent.send({ type: 'casual.select', roomId, slots: [0, 1, 2], confirm: true });
    await Promise.all([
      creator.waitFor(message => message.type === 'casual.state' && message.room.teamPreview?.every((preview: any) => preview.confirmed)),
      opponent.waitFor(message => message.type === 'casual.state' && message.room.teamPreview?.every((preview: any) => preview.confirmed)),
    ]);
    creator.send({ type: 'casual.start', roomId });
    const started = await creator.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status === 'battling'
    ));
    creator.send({ type: 'match.subscribe', matchId: started.room.matchId });
    opponent.send({ type: 'match.subscribe', matchId: started.room.matchId });
    await Promise.all([
      creator.waitFor(message => message.type === 'match.subscribed'),
      opponent.waitFor(message => message.type === 'match.subscribed'),
    ]);

    creator.send({ type: 'identify', playerId: 'demo-player-2' });
    const denied = await creator.waitFor<any>(message => message.type === 'error');
    assert.equal(denied.code, 'AlreadyAuthenticatedError');

    creator.send({ type: 'arena.snapshot' });
    const creatorSnapshot = await creator.waitFor<any>(message => (
      message.type === 'arena.snapshot' && message.snapshot.wallet.playerId === 'demo-player-1'
    ));
    assert.equal(creatorSnapshot.snapshot.wallet.playerId, 'demo-player-1');

    opponent.send({ type: 'casual.subscribe', roomId });
    const stillBattling = await opponent.waitFor<any>(message => (
      message.type === 'casual.state'
      && message.room.id === roomId
      && message.room.status === 'battling'
    ));
    assert.equal(stillBattling.room.status, 'battling');
    assert.equal(stillBattling.room.creatorId, 'demo-player-1');
    assert.notEqual(stillBattling.room.status, 'completed');

    const health = await httpGet(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.match(health.body, /"ok":true/);
    opponent.send({ type: 'arena.snapshot' });
    const snapshot = await opponent.waitFor<any>(message => (
      message.type === 'arena.snapshot' && message.snapshot.wallet.playerId === 'demo-player-2'
    ));
    assert.equal(snapshot.snapshot.wallet.playerId, 'demo-player-2');
  } finally {
    await Promise.all([creator.close(), opponent.close()]);
    await server.close();
  }
});

test('a second socket for the same wallet replaces the first session', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const first = new TestClient(port);
  const second = new TestClient(port);
  const other = new TestClient(port);
  const keypair = createSolanaKeypair();
  try {
    await Promise.all([first.open(), second.open(), other.open()]);
    await authenticate(first, keypair);
    first.send({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: 1_000,
    });
    const created = await first.waitFor<any>(message => message.type === 'casual.created');

    await authenticate(second, keypair);
    const replaced = await first.waitFor<any>(message => (
      message.type === 'error' && message.code === 'SessionReplacedError'
    ));
    assert.equal(replaced.code, 'SessionReplacedError');
    await new Promise<void>(resolve => {
      if (first.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      first.socket.once('close', () => resolve());
    });

    first.send({ type: 'casual.cancel', roomId: created.room.id });
    const ignored = await Promise.race([
      first.waitFor(message => message.type === 'casual.state' || message.type === 'error', 400).then(
        message => message,
        () => ({ type: 'timeout' }),
      ),
    ]);
    assert.notEqual(ignored.type, 'casual.state');

    await identify(other, 'demo-player-2');
    other.send({ type: 'casual.accept', roomId: created.room.id });
    const accepted = await other.waitFor<any>(message => (
      message.type === 'error' || (message.type === 'casual.state' && message.room.status === 'full')
    ));
    assert.equal(accepted.type, 'casual.state');
    second.send({ type: 'casual.cancel', roomId: created.room.id });
    const cancelled = await second.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status === 'cancelled'
    ));
    assert.equal(cancelled.room.status, 'cancelled');
    assert.equal(await server.economics.getBalance(keypair.address), DEFAULT_DEV_BALANCE_POKE);
  } finally {
    await Promise.all([first.close(), second.close(), other.close()]);
    await server.close();
  }
});

test('disconnect before a casual battle cancels the room and refunds once', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  try {
    await Promise.all([creator.open(), opponent.open()]);
    await identify(creator, 'demo-player-1');
    await identify(opponent, 'demo-player-2');
    creator.send({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: 50_000,
    });
    const created = await creator.waitFor<any>(message => message.type === 'casual.created');
    opponent.send({ type: 'casual.accept', roomId: created.room.id });
    await opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'full');
    assert.equal(await server.economics.getBalance('demo-player-1'), 10_000_000 - 50_000);
    assert.equal(await server.economics.getBalance('demo-player-2'), 10_000_000 - 50_000);

    await creator.close();
    await creator.close();
    const cancelled = await opponent.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status === 'cancelled'
    ));
    assert.equal(cancelled.room.status, 'cancelled');
    assert.equal(await server.economics.getBalance('demo-player-1'), 10_000_000);
    assert.equal(await server.economics.getBalance('demo-player-2'), 10_000_000);
  } finally {
    await opponent.close();
    await server.close();
  }
});

test('a live casual disconnect waits for reconnect then forfeits exactly once', async () => {
  const server = new ApiServer({ allowDemoAuth: true, disconnectGraceMs: 80, countdownMs: 0 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  try {
    await Promise.all([creator.open(), opponent.open()]);
    await identify(creator, 'demo-player-1');
    await identify(opponent, 'demo-player-2');
    creator.send({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: 100_000,
    });
    const created = await creator.waitFor<any>(message => message.type === 'casual.created');
    opponent.send({ type: 'casual.accept', roomId: created.room.id });
    await opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'full');
    creator.send({ type: 'casual.ready', roomId: created.room.id, ready: true });
    opponent.send({ type: 'casual.ready', roomId: created.room.id, ready: true });
    await Promise.all([
      creator.waitFor(message => message.type === 'casual.state' && message.room.status === 'drafting'),
      opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'drafting'),
    ]);
    creator.send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
    opponent.send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
    await Promise.all([
      creator.waitFor(message => message.type === 'casual.state' && message.room.teamPreview?.every((preview: any) => preview.confirmed)),
      opponent.waitFor(message => message.type === 'casual.state' && message.room.teamPreview?.every((preview: any) => preview.confirmed)),
    ]);
    creator.send({ type: 'casual.start', roomId: created.room.id });
    await creator.waitFor(message => message.type === 'casual.state' && message.room.status === 'battling');

    await creator.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(server.casual.getRoom(created.room.id).status, 'battling');

    const reconnected = new TestClient(port);
    await reconnected.open();
    await identify(reconnected, 'demo-player-1');
    reconnected.send({ type: 'match.subscribe', matchId: created.room.matchId });
    const resumed = await reconnected.waitFor<any>(message => (
      message.type === 'match.subscribed' || message.type === 'error'
    ));
    assert.equal(resumed.type, 'match.subscribed');
    assert.notEqual(server.casual.getRoom(created.room.id).status, 'completed');

    await reconnected.close();
    await reconnected.close();
    const settled = await opponent.waitFor<any>(message => (
      message.type === 'casual.result'
      || (message.type === 'casual.state' && message.room.status === 'completed')
    ), 5_000);
    const room = server.casual.getRoom(created.room.id);
    assert.equal(room.status, 'completed');
    assert.equal(room.winnerId, 'demo-player-2');
    assert.equal(room.payout?.amount, 196_000);
    assert.equal(await server.economics.getBalance('demo-player-2'), 10_000_000 - 100_000 + 196_000);
    assert.equal(await server.economics.getBalance('demo-player-1'), 10_000_000 - 100_000);
    assert.ok(settled);
  } finally {
    await opponent.close();
    await server.close();
  }
});

test('a live tournament disconnect forfeits the disconnected player and advances once', async () => {
  const server = new ApiServer({ allowDemoAuth: true, disconnectGraceMs: 80, countdownMs: 0 });
  const port = await server.listen(0);
  const host = new TestClient(port);
  const member = new TestClient(port);
  try {
    await Promise.all([host.open(), member.open()]);
    await identify(host, 'demo-player-1');
    await identify(member, 'demo-player-2');
    host.send({ type: 'tournament.create', title: 'Disconnect Cup', maxPlayers: 4 });
    const created = await host.waitFor<any>(message => message.type === 'tournament.created');
    const tournamentId = created.tournament.id;
    host.send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_ONE });
    member.send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_TWO });
    await host.waitFor(message => message.type === 'tournament.state' && message.tournament.players?.length === 2);
    host.send({ type: 'tournament.start', tournamentId });
    const started = await host.waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.status === 'in-progress'
    ));
    const match = started.tournament.bracket.find((candidate: any) => (
      candidate.status === 'active' || candidate.status === 'ready'
    ));
    assert.ok(match);
    host.send({ type: 'match.subscribe', matchId: match.id });
    member.send({ type: 'match.subscribe', matchId: match.id });
    await Promise.all([
      host.waitFor(message => message.type === 'match.subscribed'),
      member.waitFor(message => message.type === 'match.subscribed'),
    ]);

    await host.close();
    await host.close();
    const finished = await member.waitFor<any>(message => (
      message.type === 'tournament.state'
      && (message.tournament.status === 'completed' || message.tournament.bracket?.some((item: any) => item.winner))
    ), 5_000);
    const settled = (await server.tournaments.getMatch(match.id)).match;
    assert.ok(settled.status === 'completed' || settled.status === 'forfeited');
    assert.equal(settled.winner, 'demo-player-2');
    assert.notEqual(settled.winner, 'demo-player-1');
    const tournament = await server.tournaments.getTournament(tournamentId);
    assert.equal(tournament.winner, 'demo-player-2');
    assert.equal(tournament.status, 'completed');
    const again = (await server.tournaments.getMatch(match.id)).match;
    assert.equal(again.winner, settled.winner);
    assert.equal(again.completedAt, settled.completedAt);
    assert.ok(finished);
  } finally {
    await member.close();
    await server.close();
  }
});

test('a stale viewer cannot crash an async match broadcast', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  const spectator = new TestClient(port);
  const spectatorKey = createSolanaKeypair();
  try {
    await Promise.all([creator.open(), opponent.open(), spectator.open()]);
    await identify(creator, 'demo-player-1');
    await identify(opponent, 'demo-player-2');
    await authenticate(spectator, spectatorKey);

    creator.send({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: 1_000,
    });
    const created = await creator.waitFor<any>(message => message.type === 'casual.created');
    opponent.send({ type: 'casual.accept', roomId: created.room.id });
    await opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'full');
    creator.send({ type: 'casual.ready', roomId: created.room.id, ready: true });
    opponent.send({ type: 'casual.ready', roomId: created.room.id, ready: true });
    await Promise.all([
      creator.waitFor(message => message.type === 'casual.state' && message.room.status === 'drafting'),
      opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'drafting'),
    ]);
    creator.send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
    opponent.send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
    await Promise.all([
      creator.waitFor(message => message.type === 'casual.state' && message.room.teamPreview?.every((preview: any) => preview.confirmed)),
      opponent.waitFor(message => message.type === 'casual.state' && message.room.teamPreview?.every((preview: any) => preview.confirmed)),
    ]);
    creator.send({ type: 'casual.start', roomId: created.room.id });
    const started = await creator.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status === 'battling'
    ));
    const matchId = started.room.matchId as string;

    const internals = server as unknown as {
      connections: Map<unknown, { playerId?: string; matchIds: Set<string> }>;
      scheduleMatchBroadcast: (id: string) => void;
    };
    let spectatorConnection: { playerId?: string; matchIds: Set<string> } | undefined;
    for (const connection of internals.connections.values()) {
      if (connection.playerId === spectatorKey.address) spectatorConnection = connection;
    }
    assert.ok(spectatorConnection);
    spectatorConnection.matchIds.add(matchId);
    internals.scheduleMatchBroadcast(matchId);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(spectatorConnection.matchIds.has(matchId), false);

    const health = await httpGet(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(server.casual.getRoom(created.room.id).status, 'battling');
    opponent.send({ type: 'arena.snapshot' });
    const snapshot = await opponent.waitFor<any>(message => (
      message.type === 'arena.snapshot' && message.snapshot.wallet.playerId === 'demo-player-2'
    ));
    assert.equal(snapshot.snapshot.wallet.playerId, 'demo-player-2');
  } finally {
    await Promise.all([creator.close(), opponent.close(), spectator.close()]);
    await server.close();
  }
});
