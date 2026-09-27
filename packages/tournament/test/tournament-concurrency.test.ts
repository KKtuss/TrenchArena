import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DuplicateRegistrationError,
  InMemoryAsyncTournamentRepository,
  TournamentService,
  createTournamentPlayerId,
  type TournamentMatch,
} from '../src';
import { TEAM_ONE, TEAM_TWO } from './fixtures';

const PLAYERS = ['player-1', 'player-2', 'player-3', 'player-4', 'player-5']
  .map(createTournamentPlayerId);

test('concurrent registration cannot exceed capacity or double-reserve a player', async () => {
  const holds = new Map<string, number>();
  const ledger = {
    async reserve(holdKey: string, _playerId: string, amount: number): Promise<boolean> {
      if (holds.has(holdKey)) return false;
      holds.set(holdKey, amount);
      return true;
    },
    async release(holdKey: string): Promise<number> {
      const amount = holds.get(holdKey) ?? 0;
      holds.delete(holdKey);
      return amount;
    },
  };
  const service = new TournamentService({
    repository: new InMemoryAsyncTournamentRepository(undefined, ledger),
  });
  const tournament = await service.createTournament({
    title: 'Capacity Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    hostId: 'host',
    entryFee: 50_000,
  });
  await service.openRegistration(tournament.id);

  const results = await Promise.allSettled(PLAYERS.map((playerId, index) => (
    service.registerPlayer(tournament.id, {
      playerId,
      displayName: `P${index}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    })
  )));
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 4);
  assert.equal(rejected.length, 1);
  assert.match(String((rejected[0] as PromiseRejectedResult).reason), /player limit/);
  assert.equal(holds.size, 4);

  const loaded = await service.getTournament(tournament.id);
  assert.equal(loaded.players.filter(player => player.status === 'registered').length, 4);

  await assert.rejects(
    () => service.registerPlayer(tournament.id, {
      playerId: PLAYERS[0],
      displayName: 'Again',
      team: TEAM_ONE,
    }),
    DuplicateRegistrationError,
  );
  assert.equal(holds.size, 4);
});

test('concurrent start produces one bracket', async () => {
  const service = new TournamentService();
  const tournament = await service.createTournament({
    title: 'Start Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYERS.slice(0, 4).entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `P${index}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  const [first, second] = await Promise.all([
    service.startTournament(tournament.id),
    service.startTournament(tournament.id),
  ]);
  assert.equal(first.status, 'in-progress');
  assert.equal(second.status, 'in-progress');
  const bracket = await service.getBracket(tournament.id);
  assert.equal(bracket.length, 3);
  assert.equal(bracket.filter(match => match.round === 1 && match.status === 'ready').length, 2);
});

test('concurrent match completion advances the bracket once', async () => {
  const service = new TournamentService({
    battleEngine: {
      async createBattle(input: { players: Array<{ id: string }> }) {
        const winner = input.players[0].id;
        const result = {
          status: 'win' as const,
          winner,
          score: [6, 0],
          turns: 1,
        };
        return {
          id: 'win-session',
          async start() {},
          getResult: () => result,
          getState: () => ({
            id: 'win-session',
            lifecycle: 'ended',
            format: 'gen9ou',
            players: input.players.map(player => ({ id: player.id, name: player.id })),
            result,
          }),
          subscribe(listener: (terminal: { type: 'completed'; result: typeof result }) => void) {
            queueMicrotask(() => listener({ type: 'completed', result }));
            return () => undefined;
          },
          subscribeEvents: () => () => undefined,
        };
      },
    } as any,
  });
  const tournament = await service.createTournament({
    title: 'Complete Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'fixed',
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYERS.slice(0, 4).entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `P${index}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 1)!;
  const started = await service.startMatch(match.id);
  const settled = await waitFor(service, match.id);
  assert.ok(settled.winner);
  const battleResult = settled.result;
  assert.ok(battleResult?.kind === 'battle');
  const again = await service.applyBattleResult(
    match.id,
    started.battleInstanceId!,
    battleResult.battleResult,
  );
  assert.equal(settled.winner, again.winner);
  const next = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 2)!;
  const advanced = [next.player1, next.player2].filter(Boolean);
  assert.equal(advanced.length, 1);
});

test('a tied match can be replayed but cannot produce two terminal winners', async () => {
  const tieResult = { status: 'tie' as const, score: [0, 0], turns: 0 };
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
              { id: PLAYERS[0], name: 'P1' },
              { id: PLAYERS[1], name: 'P2' },
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
    title: 'Replay Cup',
    format: 'gen9ou',
    maxPlayers: 4,
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYERS.slice(0, 4).entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `P${index}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 1)!;
  const first = await service.startMatch(match.id);
  const tied = await waitFor(service, match.id);
  assert.equal(tied.status, 'tied');
  const [replay, concurrent] = await Promise.allSettled([
    service.startMatch(match.id),
    service.startMatch(match.id),
  ]);
  const started = [replay, concurrent].filter(result => result.status === 'fulfilled');
  const blocked = [replay, concurrent].filter(result => result.status === 'rejected');
  assert.equal(started.length, 1);
  assert.equal(blocked.length, 1);
  assert.notEqual(
    (started[0] as PromiseFulfilledResult<TournamentMatch>).value.battleInstanceId,
    first.battleInstanceId,
  );
  const again = await waitFor(service, match.id);
  assert.equal(again.status, 'tied');
  assert.equal(again.winner, undefined);
  const next = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 2)!;
  assert.equal(next.player1, undefined);
  assert.equal(next.player2, undefined);
});

test('restarting the in-memory store reconstructs host, fee, roster, and bracket', async () => {
  const ledger = {
    async reserve(): Promise<boolean> { return true; },
    async release(): Promise<number> { return 0; },
  };
  const repository = new InMemoryAsyncTournamentRepository(undefined, ledger);
  const service = new TournamentService({ repository });
  const tournament = await service.createTournament({
    title: 'Restart Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    hostId: 'host-wallet',
    entryFee: 25_000,
    bracketSeed: 'restart',
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYERS.slice(0, 4).entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `P${index}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(candidate => candidate.round === 1)!;
  await repository.commitMatchOutcome({
    match: {
      ...match,
      status: 'completed',
      winner: match.player1,
      completedAt: Date.now(),
      updatedAt: Date.now(),
      result: { kind: 'battle', battleResult: { status: 'win', winner: match.player1, score: [6, 0], turns: 1 } },
    },
  });

  const snapshot = await repository.getTournament(tournament.id);
  assert.ok(snapshot);
  const matches = await repository.listMatches(tournament.id);
  const fresh = new InMemoryAsyncTournamentRepository();
  await fresh.saveTournament(snapshot);
  for (const item of matches) await fresh.saveMatch(item);
  const restarted = new TournamentService({ repository: fresh });
  const loaded = await restarted.getTournament(tournament.id);
  assert.equal(loaded.hostId, 'host-wallet');
  assert.notEqual(loaded.hostId, PLAYERS[0]);
  assert.equal(loaded.entryFee, 25_000);
  assert.equal(loaded.players.length, 4);
  assert.equal(loaded.players[0]?.team, TEAM_ONE);
  const bracket = await restarted.getBracket(tournament.id);
  assert.equal(bracket.length, 3);
  const stored = bracket.find(item => item.id === match.id);
  assert.equal(stored?.status, 'completed');
  assert.equal(stored?.winner, match.player1);
});

test('an interrupted live match can be restarted without inventing a winner', async () => {
  const repository = new InMemoryAsyncTournamentRepository();
  const service = new TournamentService({ repository });
  const tournament = await service.createTournament({
    title: 'Interrupt Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    hostId: 'host-a',
    bracketSeed: 'interrupt',
  });
  await service.openRegistration(tournament.id);
  for (const [index, playerId] of PLAYERS.slice(0, 4).entries()) {
    await service.registerPlayer(tournament.id, {
      playerId,
      displayName: `P${index}`,
      team: index % 2 === 0 ? TEAM_ONE : TEAM_TWO,
    });
  }
  await service.startTournament(tournament.id);
  const match = (await service.getBracket(tournament.id)).find(item => item.round === 1)!;
  await service.startMatch(match.id);
  const interrupted = await repository.interruptMatch(match.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.winner, undefined);
  assert.equal(interrupted.result, undefined);

  const restarted = new TournamentService({ repository });
  const resumed = await restarted.startMatch(match.id);
  assert.notEqual(resumed.status, 'interrupted');
  assert.ok(resumed.status === 'battle-created' || resumed.status === 'active' || resumed.status === 'completed' || resumed.status === 'forfeited' || resumed.status === 'tied');
  if (resumed.status === 'battle-created' || resumed.status === 'active') {
    assert.equal(resumed.winner, undefined);
  }
});

async function waitFor(service: TournamentService, matchId: TournamentMatch['id']): Promise<TournamentMatch> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const current = (await service.getMatch(matchId)).match;
    if (current.status === 'completed' || current.status === 'forfeited' || current.status === 'tied') {
      return current;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Match did not settle: ${matchId}`);
}
