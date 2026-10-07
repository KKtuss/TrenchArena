import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ArenaChainClient,
  createMockQuote,
  evaluatePassport,
  type ArenaChainClient as ChainClient,
} from '@pokearena/solana-client';
import type { ChainIntentRow, ChainIntentStatus, PostgresChainStore } from '@pokearena/db';
import { WebSocket } from 'ws';

import { AsyncLimiter } from '../src/async-limit';
import {
  ChainEconomyService,
  INTENT_VERIFICATION_CONCURRENCY,
} from '../src/chain-economy';
import { ApiServer } from '../src/server';
import { encodeBase58 } from '../src/wallet-auth';

const PROGRAM_ID = '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W';
const TOURNAMENT_ID = '11111111-1111-4111-8111-111111111111';

test('authorization reads POKE balance on every check', async () => {
  const keeper = Keypair.generate();
  const player = Keypair.generate().publicKey;
  const service = new ChainEconomyService({
    env: chainEnv(keeper),
    keeper,
    chainStore: null,
  });
  let reads = 0;
  (service.client!.connection as unknown as {
    getTokenAccountBalance: () => Promise<{ value: { amount: string } }>;
  }).getTokenAccountBalance = async () => {
    reads += 1;
    return { value: { amount: '1000000000' } };
  };

  await service.getPassport(player.toBase58());
  await service.getPassport(player.toBase58());

  assert.equal(reads, 2);
});

test('tx.confirm verification is bounded, idempotent, and retryable', async () => {
  const keeper = Keypair.generate();
  const player = Keypair.generate();
  const store = new MemoryIntents();
  let active = 0;
  let peak = 0;
  let verifications = 0;
  let submissions = 0;
  const client = {
    configAddress: PublicKey.default,
    verifyIntentTransaction: async (signature: string) => {
      verifications += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 30));
      active -= 1;
      if (signature.startsWith('rate-limited')) {
        return { signature, status: 'pending', error: '429 Too Many Requests' };
      }
      if (signature.startsWith('rejected')) {
        return { signature, status: 'failed', error: 'Transaction signer does not match the intent.' };
      }
      return { signature, status: 'confirmed', slot: 9 };
    },
    sendRawTransaction: async () => {
      submissions += 1;
      return 'submitted';
    },
  } as unknown as ChainClient;

  const economy = new ChainEconomyService({
    env: chainEnv(keeper),
    keeper,
    chainStore: store as unknown as PostgresChainStore,
    client,
  });

  const ids = Array.from({ length: 6 }, () => store.insert(player.publicKey, 'confirm'));
  await Promise.all(ids.map((id, index) => economy.confirmIntent({
    intentId: id,
    signature: `confirm-${index}`,
  })));
  assert.equal(peak, INTENT_VERIFICATION_CONCURRENCY);
  assert.equal(verifications, 6);
  assert.equal(store.reserved, 6);
  assert.equal(submissions, 0);

  const duplicate = store.insert(player.publicKey, 'confirm');
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const original = client.verifyIntentTransaction;
  let duplicateCalls = 0;
  client.verifyIntentTransaction = async (signature, expected) => {
    if (signature === 'duplicate-signature') {
      duplicateCalls += 1;
      await gate;
      return { signature, status: 'confirmed', slot: 4 };
    }
    return original.call(client, signature, expected);
  };
  const first = economy.confirmIntent({ intentId: duplicate, signature: 'duplicate-signature' });
  const second = economy.confirmIntent({ intentId: duplicate, signature: 'duplicate-signature' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(duplicateCalls, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, 'confirmed');
  assert.equal(secondResult.status, 'confirmed');
  assert.equal(store.reserved, 7);
  const third = await economy.confirmIntent({ intentId: duplicate, signature: 'duplicate-signature' });
  assert.equal(third.status, 'confirmed');
  assert.equal(duplicateCalls, 1);

  const unknown = store.insert(player.publicKey, 'rate-limit');
  const retryable = await economy.confirmIntent({ intentId: unknown, signature: 'rate-limited-signature' });
  assert.equal(retryable.status, 'pending');
  assert.equal(store.rows.get(unknown)?.status, 'pending');
  assert.match(String(store.rows.get(unknown)?.metadata.error), /429/);
  assert.equal(submissions, 0);

  const rejected = store.insert(player.publicKey, 'rejected');
  const failed = await economy.confirmIntent({ intentId: rejected, signature: 'rejected-signature' });
  assert.equal(failed.status, 'failed');
  assert.equal(store.rows.get(rejected)?.status, 'failed');
  assert.equal(store.reserved, 7);
});

test('simultaneous arena refreshes share one snapshot pass and cached POKE balances', async () => {
  const keeper = Keypair.generate();
  let pokeReads = 0;
  const quote = createMockQuote();
  const client = {
    configAddress: PublicKey.default,
    resolveQuote: () => quote,
    getPokeBalance: async () => {
      pokeReads += 1;
      return 50_000_000_000n;
    },
    getPassportStatus: async (input: { liquidAtoms?: bigint; heldEntryAtoms?: bigint }) => {
      if (input.liquidAtoms === undefined) {
        throw new Error('Display snapshot fetched a POKE balance independently.');
      }
      return evaluatePassport({
        liquidAtoms: input.liquidAtoms,
        heldEntryAtoms: input.heldEntryAtoms,
        quote,
      });
    },
    getSolBalance: async () => 1_000_000_000n,
    getTreasuryLamports: async () => 0n,
  } as unknown as ArenaChainClient;
  const economy = new ChainEconomyService({
    env: chainEnv(keeper),
    keeper,
    chainStore: null,
    client,
  });
  const server = new ApiServer({
    chainEconomy: economy,
    devFaucet: false,
    maxConnectionsPerIp: 32,
    rateLimits: { authChallenge: 40 },
  });
  const port = await server.listen(0);
  const clients = Array.from({ length: 8 }, () => new TestClient(port));
  try {
    await Promise.all(clients.map(clientSocket => clientSocket.open()));
    await Promise.all(clients.map(async clientSocket => {
      const keypair = createSolanaKeypair();
      await authenticate(clientSocket, keypair);
    }));
    assert.equal(pokeReads, 8);

    const passesBefore = server.arenaSnapshotPasses;
    const readsBefore = pokeReads;
    await Promise.all(Array.from({ length: 8 }, () => server.refreshArenaSnapshotsForTests()));
    assert.equal(server.arenaSnapshotPasses - passesBefore, 1);
    assert.equal(pokeReads - readsBefore, 0);
  } finally {
    await Promise.all(clients.map(clientSocket => clientSocket.close()));
    await server.close();
  }
});

test('a pending burn signature is kept and a second confirmation cannot replace it', async () => {
  const keeper = Keypair.generate();
  const player = Keypair.generate();
  const store = new MemoryIntents();
  const seen: string[] = [];
  const client = {
    configAddress: PublicKey.default,
    verifyIntentTransaction: async (signature: string) => {
      seen.push(signature);
      return { signature, status: 'pending', error: '429 Too Many Requests' };
    },
  } as unknown as ChainClient;
  const economy = new ChainEconomyService({
    env: chainEnv(keeper),
    keeper,
    chainStore: store as unknown as PostgresChainStore,
    client,
  });
  const intentId = store.insert(player.publicKey, 'pin');
  await economy.confirmIntent({ intentId, signature: 'original-signature' });
  await economy.confirmIntent({ intentId, signature: 'replacement-signature' });
  assert.deepEqual(seen, ['original-signature', 'original-signature']);
  assert.equal(store.rows.get(intentId)?.metadata.signature, 'original-signature');
  assert.equal(store.rows.get(intentId)?.status, 'pending');
});

test('an outstanding burn signature is resumed instead of building another transaction', async () => {
  const keeper = Keypair.generate();
  const player = Keypair.generate().publicKey;
  const intentId = randomUUID();
  let blockhashReads = 0;
  const store = {
    async saveQuote() {},
    async sumReservedEntryAtoms() { return 0; },
    async getIntentByScope() {
      return {
        id: intentId,
        kind: 'poke_entry_deposit' as const,
        scopeId: `${TOURNAMENT_ID}:${player.toBase58()}`,
        playerId: player.toBase58(),
        asset: 'POKE' as const,
        amount: 10_000_000_000,
        status: 'pending' as const,
        idempotencyKey: `poke_entry_deposit:${TOURNAMENT_ID}:${player.toBase58()}`,
        tournamentId: TOURNAMENT_ID,
        metadata: { signature: 'already-signed' },
      };
    },
  };
  const client = {
    resolveQuote: () => createMockQuote(),
    getPassportStatus: async () => evaluatePassport({
      liquidAtoms: 12_000_000_000n,
      quote: createMockQuote(),
    }),
    getLatestBlockhash: async () => {
      blockhashReads += 1;
      throw new Error('A new transaction must not be built.');
    },
  } as unknown as ChainClient;
  const economy = new ChainEconomyService({
    env: chainEnv(keeper),
    keeper,
    chainStore: store as unknown as PostgresChainStore,
    client,
  });
  const resumed = await economy.createPokeEntryDepositIntent({
    tournamentId: TOURNAMENT_ID,
    playerId: player.toBase58(),
    entryAtoms: 10_000_000_000,
    fixedBurnFee: true,
  });
  assert.equal(resumed.intentId, intentId);
  assert.equal(resumed.signature, 'already-signed');
  assert.equal(resumed.serializedTx.length, 0);
  assert.equal(blockhashReads, 0);
});

test('display balance limiter caps concurrent POKE reads', async () => {
  const limiter = new AsyncLimiter(4);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
  })));
  assert.equal(peak, 4);
});

function chainEnv(keeper: Keypair): NodeJS.ProcessEnv {
  return {
    POKEARENA_CHAIN_ECONOMY: 'true',
    POKEARENA_SOLANA_CLUSTER: 'localnet',
    POKEARENA_SOLANA_RPC: 'http://127.0.0.1:8899',
    POKEARENA_PROGRAM_ID: PROGRAM_ID,
    POKEARENA_POKE_MINT: Keypair.generate().publicKey.toBase58(),
    POKEARENA_KEEPER: keeper.publicKey.toBase58(),
    POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
    POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
  };
}

class MemoryIntents {
  readonly rows = new Map<string, ChainIntentRow>();
  reserved = 0;

  insert(player: PublicKey, mode: string): string {
    const id = randomUUID();
    this.rows.set(id, {
      id,
      kind: 'poke_entry_deposit',
      scopeId: `${TOURNAMENT_ID}:${player.toBase58()}`,
      playerId: player.toBase58(),
      asset: 'POKE',
      amount: 1,
      status: 'pending',
      idempotencyKey: `poke_entry_deposit:${id}`,
      tournamentId: TOURNAMENT_ID,
      metadata: {
        mode,
        playerPokeAta: player.toBase58(),
        expected: {
          signer: player.toBase58(),
          discriminator: '00'.repeat(8),
        },
      },
    });
    return id;
  }

  async getIntent(id: string): Promise<ChainIntentRow | null> {
    return this.rows.get(id) ?? null;
  }

  async setIntentStatus(
    id: string,
    status: ChainIntentStatus,
    extras: { signature?: string; error?: string } = {},
  ): Promise<ChainIntentRow> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown chain intent: ${id}`);
    const retryable = status === 'confirmed' || status === 'pending';
    if (row.status === 'confirmed' || (row.status === 'failed' && !retryable)) return row;
    row.status = status;
    row.metadata = {
      ...row.metadata,
      ...(extras.signature ? { signature: extras.signature } : {}),
      ...(extras.error ? { error: extras.error } : {}),
    };
    return row;
  }

  async markEntryReserved(): Promise<void> {
    this.reserved += 1;
  }

  async mergeIntentMetadata(id: string, patch: Record<string, unknown>): Promise<ChainIntentRow> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown chain intent: ${id}`);
    row.metadata = { ...row.metadata, ...patch };
    return row;
  }
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
      const timeout = setTimeout(() => {
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
  await client.waitFor(message => message.type === 'arena.snapshot');
}
