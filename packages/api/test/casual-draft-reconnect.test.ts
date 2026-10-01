/**
 * Casual draft reconnect. A dropped socket keeps the room, preset pair, and
 * private selection until the disconnect grace expires.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { ChainIntentRow, ChainIntentStatus, CreateIntentInput, PostgresChainStore } from '@pokearena/db';
import {
  IX,
  configPda,
  depositSolWagerIx,
  feeVaultPda,
  refundSolWagerIx,
  uuidToBytes,
  type ArenaChainClient,
} from '@pokearena/solana-client';

import { CasualRoomService } from '../src/casual-service';
import { ChainEconomyService } from '../src/chain-economy';
import { InMemoryEconomicsStore } from '../src/memory-economics-store';
import { ApiServer } from '../src/server';
import { encodeBase58 } from '../src/wallet-auth';

const START = 10_000_000_000n;
const COLLATERAL = 1_000_000_000n;
const RENT = 890_880n;
const FEE = (COLLATERAL * 2n * 200n) / 10_000n;

class TestClient {
  readonly socket: WebSocket;
  private readonly messages: any[] = [];
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
    this.socket.send(JSON.stringify({ requestId: randomUUID(), ...message }));
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

async function identify(client: TestClient, playerId: 'demo-player-1' | 'demo-player-2'): Promise<void> {
  client.send({ type: 'identify', playerId });
  await client.waitFor(message => message.type === 'ready' && message.playerId === playerId);
}

async function authenticate(client: TestClient, keypair: ReturnType<typeof createSolanaKeypair>): Promise<void> {
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

function previewFor(room: any, playerId: string) {
  return room.teamPreview?.find((preview: any) => preview.playerId === playerId);
}

async function openCasualDraft(port: number) {
  const creator = new TestClient(port);
  const opponent = new TestClient(port);
  await Promise.all([creator.open(), opponent.open()]);
  await identify(creator, 'demo-player-1');
  await identify(opponent, 'demo-player-2');
  creator.send({
    type: 'casual.create',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 1_000,
  });
  const created = await creator.waitFor<any>(message => message.type === 'casual.created');
  opponent.send({ type: 'casual.accept', roomId: created.room.id });
  await opponent.waitFor(message => message.type === 'casual.state' && message.room.status === 'full');
  creator.send({ type: 'casual.ready', roomId: created.room.id, ready: true });
  opponent.send({ type: 'casual.ready', roomId: created.room.id, ready: true });
  const drafted = await creator.waitFor<any>(message => (
    message.type === 'casual.state' && message.room.status === 'drafting' && message.room.teamPreview?.length === 2
  ));
  creator.send({
    type: 'casual.select',
    roomId: created.room.id,
    slots: [0, 2],
    confirm: false,
  });
  const selected = await creator.waitFor<any>(message => {
    const yours = previewFor(message.room ?? {}, 'demo-player-1');
    return message.type === 'casual.state'
      && message.room.id === created.room.id
      && yours?.selectedSlots?.join(',') === '0,2'
      && yours.confirmed === false;
  });
  return { creator, opponent, room: selected.room, drafted: drafted.room };
}

test('a drafting disconnect keeps the room until the grace period ends', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0, disconnectGraceMs: 400 });
  const port = await server.listen(0);
  const { creator, opponent, room } = await openCasualDraft(port);
  try {
    const before = server.casual.getRoom(room.id, 'demo-player-1');
    await creator.close();
    await new Promise(resolve => setTimeout(resolve, 40));
    const during = server.casual.getRoom(room.id, 'demo-player-1');
    assert.equal(during.status, 'drafting');
    assert.equal(previewFor(during, 'demo-player-1').presetId, previewFor(before, 'demo-player-1').presetId);
    assert.deepEqual(previewFor(during, 'demo-player-1').selectedSlots, [0, 2]);
    assert.equal(previewFor(during, 'demo-player-1').confirmed, false);
    assert.equal(await server.economics.getBalance('demo-player-1'), 10_000_000 - 1_000);
    const cancelled = await opponent.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.id === room.id && message.room.status === 'cancelled'
    ), 2_000);
    assert.equal(cancelled.room.status, 'cancelled');
    assert.equal(cancelled.room.winnerId, undefined);
    assert.equal(await server.economics.getBalance('demo-player-1'), 10_000_000);
    assert.equal(await server.economics.getBalance('demo-player-2'), 10_000_000);
  } finally {
    await opponent.close();
    await server.close();
  }
});

test('reconnecting during the draft restores the same presets and private selection', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0, disconnectGraceMs: 400 });
  const port = await server.listen(0);
  const { creator, opponent, room } = await openCasualDraft(port);
  let returned: TestClient | undefined;
  try {
    const before = server.casual.getRoom(room.id, 'demo-player-1');
    const creatorPreset = previewFor(before, 'demo-player-1').presetId;
    const opponentPreset = previewFor(before, 'demo-player-2').presetId;
    assert.equal(creatorPreset, opponentPreset);
    assert.deepEqual(
      previewFor(before, 'demo-player-1').pokemon.map((mon: { species: string }) => mon.species),
      previewFor(before, 'demo-player-2').pokemon.map((mon: { species: string }) => mon.species),
    );
    const opponentView = server.casual.getRoom(room.id, 'demo-player-2');
    assert.equal(previewFor(opponentView, 'demo-player-1').selectedSlots, undefined);
    assert.equal(previewFor(opponentView, 'demo-player-2').pokemon.length, 6);

    await creator.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(server.casual.getRoom(room.id).status, 'drafting');

    returned = new TestClient(port);
    await returned.open();
    await identify(returned, 'demo-player-1');
    const restored = await returned.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.id === room.id && message.room.status === 'drafting'
    ));
    const yours = previewFor(restored.room, 'demo-player-1');
    const rival = previewFor(restored.room, 'demo-player-2');
    assert.equal(yours.presetId, creatorPreset);
    assert.equal(rival.presetId, opponentPreset);
    assert.deepEqual(yours.selectedSlots, [0, 2]);
    assert.equal(yours.confirmed, false);
    assert.equal(rival.selectedSlots, undefined);
    assert.equal(rival.confirmed, false);
    assert.equal(restored.room.creatorId, 'demo-player-1');
    assert.equal(restored.room.opponentId, 'demo-player-2');

    returned.send({ type: 'casual.subscribe', roomId: room.id });
    const subscribed = await returned.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.id === room.id && message.requestId
    ));
    assert.deepEqual(previewFor(subscribed.room, 'demo-player-1').selectedSlots, [0, 2]);
    assert.equal(previewFor(subscribed.room, 'demo-player-2').selectedSlots, undefined);

    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(server.casual.getRoom(room.id).status, 'drafting');
    assert.equal(server.casual.getRoom(room.id, 'demo-player-1').teamPreview?.[0]?.presetId, creatorPreset);
  } finally {
    await returned?.close();
    await opponent.close();
    await server.close();
  }
});

test('an old socket cannot cancel a draft after the player has reconnected', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0, disconnectGraceMs: 80 });
  const port = await server.listen(0);
  const { creator, opponent, room } = await openCasualDraft(port);
  try {
    const second = new TestClient(port);
    await second.open();
    await identify(second, 'demo-player-1');
    const replaced = await creator.waitFor<any>(message => message.type === 'error' && message.code === 'SessionReplacedError');
    assert.equal(replaced.code, 'SessionReplacedError');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(server.casual.getRoom(room.id).status, 'drafting');
    assert.equal(await server.economics.getBalance('demo-player-1'), 10_000_000 - 1_000);
    await second.close();
  } finally {
    await creator.close();
    await opponent.close();
    await server.close();
  }
});

test('a reconnected player can finish the draft and start the battle', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0, disconnectGraceMs: 400 });
  const port = await server.listen(0);
  const { creator, opponent, room } = await openCasualDraft(port);
  try {
    const preset = previewFor(server.casual.getRoom(room.id, 'demo-player-1'), 'demo-player-1').presetId;
    await creator.close();
    const returned = new TestClient(port);
    await returned.open();
    await identify(returned, 'demo-player-1');
    await returned.waitFor(message => message.type === 'casual.state' && message.room.id === room.id);
    returned.send({ type: 'casual.select', roomId: room.id, slots: [0, 2, 4], confirm: true });
    opponent.send({ type: 'casual.select', roomId: room.id, slots: [1, 2, 3], confirm: true });
    await returned.waitFor(message => (
      message.type === 'casual.state'
      && message.room.teamPreview?.every((preview: any) => preview.confirmed)
    ));
    const locked = server.casual.getRoom(room.id, 'demo-player-2');
    assert.equal(locked.status, 'battling');
    assert.deepEqual(previewFor(locked, 'demo-player-1').selectedSlots, [0, 2, 4]);
    assert.equal(previewFor(locked, 'demo-player-1').presetId, preset);
    returned.send({ type: 'casual.start', roomId: room.id });
    const started = await returned.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status === 'battling'
    ));
    assert.equal(started.room.status, 'battling');
    assert.equal(started.room.battleInstanceId !== undefined, true);
    await returned.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(server.casual.getRoom(room.id).status, 'battling');
  } finally {
    await opponent.close();
    await server.close();
  }
});

class DraftLedger {
  feeVault = 0n;
  private readonly balances = new Map<string, bigint>();
  private escrow?: {
    creator: PublicKey;
    opponent: PublicKey;
    creatorDeposited: boolean;
    opponentDeposited: boolean;
    feeCharged: boolean;
    status: number;
    vault: bigint;
  };
  private readonly replays = new Set<string>();

  constructor(
    readonly programId: PublicKey,
    readonly keeper: PublicKey,
    readonly feeVaultKey: PublicKey,
    readonly roomId: string,
  ) {}

  credit(owner: PublicKey): void {
    this.balances.set(owner.toBase58(), START);
  }

  balance(owner: PublicKey): bigint {
    return this.balances.get(owner.toBase58()) ?? 0n;
  }

  total(): bigint {
    let sum = this.feeVault + (this.escrow?.vault ?? 0n);
    for (const amount of this.balances.values()) sum += amount;
    return sum;
  }

  open(creator: PublicKey): void {
    this.debit(creator, RENT);
    this.escrow = {
      creator,
      opponent: PublicKey.default,
      creatorDeposited: false,
      opponentDeposited: false,
      feeCharged: false,
      status: 0,
      vault: RENT,
    };
  }

  view() {
    if (!this.escrow) throw new Error('Match escrow account was not found.');
    return {
      creator: this.escrow.creator,
      opponent: this.escrow.opponent,
      collateralLamports: COLLATERAL,
      creatorDeposited: this.escrow.creatorDeposited,
      opponentDeposited: this.escrow.opponentDeposited,
      feeCharged: this.escrow.feeCharged,
      status: this.escrow.status,
    };
  }

  state() {
    if (!this.escrow) throw new Error('Match escrow account was not found.');
    return this.escrow;
  }

  async submit(instructions: TransactionInstruction[]) {
    try {
      for (const instruction of instructions) this.apply(instruction);
      return { signature: `draft-${this.replays.size}`, status: 'confirmed' as const, slot: 1 };
    } catch (error) {
      return {
        signature: 'draft-failed',
        status: 'failed' as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  apply(instruction: TransactionInstruction): void {
    const data = Buffer.from(instruction.data);
    const disc = data.subarray(0, 8);
    const escrow = this.state();
    if (disc.equals(IX.depositSolWager)) {
      const depositor = instruction.keys[0]!.pubkey;
      const side = data[8];
      if (side === 0) {
        if (!depositor.equals(escrow.creator) || escrow.creatorDeposited) throw new Error('Unauthorized');
        this.debit(depositor, COLLATERAL);
        escrow.creatorDeposited = true;
      } else {
        if (escrow.opponent.equals(PublicKey.default) || !depositor.equals(escrow.opponent)) {
          throw new Error('Unauthorized');
        }
        this.debit(depositor, COLLATERAL);
        escrow.opponentDeposited = true;
      }
      escrow.vault += COLLATERAL;
      escrow.status = escrow.creatorDeposited && escrow.opponentDeposited ? 2 : 1;
      return;
    }
    if (disc.equals(IX.seatMatchOpponent)) {
      if (!instruction.keys[0]?.pubkey.equals(this.keeper)) throw new Error('Unauthorized');
      escrow.opponent = instruction.keys[2]!.pubkey;
      return;
    }
    if (disc.equals(IX.chargeMatchFee)) {
      if (!instruction.keys[0]?.pubkey.equals(this.keeper)) throw new Error('Unauthorized');
      if (escrow.status !== 2 || escrow.feeCharged) throw new Error('InvalidMatchStatus');
      escrow.vault -= FEE;
      this.feeVault += FEE;
      escrow.feeCharged = true;
      escrow.status = 3;
      return;
    }
    if (disc.equals(IX.settleMatchTie)) {
      if (!instruction.keys[0]?.pubkey.equals(this.keeper)) throw new Error('Unauthorized');
      const replay = instruction.keys[6]!.pubkey.toBase58();
      if (this.replays.has(replay)) throw new Error('Replay account already exists.');
      if (escrow.status !== 2 && escrow.status !== 3) throw new Error('InvalidMatchStatus');
      this.replays.add(replay);
      const payout = escrow.vault - RENT;
      const each = payout / 2n;
      escrow.vault = RENT;
      this.creditTo(instruction.keys[3]!.pubkey, each);
      this.creditTo(instruction.keys[4]!.pubkey, payout - each);
      escrow.status = 4;
      return;
    }
    if (disc.equals(IX.refundSolWager)) {
      if (!instruction.keys[0]?.pubkey.equals(this.keeper)) throw new Error('Unauthorized');
      throw new Error('InvalidMatchStatus');
    }
  }

  private debit(owner: PublicKey, amount: bigint): void {
    const next = this.balance(owner) - amount;
    if (next < 0n) throw new Error('Insufficient balance.');
    this.balances.set(owner.toBase58(), next);
  }

  private creditTo(owner: PublicKey, amount: bigint): void {
    this.balances.set(owner.toBase58(), this.balance(owner) + amount);
  }
}

class MemoryChainStore {
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

  async getIntentByScope(kind: ChainIntentRow['kind'], scopeId: string): Promise<ChainIntentRow | undefined> {
    return [...this.intents.values()].find(row => row.kind === kind && row.scopeId === scopeId);
  }

  async setIntentStatus(id: string, status: ChainIntentStatus): Promise<ChainIntentRow> {
    const row = this.intents.get(id);
    if (!row) throw new Error(`Unknown chain intent: ${id}`);
    if (row.status === 'confirmed' || row.status === 'expired' || row.status === 'cancelled') return row;
    if (row.status === 'failed' && status !== 'confirmed') return row;
    row.status = status;
    return row;
  }
}

async function confirmDeposits(store: MemoryChainStore, roomId: string, creatorId: string, opponentId: string) {
  for (const [scope, playerId] of [['creator', creatorId], ['opponent', opponentId]] as const) {
    const intent = await store.createIntent({
      kind: 'sol_wager_deposit',
      scopeId: `${roomId}:${scope}`,
      playerId,
      asset: 'SOL',
      amount: Number(COLLATERAL),
      idempotencyKey: `sol_wager_deposit:${roomId}:${scope}`,
      roomId,
    });
    await store.setIntentStatus(intent.id, 'confirmed');
  }
}

async function fundedSolDraft() {
  const keeper = Keypair.generate();
  const creatorWallet = createSolanaKeypair();
  const opponentWallet = createSolanaKeypair();
  const creator = new PublicKey(creatorWallet.address);
  const opponent = new PublicKey(opponentWallet.address);
  const programId = Keypair.generate().publicKey;
  const economics = new InMemoryEconomicsStore();
  const chainStore = new MemoryChainStore();
  const economyHolder: { ledger?: DraftLedger; economy?: ChainEconomyService } = {};
  const casual = new CasualRoomService({
    economics,
    countdownMs: 0,
    chainSettlement: {
      settle: input => economyHolder.economy!.settleCasual(input),
      refund: (roomId, creatorId, opponentId) => economyHolder.economy!.refundCasual(roomId, creatorId, opponentId),
    },
  });
  const room = await casual.createRoom({
    creatorId: creator.toBase58(),
    roomType: 'open',
    battleSize: '1v1',
    collateral: Number(COLLATERAL),
    rail: 'sol_chain',
  });
  const ledger = new DraftLedger(programId, keeper.publicKey, feeVaultPda(programId)[0], room.id);
  ledger.credit(creator);
  ledger.credit(opponent);
  ledger.open(creator);
  const economy = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'localnet',
      POKEARENA_PROGRAM_ID: programId.toBase58(),
      POKEARENA_POKE_MINT: Keypair.generate().publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
    },
    chainStore: chainStore as unknown as PostgresChainStore,
    client: {
      configAddress: configPda(programId)[0],
      getMatchEscrowState: () => ledger.view(),
    } as unknown as ArenaChainClient,
    keeper,
    submitKeeper: instructions => ledger.submit(instructions),
  });
  economyHolder.economy = economy;
  ledger.apply(depositSolWagerIx({
    programId,
    depositor: creator,
    roomId: uuidToBytes(room.id),
    side: 0,
  }));
  await economy.seatMatchOpponent({ roomId: room.id, opponentId: opponent.toBase58() });
  ledger.apply(depositSolWagerIx({
    programId,
    depositor: opponent,
    roomId: uuidToBytes(room.id),
    side: 1,
  }));
  await casual.acceptRoom(room.id, opponent.toBase58());
  casual.setReady(room.id, creator.toBase58(), true);
  casual.setReady(room.id, opponent.toBase58(), true);
  casual.selectTeam(room.id, creator.toBase58(), [0, 2], false);
  await confirmDeposits(chainStore, room.id, creator.toBase58(), opponent.toBase58());
  const server = new ApiServer({
    allowDemoAuth: false,
    devFaucet: false,
    countdownMs: 0,
    disconnectGraceMs: 80,
    economics,
    casual,
    chainEconomy: economy,
  });
  return {
    server,
    ledger,
    creator,
    opponent,
    creatorWallet,
    opponentWallet,
    room,
    opened: ledger.total(),
    programId,
  };
}

test('a SOL draft survives reconnect and can still start', async () => {
  const { server, ledger, creator, opponent, creatorWallet, opponentWallet, room } = await fundedSolDraft();
  const port = await server.listen(0);
  const left = new TestClient(port);
  const right = new TestClient(port);
  try {
    await Promise.all([left.open(), right.open()]);
    await authenticate(left, creatorWallet);
    await authenticate(right, opponentWallet);
    const preset = previewFor(server.casual.getRoom(room.id, creator.toBase58()), creator.toBase58()).presetId;
    await left.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(server.casual.getRoom(room.id).status, 'drafting');
    assert.equal(ledger.state().status, 2);
    const returned = new TestClient(port);
    await returned.open();
    await authenticate(returned, creatorWallet);
    const restored = await returned.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.id === room.id && message.room.status === 'drafting'
    ));
    assert.equal(previewFor(restored.room, creator.toBase58()).presetId, preset);
    assert.deepEqual(previewFor(restored.room, creator.toBase58()).selectedSlots, [0, 2]);
    assert.equal(previewFor(restored.room, opponent.toBase58()).selectedSlots, undefined);
    returned.send({ type: 'casual.select', roomId: room.id, slots: [0, 2, 4], confirm: true });
    right.send({ type: 'casual.select', roomId: room.id, slots: [0, 1, 2], confirm: true });
    await returned.waitFor(message => (
      message.type === 'casual.state' && message.room.teamPreview?.every((preview: any) => preview.confirmed)
    ));
    returned.send({ type: 'casual.start', roomId: room.id });
    const started = await returned.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.status === 'battling'
    ));
    assert.equal(started.room.status, 'battling');
    assert.equal(ledger.state().status, 3);
    assert.equal(ledger.state().feeCharged, true);
    assert.equal(ledger.feeVault, FEE);
    await returned.close();
  } finally {
    await right.close();
    await server.close();
  }
});

test('an abandoned SOL draft tie-settles after the grace period', async () => {
  const { server, ledger, creator, opponent, creatorWallet, opponentWallet, room, opened, programId } = await fundedSolDraft();
  const port = await server.listen(0);
  const left = new TestClient(port);
  const right = new TestClient(port);
  try {
    await Promise.all([left.open(), right.open()]);
    await authenticate(left, creatorWallet);
    await authenticate(right, opponentWallet);
    right.send({ type: 'casual.subscribe', roomId: room.id });
    await right.waitFor(message => message.type === 'casual.state' && message.room.id === room.id);
    await left.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ledger.state().status, 2);
    assert.equal(server.casual.getRoom(room.id).status, 'drafting');
    const cancelled = await right.waitFor<any>(message => (
      message.type === 'casual.state' && message.room.id === room.id && message.room.status === 'cancelled'
    ), 2_000);
    assert.equal(cancelled.room.winnerId, undefined);
    assert.equal(ledger.state().status, 4);
    assert.equal(ledger.state().feeCharged, false);
    assert.equal(ledger.state().vault, RENT);
    assert.equal(ledger.feeVault, 0n);
    assert.equal(ledger.balance(creator), START - RENT);
    assert.equal(ledger.balance(opponent), START);
    assert.equal((await server.economics.getCasualRoom(room.id))?.status, 'cancelled');
    assert.equal(ledger.total(), opened);
    assert.throws(() => ledger.apply(refundSolWagerIx({
      programId,
      authority: creator,
      config: configPda(programId)[0],
      recipient: creator,
      roomId: uuidToBytes(room.id),
      side: 0,
    })), /InvalidMatchStatus|Unauthorized/);
  } finally {
    await right.close();
    await server.close();
  }
});
