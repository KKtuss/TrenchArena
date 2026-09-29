import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { ApiServer } from '../src/server';
import { encodeBase58 } from '../src/wallet-auth';

class TestClient {
  readonly socket: WebSocket;
  private readonly messages: unknown[] = [];
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

  send(message: unknown): void {
    this.socket.send(JSON.stringify({
      requestId: randomUUID(),
      ...(message as object),
    }));
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
    (this.socket as WebSocket & { _socket?: { destroy: () => void } })._socket?.destroy();
    return Promise.resolve();
  }
}

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

async function identify(client: TestClient, playerId: string): Promise<void> {
  client.send({ type: 'identify', playerId });
  await client.waitFor(message => message.type === 'arena.snapshot');
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

async function startCasualBattle(clients: [TestClient, TestClient]): Promise<string> {
  clients[0].send({
    type: 'casual.create',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 1_000,
  });
  const created = await clients[0].waitFor<any>(message => message.type === 'casual.created');
  clients[1].send({ type: 'casual.accept', roomId: created.room.id });
  await clients[1].waitFor(message => message.type === 'casual.state' && message.room.status === 'full');
  clients[0].send({ type: 'casual.ready', roomId: created.room.id, ready: true });
  clients[1].send({ type: 'casual.ready', roomId: created.room.id, ready: true });
  await Promise.all(clients.map(client => client.waitFor(message => (
    message.type === 'casual.state' && message.room.status === 'drafting'
  ))));
  clients[0].send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
  clients[1].send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
  await Promise.all(clients.map(client => client.waitFor(message => (
    message.type === 'casual.state'
    && message.room.status === 'battling'
  ))));
  return created.room.id;
}

test('a bystander can watch a live casual fight without private requests or starting it', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const players: [TestClient, TestClient] = [new TestClient(port), new TestClient(port)];
  const watcher = new TestClient(port);
  const keypair = createSolanaKeypair();
  try {
    await Promise.all([...players, watcher].map(client => client.open()));
    await identify(players[0], 'demo-player-1');
    await identify(players[1], 'demo-player-2');
    await authenticate(watcher, keypair);

    const roomId = await startCasualBattle(players);
    watcher.send({ type: 'live.watch' });
    const live = await watcher.waitFor<any>(message => message.type === 'live.update' && message.fight);
    assert.equal(live.fight.source, 'casual');
    assert.equal(live.fight.status, 'active');
    assert.ok(live.view);
    assert.equal(live.view.request, undefined);
    assert.ok(Array.isArray(live.events));
    assert.ok(live.events.length > 0);
    assert.ok(!live.events.some((event: any) => event.scope === 'private'));
    assert.ok(!live.events.some((event: any) => String(event.data ?? '').includes('|request|')));
    assert.ok(live.view.sides[0].active?.species || live.view.sides[0].party?.length);

    watcher.send({ type: 'live.list' });
    const listed = await watcher.waitFor<any>(message => message.type === 'live.list');
    assert.equal(listed.fights[0].matchId, live.fight.matchId);

    watcher.send({
      type: 'match.choice',
      matchId: live.fight.matchId,
      battleInstanceId: live.view.battleId,
      requestRevision: 1,
      choice: { type: 'move', slot: 1 },
    });
    const denied = await watcher.waitFor<any>(message => message.type === 'error');
    assert.match(denied.message, /Subscribe to the match first|You are not a player/i);
  } finally {
    await Promise.all([...players, watcher].map(client => client.close()));
    await server.close();
  }
});

test('a bystander can watch a live tournament fight', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const players: [TestClient, TestClient] = [new TestClient(port), new TestClient(port)];
  const watcher = new TestClient(port);
  const keypair = createSolanaKeypair();
  try {
    await Promise.all([...players, watcher].map(client => client.open()));
    await identify(players[0], 'demo-player-1');
    await identify(players[1], 'demo-player-2');
    await authenticate(watcher, keypair);

    players[0].send({ type: 'tournament.create', title: 'Home Cup', maxPlayers: 4 });
    const created = await players[0].waitFor<any>(message => message.type === 'tournament.created');
    const tournamentId = created.tournament.id;
    players[0].send({ type: 'tournament.join', tournamentId });
    players[1].send({ type: 'tournament.join', tournamentId });
    await Promise.all(players.map(client => client.waitFor(message => message.type === 'tournament.state')));
    players[0].send({ type: 'tournament.start', tournamentId });
    const state = await players[0].waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.status === 'in-progress'
    ));
    const match = state.tournament.bracket.find((candidate: any) => candidate.status === 'active')
      ?? state.tournament.bracket.find((candidate: any) => candidate.status === 'ready');
    assert.ok(match);
    players[0].send({ type: 'match.subscribe', matchId: match.id });
    players[1].send({ type: 'match.subscribe', matchId: match.id });
    await Promise.all(players.map(client => client.waitFor(message => message.type === 'match.subscribed')));

    watcher.send({ type: 'live.watch' });
    const live = await watcher.waitFor<any>(message => message.type === 'live.update' && message.fight);
    assert.equal(live.fight.source, 'tournament');
    assert.equal(live.fight.tournamentId, tournamentId);
    assert.equal(live.view?.request, undefined);
    assert.ok(Array.isArray(live.events));
    assert.ok(!live.events?.some((event: any) => event.scope === 'private'));
    assert.ok(!live.events?.some((event: any) => String(event.data ?? '').includes('|request|')));
  } finally {
    await Promise.all([...players, watcher].map(client => client.close()));
    await server.close();
  }
});
