import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import { databaseConfig, migrate } from '../src/migrate';
import { PostgresEconomicsStore } from '../src/postgres-economics-store';
import { PostgresTournamentStore } from '../src/postgres-tournament-store';
import type { DurableTournament, DurableTournamentMatch } from '../src/tournament-store';

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
    title: 'Atomic Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'default',
    matchTimeoutMs: 300_000,
    status: 'registration',
    hostId: wallet(),
    entryFee: 50_000,
    players: [],
    matchIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('postgres tournament registration, capacity, restart, and match idempotency', async t => {
  const pool = await tryPool();
  if (!pool) {
    t.skip('PostgreSQL is not reachable (set POKEARENA_DATABASE_URL). Live tournament persistence tests were not executed.');
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
  const host = wallet();
  const players = [wallet(), wallet(), wallet(), wallet(), wallet()];
  await economics.credit(host, 1_000_000);
  for (const player of players) await economics.credit(player, 1_000_000);

  const tournament = baseTournament({ hostId: host, entryFee: 50_000 });
  await store.saveTournament(tournament);

  const registered = await Promise.allSettled(players.map((playerId, index) => (
    store.registerPlayer({
      tournamentId: tournament.id,
      playerId,
      displayName: `P${index}`,
      team: `team-${index}`,
    })
  )));
  assert.equal(registered.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(registered.filter(result => result.status === 'rejected').length, 1);
  const rejected = registered.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejected.reason), /player limit|already registered/);

  const loaded = await store.getTournament(tournament.id);
  assert.equal(loaded?.players.filter(player => player.status === 'registered').length, 4);
  assert.equal(loaded?.hostId, host);
  assert.equal(loaded?.entryFee, 50_000);
  for (const player of loaded!.players) {
    const hold = await economics.getHold(`tournament:${tournament.id}:${player.id}`);
    assert.equal(hold?.status, 'reserved');
    assert.equal(hold?.amount, 50_000);
    assert.equal(await economics.getBalance(player.id), 950_000);
  }

  const duplicate = loaded!.players[0]!;
  const balanceBefore = await economics.getBalance(duplicate.id);
  await assert.rejects(
    () => store.registerPlayer({
      tournamentId: tournament.id,
      playerId: duplicate.id,
      displayName: 'Again',
      team: 'team-dup',
    }),
    /already registered/,
  );
  assert.equal(await economics.getBalance(duplicate.id), balanceBefore);
  assert.equal((await economics.getHold(`tournament:${tournament.id}:${duplicate.id}`))?.status, 'reserved');

  const leaver = loaded!.players[1]!;
  const leaveBalance = await economics.getBalance(leaver.id);
  const withdrawnTournament = await store.getTournament(tournament.id);
  assert.ok(withdrawnTournament);
  const withdrawnPlayer = withdrawnTournament.players.find(player => player.id === leaver.id);
  assert.ok(withdrawnPlayer);
  withdrawnPlayer.status = 'withdrawn';
  withdrawnPlayer.teamLocked = false;
  withdrawnPlayer.burnFeePaid = false;
  withdrawnTournament.updatedAt = Date.now();
  await store.saveTournament(withdrawnTournament);
  await economics.release(`tournament:${tournament.id}:${leaver.id}`);
  assert.equal(await economics.getBalance(leaver.id), leaveBalance + 50_000);
  assert.equal((await economics.getHold(`tournament:${tournament.id}:${leaver.id}`))?.status, 'released');

  const rejoined = await store.registerPlayer({
    tournamentId: tournament.id,
    playerId: leaver.id,
    displayName: 'Back Again',
    team: 'team-rejoin',
  });
  assert.equal(rejoined.status, 'registered');
  assert.equal(rejoined.displayName, 'Back Again');
  assert.equal(await economics.getBalance(leaver.id), leaveBalance);
  assert.equal((await economics.getHold(`tournament:${tournament.id}:${leaver.id}`))?.status, 'reserved');

  let failCommit = true;
  const rolling = new PostgresTournamentStore(pool, {
    beforeCommit: () => {
      if (failCommit) throw new Error('injected registration commit failure');
    },
  });
  const extra = wallet();
  await economics.credit(extra, 1_000_000);
  const rollbackTournament = baseTournament({ hostId: host, maxPlayers: 8, entryFee: 50_000 });
  await store.saveTournament(rollbackTournament);
  await assert.rejects(
    () => rolling.registerPlayer({
      tournamentId: rollbackTournament.id,
      playerId: extra,
      displayName: 'Rollback',
      team: 'team-x',
    }),
    /injected registration commit failure/,
  );
  failCommit = false;
  const rolled = await store.getTournament(rollbackTournament.id);
  assert.equal(rolled?.players.length, 0);
  assert.equal(await economics.getHold(`tournament:${rollbackTournament.id}:${extra}`), undefined);
  assert.equal(await economics.getBalance(extra), 1_000_000);

  const now = Date.now();
  const matchA: DurableTournamentMatch = {
    id: randomUUID(),
    tournamentId: tournament.id,
    round: 1,
    bracketPosition: 0,
    player1: loaded!.players[0]!.id,
    player2: loaded!.players[1]!.id,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  };
  const matchB: DurableTournamentMatch = {
    id: randomUUID(),
    tournamentId: tournament.id,
    round: 1,
    bracketPosition: 1,
    player1: loaded!.players[2]!.id,
    player2: loaded!.players[3]!.id,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  };
  const finalMatch: DurableTournamentMatch = {
    id: randomUUID(),
    tournamentId: tournament.id,
    round: 2,
    bracketPosition: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  const started = {
    ...loaded!,
    status: 'in-progress',
    matchIds: [matchA.id, matchB.id, finalMatch.id],
    startedAt: now,
    updatedAt: now,
  };
  const [startOne, startTwo] = await Promise.all([
    store.saveBracket(started, [matchA, matchB, finalMatch]),
    store.saveBracket(started, [matchA, matchB, finalMatch]),
  ]);
  assert.equal(startOne, undefined);
  assert.equal(startTwo, undefined);
  assert.equal((await store.getTournament(tournament.id))?.status, 'in-progress');

  const begun = await Promise.allSettled([
    store.beginMatchStart(matchA.id),
    store.beginMatchStart(matchA.id),
  ]);
  assert.equal(begun.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(begun.filter(result => result.status === 'rejected').length, 1);
  await store.attachBattleInstance(matchA.id, 'battle-a');
  await store.markMatchActive(matchA.id);

  const completedA: DurableTournamentMatch = {
    ...(await store.getMatch(matchA.id))!,
    status: 'completed',
    winner: matchA.player1,
    result: { kind: 'battle', battleResult: { status: 'win', winner: matchA.player1, score: [6, 0], turns: 1 } },
    completedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const advancedFinal: DurableTournamentMatch = {
    ...finalMatch,
    player1: matchA.player1,
    updatedAt: Date.now(),
  };
  const [outcomeOne, outcomeTwo] = await Promise.all([
    store.commitMatchOutcome({ match: completedA, nextMatch: advancedFinal }),
    store.commitMatchOutcome({ match: completedA, nextMatch: advancedFinal }),
  ]);
  assert.equal(outcomeOne.winner, matchA.player1);
  assert.equal(outcomeTwo.winner, matchA.player1);
  const next = await store.getMatch(finalMatch.id);
  assert.equal(next?.player1, matchA.player1);
  assert.equal(next?.player2, undefined);

  const tied: DurableTournamentMatch = {
    ...(await store.getMatch(matchB.id))!,
    status: 'tied',
    result: { kind: 'battle', battleResult: { status: 'tie', score: [0, 0], turns: 1 } },
    completedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.commitMatchOutcome({ match: tied });
  await store.beginMatchStart(matchB.id);
  await assert.rejects(() => store.beginMatchStart(matchB.id));
  const replayed = await store.getMatch(matchB.id);
  assert.equal(replayed?.status, 'battle-created');
  assert.equal(replayed?.winner, undefined);
  assert.equal(replayed?.completedAt, undefined);

  const champion = {
    ...(await store.getTournament(tournament.id))!,
    status: 'completed' as const,
    winner: loaded!.players[0]!.id,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const finalCompleted: DurableTournamentMatch = {
    ...(await store.getMatch(finalMatch.id))!,
    player1: loaded!.players[0]!.id,
    player2: loaded!.players[2]!.id,
    status: 'completed',
    winner: loaded!.players[0]!.id,
    result: { kind: 'battle', battleResult: { status: 'win', winner: loaded!.players[0]!.id, score: [6, 0], turns: 1 } },
    completedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.commitMatchOutcome({ match: finalCompleted, tournament: champion });

  const holdKeys = loaded!.players.map(player => `tournament:${tournament.id}:${player.id}`);
  const payout = await economics.completeTournamentWin({
    winnerId: loaded!.players[0]!.id,
    entryFee: 50_000,
    playerCount: 4,
    settlementKey: `tournament:${tournament.id}`,
    holdKeys,
  });
  const paidAgain = await economics.completeTournamentWin({
    winnerId: loaded!.players[1]!.id,
    entryFee: 50_000,
    playerCount: 4,
    settlementKey: `tournament:${tournament.id}`,
    holdKeys,
  });
  assert.equal(payout.winnerId, loaded!.players[0]!.id);
  assert.equal(paidAgain.winnerId, loaded!.players[0]!.id);
  assert.equal(payout.amount, paidAgain.amount);

  const restarted = new PostgresTournamentStore(pool);
  const reconstructed = await restarted.getTournament(tournament.id);
  assert.equal(reconstructed?.hostId, host);
  assert.equal(reconstructed?.entryFee, 50_000);
  assert.equal(reconstructed?.status, 'completed');
  assert.equal(reconstructed?.winner, loaded!.players[0]!.id);
  assert.equal(reconstructed?.players.length, 4);
  assert.equal(
    new Set(reconstructed?.players.map(player => player.team)).size,
    4,
  );
  const reconstructedMatches = await restarted.listMatches(tournament.id);
  assert.equal(reconstructedMatches.length, 3);
  assert.equal(reconstructedMatches.find(match => match.id === matchA.id)?.status, 'completed');
  assert.equal((await economics.getSettlement(`tournament:${tournament.id}`))?.winnerId, loaded!.players[0]!.id);

  await assert.rejects(
    () => pool.query(
      `INSERT INTO holds (
         hold_key, player_id, amount, purpose, status, tournament_id
       ) VALUES ($1, $2, 50000, 'tournament_entry', 'reserved', $3)`,
      [`tournament:${randomUUID()}:${host}`, host, randomUUID()],
    ),
    /foreign key|violates/i,
  );

  await pool.end();
});
