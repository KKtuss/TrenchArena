import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';

import type { BattleEngine, BattleTerminal } from '@pokearena/battle-engine';
import { WebSocket } from 'ws';

import {
  CasualNotReadyError,
  CasualRoomService,
} from '../src/casual-service';
import { DEMO_TEAM_ONE } from '../src/demo-teams';
import { DEFAULT_DEV_BALANCE_POKE, MockEconomics } from '../src/mock-economics';
import { ApiServer } from '../src/server';
import { encodeBase58 } from '../src/wallet-auth';
import { bothConfirmCasual, openFullCasualRoom } from './casual-flow';

const COLLATERAL = 1_000;

async function openReadyRoom(casual: CasualRoomService, collateral = COLLATERAL) {
  const room = await openFullCasualRoom(casual, 'demo-player-1', 'demo-player-2', collateral);
  bothConfirmCasual(casual, room.id);
  return casual.getRoom(room.id);
}

test('one balance cannot reserve two casual rooms', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });
  const first = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 6_000_000,
  });
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 6_000_000);
  await assert.rejects(() => casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 6_000_000,
  }), /Collateral exceeds/);
  assert.equal(casual.listOpenRooms().length, 1);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 6_000_000);
  assert.equal(economics.hasHold(`casual:${first.id}:creator`), true);

  await casual.cancelRoom(first.id, 'demo-player-1');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.hasHold(`casual:${first.id}:creator`), false);
  const second = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 6_000_000,
  });
  assert.equal(second.status, 'open');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 6_000_000);
});

test('an opponent who cannot pay does not take the seat or the creator stake', async () => {
  const economics = new MockEconomics();
  economics.lockCollateral('demo-player-2', 10_000_000);
  const casual = new CasualRoomService({ economics });
  const room = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: COLLATERAL,
  });
  await assert.rejects(() => casual.acceptRoom(room.id, 'demo-player-2'), /Collateral exceeds/);
  const stored = casual.getRoom(room.id);
  assert.equal(stored.status, 'open');
  assert.equal(stored.opponentId, undefined);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance('demo-player-2'), 0);
  assert.equal(economics.hasHold(`casual:${room.id}:opponent`), false);
});

test('cancel refunds each reserved player once', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });
  const open = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: COLLATERAL,
  });
  await casual.cancelRoom(open.id, 'demo-player-1');
  await casual.cancelRoom(open.id, 'demo-player-1');
  assert.equal(casual.getRoom(open.id).status, 'cancelled');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);

  const full = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: COLLATERAL,
  });
  await casual.acceptRoom(full.id, 'demo-player-2');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - COLLATERAL);
  await casual.cancelRoom(full.id, 'demo-player-2');
  await casual.cancelRoom(full.id, 'demo-player-1');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);
});

test('an unsupported 2v2 start keeps the existing reservations until cancel', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics, allowDemoAuth: true });
  const room = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '2v2',
    collateral: COLLATERAL,
  });
  await casual.acceptRoom(room.id, 'demo-player-2');
  casual.setReady(room.id, 'demo-player-1', true);
  casual.setReady(room.id, 'demo-player-2', true);
  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), /2v2 battles are not supported/);
  assert.equal(casual.getRoom(room.id).status, 'ready');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - COLLATERAL);
  await casual.cancelRoom(room.id, 'demo-player-1');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);
});

test('a start that fails before the battle is live refunds both stakes once', async () => {
  const economics = new MockEconomics();
  const battleEngine = {
    async createBattle() {
      throw new Error('sim down');
    },
  } as unknown as BattleEngine;
  const casual = new CasualRoomService({ economics, battleEngine, allowDemoAuth: true });
  const room = await openReadyRoom(casual);
  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), /sim down/);
  assert.equal(casual.getRoom(room.id).status, 'cancelled');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);
  assert.equal(economics.hasHold(`casual:${room.id}:creator`), false);
  assert.equal(economics.hasHold(`casual:${room.id}:opponent`), false);

  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), CasualNotReadyError);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);

  const retry = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: COLLATERAL,
  });
  assert.equal(retry.status, 'open');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);
});

test('two starts share one battle and a pre-live failure refunds once', async () => {
  const economics = new MockEconomics();
  let calls = 0;
  let continueBattle!: () => void;
  const gate = new Promise<void>(resolve => {
    continueBattle = resolve;
  });
  const battleEngine = {
    async createBattle() {
      calls += 1;
      await gate;
      throw new Error('sim down');
    },
  } as unknown as BattleEngine;
  const casual = new CasualRoomService({ economics, battleEngine, allowDemoAuth: true });
  const room = await openReadyRoom(casual, 100_000);
  const pending = Promise.all([
    casual.startBattle(room.id, 'demo-player-1'),
    casual.startBattle(room.id, 'demo-player-2'),
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(casual.getRoom(room.id).status, 'starting');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 100_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - 100_000);

  continueBattle();
  await assert.rejects(pending, /sim down/);
  assert.equal(casual.getRoom(room.id).status, 'cancelled');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);
  assert.equal(calls, 1);
});

test('a live failure refunds the reserved stakes once', async () => {
  const economics = new MockEconomics();
  const battleEngine = {
    async createBattle() {
      return {
        id: 'stake-fail',
        async start() {},
        getResult: () => undefined,
        getState: () => ({
          id: 'stake-fail',
          lifecycle: 'failed',
          failure: { code: 'simulator-error', message: 'down' },
        }),
        subscribe(listener: (terminal: BattleTerminal) => void) {
          const failure: BattleTerminal = {
            type: 'failed',
            failure: { code: 'simulator-error', message: 'down' },
          };
          listener(failure);
          listener(failure);
          return () => {};
        },
        subscribeEvents() {
          return () => {};
        },
      };
    },
  } as unknown as BattleEngine;
  const casual = new CasualRoomService({ economics, battleEngine, allowDemoAuth: true });
  const room = await openReadyRoom(casual, 100_000);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(started.status, 'cancelled');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);
});

test('a casual win pays the pot minus the 2% fee once', async () => {
  const economics = new MockEconomics();
  const win: BattleTerminal = {
    type: 'completed',
    result: { status: 'win', winner: 'demo-player-1', score: [1, 0], turns: 1 },
  };
  const battleEngine = {
    async createBattle() {
      return {
        id: 'stake-win',
        async start() {},
        getResult: () => win.result,
        getState: () => ({
          id: 'stake-win',
          lifecycle: 'ended',
          result: win.result,
        }),
        subscribe(listener: (terminal: BattleTerminal) => void) {
          listener(win);
          listener(win);
          return () => {};
        },
        subscribeEvents() {
          return () => {};
        },
      };
    },
  } as unknown as BattleEngine;
  const casual = new CasualRoomService({ economics, battleEngine, allowDemoAuth: true });
  const room = await openReadyRoom(casual, 100_000);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(started.status, 'completed');
  assert.equal(started.payout?.amount, 196_000);
  assert.equal(started.payout?.protocolFee, 4_000);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 100_000 + 196_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - 100_000);
  assert.equal(economics.hasHold(`casual:${room.id}:creator`), false);
  assert.equal(economics.release(`casual:${room.id}:creator`), 0);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 100_000 + 196_000);
});

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

test('the dev faucet follows demo auth and production wallets stay at zero', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const client = new TestClient(port);
  const keypair = createSolanaKeypair();
  try {
    await client.open();
    client.send({ type: 'auth.challenge', address: keypair.address });
    const challenge = await client.waitFor<any>(message => message.type === 'auth.challenge');
    client.send({
      type: 'auth.verify',
      address: keypair.address,
      signature: signMessage(keypair.privateKey, challenge.message),
      nonce: challenge.nonce,
    });
    const snapshot = await client.waitFor<any>(message => message.type === 'arena.snapshot');
    assert.equal(snapshot.snapshot.wallet.balance, DEFAULT_DEV_BALANCE_POKE);
    assert.equal(snapshot.snapshot.wallet.eligible, true);
    assert.equal((await server.economics.ensureWallet(keypair.address)).balance, DEFAULT_DEV_BALANCE_POKE);
  } finally {
    await client.close();
    await server.close();
  }
});

async function identifyDemo(client: TestClient, playerId: 'demo-player-1' | 'demo-player-2'): Promise<void> {
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

test('tournament entry is reserved with registration and released when registration fails', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  try {
    await creator.open();
    await identifyDemo(creator, 'demo-player-1');

    await server.economics.lockCollateral('demo-player-1', DEFAULT_DEV_BALANCE_POKE);
    creator.send({ type: 'tournament.create', title: 'Empty Cup', maxPlayers: 4, entryFee: 50_000 });
    const broke = await creator.waitFor<any>(message => message.type === 'tournament.created');
    creator.send({ type: 'tournament.join', tournamentId: broke.tournament.id, team: DEMO_TEAM_ONE });
    const denied = await creator.waitFor<any>(message => message.type === 'error');
    assert.match(denied.message, /Collateral exceeds/);
    creator.send({ type: 'tournament.subscribe', tournamentId: broke.tournament.id });
    const empty = await creator.waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.id === broke.tournament.id
    ));
    assert.equal(empty.tournament.players?.length ?? 0, 0);
    assert.equal(await server.economics.getBalance('demo-player-1'), 0);
    assert.equal(await server.economics.hasHold(`tournament:${broke.tournament.id}:demo-player-1`), false);

    await server.economics.credit('demo-player-1', 50_000);
    creator.send({ type: 'tournament.create', title: 'Paid Cup', maxPlayers: 4, entryFee: 50_000 });
    const paid = await creator.waitFor<any>(message => (
      message.type === 'tournament.created' && message.tournament.title === 'Paid Cup'
    ));
    creator.send({ type: 'tournament.join', tournamentId: paid.tournament.id, team: DEMO_TEAM_ONE });
    const seated = await creator.waitFor<any>(message => (
      message.type === 'tournament.state'
      && message.tournament.id === paid.tournament.id
      && message.tournament.players?.length === 1
    ));
    assert.equal(seated.tournament.players.length, 1);
    assert.equal(await server.economics.getBalance('demo-player-1'), 0);
    assert.equal(await server.economics.hasHold(`tournament:${paid.tournament.id}:demo-player-1`), true);

    creator.send({ type: 'tournament.join', tournamentId: paid.tournament.id, team: DEMO_TEAM_ONE });
    const duplicate = await creator.waitFor<any>(message => message.code === 'DuplicateRegistrationError');
    assert.equal(duplicate.code, 'DuplicateRegistrationError');
    assert.equal(await server.economics.getBalance('demo-player-1'), 0);
    assert.equal(await server.economics.hasHold(`tournament:${paid.tournament.id}:demo-player-1`), true);

    creator.send({ type: 'tournament.create', title: 'Second Cup', maxPlayers: 4, entryFee: 50_000 });
    const second = await creator.waitFor<any>(message => (
      message.type === 'tournament.created' && message.tournament.title === 'Second Cup'
    ));
    creator.send({ type: 'tournament.join', tournamentId: second.tournament.id, team: DEMO_TEAM_ONE });
    const secondJoin = await creator.waitFor<any>(message => message.message?.includes('Collateral'));
    assert.equal(secondJoin.type, 'error');
    assert.equal(await server.economics.getBalance('demo-player-1'), 0);
    assert.equal(await server.economics.hasHold(`tournament:${paid.tournament.id}:demo-player-1`), true);
    assert.equal(await server.economics.hasHold(`tournament:${second.tournament.id}:demo-player-1`), false);
  } finally {
    await creator.close();
    await server.close();
  }
});

test('a full tournament refunds only the rejected joiner', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const seats = [new TestClient(port), new TestClient(port), new TestClient(port), new TestClient(port)];
  const rejected = new TestClient(port);
  const wallets = [createSolanaKeypair(), createSolanaKeypair(), createSolanaKeypair()];
  try {
    await Promise.all([...seats, rejected].map(client => client.open()));
    await identifyDemo(seats[0], 'demo-player-1');
    await identifyDemo(seats[1], 'demo-player-2');
    await authenticate(seats[2], wallets[0]);
    await authenticate(seats[3], wallets[1]);
    await authenticate(rejected, wallets[2]);

    seats[0].send({ type: 'tournament.create', title: 'Full Cup', maxPlayers: 4, entryFee: 50_000 });
    const created = await seats[0].waitFor<any>(message => message.type === 'tournament.created');
    const tournamentId = created.tournament.id;
    for (const client of seats) {
      client.send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_ONE });
    }
    await seats[0].waitFor<any>(message => (
      message.type === 'tournament.state'
      && message.tournament.id === tournamentId
      && message.tournament.players?.length === 4
    ));

    const balanceBefore = await server.economics.getBalance(wallets[2].address);
    rejected.send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_ONE });
    const full = await rejected.waitFor<any>(message => message.type === 'error');
    assert.match(full.message, /player limit/);
    assert.equal(await server.economics.getBalance(wallets[2].address), balanceBefore);
    assert.equal(await server.economics.hasHold('tournament:' + tournamentId + ':' + wallets[2].address), false);
    assert.equal(await server.economics.getBalance('demo-player-1'), DEFAULT_DEV_BALANCE_POKE - 50_000);
    assert.equal(await server.economics.hasHold('tournament:' + tournamentId + ':demo-player-1'), true);
    assert.equal((await server.tournaments.getTournament(tournamentId)).players.length, 4);
  } finally {
    await Promise.all([...seats, rejected].map(client => client.close()));
    await server.close();
  }
});
