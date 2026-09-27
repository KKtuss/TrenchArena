import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryEconomicsStore } from '../src/memory-economics-store';
import { MockEconomics } from '../src/mock-economics';
import {
  EconomicsUnavailableError,
  resolveEconomicsBackend,
} from '../src/economics-runtime';
import { ApiServer } from '../src/server';
import { CasualRoomService } from '../src/casual-service';

test('in-memory economics store preserves reserve, release, consume, and settlement semantics', async () => {
  const store = new InMemoryEconomicsStore(new MockEconomics());
  assert.equal(await store.reserve('creator', 'demo-player-1', 100_000), true);
  assert.equal(await store.reserve('creator', 'demo-player-1', 100_000), false);
  assert.equal(await store.getBalance('demo-player-1'), 10_000_000 - 100_000);
  assert.equal(await store.hasHold('creator'), true);
  await store.consume('creator');
  assert.equal(await store.hasHold('creator'), false);
  assert.equal(await store.release('creator'), 0);

  await store.reserve('creator', 'demo-player-1', 100_000);
  await store.reserve('opponent', 'demo-player-2', 100_000);
  await store.consume('creator');
  await store.consume('opponent');
  const payout = await store.settleCasualWin({
    winnerId: 'demo-player-1',
    loserId: 'demo-player-2',
    collateral: 100_000,
    settlementKey: 'casual-test',
  });
  const repeat = await store.settleCasualWin({
    winnerId: 'demo-player-1',
    loserId: 'demo-player-2',
    collateral: 100_000,
    settlementKey: 'casual-test',
  });
  assert.equal(payout.amount, 196_000);
  assert.equal(repeat.amount, payout.amount);
  assert.equal(await store.getBalance('demo-player-1'), 10_000_000 - 200_000 + 196_000);
});

test('in-memory casual room+hold and settlement are idempotent', async () => {
  const store = new InMemoryEconomicsStore(new MockEconomics());
  const id = '11111111-1111-4111-8111-111111111111';
  await store.createCasualRoomWithHold({
    id,
    matchId: `casual-${id}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: 'demo-player-1',
    collateral: 100_000,
  });
  await store.acceptCasualRoomWithHold({
    roomId: id,
    opponentId: 'demo-player-2',
    collateral: 100_000,
  });
  const first = await store.completeCasualWin({
    roomId: id,
    winnerId: 'demo-player-1',
    loserId: 'demo-player-2',
    collateral: 100_000,
    reason: 'casual-win',
  });
  const second = await store.completeCasualWin({
    roomId: id,
    winnerId: 'demo-player-2',
    loserId: 'demo-player-1',
    collateral: 100_000,
    reason: 'casual-win',
  });
  assert.equal(first.winnerId, 'demo-player-1');
  assert.equal(second.winnerId, 'demo-player-1');
  assert.equal(await store.getBalance('demo-player-1'), 10_000_000 - 100_000 + 196_000);
  assert.equal(await store.getBalance('demo-player-2'), 10_000_000 - 100_000);
});

test('development defaults to in-memory economics and production refuses the fallback', () => {
  assert.equal(resolveEconomicsBackend({}), 'memory');
  assert.equal(resolveEconomicsBackend({ POKEARENA_ECONOMICS: 'memory' }), 'memory');
  assert.equal(resolveEconomicsBackend({ NODE_ENV: 'production' }), 'postgres');
  assert.equal(resolveEconomicsBackend({ POKEARENA_ECONOMICS: 'postgres' }), 'postgres');
  assert.throws(
    () => resolveEconomicsBackend({ NODE_ENV: 'production', POKEARENA_ECONOMICS: 'memory' }),
    EconomicsUnavailableError,
  );
  const previous = process.env.POKEARENA_ECONOMICS;
  process.env.POKEARENA_ECONOMICS = 'postgres';
  try {
    assert.throws(
      () => new ApiServer({ allowDemoAuth: true, originMode: 'development' }),
      /PostgreSQL economics is required/,
    );
  } finally {
    if (previous === undefined) delete process.env.POKEARENA_ECONOMICS;
    else process.env.POKEARENA_ECONOMICS = previous;
  }
});

test('constructing ApiServer without options uses in-memory economics outside production', async () => {
  const economicsFlag = process.env.POKEARENA_ECONOMICS;
  delete process.env.POKEARENA_ECONOMICS;
  try {
    if (resolveEconomicsBackend() === 'postgres') return;
    const server = new ApiServer({ allowDemoAuth: true });
    assert.equal(await server.economics.getBalance('demo-player-1'), 10_000_000);
    await server.close();
  } finally {
    if (economicsFlag === undefined) delete process.env.POKEARENA_ECONOMICS;
    else process.env.POKEARENA_ECONOMICS = economicsFlag;
  }
});

test('concurrent in-memory accept cannot seat two opponents', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });
  const room = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 100_000,
  });
  const results = await Promise.allSettled([
    casual.acceptRoom(room.id, 'demo-player-2'),
    casual.acceptRoom(room.id, 'WalletOpponent11111111111111111111111'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(casual.getRoom(room.id).opponentId, 'demo-player-2');
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - 100_000);
  assert.equal(economics.hasHold(`casual:${room.id}:opponent`), true);
});
