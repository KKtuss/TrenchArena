import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { toPublicError } from '../src/public-errors';
import { ApiServer } from '../src/server';
import { encodeBase58 } from '../src/wallet-auth';

const PRODUCTION_ORIGIN = 'https://pokearena.example';
const OTHER_ORIGIN = 'https://other.example';

function createSolanaKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublic = Buffer.from(spki.subarray(spki.length - 32));
  return { address: encodeBase58(rawPublic), privateKey };
}

function signMessage(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  message: string,
): string {
  return encodeBase58(sign(null, Buffer.from(message, 'utf8'), privateKey as any));
}

class TestClient {
  readonly socket: WebSocket;
  private readonly messages: any[] = [];
  private readonly waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
  }> = [];

  constructor(port: number, origin?: string, forwardedFor?: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      ...(origin ? { origin } : {}),
      ...(forwardedFor ? { headers: { 'X-Forwarded-For': forwardedFor } } : {}),
    });
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
    this.socket.send(JSON.stringify({ requestId: randomUUID(), ...message }));
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
    return new Promise(resolve => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.socket.once('close', () => resolve());
      this.socket.terminate();
    });
  }
}

function httpGet(url: string): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function expectUpgradeRejected(port: number, origin?: string): Promise<void> {
  const client = new TestClient(port, origin);
  await assert.rejects(() => client.open());
  await client.close();
}

async function identify(client: TestClient, playerId: 'demo-player-1' | 'demo-player-2'): Promise<void> {
  client.send({ type: 'identify', playerId });
  await client.waitFor(message => message.type === 'ready' && message.playerId === playerId);
}

async function authenticate(
  client: TestClient,
  keypair: ReturnType<typeof createSolanaKeypair>,
): Promise<void> {
  client.send({ type: 'auth.challenge', address: keypair.address });
  const challenge = await client.waitFor<any>(message => (
    message.type === 'auth.challenge' && message.address === keypair.address
  ));
  client.send({
    type: 'auth.verify',
    address: keypair.address,
    signature: signMessage(keypair.privateKey, challenge.message),
    nonce: challenge.nonce,
  });
  await client.waitFor(message => message.type === 'auth.verified' && message.playerId === keypair.address);
}

test('allowed production origin can upgrade and still requires wallet auth', async () => {
  const server = new ApiServer({
    originMode: 'strict',
    allowedOrigins: [PRODUCTION_ORIGIN],
  });
  const port = await server.listen(0);
  const client = new TestClient(port, PRODUCTION_ORIGIN);
  try {
    await client.open();
    client.send({ type: 'tournament.create', title: 'Blocked', maxPlayers: 4 });
    const denied = await client.waitFor<any>(message => message.type === 'error');
    assert.match(denied.message, /Authenticate with a wallet/i);
    assert.notEqual(denied.code, 'TournamentHostRequiredError');
    const keypair = createSolanaKeypair();
    await authenticate(client, keypair);
    client.send({ type: 'arena.snapshot' });
    const snapshot = await client.waitFor<any>(message => message.type === 'arena.snapshot');
    assert.equal(snapshot.snapshot.wallet.playerId, keypair.address);
  } finally {
    await client.close();
    await server.close();
  }
});

test('disallowed and malformed origins are rejected', async () => {
  const server = new ApiServer({
    originMode: 'strict',
    allowedOrigins: [PRODUCTION_ORIGIN],
  });
  const port = await server.listen(0);
  try {
    await expectUpgradeRejected(port, 'https://evil.example');
    await expectUpgradeRejected(port, 'https://pokearena.example/path');
    await expectUpgradeRejected(port, 'not-a-origin');
    await expectUpgradeRejected(port, 'null');
    await expectUpgradeRejected(port);
    const allowed = new TestClient(port, PRODUCTION_ORIGIN);
    await allowed.open();
    allowed.send({ type: 'ping' });
    const pong = await allowed.waitFor(message => message.type === 'pong');
    assert.equal(pong.type, 'pong');
    await allowed.close();
  } finally {
    await server.close();
  }
});

test('development localhost origins work only in development origin mode', async () => {
  const development = new ApiServer({ originMode: 'development' });
  const developmentPort = await development.listen(0);
  try {
    const local = new TestClient(developmentPort, 'http://localhost:3001');
    await local.open();
    local.send({ type: 'ping' });
    await local.waitFor(message => message.type === 'pong');
    await local.close();
  } finally {
    await development.close();
  }

  const strict = new ApiServer({
    originMode: 'strict',
    allowedOrigins: [PRODUCTION_ORIGIN],
  });
  const strictPort = await strict.listen(0);
  try {
    await expectUpgradeRejected(strictPort, 'http://localhost:3001');
    await expectUpgradeRejected(strictPort, 'http://127.0.0.1:3001');
  } finally {
    await strict.close();
  }
});

test('connection limits reject extras without affecting existing sockets', async () => {
  const server = new ApiServer({
    maxConnections: 2,
    maxConnectionsPerIp: 16,
  });
  const port = await server.listen(0);
  const first = new TestClient(port);
  const second = new TestClient(port);
  try {
    await Promise.all([first.open(), second.open()]);
    assert.equal(server.connectionCount, 2);
    await expectUpgradeRejected(port);
    first.send({ type: 'ping' });
    await first.waitFor(message => message.type === 'pong');
    await second.close();
    const replacement = new TestClient(port);
    await replacement.open();
    replacement.send({ type: 'ping' });
    await replacement.waitFor(message => message.type === 'pong');
    await replacement.close();
  } finally {
    await Promise.all([first.close(), second.close()]);
    await server.close();
  }
});

test('per-IP connection limit is independent of the global cap', async () => {
  const server = new ApiServer({
    maxConnections: 16,
    maxConnectionsPerIp: 1,
  });
  const port = await server.listen(0);
  const first = new TestClient(port);
  try {
    await first.open();
    await expectUpgradeRejected(port);
    first.send({ type: 'ping' });
    await first.waitFor(message => message.type === 'pong');
    await first.close();
    const again = new TestClient(port);
    await again.open();
    await again.close();
  } finally {
    await first.close();
    await server.close();
  }
});

test('oversized WebSocket payloads are rejected without crashing the server', async () => {
  const server = new ApiServer({ allowDemoAuth: true, maxPayloadBytes: 2_048 });
  const port = await server.listen(0);
  const noisy = new TestClient(port);
  const other = new TestClient(port);
  try {
    await Promise.all([noisy.open(), other.open()]);
    await identify(other, 'demo-player-2');
    noisy.socket.send(`{"requestId":"${randomUUID()}","type":"ping","pad":"${'x'.repeat(8_000)}"}`);
    await new Promise<void>(resolve => {
      if (noisy.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      noisy.socket.once('close', () => resolve());
      noisy.socket.once('error', () => resolve());
    });
    const health = await httpGet(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body, '{"ok":true}');
    assert.equal(health.headers['access-control-allow-origin'], undefined);
    other.send({ type: 'arena.snapshot' });
    const snapshot = await other.waitFor<any>(message => (
      message.type === 'arena.snapshot' && message.snapshot.wallet.playerId === 'demo-player-2'
    ));
    assert.equal(snapshot.snapshot.wallet.playerId, 'demo-player-2');
  } finally {
    await Promise.all([noisy.close(), other.close()]);
    await server.close();
  }
});

test('auth challenge and room creation spam are throttled per actor', async () => {
  const server = new ApiServer({
    allowDemoAuth: true,
    trustProxy: true,
    rateLimits: {
      windowMs: 200,
      authChallenge: 1,
      casualCreate: 1,
      tournamentCreate: 8,
      teamSearch: 8,
      matchChoice: 8,
    },
  });
  const port = await server.listen(0);
  const first = new TestClient(port, undefined, '203.0.113.10');
  const second = new TestClient(port, undefined, '203.0.113.20');
  const keypair = createSolanaKeypair();
  const otherKey = createSolanaKeypair();
  try {
    await Promise.all([first.open(), second.open()]);
    first.send({ type: 'auth.challenge', address: keypair.address });
    await first.waitFor(message => message.type === 'auth.challenge');
    first.send({ type: 'auth.challenge', address: keypair.address });
    const throttled = await first.waitFor<any>(message => message.type === 'error');
    assert.equal(throttled.code, 'RateLimitedError');

    second.send({ type: 'auth.challenge', address: otherKey.address });
    const otherChallenge = await second.waitFor<any>(message => message.type === 'auth.challenge');
    assert.equal(otherChallenge.address, otherKey.address);

    await identify(first, 'demo-player-1');
    await identify(second, 'demo-player-2');
    first.send({ type: 'casual.create', roomType: 'open', battleSize: '1v1', collateral: 1_000 });
    await first.waitFor(message => message.type === 'casual.created');
    first.send({ type: 'casual.create', roomType: 'open', battleSize: '1v1', collateral: 1_000 });
    const roomDenied = await first.waitFor<any>(message => message.type === 'error');
    assert.equal(roomDenied.code, 'RateLimitedError');
    second.send({ type: 'casual.create', roomType: 'open', battleSize: '1v1', collateral: 1_000 });
    const created = await second.waitFor<any>(message => message.type === 'casual.created' || message.type === 'error');
    assert.equal(created.type, 'casual.created');

    await new Promise(resolve => setTimeout(resolve, 220));
    first.send({ type: 'auth.challenge', address: keypair.address });
    const recovered = await first.waitFor<any>(message => (
      message.type === 'auth.challenge' || message.type === 'error'
    ));
    assert.equal(recovered.type, 'auth.challenge');
  } finally {
    await Promise.all([first.close(), second.close()]);
    await server.close();
  }
});

test('auth challenges are bound to the requesting socket, origin, and expiry', async () => {
  const server = new ApiServer({
    originMode: 'strict',
    allowedOrigins: [PRODUCTION_ORIGIN, OTHER_ORIGIN],
    challengeTtlMs: 40,
    challengeCleanupMs: 15,
  });
  const port = await server.listen(0);
  const first = new TestClient(port, PRODUCTION_ORIGIN);
  const second = new TestClient(port, OTHER_ORIGIN);
  const keypair = createSolanaKeypair();
  try {
    await Promise.all([first.open(), second.open()]);
    first.send({ type: 'auth.challenge', address: keypair.address });
    const challenge = await first.waitFor<any>(message => message.type === 'auth.challenge');
    assert.match(challenge.message, new RegExp(`URI: ${PRODUCTION_ORIGIN}`));
    assert.doesNotMatch(challenge.message, new RegExp(OTHER_ORIGIN));

    const signature = signMessage(keypair.privateKey, challenge.message);
    second.send({
      type: 'auth.verify',
      address: keypair.address,
      signature,
      nonce: challenge.nonce,
    });
    const stolen = await second.waitFor<any>(message => message.type === 'error');
    assert.match(stolen.message, /another connection|origin/i);

    await new Promise(resolve => setTimeout(resolve, 50));
    first.send({
      type: 'auth.verify',
      address: keypair.address,
      signature,
      nonce: challenge.nonce,
    });
    const expired = await first.waitFor<any>(message => message.type === 'error');
    assert.match(expired.message, /expired|Unknown/i);

    first.send({ type: 'auth.challenge', address: keypair.address });
    const fresh = await first.waitFor<any>(message => message.type === 'auth.challenge');
    const freshSignature = signMessage(keypair.privateKey, fresh.message);
    first.send({
      type: 'auth.verify',
      address: keypair.address,
      signature: freshSignature,
      nonce: fresh.nonce,
    });
    await first.waitFor(message => message.type === 'auth.verified');
    first.send({
      type: 'auth.verify',
      address: keypair.address,
      signature: freshSignature,
      nonce: fresh.nonce,
    });
    const replay = await first.waitFor<any>(message => message.type === 'error');
    assert.match(replay.message, /already used|Unknown or expired|already authenticated/i);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await server.close();
  }
});

test('expired challenges are swept and challenge spam cannot grow without bound', async () => {
  const server = new ApiServer({
    challengeTtlMs: 20,
    challengeCleanupMs: 10,
    rateLimits: {
      windowMs: 60_000,
      authChallenge: 100,
      casualCreate: 20,
      tournamentCreate: 10,
      teamSearch: 60,
      matchChoice: 120,
    },
  });
  const port = await server.listen(0);
  const client = new TestClient(port);
  const keypair = createSolanaKeypair();
  try {
    await client.open();
    for (let i = 0; i < 25; i += 1) {
      client.send({ type: 'auth.challenge', address: keypair.address });
      await client.waitFor(message => message.type === 'auth.challenge');
    }
    assert.equal(server.pendingChallengeCount, 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    server.flushAuthStateForTests();
    assert.equal(server.pendingChallengeCount, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test('public errors omit stacks, paths, and internal details', async () => {
  const leaked = toPublicError(new Error('ENOENT: no such file or directory, open \'D:\\CursorProj\\secret.env\''));
  assert.equal(leaked.code, 'ProtocolError');
  assert.equal(leaked.message.includes('D:\\'), false);
  assert.equal(leaked.message.includes('secret.env'), false);
  assert.equal(leaked.message.includes('at '), false);

  const server = new ApiServer();
  const port = await server.listen(0);
  const client = new TestClient(port);
  try {
    await client.open();
    client.send({ type: 'tournament.create', title: 'Nope', maxPlayers: 4 });
    const denied = await client.waitFor<any>(message => message.type === 'error');
    assert.equal(denied.message.includes('\n    at '), false);
    assert.equal(JSON.stringify(denied).includes('node_modules'), false);
    client.socket.send('{not-json');
    const malformed = await client.waitFor<any>(message => message.type === 'error');
    assert.equal(malformed.code, 'Error');
    assert.equal(malformed.message, 'Message must be valid JSON.');
  } finally {
    await client.close();
    await server.close();
  }
});
