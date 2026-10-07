import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryTournamentStore } from '../src/memory-tournament-store';
import {
  authoritativeTournamentOutcome,
  nextTournamentAfterMatchCommit,
} from '../src/tournament-completion';
import type { DurableTournament, DurableTournamentMatch } from '../src/tournament-store';

test('third-place tie is not a completed podium', () => {
  const outcome = authoritativeTournamentOutcome([
    { round: 2, bracketPosition: 0, status: 'completed', winner: 'a' },
    { round: 2, bracketPosition: 1, status: 'tied' },
  ]);
  assert.equal(outcome.completed, false);
  assert.equal(outcome.hasThirdPlace, true);
  const tournament: DurableTournament = {
    id: 'cup',
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'seed',
    matchTimeoutMs: 1,
    status: 'completed',
    hostId: 'host',
    entryFee: 0,
    players: [],
    matchIds: [],
    winner: 'a',
    createdAt: 1,
    updatedAt: 1,
    completedAt: 2,
  };
  const next = nextTournamentAfterMatchCommit(tournament, [
    { round: 2, bracketPosition: 0, status: 'completed', winner: 'a' },
    { round: 2, bracketPosition: 1, status: 'tied' },
  ], 3);
  assert.equal(next?.status, 'in-progress');
  assert.equal(next?.completedAt, undefined);
  assert.equal(next?.winner, undefined);
});

test('in-memory seating keeps both finalists and completes only when third place is decided', async () => {
  const store = new InMemoryTournamentStore();
  const tournament: DurableTournament = {
    id: 'cup',
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'seed',
    matchTimeoutMs: 1,
    status: 'in-progress',
    hostId: 'host',
    entryFee: 0,
    players: [],
    matchIds: ['semi-0', 'semi-1', 'final', 'third'],
    createdAt: 1,
    updatedAt: 1,
  };
  const base = (id: string, round: number, position: number): DurableTournamentMatch => ({
    id,
    tournamentId: 'cup',
    round,
    bracketPosition: position,
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
  });
  await store.saveTournament(tournament);
  await store.saveMatch({ ...base('semi-0', 1, 0), status: 'ready', player1: 'a', player2: 'b' });
  await store.saveMatch({ ...base('semi-1', 1, 1), status: 'ready', player1: 'c', player2: 'd' });
  await store.saveMatch(base('final', 2, 0));
  await store.saveMatch(base('third', 2, 1));
  const final = base('final', 2, 0);
  await Promise.all([
    store.commitMatchOutcome({
      match: { ...base('semi-0', 1, 0), status: 'completed', winner: 'a', player1: 'a', player2: 'b' },
      nextMatch: { ...final, player1: 'a' },
    }),
    store.commitMatchOutcome({
      match: { ...base('semi-1', 1, 1), status: 'completed', winner: 'c', player1: 'c', player2: 'd' },
      nextMatch: { ...final, player2: 'c' },
    }),
  ]);
  const seated = await store.getMatch('final');
  assert.equal(seated?.player1, 'a');
  assert.equal(seated?.player2, 'c');
  await store.commitMatchOutcome({
    match: { ...base('final', 2, 0), status: 'completed', winner: 'a', player1: 'a', player2: 'c' },
  });
  await store.saveMatch({
    ...base('third', 2, 1),
    status: 'ready',
    player1: 'b',
    player2: 'd',
  });
  const afterFinal = await store.getTournament('cup');
  const openThird = await store.getMatch('third');
  assert.equal(afterFinal?.status, 'in-progress');
  assert.equal(afterFinal?.winner, undefined);
  assert.equal(afterFinal?.completedAt, undefined);
  assert.equal((await store.getMatch('final'))?.winner, 'a');
  assert.equal(openThird?.status, 'ready');
  assert.equal(openThird?.winner, undefined);
  assert.equal(payoutReady(afterFinal), false);

  const restarted = new InMemoryTournamentStore();
  await restarted.saveTournament(structuredClone(afterFinal!));
  for (const id of ['semi-0', 'semi-1', 'final', 'third']) {
    await restarted.saveMatch(structuredClone((await store.getMatch(id))!));
  }
  assert.equal((await restarted.getTournament('cup'))?.status, 'in-progress');
  assert.equal((await restarted.getMatch('final'))?.winner, 'a');
  const replayedThird = await restarted.beginMatchStart('third');
  assert.equal(replayedThird.status, 'battle-created');
  assert.equal((await restarted.getTournament('cup'))?.winner, undefined);

  await store.commitMatchOutcome({
    match: { ...base('third', 2, 1), status: 'completed', winner: 'b', player1: 'b', player2: 'd' },
  });
  const done = await store.getTournament('cup');
  assert.equal(done?.status, 'completed');
  assert.equal(done?.winner, 'a');
  assert.ok(done?.completedAt);
  assert.equal(payoutReady(done), true);
  const completedAt = done?.completedAt;
  await store.commitMatchOutcome({
    match: { ...base('final', 2, 0), status: 'completed', winner: 'a', player1: 'a', player2: 'c' },
  });
  await store.commitMatchOutcome({
    match: { ...base('third', 2, 1), status: 'completed', winner: 'b', player1: 'b', player2: 'd' },
  });
  const replayed = await store.getTournament('cup');
  assert.equal(replayed?.status, 'completed');
  assert.equal(replayed?.winner, 'a');
  assert.equal(replayed?.completedAt, completedAt);
});

test('third place can finish before the final without a champion or payout', async () => {
  const store = new InMemoryTournamentStore();
  const tournament: DurableTournament = {
    id: 'cup',
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'seed',
    matchTimeoutMs: 1,
    status: 'in-progress',
    hostId: 'host',
    entryFee: 0,
    players: [],
    matchIds: ['final', 'third'],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.saveTournament(tournament);
  await store.saveMatch({
    id: 'final',
    tournamentId: 'cup',
    round: 2,
    bracketPosition: 0,
    player1: 'a',
    player2: 'c',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  });
  await store.saveMatch({
    id: 'third',
    tournamentId: 'cup',
    round: 2,
    bracketPosition: 1,
    player1: 'b',
    player2: 'd',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  });
  await store.commitMatchOutcome({
    match: {
      id: 'third',
      tournamentId: 'cup',
      round: 2,
      bracketPosition: 1,
      player1: 'b',
      player2: 'd',
      status: 'completed',
      winner: 'b',
      createdAt: 1,
      updatedAt: 2,
    },
  });
  const stored = await store.getTournament('cup');
  assert.equal(stored?.status, 'in-progress');
  assert.equal(stored?.winner, undefined);
  assert.equal((await store.getMatch('final'))?.status, 'ready');
  assert.equal(payoutReady(stored), false);
});

test('a third-place tie leaves the cup in progress with no payout', async () => {
  const store = new InMemoryTournamentStore();
  await store.saveTournament({
    id: 'cup',
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'seed',
    matchTimeoutMs: 1,
    status: 'in-progress',
    hostId: 'host',
    entryFee: 0,
    players: [],
    matchIds: ['final', 'third'],
    createdAt: 1,
    updatedAt: 1,
  });
  await store.saveMatch({
    id: 'final',
    tournamentId: 'cup',
    round: 2,
    bracketPosition: 0,
    player1: 'a',
    player2: 'c',
    status: 'completed',
    winner: 'a',
    createdAt: 1,
    updatedAt: 1,
  });
  await store.saveMatch({
    id: 'third',
    tournamentId: 'cup',
    round: 2,
    bracketPosition: 1,
    player1: 'b',
    player2: 'd',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  });
  await store.commitMatchOutcome({
    match: {
      id: 'third',
      tournamentId: 'cup',
      round: 2,
      bracketPosition: 1,
      player1: 'b',
      player2: 'd',
      status: 'tied',
      createdAt: 1,
      updatedAt: 2,
    },
  });
  const stored = await store.getTournament('cup');
  assert.equal((await store.getMatch('third'))?.status, 'tied');
  assert.equal((await store.getMatch('third'))?.winner, undefined);
  assert.equal(stored?.status, 'in-progress');
  assert.equal(stored?.winner, undefined);
  assert.equal(payoutReady(stored), false);
});

test('a two-player cup still completes on its only final', async () => {
  const store = new InMemoryTournamentStore();
  await store.saveTournament({
    id: 'cup',
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'seed',
    matchTimeoutMs: 1,
    status: 'in-progress',
    hostId: 'host',
    entryFee: 0,
    players: [],
    matchIds: ['final'],
    createdAt: 1,
    updatedAt: 1,
  });
  await store.saveMatch({
    id: 'final',
    tournamentId: 'cup',
    round: 1,
    bracketPosition: 0,
    player1: 'a',
    player2: 'b',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  });
  await store.commitMatchOutcome({
    match: {
      id: 'final',
      tournamentId: 'cup',
      round: 1,
      bracketPosition: 0,
      player1: 'a',
      player2: 'b',
      status: 'completed',
      winner: 'a',
      createdAt: 1,
      updatedAt: 2,
    },
  });
  const stored = await store.getTournament('cup');
  assert.equal(stored?.status, 'completed');
  assert.equal(stored?.winner, 'a');
  assert.ok(stored?.completedAt);
  assert.equal(payoutReady(stored), true);
});

test('concurrent final and third-place commits complete exactly once', async () => {
  const store = new InMemoryTournamentStore();
  await store.saveTournament({
    id: 'cup',
    title: 'Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'seed',
    matchTimeoutMs: 1,
    status: 'in-progress',
    hostId: 'host',
    entryFee: 0,
    players: [],
    matchIds: ['final', 'third'],
    createdAt: 1,
    updatedAt: 1,
  });
  await store.saveMatch({
    id: 'final',
    tournamentId: 'cup',
    round: 2,
    bracketPosition: 0,
    player1: 'a',
    player2: 'c',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  });
  await store.saveMatch({
    id: 'third',
    tournamentId: 'cup',
    round: 2,
    bracketPosition: 1,
    player1: 'b',
    player2: 'd',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  });
  await Promise.all([
    store.commitMatchOutcome({
      match: {
        id: 'final',
        tournamentId: 'cup',
        round: 2,
        bracketPosition: 0,
        player1: 'a',
        player2: 'c',
        status: 'completed',
        winner: 'a',
        createdAt: 1,
        updatedAt: 2,
      },
      tournament: {
        id: 'cup',
        title: 'Cup',
        format: 'gen9ou',
        maxPlayers: 4,
        bracketSeed: 'seed',
        matchTimeoutMs: 1,
        status: 'in-progress',
        hostId: 'host',
        entryFee: 0,
        players: [],
        matchIds: ['final', 'third'],
        winner: 'a',
        createdAt: 1,
        updatedAt: 1,
      },
    }),
    store.commitMatchOutcome({
      match: {
        id: 'third',
        tournamentId: 'cup',
        round: 2,
        bracketPosition: 1,
        player1: 'b',
        player2: 'd',
        status: 'completed',
        winner: 'b',
        createdAt: 1,
        updatedAt: 2,
      },
    }),
  ]);
  const done = await store.getTournament('cup');
  assert.equal(done?.status, 'completed');
  assert.equal(done?.winner, 'a');
  assert.equal((await store.getMatch('final'))?.winner, 'a');
  assert.equal((await store.getMatch('third'))?.winner, 'b');
  assert.equal(payoutReady(done), true);
  const completedAt = done?.completedAt;
  await Promise.all([
    store.commitMatchOutcome({
      match: {
        id: 'final',
        tournamentId: 'cup',
        round: 2,
        bracketPosition: 0,
        player1: 'a',
        player2: 'c',
        status: 'completed',
        winner: 'a',
        createdAt: 1,
        updatedAt: 3,
      },
    }),
    store.commitMatchOutcome({
      match: {
        id: 'third',
        tournamentId: 'cup',
        round: 2,
        bracketPosition: 1,
        player1: 'b',
        player2: 'd',
        status: 'completed',
        winner: 'b',
        createdAt: 1,
        updatedAt: 3,
      },
    }),
  ]);
  const replayed = await store.getTournament('cup');
  assert.equal(replayed?.completedAt, completedAt);
  assert.equal(replayed?.winner, 'a');
  assert.equal(replayed?.status, 'completed');
});

function payoutReady(tournament: { status: string; winner?: string; completedAt?: number } | undefined): boolean {
  return tournament?.status === 'completed' && typeof tournament.winner === 'string' && tournament.completedAt !== undefined;
}
