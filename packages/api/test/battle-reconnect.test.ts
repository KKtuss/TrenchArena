/**
 * Client reconnect reads the live battle. It must not start another Showdown
 * session, reset the decision timer, submit a choice, or settle.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { PlayerChoice } from '@pokearena/battle-engine';
import { WebSocket } from 'ws';

import { CasualRoomService } from '../src/casual-service';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { MockEconomics } from '../src/mock-economics';
import { ApiServer } from '../src/server';
import { openFullCasualRoom } from './casual-flow';

const COLLATERAL = 100_000;
const PLAYERS = ['demo-player-1', 'demo-player-2'] as const;

function firstChoice(request: { choices: readonly { type: string; slot?: number }[] }): PlayerChoice {
  const choice = request.choices[0];
  if (!choice) throw new Error('Battle has no available choice.');
  if (choice.type === 'move') {
    if (choice.slot === undefined) throw new Error('Move choice is missing a slot.');
    return { type: 'move', slot: choice.slot };
  }
  if (choice.type === 'switch') {
    if (choice.slot === undefined) throw new Error('Switch choice is missing a slot.');
    return { type: 'switch', slot: choice.slot };
  }
  if (choice.type === 'team-preview') return { type: 'team-preview' };
  return { type: 'pass' };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startedCompetitive(timeoutMs: number) {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    countdownMs: 0,
    matchTimeoutMs: timeoutMs,
  });
  const room = await openFullCasualRoom(casual, PLAYERS[0], PLAYERS[1], COLLATERAL, 'competitive');
  casual.setReady(room.id, PLAYERS[0], true, DEMO_TEAM_ONE);
  casual.setReady(room.id, PLAYERS[1], true, DEMO_TEAM_TWO);
  const started = await casual.startBattle(room.id, PLAYERS[0]);
  return { economics, casual, started };
}

test('reading an active battle does not reset its decision timer or settle it', async () => {
  const timeoutMs = 1_000;
  const { economics, casual, started } = await startedCompetitive(timeoutMs);
  const matchId = started.matchId;
  const battleId = started.battleInstanceId;
  const before = casual.getMatchView(matchId, PLAYERS[0]);
  assert.equal(before?.result, undefined);
  assert.ok(before?.request);
  const revision = before?.request?.revision;
  const sequences = casual.getMatchEvents(matchId, PLAYERS[0]).map(event => event.sequence);

  await sleep(400);
  assert.equal(casual.getMatchView(matchId, PLAYERS[0])?.result, undefined);
  const reread = casual.getMatchView(matchId, PLAYERS[0]);
  const again = await casual.startBattle(started.id, PLAYERS[0]);
  assert.equal(again.battleInstanceId, battleId);
  assert.equal(reread?.request?.revision, revision);
  assert.equal(casual.getRoom(started.id).status, 'battling');
  assert.deepEqual(
    casual.getMatchEvents(matchId, PLAYERS[0]).map(event => event.sequence).slice(0, sequences.length),
    sequences,
  );

  const afterRead = Date.now();
  let settled = casual.getRoom(started.id);
  while (settled.status !== 'completed' && Date.now() - afterRead < 800) {
    await sleep(30);
    settled = casual.getRoom(started.id);
  }
  assert.equal(settled.status, 'completed');
  assert.equal(settled.result?.status, 'tie');
  assert.equal(settled.winnerId, undefined);
  const paid1 = economics.getBalance(PLAYERS[0]);
  const paid2 = economics.getBalance(PLAYERS[1]);
  casual.getMatchView(matchId, PLAYERS[0]);
  casual.getMatchEvents(matchId, PLAYERS[0]);
  await assert.rejects(() => casual.startBattle(started.id, PLAYERS[1]));
  assert.equal(economics.getBalance(PLAYERS[0]), paid1);
  assert.equal(economics.getBalance(PLAYERS[1]), paid2);
  assert.equal(casual.getRoom(started.id).battleInstanceId, battleId);
});

test('a player can continue the same battle after the state is read again', async () => {
  const { economics, casual, started } = await startedCompetitive(30_000);
  const matchId = started.matchId;
  const battleId = started.battleInstanceId;
  const view = casual.getMatchView(matchId, PLAYERS[0]);
  assert.ok(view?.request);
  casual.getMatchEvents(matchId, PLAYERS[0]);
  casual.getMatchView(matchId, PLAYERS[1]);
  await casual.submitChoice({
    matchId,
    battleInstanceId: battleId!,
    playerId: PLAYERS[0],
    revision: view!.request!.revision,
    choice: firstChoice(view!.request!),
  });
  const after = casual.getRoom(started.id);
  assert.equal(after.status, 'battling');
  assert.equal(after.battleInstanceId, battleId);
  assert.equal(after.winnerId, undefined);
  assert.equal(casual.getMatchView(matchId, PLAYERS[0])?.result, undefined);
  const opponent = casual.getMatchView(matchId, PLAYERS[1]);
  assert.ok(opponent?.request);
  assert.equal(economics.getBalance(PLAYERS[0]), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance(PLAYERS[1]), 10_000_000 - COLLATERAL);
});

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
    return new Promise(resolve => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

function identify(client: TestClient, playerId: string): Promise<unknown> {
  client.send({ type: 'identify', playerId });
  return client.waitFor(message => message.type === 'identified' || message.type === 'arena.snapshot');
}

test('reconnecting subscribes to the same battle and can keep playing', async () => {
  const server = new ApiServer({ allowDemoAuth: true, disconnectGraceMs: 5_000, countdownMs: 0 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  try {
    await Promise.all([creator.open(), opponent.open()]);
    await identify(creator, PLAYERS[0]);
    await identify(opponent, PLAYERS[1]);
    creator.send({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: COLLATERAL,
      ruleset: 'competitive',
    });
    const created = await creator.waitFor<any>(message => message.type === 'casual.created');
    opponent.send({ type: 'casual.accept', roomId: created.room.id });
    await opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'full');
    creator.send({ type: 'casual.ready', roomId: created.room.id, ready: true, team: DEMO_TEAM_ONE });
    opponent.send({ type: 'casual.ready', roomId: created.room.id, ready: true, team: DEMO_TEAM_TWO });
    await creator.waitFor(message => message.type === 'casual.state' && message.room.status === 'ready');
    creator.send({ type: 'casual.start', roomId: created.room.id });
    const live = await creator.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status === 'battling'
    ));
    const battleId = live.room.battleInstanceId as string;

    await creator.close();
    const reconnected = new TestClient(port);
    await reconnected.open();
    await identify(reconnected, PLAYERS[0]);
    reconnected.send({ type: 'match.subscribe', matchId: created.room.matchId });
    const resumed = await reconnected.waitFor<any>(message => (
      message.type === 'match.subscribed' || message.type === 'error'
    ));
    assert.equal(resumed.type, 'match.subscribed');
    assert.equal(resumed.match.battleInstanceId, battleId);
    assert.equal(resumed.view.result, undefined);
    assert.ok(resumed.events.length > 0);
    assert.ok(resumed.view.request);

    reconnected.send({ type: 'match.subscribe', matchId: created.room.matchId });
    const second = await reconnected.waitFor<any>(message => message.type === 'match.subscribed');
    assert.equal(second.match.battleInstanceId, battleId);
    assert.equal(second.events.length, resumed.events.length);
    assert.equal(server.casual.getRoom(created.room.id).status, 'battling');

    reconnected.send({
      type: 'match.choice',
      matchId: created.room.matchId,
      battleInstanceId: battleId,
      requestRevision: resumed.view.request.revision,
      choice: firstChoice(resumed.view.request),
    });
    const updated = await reconnected.waitFor<any>(message => (
      message.type === 'match.update' || message.type === 'error'
    ));
    assert.equal(updated.type, 'match.update');
    assert.equal(updated.match.battleInstanceId, battleId);
    assert.equal(server.casual.getRoom(created.room.id).status, 'battling');
    assert.equal(server.casual.getRoom(created.room.id).winnerId, undefined);
    assert.equal(await server.economics.getBalance(PLAYERS[0]), 10_000_000 - COLLATERAL);
    assert.equal(await server.economics.getBalance(PLAYERS[1]), 10_000_000 - COLLATERAL);
    await reconnected.close();
  } finally {
    await opponent.close();
    await server.close();
  }
});

test('a reconnect after the fight ends returns the terminal state without paying again', async () => {
  const server = new ApiServer({ allowDemoAuth: true, disconnectGraceMs: 5_000, countdownMs: 0 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  try {
    await Promise.all([creator.open(), opponent.open()]);
    await identify(creator, PLAYERS[0]);
    await identify(opponent, PLAYERS[1]);
    creator.send({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: COLLATERAL,
      ruleset: 'competitive',
    });
    const created = await creator.waitFor<any>(message => message.type === 'casual.created');
    opponent.send({ type: 'casual.accept', roomId: created.room.id });
    await opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'full');
    creator.send({ type: 'casual.ready', roomId: created.room.id, ready: true, team: DEMO_TEAM_ONE });
    opponent.send({ type: 'casual.ready', roomId: created.room.id, ready: true, team: DEMO_TEAM_TWO });
    await creator.waitFor(message => message.type === 'casual.state' && message.room.status === 'ready');
    creator.send({ type: 'casual.start', roomId: created.room.id });
    const live = await creator.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status === 'battling'
    ));
    opponent.send({ type: 'casual.forfeit', roomId: created.room.id });
    await creator.waitFor(message => message.type === 'casual.state' && message.room.status === 'completed');
    const winnerBalance = await server.economics.getBalance(PLAYERS[0]);
    const loserBalance = await server.economics.getBalance(PLAYERS[1]);

    await creator.close();
    const reconnected = new TestClient(port);
    await reconnected.open();
    await identify(reconnected, PLAYERS[0]);
    reconnected.send({ type: 'match.subscribe', matchId: created.room.matchId });
    const resumed = await reconnected.waitFor<any>(message => (
      message.type === 'match.subscribed' || message.type === 'error'
    ));
    assert.equal(resumed.type, 'match.subscribed');
    assert.equal(resumed.match.battleInstanceId, live.room.battleInstanceId);
    assert.equal(resumed.match.status, 'completed');
    assert.equal(resumed.view.result.status, 'win');
    assert.equal(resumed.view.result.winner, PLAYERS[0]);
    reconnected.send({ type: 'match.subscribe', matchId: created.room.matchId });
    const second = await reconnected.waitFor<any>(message => message.type === 'match.subscribed');
    assert.equal(second.match.winner, PLAYERS[0]);
    assert.equal(await server.economics.getBalance(PLAYERS[0]), winnerBalance);
    assert.equal(await server.economics.getBalance(PLAYERS[1]), loserBalance);
    await reconnected.close();
  } finally {
    await opponent.close();
    await server.close();
  }
});
