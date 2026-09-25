import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AvailableChoice,
  type PlayerChoice,
} from '@pokearena/battle-engine';

import {
  DuplicateRegistrationError,
  InsufficientPlayersError,
  InvalidMatchResultError,
  InvalidTournamentStateTransitionError,
  RegistrationClosedError,
} from '../src';
import {
  createTournamentPlayerId,
  TournamentService,
  type TournamentMatch,
} from '../src';
import { TEAM_ONE, TEAM_TWO } from './fixtures';

const PLAYER_IDS = ['player-1', 'player-2', 'player-3', 'player-4']
  .map(createTournamentPlayerId);

function createService(): TournamentService {
  return new TournamentService();
}

function createFourPlayerTournament(
  service: TournamentService,
  bracketSeed = 'test-seed',
): ReturnType<TournamentService['createTournament']> {
  const tournament = service.createTournament({
    title: 'Integration Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed,
    matchTimeoutMs: 15_000,
  });
  service.openRegistration(tournament.id);
  PLAYER_IDS.forEach((playerId, index) => {
    service.registerPlayer(tournament.id, {
      playerId,
      displayName: `Player ${index + 1}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  });
  return tournament;
}

async function completeMatch(
  service: TournamentService,
  matchId: TournamentMatch['id'],
): Promise<TournamentMatch> {
  const started = await service.startMatch(matchId);
  assert.equal(started.status, 'active');

  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const current = service.getMatch(matchId).match;
    if (current.status === 'completed' || current.status === 'forfeited') return current;
    assert.ok(current.status === 'active' && current.battleInstanceId);

    let submitted = false;
    for (const playerId of [current.player1, current.player2]) {
      if (!playerId) continue;
      const state = service.getMatchState(matchId, playerId);
      const request = state?.request;
      if (!request || !request.choices.length) continue;

      await service.submitChoice({
        matchId,
        battleInstanceId: current.battleInstanceId,
        playerId,
        revision: request.revision,
        choice: choiceFor(request.choices[0]),
      });
      submitted = true;
    }

    if (!submitted) await tick();
  }

  throw new Error(`Match did not complete: ${matchId}`);
}

function choiceFor(choice: AvailableChoice): PlayerChoice {
  switch (choice.type) {
    case 'team-preview':
      return { type: 'team-preview' };
    case 'move':
      return { type: 'move', slot: choice.slot };
    case 'switch':
      return { type: 'switch', slot: choice.slot };
    case 'pass':
      return { type: 'pass' };
  }
}

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

test('runs a complete four-player tournament through BattleEngine', async () => {
  const service = createService();
  const tournament = createFourPlayerTournament(service);

  const started = service.startTournament(tournament.id);
  assert.equal(started.status, 'in-progress');

  const initialBracket = service.getBracket(tournament.id);
  assert.equal(initialBracket.length, 3);
  assert.equal(initialBracket.filter(match => match.round === 1).length, 2);
  assert.equal(initialBracket.filter(match => match.status === 'ready').length, 2);

  const semifinalOne = initialBracket.find(match => (
    match.round === 1 && match.bracketPosition === 0
  ))!;
  const semifinalTwo = initialBracket.find(match => (
    match.round === 1 && match.bracketPosition === 1
  ))!;

  const completedOne = await completeMatch(service, semifinalOne.id);
  assert.equal(completedOne.status, 'completed');
  assert.ok(completedOne.winner);

  const completedTwo = await completeMatch(service, semifinalTwo.id);
  assert.equal(completedTwo.status, 'completed');
  assert.ok(completedTwo.winner);

  const final = service.getBracket(tournament.id)
    .find(match => match.round === 2)!;
  assert.equal(final.status, 'ready');
  assert.deepEqual(
    new Set([final.player1, final.player2]),
    new Set([completedOne.winner, completedTwo.winner]),
  );

  const completedFinal = await completeMatch(service, final.id);
  assert.equal(completedFinal.status, 'completed');
  assert.ok(completedFinal.winner);

  const result = service.getTournamentResult(tournament.id);
  assert.ok(result);
  assert.equal(result.winner, completedFinal.winner);
  assert.equal(service.getTournament(tournament.id).status, 'completed');
});

test('rejects duplicate registration and registration after tournament start', () => {
  const service = createService();
  const tournament = service.createTournament({
    title: 'Registration Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  service.openRegistration(tournament.id);
  service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[0],
    displayName: 'Player 1',
    team: TEAM_ONE,
  });
  assert.throws(
    () => service.registerPlayer(tournament.id, {
      playerId: PLAYER_IDS[0],
      displayName: 'Duplicate',
      team: TEAM_TWO,
    }),
    DuplicateRegistrationError,
  );

  service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[1],
    displayName: 'Player 2',
    team: TEAM_TWO,
  });
  service.startTournament(tournament.id);
  assert.throws(
    () => service.registerPlayer(tournament.id, {
      playerId: PLAYER_IDS[2],
      displayName: 'Late Player',
      team: TEAM_ONE,
    }),
    RegistrationClosedError,
  );
});

test('generates and persists a deterministic bracket', () => {
  const firstService = createService();
  const secondService = createService();
  const first = createFourPlayerTournament(firstService, 'same-seed');
  const second = createFourPlayerTournament(secondService, 'same-seed');
  firstService.startTournament(first.id);
  secondService.startTournament(second.id);

  const snapshot = (service: TournamentService, id: typeof first.id) => (
    service.getBracket(id).map(match => [
      match.round,
      match.bracketPosition,
      match.player1,
      match.player2,
    ])
  );
  assert.deepEqual(snapshot(firstService, first.id), snapshot(secondService, second.id));

  const before = snapshot(firstService, first.id);
  firstService.getBracket(first.id);
  assert.deepEqual(snapshot(firstService, first.id), before);
});

test('supports eight- and sixteen-player bracket sizes', () => {
  for (const maxPlayers of [8, 16] as const) {
    const service = createService();
    const tournament = service.createTournament({
      title: `${maxPlayers}-Player Cup`,
      format: 'gen9ou',
      maxPlayers,
    });
    service.openRegistration(tournament.id);
    for (let index = 0; index < maxPlayers; index += 1) {
      service.registerPlayer(tournament.id, {
        playerId: createTournamentPlayerId(`size-${maxPlayers}-${index}`),
        displayName: `Size Player ${index}`,
        team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
      });
    }
    service.startTournament(tournament.id);
    assert.equal(service.getBracket(tournament.id).length, maxPlayers - 1);
  }
});

test('withdraws before start and rejects insufficient players', () => {
  const service = createService();
  const tournament = service.createTournament({
    title: 'Withdrawal Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  service.openRegistration(tournament.id);
  service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[0],
    displayName: 'Player 1',
    team: TEAM_ONE,
  });
  service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[1],
    displayName: 'Player 2',
    team: TEAM_TWO,
  });
  service.withdrawPlayer(tournament.id, PLAYER_IDS[1]);
  assert.equal(
    service.getTournament(tournament.id).players.find(player => player.id === PLAYER_IDS[1])?.status,
    'withdrawn',
  );
  assert.throws(() => service.startTournament(tournament.id), InsufficientPlayersError);
});

test('rejects invalid tournament state transitions and invalid match results', async () => {
  const service = createService();
  const tournament = service.createTournament({
    title: 'State Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  assert.throws(() => service.startTournament(tournament.id), InvalidTournamentStateTransitionError);
  service.openRegistration(tournament.id);
  for (let index = 0; index < 4; index += 1) {
    service.registerPlayer(tournament.id, {
      playerId: PLAYER_IDS[index],
      displayName: `Player ${index}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  service.startTournament(tournament.id);
  const match = service.getBracket(tournament.id).find(candidate => candidate.round === 1)!;
  const started = await service.startMatch(match.id);
  assert.ok(started.battleInstanceId);

  assert.throws(
    () => service.applyBattleResult(match.id, started.battleInstanceId!, {
      status: 'win',
      winner: PLAYER_IDS[0],
      score: [6, 0],
      turns: 1,
    }),
    InvalidMatchResultError,
  );
});

test('applies the same completed result twice without changing the tournament', async () => {
  const service = createService();
  const tournament = createFourPlayerTournament(service);
  service.startTournament(tournament.id);
  const match = service.getBracket(tournament.id).find(candidate => candidate.round === 1)!;
  const completed = await completeMatch(service, match.id);
  const battleResult = completed.result;
  assert.ok(battleResult?.kind === 'battle');

  const again = service.applyBattleResult(
    match.id,
    completed.battleInstanceId!,
    battleResult.battleResult,
  );
  assert.deepEqual(again, completed);
});

test('uses the configured deterministic timeout-forfeit policy', async () => {
  const service = new TournamentService({ timeoutForfeitPlayer: 'player1' });
  const tournament = service.createTournament({
    title: 'Timeout Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    matchTimeoutMs: 5,
  });
  service.openRegistration(tournament.id);
  service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[0],
    displayName: 'Player 1',
    team: TEAM_ONE,
  });
  service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[1],
    displayName: 'Player 2',
    team: TEAM_TWO,
  });
  service.startTournament(tournament.id);
  const match = service.getBracket(tournament.id).find(candidate => candidate.round === 1)!;
  const result = await service.startMatch(match.id);
  await new Promise(resolve => setTimeout(resolve, 25));
  const forfeited = service.forfeitExpiredMatch(result.id);
  assert.equal(forfeited.status, 'forfeited');
  assert.equal(forfeited.winner, PLAYER_IDS[1]);
});
