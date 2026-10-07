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
  type Tournament,
  type TournamentMatch,
} from '../src';
import { TEAM_ONE, TEAM_TWO } from './fixtures';

const PLAYER_IDS = ['player-1', 'player-2', 'player-3', 'player-4']
  .map(createTournamentPlayerId);

function createService(): TournamentService {
  return new TournamentService();
}

async function createFourPlayerTournament(
  service: TournamentService,
  bracketSeed = 'test-seed',
): Promise<Tournament> {
  const tournament = await service.createTournament({
    title: 'Integration Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed,
    matchTimeoutMs: 15_000,
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYER_IDS.entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `Player ${index + 1}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  return tournament;
}

async function completeMatch(
  service: TournamentService,
  matchId: TournamentMatch['id'],
): Promise<TournamentMatch> {
  const started = await service.startMatch(matchId);
  assert.equal(started.status, 'active');

  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const current = (await service.getMatch(matchId)).match;
    if (current.status === 'completed' || current.status === 'forfeited') return current;
    assert.ok(current.status === 'active' && current.battleInstanceId);

    let submitted = false;
    for (const playerId of [current.player1, current.player2]) {
      if (!playerId) continue;
      const state = await service.getMatchState(matchId, playerId);
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
  const tournament = await createFourPlayerTournament(service);

  const started = await service.startTournament(tournament.id);
  assert.equal(started.status, 'in-progress');

  const initialBracket = await service.getBracket(tournament.id);
  assert.equal(initialBracket.length, 4);
  assert.equal(initialBracket.filter(match => match.round === 1).length, 2);
  assert.equal(initialBracket.filter(match => match.status === 'ready').length, 2);
  assert.equal(initialBracket.filter(match => match.role === 'third-place').length, 1);

  const semifinalOne = initialBracket.find(match => (
    match.round === 1 && match.bracketPosition === 0
  ))!;
  const semifinalTwo = initialBracket.find(match => (
    match.round === 1 && match.bracketPosition === 1
  ))!;
  await completeMatch(service, semifinalOne.id);
  await completeMatch(service, semifinalTwo.id);

  const afterSemis = await service.getBracket(tournament.id);
  const finalMatch = afterSemis.find(match => match.round === 2 && match.bracketPosition === 0)!;
  const thirdMatch = afterSemis.find(match => match.role === 'third-place')!;
  assert.equal(finalMatch.status, 'ready');
  assert.equal(thirdMatch.status, 'ready');
  const playedFinal = await completeMatch(service, finalMatch.id);

  const afterFinal = await service.getTournament(tournament.id);
  assert.equal(afterFinal.status, 'in-progress');
  assert.equal(afterFinal.winner, undefined);
  const playedThird = await completeMatch(service, thirdMatch.id);

  const completed = await service.getTournament(tournament.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.winner, playedFinal.winner);
  const result = await service.getTournamentResult(tournament.id);
  const runnerUp = playedFinal.winner === playedFinal.player1 ? playedFinal.player2 : playedFinal.player1;
  assert.equal(result?.winner, completed.winner);
  assert.equal(result?.runnerUp, runnerUp);
  assert.equal(result?.thirdPlace, playedThird.winner);
  assert.notEqual(result?.thirdPlace, result?.winner);
});

test('rejects duplicate registration and registration after tournament start', async () => {
  const service = createService();
  const tournament = await service.createTournament({
    title: 'Registration Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  await service.openRegistration(tournament.id);
  await service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[0],
    displayName: 'Player 1',
    team: TEAM_ONE,
  });
  await assert.rejects(
    () => service.registerPlayer(tournament.id, {
      playerId: PLAYER_IDS[0],
      displayName: 'Duplicate',
      team: TEAM_TWO,
    }),
    DuplicateRegistrationError,
  );

  await service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[1],
    displayName: 'Player 2',
    team: TEAM_TWO,
  });
  await service.startTournament(tournament.id);
  await assert.rejects(
    () => service.registerPlayer(tournament.id, {
      playerId: PLAYER_IDS[2],
      displayName: 'Late Player',
      team: TEAM_ONE,
    }),
    RegistrationClosedError,
  );
});

test('generates and persists a deterministic bracket', async () => {
  const firstService = createService();
  const secondService = createService();
  const first = await createFourPlayerTournament(firstService, 'same-seed');
  const second = await createFourPlayerTournament(secondService, 'same-seed');
  await firstService.startTournament(first.id);
  await secondService.startTournament(second.id);

  const snapshot = async (service: TournamentService, id: typeof first.id) => (
    (await service.getBracket(id)).map(match => [
      match.round,
      match.bracketPosition,
      match.player1,
      match.player2,
    ])
  );
  assert.deepEqual(await snapshot(firstService, first.id), await snapshot(secondService, second.id));

  const before = await snapshot(firstService, first.id);
  await firstService.getBracket(first.id);
  assert.deepEqual(await snapshot(firstService, first.id), before);
});

test('supports eight- and sixteen-player bracket sizes', async () => {
  for (const maxPlayers of [8, 16, 32] as const) {
    const service = createService();
    const tournament = await service.createTournament({
      title: `${maxPlayers}-Player Cup`,
      format: 'gen9ou',
      maxPlayers,
    });
    await service.openRegistration(tournament.id);
    for (let index = 0; index < maxPlayers; index += 1) {
      await service.registerPlayer(tournament.id, {
        playerId: createTournamentPlayerId(`size-${maxPlayers}-${index}`),
        displayName: `Size Player ${index}`,
        team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
      });
    }
    await service.startTournament(tournament.id);
    const matches = await service.getBracket(tournament.id);
    const elimination = matches.filter(match => match.role !== 'third-place');
    assert.equal(elimination.length, maxPlayers - 1);
    assert.equal(matches.filter(match => match.role === 'third-place').length, 1);
  }
});

test('withdraws before start and rejects insufficient players', async () => {
  const service = createService();
  const tournament = await service.createTournament({
    title: 'Withdrawal Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  await service.openRegistration(tournament.id);
  await service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[0],
    displayName: 'Player 1',
    team: TEAM_ONE,
  });
  await service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[1],
    displayName: 'Player 2',
    team: TEAM_TWO,
  });
  await service.withdrawPlayer(tournament.id, PLAYER_IDS[1]);
  assert.equal(
    (await service.getTournament(tournament.id)).players.find(player => player.id === PLAYER_IDS[1])?.status,
    'withdrawn',
  );
  await assert.rejects(() => service.startTournament(tournament.id), InsufficientPlayersError);
});

test('a withdrawn player can rejoin while registration is still open', async () => {
  const service = createService();
  const tournament = await service.createTournament({
    title: 'Rejoin Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  await service.openRegistration(tournament.id);
  await service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[0],
    displayName: 'Player 1',
    team: TEAM_ONE,
  });
  await service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[1],
    displayName: 'Player 2',
    team: TEAM_TWO,
  });
  await service.withdrawPlayer(tournament.id, PLAYER_IDS[1]);
  const rejoined = await service.registerPlayer(tournament.id, {
    playerId: PLAYER_IDS[1],
    displayName: 'Player 2 Again',
    team: TEAM_TWO,
  });
  assert.equal(rejoined.status, 'registered');
  assert.equal(rejoined.displayName, 'Player 2 Again');
  const loaded = await service.getTournament(tournament.id);
  assert.equal(loaded.players.filter(player => player.status === 'registered').length, 2);
  assert.equal(loaded.players.find(player => player.id === PLAYER_IDS[1])?.status, 'registered');
  await assert.rejects(
    () => service.registerPlayer(tournament.id, {
      playerId: PLAYER_IDS[1],
      displayName: 'Player 2',
      team: TEAM_TWO,
    }),
    DuplicateRegistrationError,
  );
});

test('rejects invalid tournament state transitions and invalid match results', async () => {
  const service = createService();
  const tournament = await service.createTournament({
    title: 'State Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  await assert.rejects(() => service.startTournament(tournament.id), InvalidTournamentStateTransitionError);
  await service.openRegistration(tournament.id);
  for (let index = 0; index < 4; index += 1) {
    await service.registerPlayer(tournament.id, {
      playerId: PLAYER_IDS[index],
      displayName: `Player ${index}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 1)!;
  const started = await service.startMatch(match.id);
  assert.ok(started.battleInstanceId);

  await assert.rejects(
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
  const tournament = await createFourPlayerTournament(service);
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 1)!;
  const completed = await completeMatch(service, match.id);
  const battleResult = completed.result;
  assert.ok(battleResult?.kind === 'battle');

  const again = await service.applyBattleResult(
    match.id,
    completed.battleInstanceId!,
    battleResult.battleResult,
  );
  assert.deepEqual(again, completed);
});

test('a live forfeit awards the opponent once and advances that winner', async () => {
  const service = createService();
  const tournament = await createFourPlayerTournament(service);
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(candidate => (
    candidate.round === 1 && candidate.bracketPosition === 0
  ))!;
  const started = await service.startMatch(match.id);
  const loser = started.player1!;
  const winner = started.player2!;
  const first = await service.forfeit(started.id, loser);
  assert.ok(first.status === 'completed' || first.status === 'forfeited');
  assert.equal(first.winner, winner);
  assert.notEqual(first.winner, loser);
  const second = await service.forfeit(started.id, loser);
  assert.equal(second.winner, winner);
  assert.equal(second.completedAt, first.completedAt);
  const next = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 2)!;
  const advanced = [next.player1, next.player2].filter(Boolean);
  assert.equal(advanced.includes(winner), true);
  assert.equal(advanced.includes(loser), false);
});

test('timeout awards the player who still made decisions, not bracket slot player1', async () => {
  async function playTimeout(silentSlot: 'player1' | 'player2') {
    const service = new TournamentService();
    const tournament = await service.createTournament({
      title: 'Timeout Cup',
      format: 'gen9ou',
      maxPlayers: 4,
      bracketSeed: 'timeout-seed',
      matchTimeoutMs: 1_200,
    });
    await service.openRegistration(tournament.id);
    for (const [index, playerId] of PLAYER_IDS.entries()) {
      await service.registerPlayer(tournament.id, {
        playerId,
        displayName: `Player ${index + 1}`,
        team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
      });
    }
    await service.startTournament(tournament.id);
    const match = (await service.getBracket(tournament.id)).find(candidate => (
      candidate.round === 1 && candidate.bracketPosition === 0
    ))!;
    const silent = match[silentSlot];
    const active = silentSlot === 'player1' ? match.player2 : match.player1;
    assert.ok(silent && active);

    const started = await service.startMatch(match.id);
    const request = (await service.getMatchState(match.id, active))?.request;
    assert.ok(request?.choices.length);
    await service.submitChoice({
      matchId: match.id,
      battleInstanceId: started.battleInstanceId!,
      playerId: active,
      revision: request.revision,
      choice: choiceFor(request.choices[0]),
    });

    const settled = await waitForMatch(service, match.id);
    assert.equal(settled.status, 'forfeited');
    assert.equal(settled.winner, active);
    assert.notEqual(settled.winner, silent);
    assert.equal(settled.result?.kind, 'battle');
    if (settled.result?.kind === 'battle') {
      assert.equal(settled.result.battleResult.endedBy, 'timeout');
      assert.equal(settled.result.battleResult.winner, active);
    }

    const again = await service.forfeitExpiredMatch(match.id);
    assert.equal(again.winner, active);
    assert.equal(again.status, 'forfeited');
    if (again.result?.kind === 'battle') {
      const duplicate = await service.applyBattleResult(
        match.id,
        again.battleInstanceId!,
        again.result.battleResult,
      );
      assert.equal(duplicate.winner, active);
    }

    const next = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 2)!;
    const advanced = [next.player1, next.player2].filter(Boolean);
    assert.equal(advanced.includes(active), true);
    assert.equal(advanced.includes(silent), false);
    return { service, tournament, match: settled, next };
  }

  await playTimeout('player1');
  await playTimeout('player2');
});

async function waitForMatch(
  service: TournamentService,
  matchId: TournamentMatch['id'],
  timeoutMs = 5_000,
): Promise<TournamentMatch> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = (await service.getMatch(matchId)).match;
    if (current.status === 'completed' || current.status === 'forfeited' || current.status === 'tied') {
      return current;
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Match did not settle: ${matchId}`);
}

test('a tie does not award player1 or advance the bracket', async () => {
  const tieResult = {
    status: 'tie' as const,
    score: [0, 0],
    turns: 0,
  };
  const service = new TournamentService({
    battleEngine: {
      async createBattle() {
        return {
          id: 'tie-session',
          async start() {},
          getResult: () => tieResult,
          getState: () => ({
            id: 'tie-session',
            lifecycle: 'ended',
            format: 'gen9ou',
            players: [
              { id: PLAYER_IDS[0], name: 'Player 1' },
              { id: PLAYER_IDS[1], name: 'Player 2' },
            ],
            result: tieResult,
          }),
          subscribe(listener: (terminal: { type: 'completed'; result: typeof tieResult }) => void) {
            queueMicrotask(() => listener({ type: 'completed', result: tieResult }));
            return () => undefined;
          },
          subscribeEvents: () => () => undefined,
        };
      },
    } as any,
  });
  const tournament = await service.createTournament({
    title: 'Tie Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'tie-seed',
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYER_IDS.entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `Player ${index + 1}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 1)!;
  const slotOne = match.player1;
  const started = await service.startMatch(match.id);
  const settled = await waitForMatch(service, match.id);
  assert.equal(settled.status, 'tied');
  assert.equal(settled.winner, undefined);
  assert.notEqual(settled.winner, slotOne);
  assert.equal(settled.result?.kind, 'battle');
  if (settled.result?.kind === 'battle') {
    assert.equal(settled.result.battleResult.status, 'tie');
    assert.equal(settled.result.battleResult.winner, undefined);
  }
  assert.equal((await service.getTournament(tournament.id)).status, 'in-progress');
  assert.equal((await service.getTournament(tournament.id)).winner, undefined);
  const next = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 2)!;
  assert.equal(next.player1, undefined);
  assert.equal(next.player2, undefined);
  assert.equal(next.status, 'pending');

  const again = await service.applyBattleResult(match.id, started.battleInstanceId!, tieResult);
  assert.equal(again.status, 'tied');
  assert.equal(again.winner, undefined);
});

test('an active tournament battle ignores a premature or mismatched terminal', async () => {
  const premature = {
    status: 'win' as const,
    winner: PLAYER_IDS[0],
    score: [1, 0],
    turns: 3,
  };
  const authoritative = {
    status: 'win' as const,
    winner: PLAYER_IDS[1],
    score: [0, 1],
    turns: 9,
  };
  const service = new TournamentService({
    battleEngine: {
      async createBattle() {
        return {
          id: 'live-session',
          async start() {},
          getResult: () => undefined,
          getState: () => ({
            id: 'live-session',
            lifecycle: 'awaiting-choice',
            format: 'gen9ou',
            players: [
              { id: PLAYER_IDS[0], name: 'Player 1' },
              { id: PLAYER_IDS[1], name: 'Player 2' },
            ],
          }),
          subscribe(listener: (terminal: { type: 'completed'; result: typeof premature }) => void) {
            queueMicrotask(() => listener({ type: 'completed', result: premature }));
            queueMicrotask(() => listener({ type: 'completed', result: authoritative }));
            return () => undefined;
          },
          subscribeEvents: () => () => undefined,
        };
      },
    } as any,
  });
  const tournament = await service.createTournament({
    title: 'Live Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'live-seed',
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYER_IDS.entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `Player ${index + 1}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 1)!;
  const started = await service.startMatch(match.id);
  assert.equal(started.status, 'active');
  assert.equal(started.winner, undefined);
  const current = (await service.getMatch(match.id)).match;
  assert.equal(current.status, 'active');
  assert.equal(current.winner, undefined);
});
