import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Keypair, PublicKey } from '@solana/web3.js';
import { WebSocket } from 'ws';

import type { ArenaChainClient } from '@pokearena/solana-client';
import { ChainEconomyService } from '../src/chain-economy';
import { InMemoryEconomicsStore } from '../src/memory-economics-store';
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

test('SOL reconciliation coalesces reads and makes a deposited private room visible', async () => {
  const keeper = Keypair.generate();
  const programId = Keypair.generate().publicKey;
  let escrowReads = 0;
  const client = {
    configAddress: Keypair.generate().publicKey,
    getMatchEscrowState: async () => {
      escrowReads += 1;
      return {
        creator: keeper.publicKey,
        opponent: PublicKey.default,
        collateralLamports: 1_000_000n,
        creatorDeposited: true,
        opponentDeposited: false,
        feeCharged: false,
        status: 1,
      };
    },
  } as unknown as ArenaChainClient;
  const chainEconomy = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'localnet',
      POKEARENA_PROGRAM_ID: programId.toBase58(),
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
    },
    client,
    keeper,
  });
  const server = new ApiServer({
    allowDemoAuth: true,
    economics: new InMemoryEconomicsStore(),
    chainEconomy,
  });
  await server.listen(0);
  const invitedPlayerId = Keypair.generate().publicKey.toBase58();
  const room = await server.casual.createRoom({
    creatorId: keeper.publicKey.toBase58(),
    roomType: 'private',
    battleSize: '1v1',
    collateral: 1_000_000,
    invitedPlayerId,
    rail: 'sol_chain',
  });

  await Promise.all([
    (server as any).reconcileSolRoom(room.id),
    (server as any).reconcileSolRoom(room.id),
  ]);

  assert.equal(escrowReads, 1);
  assert.equal(server.casual.getRoom(room.id).status, 'open');
  assert.equal(server.casual.listOpenRooms(invitedPlayerId).some(item => item.id === room.id), true);
  await server.close();
});

test('SOL reconciliation opens the casual draft after both deposits', async () => {
  const keeper = Keypair.generate();
  const creator = Keypair.generate();
  const opponent = Keypair.generate();
  const programId = Keypair.generate().publicKey;
  const client = {
    configAddress: Keypair.generate().publicKey,
    getMatchEscrowState: async () => ({
      creator: creator.publicKey,
      opponent: opponent.publicKey,
      collateralLamports: 1_000_000n,
      creatorDeposited: true,
      opponentDeposited: true,
      feeCharged: false,
      status: 1,
    }),
  } as unknown as ArenaChainClient;
  const chainEconomy = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'localnet',
      POKEARENA_PROGRAM_ID: programId.toBase58(),
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
    },
    client,
    keeper,
  });
  const server = new ApiServer({
    allowDemoAuth: true,
    economics: new InMemoryEconomicsStore(),
    chainEconomy,
  });
  const room = await server.casual.createRoom({
    creatorId: creator.publicKey.toBase58(),
    roomType: 'private',
    battleSize: '1v1',
    collateral: 1_000_000,
    invitedPlayerId: opponent.publicKey.toBase58(),
    rail: 'sol_chain',
  });
  server.casual.markSolDeposit(room.id, 'creator');
  await server.casual.acceptRoom(room.id, opponent.publicKey.toBase58());
  assert.equal(server.casual.getRoom(room.id).status, 'full');

  await (server as any).reconcileSolRoom(room.id);

  const advanced = server.casual.getRoom(room.id, creator.publicKey.toBase58());
  assert.equal(advanced.deposits?.creator, true);
  assert.equal(advanced.deposits?.opponent, true);
  assert.equal(advanced.status, 'drafting');
  assert.equal(advanced.teamPreview?.length, 2);
  await server.close();
});

test('product flow exposes arena snapshot, casual rooms, battle view, and tournament discovery', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
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
    message.type === 'casual.state' && message.room.status === 'drafting'
  ))));
  clients[0].send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
  clients[1].send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
  await Promise.all(clients.map(client => client.waitFor(message => (
    message.type === 'casual.state'
    && message.room.teamPreview?.every((preview: { confirmed?: boolean }) => preview.confirmed)
  ))));

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

  clients[0].send({ type: 'casual.forfeit', roomId: created.room.id });
  await Promise.all(clients.map(client => client.waitFor(message => (
    message.type === 'casual.state' && message.room.id === created.room.id && message.room.status === 'completed'
  ))));

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

test('websocket Casual views hide opponent picks until both confirm and keep assigned presets', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
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
    collateral: 1_000,
  });
  const created = await clients[0].waitFor<any>(message => message.type === 'casual.created');
  const roomId = created.room.id;
  clients[1].send({ type: 'casual.accept', roomId });
  const accepted = await Promise.all(clients.map(client => client.waitFor<any>(message => (
    message.type === 'casual.state' && message.room.id === roomId && message.room.status === 'full'
  ))));
  assert.equal(accepted[0].room.teamPreview, undefined);

  clients[0].send({ type: 'casual.ready', roomId, ready: true });
  clients[1].send({ type: 'casual.ready', roomId, ready: true });
  const dealt = await Promise.all(clients.map(client => client.waitFor<any>(message => (
    message.type === 'casual.state' && message.room.id === roomId && message.room.status === 'drafting'
  ))));
  const creatorPreset = dealt[0].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.presetId;
  const opponentPreset = dealt[0].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-2')?.presetId;
  assert.ok(creatorPreset);
  assert.equal(creatorPreset, opponentPreset);
  assert.deepEqual(
    dealt[1].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-2')?.pokemon.map((mon: { species: string }) => mon.species),
    dealt[0].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.pokemon.map((mon: { species: string }) => mon.species),
  );

  clients[0].send({ type: 'casual.select', roomId, slots: [0, 2, 4], confirm: true });
  const afterCreator = await Promise.all(clients.map(client => client.waitFor<any>(message => (
    message.type === 'casual.state'
    && message.room.id === roomId
    && message.room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.confirmed === true
  ))));
  assert.deepEqual(
    afterCreator[0].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.selectedSlots,
    [0, 2, 4],
  );
  assert.equal(
    afterCreator[0].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-2')?.selectedSlots,
    undefined,
  );
  assert.equal(
    afterCreator[1].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.selectedSlots,
    undefined,
  );
  assert.equal(afterCreator[1].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.confirmed, true);

  clients[0].send({ type: 'casual.subscribe', roomId });
  const reconnect = await clients[0].waitFor<any>(message => (
    message.type === 'casual.state'
    && message.room.id === roomId
    && JSON.stringify(message.room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.selectedSlots) === JSON.stringify([0, 2, 4])
  ));
  assert.equal(
    reconnect.room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.presetId,
    creatorPreset,
  );
  assert.equal(
    reconnect.room.teamPreview?.find((item: any) => item.playerId === 'demo-player-2')?.presetId,
    opponentPreset,
  );
  assert.deepEqual(
    reconnect.room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.selectedSlots,
    [0, 2, 4],
  );

  clients[1].send({ type: 'casual.select', roomId, slots: [1, 3, 5], confirm: true });
  const revealed = await Promise.all(clients.map(client => client.waitFor<any>(message => (
    message.type === 'casual.state'
    && message.room.id === roomId
    && message.room.teamPreview?.every((item: any) => item.confirmed)
  ))));
  assert.deepEqual(
    revealed[0].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.selectedSlots,
    [0, 2, 4],
  );
  assert.deepEqual(
    revealed[0].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-2')?.selectedSlots,
    [1, 3, 5],
  );
  assert.deepEqual(
    revealed[1].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-1')?.selectedSlots,
    [0, 2, 4],
  );
  assert.deepEqual(
    revealed[1].room.teamPreview?.find((item: any) => item.playerId === 'demo-player-2')?.selectedSlots,
    [1, 3, 5],
  );

  await Promise.all(clients.map(client => client.close()));
  await server.close();
});

test('stale casual choices are rejected and valid choices are accepted', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
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
    message.type === 'casual.state' && message.room.status === 'drafting'
  ))));
  clients[0].send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
  clients[1].send({ type: 'casual.select', roomId: created.room.id, slots: [0, 1, 2], confirm: true });
  await Promise.all(clients.map(client => client.waitFor(message => (
    message.type === 'casual.state'
    && message.room.teamPreview?.every((preview: { confirmed?: boolean }) => preview.confirmed)
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
