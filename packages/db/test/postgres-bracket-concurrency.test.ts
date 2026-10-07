import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import { databaseConfig, migrate } from '../src/migrate';
import { PostgresTournamentStore } from '../src/postgres-tournament-store';
import type { DurableTournament, DurableTournamentMatch } from '../src/tournament-store';

function wallet(): string {
  return `player-${randomUUID().replaceAll('-', '')}aaaaaaaa`;
}

test('postgres bracket advancement merges concurrent winners into one next match', async t => {
  const pool = new Pool(databaseConfig());
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end();
    t.skip('PostgreSQL is not reachable (set POKEARENA_DATABASE_URL).');
    return;
  }
  try {
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }

    const store = new PostgresTournamentStore(pool);
    const tournamentId = randomUUID();
    const players = [wallet(), wallet(), wallet(), wallet()];
    const now = Date.now();
    const tournament: DurableTournament = {
      id: tournamentId,
      title: 'Concurrent bracket merge',
      format: 'gen9ou',
      maxPlayers: 4,
      bracketSeed: 'test',
      matchTimeoutMs: 300_000,
      status: 'registration',
      hostId: players[0]!,
      entryFee: 0,
      players: players.map((id, registrationOrder) => ({
        id,
        displayName: id,
        team: 'Pikachu',
        eligible: true,
        status: 'registered',
        registrationOrder,
        teamLocked: true,
        burnFeePaid: true,
      })),
      matchIds: [],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    await store.saveTournament(tournament);

    const matchA: DurableTournamentMatch = {
      id: randomUUID(),
      tournamentId,
      round: 1,
      bracketPosition: 0,
      player1: players[0],
      player2: players[1],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const matchB: DurableTournamentMatch = {
      id: randomUUID(),
      tournamentId,
      round: 1,
      bracketPosition: 1,
      player1: players[2],
      player2: players[3],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const finalMatch: DurableTournamentMatch = {
      id: randomUUID(),
      tournamentId,
      round: 2,
      bracketPosition: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await store.saveBracket(
      { ...tournament, status: 'ready', matchIds: [matchA.id, matchB.id, finalMatch.id] },
      [matchA, matchB, finalMatch],
    );
    await store.saveTournament({
      ...tournament,
      status: 'in-progress',
      matchIds: [matchA.id, matchB.id, finalMatch.id],
    });

    const completedA = {
      ...matchA,
      status: 'completed',
      winner: players[0],
      completedAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies DurableTournamentMatch;
    const completedB = {
      ...matchB,
      status: 'completed',
      winner: players[2],
      completedAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies DurableTournamentMatch;
    await Promise.all([
      store.commitMatchOutcome({
        match: completedA,
        nextMatch: { ...finalMatch, player1: players[0], updatedAt: Date.now() },
      }),
      store.commitMatchOutcome({
        match: completedB,
        nextMatch: { ...finalMatch, player2: players[2], updatedAt: Date.now() },
      }),
    ]);

    const next = await store.getMatch(finalMatch.id);
    assert.equal(next?.player1, players[0]);
    assert.equal(next?.player2, players[2]);
    assert.equal(next?.status, 'ready');
  } finally {
    await pool.end();
  }
});
