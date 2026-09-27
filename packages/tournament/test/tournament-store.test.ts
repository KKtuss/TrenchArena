import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryAsyncTournamentRepository } from '../src/tournament-store';
import type { Tournament, TournamentId, TournamentMatch, TournamentMatchId } from '../src/types';

test('async in-memory tournament repository stores host and entry fee on the tournament', async () => {
  const store = new InMemoryAsyncTournamentRepository();
  const tournament = {
    id: 't1' as TournamentId,
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'default',
    matchTimeoutMs: 300_000,
    status: 'registration',
    hostId: 'host-1',
    entryFee: 50_000,
    players: [],
    matchIds: [],
    createdAt: 1,
    updatedAt: 1,
  } satisfies Tournament;
  await store.saveTournament(tournament);
  const loaded = await store.getTournament(tournament.id);
  assert.equal(loaded?.title, 'Cup');
  assert.equal(loaded?.hostId, 'host-1');
  assert.equal(loaded?.entryFee, 50_000);

  const match = {
    id: 'm1' as TournamentMatchId,
    tournamentId: tournament.id,
    round: 1,
    bracketPosition: 0,
    status: 'tied',
    createdAt: 1,
    updatedAt: 1,
    completedAt: 2,
  } satisfies TournamentMatch;
  await store.saveMatch(match);
  const storedMatch = await store.getMatch(match.id);
  assert.equal(storedMatch?.status, 'tied');
  assert.equal(storedMatch?.winner, undefined);

  const live = {
    id: 'm2' as TournamentMatchId,
    tournamentId: tournament.id,
    round: 1,
    bracketPosition: 1,
    status: 'active' as const,
    battleInstanceId: 'dead-stream' as TournamentMatch['battleInstanceId'],
    createdAt: 1,
    updatedAt: 1,
    startedAt: 2,
  } satisfies TournamentMatch;
  await store.saveMatch(live);
  const interrupted = await store.interruptMatch(live.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.winner, undefined);
  assert.equal(interrupted.battleInstanceId, undefined);
  const again = await store.interruptMatch(live.id);
  assert.equal(again.status, 'interrupted');
});
