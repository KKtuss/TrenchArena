import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import type { BattleEngine, BattleTerminal } from '@pokearena/battle-engine';
import {
  InMemoryAsyncTournamentRepository,
  TournamentService,
} from '@pokearena/tournament';

import { CasualRoomService } from '../src/casual-service';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { InMemoryEconomicsStore } from '../src/memory-economics-store';
import { MockEconomics } from '../src/mock-economics';
import { ApiServer } from '../src/server';
import { encodeBase58 } from '../src/wallet-auth';
import { bothConfirmCasual, openFullCasualRoom } from './casual-flow';
import {
  BRACKET_SEED,
  ENTRY_FEE,
  PLAYER_COUNT,
  SettlementProbe,
  StageReport,
  createFakeBattleEngine,
  createTournamentHarness,
  driveBracketToCompletion,
  expectedChampionAlwaysPlayer1,
  expectedFirstRoundPairings,
  makeSyntheticPlayers,
  registerField,
  settleCompletedTournament,
} from './tournament-e2e-harness';

test('32-player Custom tournament: full bracket, advancement, payout once', async () => {
  const harness = createTournamentHarness();
  const { tournaments, economics, store, battles, report, repository } = harness;
  const players = makeSyntheticPlayers(PLAYER_COUNT);
  const playerIds = players.map(player => player.id);
  const expectedPairings = expectedFirstRoundPairings(playerIds, BRACKET_SEED);
  const expectedWinner = expectedChampionAlwaysPlayer1(playerIds, BRACKET_SEED);

  report.info('setup', `Provisioning ${PLAYER_COUNT} synthetic wallets (no SOL/mainnet).`);

  const created = await tournaments.createTournament({
    title: 'E2E Custom Cup',
    format: 'gen9ou',
    ruleset: 'gen9ou',
    maxPlayers: 32,
    bracketSeed: BRACKET_SEED,
    hostId: players[0].id,
    entryFee: ENTRY_FEE,
  });
  report.check('status/draft', 'Tournament starts in draft', created.status === 'draft', 'draft', created.status);

  const open = await tournaments.openRegistration(created.id);
  report.check('status/registration', 'Registration opens', open.status === 'registration', 'registration', open.status);

  await registerField(tournaments, created.id, players, economics);
  const registered = await tournaments.getTournament(created.id);
  report.check(
    'registration',
    'All 32 synthetic players registered with entry holds',
    registered.players.filter(player => player.status === 'registered').length === 32,
    32,
    registered.players.filter(player => player.status === 'registered').length,
  );
  report.check(
    'registration/holds',
    'Entry fee holds exist for every registrant',
    players.every(player => economics.hasHold(`tournament:${created.id}:${player.id}`)),
    true,
    players.every(player => economics.hasHold(`tournament:${created.id}:${player.id}`)),
  );

  await tournaments.beginTeamFinalization(created.id);
  for (const player of players) {
    await tournaments.lockRegisteredTeam(created.id, player.id);
  }
  report.pass('custom/finalization', 'Team finalization + lock completed for custom field');

  const started = await tournaments.startTournament(created.id, { ignoreFinalization: true });
  report.check('status/in-progress', 'Tournament entered in-progress', started.status === 'in-progress', 'in-progress', started.status);

  const bracket = await tournaments.getBracket(created.id);
  report.check('bracket/size', 'Full field has N-1 elimination matches plus the third-place match', bracket.length === 32, 32, bracket.length);
  report.check(
    'bracket/rounds',
    'Rounds present: R32→R16→QF→SF→Final',
    [1, 2, 3, 4, 5].every(round => bracket.some(match => match.round === round)),
    '1..5',
    [...new Set(bracket.map(match => match.round))].sort((a, b) => a - b).join(','),
  );

  const round1 = bracket.filter(match => match.round === 1).sort((a, b) => a.bracketPosition - b.bracketPosition);
  const actualPairings = round1.map(match => [match.player1, match.player2]);
  report.check(
    'bracket/seeding',
    'First-round pairings match deterministic seed',
    JSON.stringify(actualPairings) === JSON.stringify(expectedPairings),
    expectedPairings,
    actualPairings,
  );
  report.check(
    'bracket/ready',
    'All R32 matches are ready with both players',
    round1.every(match => match.status === 'ready' && match.player1 && match.player2),
    true,
    round1.every(match => match.status === 'ready' && match.player1 && match.player2),
  );
  report.check(
    'byes',
    'No bye slots in a full 32-player field',
    round1.every(match => Boolean(match.player1 && match.player2)),
    'all filled',
    round1.filter(match => !match.player1 || !match.player2).length,
  );

  const { winner, finalMatch, matchesByRound } = await driveBracketToCompletion(
    tournaments,
    created.id,
    {
      report,
      label: 'custom',
      interruptRound1Match0: true,
      repository,
      battles,
    },
  );

  for (const [round, matches] of matchesByRound) {
    report.check(
      `custom/round-${round}-settled`,
      `All round ${round} matches settled`,
      matches.every(match => match.status === 'completed' || match.status === 'forfeited'),
      matches.length,
      matches.filter(match => match.status === 'completed' || match.status === 'forfeited').length,
    );
  }

  const completed = await tournaments.getTournament(created.id);
  report.check('status/completed', 'Tournament status is completed', completed.status === 'completed', 'completed', completed.status);
  report.check('final/winner', 'Champion matches deterministic player1-win policy', winner === expectedWinner, expectedWinner, winner);
  report.check('final/match', 'Final match winner matches tournament winner', finalMatch.winner === winner, winner, finalMatch.winner);

  const result = await tournaments.getTournamentResult(created.id);
  report.check('result', 'getTournamentResult returns champion', result?.winner === winner, winner, result?.winner);

  const view = await tournaments.getMatch(finalMatch.id);
  report.check(
    'reconnect/match-view',
    'Completed final match is readable for reconnect/state recovery',
    view.match.status === 'completed' || view.match.status === 'forfeited',
    'completed|forfeited',
    view.match.status,
  );

  if (finalMatch.battleInstanceId && finalMatch.result?.kind === 'battle') {
    const again = await tournaments.applyBattleResult(
      finalMatch.id,
      finalMatch.battleInstanceId,
      finalMatch.result.battleResult,
    );
    report.check(
      'idempotent/result',
      'Re-applying the same battle result does not change the final',
      again.winner === winner && again.status === finalMatch.status,
      winner,
      again.winner,
    );
  }

  const preview = economics.previewTournament(ENTRY_FEE, PLAYER_COUNT);
  const balanceBefore = economics.getBalance(winner);
  const payout = await settleCompletedTournament(store, completed, winner);
  report.check(
    'payout/amount',
    'Champion receives 90% treasury prize pool',
    payout.amount === preview.prizePool && payout.winnerId === winner && payout.reason === 'tournament-win',
    { winnerId: winner, amount: preview.prizePool, reason: 'tournament-win' },
    { winnerId: payout.winnerId, amount: payout.amount, reason: payout.reason },
  );
  report.check(
    'payout/balance',
    'Winner balance increases by prize pool once',
    economics.getBalance(winner) === balanceBefore + preview.prizePool,
    balanceBefore + preview.prizePool,
    economics.getBalance(winner),
  );

  const payoutAgain = await settleCompletedTournament(store, completed, winner);
  report.check(
    'payout/once',
    'Second settlement returns the same payout without double-pay',
    payoutAgain.amount === payout.amount
      && economics.getBalance(winner) === balanceBefore + preview.prizePool
      && battles.settlementProbe.callCount === 2,
    { calls: 2, balance: balanceBefore + preview.prizePool },
    { calls: battles.settlementProbe.callCount, balance: economics.getBalance(winner) },
  );
  report.check(
    'payout/settlement-key',
    'Settlement is keyed by tournament id',
    economics.inspectSettlement(`tournament:${created.id}`)?.winnerId === winner,
    winner,
    economics.inspectSettlement(`tournament:${created.id}`)?.winnerId,
  );

  {
    const failHarness = createTournamentHarness('hang');
    const miniPlayers = makeSyntheticPlayers(4);
    const mini = await failHarness.tournaments.createTournament({
      title: 'Unfinished Match Cup',
      format: 'gen9ou',
      maxPlayers: 4,
      bracketSeed: 'unfinished',
      hostId: miniPlayers[0].id,
      entryFee: 0,
    });
    await failHarness.tournaments.openRegistration(mini.id);
    await registerField(failHarness.tournaments, mini.id, miniPlayers, failHarness.economics);
    await failHarness.tournaments.startTournament(mini.id);
    const match = (await failHarness.tournaments.getBracket(mini.id)).find(item => item.round === 1)!;
    const startedHang = await failHarness.tournaments.startMatch(match.id);
    report.check(
      'unfinished/active',
      'Hang-mode match stays unfinished until forfeit',
      startedHang.status === 'active' && !startedHang.winner,
      'active/no-winner',
      `${startedHang.status}/${startedHang.winner ?? 'none'}`,
    );
    const forfeited = await failHarness.tournaments.forfeit(match.id, match.player2!);
    report.check(
      'unfinished/forfeit',
      'Forfeit settles unfinished match for the opponent',
      forfeited.status === 'forfeited' || forfeited.status === 'completed',
      'forfeited|completed',
      forfeited.status,
    );
    report.check(
      'unfinished/winner',
      'Forfeit awards the non-forfeiting player',
      forfeited.winner === match.player1,
      match.player1,
      forfeited.winner,
    );
  }

  {
    const failThenHang = createTournamentHarness('failed-then-hang');
    const miniPlayers = makeSyntheticPlayers(4);
    const mini = await failThenHang.tournaments.createTournament({
      title: 'Failed Terminal Cup',
      format: 'gen9ou',
      maxPlayers: 4,
      bracketSeed: 'failed-terminal',
      hostId: miniPlayers[0].id,
      entryFee: 0,
    });
    await failThenHang.tournaments.openRegistration(mini.id);
    await registerField(failThenHang.tournaments, mini.id, miniPlayers, failThenHang.economics);
    await failThenHang.tournaments.startTournament(mini.id);
    const match = (await failThenHang.tournaments.getBracket(mini.id)).find(item => item.round === 1)!;
    const startedFail = await failThenHang.tournaments.startMatch(match.id);
    report.check(
      'failed-terminal/no-settle',
      'Failed battle terminal does not invent a tournament winner',
      startedFail.status === 'active' && startedFail.winner === undefined,
      'active/no-winner',
      `${startedFail.status}/${startedFail.winner ?? 'none'}`,
    );
    const afterForfeit = await failThenHang.tournaments.forfeit(match.id, match.player1!);
    report.check(
      'failed-terminal/recover',
      'Forfeit recovers a failed/hanging match',
      Boolean(afterForfeit.winner) && afterForfeit.winner === match.player2,
      match.player2,
      afterForfeit.winner,
    );
  }

  report.info('cleanup', 'Each scenario uses a fresh in-memory repository/economics/battle engine.');
  report.assertAllPassed('Custom 32-player tournament E2E');
});

test('32-player Casual-format tournament: registration through champion', async () => {
  const harness = createTournamentHarness();
  const { tournaments, economics, store, report } = harness;
  const players = makeSyntheticPlayers(PLAYER_COUNT);
  const playerIds = players.map(player => player.id);
  const expectedWinner = expectedChampionAlwaysPlayer1(playerIds, BRACKET_SEED);

  const created = await tournaments.createTournament({
    title: 'E2E Casual Gen9 Cup',
    format: 'gen9ou',
    ruleset: 'gen9casual',
    maxPlayers: 32,
    bracketSeed: BRACKET_SEED,
    hostId: players[0].id,
    entryFee: ENTRY_FEE,
  });
  await tournaments.openRegistration(created.id);
  await registerField(tournaments, created.id, players, economics);
  report.check(
    'casual-cup/registration',
    'Casual-format cup registers 32 players',
    (await tournaments.getTournament(created.id)).players.length === 32,
    32,
    (await tournaments.getTournament(created.id)).players.length,
  );

  const started = await tournaments.startTournament(created.id);
  report.check('casual-cup/start', 'Casual-format cup starts', started.status === 'in-progress', 'in-progress', started.status);
  report.check(
    'casual-cup/ruleset',
    'Casual ruleset is gen9casual',
    started.ruleset === 'gen9casual',
    'gen9casual',
    started.ruleset,
  );

  const { winner } = await driveBracketToCompletion(tournaments, created.id, {
    report,
    label: 'casual-cup',
  });
  report.check('casual-cup/winner', 'Casual-format champion is deterministic', winner === expectedWinner, expectedWinner, winner);

  const completed = await tournaments.getTournament(created.id);
  const payout = await settleCompletedTournament(store, completed, winner);
  const preview = economics.previewTournament(ENTRY_FEE, PLAYER_COUNT);
  report.check(
    'casual-cup/payout',
    'Casual-format cup settles prize once',
    payout.amount === preview.prizePool && payout.winnerId === winner,
    preview.prizePool,
    payout.amount,
  );
  const again = await settleCompletedTournament(store, completed, winner);
  report.check(
    'casual-cup/payout-once',
    'Repeat settlement is idempotent',
    again.amount === payout.amount,
    payout.amount,
    again.amount,
  );

  report.assertAllPassed('Casual-format 32-player tournament E2E');
});

test('Casual 1v1 room flow with mocked battle + payout; 2v2 remains unsupported', async () => {
  const report = new StageReport();
  const economics = new MockEconomics({ devFaucet: true });
  const battles = createFakeBattleEngine('instant-player1-win');
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    battleEngine: battles.engine,
    countdownMs: 0,
  });

  const room = await openFullCasualRoom(casual, 'demo-player-1', 'demo-player-2', 100_000);
  report.check('casual/open-full', 'Casual room reaches full', room.status === 'full', 'full', room.status);
  bothConfirmCasual(casual, room.id);
  const drafting = casual.getRoom(room.id);
  report.check(
    'casual/ready',
    'Both players confirmed selections',
    drafting.status === 'ready' || drafting.status === 'drafting' || drafting.status === 'full',
    'ready|drafting|full',
    drafting.status,
  );

  await casual.startBattle(room.id, 'demo-player-1');
  for (let i = 0; i < 50 && casual.getRoom(room.id).status !== 'completed'; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const completed = casual.getRoom(room.id);
  report.check('casual/complete', 'Casual battle completes via fake engine', completed.status === 'completed', 'completed', completed.status);
  report.check(
    'casual/winner',
    'Creator (player1) wins under fake engine policy',
    completed.winnerId === 'demo-player-1',
    'demo-player-1',
    completed.winnerId,
  );
  report.check(
    'casual/payout',
    'Casual payout is mocked and non-zero',
    Boolean(completed.payout?.mocked && completed.payout.amount > 0),
    true,
    completed.payout,
  );
  const preview = economics.previewCasual(100_000);
  report.check(
    'casual/payout-amount',
    'Winner receives pot minus protocol fee',
    completed.payout?.amount === preview.winnerPayout,
    preview.winnerPayout,
    completed.payout?.amount,
  );

  {
    const badCasual = new CasualRoomService({
      economics: new MockEconomics({ devFaucet: true }),
      allowDemoAuth: true,
      countdownMs: 0,
      battleEngine: {
        async createBattle() {
          return {
            id: 'bad-session',
            async start() {},
            getResult: () => undefined,
            getState: () => ({ id: 'bad-session', lifecycle: 'awaiting-choice' }),
            getView: () => ({ sides: [] }),
            subscribe(listener: (terminal: BattleTerminal) => void) {
              listener({ type: 'failed', failure: { code: 'simulator-error', message: 'nope' } });
              listener({
                type: 'completed',
                result: {
                  status: 'win',
                  winner: 'demo-player-1',
                  score: [1, 0],
                  turns: 1,
                },
              });
              return () => undefined;
            },
            subscribeEvents() {
              return () => undefined;
            },
          };
        },
      } as unknown as BattleEngine,
    });
    const badRoom = await openFullCasualRoom(badCasual);
    bothConfirmCasual(badCasual, badRoom.id);
    const after = await badCasual.startBattle(badRoom.id, 'demo-player-1');
    report.check(
      'casual/failed-terminal',
      'Mismatched/failed terminal does not settle while session is not ended',
      after.status === 'battling',
      'battling',
      after.status,
    );
  }

  {
    const twoVTwo = new CasualRoomService({ economics: new MockEconomics(), allowDemoAuth: true });
    const created = await twoVTwo.createRoom({
      creatorId: 'demo-player-1',
      roomType: 'open',
      battleSize: '2v2',
      collateral: 10_000,
    });
    await twoVTwo.acceptRoom(created.id, 'demo-player-2');
    twoVTwo.setReady(created.id, 'demo-player-1', true);
    twoVTwo.setReady(created.id, 'demo-player-2', true);
    await assert.rejects(
      () => twoVTwo.startBattle(created.id, 'demo-player-1'),
      /2v2 battles are not supported/,
    );
    report.skip(
      'casual/2v2',
      '2v2 Casual exists in UI/config but start is intentionally unsupported (verified rejection).',
    );
  }

  report.info(
    'ui-wiring',
    'Known visual-only / incomplete UI paths: bracket preview (buildMockTournament), NEXT/LATER schedule cards, Casual 2v2 Coming soon. Chain tournament registration is database-only; payment is a separate fixed-fee flow.',
  );
  report.assertAllPassed('Casual 1v1 E2E + unsupported 2v2');
});

test('ApiServer settlement triggers once for a completed cup (mocked battles, demo auth)', async () => {
  const report = new StageReport();
  const economics = new MockEconomics({ devFaucet: true });
  const store = new InMemoryEconomicsStore(economics);
  new SettlementProbe().wrap(store);
  const battles = createFakeBattleEngine('instant-player1-win');
  const repository = new InMemoryAsyncTournamentRepository(undefined, {
    reserve: (holdKey, playerId, amount) => store.reserve(holdKey, playerId, amount),
    release: holdKey => store.release(holdKey),
  });
  const tournaments = new TournamentService({
    battleEngine: battles.engine,
    repository,
  });

  const server = new ApiServer({
    allowDemoAuth: true,
    localTestMode: true,
    countdownMs: 0,
    economics: store,
    tournaments,
  });

  const port = await server.listen(0);
  const host = new TestClient(port);
  const guest = new TestClient(port);

  try {
    await Promise.all([host.open(), guest.open()]);
    host.send({ type: 'identify', playerId: 'demo-player-1' });
    guest.send({ type: 'identify', playerId: 'demo-player-2' });
    await Promise.all([
      host.waitFor(message => message.type === 'ready'),
      guest.waitFor(message => message.type === 'ready'),
    ]);

    host.send({ type: 'tournament.create', title: 'API Settlement Cup', maxPlayers: 4, entryFee: ENTRY_FEE });
    const created = await host.waitFor<any>(message => message.type === 'tournament.created');
    const tournamentId = created.tournament.id as string;
    report.pass('api/create', `Created tournament ${tournamentId}`);

    host.send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_ONE });
    guest.send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_TWO });
    await Promise.all([
      host.waitFor(message => message.type === 'tournament.state' && message.tournament.players?.length >= 1),
      guest.waitFor(message => message.type === 'tournament.state' && message.tournament.players?.length >= 2),
    ]);
    report.pass('api/join', 'Both demo players joined without wallets/SOL');

    host.send({ type: 'tournament.start', tournamentId });
    const started = await host.waitFor<any>(message => (
      message.type === 'tournament.state'
      && (message.tournament.status === 'in-progress' || message.tournament.status === 'completed')
    ), 10_000);
    report.check(
      'api/start',
      'Tournament started via API (may already be completed under instant battles)',
      started.tournament.status === 'in-progress' || started.tournament.status === 'completed',
      'in-progress|completed',
      started.tournament.status,
    );

    const result = started.type === 'tournament.result'
      ? started
      : await host.waitFor<any>(message => message.type === 'tournament.result', 15_000);
    report.check(
      'api/result',
      'tournament.result emitted with payout',
      result.tournament.status === 'completed' && Boolean(result.payout),
      'completed+payout',
      `${result.tournament.status}/${result.payout?.amount}`,
    );
    report.check(
      'api/payout-recipient',
      'Payout recipient is the final winner',
      result.payout.winnerId === result.tournament.winner,
      result.tournament.winner,
      result.payout.winnerId,
    );

    const settlementKey = `tournament:${tournamentId}`;
    const first = await store.getSettlement(settlementKey);
    report.check('api/settlement-stored', 'Settlement persisted under tournament key', Boolean(first), true, Boolean(first));

    const live = await server.tournaments.getTournament(tournamentId as any);
    const registered = live.players.filter(player => player.status === 'registered');
    const beforeBalance = economics.getBalance(live.winner!);
    const second = await store.completeTournamentWin({
      winnerId: live.winner!,
      entryFee: live.entryFee,
      playerCount: registered.length,
      settlementKey,
      holdKeys: registered.map(player => `tournament:${tournamentId}:${player.id}`),
    });
    report.check(
      'api/payout-once',
      'Second completeTournamentWin does not double-pay',
      second.amount === first!.amount && economics.getBalance(live.winner!) === beforeBalance,
      { amount: first!.amount, balance: beforeBalance },
      { amount: second.amount, balance: economics.getBalance(live.winner!) },
    );
  } finally {
    await Promise.all([host.close(), guest.close()]);
    await server.close();
  }

  report.info(
    'ui-wiring',
    'Chain-backed tournament.join is intentionally database-only. The web UI starts the separate fixed-fee payment intent after the 32-player field fills.',
  );
  report.assertAllPassed('ApiServer tournament settlement E2E');
});

test('Harness cleanup/reset: independent runs do not share state', async () => {
  const report = new StageReport();
  const first = createTournamentHarness();
  const second = createTournamentHarness();
  const players = makeSyntheticPlayers(4);

  const a = await first.tournaments.createTournament({
    title: 'Cleanup A',
    format: 'gen9ou',
    maxPlayers: 4,
    hostId: players[0].id,
    entryFee: 0,
  });
  await first.tournaments.openRegistration(a.id);
  await registerField(first.tournaments, a.id, players, first.economics);

  const listedSecond = await second.tournaments.listTournaments();
  report.check(
    'cleanup/isolation',
    'Fresh harness has no tournaments from prior run',
    listedSecond.length === 0,
    0,
    listedSecond.length,
  );
  report.check(
    'cleanup/economics-isolation',
    'Fresh economics has no holds from prior run',
    !second.economics.hasHold(`tournament:${a.id}:${players[0].id}`),
    false,
    second.economics.hasHold(`tournament:${a.id}:${players[0].id}`),
  );
  first.reset();
  second.reset();
  report.assertAllPassed('Harness cleanup/reset');
});

class TestClient {
  readonly socket: WebSocket;
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
  }> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const waiter = this.waiters.find(item => item.predicate(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify({
      requestId: randomUUID(),
      ...(message as object),
    }));
  }

  async waitFor<T = any>(
    predicate: (message: any) => boolean,
    timeoutMs = 5_000,
  ): Promise<T> {
    const existing = this.messages.find(predicate);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return existing as T;
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiter = this.waiters.find(item => item.resolve === resolve);
        if (waiter) this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('Timed out waiting for WebSocket message.'));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: message => {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
  }

  close(): Promise<void> {
    this.socket.terminate();
    (this.socket as WebSocket & { _socket?: { destroy: () => void } })._socket?.destroy();
    return Promise.resolve();
  }
}

export function createSolanaKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublic = Buffer.from(spki.subarray(spki.length - 32));
  return { address: encodeBase58(rawPublic), privateKey };
}

export function signAuthMessage(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  message: string,
): string {
  return encodeBase58(sign(null, Buffer.from(message, 'utf8'), privateKey as any));
}
