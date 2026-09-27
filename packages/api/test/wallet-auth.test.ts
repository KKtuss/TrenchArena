import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { ApiServer } from '../src/server';
import {
  buildAuthMessage,
  createAuthChallenge,
  decodeBase58,
  encodeBase58,
  isSolanaAddress,
  verifySolanaSignature,
} from '../src/wallet-auth';

function createSolanaKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublic = Buffer.from(spki.subarray(spki.length - 32));
  const address = encodeBase58(rawPublic);
  return { address, privateKey, publicKey: rawPublic };
}

function signMessage(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  message: string,
): string {
  const signature = sign(null, Buffer.from(message, 'utf8'), privateKey as any);
  return encodeBase58(signature);
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
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message.')), timeoutMs);
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

test('wallet-auth helpers encode and verify Solana signatures', () => {
  const keypair = createSolanaKeypair();
  assert.equal(isSolanaAddress(keypair.address), true);
  assert.equal(decodeBase58(keypair.address).length, 32);
  const challenge = createAuthChallenge(keypair.address, Date.UTC(2026, 0, 1));
  assert.match(challenge.message, /PokeArena login/);
  assert.match(challenge.message, /URI: http:\/\/127\.0\.0\.1/);
  assert.equal(
    challenge.message,
    buildAuthMessage(keypair.address, challenge.nonce, Date.UTC(2026, 0, 1), 'http://127.0.0.1'),
  );
  const signature = signMessage(keypair.privateKey, challenge.message);
  assert.equal(verifySolanaSignature({
    address: keypair.address,
    message: challenge.message,
    signature,
  }), true);
  assert.equal(verifySolanaSignature({
    address: keypair.address,
    message: challenge.message,
    signature: signMessage(keypair.privateKey, 'tampered'),
  }), false);
});

test('auth.challenge and auth.verify bind wallet identity with mock balance', async () => {
  const server = new ApiServer();
  const port = await server.listen(0);
  const client = new TestClient(port);
  const keypair = createSolanaKeypair();
  try {
    await client.open();
    client.send({ type: 'auth.challenge', address: keypair.address });
    const challenge = await client.waitFor((message: any) => message.type === 'auth.challenge');
    assert.equal(challenge.address, keypair.address);
    assert.ok(challenge.nonce);
    assert.ok(challenge.message.includes(keypair.address));

    const signature = signMessage(keypair.privateKey, challenge.message);
    client.send({
      type: 'auth.verify',
      address: keypair.address,
      signature,
      nonce: challenge.nonce,
    });
    const verified = await client.waitFor((message: any) => message.type === 'auth.verified');
    assert.equal(verified.playerId, keypair.address);
    const ready = await client.waitFor(
      (message: any) => message.type === 'ready' && message.playerId === keypair.address,
    );
    assert.equal(ready.playerId, keypair.address);
    const snapshot = await client.waitFor((message: any) => message.type === 'arena.snapshot');
    assert.equal(snapshot.snapshot.wallet.playerId, keypair.address);
    assert.equal(snapshot.snapshot.wallet.balance, 0);
    assert.equal(snapshot.snapshot.wallet.eligible, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('auth.verify rejects invalid, expired, and replayed signatures', async () => {
  const server = new ApiServer();
  const port = await server.listen(0);
  const client = new TestClient(port);
  const keypair = createSolanaKeypair();
  const other = createSolanaKeypair();
  try {
    await client.open();
    client.send({ type: 'auth.challenge', address: keypair.address });
    const challenge = await client.waitFor((message: any) => message.type === 'auth.challenge');

    client.send({
      type: 'auth.verify',
      address: keypair.address,
      signature: signMessage(other.privateKey, challenge.message),
      nonce: challenge.nonce,
    });
    const invalid = await client.waitFor((message: any) => message.type === 'error');
    assert.match(invalid.message, /Invalid wallet signature/i);

    client.send({ type: 'auth.challenge', address: keypair.address });
    const challenge2 = await client.waitFor((message: any) => message.type === 'auth.challenge');
    const signature = signMessage(keypair.privateKey, challenge2.message);
    client.send({
      type: 'auth.verify',
      address: keypair.address,
      signature,
      nonce: challenge2.nonce,
    });
    await client.waitFor((message: any) => message.type === 'auth.verified');

    client.send({
      type: 'auth.verify',
      address: keypair.address,
      signature,
      nonce: challenge2.nonce,
    });
    const replay = await client.waitFor((message: any) => message.type === 'error');
    assert.match(replay.message, /Unknown or expired|already used/i);

    client.send({
      type: 'auth.verify',
      address: keypair.address,
      signature,
      nonce: 'missing-nonce',
    });
    const missing = await client.waitFor((message: any) => message.type === 'error');
    assert.match(missing.message, /Unknown or expired/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test('wallet reconnect restores identity via fresh signature', async () => {
  const server = new ApiServer();
  const port = await server.listen(0);
  const keypair = createSolanaKeypair();
  const first = new TestClient(port);
  try {
    await first.open();
    first.send({ type: 'auth.challenge', address: keypair.address });
    const challenge = await first.waitFor((message: any) => message.type === 'auth.challenge');
    first.send({
      type: 'auth.verify',
      address: keypair.address,
      signature: signMessage(keypair.privateKey, challenge.message),
      nonce: challenge.nonce,
    });
    await first.waitFor(
      (message: any) => message.type === 'ready' && message.playerId === keypair.address,
    );
    await first.close();

    const second = new TestClient(port);
    await second.open();
    second.send({ type: 'auth.challenge', address: keypair.address });
    const challenge2 = await second.waitFor((message: any) => message.type === 'auth.challenge');
    second.send({
      type: 'auth.verify',
      address: keypair.address,
      signature: signMessage(keypair.privateKey, challenge2.message),
      nonce: challenge2.nonce,
    });
    const ready = await second.waitFor(
      (message: any) => message.type === 'ready' && message.playerId === keypair.address,
    );
    assert.equal(ready.playerId, keypair.address);
    const snapshot = await second.waitFor((message: any) => message.type === 'arena.snapshot');
    assert.equal(snapshot.snapshot.wallet.balance, 0);
    assert.equal(snapshot.snapshot.wallet.eligible, false);
    await second.close();
  } finally {
    await first.close();
    await server.close();
  }
});
