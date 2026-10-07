import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitTournamentPrize } from '../lib/tournament-prize';
import {
  displayHubStatus,
  bracketFieldSize,
  buildMockTournament,
  currentRound,
  emptyBracket,
  formatTimeout,
  groupedRounds,
  hubStatus,
  matchActionLabel,
  playerHubStatus,
  playerScore,
  progressionSteps,
  roundTitles,
  totalRounds,
  userMatchIds,
  visibleBracket,
} from '../lib/tournament-hub';

test('round titles follow single-elimination field size', () => {
  assert.deepEqual(roundTitles(8), ['QUARTERFINALS', 'SEMIFINALS', 'FINAL']);
  assert.deepEqual(roundTitles(16), ['ROUND OF 16', 'QUARTERFINALS', 'SEMIFINALS', 'FINAL']);
  assert.equal(totalRounds(32), 5);
  assert.equal(roundTitles(32)[0], 'ROUND OF 32');
});

test('hub status maps tournament lifecycle to LIVE / UPCOMING / COMPLETED', () => {
  assert.equal(hubStatus('in-progress'), 'LIVE');
  assert.equal(hubStatus('registration'), 'UPCOMING');
  assert.equal(hubStatus('ready'), 'UPCOMING');
  assert.equal(hubStatus('completed'), 'COMPLETED');
  assert.equal(hubStatus('cancelled'), 'CANCELLED');
});

test('empty bracket is a full single-elimination tree of waiting matches', () => {
  const sixteen = emptyBracket(16, 'cup');
  assert.equal(sixteen.length, 16);
  assert.equal(sixteen.filter(match => match.role !== 'third-place').length, 15);
  assert.equal(sixteen.filter(match => match.role === 'third-place').length, 1);
  assert.equal(sixteen.filter(match => match.round === 1).length, 8);
  assert.ok(sixteen.every(match => match.placeholder && match.status === 'pending'));
  const thirtyTwo = emptyBracket(32, 'cup');
  assert.equal(thirtyTwo.length, 32);
  assert.equal(thirtyTwo.filter(match => match.role !== 'third-place').length, 31);
  assert.equal(thirtyTwo.filter(match => match.role === 'third-place').length, 1);
});

test('mock live bracket advances winners and highlights the viewer path', () => {
  const tournament = buildMockTournament({ maxPlayers: 16, currentRound: 2, viewerId: 'you' });
  assert.equal(tournament.status, 'in-progress');
  assert.equal(currentRound(tournament.bracket ?? [], tournament.status), 2);
  const path = userMatchIds(tournament.bracket ?? [], 'you');
  assert.ok(path.size >= 2);
  const first = tournament.bracket?.find(match => match.round === 1 && match.player1 === 'you');
  assert.equal(first?.winner, 'you');
  assert.equal(playerScore(first!, 'you'), 1);
  assert.equal(playerScore(first!, first!.player2), 0);
  const live = tournament.bracket?.find(match => match.status === 'active');
  assert.equal(live?.player1, 'you');
  assert.equal(matchActionLabel(live!, 'you'), 'Enter battle');
  assert.equal(matchActionLabel(live!, 'spectator'), 'View match');
  const status = playerHubStatus(tournament, tournament.bracket ?? [], 'you');
  assert.equal(status.kind, 'live');
});

test('progression marks the current round and completed cups', () => {
  const live = progressionSteps(16, 2, 'in-progress');
  assert.equal(live[0]?.state, 'done');
  assert.equal(live[1]?.state, 'current');
  assert.equal(live[2]?.state, 'upcoming');
  const done = progressionSteps(8, 3, 'completed');
  assert.ok(done.every(step => step.state === 'done'));
});

test('visible bracket falls back to a skeleton when registration has no matches', () => {
  const grouped = groupedRounds(visibleBracket({
    id: 'open',
    title: 'Cup',
    format: 'gen9ou',
    status: 'registration',
    maxPlayers: 8,
  }), 8);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0]?.matches.length, 4);
});

test('a started 2-player bracket is a final even when the cup cap is 32', () => {
  assert.equal(bracketFieldSize([{
    id: 'only-match',
    round: 1,
    bracketPosition: 0,
    status: 'active',
    player1: 'you',
    player2: 'aaaa',
  }], 32), 2);
  const full = buildMockTournament({ maxPlayers: 32, currentRound: 2, status: 'in-progress', viewerId: 'you' });
  assert.equal(bracketFieldSize(full.bracket ?? [], 32), 32);
  assert.equal(currentRound(full.bracket ?? [], full.status), 2);
});

test('prize shares are 50/35/15 and a finished final still waits on third place', () => {
  const shares = splitTournamentPrize(100);
  assert.deepEqual(shares, { first: 50, second: 35, third: 15 });
  assert.equal(splitTournamentPrize(99).first + splitTournamentPrize(99).second + splitTournamentPrize(99).third, 99);
  const waiting = displayHubStatus({
    status: 'in-progress',
    economics: { prizePool: 100 },
  }, [
    { id: 'final', round: 2, bracketPosition: 0, status: 'completed', winner: 'a', player1: 'a', player2: 'b' },
    { id: 'third', round: 2, bracketPosition: 1, role: 'third-place', status: 'ready', player1: 'c', player2: 'd' },
  ]);
  assert.equal(waiting, 'LIVE');
  const tied = displayHubStatus({
    status: 'in-progress',
    economics: { prizePool: 100 },
  }, [
    { id: 'final', round: 2, bracketPosition: 0, status: 'completed', winner: 'a', player1: 'a', player2: 'b' },
    { id: 'third', round: 2, bracketPosition: 1, role: 'third-place', status: 'tied', player1: 'c', player2: 'd' },
  ]);
  assert.equal(tied, 'LIVE');
  const settled = displayHubStatus({
    status: 'completed',
    payout: { amount: 50 },
    economics: { prizePool: 100 },
  }, [
    { id: 'final', round: 2, bracketPosition: 0, status: 'completed', winner: 'a' },
    { id: 'third', round: 2, bracketPosition: 1, role: 'third-place', status: 'completed', winner: 'c' },
  ]);
  assert.equal(settled, 'COMPLETED');
});

test('timeout clock and champion mock stay aligned with cup rules', () => {
  assert.equal(formatTimeout(300_000), '5:00');
  const cup = buildMockTournament({ maxPlayers: 8, champion: true, viewerId: 'you' });
  assert.equal(cup.status, 'completed');
  assert.ok(cup.winner);
  assert.equal(playerHubStatus(cup, cup.bracket ?? [], cup.winner).kind, 'champion');
  assert.equal(playerHubStatus(cup, cup.bracket ?? [], 'you').kind, 'champion');
});
