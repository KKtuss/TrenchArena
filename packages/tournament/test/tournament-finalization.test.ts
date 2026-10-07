import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BURN_PAYMENT_WINDOW_MS,
  createTournamentPlayerId,
  TEAM_FINALIZATION_MS,
  TOURNAMENT_BURN_FEE_ATOMS,
  TournamentService,
} from '../src';
import { TEAM_ONE, TEAM_TWO } from './fixtures';

const PLAYERS = ['player-1', 'player-2', 'player-3', 'player-4'].map(createTournamentPlayerId);

test('chain tournaments allow a 16-player or 32-player field and the fixed burn fee', async () => {
  const service = new TournamentService();
  await assert.rejects(
    () => service.createTournament({
      title: 'Invalid Chain Cup',
      format: 'gen9ou',
      maxPlayers: 4,
      rail: 'sol_chain',
      entryAtoms: 10_000,
    }),
    /16-player or 32-player field/i,
  );
  await assert.rejects(
    () => service.createTournament({
      title: 'Invalid Eight Cup',
      format: 'gen9ou',
      maxPlayers: 8,
      rail: 'sol_chain',
      entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
    }),
    /16-player or 32-player field/i,
  );
  const sixteen = await service.createTournament({
    title: 'Sixteen Chain Cup',
    format: 'gen9ou',
    maxPlayers: 16,
    rail: 'sol_chain',
    entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
  });
  assert.equal(sixteen.maxPlayers, 16);
  await assert.rejects(
    () => service.createTournament({
      title: 'Display Units Cup',
      format: 'gen9ou',
      maxPlayers: 32,
      rail: 'sol_chain',
      entryAtoms: 10_000,
    }),
    /10,000,000,000 raw atoms/i,
  );
  await assert.rejects(
    () => service.createTournament({
      title: 'Invalid Fee Cup',
      format: 'gen9ou',
      maxPlayers: 32,
      rail: 'sol_chain',
      entryAtoms: 9_999,
    }),
    /10,000,000,000 raw atoms/i,
  );
  const created = await service.createTournament({
    title: 'Valid Fee Cup',
    format: 'gen9ou',
    maxPlayers: 32,
    rail: 'sol_chain',
    entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
  });
  assert.equal(created.entryAtoms, 10_000_000_000);
  assert.equal(created.entryAtoms, TOURNAMENT_BURN_FEE_ATOMS);
});

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

test('chain payment finalization replaces unpaid players sequentially before the roster locks', async () => {
  let now = 20_000;
  const service = new TournamentService({ now: () => now });
  const tournament = await service.createTournament({
    title: 'Chain Cup',
    format: 'gen9ou',
    ruleset: 'gen9cup',
    maxPlayers: 32,
    rail: 'sol_chain',
    entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
    prizeLamports: 100,
  });
  await service.openRegistration(tournament.id);
  const players = [
    ...Array.from({ length: 32 }, (_, index) => `chain-${index + 1}`),
    'wait-1',
  ].map(createTournamentPlayerId);
  for (const [index, playerId] of players.entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: playerId,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }

  const opened = await service.beginTeamFinalization(tournament.id);
  assert.equal(opened.finalizesAt, now + BURN_PAYMENT_WINDOW_MS);
  await assert.rejects(
    () => service.startTournament(tournament.id),
    /payment finalization is incomplete/i,
  );
  for (const playerId of players.slice(0, 31)) {
    await service.markBurnFeePaid(tournament.id, playerId!);
  }

  now = opened.finalizesAt!;
  const replacement = await service.advanceBurnFeeWindow(tournament.id);
  assert.equal(replacement.promotedPlayerId, players[32]);
  assert.equal(replacement.readyToFinalize, false);
  assert.equal(
    replacement.tournament.players.find(player => player.id === players[31])?.status,
    'withdrawn',
  );
  assert.equal(
    replacement.tournament.players.find(player => player.id === players[32])?.status,
    'registered',
  );

  await service.markBurnFeePaid(tournament.id, players[32]!);
  now = replacement.tournament.finalizesAt!;
  const finalized = await service.advanceBurnFeeWindow(tournament.id);
  assert.equal(finalized.readyToFinalize, true);
  assert.equal(finalized.tournament.finalizesAt, now);
  assert.equal(
    finalized.tournament.players
      .filter(player => player.status === 'registered')
      .every(player => player.burnFeePaid === true),
    true,
  );
  const started = await service.startTournament(tournament.id);
  assert.equal(started.status, 'in-progress');
});
