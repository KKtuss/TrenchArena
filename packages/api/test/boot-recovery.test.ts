import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import {
  InMemoryTournamentStore,
  previewTournament,
  recoverDurableState,
  RecoveryFailedError,
  type DurableTournament,
  type DurableTournamentMatch,
} from '@pokearena/db';
import { TournamentService } from '@pokearena/tournament';

import { InMemoryEconomicsStore } from '../src/memory-economics-store';
import { MockEconomics } from '../src/mock-economics';
import { PostgresTournamentRepository } from '../src/postgres-tournament-repository';
import { ApiServer } from '../src/server';

const silent = (): void => undefined;
const FEE = 50_000;

function wallet(): string {
  return `player-${randomUUID().replaceAll('-', '')}aaaaaaaa`;
}

function baseTournament(overrides: Partial<DurableTournament> = {}): DurableTournament {
  const now = Date.now();
  return {
    id: randomUUID(),
    title: 'Recovery Cup',
    format: 'gen9ou',
    maxPlayers: 4,
    bracketSeed: 'default',
    matchTimeoutMs: 300_000,
    status: 'registration',
    hostId: wallet(),
    entryFee: FEE,
    players: [],
    matchIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function fund(economics: InMemoryEconomicsStore, playerId: string, amount = 1_000_000): Promise<void> {
  await economics.ensureWallet(playerId);
  await economics.credit(playerId, amount);
}

async function registerPaid(
  store: InMemoryTournamentStore,
  economics: InMemoryEconomicsStore,
  tournamentId: string,
  playerId: string,
  index: number,
  entryFee = FEE,
): Promise<void> {
  await fund(economics, playerId);
  await store.registerPlayer({
    tournamentId,
    playerId,
    displayName: `P${index}`,
    team: `team-${index}`,
  });
  if (entryFee > 0) {
    await economics.reserve(`tournament:${tournamentId}:${playerId}`, playerId, entryFee);
  }
}

async function completeUnsettled(
  store: InMemoryTournamentStore,
  tournamentId: string,
  winnerId: string,
): Promise<void> {
  const tournament = await store.getTournament(tournamentId);
  assert.ok(tournament);
  await store.saveTournament({
    ...tournament,
    status: 'completed',
    winner: winnerId,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function snapshot(economics: InMemoryEconomicsStore, playerIds: string[], holdKeys: string[], settlementKey: string) {
  const balances: Record<string, number> = {};
  for (const playerId of playerIds) balances[playerId] = await economics.getBalance(playerId);
  const holds: Record<string, string> = {};
  for (const holdKey of holdKeys) {
    const hold = await economics.getHold(holdKey);
    holds[holdKey] = hold?.status ?? 'missing';
  }
  const settlement = await economics.getSettlement(settlementKey);
  return {
    balances,
    holds,
    settlement: settlement
      ? { winnerId: settlement.winnerId, amount: settlement.amount, reason: settlement.reason }
      : undefined,
  };
}

test('in-memory recovery settles a completed tournament exactly once', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const hostId = wallet();
  const players = [wallet(), wallet(), wallet(), wallet()];
  await fund(economics, hostId);
  const tournament = baseTournament({ hostId });
  await store.saveTournament(tournament);
  for (const [index, playerId] of players.entries()) {
    await registerPaid(store, economics, tournament.id, playerId, index);
  }
  await completeUnsettled(store, tournament.id, players[0]!);

  const holdKeys = players.map(playerId => `tournament:${tournament.id}:${playerId}`);
  const prize = previewTournament(FEE, 4).prizePool;
  const beforeWinner = await economics.getBalance(players[0]!);
  const report = await recoverDurableState({ economics, tournaments: store, logger: silent });
  assert.equal((await economics.getSettlement(`tournament:${tournament.id}`))?.winnerId, players[0]);
  assert.equal(await economics.getBalance(players[0]!), beforeWinner + prize);
  for (const holdKey of holdKeys) {
    assert.equal((await economics.getHold(holdKey))?.status, 'consumed');
  }

  const afterFirst = await snapshot(economics, players, holdKeys, `tournament:${tournament.id}`);
  await recoverDurableState({ economics, tournaments: store, logger: silent });
  assert.deepEqual(
    await snapshot(economics, players, holdKeys, `tournament:${tournament.id}`),
    afterFirst,
  );
  assert.ok(report.settledTournamentIds.includes(tournament.id));
});

test('in-memory recovery does not pay an already settled or cancelled tournament', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const hostId = wallet();
  const settledPlayers = [wallet(), wallet(), wallet(), wallet()];
  const cancelledPlayers = [wallet(), wallet(), wallet(), wallet()];
  await fund(economics, hostId);

  const settled = baseTournament({ hostId, title: 'Settled' });
  await store.saveTournament(settled);
  for (const [index, playerId] of settledPlayers.entries()) {
    await registerPaid(store, economics, settled.id, playerId, index);
  }
  await completeUnsettled(store, settled.id, settledPlayers[0]!);
  await economics.completeTournamentWin({
    winnerId: settledPlayers[0]!,
    entryFee: FEE,
    playerCount: 4,
    settlementKey: `tournament:${settled.id}`,
    holdKeys: settledPlayers.map(playerId => `tournament:${settled.id}:${playerId}`),
  });
  const afterPay = await economics.getBalance(settledPlayers[0]!);

  const cancelled = baseTournament({ hostId, title: 'Cancelled' });
  await store.saveTournament(cancelled);
  for (const [index, playerId] of cancelledPlayers.entries()) {
    await registerPaid(store, economics, cancelled.id, playerId, index);
  }
  const loaded = await store.getTournament(cancelled.id);
  assert.ok(loaded);
  await store.saveTournament({ ...loaded, status: 'cancelled', updatedAt: Date.now() });
  const cancelledWinnerBalance = await economics.getBalance(cancelledPlayers[0]!);

  await recoverDurableState({ economics, tournaments: store, logger: silent });
  assert.equal(await economics.getBalance(settledPlayers[0]!), afterPay);
  assert.equal(await economics.getSettlement(`tournament:${cancelled.id}`), undefined);
  assert.equal(await economics.getBalance(cancelledPlayers[0]!), cancelledWinnerBalance);
  for (const playerId of cancelledPlayers) {
    assert.equal((await economics.getHold(`tournament:${cancelled.id}:${playerId}`))?.status, 'reserved');
  }
});

test('in-memory recovery is safe if it crashes after the first settlement', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const hostId = wallet();
  await fund(economics, hostId);
  const firstPlayers = [wallet(), wallet(), wallet(), wallet()];
  const secondPlayers = [wallet(), wallet(), wallet(), wallet()];
  const first = baseTournament({ hostId, title: 'First' });
  const second = baseTournament({ hostId, title: 'Second' });
  await store.saveTournament(first);
  await store.saveTournament(second);
  for (const [index, playerId] of firstPlayers.entries()) {
    await registerPaid(store, economics, first.id, playerId, index);
  }
  for (const [index, playerId] of secondPlayers.entries()) {
    await registerPaid(store, economics, second.id, playerId, index);
  }
  await completeUnsettled(store, first.id, firstPlayers[0]!);
  await completeUnsettled(store, second.id, secondPlayers[0]!);

  let settled = 0;
  await assert.rejects(
    () => recoverDurableState({
      economics,
      tournaments: store,
      logger: silent,
      afterSettleTournament: () => {
        settled += 1;
        if (settled === 1) throw new Error('injected crash');
      },
    }),
    RecoveryFailedError,
  );
  const firstPaid = Boolean(await economics.getSettlement(`tournament:${first.id}`));
  const secondPaid = Boolean(await economics.getSettlement(`tournament:${second.id}`));
  assert.equal(firstPaid !== secondPaid, true);
  const firstWinnerBefore = await economics.getBalance(firstPlayers[0]!);
  const secondWinnerBefore = await economics.getBalance(secondPlayers[0]!);
  await recoverDurableState({ economics, tournaments: store, logger: silent });
  assert.ok(await economics.getSettlement(`tournament:${first.id}`));
  assert.ok(await economics.getSettlement(`tournament:${second.id}`));
  const prize = previewTournament(FEE, 4).prizePool;
  if (firstPaid) {
    assert.equal(await economics.getBalance(firstPlayers[0]!), firstWinnerBefore);
    assert.equal(await economics.getBalance(secondPlayers[0]!), secondWinnerBefore + prize);
  } else {
    assert.equal(await economics.getBalance(secondPlayers[0]!), secondWinnerBefore);
    assert.equal(await economics.getBalance(firstPlayers[0]!), firstWinnerBefore + prize);
  }
});

test('in-memory recovery keeps live reserved holds and terminal holds terminal', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const hostId = wallet();
  await fund(economics, hostId);
  const openPlayers = [wallet(), wallet()];
  const open = baseTournament({ hostId, title: 'Open' });
  await store.saveTournament(open);
  for (const [index, playerId] of openPlayers.entries()) {
    await registerPaid(store, economics, open.id, playerId, index);
  }

  const readyPlayers = [wallet(), wallet(), wallet(), wallet()];
  const ready = baseTournament({ hostId, title: 'Ready' });
  await store.saveTournament(ready);
  for (const [index, playerId] of readyPlayers.entries()) {
    await registerPaid(store, economics, ready.id, playerId, index);
  }
  const readyRow = await store.getTournament(ready.id);
  assert.ok(readyRow);
  await store.saveTournament({ ...readyRow, status: 'ready', updatedAt: Date.now() });

  const livePlayers = [wallet(), wallet(), wallet(), wallet()];
  const live = baseTournament({ hostId, title: 'Live' });
  await store.saveTournament(live);
  for (const [index, playerId] of livePlayers.entries()) {
    await registerPaid(store, economics, live.id, playerId, index);
  }
  const liveRow = await store.getTournament(live.id);
  assert.ok(liveRow);
  await store.saveTournament({ ...liveRow, status: 'in-progress', startedAt: Date.now(), updatedAt: Date.now() });

  await recoverDurableState({ economics, tournaments: store, logger: silent });
  for (const playerId of [...openPlayers, ...readyPlayers, ...livePlayers]) {
    const tournamentId = openPlayers.includes(playerId)
      ? open.id
      : readyPlayers.includes(playerId) ? ready.id : live.id;
    assert.equal((await economics.getHold(`tournament:${tournamentId}:${playerId}`))?.status, 'reserved');
  }
});

test('in-memory recovery interrupts live matches without inventing a winner', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const hostId = wallet();
  const players = [wallet(), wallet(), wallet(), wallet()];
  await fund(economics, hostId);
  const tournament = baseTournament({ hostId });
  await store.saveTournament(tournament);
  for (const [index, playerId] of players.entries()) {
    await registerPaid(store, economics, tournament.id, playerId, index);
  }
  const inProgress = await store.getTournament(tournament.id);
  assert.ok(inProgress);
  await store.saveTournament({
    ...inProgress,
    status: 'in-progress',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
  const now = Date.now();
  const created: DurableTournamentMatch = {
    id: randomUUID(),
    tournamentId: tournament.id,
    round: 1,
    bracketPosition: 0,
    player1: players[0],
    player2: players[1],
    status: 'battle-created',
    battleInstanceId: 'gone-created',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  const active: DurableTournamentMatch = {
    id: randomUUID(),
    tournamentId: tournament.id,
    round: 1,
    bracketPosition: 1,
    player1: players[2],
    player2: players[3],
    status: 'active',
    battleInstanceId: 'gone-active',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  const tied: DurableTournamentMatch = {
    id: randomUUID(),
    tournamentId: tournament.id,
    round: 2,
    bracketPosition: 0,
    status: 'tied',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
  const terminal: DurableTournamentMatch = {
    id: randomUUID(),
    tournamentId: tournament.id,
    round: 2,
    bracketPosition: 1,
    player1: players[0],
    player2: players[1],
    status: 'completed',
    winner: players[0],
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
  await store.saveMatch(created);
  await store.saveMatch(active);
  await store.saveMatch(tied);
  await store.saveMatch(terminal);

  const report = await recoverDurableState({ economics, tournaments: store, logger: silent });
  const createdAfter = await store.getMatch(created.id);
  const activeAfter = await store.getMatch(active.id);
  const tiedAfter = await store.getMatch(tied.id);
  const terminalAfter = await store.getMatch(terminal.id);
  assert.equal(createdAfter?.status, 'interrupted');
  assert.equal(createdAfter?.winner, undefined);
  assert.equal(createdAfter?.battleInstanceId, undefined);
  assert.equal(activeAfter?.status, 'interrupted');
  assert.equal(activeAfter?.winner, undefined);
  assert.equal(tiedAfter?.status, 'tied');
  assert.equal(tiedAfter?.winner, undefined);
  assert.equal(terminalAfter?.status, 'completed');
  assert.equal(terminalAfter?.winner, players[0]);
  assert.equal(report.interruptedMatchIds.includes(created.id), true);
  assert.equal(report.interruptedMatchIds.includes(active.id), true);

  const resumed = await store.beginMatchStart(created.id);
  assert.equal(resumed.status, 'battle-created');
  assert.equal(resumed.winner, undefined);
});

test('in-memory recovery reconstructs tournament state and preserves withdrawal', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const hostId = wallet();
  const players = [wallet(), wallet(), wallet(), wallet()];
  await fund(economics, hostId);
  const tournament = baseTournament({ hostId, title: 'State Cup' });
  await store.saveTournament(tournament);
  for (const [index, playerId] of players.entries()) {
    await registerPaid(store, economics, tournament.id, playerId, index);
  }
  const loaded = await store.getTournament(tournament.id);
  assert.ok(loaded);
  loaded.players[1]!.status = 'withdrawn';
  await store.saveTournament(loaded);
  const match: DurableTournamentMatch = {
    id: randomUUID(),
    tournamentId: tournament.id,
    round: 1,
    bracketPosition: 0,
    player1: players[0],
    player2: players[2],
    status: 'ready',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const ready = await store.getTournament(tournament.id);
  assert.ok(ready);
  await store.saveTournament({ ...ready, status: 'ready', matchIds: [match.id], updatedAt: Date.now() });
  await store.saveMatch(match);

  await recoverDurableState({ economics, tournaments: store, logger: silent });
  const reconstructed = new TournamentService({
    repository: new PostgresTournamentRepository(store),
  });
  const after = await reconstructed.getTournament(tournament.id as never);
  assert.equal(after.hostId, hostId);
  assert.equal(after.entryFee, FEE);
  assert.equal(after.title, 'State Cup');
  assert.equal(after.players.length, 4);
  assert.equal(after.players.find(player => player.id === players[1])?.status, 'withdrawn');
  assert.equal((await economics.getHold(`tournament:${tournament.id}:${players[1]}`))?.status, 'reserved');
  const bracket = await reconstructed.getBracket(tournament.id as never);
  assert.equal(bracket[0]?.status, 'ready');
});

test('in-memory recovery releases orphan reserved holds and fails closed on missing registered holds', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const hostId = wallet();
  const players = [wallet(), wallet()];
  const orphan = wallet();
  await fund(economics, hostId);
  await fund(economics, orphan);
  const tournament = baseTournament({ hostId });
  await store.saveTournament(tournament);
  for (const [index, playerId] of players.entries()) {
    await registerPaid(store, economics, tournament.id, playerId, index);
  }
  const orphanKey = `tournament:${tournament.id}:${orphan}`;
  await economics.reserve(orphanKey, orphan, FEE);
  const orphanBalance = await economics.getBalance(orphan);
  await recoverDurableState({ economics, tournaments: store, logger: silent });
  assert.equal((await economics.getHold(orphanKey))?.status, 'released');
  assert.equal(await economics.getBalance(orphan), orphanBalance + FEE);

  const broken = baseTournament({ hostId, title: 'Broken' });
  await store.saveTournament(broken);
  const missing = wallet();
  await fund(economics, missing);
  await store.registerPlayer({
    tournamentId: broken.id,
    playerId: missing,
    displayName: 'Missing',
    team: 'team-x',
  });
  await assert.rejects(
    () => recoverDurableState({ economics, tournaments: store, logger: silent }),
    RecoveryFailedError,
  );
});

test('two in-memory recovery attempts cannot double-settle', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const hostId = wallet();
  const players = [wallet(), wallet(), wallet(), wallet()];
  await fund(economics, hostId);
  const tournament = baseTournament({ hostId });
  await store.saveTournament(tournament);
  for (const [index, playerId] of players.entries()) {
    await registerPaid(store, economics, tournament.id, playerId, index);
  }
  await completeUnsettled(store, tournament.id, players[0]!);
  const before = await economics.getBalance(players[0]!);
  await Promise.all([
    recoverDurableState({ economics, tournaments: store, logger: silent }),
    recoverDurableState({ economics, tournaments: store, logger: silent }),
  ]);
  const prize = previewTournament(FEE, 4).prizePool;
  assert.equal(await economics.getBalance(players[0]!), before + prize);
  const again = await economics.completeTournamentWin({
    winnerId: players[0]!,
    entryFee: FEE,
    playerCount: 4,
    settlementKey: `tournament:${tournament.id}`,
    holdKeys: players.map(playerId => `tournament:${tournament.id}:${playerId}`),
  });
  assert.equal(again.amount, prize);
  assert.equal(await economics.getBalance(players[0]!), before + prize);
});

test('in-memory recovery cancels persisted casual lobbies through EconomicsStore', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics());
  const store = new InMemoryTournamentStore();
  const roomId = randomUUID();
  await economics.createCasualRoomWithHold({
    id: roomId,
    matchId: `casual-${roomId}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId: 'demo-player-1',
    collateral: 100_000,
  });
  const before = await economics.getBalance('demo-player-1');
  await recoverDurableState({ economics, tournaments: store, logger: silent });
  assert.equal((await economics.getCasualRoom(roomId))?.status, 'cancelled');
  assert.equal((await economics.getHold(`casual:${roomId}:creator`))?.status, 'released');
  assert.equal(await economics.getBalance('demo-player-1'), before + 100_000);
});

test('host authorization after restart uses persisted hostId', async () => {
  const economics = new InMemoryEconomicsStore(new MockEconomics({ devFaucet: true }));
  const store = new InMemoryTournamentStore();
  const repository = new PostgresTournamentRepository(store);
  const first = new ApiServer({
    economics,
    tournamentRepository: repository,
    allowDemoAuth: true,
    originMode: 'development',
  });
  const port = await first.listen(0);
  const host = new TestClient(port);
  await host.open();
  host.send({ type: 'identify', playerId: 'demo-player-1' });
  await host.waitFor(message => message.type === 'ready');
  host.send({ type: 'tournament.create', title: 'Host Cup', maxPlayers: 4, entryFee: 0 });
  const created = await host.waitFor<any>(message => message.type === 'tournament.created');
  const tournamentId = created.tournament.id;
  await host.close();
  await first.close();

  await recoverDurableState({ economics, tournaments: store, logger: silent });
  const loaded = await store.getTournament(tournamentId);
  assert.equal(loaded?.hostId, 'demo-player-1');

  const second = new ApiServer({
    economics,
    tournamentRepository: repository,
    allowDemoAuth: true,
    originMode: 'development',
  });
  const nextPort = await second.listen(0);
  const hostAgain = new TestClient(nextPort);
  const other = new TestClient(nextPort);
  await hostAgain.open();
  await other.open();
  hostAgain.send({ type: 'identify', playerId: 'demo-player-1' });
  other.send({ type: 'identify', playerId: 'demo-player-2' });
  await hostAgain.waitFor(message => message.type === 'ready');
  await other.waitFor(message => message.type === 'ready');
  other.send({ type: 'tournament.start', tournamentId });
  const rejected = await other.waitFor<any>(message => message.type === 'error');
  assert.equal(rejected.code, 'TournamentHostRequiredError');
  hostAgain.send({ type: 'tournament.start', tournamentId });
  const hostResult = await hostAgain.waitFor<any>(
    message => message.type === 'error' || message.type === 'tournament.state',
  );
  assert.notEqual(hostResult.code, 'TournamentHostRequiredError');
  await hostAgain.close();
  await other.close();
  await second.close();
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

  async waitFor<T = any>(predicate: (message: any) => boolean, timeoutMs = 5_000): Promise<T> {
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
