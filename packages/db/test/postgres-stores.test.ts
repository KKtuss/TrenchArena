import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import { databaseConfig, migrate } from '../src/migrate';
import { InMemoryTournamentStore } from '../src/memory-tournament-store';
import { PostgresEconomicsStore } from '../src/postgres-economics-store';
import { PostgresTournamentStore } from '../src/postgres-tournament-store';
import type { DurableTournament } from '../src/tournament-store';
import type { EconomicsStore } from '../src/economics-store';

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

test('in-memory tournament store keeps host and entry fee', async () => {
  const store = new InMemoryTournamentStore();
  const id = randomUUID();
  const tournament: DurableTournament = {
    id,
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'default',
    matchTimeoutMs: 300_000,
    status: 'registration',
    hostId: 'host-1',
    entryFee: 50_000,
    players: [{
      id: 'player-1',
      displayName: 'P1',
      team: 'team-one',
      eligible: true,
      status: 'registered',
      registrationOrder: 0,
    }],
    matchIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.saveTournament(tournament);
  const loaded = await store.getTournament(id);
  assert.equal(loaded?.hostId, 'host-1');
  assert.equal(loaded?.entryFee, 50_000);
  assert.equal(loaded?.players[0]?.team, 'team-one');
});

test('postgres economics and tournament stores enforce durable keys', async t => {
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

  const economics: EconomicsStore = new PostgresEconomicsStore(pool);
  const tournaments = new PostgresTournamentStore(pool);
  const roomId = randomUUID();
  const player = `player-${randomUUID().replaceAll('-', '')}aaaaaaaa`;

  await economics.credit(player, 1_000_000);
  await pool.query(
    `INSERT INTO casual_rooms (
       id, match_id, room_type, battle_size, format, creator_id, collateral, status
     ) VALUES ($1, $2, 'open', '1v1', 'gen9ou', $3, 1000, 'open')`,
    [roomId, `casual-${roomId}`, player],
  );

  const holdKey = `casual:${roomId}:creator`;
  assert.equal(await economics.reserve(holdKey, player, 1000), true);
  assert.equal(await economics.reserve(holdKey, player, 1000), false);
  assert.equal(await economics.getBalance(player), 999_000);
  await assert.rejects(
    () => economics.reserve(holdKey, player, 2000),
    /Collateral hold already exists/,
  );

  const released = await economics.release(holdKey);
  assert.equal(released, 1000);
  assert.equal(await economics.hasHold(holdKey), false);
  assert.equal(await economics.release(holdKey), 0);
  assert.equal(await economics.getBalance(player), 1_000_000);

  const roomId2 = randomUUID();
  await pool.query(
    `INSERT INTO casual_rooms (
       id, match_id, room_type, battle_size, format, creator_id, collateral, status
     ) VALUES ($1, $2, 'open', '1v1', 'gen9ou', $3, 1000, 'open')`,
    [roomId2, `casual-${roomId2}`, player],
  );
  const holdKey2 = `casual:${roomId2}:creator`;
  assert.equal(await economics.reserve(holdKey2, player, 1000), true);
  await economics.consume(holdKey2);
  const payout = await economics.settleCasualWin({
    winnerId: player,
    loserId: 'other',
    collateral: 1000,
    settlementKey: `casual:${roomId2}`,
  });
  assert.equal(payout.amount, 1960);
  const again = await economics.settleCasualWin({
    winnerId: player,
    loserId: 'other',
    collateral: 1000,
    settlementKey: `casual:${roomId2}`,
  });
  assert.equal(again.amount, 1960);
  assert.equal(await economics.getBalance(player), 1_000_000 - 1000 + 1960);

  const tournamentId = randomUUID();
  await tournaments.saveTournament({
    id: tournamentId,
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'default',
    matchTimeoutMs: 300_000,
    status: 'registration',
    hostId: player,
    entryFee: 50_000,
    players: [{
      id: player,
      displayName: 'Host',
      team: 'paste',
      eligible: true,
      status: 'registered',
      registrationOrder: 0,
    }],
    matchIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const loaded = await tournaments.getTournament(tournamentId);
  assert.equal(loaded?.hostId, player);
  assert.equal(loaded?.entryFee, 50_000);
  const matchId = randomUUID();
  await tournaments.saveMatch({
    id: matchId,
    tournamentId,
    round: 1,
    bracketPosition: 0,
    player1: player,
    status: 'tied',
    result: { kind: 'battle', battleResult: { status: 'tie', score: [0, 0], turns: 1 } },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: Date.now(),
  });
  const match = await tournaments.getMatch(matchId);
  assert.equal(match?.status, 'tied');
  assert.equal(match?.winner, undefined);

  await pool.end();
});
