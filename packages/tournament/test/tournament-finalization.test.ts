import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTournamentPlayerId, TEAM_FINALIZATION_MS, TournamentService } from '../src';
import { TEAM_ONE, TEAM_TWO } from './fixtures';

const PLAYERS = ['player-1', 'player-2', 'player-3', 'player-4'].map(createTournamentPlayerId);

test('a full custom field opens one shared 5-minute finalization and then starts', async () => {
  let now = 1_000_000;
  const service = new TournamentService({ now: () => now });
  const tournament = await service.createTournament({
    title: 'Gen 4 Cup',
    format: 'gen9ou',
    ruleset: 'gen4cup',
    maxPlayers: 4,
    matchTimeoutMs: 15_000,
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYERS.entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `Player ${index + 1}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }

  const opened = await service.beginTeamFinalization(tournament.id);
  assert.equal(opened.finalizesAt, now + TEAM_FINALIZATION_MS);
  assert.equal(TEAM_FINALIZATION_MS, 5 * 60 * 1000);
  const again = await service.beginTeamFinalization(tournament.id);
  assert.equal(again.finalizesAt, opened.finalizesAt);

  await service.lockRegisteredTeam(tournament.id, PLAYERS[0]!);
  await assert.rejects(
    () => service.updateRegisteredTeam(tournament.id, PLAYERS[0]!, TEAM_TWO),
    /already locked/i,
  );
  const edited = await service.updateRegisteredTeam(tournament.id, PLAYERS[1]!, TEAM_ONE);
  assert.equal(edited.players.find(player => player.id === PLAYERS[1])?.team, TEAM_ONE);

  await assert.rejects(
    () => service.startTournament(tournament.id),
    /finalization is still open/i,
  );

  now = opened.finalizesAt!;
  await assert.rejects(
    () => service.updateRegisteredTeam(tournament.id, PLAYERS[1]!, TEAM_TWO),
    /closed/i,
  );
  const started = await service.startTournament(tournament.id);
  assert.equal(started.status, 'in-progress');
  const bracket = await service.getBracket(started.id);
  assert.equal(bracket.length > 0, true);
  assert.equal(
    bracket.some(match => match.player1 === PLAYERS[1] || match.player2 === PLAYERS[1]),
    true,
  );
});

test('leaving before the deadline reopens registration and releases the shared timer', async () => {
  let now = 5_000;
  const service = new TournamentService({ now: () => now });
  const tournament = await service.createTournament({
    title: 'Gen 1 Cup',
    format: 'gen9ou',
    ruleset: 'gen1cup',
    maxPlayers: 4,
    entryFee: 0,
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYERS.entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `Player ${index + 1}`,
      team: TEAM_ONE,
    });
  }
  await service.beginTeamFinalization(tournament.id);
  const left = await service.withdrawPlayer(tournament.id, PLAYERS[3]!);
  assert.equal(left.finalizesAt, undefined);
  assert.equal(left.players.filter(player => player.status === 'registered').length, 3);
  await assert.rejects(
    () => service.startTournament(left.id),
    /power of two/i,
  );
});
