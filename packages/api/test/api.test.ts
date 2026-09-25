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
    reject: (error: Error) => void;
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

  hasMessage(predicate: (message: any) => boolean): boolean {
    return this.messages.some(predicate);
  }

  async waitFor<T = any>(
    predicate: (message: any) => boolean,
    timeoutMs = 5_000,
  ): Promise<T> {
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
        reject,
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

async function waitForMatchUpdates(clients: [TestClient, TestClient]): Promise<[any, any]> {
  const messages = await Promise.all(clients.map(client => (
    client.waitFor<any>(message => message.type === 'match.update' || message.type === 'error')
  )));
  for (const message of messages) {
    if (message.type === 'error') {
      throw new Error(`Unexpected API error during match: ${message.code}: ${message.message}`);
    }
  }
  return messages as [any, any];
}

async function createTwoPlayerMatch(server: ApiServer): Promise<{
  clients: [TestClient, TestClient];
  port: number;
  matchId: string;
  battleInstanceId: string;
  snapshots: [any, any];
}> {
  const port = await server.listen(0);
  const clients: [TestClient, TestClient] = [new TestClient(port), new TestClient(port)];
  await Promise.all(clients.map(client => client.open()));

  clients[0].send({ type: 'identify', playerId: 'demo-player-1' });
  clients[1].send({ type: 'identify', playerId: 'demo-player-2' });
  await Promise.all(clients.map(client => client.waitFor(message => message.type === 'ready')));

  clients[0].send({ type: 'tournament.create', title: 'Browser Test Cup', maxPlayers: 4 });
  const created = await clients[0].waitFor<any>(message => message.type === 'tournament.created');
  const tournamentId = created.tournament.id;

  clients[0].send({ type: 'tournament.join', tournamentId });
  clients[1].send({ type: 'tournament.join', tournamentId });
  await Promise.all(clients.map(client => (
    client.waitFor(message => message.type === 'tournament.state')
  )));

  clients[0].send({ type: 'tournament.start', tournamentId });
  const state = await clients[0].waitFor<any>(message => (
    message.type === 'tournament.state' && message.tournament.status === 'in-progress'
  ));
  const match = state.tournament.bracket.find((candidate: any) => candidate.status === 'active')
    ?? state.tournament.bracket.find((candidate: any) => candidate.status === 'ready');
  assert.ok(match);

  clients[0].send({ type: 'match.subscribe', matchId: match.id });
  clients[1].send({ type: 'match.subscribe', matchId: match.id });
  const snapshots = await Promise.all(clients.map(client => (
    client.waitFor<any>(message => message.type === 'match.subscribed')
  )));
  assert.equal(snapshots[0].match.id, match.id);
  assert.equal(snapshots[1].match.id, match.id);

  return {
    clients,
    port,
    matchId: match.id,
    battleInstanceId: snapshots[0].match.battleInstanceId,
    snapshots: snapshots as [any, any],
  };
}

test('two WebSocket clients play a complete tournament match with isolated events', async () => {
  const server = new ApiServer();
  const { clients, port, matchId, battleInstanceId, snapshots } = await createTwoPlayerMatch(server);
  let [stateA, stateB] = snapshots;

  assert.equal(stateA.state.request.playerId, 'demo-player-1');
  assert.equal(stateB.state.request.playerId, 'demo-player-2');
  assert.ok(!stateA.events.some((event: any) => event.playerId === 'demo-player-2'));
  assert.ok(!stateB.events.some((event: any) => event.playerId === 'demo-player-1'));

  for (let turn = 0; turn < 1000; turn += 1) {
    if (stateA.match.status === 'completed') break;
    if (stateA.state.request?.choices.length) {
      clients[0].send({
        type: 'match.choice',
        matchId,
        battleInstanceId,
        requestRevision: stateA.state.request.revision,
        choice: choiceFor(stateA.state.request.choices[0]),
      });
      [stateA, stateB] = await waitForMatchUpdates(clients);
    }

    if (stateB.match.status === 'completed') break;
    if (stateB.state.request?.choices.length) {
      clients[1].send({
        type: 'match.choice',
        matchId,
        battleInstanceId,
        requestRevision: stateB.state.request.revision,
        choice: choiceFor(stateB.state.request.choices[0]),
      });
      [stateA, stateB] = await waitForMatchUpdates(clients);
    }
  }

  const completedA = await clients[0].waitFor<any>(message => (
    message.type === 'tournament.state' && message.tournament.status === 'completed'
  ));
  const completedB = await clients[1].waitFor<any>(message => (
    message.type === 'tournament.state' && message.tournament.status === 'completed'
  ));
  assert.equal(completedA.tournament.status, 'completed');
  assert.equal(completedB.tournament.status, 'completed');
  await clients[0].close();
  const reconnected = new TestClient(port);
  await reconnected.open();
  reconnected.send({ type: 'identify', playerId: 'demo-player-1' });
  await reconnected.waitFor(message => (
    message.type === 'ready' && message.playerId === 'demo-player-1'
  ));
  reconnected.send({ type: 'match.subscribe', matchId });
  const replayed = await reconnected.waitFor<any>(message => message.type === 'match.subscribed');
  assert.ok(replayed.events.length > 0);
  assert.ok(!replayed.events.some((event: any) => event.playerId === 'demo-player-2'));
  await reconnected.close();
  await Promise.all(clients.map(client => client.close()));
  await server.close();
});

test('rejects stale, raw, and unauthorized WebSocket actions', async () => {
  const server = new ApiServer();
  const { clients, matchId, battleInstanceId, snapshots } = await createTwoPlayerMatch(server);
  const snapshot = snapshots[0];

  clients[0].send({
    type: 'match.choice',
    matchId: 'not-this-match',
    battleInstanceId,
    requestRevision: snapshot.state.request.revision,
    choice: { type: 'move', slot: 1 },
  });
  assert.equal((await clients[0].waitFor<any>(message => message.type === 'error')).code, 'Error');

  clients[0].send({
    type: 'match.finalize',
    matchId,
    result: { status: 'win', winner: 'demo-player-1' },
  });
  assert.equal((await clients[0].waitFor<any>(message => message.type === 'error')).code, 'Error');

  clients[0].send({
    type: 'match.choice',
    playerId: 'demo-player-2',
    matchId,
    battleInstanceId,
    requestRevision: snapshot.state.request.revision,
    choice: choiceFor(snapshot.state.request.choices[0]),
  });
  assert.equal((await clients[0].waitFor<any>(message => message.type === 'error')).code, 'Error');

  clients[0].send({
    type: 'match.choice',
    matchId,
    battleInstanceId,
    requestRevision: snapshot.state.request.revision,
    choice: { type: 'raw', command: '>eval process.exit()' },
  });
  assert.equal((await clients[0].waitFor<any>(message => message.type === 'error')).code, 'Error');

  clients[0].send({
    type: 'match.choice',
    matchId,
    battleInstanceId,
    requestRevision: snapshot.state.request.revision - 1,
    choice: choiceFor(snapshot.state.request.choices[0]),
  });
  assert.equal((await clients[0].waitFor<any>(message => message.type === 'error')).code, 'StaleChoiceError');

  clients[0].socket.send('{malformed');
  assert.equal((await clients[0].waitFor<any>(message => message.type === 'error')).code, 'Error');
  clients[0].send({ requestId: 'ping-correlation', type: 'ping' });
  const pong = await clients[0].waitFor<any>(message => message.type === 'pong');
  assert.equal(pong.requestId, 'ping-correlation');

  await Promise.all(clients.map(client => client.close()));
  await server.close();
});

test('rejects duplicate choice submissions and reconnects before the first choice', async () => {
  const server = new ApiServer();
  const { clients, port, matchId, battleInstanceId, snapshots } = await createTwoPlayerMatch(server);
  const snapshot = snapshots[0];
  const choiceMessage = {
    type: 'match.choice',
    matchId,
    battleInstanceId,
    requestRevision: snapshot.state.request.revision,
    choice: choiceFor(snapshot.state.request.choices[0]),
  };

  await clients[0].close();
  const reconnected = new TestClient(port);
  await reconnected.open();
  reconnected.send({ type: 'identify', playerId: 'demo-player-1' });
  await reconnected.waitFor(message => (
    message.type === 'ready' && message.playerId === 'demo-player-1'
  ));
  reconnected.send({ type: 'match.subscribe', matchId });
  const replayed = await reconnected.waitFor<any>(message => message.type === 'match.subscribed');
  assert.equal(replayed.state.request.playerId, 'demo-player-1');
  assert.equal(replayed.state.request.revision, snapshot.state.request.revision);
  clients[0] = reconnected;

  clients[0].send(choiceMessage);
  await waitForMatchUpdates(clients);
  clients[0].send(choiceMessage);
  assert.equal((await clients[0].waitFor<any>(message => message.type === 'error')).code, 'StaleChoiceError');

  await reconnected.close();
  await Promise.all(clients.map(client => client.close()));
  await server.close();
});

test('keeps two simultaneous matches isolated', async () => {
  const server = new ApiServer();
  const port = await server.listen(0);
  const clients = await Promise.all([
    new TestClient(port),
    new TestClient(port),
    new TestClient(port),
    new TestClient(port),
  ]);
  await Promise.all(clients.map(client => client.open()));
  clients.forEach((client, index) => {
    client.send({
      type: 'identify',
      playerId: index % 2 === 0 ? 'demo-player-1' : 'demo-player-2',
    });
  });
  await Promise.all(clients.map(client => client.waitFor(message => message.type === 'ready')));

  const setupPair = async (first: TestClient, second: TestClient, title: string) => {
    first.send({ type: 'tournament.create', title, maxPlayers: 4 });
    const created = await first.waitFor<any>(message => message.type === 'tournament.created');
    const tournamentId = created.tournament.id;
    first.send({ type: 'tournament.join', tournamentId });
    second.send({ type: 'tournament.join', tournamentId });
    await Promise.all([
      first.waitFor(message => message.type === 'tournament.state'),
      second.waitFor(message => message.type === 'tournament.state'),
    ]);
    first.send({ type: 'tournament.start', tournamentId });
    const state = await first.waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.status === 'in-progress'
    ));
    const match = state.tournament.bracket.find((candidate: any) => candidate.status === 'active');
    first.send({ type: 'match.subscribe', matchId: match.id });
    second.send({ type: 'match.subscribe', matchId: match.id });
    await Promise.all([
      first.waitFor(message => message.type === 'match.subscribed'),
      second.waitFor(message => message.type === 'match.subscribed'),
    ]);
    return match.id;
  };

  const matchOne = await setupPair(clients[0], clients[1], 'Simultaneous Cup One');
  const matchTwo = await setupPair(clients[2], clients[3], 'Simultaneous Cup Two');
  assert.notEqual(matchOne, matchTwo);
  assert.equal(clients[0].hasMessage(message => message.match?.id === matchTwo), false);
  assert.equal(clients[2].hasMessage(message => message.match?.id === matchOne), false);

  await Promise.all(clients.map(client => client.close()));
  await server.close();
});
