import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { ArenaChainClient, IX, type ArenaChainConfig } from '@pokearena/solana-client';
import type { ChainIntentRow, ChainIntentStatus, CreateIntentInput, PostgresChainStore } from '@pokearena/db';

import { CasualRoomService } from '../src/casual-service';
import {
  assessDepositEscrow,
  ChainEconomyService,
  depositEscrowFollowUp,
} from '../src/chain-economy';
import { MockEconomics } from '../src/mock-economics';

const PROGRAM_ID = '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W';

class MemoryChainStore {
  readonly statusWrites: ChainIntentStatus[] = [];
  private readonly intents = new Map<string, ChainIntentRow>();

  async createIntent(input: CreateIntentInput): Promise<ChainIntentRow> {
    const existing = [...this.intents.values()].find(row => row.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const row: ChainIntentRow = {
      id: randomUUID(),
      kind: input.kind,
      scopeId: input.scopeId,
      ...(input.playerId ? { playerId: input.playerId } : {}),
      asset: input.asset,
      amount: input.amount,
      status: 'created',
      idempotencyKey: input.idempotencyKey,
      ...(input.roomId ? { roomId: input.roomId } : {}),
      metadata: input.metadata ?? {},
    };
    this.intents.set(row.id, row);
    return row;
  }

  async getIntent(id: string): Promise<ChainIntentRow | undefined> {
    const row = this.intents.get(id);
    return row ? { ...row, metadata: { ...row.metadata } } : undefined;
  }

  async getIntentByScope(kind: ChainIntentRow['kind'], scopeId: string): Promise<ChainIntentRow | undefined> {
    const row = [...this.intents.values()].find(item => item.kind === kind && item.scopeId === scopeId);
    return row ? { ...row, metadata: { ...row.metadata } } : undefined;
  }

  async listPendingIntents(): Promise<ChainIntentRow[]> {
    return [...this.intents.values()]
      .filter(row => row.status === 'created' || row.status === 'pending')
      .map(row => ({ ...row, metadata: { ...row.metadata } }));
  }

  async mergeIntentMetadata(id: string, patch: Record<string, unknown>): Promise<ChainIntentRow> {
    const row = this.intents.get(id);
    if (!row) throw new Error(`Unknown chain intent: ${id}`);
    row.metadata = { ...row.metadata, ...patch };
    return { ...row, metadata: { ...row.metadata } };
  }

  async setIntentStatus(id: string, status: ChainIntentStatus): Promise<ChainIntentRow> {
    const row = this.intents.get(id);
    if (!row) throw new Error(`Unknown chain intent: ${id}`);
    this.statusWrites.push(status);
    const retryable = status === 'confirmed' || status === 'pending';
    if (
      row.status === 'confirmed'
      || row.status === 'cancelled'
      || ((row.status === 'failed' || row.status === 'expired') && !retryable)
    ) {
      return { ...row, metadata: { ...row.metadata } };
    }
    row.status = status;
    return { ...row, metadata: { ...row.metadata } };
  }
}

function encodeBase58(input: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of input) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    const remainder = value % 58n;
    value /= 58n;
    encoded = alphabet[Number(remainder)] + encoded;
  }
  for (const byte of input) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function chainConfig(keeper: PublicKey): ArenaChainConfig {
  return {
    cluster: 'localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    programId: new PublicKey(PROGRAM_ID),
    pokeMint: PublicKey.default,
    feeVault: PublicKey.default,
    treasuryVault: PublicKey.default,
    operatorVault: PublicKey.default,
    quoteAuthority: keeper,
    keeper,
    authority: keeper,
    buybackBps: 2500,
    minBuybackLamports: 1,
    chainEconomyEnabled: true,
    commitment: 'confirmed',
  };
}

function harness() {
  const keeper = Keypair.generate();
  const player = Keypair.generate();
  const calls = { status: 0, parsed: 0, account: 0, sent: 0, height: 0 };
  const client = new ArenaChainClient(chainConfig(keeper.publicKey));
  client.getMatchEscrowState = async () => {
    throw new Error('Match escrow account was not found.');
  };
  client.connection.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  });
  client.connection.getSignatureStatuses = async () => {
    calls.status += 1;
    return {
      context: { slot: 9 },
      value: [{ slot: 8, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
    };
  };
  client.connection.getParsedTransaction = async () => {
    calls.parsed += 1;
    return null;
  };
  client.connection.getAccountInfo = async () => {
    calls.account += 1;
    return null;
  };
  client.connection.getBlockHeight = async () => {
    calls.height += 1;
    return 1;
  };
  client.connection.sendRawTransaction = async () => {
    calls.sent += 1;
    return 'sent';
  };
  const chainStore = new MemoryChainStore();
  const economy = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'localnet',
      POKEARENA_SOLANA_RPC: 'http://127.0.0.1:8899',
      POKEARENA_PROGRAM_ID: PROGRAM_ID,
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_DEPOSIT_POLL_MS: '0',
    },
    chainStore: chainStore as unknown as PostgresChainStore,
    client,
    keeper,
  });
  return { player, calls, chainStore, economy, client };
}

async function issuedIntent() {
  const setup = harness();
  const roomId = randomUUID();
  const created = await setup.economy.createSolWagerDepositIntent({
    roomId,
    playerId: setup.player.publicKey.toBase58(),
    side: 0,
    collateralLamports: 1_000_000,
  });
  const tx = Transaction.from(Uint8Array.from(created.serializedTx));
  tx.sign(setup.player);
  return {
    ...setup,
    roomId,
    intentId: created.intentId,
    signature: encodeBase58(tx.signature!),
  };
}

test('SOL deposit confirmation opens from the issued signature and ignores a later duplicate', async () => {
  const issued = await issuedIntent();
  const first = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: issued.signature,
  });
  const stored = await issued.chainStore.getIntent(issued.intentId);
  const duplicate = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: 'confirmed',
  });

  assert.equal(first.status, 'confirmed');
  assert.equal(stored?.status, 'confirmed');
  assert.equal(duplicate.status, 'confirmed');
  assert.equal(issued.calls.status, 1);
  assert.equal(issued.calls.parsed, 0);
  assert.equal(issued.calls.account, 0);
  assert.equal(issued.chainStore.statusWrites.filter(status => status === 'confirmed').length, 1);
});

test('SOL deposit confirmation rejects an unrelated signature and a forged confirmed flag', async () => {
  const issued = await issuedIntent();
  const unrelated = new Transaction();
  unrelated.feePayer = issued.player.publicKey;
  unrelated.recentBlockhash = Keypair.generate().publicKey.toBase58();
  unrelated.add(SystemProgram.transfer({
    fromPubkey: issued.player.publicKey,
    toPubkey: issued.player.publicKey,
    lamports: 2,
  }));
  unrelated.sign(issued.player);

  const forged = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: 'confirmed',
  });
  const wrong = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: encodeBase58(unrelated.signature!),
  });

  assert.equal(forged.status, 'failed');
  assert.equal(wrong.status, 'failed');
  assert.equal(issued.calls.status, 0);
  assert.equal(issued.calls.parsed, 0);
  assert.notEqual((await issued.chainStore.getIntent(issued.intentId))?.status, 'confirmed');
});

test('escrow lag and an unread account never revoke a confirmed lobby', () => {
  const creator = Keypair.generate().publicKey;
  const lagging = assessDepositEscrow({
    side: 'creator',
    roomCreator: creator.toBase58(),
    roomCollateral: 1_000_000,
    state: {
      creator,
      opponent: PublicKey.default,
      collateralLamports: 1_000_000n,
      creatorDeposited: false,
      opponentDeposited: false,
      feeCharged: false,
      status: 1,
    },
  });
  assert.equal(lagging, 'lagging');
  assert.equal(depositEscrowFollowUp(lagging, 0), 'retry');
  assert.equal(depositEscrowFollowUp(lagging, 1), 'keep');
  assert.equal(depositEscrowFollowUp('unread', 0), 'retry');
  assert.equal(depositEscrowFollowUp('unread', 1), 'keep');

  const mismatch = assessDepositEscrow({
    side: 'creator',
    roomCreator: creator.toBase58(),
    roomCollateral: 1_000_000,
    state: {
      creator,
      opponent: PublicKey.default,
      collateralLamports: 2_000_000n,
      creatorDeposited: true,
      opponentDeposited: false,
      feeCharged: false,
      status: 1,
    },
  });
  assert.equal(mismatch, 'mismatch');
  assert.equal(depositEscrowFollowUp(mismatch, 0), 'revoke');
});

test('a contradictory escrow read closes only the unmatched deposit', async () => {
  const casual = new CasualRoomService({
    economics: new MockEconomics(),
    selectionMs: 60_000,
  });
  const created = await casual.createRoom({
    creatorId: 'sol-creator',
    roomType: 'private',
    battleSize: '1v1',
    collateral: 1_000_000,
    invitedPlayerId: 'sol-invitee',
    rail: 'sol_chain',
  });
  casual.markSolDeposit(created.id, 'creator');
  assert.equal(casual.listOpenRooms('sol-invitee').some(room => room.id === created.id), true);
  await casual.acceptRoom(created.id, 'sol-invitee');
  casual.markSolDeposit(created.id, 'opponent');
  assert.equal(casual.getRoom(created.id).status, 'drafting');

  const revoked = casual.revokeUnmatchedSolDeposit(
    created.id,
    'creator',
    'Escrow collateral does not match the wager.',
  );
  assert.equal(revoked.status, 'full');
  assert.equal(revoked.deposits?.creator, false);
  assert.equal(revoked.deposits?.opponent, true);
  casual.markSolDeposit(created.id, 'creator');
  assert.equal(casual.getRoom(created.id).status, 'drafting');
  const again = casual.revokeUnmatchedSolDeposit(created.id, 'creator', 'same mismatch');
  assert.equal(again.status, 'full');
});

function queueStatuses(
  client: ArenaChainClient,
  calls: { status: number },
  values: Array<{ confirmationStatus?: 'processed' | 'confirmed' | 'finalized'; err?: unknown; slot?: number } | null>,
): void {
  const pending = [...values];
  client.connection.getSignatureStatuses = async () => {
    calls.status += 1;
    const next = pending.length > 0 ? pending.shift()! : values[values.length - 1] ?? null;
    return {
      context: { slot: 9 },
      value: [next ? { slot: next.slot ?? 8, confirmations: 0, err: next.err ?? null, confirmationStatus: next.confirmationStatus } : null],
    };
  };
}

test('a delayed deposit stays pending and confirms after later polls', async () => {
  const issued = await issuedIntent();
  queueStatuses(issued.client, issued.calls, [
    { confirmationStatus: 'processed', slot: 4 },
    null,
    { confirmationStatus: 'confirmed', slot: 6 },
  ]);
  const first = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: issued.signature,
  });
  assert.equal(first.status, 'pending');
  assert.equal((await issued.chainStore.getIntent(issued.intentId))?.status, 'pending');
  const watched = await issued.economy.waitForDepositWatch(issued.intentId);
  assert.equal(watched?.status, 'confirmed');
  assert.equal((await issued.chainStore.getIntent(issued.intentId))?.status, 'confirmed');
  assert.equal(issued.calls.status > 1, true);
});

test('an on-chain transaction error fails the deposit without opening the lobby', async () => {
  const issued = await issuedIntent();
  queueStatuses(issued.client, issued.calls, [
    { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] }, slot: 7 },
  ]);
  const result = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: issued.signature,
  });
  assert.equal(result.status, 'failed');
  assert.equal(issued.economy.waitForDepositWatch(issued.intentId), undefined);
  assert.equal((await issued.chainStore.getIntent(issued.intentId))?.status, 'failed');
});

test('a create transaction is not broadcast when the escrow already exists', async () => {
  const issued = await issuedIntent();
  const unsigned = Transaction.from(Buffer.from(
    (await issued.chainStore.getIntent(issued.intentId))!.metadata.serializedTx as string,
    'base64',
  ));
  unsigned.partialSign(issued.player);
  issued.client.getMatchEscrowState = async () => ({
    creator: issued.player.publicKey,
    opponent: PublicKey.default,
    collateralLamports: 1_000_000n,
    creatorDeposited: false,
    opponentDeposited: false,
    feeCharged: false,
    status: 0,
  });
  const result = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: issued.signature,
    signedTransaction: [...unsigned.serialize()],
  });
  assert.equal(result.status, 'pending');
  assert.match(result.error ?? '', /deposit-only|already exists/i);
  assert.equal(issued.calls.sent, 0);
  assert.equal(issued.calls.status, 0);
});

test('repeating a deposit while the first signature is pending does not send another create', async () => {
  const issued = await issuedIntent();
  queueStatuses(issued.client, issued.calls, [
    { confirmationStatus: 'processed', slot: 2 },
    { confirmationStatus: 'processed', slot: 2 },
    { confirmationStatus: 'confirmed', slot: 3 },
  ]);
  const storedBytes = Buffer.from(
    (await issued.chainStore.getIntent(issued.intentId))!.metadata.serializedTx as string,
    'base64',
  );
  const unsigned = Transaction.from(storedBytes);
  unsigned.partialSign(issued.player);
  const signed = [...unsigned.serialize()];
  const first = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: issued.signature,
    signedTransaction: signed,
  });
  assert.equal(first.status, 'pending');
  assert.equal(issued.calls.sent, 1);
  const again = await issued.economy.createSolWagerDepositIntent({
    roomId: issued.roomId,
    playerId: issued.player.publicKey.toBase58(),
    side: 0,
    collateralLamports: 1_000_000,
  });
  assert.deepEqual(Buffer.from(again.serializedTx), storedBytes);
  const second = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: issued.signature,
    signedTransaction: signed,
  });
  assert.equal(second.status, 'pending');
  assert.equal(issued.calls.sent, 1);
  await issued.economy.waitForDepositWatch(issued.intentId);
  assert.equal((await issued.chainStore.getIntent(issued.intentId))?.status, 'confirmed');
});

test('a confirmed escrow adopts a stale local deposit intent', async () => {
  const issued = await issuedIntent();
  await issued.chainStore.setIntentStatus(issued.intentId, 'failed');
  issued.client.getMatchEscrowState = async () => ({
    creator: issued.player.publicKey,
    opponent: PublicKey.default,
    collateralLamports: 1_000_000n,
    creatorDeposited: true,
    opponentDeposited: false,
    feeCharged: false,
    status: 1,
  });
  const rebuilt = await issued.economy.createSolWagerDepositIntent({
    roomId: issued.roomId,
    playerId: issued.player.publicKey.toBase58(),
    side: 0,
    collateralLamports: 1_000_000,
  });
  assert.deepEqual(rebuilt.serializedTx, []);
  assert.equal((await issued.chainStore.getIntent(issued.intentId))?.status, 'confirmed');
  await issued.chainStore.setIntentStatus(issued.intentId, 'pending');
  await issued.economy.adoptEscrowDeposit(issued.roomId, 'creator');
  assert.equal((await issued.chainStore.getIntent(issued.intentId))?.status, 'confirmed');
});

test('a pending deposit is confirmed again after the process restarts', async () => {
  const issued = await issuedIntent();
  await issued.chainStore.mergeIntentMetadata(issued.intentId, { signature: issued.signature });
  await issued.chainStore.setIntentStatus(issued.intentId, 'pending');
  const stored = await issued.chainStore.getIntent(issued.intentId);
  assert.equal(stored?.status, 'pending');

  const restarted = harness();
  restarted.client.connection.getSignatureStatuses = async () => {
    restarted.calls.status += 1;
    return {
      context: { slot: 12 },
      value: [{ slot: 11, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
    };
  };
  await restarted.chainStore.createIntent({
    kind: 'sol_wager_deposit',
    scopeId: `${issued.roomId}:creator`,
    playerId: issued.player.publicKey.toBase58(),
    asset: 'SOL',
    amount: 1_000_000,
    idempotencyKey: `sol_wager_deposit:${issued.roomId}:creator`,
    roomId: issued.roomId,
    metadata: stored?.metadata ?? {},
  });
  const copied = await restarted.chainStore.getIntentByScope('sol_wager_deposit', `${issued.roomId}:creator`);
  await restarted.chainStore.setIntentStatus(copied!.id, 'pending');
  await restarted.economy.resumePendingDeposits();
  const watched = await restarted.economy.waitForDepositWatch(copied!.id);
  assert.equal(watched?.status, 'confirmed');
  assert.equal((await restarted.chainStore.getIntent(copied!.id))?.status, 'confirmed');
  assert.equal(restarted.calls.sent, 0);
});

test('a wallet-augmented signature matches the issued deposit and a modified one is rejected', async () => {
  const lighthouse = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
  const issued = await issuedIntent();
  const stored = Buffer.from(
    (await issued.chainStore.getIntent(issued.intentId))!.metadata.serializedTx as string,
    'base64',
  );
  const unsigned = Transaction.from(stored);
  const creates = unsigned.instructions.filter(instruction => (
    instruction.programId.equals(new PublicKey(PROGRAM_ID))
    && Buffer.from(instruction.data).subarray(0, IX.createMatchEscrow.length).equals(IX.createMatchEscrow)
  ));
  assert.equal(creates.length, 1);
  const configAccount = creates[0]!.keys[1]!.pubkey;
  unsigned.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
  unsigned.add(new TransactionInstruction({
    programId: lighthouse,
    keys: [{ pubkey: configAccount, isSigner: false, isWritable: true }],
    data: Buffer.from([4]),
  }));
  unsigned.sign(issued.player);
  const accepted = await issued.economy.confirmIntent({
    intentId: issued.intentId,
    signature: encodeBase58(unsigned.signature!),
    signedTransaction: [...unsigned.serialize()],
  });
  assert.equal(accepted.status, 'confirmed');
  assert.equal(issued.calls.sent, 1);

  const rejected = await issuedIntent();
  const original = Transaction.from(Buffer.from(
    (await rejected.chainStore.getIntent(rejected.intentId))!.metadata.serializedTx as string,
    'base64',
  ));
  original.instructions[0]!.data = Buffer.from([1, 2, 3, 4]);
  original.sign(rejected.player);
  const failed = await rejected.economy.confirmIntent({
    intentId: rejected.intentId,
    signature: encodeBase58(original.signature!),
    signedTransaction: [...original.serialize()],
  });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /First difference: instruction 0 data/);
  assert.equal(rejected.calls.sent, 0);
});
