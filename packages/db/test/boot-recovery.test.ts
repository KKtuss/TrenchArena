import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import { recoverDurableState, RecoveryFailedError } from '../src/boot-recovery';
import { previewTournament } from '../src/economics-math';
import { databaseConfig, migrate } from '../src/migrate';
import { PostgresEconomicsStore } from '../src/postgres-economics-store';
import { PostgresTournamentStore } from '../src/postgres-tournament-store';
import type { DurableTournament, DurableTournamentMatch } from '../src/tournament-store';

const silent = (): void => undefined;
const FEE = 50_000;

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

function wallet(): string {
  return `player-${randomUUID().replaceAll('-', '')}aaaaaaaa`;
}

function baseTournament(overrides: Partial<DurableTournament> = {}): DurableTournament {
  const now = Date.now();
  return {
    id: randomUUID(),
    title: 'PG Recovery Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'default',
    matchTimeoutMs: 300_000,
    status: 'registration',
    hostId: wallet(),
    entryFee: FEE,
    players: [],
    matchIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function registerFour(
  store: PostgresTournamentStore,
  economics: PostgresEconomicsStore,
  tournament: DurableTournament,
  players: string[],
): Promise<void> {
  await economics.credit(tournament.hostId, 1_000_000);
  for (const [index, playerId] of players.entries()) {
    await economics.credit(playerId, 1_000_000);
    await store.registerPlayer({
      tournamentId: tournament.id,
      playerId,
      displayName: `P${index}`,
      team: `team-${index}`,
    });
  }
}

async function markCompleted(
  store: PostgresTournamentStore,
  tournamentId: string,
  winnerId: string,
): Promise<void> {
  const tournament = await store.getTournament(tournamentId);
  assert.ok(tournament);
  await store.saveTournament({
    ...tournament,
    status: 'completed',
    winner: winnerId,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

test('postgres boot recovery settles, interrupts, and stays idempotent', async t => {
  const pool = await tryPool();
  if (!pool) {
    t.skip('PostgreSQL is not reachable (set POKEARENA_DATABASE_URL). Live recovery tests were not executed.');
    return;
  }

  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }

  const economics = new PostgresEconomicsStore(pool);
  const store = new PostgresTournamentStore(pool);

  await t.test('completed + unsettled settles once; rerun and concurrent recovery do not double-pay', async () => {
    const hostId = wallet();
    const players = [wallet(), wallet(), wallet(), wallet()];
    const tournament = baseTournament({ hostId });
    await store.saveTournament(tournament);
    await registerFour(store, economics, tournament, players);
    await markCompleted(store, tournament.id, players[0]!);
    const prize = previewTournament(FEE, 4).prizePool;
    const before = await economics.getBalance(players[0]!);
    await recoverDurableState({ economics, tournaments: store, logger: silent });
    assert.equal((await economics.getSettlement(`tournament:${tournament.id}`))?.winnerId, players[0]);
    assert.equal(await economics.getBalance(players[0]!), before + prize);
    await Promise.all([
      recoverDurableState({ economics, tournaments: store, logger: silent }),
      recoverDurableState({ economics, tournaments: store, logger: silent }),
    ]);
    assert.equal(await economics.getBalance(players[0]!), before + prize);
    const again = await economics.completeTournamentWin({
      winnerId: players[0]!,
      entryFee: FEE,
      playerCount: 4,
      settlementKey: `tournament:${tournament.id}`,
      holdKeys: players.map(playerId => `tournament:${tournament.id}:${playerId}`),
    });
    assert.equal(again.amount, prize);
    assert.equal(await economics.getBalance(players[0]!), before + prize);
    for (const playerId of players) {
      assert.equal((await economics.getHold(`tournament:${tournament.id}:${playerId}`))?.status, 'consumed');
    }
  });

  await t.test('already settled and cancelled tournaments are not paid again', async () => {
    const hostId = wallet();
    const settledPlayers = [wallet(), wallet(), wallet(), wallet()];
    const cancelledPlayers = [wallet(), wallet(), wallet(), wallet()];
    const settled = baseTournament({ hostId, title: 'Already paid' });
    await store.saveTournament(settled);
    await registerFour(store, economics, settled, settledPlayers);
    await markCompleted(store, settled.id, settledPlayers[0]!);
    await economics.completeTournamentWin({
      winnerId: settledPlayers[0]!,
      entryFee: FEE,
      playerCount: 4,
      settlementKey: `tournament:${settled.id}`,
      holdKeys: settledPlayers.map(playerId => `tournament:${settled.id}:${playerId}`),
    });
    const paid = await economics.getBalance(settledPlayers[0]!);

    const cancelled = baseTournament({ hostId, title: 'Cancelled' });
    await store.saveTournament(cancelled);
    await registerFour(store, economics, cancelled, cancelledPlayers);
    const row = await store.getTournament(cancelled.id);
    assert.ok(row);
    await store.saveTournament({ ...row, status: 'cancelled', updatedAt: Date.now() });
    const cancelledBalance = await economics.getBalance(cancelledPlayers[0]!);

    await recoverDurableState({ economics, tournaments: store, logger: silent });
    assert.equal(await economics.getBalance(settledPlayers[0]!), paid);
    assert.equal(await economics.getSettlement(`tournament:${cancelled.id}`), undefined);
    assert.equal(await economics.getBalance(cancelledPlayers[0]!), cancelledBalance);
    assert.equal((await economics.getHold(`tournament:${cancelled.id}:${cancelledPlayers[0]}`))?.status, 'reserved');
  });

  await t.test('injected crash after first settlement is safe to rerun', async () => {
    const hostId = wallet();
    const firstPlayers = [wallet(), wallet(), wallet(), wallet()];
    const secondPlayers = [wallet(), wallet(), wallet(), wallet()];
    const first = baseTournament({ hostId, title: 'Crash A' });
    const second = baseTournament({ hostId, title: 'Crash B' });
    await store.saveTournament(first);
    await store.saveTournament(second);
    await registerFour(store, economics, first, firstPlayers);
    await registerFour(store, economics, second, secondPlayers);
    await markCompleted(store, first.id, firstPlayers[0]!);
    await markCompleted(store, second.id, secondPlayers[0]!);
    let settled = 0;
    await assert.rejects(
      () => recoverDurableState({
        economics,
        tournaments: store,
        logger: silent,
        afterSettleTournament: () => {
          settled += 1;
          if (settled === 1) throw new Error('injected crash');
        },
      }),
      RecoveryFailedError,
    );
    const firstPaid = Boolean(await economics.getSettlement(`tournament:${first.id}`));
    const secondPaid = Boolean(await economics.getSettlement(`tournament:${second.id}`));
    assert.equal(firstPaid !== secondPaid, true);
    const prize = previewTournament(FEE, 4).prizePool;
    const firstBefore = await economics.getBalance(firstPlayers[0]!);
    const secondBefore = await economics.getBalance(secondPlayers[0]!);
    await recoverDurableState({ economics, tournaments: store, logger: silent });
    assert.ok(await economics.getSettlement(`tournament:${first.id}`));
    assert.ok(await economics.getSettlement(`tournament:${second.id}`));
    if (firstPaid) {
      assert.equal(await economics.getBalance(firstPlayers[0]!), firstBefore);
      assert.equal(await economics.getBalance(secondPlayers[0]!), secondBefore + prize);
    } else {
      assert.equal(await economics.getBalance(secondPlayers[0]!), secondBefore);
      assert.equal(await economics.getBalance(firstPlayers[0]!), firstBefore + prize);
    }
  });

  await t.test('interrupted live matches do not invent a winner; tied and terminal stay put', async () => {
    const hostId = wallet();
    const players = [wallet(), wallet(), wallet(), wallet()];
    const tournament = baseTournament({ hostId });
    await store.saveTournament(tournament);
    await registerFour(store, economics, tournament, players);
    const loaded = await store.getTournament(tournament.id);
    assert.ok(loaded);
    await store.saveTournament({
      ...loaded,
      status: 'in-progress',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const now = Date.now();
    const created: DurableTournamentMatch = {
      id: randomUUID(),
      tournamentId: tournament.id,
      round: 1,
      bracketPosition: 0,
      player1: players[0],
      player2: players[1],
      status: 'battle-created',
      battleInstanceId: 'gone-created',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    const active: DurableTournamentMatch = {
      id: randomUUID(),
      tournamentId: tournament.id,
      round: 1,
      bracketPosition: 1,
      player1: players[2],
      player2: players[3],
      status: 'active',
      battleInstanceId: 'gone-active',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    const tied: DurableTournamentMatch = {
      id: randomUUID(),
      tournamentId: tournament.id,
      round: 2,
      bracketPosition: 0,
      status: 'tied',
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    };
    const terminal: DurableTournamentMatch = {
      id: randomUUID(),
      tournamentId: tournament.id,
      round: 2,
      bracketPosition: 1,
      player1: players[0],
      player2: players[1],
      status: 'completed',
      winner: players[0],
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    };
    await store.saveMatch(created);
    await store.saveMatch(active);
    await store.saveMatch(tied);
    await store.saveMatch(terminal);
    await recoverDurableState({ economics, tournaments: store, logger: silent });
    assert.equal((await store.getMatch(created.id))?.status, 'interrupted');
    assert.equal((await store.getMatch(created.id))?.winner, undefined);
    assert.equal((await store.getMatch(active.id))?.status, 'interrupted');
    assert.equal((await store.getMatch(active.id))?.winner, undefined);
    assert.equal((await store.getMatch(tied.id))?.status, 'tied');
    assert.equal((await store.getMatch(terminal.id))?.status, 'completed');
    assert.equal((await store.getMatch(terminal.id))?.winner, players[0]);
    const resumed = await store.beginMatchStart(created.id);
    assert.equal(resumed.status, 'battle-created');
    assert.equal(resumed.winner, undefined);
    const reconstructed = await store.getTournament(tournament.id);
    assert.equal(reconstructed?.hostId, hostId);
    assert.equal(reconstructed?.entryFee, FEE);
    assert.equal(reconstructed?.players.length, 4);
  });

  await t.test('orphan reserved hold is released once', async () => {
    const hostId = wallet();
    const players = [wallet(), wallet()];
    const orphan = wallet();
    const tournament = baseTournament({ hostId });
    await store.saveTournament(tournament);
    await economics.credit(hostId, 1_000_000);
    for (const [index, playerId] of players.entries()) {
      await economics.credit(playerId, 1_000_000);
      await store.registerPlayer({
        tournamentId: tournament.id,
        playerId,
        displayName: `P${index}`,
        team: `team-${index}`,
      });
    }
    await economics.credit(orphan, 1_000_000);
    const orphanKey = `tournament:${tournament.id}:${orphan}`;
    await economics.reserve(orphanKey, orphan, FEE);
    const orphanBefore = await economics.getBalance(orphan);
    await recoverDurableState({ economics, tournaments: store, logger: silent });
    assert.equal((await economics.getHold(orphanKey))?.status, 'released');
    assert.equal(await economics.getBalance(orphan), orphanBefore + FEE);
  });

  await t.test('withdrawn players stay withdrawn and keep reserved holds', async () => {
    const hostId = wallet();
    const players = [wallet(), wallet(), wallet(), wallet()];
    const tournament = baseTournament({ hostId, title: 'Withdraw' });
    await store.saveTournament(tournament);
    await registerFour(store, economics, tournament, players);
    const loaded = await store.getTournament(tournament.id);
    assert.ok(loaded);
    loaded.players[1]!.status = 'withdrawn';
    await store.saveTournament(loaded);
    await recoverDurableState({ economics, tournaments: store, logger: silent });
    const after = await store.getTournament(tournament.id);
    assert.equal(after?.players.find(player => player.id === players[1])?.status, 'withdrawn');
    assert.equal((await economics.getHold(`tournament:${tournament.id}:${players[1]}`))?.status, 'reserved');
    assert.equal(after?.hostId, hostId);
  });

  await t.test('missing registered hold fails closed', async () => {
    const hostId = wallet();
    const broken = baseTournament({ hostId, title: 'Missing hold' });
    const missing = wallet();
    await economics.credit(missing, 1_000_000);
    await store.saveTournament({
      ...broken,
      players: [{
        id: missing,
        displayName: 'Missing',
        team: 'team-x',
        eligible: true,
        status: 'registered',
        registrationOrder: 0,
      }],
    });
    await assert.rejects(
      () => recoverDurableState({ economics, tournaments: store, logger: silent }),
      RecoveryFailedError,
    );
  });

  await pool.end();
});
