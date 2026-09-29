import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { ApiServer } from '../src/server';

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

async function identify(client: TestClient, playerId: string): Promise<any> {
  client.send({ type: 'identify', playerId });
  return client.waitFor(message => message.type === 'arena.snapshot');
}

test('published trainer names are visible to other connected clients', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const alice = new TestClient(port);
  const bob = new TestClient(port);
  try {
    await Promise.all([alice.open(), bob.open()]);
    await identify(alice, 'demo-player-1');
    await identify(bob, 'demo-player-2');

    alice.send({ type: 'trainer.profile', username: 'Kaktuss', spriteId: 'blue-gen3' });
    const ack = await alice.waitFor((message: any) => (
      message.type === 'trainer.profile' && message.playerId === 'demo-player-1'
    ));
    assert.equal(ack.profile.username, 'Kaktuss');
    assert.equal(ack.profile.spriteId, 'blue-gen3');

    const directory = await bob.waitFor((message: any) => (
      message.type === 'trainer.directory' && message.trainers['demo-player-1']?.username === 'Kaktuss'
    ));
    assert.equal(directory.trainers['demo-player-1'].username, 'Kaktuss');
  } finally {
    await Promise.all([alice.close(), bob.close()]);
    await server.close();
  }
});

test('a late joiner receives already-published trainer names in the snapshot', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const port = await server.listen(0);
  const alice = new TestClient(port);
  const bob = new TestClient(port);
  try {
    await alice.open();
    await identify(alice, 'demo-player-1');
    alice.send({ type: 'trainer.profile', username: 'Kaktuss', spriteId: 'blue-gen3' });
    await alice.waitFor((message: any) => (
      message.type === 'trainer.profile' && message.profile?.username === 'Kaktuss'
    ));

    await bob.open();
    const snapshot = await identify(bob, 'demo-player-2');
    assert.equal(snapshot.snapshot.trainers['demo-player-1'].username, 'Kaktuss');
    assert.equal(snapshot.snapshot.trainers['demo-player-1'].spriteId, 'blue-gen3');
  } finally {
    await Promise.all([alice.close(), bob.close()]);
    await server.close();
  }
});
