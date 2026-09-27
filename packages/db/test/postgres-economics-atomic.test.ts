import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import { databaseConfig, migrate } from '../src/migrate';
import { creatorHoldKey, opponentHoldKey } from '../src/economics-store';
import { PostgresEconomicsStore } from '../src/postgres-economics-store';
import { PostgresTournamentStore } from '../src/postgres-tournament-store';

async function tryPool(): Promise<Pool | undefined> {
  const pool = new Pool(databaseConfig());
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    return undefined;
  }
}

function player(label: string): string {
  return `${label}-${randomUUID().replaceAll('-', '')}`.slice(0, 48);
}

test('postgres economics enforces atomic casual ops, concurrency, restart, and rollback', async t => {
  const pool = await tryPool();
  if (!pool) {
    t.skip('PostgreSQL is not reachable (set POKEARENA_DATABASE_URL). Live adapter tests were not executed.');
    return;
  }

  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }

  const store = new PostgresEconomicsStore(pool);
  const creator = player('creator');
  const opponent = player('opponent');
  const other = player('other');
  await store.credit(creator, 1_000_000);
  await store.credit(opponent, 1_000_000);
  await store.credit(other, 1_000_000);

  const roomId = randomUUID();
  await store.createCasualRoomWithHold({
    id: roomId,
    matchId: `casual-${roomId}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: creator,
    collateral: 100_000,
  });
  const created = await store.getCasualRoom(roomId);
  assert.equal(created?.status, 'open');
  assert.equal(await store.hasHold(creatorHoldKey(roomId)), true);
  assert.equal(await store.getBalance(creator), 900_000);

  await assert.rejects(
    () => store.acceptCasualRoomWithHold({ roomId, opponentId: opponent, collateral: 100_000_000 }),
    /Collateral exceeds/,
  );
  assert.equal((await store.getCasualRoom(roomId))?.opponentId, undefined);
  assert.equal(await store.getBalance(opponent), 1_000_000);
  assert.equal(await store.hasHold(opponentHoldKey(roomId)), false);

  const [first, second] = await Promise.allSettled([
    store.acceptCasualRoomWithHold({ roomId, opponentId: opponent, collateral: 100_000 }),
    store.acceptCasualRoomWithHold({ roomId, opponentId: other, collateral: 100_000 }),
  ]);
  const accepted = [first, second].filter(result => result.status === 'fulfilled');
  const rejected = [first, second].filter(result => result.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  const afterAccept = await store.getCasualRoom(roomId);
  assert.equal(afterAccept?.status, 'full');
  assert.equal(afterAccept?.opponentId, opponent);
  assert.equal(await store.getBalance(opponent), 900_000);
  assert.equal(await store.getBalance(other), 1_000_000);

  await store.acceptCasualRoomWithHold({ roomId, opponentId: opponent, collateral: 100_000 });
  assert.equal(await store.getBalance(opponent), 900_000);

  const [winA, winB] = await Promise.all([
    store.completeCasualWin({
      roomId,
      winnerId: creator,
      loserId: opponent,
      collateral: 100_000,
      reason: 'casual-win',
    }),
    store.completeCasualWin({
      roomId,
      winnerId: opponent,
      loserId: creator,
      collateral: 100_000,
      reason: 'casual-win',
    }),
  ]);
  assert.equal(winA.amount, winB.amount);
  assert.equal(winA.winnerId, winB.winnerId);
  assert.equal(winA.winnerId, creator);
  assert.equal(await store.getBalance(creator), 900_000 + 196_000);
  assert.equal(await store.getBalance(opponent), 900_000);
  const hold = await store.getHold(creatorHoldKey(roomId));
  assert.equal(hold?.status, 'consumed');
  const settlement = await store.getSettlement(`casual:${roomId}`);
  assert.equal(settlement?.amount, 196_000);

  const racedRoom = randomUUID();
  await store.createCasualRoomWithHold({
    id: racedRoom,
    matchId: `casual-${racedRoom}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: creator,
    collateral: 10_000,
  });
  await store.acceptCasualRoomWithHold({
    roomId: racedRoom,
    opponentId: opponent,
    collateral: 10_000,
  });
  const [cancelResult, settleResult] = await Promise.allSettled([
    store.cancelCasualRoom(racedRoom),
    store.completeCasualWin({
      roomId: racedRoom,
      winnerId: creator,
      loserId: opponent,
      collateral: 10_000,
      reason: 'casual-win',
    }),
  ]);
  assert.equal(
    [cancelResult, settleResult].filter(result => result.status === 'fulfilled').length,
    1,
  );
  const raced = await store.getCasualRoom(racedRoom);
  assert.ok(raced?.status === 'cancelled' || raced?.status === 'completed');
  if (raced?.status === 'cancelled') {
    assert.equal((await store.getHold(creatorHoldKey(racedRoom)))?.status, 'released');
    assert.equal(await store.getSettlement(`casual:${racedRoom}`), undefined);
  } else {
    assert.equal((await store.getHold(creatorHoldKey(racedRoom)))?.status, 'consumed');
    assert.ok(await store.getSettlement(`casual:${racedRoom}`));
  }

  const low = player('low');
  await store.credit(low, 5_000);
  const brokeRoom = randomUUID();
  await assert.rejects(() => store.createCasualRoomWithHold({
    id: brokeRoom,
    matchId: `casual-${brokeRoom}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: low,
    collateral: 10_000,
  }), /Collateral exceeds/);
  assert.equal(await store.getCasualRoom(brokeRoom), undefined);
  assert.equal(await store.getBalance(low), 5_000);
  assert.equal(await store.getHold(creatorHoldKey(brokeRoom)), undefined);

  const spend = player('spend');
  await store.credit(spend, 100_000);
  const roomA = randomUUID();
  const roomB = randomUUID();
  const [reserveA, reserveB] = await Promise.allSettled([
    store.createCasualRoomWithHold({
      id: roomA,
      matchId: `casual-${roomA}`,
      roomType: 'open',
      battleSize: '1v1',
      creatorId: spend,
      collateral: 100_000,
    }),
    store.createCasualRoomWithHold({
      id: roomB,
      matchId: `casual-${roomB}`,
      roomType: 'open',
      battleSize: '1v1',
      creatorId: spend,
      collateral: 100_000,
    }),
  ]);
  assert.equal([reserveA, reserveB].filter(result => result.status === 'fulfilled').length, 1);
  assert.equal([reserveA, reserveB].filter(result => result.status === 'rejected').length, 1);
  assert.equal(await store.getBalance(spend), 0);

  const failRoom = randomUUID();
  const failing = new PostgresEconomicsStore(pool, { failNext: 'commit' });
  await store.credit(creator, 50_000);
  const beforeFail = await store.getBalance(creator);
  await assert.rejects(() => failing.createCasualRoomWithHold({
    id: failRoom,
    matchId: `casual-${failRoom}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: creator,
    collateral: 50_000,
  }), /injected commit failure/);
  assert.equal(await store.getCasualRoom(failRoom), undefined);
  assert.equal(await store.getBalance(creator), beforeFail);

  const holdFailRoom = randomUUID();
  const holdFail = new PostgresEconomicsStore(pool, { failNext: 'insertHold' });
  await assert.rejects(() => holdFail.createCasualRoomWithHold({
    id: holdFailRoom,
    matchId: `casual-${holdFailRoom}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: creator,
    collateral: 50_000,
  }), /injected insertHold failure/);
  assert.equal(await store.getCasualRoom(holdFailRoom), undefined);
  assert.equal(await store.getBalance(creator), beforeFail);

  const debitFailRoom = randomUUID();
  const debitFail = new PostgresEconomicsStore(pool, { failNext: 'debit' });
  await assert.rejects(() => debitFail.createCasualRoomWithHold({
    id: debitFailRoom,
    matchId: `casual-${debitFailRoom}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: creator,
    collateral: 50_000,
  }), /injected debit failure/);
  assert.equal(await store.getCasualRoom(debitFailRoom), undefined);
  assert.equal(await store.getBalance(creator), beforeFail);

  const persistRoom = randomUUID();
  await store.createCasualRoomWithHold({
    id: persistRoom,
    matchId: `casual-${persistRoom}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: creator,
    collateral: 20_000,
  });
  await store.acceptCasualRoomWithHold({
    roomId: persistRoom,
    opponentId: opponent,
    collateral: 20_000,
  });
  await store.completeCasualTie({
    roomId: persistRoom,
    player1Id: creator,
    player2Id: opponent,
    collateral: 20_000,
  });
  const restarted = new PostgresEconomicsStore(pool);
  assert.equal(await restarted.getBalance(creator), await store.getBalance(creator));
  assert.equal((await restarted.getHold(creatorHoldKey(persistRoom)))?.status, 'consumed');
  assert.equal((await restarted.getSettlement(`casual:${persistRoom}`))?.reason, 'casual-tie');
  assert.equal((await restarted.getCasualRoom(persistRoom))?.status, 'completed');
  assert.equal((await restarted.getCasualRoom(persistRoom))?.winnerId, undefined);

  const tournamentId = randomUUID();
  const tournaments = new PostgresTournamentStore(pool);
  await tournaments.saveTournament({
    id: tournamentId,
    title: 'Settle Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'default',
    matchTimeoutMs: 300_000,
    status: 'registration',
    hostId: creator,
    entryFee: 10_000,
    players: [],
    matchIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const entryKey = `tournament:${tournamentId}:${creator}`;
  assert.equal(await store.reserve(entryKey, creator, 10_000), true);
  const payout = await store.completeTournamentWin({
    winnerId: creator,
    entryFee: 10_000,
    playerCount: 1,
    settlementKey: `tournament:${tournamentId}`,
    holdKeys: [entryKey],
  });
  const again = await store.completeTournamentWin({
    winnerId: other,
    entryFee: 10_000,
    playerCount: 1,
    settlementKey: `tournament:${tournamentId}`,
    holdKeys: [entryKey],
  });
  assert.equal(payout.amount, again.amount);
  assert.equal(payout.winnerId, creator);
  assert.equal((await restarted.getHold(entryKey))?.status, 'consumed');

  const settlementFailRoom = randomUUID();
  await store.createCasualRoomWithHold({
    id: settlementFailRoom,
    matchId: `casual-${settlementFailRoom}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: creator,
    collateral: 10_000,
  });
  await store.acceptCasualRoomWithHold({
    roomId: settlementFailRoom,
    opponentId: opponent,
    collateral: 10_000,
  });
  const beforeSettle = await store.getBalance(creator);
  const settleFail = new PostgresEconomicsStore(pool, { failNext: 'insertSettlement' });
  await assert.rejects(() => settleFail.completeCasualWin({
    roomId: settlementFailRoom,
    winnerId: creator,
    loserId: opponent,
    collateral: 10_000,
    reason: 'casual-win',
  }), /injected insertSettlement failure/);
  assert.equal(await store.getBalance(creator), beforeSettle);
  assert.equal((await store.getHold(creatorHoldKey(settlementFailRoom)))?.status, 'reserved');
  assert.equal(await store.getSettlement(`casual:${settlementFailRoom}`), undefined);

  await pool.end();
});
