import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authoritativeTournamentOutcome } from '../src/bracket';
import { createTournamentPlayerId } from '../src/types';
import { InMemoryAsyncTournamentRepository } from '../src/tournament-store';
import type { Tournament, TournamentMatch } from '../src/types';

const A = createTournamentPlayerId('a');
const B = createTournamentPlayerId('b');
const C = createTournamentPlayerId('c');
const D = createTournamentPlayerId('d');

const CUP = 'cup-lock';

function cup(status: Tournament['status'] = 'in-progress'): Tournament {
  return {
    id: CUP as Tournament['id'],
    title: 'Lock Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'seed',
    matchTimeoutMs: 1_000,
    status,
    hostId: 'host',
    entryFee: 0,
    players: [],
    matchIds: ['final', 'third'] as Tournament['matchIds'],
    createdAt: 1,
    updatedAt: 1,
  };
}

function match(id: string, position: number, status: string, winner?: string): TournamentMatch {
  return {
    id: id as TournamentMatch['id'],
    tournamentId: CUP as TournamentMatch['tournamentId'],
    round: 2,
    bracketPosition: position,
    player1: position === 0 ? A : C,
    player2: position === 0 ? B : D,
    status: status as TournamentMatch['status'],
    ...(winner ? { winner: createTournamentPlayerId(winner) } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

test('a third-place tie does not complete the podium', () => {
  const outcome = authoritativeTournamentOutcome([
    { round: 2, bracketPosition: 0, status: 'completed', winner: 'a' },
    { round: 2, bracketPosition: 1, status: 'tied' },
  ]);
  assert.equal(outcome.completed, false);
  assert.equal(outcome.thirdDecided, false);
  assert.equal(outcome.winner, 'a');
});

test('a finished final leaves the tournament in progress until third place is decided', async () => {
  const repo = new InMemoryAsyncTournamentRepository();
  await repo.saveTournament(cup());
  await repo.saveMatch(match('final', 0, 'ready'));
  await repo.saveMatch(match('third', 1, 'ready'));
  await repo.commitMatchOutcome({
    match: match('final', 0, 'completed', 'a'),
    tournament: { ...cup(), winner: 'a' as Tournament['winner'] },
  });
  const stored = await repo.getTournament(CUP as Tournament['id']);
  const third = await repo.getMatch('third' as TournamentMatch['id']);
  const final = await repo.getMatch('final' as TournamentMatch['id']);
  assert.equal(stored?.status, 'in-progress');
  assert.equal(stored?.winner, undefined);
  assert.equal(stored?.completedAt, undefined);
  assert.equal(final?.winner, A);
  assert.equal(third?.status, 'ready');
  assert.equal(third?.winner, undefined);
});

test('third place finishing first does not complete the tournament', async () => {
  const repo = new InMemoryAsyncTournamentRepository();
  await repo.saveTournament(cup());
  await repo.saveMatch(match('final', 0, 'ready'));
  await repo.saveMatch(match('third', 1, 'ready'));
  await repo.commitMatchOutcome({ match: match('third', 1, 'completed', 'c') });
  const stored = await repo.getTournament(CUP as Tournament['id']);
  const final = await repo.getMatch('final' as TournamentMatch['id']);
  assert.equal(stored?.status, 'in-progress');
  assert.equal(stored?.winner, undefined);
  assert.equal(final?.status, 'ready');
  assert.equal(final?.winner, undefined);
});

test('a third-place tie keeps an open cup with no champion', async () => {
  const repo = new InMemoryAsyncTournamentRepository();
  await repo.saveTournament(cup());
  await repo.saveMatch(match('final', 0, 'ready'));
  await repo.saveMatch(match('third', 1, 'ready'));
  await repo.commitMatchOutcome({ match: match('final', 0, 'completed', 'a') });
  await repo.commitMatchOutcome({ match: match('third', 1, 'tied') });
  const stored = await repo.getTournament(CUP as Tournament['id']);
  const third = await repo.getMatch('third' as TournamentMatch['id']);
  assert.equal(third?.status, 'tied');
  assert.equal(third?.winner, undefined);
  assert.equal(stored?.status, 'in-progress');
  assert.equal(stored?.winner, undefined);
});

test('a two-player final with no third-place match completes immediately', async () => {
  const repo = new InMemoryAsyncTournamentRepository();
  const tournament = cup();
  tournament.matchIds = ['final'] as Tournament['matchIds'];
  await repo.saveTournament(tournament);
  await repo.saveMatch(match('final', 0, 'ready'));
  await repo.commitMatchOutcome({ match: match('final', 0, 'completed', 'a') });
  const stored = await repo.getTournament(CUP as Tournament['id']);
  assert.equal(stored?.status, 'completed');
  assert.equal(stored?.winner, A);
  assert.ok(stored?.completedAt);
});

test('concurrent final and third-place results complete from the locked matches', async () => {
  const repo = new InMemoryAsyncTournamentRepository();
  await repo.saveTournament(cup());
  await repo.saveMatch(match('final', 0, 'ready'));
  await repo.saveMatch(match('third', 1, 'ready'));
  const stale = cup();
  await Promise.all([
    repo.commitMatchOutcome({
      match: match('final', 0, 'completed', 'a'),
      tournament: { ...stale, winner: 'a' as Tournament['winner'] },
    }),
    repo.commitMatchOutcome({
      match: match('third', 1, 'completed', 'c'),
      tournament: stale,
    }),
  ]);
  const stored = await repo.getTournament(CUP as Tournament['id']);
  assert.equal(stored?.status, 'completed');
  assert.equal(stored?.winner, A);
});

test('a stale in-progress snapshot cannot clear a decided podium', async () => {
  const repo = new InMemoryAsyncTournamentRepository();
  await repo.saveTournament(cup());
  await repo.saveMatch(match('final', 0, 'ready'));
  await repo.saveMatch(match('third', 1, 'ready'));
  await repo.commitMatchOutcome({ match: match('final', 0, 'completed', 'a') });
  await repo.commitMatchOutcome({
    match: match('third', 1, 'completed', 'c'),
    tournament: cup(),
  });
  const stored = await repo.getTournament(CUP as Tournament['id']);
  assert.equal(stored?.status, 'completed');
  assert.equal(stored?.winner, A);
});

test('semifinal seating merges both finalists instead of overwriting one', async () => {
  const repo = new InMemoryAsyncTournamentRepository();
  const tournament = cup();
  tournament.matchIds = ['semi-0', 'semi-1', 'final'] as Tournament['matchIds'];
  await repo.saveTournament(tournament);
  await repo.saveMatch({ ...match('semi-0', 0, 'ready'), round: 1 });
  await repo.saveMatch({ ...match('semi-1', 1, 'ready'), round: 1 });
  await repo.saveMatch({
    ...match('final', 0, 'pending'),
    player1: undefined,
    player2: undefined,
  });
  const final = {
    ...match('final', 0, 'pending'),
    player1: undefined,
    player2: undefined,
  };
  await Promise.all([
    repo.commitMatchOutcome({
      match: { ...match('semi-0', 0, 'completed', 'a'), round: 1 },
      nextMatch: { ...final, player1: A },
    }),
    repo.commitMatchOutcome({
      match: { ...match('semi-1', 1, 'completed', 'c'), round: 1, player1: C, player2: D },
      nextMatch: { ...final, player2: C },
    }),
  ]);
  const seated = await repo.getMatch('final' as TournamentMatch['id']);
  assert.equal(seated?.player1, A);
  assert.equal(seated?.player2, C);
});
