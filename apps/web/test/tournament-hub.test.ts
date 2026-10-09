import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitTournamentPrize, tournamentPayoutView, tournamentPrizeView } from '../lib/tournament-prize';
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
  tournamentPodium,
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

test('podium reads the final and the 3rd-place match', () => {
  const cup = buildMockTournament({ maxPlayers: 8, champion: true, viewerId: 'you' });
  const podium = tournamentPodium(cup.bracket ?? [], cup.winner);
  assert.equal(podium.final?.round, 3);
  assert.equal(podium.thirdPlace?.role, 'third-place');
  assert.equal(podium.first, cup.winner);
  assert.equal(podium.second, podium.final?.player1 === cup.winner ? podium.final?.player2 : podium.final?.player1);
  assert.ok(podium.third);
  assert.equal(podium.third, podium.thirdPlace?.winner);
  assert.equal(new Set([podium.first, podium.second, podium.third]).size, 3);
});

test('podium stays empty until the deciding matches settle', () => {
  const live = buildMockTournament({ maxPlayers: 8, currentRound: 2, status: 'in-progress' });
  const podium = tournamentPodium(live.bracket ?? []);
  assert.equal(podium.final?.round, 3);
  assert.equal(podium.first, undefined);
  assert.equal(podium.second, undefined);
  assert.equal(podium.third, undefined);
  assert.equal(tournamentPodium(emptyBracket(8)).final, undefined);
  const duel = tournamentPodium([
    { id: 'final', round: 1, bracketPosition: 0, status: 'completed', winner: 'a', player1: 'a', player2: 'b' },
  ]);
  assert.deepEqual([duel.first, duel.second, duel.third, duel.thirdPlace], ['a', 'b', undefined, undefined]);
});

test('prize view keeps each rail in its own unit', () => {
  const legacy = tournamentPrizeView({}, 1_000);
  assert.equal(legacy.chainLabel, undefined);
  assert.equal(legacy.label, '1,000 POKE');
  assert.deepEqual(legacy.shares, { first: 500, second: 350, third: 150 });
  assert.equal(legacy.formatShare(500), '500 POKE');
  const cards = tournamentPrizeView({ rail: 'sol_chain', prizeCardsRaw: 2_000, prizeLamports: 9 }, 1_000);
  assert.equal(cards.label, '2,000 CARDS');
  assert.deepEqual(cards.shares, { first: 1_000, second: 700, third: 300 });
  assert.equal(cards.formatShare(700), '700 CARDS');
  const sol = tournamentPrizeView({ rail: 'sol_chain', prizeLamports: 2_000_000_000 }, 1_000);
  assert.equal(sol.label, '2.00 SOL');
  assert.equal(sol.formatShare(1_000_000_000), '1.00 SOL');
  const unreserved = tournamentPrizeView({ rail: 'sol_chain' }, 1_000);
  assert.equal(unreserved.chainLabel, undefined);
  assert.equal(unreserved.label, '1,000 POKE');
  assert.equal(unreserved.shares, undefined);
});

test('payout view only lists podium places for a CARDS podium settlement', () => {
  assert.equal(tournamentPayoutView(undefined), undefined);
  const poke = tournamentPayoutView({ symbol: 'POKE', amount: 360_000 });
  assert.equal(poke?.label, '360,000 POKE');
  assert.equal(poke?.places, undefined);
  assert.equal(poke?.format(5), '5 POKE');
  assert.equal(tournamentPayoutView({ symbol: 'SOL', amount: 1_500_000_000 })?.label, '1.50 SOL');
  const podium = tournamentPayoutView({ symbol: 'CARDS', amount: 1_000, cardsAmountRaw: 2_000 });
  assert.equal(podium?.label, '1,000 CARDS');
  assert.equal(podium?.amount, 1_000);
  assert.deepEqual(podium?.places, { first: '1,000 CARDS', second: '700 CARDS', third: '300 CARDS' });
  assert.equal(tournamentPayoutView({ symbol: 'CARDS', amount: 2_000, cardsAmountRaw: 2_000 })?.places, undefined);
  assert.equal(tournamentPayoutView({ symbol: 'CARDS', amount: 900, cardsAmountRaw: 2_000 })?.places, undefined);
});
