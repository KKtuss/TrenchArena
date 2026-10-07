/**
 * Fight history is a read of completed rooms and tournament matches.
 * It does not settle, and it does not accept a caller-supplied player id.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { previewCasual } from '@pokearena/db';
import type { TournamentId } from '@pokearena/tournament';
import { WebSocket } from 'ws';

import { CasualRoomService, type CasualFightRecord } from '../src/casual-service';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import {
  casualFightEntry,
  pageFightHistory,
  tournamentFightEntry,
  type FightHistoryEntry,
} from '../src/fight-history';
import { ApiServer } from '../src/server';

const COLLATERAL = 100_000;
const PLAYERS = ['demo-player-1', 'demo-player-2'] as const;

test('win, loss, forfeit, and tie nets follow the settlement', () => {
  const preview = previewCasual(COLLATERAL);
  const completedAt = 1_700_000_000_000;
  const win = casualFightEntry(record({
    winnerId: PLAYERS[0],
    resultStatus: 'win',
    payoutAmount: preview.winnerPayout,
    payoutReason: 'casual-win',
    protocolFee: preview.protocolFee,
    completedAt,
  }), PLAYERS[0]);
  const loss = casualFightEntry(record({
    winnerId: PLAYERS[0],
    resultStatus: 'win',
    payoutAmount: preview.winnerPayout,
    payoutReason: 'casual-win',
    protocolFee: preview.protocolFee,
    completedAt,
  }), PLAYERS[1]);
  const forfeit = casualFightEntry(record({
    winnerId: PLAYERS[0],
    resultStatus: 'win',
    payoutAmount: preview.winnerPayout,
    payoutReason: 'casual-forfeit',
    protocolFee: preview.protocolFee,
    completedAt,
  }), PLAYERS[1]);
  const tie = casualFightEntry(record({
    resultStatus: 'tie',
    payoutAmount: COLLATERAL,
    payoutReason: 'casual-tie',
    protocolFee: 0,
    completedAt,
  }), PLAYERS[0]);

  assert.equal(win.result, 'win');
  assert.equal(win.mode, 'casual');
  assert.equal(win.payout, preview.winnerPayout);
  assert.equal(win.net, preview.winnerPayout - COLLATERAL);
  assert.equal(win.fee, preview.protocolFee);
  assert.equal(loss.result, 'loss');
  assert.equal(loss.net, -COLLATERAL);
  assert.equal(loss.payout, 0);
  assert.equal(forfeit.result, 'forfeit');
  assert.equal(forfeit.net, -COLLATERAL);
  assert.equal(tie.result, 'tie');
  assert.equal(tie.net, 0);
  assert.equal(tie.paid, true);
});

test('mock rooms stay on POKE and a SOL room shares one lamport stake', async () => {
  const casual = new CasualRoomService({ countdownMs: 0 });
  const mock = await casual.createRoom({
    creatorId: PLAYERS[0],
    roomType: 'open',
    battleSize: '1v1',
    collateral: COLLATERAL,
  });
  assert.notEqual(mock.rail, 'sol_chain');
  assert.equal(mock.collateral, COLLATERAL);
  assert.equal(mock.economics.winnerPayout, previewCasual(COLLATERAL).winnerPayout);

  const lamports = 50_000_000;
  const sol = await casual.createRoom({
    creatorId: 'sol-history-player-1',
    roomType: 'private',
    battleSize: '1v1',
    collateral: lamports,
    invitedPlayerId: 'sol-history-player-2',
    rail: 'sol_chain',
  });
  assert.equal(sol.rail, 'sol_chain');
  assert.equal(sol.status, 'pending_deposit');
  casual.markSolDeposit(sol.id, 'creator');
  await casual.acceptRoom(sol.id, 'sol-history-player-2');
  const joined = casual.getRoom(sol.id);
  assert.equal(joined.opponentId, 'sol-history-player-2');
  assert.equal(joined.collateral, lamports);
  const fee = Math.floor((lamports * 2 * 200) / 10_000);
  assert.equal(joined.economics.protocolFee, fee);
  assert.equal(joined.economics.winnerPayout, lamports * 2 - fee);
});

test('SOL history uses the settlement currency and the escrow credit', () => {
  const stake = 100_000_000;
  const fee = Math.floor((stake * 2 * 200) / 10_000);
  const winnerCredit = stake * 2 - fee;
  const win = casualFightEntry(record({
    collateral: stake,
    rail: 'sol_chain',
    winnerId: PLAYERS[0],
    resultStatus: 'win',
    payoutAmount: winnerCredit,
    payoutSymbol: 'SOL',
    payoutReason: 'casual-win',
    protocolFee: fee,
  }), PLAYERS[0]);
  const loss = casualFightEntry(record({
    collateral: stake,
    rail: 'sol_chain',
    winnerId: PLAYERS[0],
    resultStatus: 'win',
    payoutAmount: winnerCredit,
    payoutSymbol: 'SOL',
    payoutReason: 'casual-win',
    protocolFee: fee,
  }), PLAYERS[1]);
  const tieCredit = Math.floor((stake * 2 - fee) / 2);
  const tie = casualFightEntry(record({
    collateral: stake,
    rail: 'sol_chain',
    resultStatus: 'tie',
    payoutAmount: tieCredit,
    payoutSymbol: 'SOL',
    payoutReason: 'casual-tie',
    protocolFee: fee,
  }), PLAYERS[0]);

  assert.equal(win.symbol, 'SOL');
  assert.equal(win.stake, stake);
  assert.equal(win.payout, winnerCredit);
  assert.equal(win.net, winnerCredit - stake);
  assert.equal(win.fee, fee);
  assert.equal(loss.symbol, 'SOL');
  assert.equal(loss.net, -stake);
  assert.equal(loss.payout, 0);
  assert.equal(tie.symbol, 'SOL');
  assert.equal(tie.net, tieCredit - stake);
  assert.equal(tie.net, -Math.floor(fee / 2));
});

test('an unsettled record is not presented as a paid result', () => {
  const entry = casualFightEntry(record({
    settled: false,
    winnerId: PLAYERS[0],
    resultStatus: 'win',
    payoutAmount: previewCasual(COLLATERAL).winnerPayout,
    payoutReason: 'casual-win',
  }), PLAYERS[0]);
  assert.equal(entry.paid, false);
  assert.equal(entry.net, 0);
  assert.equal(entry.payout, 0);
  assert.equal(entry.stake, 0);
});

test('competitive rooms keep their mode and tournament cup money is counted once', () => {
  const competitive = casualFightEntry(record({
    ruleset: 'competitive',
    winnerId: PLAYERS[1],
    resultStatus: 'win',
    payoutAmount: previewCasual(COLLATERAL).winnerPayout,
    payoutReason: 'casual-win',
  }), PLAYERS[1]);
  assert.equal(competitive.mode, 'competitive');
  assert.equal(competitive.result, 'win');

  const champion = tournamentFightEntry({
    playerId: PLAYERS[0],
    matchId: 'final',
    tournamentId: 'cup',
    opponentId: PLAYERS[1],
    status: 'completed',
    winnerId: PLAYERS[0],
    completedAt: 30,
    entryFee: 50_000,
    prize: 180_000,
    symbol: 'POKE',
    carriesCupBalance: true,
    playerWonCup: true,
  });
  const runnerUp = tournamentFightEntry({
    playerId: PLAYERS[1],
    matchId: 'final',
    tournamentId: 'cup',
    opponentId: PLAYERS[0],
    status: 'forfeited',
    winnerId: PLAYERS[0],
    completedAt: 30,
    entryFee: 50_000,
    prize: 180_000,
    symbol: 'POKE',
    carriesCupBalance: true,
    playerWonCup: false,
  });
  const earlier = tournamentFightEntry({
    playerId: PLAYERS[0],
    matchId: 'semi',
    tournamentId: 'cup',
    opponentId: 'demo-player-3',
    status: 'completed',
    winnerId: PLAYERS[0],
    completedAt: 10,
    entryFee: 50_000,
    prize: 180_000,
    symbol: 'POKE',
    carriesCupBalance: false,
    playerWonCup: true,
  });
  assert.equal(champion.mode, 'tournament');
  assert.equal(champion.result, 'win');
  assert.equal(champion.net, 130_000);
  assert.equal(champion.payout, 180_000);
  assert.equal(runnerUp.result, 'forfeit');
  assert.equal(runnerUp.net, -50_000);
  assert.equal(earlier.net, 0);
  assert.equal(earlier.paid, false);
});

test('newest fights page first', () => {
  const entries = [entry('a', 1), entry('b', 3), entry('c', 2)];
  const first = pageFightHistory(entries, 2);
  assert.deepEqual(first.entries.map(item => item.id), ['b', 'c']);
  assert.deepEqual(first.nextCursor, { completedAt: 2, id: 'c' });
  const second = pageFightHistory(entries, 2, first.nextCursor);
  assert.deepEqual(second.entries.map(item => item.id), ['a']);
  assert.equal(second.nextCursor, undefined);
});

test('completed casual and competitive fights are listed for the signed-in player only', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  try {
    await Promise.all([creator.open(), opponent.open()]);
    await identify(creator, PLAYERS[0]);
    await identify(opponent, PLAYERS[1]);

    const first = await reachBattle(creator, opponent, 'casual');
    opponent.send({ type: 'casual.forfeit', roomId: first.id });
    const settled = await creator.waitFor<any>(message => (
      message.type === 'casual.result' && message.room.id === first.id
    ));
    assert.equal(settled.room.status, 'completed');
    assert.equal(settled.room.winnerId, PLAYERS[0]);

    const preview = previewCasual(COLLATERAL);

    creator.send({ type: 'history.list', playerId: PLAYERS[1] });
    const creatorHistory = await creator.waitFor<any>(message => message.type === 'history.list');
    const creatorRow = creatorHistory.entries.find((item: FightHistoryEntry) => item.id === first.id);
    assert.equal(creatorRow.result, 'win');
    assert.equal(creatorRow.mode, 'casual');
    assert.equal(creatorRow.opponentId, PLAYERS[1]);
    assert.equal(creatorRow.payout, preview.winnerPayout);
    assert.equal(creatorRow.net, preview.winnerPayout - COLLATERAL);
    assert.equal(creatorRow.paid, true);
    assert.equal(JSON.stringify(creatorHistory.entries).includes('teamPreview'), false);
    assert.equal(JSON.stringify(creatorHistory.entries).includes('selectedSlots'), false);

    opponent.send({ type: 'history.list' });
    const opponentHistory = await opponent.waitFor<any>(message => message.type === 'history.list');
    const opponentRow = opponentHistory.entries.find((item: FightHistoryEntry) => item.id === first.id);
    assert.equal(opponentRow.result, 'forfeit');
    assert.equal(opponentRow.net, -COLLATERAL);
    assert.equal(opponentRow.opponentId, PLAYERS[0]);

    const second = await reachBattle(creator, opponent, 'casual');
    creator.send({ type: 'casual.forfeit', roomId: second.id });
    await opponent.waitFor(message => message.type === 'casual.result' && message.room.id === second.id);

    creator.send({ type: 'history.list', limit: 1 });
    const page = await creator.waitFor<any>(message => message.type === 'history.list');
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].id, second.id);
    assert.equal(page.entries[0].result, 'forfeit');
    assert.ok(page.nextCursor);

    creator.send({
      type: 'history.list',
      limit: 1,
      beforeCompletedAt: page.nextCursor.completedAt,
      beforeId: page.nextCursor.id,
    });
    const older = await creator.waitFor<any>(message => message.type === 'history.list');
    assert.equal(older.entries.length, 1);
    assert.equal(older.entries[0].id, first.id);
    assert.equal(older.entries[0].result, 'win');

    const live = await reachBattle(creator, opponent, 'competitive');
    creator.send({ type: 'history.list' });
    const during = await creator.waitFor<any>(message => message.type === 'history.list');
    assert.equal(during.entries.some((item: FightHistoryEntry) => item.id === live.id), false);

    opponent.send({ type: 'casual.forfeit', roomId: live.id });
    await creator.waitFor(message => message.type === 'casual.result' && message.room.id === live.id);
    creator.send({ type: 'history.list', limit: 1 });
    const competitive = await creator.waitFor<any>(message => message.type === 'history.list');
    assert.equal(competitive.entries[0].id, live.id);
    assert.equal(competitive.entries[0].mode, 'competitive');
    assert.equal(competitive.entries[0].result, 'win');

    const beforeBalance = await walletBalance(creator);
    creator.send({ type: 'history.list' });
    await creator.waitFor(message => message.type === 'history.list');
    const afterBalance = await walletBalance(creator);
    assert.equal(afterBalance, beforeBalance);
  } finally {
    await Promise.all([creator.close(), opponent.close()]);
    await server.close();
  }
});

test('a timed-out fight is a tie with no balance change', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0, matchTimeoutMs: 700 });
  const port = await server.listen(0);
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  try {
    await Promise.all([creator.open(), opponent.open()]);
    await identify(creator, PLAYERS[0]);
    await identify(opponent, PLAYERS[1]);
    const room = await reachBattle(creator, opponent, 'casual');
    const settled = await creator.waitFor<any>(message => (
      message.type === 'casual.result' && message.room.id === room.id
    ), 8_000);
    assert.equal(settled.room.result?.status, 'tie');
    creator.send({ type: 'history.list' });
    const history = await creator.waitFor<any>(message => message.type === 'history.list');
    const row = history.entries.find((item: FightHistoryEntry) => item.id === room.id);
    assert.equal(row.result, 'tie');
    assert.equal(row.net, 0);
    assert.equal(row.paid, true);
  } finally {
    await Promise.all([creator.close(), opponent.close()]);
    await server.close();
  }
});

test('a finished tournament match is listed without another player wallet', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const players = [new TestClient(port), new TestClient(port)] as const;
  try {
    await Promise.all(players.map(client => client.open()));
    await identify(players[0], PLAYERS[0]);
    await identify(players[1], PLAYERS[1]);
    players[0].send({ type: 'tournament.create', title: 'History Cup', maxPlayers: 4, entryFee: 0 });
    const created = await players[0].waitFor<any>(message => message.type === 'tournament.created');
    const tournamentId = created.tournament.id as string;
    players[0].send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_ONE });
    players[1].send({ type: 'tournament.join', tournamentId, team: DEMO_TEAM_TWO });
    await Promise.all(players.map(client => client.waitFor(message => message.type === 'tournament.state')));
    players[0].send({ type: 'tournament.start', tournamentId });
    const state = await players[0].waitFor<any>(message => (
      message.type === 'tournament.state' && message.tournament.status === 'in-progress'
    ));
    let match = state.tournament.bracket.find((candidate: { id: string; status?: string; player1?: string; player2?: string }) => (
      candidate.status === 'active' && candidate.player1 && candidate.player2
    ));
    for (let attempt = 0; !match && attempt < 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const bracket = await server.tournaments.getBracket(tournamentId as TournamentId);
      match = bracket.find(candidate => candidate.status === 'active' && candidate.player1 && candidate.player2);
    }
    assert.ok(match);
    await server.tournaments.forfeit(match.id, PLAYERS[1]);
    await players[0].waitFor(message => (
      message.type === 'tournament.state' && message.tournament.status === 'completed'
    ));

    players[1].send({ type: 'history.list', playerId: PLAYERS[0] });
    const history = await players[1].waitFor<any>(message => message.type === 'history.list');
    const row = history.entries.find((item: FightHistoryEntry) => item.id === match.id);
    assert.ok(row);
    assert.equal(row.mode, 'tournament');
    assert.equal(row.result, 'loss');
    assert.equal(row.paid, true);
    assert.equal(row.stake, 0);
    assert.equal(row.payout, 0);
    assert.equal(row.net, 0);
    assert.equal(JSON.stringify(row).includes(DEMO_TEAM_ONE.slice(0, 20)), false);

    players[0].send({ type: 'history.list' });
    const winner = await players[0].waitFor<any>(message => message.type === 'history.list');
    const won = winner.entries.find((item: FightHistoryEntry) => item.id === match.id);
    assert.equal(won.result, 'win');
    assert.equal(won.opponentId, PLAYERS[1]);
  } finally {
    await Promise.all(players.map(client => client.close()));
    await server.close();
  }
});

function record(overrides: Partial<CasualFightRecord> = {}): CasualFightRecord {
  return {
    id: 'room-1',
    matchId: 'casual-room-1',
    ruleset: 'casual',
    creatorId: PLAYERS[0],
    opponentId: PLAYERS[1],
    collateral: COLLATERAL,
    payoutSymbol: 'POKE',
    completedAt: 1,
    settled: true,
    ...overrides,
  };
}

function entry(id: string, completedAt: number): FightHistoryEntry {
  return casualFightEntry(record({ id, completedAt, winnerId: PLAYERS[0], resultStatus: 'win', payoutAmount: 1, payoutReason: 'casual-win' }), PLAYERS[0]);
}

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

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({
      requestId: randomUUID(),
      ...message,
    }));
  }

  async waitFor<T = any>(predicate: (message: any) => boolean, timeoutMs = 20_000): Promise<T> {
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
    return Promise.resolve();
  }
}

async function walletBalance(client: TestClient): Promise<number> {
  const requestId = randomUUID();
  client.socket.send(JSON.stringify({ type: 'arena.snapshot', requestId }));
  const snapshot = await client.waitFor<any>(message => (
    message.type === 'arena.snapshot' && message.requestId === requestId
  ));
  return snapshot.snapshot.wallet.balance as number;
}

function identify(client: TestClient, playerId: string): Promise<unknown> {
  client.send({ type: 'identify', playerId });
  return client.waitFor(message => message.type === 'identified' || message.type === 'arena.snapshot');
}

async function reachBattle(
  creator: TestClient,
  opponent: TestClient,
  ruleset: 'casual' | 'competitive',
): Promise<{ id: string }> {
  creator.send({
    type: 'casual.create',
    roomType: 'open',
    battleSize: '1v1',
    collateral: COLLATERAL,
    ruleset,
  });
  const created = await creator.waitFor<any>(message => message.type === 'casual.created');
  const roomId = created.room.id as string;
  opponent.send({ type: 'casual.accept', roomId });
  await opponent.waitFor(message => (
    message.type === 'casual.state' && message.room.id === roomId && message.room.status === 'full'
  ));
  creator.send({
    type: 'casual.ready',
    roomId,
    ready: true,
    ...(ruleset === 'competitive' ? { team: DEMO_TEAM_ONE } : {}),
  });
  opponent.send({
    type: 'casual.ready',
    roomId,
    ready: true,
    ...(ruleset === 'competitive' ? { team: DEMO_TEAM_TWO } : {}),
  });
  await creator.waitFor(message => (
    message.type === 'casual.state'
    && message.room.id === roomId
    && (message.room.status === 'ready' || message.room.status === 'drafting')
  ));
  creator.send({ type: 'casual.start', roomId });
  if (ruleset === 'casual') {
    await creator.waitFor(message => (
      message.type === 'casual.state' && message.room.id === roomId && message.room.status === 'drafting'
    ));
    creator.send({ type: 'casual.select', roomId, slots: [0, 1, 2], confirm: true });
    opponent.send({ type: 'casual.select', roomId, slots: [3, 4, 5], confirm: true });
  }
  await creator.waitFor(message => (
    message.type === 'casual.state' && message.room.id === roomId && message.room.status === 'battling'
  ));
  return { id: roomId };
}
