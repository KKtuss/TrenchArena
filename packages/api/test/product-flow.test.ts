import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { ApiServer } from '../src/server';

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

function choiceFor(choice: any): any {
  if (choice.type === 'move') return { type: 'move', slot: choice.slot };
  if (choice.type === 'switch') return { type: 'switch', slot: choice.slot };
  return { type: choice.type };
}

test('product flow exposes arena snapshot, casual rooms, battle view, and tournament discovery', async () => {
  const server = new ApiServer({ allowDemoAuth: true });
  const port = await server.listen(0);
  const clients: [TestClient, TestClient] = [new TestClient(port), new TestClient(port)];
  await Promise.all(clients.map(client => client.open()));

  clients[0].send({ type: 'identify', playerId: 'demo-player-1' });
  clients[1].send({ type: 'identify', playerId: 'demo-player-2' });
  const snapshots = await Promise.all(clients.map(client => (
    client.waitFor<any>(message => message.type === 'arena.snapshot')
  )));
  assert.equal(snapshots[0].snapshot.wallet.symbol, 'POKE');
  assert.equal(snapshots[0].snapshot.wallet.balance, 10_000_000);

  clients[0].send({
    type: 'casual.create',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 100_000,
  });
  const created = await clients[0].waitFor<any>(message => message.type === 'casual.created');
  assert.equal(created.room.economics.protocolFee, 4_000);

  clients[1].send({ type: 'casual.accept', roomId: created.room.id });
  await clients[1].waitFor(message => message.type === 'casual.state');
  clients[0].send({ type: 'casual.ready', roomId: created.room.id, ready: true });
  clients[1].send({ type: 'casual.ready', roomId: created.room.id, ready: true });
  await Promise.all(clients.map(client => client.waitFor(message => (
    message.type === 'casual.state' && message.room.status === 'ready'
  ))));

  clients[0].send({ type: 'casual.start', roomId: created.room.id });
  const started = await clients[0].waitFor<any>(message => (
    message.type === 'casual.state' && message.room.status === 'battling'
  ));

  clients[0].send({ type: 'match.subscribe', matchId: started.room.matchId });
  clients[1].send({ type: 'match.subscribe', matchId: started.room.matchId });
  const subscribed = await Promise.all(clients.map(client => (
    client.waitFor<any>(message => message.type === 'match.subscribed')
  )));
  assert.equal(subscribed[0].source, 'casual');
  assert.ok(subscribed[0].view);
  assert.equal(subscribed[0].view.request.playerId, 'demo-player-1');
  assert.ok(!subscribed[0].events.some((event: any) => event.playerId === 'demo-player-2'));

  clients[0].send({
    type: 'tournament.create',
    title: 'Discovery Cup',
    maxPlayers: 4,
    entryFee: 50_000,
  });
  const tournament = await clients[0].waitFor<any>(message => message.type === 'tournament.created');
  clients[0].send({ type: 'tournament.list' });
  const listed = await clients[0].waitFor<any>(message => message.type === 'tournament.list');
  assert.ok(listed.tournaments.some((item: any) => item.id === tournament.tournament.id));

  clients[0].send({
    type: 'casual.create',
    roomType: 'open',
    battleSize: '2v2',
    collateral: 10_000,
  });
  const twoVTwo = await clients[0].waitFor<any>(message => (
    message.type === 'casual.created' && message.room.battleSize === '2v2'
  ));
  clients[1].send({ type: 'casual.accept', roomId: twoVTwo.room.id });
  await clients[1].waitFor(message => message.type === 'casual.state' && message.room.id === twoVTwo.room.id);
  clients[0].send({ type: 'casual.ready', roomId: twoVTwo.room.id, ready: true });
  clients[1].send({ type: 'casual.ready', roomId: twoVTwo.room.id, ready: true });
  await Promise.all(clients.map(client => client.waitFor(message => (
    message.type === 'casual.state' && message.room.id === twoVTwo.room.id && message.room.status === 'ready'
  ))));
  clients[0].send({ type: 'casual.start', roomId: twoVTwo.room.id });
  const unsupported = await clients[0].waitFor<any>(message => message.type === 'error');
  assert.match(unsupported.message, /2v2/);

  await Promise.all(clients.map(client => client.close()));
  await server.close();
});

test('stale casual choices are rejected and valid choices are accepted', async () => {
  const server = new ApiServer({ allowDemoAuth: true });
  const port = await server.listen(0);
  const clients: [TestClient, TestClient] = [new TestClient(port), new TestClient(port)];
  await Promise.all(clients.map(client => client.open()));
  clients[0].send({ type: 'identify', playerId: 'demo-player-1' });
  clients[1].send({ type: 'identify', playerId: 'demo-player-2' });
  await Promise.all(clients.map(client => client.waitFor(message => message.type === 'ready' && message.playerId)));

  clients[0].send({
    type: 'casual.create',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 20_000,
  });
  const created = await clients[0].waitFor<any>(message => message.type === 'casual.created');
  clients[1].send({ type: 'casual.accept', roomId: created.room.id });
  await clients[1].waitFor(message => message.type === 'casual.state');
  clients[0].send({ type: 'casual.ready', roomId: created.room.id, ready: true });
  clients[1].send({ type: 'casual.ready', roomId: created.room.id, ready: true });
  await Promise.all(clients.map(client => client.waitFor(message => (
    message.type === 'casual.state' && message.room.status === 'ready'
  ))));
  clients[0].send({ type: 'casual.start', roomId: created.room.id });
  const started = await clients[0].waitFor<any>(message => (
    message.type === 'casual.state' && message.room.status === 'battling'
  ));

  clients[0].send({ type: 'match.subscribe', matchId: started.room.matchId });
  clients[1].send({ type: 'match.subscribe', matchId: started.room.matchId });
  const [stateA] = await Promise.all(clients.map(client => (
    client.waitFor<any>(message => message.type === 'match.subscribed')
  )));

  clients[0].send({
    type: 'match.choice',
    matchId: started.room.matchId,
    battleInstanceId: started.room.battleInstanceId,
    requestRevision: stateA.state.request.revision - 1,
    choice: choiceFor(stateA.state.request.choices[0]),
  });
  assert.equal((await clients[0].waitFor<any>(message => message.type === 'error')).code, 'StaleChoiceError');

  clients[0].send({
    type: 'match.choice',
    matchId: started.room.matchId,
    battleInstanceId: started.room.battleInstanceId,
    requestRevision: stateA.state.request.revision,
    choice: choiceFor(stateA.state.request.choices[0]),
  });
  const accepted = await clients[0].waitFor<any>(message => message.type === 'match.choice.accepted');
  assert.equal(accepted.matchId, started.room.matchId);
  const update = await clients[0].waitFor<any>(message => message.type === 'match.update');
  assert.equal(update.source, 'casual');
  assert.ok(update.view);

  await Promise.all(clients.map(client => client.close()));
  await server.close();
});
