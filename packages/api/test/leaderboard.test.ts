import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import {
  applyFightToLeaderboard,
  emptyLeaderboardStats,
  rankLeaderboard,
} from '../src/leaderboard';
import type { FightHistoryEntry } from '../src/fight-history';
import { ApiServer } from '../src/server';

function entry(partial: Partial<FightHistoryEntry> & Pick<FightHistoryEntry, 'result' | 'symbol' | 'net' | 'paid'>): FightHistoryEntry {
  return {
    id: partial.id ?? randomUUID(),
    matchId: partial.matchId ?? randomUUID(),
    mode: partial.mode ?? 'casual',
    opponentId: partial.opponentId ?? 'rival',
    result: partial.result,
    completedAt: partial.completedAt ?? 1,
    symbol: partial.symbol,
    stake: partial.stake ?? 0,
    payout: partial.payout ?? 0,
    fee: partial.fee ?? 0,
    net: partial.net,
    paid: partial.paid,
    detailPath: partial.detailPath ?? '/result/x',
  };
}

test('ranks trainers by SOL PnL, then win rate, then fights', () => {
  const ace = emptyLeaderboardStats('ace', { username: 'Ace', spriteId: 'red-gen1' });
  const bee = emptyLeaderboardStats('bee', { username: 'Bee', spriteId: 'blue-gen3' });
  const cal = emptyLeaderboardStats('cal', { username: 'Cal', spriteId: 'leaf-gen3' });
  applyFightToLeaderboard(ace, entry({ result: 'win', symbol: 'SOL', net: 90_000_000, paid: true }));
  applyFightToLeaderboard(ace, entry({ result: 'loss', symbol: 'SOL', net: -100_000_000, paid: true }));
  applyFightToLeaderboard(bee, entry({ result: 'win', symbol: 'SOL', net: 90_000_000, paid: true }));
  applyFightToLeaderboard(cal, entry({ result: 'win', symbol: 'POKE', net: 50_000, paid: true }));
  applyFightToLeaderboard(cal, entry({ result: 'win', symbol: 'SOL', net: 10_000_000, paid: false }));

  const ranked = rankLeaderboard([ace, bee, cal]);
  assert.equal(ranked[0]?.username, 'Bee');
  assert.equal(ranked[0]?.solPnlLamports, 90_000_000);
  assert.equal(ranked[1]?.username, 'Cal');
  assert.equal(ranked[1]?.solPnlLamports, 0);
  assert.equal(ranked[1]?.winRateBps, 10_000);
  assert.equal(ranked[2]?.username, 'Ace');
  assert.equal(ranked[2]?.solPnlLamports, -10_000_000);
  assert.equal(ranked[0]?.rank, 1);
});

test('forfeits count as losses for win rate and unpaid SOL is ignored', () => {
  const stats = emptyLeaderboardStats('ace', { username: 'Ace', spriteId: 'red-gen1' });
  applyFightToLeaderboard(stats, entry({ result: 'win', symbol: 'SOL', net: 1, paid: true }));
  applyFightToLeaderboard(stats, entry({ result: 'forfeit', symbol: 'SOL', net: -2, paid: true }));
  applyFightToLeaderboard(stats, entry({ result: 'tie', symbol: 'SOL', net: 0, paid: true }));
  assert.equal(stats.fights, 3);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.ties, 1);
  assert.equal(stats.winRateBps, 5_000);
  assert.equal(stats.solPnlLamports, -1);
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

  async waitFor<T = any>(predicate: (message: any) => boolean, timeoutMs = 8_000): Promise<T> {
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

test('leaderboard.list is public and lists published trainers without a fight record', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const alice = new TestClient(port);
  const guest = new TestClient(port);
  try {
    await Promise.all([alice.open(), guest.open()]);
    alice.send({ type: 'identify', playerId: 'demo-player-1' });
    await alice.waitFor(message => message.type === 'arena.snapshot');
    alice.send({ type: 'trainer.profile', username: 'Kaktuss', spriteId: 'blue-gen3' });
    await alice.waitFor((message: any) => (
      message.type === 'trainer.profile' && message.profile?.username === 'Kaktuss'
    ));

    guest.send({ type: 'leaderboard.list' });
    const board = await guest.waitFor<any>(message => message.type === 'leaderboard.list');
    assert.equal(board.rows.length, 1);
    assert.equal(board.rows[0].username, 'Kaktuss');
    assert.equal(board.rows[0].spriteId, 'blue-gen3');
    assert.equal(board.rows[0].fights, 0);
    assert.equal(board.rows[0].solPnlLamports, 0);
    assert.equal(board.rows[0].rank, 1);
  } finally {
    await Promise.all([alice.close(), guest.close()]);
    await server.close();
  }
});
