import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TEAM_FINALIZATION_MS,
  TOURNAMENT_BURN_FEE_ATOMS,
  TournamentService,
  createTournamentPlayerId,
  type TournamentId,
  type TournamentMatch,
} from '../src';
import { TEAM_ONE, TEAM_TWO } from './fixtures';

function players(count: number) {
  return Array.from({ length: count }, (_, index) => createTournamentPlayerId(
    `p${String(index + 1).padStart(2, '0')}`,
  ));
}

async function createField(
  service: TournamentService,
  maxPlayers: 16 | 32,
  count: number = maxPlayers,
) {
  const tournament = await service.createTournament({
    title: `${maxPlayers} Cup`,
    format: 'gen9ou',
    ruleset: 'gen9ou',
    maxPlayers,
    bracketSeed: `capacity-${maxPlayers}`,
  });
  await service.openRegistration(tournament.id);
  const ids = players(count);
  const registered = [];
  for (const [index, playerId] of ids.entries()) {
    registered.push(await service.registerPlayer(tournament.id, {
      playerId,
      displayName: playerId,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    }));
  }
  return { tournament, registered };
}

function eliminationMatches(matches: TournamentMatch[]): TournamentMatch[] {
  return matches.filter(match => match.role !== 'third-place');
}

async function playReady(
  service: TournamentService,
  tournamentId: TournamentId,
  include: (match: TournamentMatch) => boolean,
): Promise<void> {
  for (;;) {
    const ready = (await service.getBracket(tournamentId))
      .filter(match => match.status === 'ready' && include(match))
      .sort((left, right) => left.round - right.round || left.bracketPosition - right.bracketPosition);
    const next = ready[0];
    if (!next?.player2) return;
    await service.startMatch(next.id);
    await service.forfeit(next.id, next.player2);
  }
}

test('16-player registration fills at the configured capacity and 32 stays independent', async () => {
  const service = new TournamentService();
  const sixteen = await createField(service, 16, 15);
  await assert.rejects(
    () => service.beginTeamFinalization(sixteen.tournament.id),
    /field is full/i,
  );

  const last = await service.registerPlayer(sixteen.tournament.id, {
    playerId: players(16)[15]!,
    displayName: 'p16',
    team: TEAM_TWO,
  });
  assert.equal(last.status, 'registered');
  const opened = await service.beginTeamFinalization(sixteen.tournament.id);
  assert.equal(opened.maxPlayers, 16);
  assert.ok(opened.finalizesAt);

  const overflow = await service.registerPlayer(sixteen.tournament.id, {
    playerId: createTournamentPlayerId('p17'),
    displayName: 'p17',
    team: TEAM_ONE,
  });
  assert.equal(overflow.status, 'waitlisted');

  const thirtyTwo = await createField(service, 32, 31);
  await assert.rejects(
    () => service.beginTeamFinalization(thirtyTwo.tournament.id),
    /field is full/i,
  );
  assert.equal((await service.getTournament(sixteen.tournament.id)).maxPlayers, 16);
  assert.equal((await service.getTournament(thirtyTwo.tournament.id)).maxPlayers, 32);
});

test('a 16-player bracket has four rounds, 15 elimination matches, and one third-place match', async () => {
  let now = 1_000;
  const service = new TournamentService({ now: () => now });
  const { tournament } = await createField(service, 16);
  await service.beginTeamFinalization(tournament.id);
  now += TEAM_FINALIZATION_MS;
  const started = await service.startTournament(tournament.id);
  const matches = await service.getBracket(started.id);
  const elimination = eliminationMatches(matches);
  const third = matches.find(match => match.role === 'third-place');
  assert.equal(started.maxPlayers, 16);
  assert.equal(elimination.length, 15);
  assert.equal(matches.length, 16);
  assert.equal(Math.max(...elimination.map(match => match.round)), 4);
  assert.deepEqual(
    [1, 2, 3, 4].map(round => elimination.filter(match => match.round === round).length),
    [8, 4, 2, 1],
  );
  assert.equal(third?.round, 4);
  assert.equal(third?.bracketPosition, 1);
  assert.equal(third?.status, 'pending');

  await playReady(
    service,
    started.id,
    match => match.round < 4,
  );
  const placed = (await service.getBracket(started.id)).find(match => match.role === 'third-place');
  const semis = (await service.getBracket(started.id)).filter(match => match.round === 3);
  const losers = semis.map(match => (match.winner === match.player1 ? match.player2 : match.player1));
  assert.equal(placed?.status, 'ready');
  assert.ok(placed?.player1 && losers.includes(placed.player1));
  assert.ok(placed?.player2 && losers.includes(placed.player2));

  await playReady(service, started.id, match => match.role !== 'third-place' && match.round === 4);
  const afterFinal = await service.getTournament(started.id);
  const recordedFinal = (await service.getBracket(started.id)).find(match => match.role !== 'third-place' && match.round === 4);
  assert.equal(afterFinal.status, 'in-progress');
  assert.equal(afterFinal.winner, undefined);
  assert.ok(recordedFinal?.winner);

  await playReady(service, started.id, match => match.role === 'third-place');
  const completed = await service.getTournament(started.id);
  const finalMatches = await service.getBracket(started.id);
  const finalThird = finalMatches.find(match => match.role === 'third-place');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.winner, recordedFinal?.winner);
  assert.notEqual(finalThird?.winner, completed.winner);
  assert.equal(finalMatches.filter(match => match.status === 'completed' || match.status === 'forfeited').length, 16);
});

test('a 32-player bracket has 31 elimination matches plus a third-place match', async () => {
  let now = 5_000;
  const service = new TournamentService({ now: () => now });
  const { tournament } = await createField(service, 32);
  await service.beginTeamFinalization(tournament.id);
  now += TEAM_FINALIZATION_MS;
  const started = await service.startTournament(tournament.id);
  const matches = await service.getBracket(started.id);
  const elimination = eliminationMatches(matches);
  const third = matches.find(match => match.role === 'third-place');
  assert.equal(elimination.length, 31);
  assert.equal(matches.length, 32);
  assert.equal(third?.round, 5);
  assert.equal(third?.bracketPosition, 1);
  assert.equal(third?.status, 'pending');
  assert.equal(matches.filter(match => match.round === 1).length, 16);

  await playReady(service, started.id, match => match.round < 5);
  const placed = (await service.getBracket(started.id)).find(match => match.role === 'third-place');
  const semis = (await service.getBracket(started.id)).filter(match => match.round === 4);
  const losers = semis.map(match => (match.winner === match.player1 ? match.player2 : match.player1));
  assert.equal(placed?.status, 'ready');
  assert.ok(placed?.player1 && losers.includes(placed.player1));
  assert.ok(placed?.player2 && losers.includes(placed.player2));

  await playReady(service, started.id, match => match.role !== 'third-place' && match.round === 5);
  const afterFinal = await service.getTournament(started.id);
  const recordedFinal = (await service.getBracket(started.id)).find(match => match.role !== 'third-place' && match.round === 5);
  assert.equal(afterFinal.status, 'in-progress');
  assert.equal(afterFinal.winner, undefined);
  assert.ok(recordedFinal?.winner);

  await playReady(service, started.id, match => match.role === 'third-place');
  const completed = await service.getTournament(started.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.winner, recordedFinal?.winner);
  const result = await service.getTournamentResult(started.id);
  assert.equal(result?.winner, completed.winner);
  assert.equal(result?.thirdPlace, (await service.getBracket(started.id)).find(match => match.role === 'third-place')?.winner);
  assert.notEqual(result?.thirdPlace, result?.winner);
  assert.notEqual(result?.runnerUp, result?.winner);
});

test('chain creation accepts the configured 16-player field without changing the burn fee', async () => {
  const service = new TournamentService();
  const created = await service.createTournament({
    title: 'Chain Sixteen',
    format: 'gen9ou',
    maxPlayers: 16,
    rail: 'sol_chain',
    entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
  });
  assert.equal(created.maxPlayers, 16);
  assert.equal(created.entryAtoms, TOURNAMENT_BURN_FEE_ATOMS);
  const normal = await service.createTournament({
    title: 'Chain Thirty Two',
    format: 'gen9ou',
    maxPlayers: 32,
    rail: 'sol_chain',
    entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
  });
  assert.equal(normal.maxPlayers, 32);
});
