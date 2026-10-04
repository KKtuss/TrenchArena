/**
 * SOL wager cancellation, opponent binding, and restart recovery.
 * The ledger applies the same instruction builders the API sends and enforces
 * the escrow rules that keep a funded vault from being stranded or double-paid.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import type { BattleEngine } from '@pokearena/battle-engine';
import {
  InMemoryTournamentStore,
  recoverDurableState,
  type ChainIntentRow,
  type ChainIntentStatus,
  type CreateIntentInput,
  type PostgresChainStore,
} from '@pokearena/db';
import {
  IX,
  configPda,
  depositSolWagerIx,
  feeVaultPda,
  matchEscrowPda,
  matchVaultPda,
  refundSolWagerIx,
  settleMatchTieIx,
  uuidToBytes,
  type ArenaChainClient,
  type SentTransaction,
} from '@pokearena/solana-client';

import { CasualRoomService } from '../src/casual-service';
import { ChainEconomyService } from '../src/chain-economy';
import { InMemoryEconomicsStore } from '../src/memory-economics-store';
import { bothConfirmCasual } from './casual-flow';

const START = 10_000_000_000n;
const COLLATERAL = 1_000_000_000n;
const RENT = 890_880n;
const FEE = (COLLATERAL * 2n * 200n) / 10_000n;

test('pending SOL rooms stay hidden until a landed creator deposit', async () => {
  const economics = new InMemoryEconomicsStore();
  const creator = Keypair.generate().publicKey.toBase58();
  const casual = new CasualRoomService({ economics });
  const room = await casual.createRoom({
    creatorId: creator,
    roomType: 'open',
    battleSize: '1v1',
    collateral: Number(COLLATERAL),
    rail: 'sol_chain',
  });

  assert.equal(casual.listOpenRooms('opponent').some(item => item.id === room.id), false);
  casual.markSolDeposit(room.id, 'creator');
  assert.equal(casual.listOpenRooms('opponent').some(item => item.id === room.id), true);
  const durable = await economics.getCasualRoom(room.id);
  assert.ok(durable);

  const restored = new CasualRoomService({ economics });
  restored.restoreRoom(durable, { creator: true });
  const restoredRoom = restored.listOpenRooms('opponent').find(item => item.id === room.id);
  assert.equal(restoredRoom?.status, 'open');
  assert.equal(restoredRoom?.deposits?.creator, true);
});

interface Escrow {
  creator: PublicKey;
  opponent: PublicKey;
  collateral: bigint;
  creatorDeposited: boolean;
  opponentDeposited: boolean;
  feeCharged: boolean;
  status: number;
  vault: bigint;
  settlementKey?: Buffer;
}

class SolLedger {
  readonly replays = new Set<string>();
  readonly applied: string[] = [];
  feeVault = 0n;
  failNext = false;
  private readonly balances = new Map<string, bigint>();
  private readonly byEscrow = new Map<string, Escrow>();
  private signature = 0;

  constructor(
    readonly programId: PublicKey,
    readonly keeper: PublicKey,
    readonly feeVaultKey: PublicKey,
  ) {}

  credit(owner: PublicKey, amount = START): void {
    this.balances.set(owner.toBase58(), amount);
  }

  balance(owner: PublicKey): bigint {
    return this.balances.get(owner.toBase58()) ?? 0n;
  }

  total(): bigint {
    let sum = this.feeVault;
    for (const amount of this.balances.values()) sum += amount;
    for (const escrow of this.byEscrow.values()) sum += escrow.vault;
    return sum;
  }

  open(roomId: string, creator: PublicKey): void {
    const bytes = uuidToBytes(roomId);
    const [escrow] = matchEscrowPda(this.programId, bytes);
    if (this.byEscrow.has(escrow.toBase58())) throw new Error('Escrow already exists.');
    this.debit(creator, RENT);
    this.byEscrow.set(escrow.toBase58(), {
      creator,
      opponent: PublicKey.default,
      collateral: COLLATERAL,
      creatorDeposited: false,
      opponentDeposited: false,
      feeCharged: false,
      status: 0,
      vault: RENT,
    });
  }

  view(roomId: Uint8Array) {
    const escrow = this.require(roomId);
    return {
      creator: escrow.creator,
      opponent: escrow.opponent,
      collateralLamports: escrow.collateral,
      creatorDeposited: escrow.creatorDeposited,
      opponentDeposited: escrow.opponentDeposited,
      feeCharged: escrow.feeCharged,
      status: escrow.status,
    };
  }

  escrow(roomId: string): Escrow {
    return this.require(uuidToBytes(roomId));
  }

  async submit(instructions: TransactionInstruction[]): Promise<SentTransaction> {
    this.signature += 1;
    const signature = `sol-test-${this.signature}`;
    if (this.failNext) {
      this.failNext = false;
      return { signature, status: 'failed', error: 'Simulated keeper transaction failure.' };
    }
    try {
      for (const instruction of instructions) this.apply(instruction);
      return { signature, status: 'confirmed', slot: this.signature };
    } catch (error) {
      return {
        signature,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  apply(instruction: TransactionInstruction): void {
    const data = Buffer.from(instruction.data);
    const disc = data.subarray(0, 8);
    if (disc.equals(IX.depositSolWager)) this.deposit(instruction, data[8] ?? 255);
    else if (disc.equals(IX.seatMatchOpponent)) this.seat(instruction);
    else if (disc.equals(IX.refundSolWager)) this.refund(instruction, data[8] ?? 255);
    else if (disc.equals(IX.chargeMatchFee)) this.chargeFee(instruction);
    else if (disc.equals(IX.settleMatchTie)) this.settleTie(instruction, data.subarray(8, 40));
    else if (disc.equals(IX.settleMatchWin)) this.settleWin(instruction, data.subarray(8, 40));
    else throw new Error('Unexpected instruction in SOL wager test.');
  }

  private deposit(instruction: TransactionInstruction, side: number): void {
    const depositor = instruction.keys[0]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[1]?.pubkey);
    if (!depositor) throw new Error('Missing depositor.');
    if (escrow.status !== 0 && escrow.status !== 1) throw new Error('InvalidMatchStatus');
    if (side === 0) {
      if (!depositor.equals(escrow.creator)) throw new Error('Unauthorized');
      if (escrow.creatorDeposited) throw new Error('AlreadyDeposited');
      this.debit(depositor, escrow.collateral);
      escrow.creatorDeposited = true;
    } else if (side === 1) {
      if (escrow.opponent.equals(PublicKey.default) || !depositor.equals(escrow.opponent)) {
        throw new Error('Unauthorized');
      }
      if (escrow.opponentDeposited) throw new Error('AlreadyDeposited');
      this.debit(depositor, escrow.collateral);
      escrow.opponentDeposited = true;
    } else {
      throw new Error('InvalidSide');
    }
    escrow.vault += escrow.collateral;
    escrow.status = escrow.creatorDeposited && escrow.opponentDeposited ? 2 : 1;
    this.applied.push('deposit_sol_wager');
  }

  private seat(instruction: TransactionInstruction): void {
    const authority = instruction.keys[0]?.pubkey;
    const opponent = instruction.keys[2]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[3]?.pubkey);
    this.requireKeeper(authority);
    if (!opponent) throw new Error('Missing opponent.');
    if (escrow.status !== 0 && escrow.status !== 1) throw new Error('InvalidMatchStatus');
    if (escrow.opponentDeposited) throw new Error('AlreadyDeposited');
    if (opponent.equals(PublicKey.default) || opponent.equals(escrow.creator)) {
      throw new Error('Unauthorized');
    }
    if (!escrow.opponent.equals(PublicKey.default) && !escrow.opponent.equals(opponent)) {
      throw new Error('Unauthorized');
    }
    escrow.opponent = opponent;
    this.applied.push('seat_match_opponent');
  }

  private refund(instruction: TransactionInstruction, side: number): void {
    const authority = instruction.keys[0]?.pubkey;
    const recipient = instruction.keys[2]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[3]?.pubkey);
    this.requireKeeper(authority);
    if (!recipient) throw new Error('Missing recipient.');
    if (escrow.status !== 0 && escrow.status !== 1 && escrow.status !== 5) {
      throw new Error('InvalidMatchStatus');
    }
    if (escrow.feeCharged) throw new Error('FeeAlreadyCharged');
    const expected = side === 0 ? escrow.creator : side === 1 ? escrow.opponent : undefined;
    const deposited = side === 0 ? escrow.creatorDeposited : side === 1 ? escrow.opponentDeposited : false;
    if (!expected || !deposited) throw new Error('NotDeposited');
    if (!recipient.equals(expected)) throw new Error('Unauthorized');
    if (escrow.vault < escrow.collateral) throw new Error('Insufficient vault.');
    escrow.vault -= escrow.collateral;
    this.creditTo(recipient, escrow.collateral);
    if (side === 0) escrow.creatorDeposited = false;
    else escrow.opponentDeposited = false;
    escrow.status = 5;
    this.applied.push('refund_sol_wager');
  }

  private chargeFee(instruction: TransactionInstruction): void {
    const authority = instruction.keys[0]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[2]?.pubkey);
    const feeVault = instruction.keys[4]?.pubkey;
    this.requireKeeper(authority);
    if (!feeVault?.equals(this.feeVaultKey)) throw new Error('Unauthorized');
    if (escrow.status !== 2) throw new Error('InvalidMatchStatus');
    if (escrow.feeCharged) throw new Error('FeeAlreadyCharged');
    if (escrow.vault < FEE) throw new Error('Insufficient vault.');
    escrow.vault -= FEE;
    this.feeVault += FEE;
    escrow.feeCharged = true;
    escrow.status = 3;
    this.applied.push('charge_match_fee');
  }

  private settleTie(instruction: TransactionInstruction, settlementKey: Buffer): void {
    const authority = instruction.keys[0]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[2]?.pubkey);
    const creator = instruction.keys[3]?.pubkey;
    const opponent = instruction.keys[4]?.pubkey;
    const replay = instruction.keys[6]?.pubkey;
    this.requireKeeper(authority);
    if (!creator?.equals(escrow.creator) || !opponent?.equals(escrow.opponent)) {
      throw new Error('Unauthorized');
    }
    this.consumeReplay(replay, settlementKey);
    if (escrow.status !== 2 && escrow.status !== 3) throw new Error('InvalidMatchStatus');
    const payout = escrow.vault - RENT;
    const each = payout / 2n;
    const rem = payout - each * 2n;
    escrow.vault = RENT;
    this.creditTo(creator, each);
    this.creditTo(opponent, each + rem);
    escrow.status = 4;
    escrow.settlementKey = Buffer.from(settlementKey);
    this.applied.push('settle_match_tie');
  }

  private settleWin(instruction: TransactionInstruction, settlementKey: Buffer): void {
    const authority = instruction.keys[0]?.pubkey;
    const winner = instruction.keys[2]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[3]?.pubkey);
    const replay = instruction.keys[5]?.pubkey;
    this.requireKeeper(authority);
    if (!winner || (!winner.equals(escrow.creator) && !winner.equals(escrow.opponent))) {
      throw new Error('Unauthorized');
    }
    this.consumeReplay(replay, settlementKey);
    if (escrow.status !== 3 || !escrow.feeCharged) throw new Error('InvalidMatchStatus');
    const payout = escrow.vault - RENT;
    escrow.vault = RENT;
    this.creditTo(winner, payout);
    escrow.status = 4;
    escrow.settlementKey = Buffer.from(settlementKey);
    this.applied.push('settle_match_win');
  }

  private consumeReplay(replay: PublicKey | undefined, settlementKey: Buffer): void {
    if (!replay || settlementKey.length !== 32) throw new Error('Invalid settlement key.');
    if (this.replays.has(replay.toBase58())) throw new Error('Replay account already exists.');
    this.replays.add(replay.toBase58());
  }

  private requireKeeper(authority: PublicKey | undefined): void {
    if (!authority?.equals(this.keeper)) throw new Error('Unauthorized');
  }

  private escrowAccount(address: PublicKey | undefined): Escrow {
    const escrow = address ? this.byEscrow.get(address.toBase58()) : undefined;
    if (!escrow) throw new Error('Match escrow account was not found.');
    return escrow;
  }

  private require(roomId: Uint8Array): Escrow {
    const [address] = matchEscrowPda(this.programId, Buffer.from(roomId));
    return this.escrowAccount(address);
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

  async getIntent(id: string): Promise<ChainIntentRow | undefined> {
    const row = this.intents.get(id);
    return row ? { ...row } : undefined;
  }

  async getIntentByScope(kind: ChainIntentRow['kind'], scopeId: string): Promise<ChainIntentRow | undefined> {
    const row = [...this.intents.values()].find(item => item.kind === kind && item.scopeId === scopeId);
    return row ? { ...row } : undefined;
  }

  async mergeIntentMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<ChainIntentRow> {
    const row = this.intents.get(id);
    if (!row) throw new Error(`Unknown chain intent: ${id}`);
    row.metadata = { ...row.metadata, ...patch };
    return { ...row, metadata: { ...row.metadata } };
  }

  async setIntentStatus(
    id: string,
    status: ChainIntentStatus,
  ): Promise<ChainIntentRow> {
    const row = this.intents.get(id);
    if (!row) throw new Error(`Unknown chain intent: ${id}`);
    const retryable = status === 'confirmed' || status === 'pending';
    if (
      row.status === 'confirmed'
      || row.status === 'cancelled'
      || ((row.status === 'failed' || row.status === 'expired') && !retryable)
    ) {
      return { ...row };
    }
    row.status = status;
    return { ...row };
  }
}

function harness(options: {
  readMatchEscrowState?: (roomId: Uint8Array, ledger: SolLedger) => ReturnType<SolLedger['view']>;
  settledReadLags?: boolean;
  laggingConfirmedReads?: boolean;
} = {}) {
  const keeper = Keypair.generate();
  const creator = Keypair.generate();
  const opponent = Keypair.generate();
  const mallory = Keypair.generate();
  const programId = Keypair.generate().publicKey;
  const ledger = new SolLedger(programId, keeper.publicKey, feeVaultPda(programId)[0]);
  ledger.credit(creator.publicKey);
  ledger.credit(opponent.publicKey);
  ledger.credit(mallory.publicKey);
  const chainStore = new MemoryChainStore();
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
      getMatchEscrowState: (roomId: Uint8Array) => (
        options.readMatchEscrowState?.(roomId, ledger) ?? ledger.view(roomId)
      ),
      ...(options.laggingConfirmedReads
        ? {
          waitForMatchEscrowState: async (
            _roomId: Uint8Array,
            _predicate: (state: ReturnType<SolLedger['view']>) => boolean,
            waitOptions?: { commitment?: string },
          ) => {
            if (waitOptions?.commitment !== 'confirmed') {
              throw new Error('Match escrow state did not reach the expected state.');
            }
            throw new Error('Match escrow state did not reach the expected state.');
          },
        }
        : {}),
      ...(options.settledReadLags
        ? {
          waitForMatchEscrowState: async (
            roomId: Uint8Array,
            predicate: (state: ReturnType<SolLedger['view']>) => boolean,
          ) => {
            const view = options.readMatchEscrowState?.(roomId, ledger) ?? ledger.view(roomId);
            const settled = predicate({ ...view, status: 4 });
            const unsettled = predicate({ ...view, status: view.status === 4 ? 3 : view.status });
            if (settled && !unsettled) {
              throw new Error('Match escrow state did not reach the expected state.');
            }
            if (predicate(view)) return view;
            throw new Error('Match escrow state did not reach the expected state.');
          },
        }
        : {}),
      buildTransaction: async (payer: PublicKey, instructions: TransactionInstruction[]) => {
        const tx = new Transaction();
        tx.feePayer = payer;
        tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
        tx.add(...instructions);
        return tx;
      },
    } as unknown as ArenaChainClient,
    keeper,
    submitKeeper: instructions => ledger.submit(instructions),
  });
  const economics = new InMemoryEconomicsStore();
  const opened = ledger.total();
  return { keeper, creator, opponent, mallory, programId, ledger, chainStore, economy, economics, opened };
}

test('reuses an existing escrow instead of recreating it for a SOL deposit retry', async () => {
  const { ledger, economy, chainStore, programId, creator } = harness();
  const roomId = randomUUID();
  ledger.open(roomId, creator.publicKey);

  const first = await economy.createSolWagerDepositIntent({
    roomId,
    playerId: creator.publicKey.toBase58(),
    side: 0,
    collateralLamports: Number(COLLATERAL),
  });
  const transaction = Transaction.from(Uint8Array.from(first.serializedTx));
  assert.equal(transaction.instructions.length, 1);
  assert.equal(
    Buffer.from(transaction.instructions[0]!.data).subarray(0, 8).equals(IX.depositSolWager),
    true,
  );
  ledger.apply(transaction.instructions[0]!);

  const retry = await economy.createSolWagerDepositIntent({
    roomId,
    playerId: creator.publicKey.toBase58(),
    side: 0,
    collateralLamports: Number(COLLATERAL),
  });
  assert.deepEqual(retry.serializedTx, []);
  assert.equal(
    (await chainStore.getIntentByScope('sol_wager_deposit', `${roomId}:creator`))?.status,
    'confirmed',
  );
});

async function persistRoom(
  economics: InMemoryEconomicsStore,
  roomId: string,
  creatorId: string,
  status: 'pending_deposit' | 'full' | 'starting' | 'battling' = 'pending_deposit',
  opponentId?: string,
) {
  await economics.createCasualRoomWithHold({
    id: roomId,
    matchId: `casual-${roomId}`,
    roomType: 'open',
    battleSize: '1v1',
    creatorId,
    collateral: Number(COLLATERAL),
    rail: 'sol_chain',
    collateralLamports: Number(COLLATERAL),
  });
  if (opponentId) {
    await economics.acceptCasualRoomWithHold({
      roomId,
      opponentId,
      collateral: Number(COLLATERAL),
    });
  }
  if (status !== 'full') {
    await economics.setCasualRoomStatus(roomId, status);
  }
}

async function confirmDeposits(chainStore: MemoryChainStore, roomId: string, creatorId: string, opponentId: string) {
  for (const [scope, playerId] of [['creator', creatorId], ['opponent', opponentId]] as const) {
    const intent = await chainStore.createIntent({
      kind: 'sol_wager_deposit',
      scopeId: `${roomId}:${scope}`,
      playerId,
      asset: 'SOL',
      amount: Number(COLLATERAL),
      idempotencyKey: `sol_wager_deposit:${roomId}:${scope}`,
      roomId,
    });
    await chainStore.setIntentStatus(intent.id, 'confirmed');
  }
}

function deposit(programId: PublicKey, depositor: PublicKey, roomId: string, side: 0 | 1) {
  return depositSolWagerIx({ programId, depositor, roomId: uuidToBytes(roomId), side });
}

test('open room cancellation returns no collateral and cancels the room', async () => {
  const { ledger, economy, economics, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  ledger.open(roomId, creator.publicKey);
  await persistRoom(economics, roomId, creator.publicKey.toBase58());
  await economy.refundCasual(roomId, creator.publicKey.toBase58());
  const escrow = ledger.escrow(roomId);
  assert.equal(escrow.status, 0);
  assert.equal(escrow.vault, RENT);
  assert.equal(ledger.balance(creator.publicKey), START - RENT);
  assert.equal(ledger.balance(opponent.publicKey), START);
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  const room = await economics.getCasualRoom(roomId);
  assert.equal(room?.status, 'cancelled');
  assert.equal(room?.winnerId, undefined);
  assert.equal(ledger.total(), opened);
});

test('one-sided funding cancellation refunds only the depositor', async () => {
  const { ledger, economy, economics, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await persistRoom(economics, roomId, creator.publicKey.toBase58());
  await economy.refundCasual(roomId, creator.publicKey.toBase58());
  const escrow = ledger.escrow(roomId);
  assert.equal(escrow.status, 5);
  assert.equal(escrow.creatorDeposited, false);
  assert.equal(escrow.vault, RENT);
  assert.equal(ledger.balance(creator.publicKey), START - RENT);
  assert.equal(ledger.balance(opponent.publicKey), START);
  assert.equal(ledger.feeVault, 0n);
  const room = await economics.getCasualRoom(roomId);
  await economy.recoverCasualRoom(room!, economics);
  assert.equal((await economics.getCasualRoom(roomId))?.status, 'cancelled');
  assert.equal(ledger.total(), opened);
});

test('refund waits through a stale escrow read before marking the intent confirmed', async () => {
  let reads = 0;
  const { ledger, economy, economics, programId, creator } = harness({
    readMatchEscrowState: (roomId, currentLedger) => {
      reads += 1;
      if (reads === 2) {
        const stale = currentLedger.view(roomId);
        return { ...stale, creatorDeposited: true, status: 1 };
      }
      return currentLedger.view(roomId);
    },
  });
  const roomId = randomUUID();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await persistRoom(economics, roomId, creator.publicKey.toBase58());

  await economy.refundCasual(roomId, creator.publicKey.toBase58());

  assert.equal(reads, 3);
  assert.equal(ledger.escrow(roomId).creatorDeposited, false);
  assert.equal(
    (await economics.getCasualRoom(roomId))?.status,
    'pending_deposit',
  );
});

test('both-sided funded cancellation tie-settles both stakes', async () => {
  const { ledger, economy, economics, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  assert.equal(ledger.escrow(roomId).status, 2);
  assert.throws(
    () => ledger.apply(refundSolWagerIx({
      programId,
      authority: creator.publicKey,
      config: configPda(programId)[0],
      recipient: creator.publicKey,
      roomId: uuidToBytes(roomId),
      side: 0,
    })),
    /Unauthorized|InvalidMatchStatus/,
  );
  assert.equal(ledger.escrow(roomId).status, 2);
  assert.equal(ledger.escrow(roomId).vault, RENT + COLLATERAL * 2n);
  await persistRoom(economics, roomId, creatorId, 'full', opponentId);
  await economy.refundCasual(roomId, creatorId, opponentId);
  const escrow = ledger.escrow(roomId);
  assert.equal(escrow.status, 4);
  assert.equal(escrow.feeCharged, false);
  assert.equal(escrow.vault, RENT);
  assert.equal(ledger.balance(creator.publicKey), START - RENT);
  assert.equal(ledger.balance(opponent.publicKey), START);
  assert.equal(ledger.feeVault, 0n);
  assert.ok(ledger.applied.includes('settle_match_tie'));
  assert.equal(ledger.applied.includes('refund_sol_wager'), false);
  assert.equal(escrow.settlementKey?.length, 32);
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  const room = await economics.getCasualRoom(roomId);
  assert.equal(room?.status, 'completed');
  assert.equal(room?.resultStatus, 'tie');
  assert.equal(room?.winnerId, undefined);
  assert.equal((await economics.getWallet(creatorId)).balance, 0);
  assert.equal(ledger.total(), opened);
});

test('wrong wallet cannot deposit the opponent side', async () => {
  const { ledger, economy, programId, creator, opponent, mallory, opened } = harness();
  const roomId = randomUUID();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  assert.throws(
    () => ledger.apply(deposit(programId, mallory.publicKey, roomId, 1)),
    /Unauthorized/,
  );
  assert.equal(ledger.escrow(roomId).opponent.equals(PublicKey.default), true);
  await economy.seatMatchOpponent({ roomId, opponentId: opponent.publicKey.toBase58() });
  await assert.rejects(
    () => economy.seatMatchOpponent({ roomId, opponentId: mallory.publicKey.toBase58() }),
    /different opponent/i,
  );
  const before = ledger.balance(mallory.publicKey);
  assert.throws(
    () => ledger.apply(deposit(programId, mallory.publicKey, roomId, 1)),
    /Unauthorized/,
  );
  const escrow = ledger.escrow(roomId);
  assert.equal(escrow.status, 1);
  assert.equal(escrow.opponentDeposited, false);
  assert.equal(escrow.opponent.toBase58(), opponent.publicKey.toBase58());
  assert.equal(ledger.balance(mallory.publicKey), before);
  assert.equal(escrow.vault, RENT + COLLATERAL);
  assert.equal(ledger.total(), opened);
});

test('seated opponent deposit funds the escrow', async () => {
  const { ledger, economy, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId: opponent.publicKey.toBase58() });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  const escrow = ledger.escrow(roomId);
  assert.equal(escrow.status, 2);
  assert.equal(escrow.creatorDeposited, true);
  assert.equal(escrow.opponentDeposited, true);
  assert.equal(escrow.opponent.toBase58(), opponent.publicKey.toBase58());
  assert.equal(ledger.balance(creator.publicKey), START - RENT - COLLATERAL);
  assert.equal(ledger.balance(opponent.publicKey), START - COLLATERAL);
  assert.equal(ledger.total(), opened);
});

test('duplicate refund does not pay twice, including a failed attempt', async () => {
  const { ledger, economy, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  const locked = ledger.balance(creator.publicKey);
  ledger.failNext = true;
  await assert.rejects(() => economy.refundCasual(roomId, creator.publicKey.toBase58()), /Simulated keeper/);
  assert.equal(ledger.escrow(roomId).status, 1);
  assert.equal(ledger.escrow(roomId).creatorDeposited, true);
  assert.equal(ledger.balance(creator.publicKey), locked);
  const failed = await chainStore.getIntentByScope('sol_wager_refund', `${roomId}:0`);
  assert.equal(failed?.status, 'failed');
  await economy.refundCasual(roomId, creator.publicKey.toBase58());
  assert.equal(ledger.balance(creator.publicKey), START - RENT);
  assert.equal((await chainStore.getIntentByScope('sol_wager_refund', `${roomId}:0`))?.status, 'confirmed');
  const after = ledger.balance(creator.publicKey);
  await economy.refundCasual(roomId, creator.publicKey.toBase58());
  assert.equal(ledger.balance(creator.publicKey), after);
  assert.equal(ledger.balance(opponent.publicKey), START);
  assert.equal(ledger.replays.size, 0);
  assert.equal(ledger.total(), opened);
});

test('duplicate tie settlement does not pay twice', async () => {
  const { ledger, economy, programId, keeper, creator, opponent, chainStore, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  const first = await economy.settleCasual({ roomId, creatorId, opponentId });
  const creatorAfter = ledger.balance(creator.publicKey);
  const opponentAfter = ledger.balance(opponent.publicKey);
  assert.equal(first.amount, Number(COLLATERAL));
  assert.equal(ledger.escrow(roomId).status, 4);
  assert.equal(ledger.replays.size, 1);
  const second = await economy.settleCasual({ roomId, creatorId, opponentId });
  assert.equal(second.settlementKey, first.settlementKey);
  assert.equal(ledger.balance(creator.publicKey), creatorAfter);
  assert.equal(ledger.balance(opponent.publicKey), opponentAfter);
  assert.equal(ledger.replays.size, 1);
  assert.equal((await chainStore.getIntentByScope('sol_match_tie', roomId))?.status, 'confirmed');
  ledger.escrow(roomId).status = 2;
  assert.throws(() => ledger.apply(settleMatchTieIx({
    programId,
    authority: keeper.publicKey,
    config: configPda(programId)[0],
    creator: creator.publicKey,
    opponent: opponent.publicKey,
    roomId: uuidToBytes(roomId),
    settlementKey: Buffer.from(ledger.escrow(roomId).settlementKey!),
  })), /Replay/);
  assert.equal(ledger.balance(creator.publicKey), creatorAfter);
  assert.equal(ledger.total(), opened);
});

test('battle initialization failure before the fee leaves the wager refundable', async () => {
  const { ledger, economy, economics, programId, creator, opponent, opened } = harness();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  const casual = new CasualRoomService({
    economics,
    countdownMs: 0,
    battleEngine: { createBattle: async () => { throw new Error('showdown failed before fee'); } } as unknown as BattleEngine,
    chainSettlement: {
      settle: input => economy.settleCasual(input),
      refund: (id, left, right) => economy.refundCasual(id, left, right),
    },
  });
  const room = await casual.createRoom({
    creatorId,
    roomType: 'open',
    battleSize: '1v1',
    collateral: Number(COLLATERAL),
    rail: 'sol_chain',
  });
  ledger.open(room.id, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, room.id, 0));
  casual.markSolDeposit(room.id, 'creator');
  await economy.seatMatchOpponent({ roomId: room.id, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, room.id, 1));
  await casual.acceptRoom(room.id, opponentId);
  casual.markSolDeposit(room.id, 'creator');
  casual.markSolDeposit(room.id, 'opponent');
  bothConfirmCasual(casual, room.id, creatorId, opponentId);
  await assert.rejects(() => casual.startBattle(room.id, creatorId), /showdown failed before fee/);
  const escrow = ledger.escrow(room.id);
  assert.equal(escrow.status, 4);
  assert.equal(escrow.feeCharged, false);
  assert.equal(escrow.vault, RENT);
  assert.equal(ledger.feeVault, 0n);
  assert.equal(ledger.balance(creator.publicKey), START - RENT);
  assert.equal(ledger.balance(opponent.publicKey), START);
  const stored = await economics.getCasualRoom(room.id);
  assert.equal(stored?.status, 'cancelled');
  assert.equal(stored?.winnerId, undefined);
  assert.equal(casual.getRoom(room.id).status, 'cancelled');
  assert.equal(ledger.total(), opened);
});

test('battle initialization failure after the fee tie-settles the remainder', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  const casual = new CasualRoomService({
    economics,
    countdownMs: 0,
    battleEngine: { createBattle: async () => { throw new Error('showdown failed after fee'); } } as unknown as BattleEngine,
    chainSettlement: {
      settle: input => economy.settleCasual(input),
      refund: (id, left, right) => economy.refundCasual(id, left, right),
    },
  });
  const room = await casual.createRoom({
    creatorId,
    roomType: 'open',
    battleSize: '1v1',
    collateral: Number(COLLATERAL),
    rail: 'sol_chain',
  });
  ledger.open(room.id, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, room.id, 0));
  casual.markSolDeposit(room.id, 'creator');
  await economy.seatMatchOpponent({ roomId: room.id, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, room.id, 1));
  await confirmDeposits(chainStore, room.id, creatorId, opponentId);
  await economy.prepareCasualStart(room.id);
  assert.equal(ledger.escrow(room.id).status, 3);
  assert.equal(ledger.feeVault, FEE);
  await casual.acceptRoom(room.id, opponentId);
  casual.markSolDeposit(room.id, 'creator');
  casual.markSolDeposit(room.id, 'opponent');
  bothConfirmCasual(casual, room.id, creatorId, opponentId);
  await assert.rejects(() => casual.startBattle(room.id, creatorId), /showdown failed after fee/);
  const escrow = ledger.escrow(room.id);
  assert.equal(escrow.status, 4);
  assert.equal(escrow.feeCharged, true);
  assert.equal(escrow.vault, RENT);
  assert.equal(ledger.feeVault, FEE);
  assert.equal(ledger.balance(creator.publicKey), START - RENT - FEE / 2n);
  assert.equal(ledger.balance(opponent.publicKey), START - FEE / 2n);
  assert.equal((await economics.getCasualRoom(room.id))?.status, 'cancelled');
  assert.equal((await economics.getCasualRoom(room.id))?.winnerId, undefined);
  assert.equal((await chainStore.getIntentByScope('sol_match_tie', room.id))?.status, 'confirmed');
  assert.equal(ledger.total(), opened);
});

test('process restart while funding preserves a landed one-sided deposit', async () => {
  const { ledger, economy, economics, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await persistRoom(economics, roomId, creatorId);
  const report = await recoverDurableState({
    economics,
    tournaments: new InMemoryTournamentStore(),
    recoverSolCasualRoom: room => economy.recoverCasualRoom(room, economics),
  });
  assert.equal(report.cancelledCasualRoomIds.includes(roomId), false);
  assert.equal(ledger.escrow(roomId).status, 1);
  assert.equal(ledger.escrow(roomId).creatorDeposited, true);
  assert.equal(ledger.balance(creator.publicKey), START - RENT - COLLATERAL);
  assert.equal(ledger.balance(opponent.publicKey), START);
  assert.equal((await economics.getCasualRoom(roomId))?.status, 'pending_deposit');
  assert.equal((await economics.getCasualRoom(roomId))?.winnerId, undefined);
  assert.equal(ledger.total(), opened);
});

test('process restart after both deposits does not invent a tie', async () => {
  const { ledger, economy, economics, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await persistRoom(economics, roomId, creatorId, 'full', opponentId);
  const creatorBefore = ledger.balance(creator.publicKey);
  const opponentBefore = ledger.balance(opponent.publicKey);
  const report = await recoverDurableState({
    economics,
    tournaments: new InMemoryTournamentStore(),
    recoverSolCasualRoom: room => economy.recoverCasualRoom(room, economics),
  });
  assert.equal(report.cancelledCasualRoomIds.includes(roomId), false);
  const room = await economics.getCasualRoom(roomId);
  assert.equal(ledger.escrow(roomId).status, 2);
  assert.equal(ledger.escrow(roomId).feeCharged, false);
  assert.equal(ledger.balance(creator.publicKey), creatorBefore);
  assert.equal(ledger.balance(opponent.publicKey), opponentBefore);
  assert.equal(room?.status, 'full');
  assert.equal(room?.resultStatus, undefined);
  assert.equal(room?.winnerId, undefined);
  assert.equal(ledger.total(), opened);

  await recoverDurableState({
    economics,
    tournaments: new InMemoryTournamentStore(),
    recoverSolCasualRoom: roomArg => economy.recoverCasualRoom(roomArg, economics),
  });
  assert.equal(ledger.escrow(roomId).status, 2);
  assert.equal((await economics.getCasualRoom(roomId))?.status, 'full');
  assert.equal(ledger.total(), opened);
});

test('process restart during an active fight tie-settles the dead battle', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await persistRoom(economics, roomId, creatorId, 'battling', opponentId);
  await economy.prepareCasualStart(roomId);
  assert.equal(ledger.escrow(roomId).status, 3);
  await recoverDurableState({
    economics,
    tournaments: new InMemoryTournamentStore(),
    recoverSolCasualRoom: room => economy.recoverCasualRoom(room, economics),
  });
  const room = await economics.getCasualRoom(roomId);
  assert.equal(ledger.escrow(roomId).status, 4);
  assert.equal(ledger.feeVault, FEE);
  assert.equal(ledger.balance(creator.publicKey), START - RENT - FEE / 2n);
  assert.equal(ledger.balance(opponent.publicKey), START - FEE / 2n);
  assert.equal(room?.status, 'completed');
  assert.equal(room?.resultStatus, 'tie');
  assert.equal((await chainStore.getIntentByScope('sol_match_tie', roomId))?.status, 'confirmed');
  assert.equal(ledger.applied.filter(name => name === 'settle_match_tie').length, 1);
  assert.equal(ledger.total(), opened);

  await economy.recoverCasualRoom(room!, economics);
  assert.equal(ledger.applied.filter(name => name === 'settle_match_tie').length, 1);
  assert.equal(ledger.total(), opened);
});

test('a charged escrow with no battle result is tie-settled on recovery', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await persistRoom(economics, roomId, creatorId, 'full', opponentId);
  await economy.prepareCasualStart(roomId);
  assert.equal(ledger.escrow(roomId).status, 3);
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  assert.equal(ledger.escrow(roomId).status, 4);
  assert.equal(ledger.feeVault, FEE);
  assert.equal(ledger.balance(creator.publicKey), START - RENT - FEE / 2n);
  assert.equal(ledger.balance(opponent.publicKey), START - FEE / 2n);
  assert.equal((await economics.getCasualRoom(roomId))?.resultStatus, 'tie');
  assert.equal(ledger.applied.filter(name => name === 'settle_match_tie').length, 1);
  assert.equal(ledger.total(), opened);
});

test('a persisted win intent is settled on recovery and a second pass does not pay again', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await persistRoom(economics, roomId, creatorId, 'battling', opponentId);
  await economy.prepareCasualStart(roomId);
  await chainStore.createIntent({
    kind: 'sol_match_win',
    scopeId: roomId,
    playerId: creatorId,
    asset: 'SOL',
    amount: 0,
    idempotencyKey: `sol_match_win:${roomId}`,
    roomId,
  });
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  const room = await economics.getCasualRoom(roomId);
  assert.equal(ledger.escrow(roomId).status, 4);
  assert.equal(room?.status, 'completed');
  assert.equal(room?.resultStatus, 'win');
  assert.equal(room?.winnerId, creatorId);
  assert.equal(ledger.balance(creator.publicKey), START - RENT - COLLATERAL + (COLLATERAL * 2n - FEE));
  assert.equal(ledger.balance(opponent.publicKey), START - COLLATERAL);
  const creatorAfter = ledger.balance(creator.publicKey);
  const opponentAfter = ledger.balance(opponent.publicKey);
  await economy.recoverCasualRoom(room!, economics);
  assert.equal(ledger.balance(creator.publicKey), creatorAfter);
  assert.equal(ledger.balance(opponent.publicKey), opponentAfter);
  assert.equal(ledger.escrow(roomId).status, 4);
  assert.equal(ledger.total(), opened);
});

test('recovery of an already-settled room records the winner without paying again', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await persistRoom(economics, roomId, creatorId, 'battling', opponentId);
  await economy.prepareCasualStart(roomId);
  await economy.settleCasual({ roomId, creatorId, opponentId, winnerId: creatorId });
  const creatorAfter = ledger.balance(creator.publicKey);
  const opponentAfter = ledger.balance(opponent.publicKey);
  assert.equal(creatorAfter, START - RENT - COLLATERAL + (COLLATERAL * 2n - FEE));
  assert.equal(opponentAfter, START - COLLATERAL);
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  const room = await economics.getCasualRoom(roomId);
  assert.equal(room?.status, 'completed');
  assert.equal(room?.resultStatus, 'win');
  assert.equal(room?.winnerId, creatorId);
  assert.equal(room?.settlementKey, `casual:${roomId}`);
  assert.equal(ledger.balance(creator.publicKey), creatorAfter);
  assert.equal(ledger.balance(opponent.publicKey), opponentAfter);
  assert.equal(ledger.replays.size, 1);
  assert.equal((await economics.getWallet(opponentId)).balance, 0);
  assert.equal(ledger.total(), opened);
});

test('a settled escrow with a failed win intent records that winner and does not pay again', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await persistRoom(economics, roomId, creatorId, 'battling', opponentId);
  await economy.prepareCasualStart(roomId);
  ledger.escrow(roomId).status = 4;
  const recorded = await chainStore.createIntent({
    kind: 'sol_match_win',
    scopeId: roomId,
    playerId: creatorId,
    asset: 'SOL',
    amount: 0,
    idempotencyKey: `sol_match_win:${roomId}`,
    roomId,
  });
  await chainStore.setIntentStatus(recorded.id, 'failed');
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  const room = await economics.getCasualRoom(roomId);
  assert.equal(room?.status, 'completed');
  assert.equal(room?.resultStatus, 'win');
  assert.equal(room?.winnerId, creatorId);
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, 0);
  assert.equal(ledger.total(), opened);
});

test('a confirmed tie is recorded even when a failed win intent also exists', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await persistRoom(economics, roomId, creatorId, 'battling', opponentId);
  await economy.prepareCasualStart(roomId);
  ledger.escrow(roomId).status = 4;
  const win = await chainStore.createIntent({
    kind: 'sol_match_win',
    scopeId: roomId,
    playerId: creatorId,
    asset: 'SOL',
    amount: 0,
    idempotencyKey: `sol_match_win:${roomId}`,
    roomId,
  });
  await chainStore.setIntentStatus(win.id, 'failed');
  const tie = await chainStore.createIntent({
    kind: 'sol_match_tie',
    scopeId: roomId,
    asset: 'SOL',
    amount: 0,
    idempotencyKey: `sol_match_tie:${roomId}`,
    roomId,
  });
  await chainStore.setIntentStatus(tie.id, 'confirmed');
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  const room = await economics.getCasualRoom(roomId);
  assert.equal(room?.status, 'completed');
  assert.equal(room?.resultStatus, 'tie');
  assert.equal(room?.winnerId, undefined);
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, 0);
  assert.equal(ledger.applied.filter(name => name === 'settle_match_tie').length, 0);
  assert.equal(ledger.total(), opened);
});

test('recovery called twice does not settle again', async () => {
  const { ledger, economy, economics, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await persistRoom(economics, roomId, creatorId, 'full', opponentId);
  const hook = {
    economics,
    tournaments: new InMemoryTournamentStore(),
    recoverSolCasualRoom: (room: { id: string }) => economy.recoverCasualRoom(
      room as Parameters<ChainEconomyService['recoverCasualRoom']>[0],
      economics,
    ),
  };
  await recoverDurableState(hook);
  const after = {
    creator: ledger.balance(creator.publicKey),
    opponent: ledger.balance(opponent.publicKey),
    replays: ledger.replays.size,
    status: ledger.escrow(roomId).status,
  };
  await recoverDurableState(hook);
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  assert.equal(ledger.balance(creator.publicKey), after.creator);
  assert.equal(ledger.balance(opponent.publicKey), after.opponent);
  assert.equal(ledger.replays.size, after.replays);
  assert.equal(ledger.escrow(roomId).status, after.status);
  assert.equal((await economics.getCasualRoom(roomId))?.winnerId, undefined);
  assert.equal(ledger.total(), opened);
});

test('unauthorized refund is rejected and does not move funds', async () => {
  const { ledger, economy, programId, creator, opponent, mallory, opened } = harness();
  const roomId = randomUUID();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  const locked = ledger.balance(creator.publicKey);
  assert.throws(
    () => ledger.apply(refundSolWagerIx({
      programId,
      authority: mallory.publicKey,
      config: configPda(programId)[0],
      recipient: creator.publicKey,
      roomId: uuidToBytes(roomId),
      side: 0,
    })),
    /Unauthorized/,
  );
  assert.throws(
    () => ledger.apply(refundSolWagerIx({
      programId,
      authority: creator.publicKey,
      config: configPda(programId)[0],
      recipient: mallory.publicKey,
      roomId: uuidToBytes(roomId),
      side: 0,
    })),
    /Unauthorized/,
  );
  assert.equal(ledger.escrow(roomId).status, 1);
  assert.equal(ledger.escrow(roomId).creatorDeposited, true);
  assert.equal(ledger.balance(creator.publicKey), locked);
  assert.equal(ledger.balance(mallory.publicKey), START);
  await economy.refundCasual(roomId, creator.publicKey.toBase58());
  assert.equal(ledger.escrow(roomId).status, 5);
  assert.equal(ledger.balance(creator.publicKey), START - RENT);
  assert.equal(ledger.balance(opponent.publicKey), START);
  assert.equal(ledger.total(), opened);
});

test('happy path charges the fee and pays the winner once', async () => {
  const { ledger, economy, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await economy.prepareCasualStart(roomId);
  const payout = await economy.settleCasual({ roomId, creatorId, opponentId, winnerId: opponentId });
  assert.equal(payout.amount, Number(COLLATERAL * 2n - FEE));
  assert.equal(ledger.feeVault, FEE);
  assert.equal(ledger.escrow(roomId).status, 4);
  assert.equal(ledger.escrow(roomId).feeCharged, true);
  assert.equal(ledger.balance(opponent.publicKey), START - COLLATERAL + (COLLATERAL * 2n - FEE));
  assert.equal(ledger.balance(creator.publicKey), START - RENT - COLLATERAL);
  const again = await economy.settleCasual({ roomId, creatorId, opponentId, winnerId: opponentId });
  assert.equal(again.settlementKey, payout.settlementKey);
  assert.equal(ledger.balance(opponent.publicKey), START - COLLATERAL + (COLLATERAL * 2n - FEE));
  assert.equal(ledger.replays.size, 1);
  await assert.rejects(
    () => economy.settleCasual({ roomId, creatorId, opponentId }),
    /already settled as a tie|Match was already settled/,
  );
  assert.equal(ledger.balance(opponent.publicKey), START - COLLATERAL + (COLLATERAL * 2n - FEE));
  assert.equal(ledger.total(), opened);
});

test('a failed settlement stays retryable and the retry pays once', async () => {
  const { ledger, economy, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await economy.prepareCasualStart(roomId);
  ledger.failNext = true;
  await assert.rejects(
    () => economy.settleCasual({ roomId, creatorId, opponentId, winnerId: opponentId }),
    /Simulated keeper/,
  );
  const failed = await chainStore.getIntentByScope('sol_match_win', roomId);
  assert.equal(failed?.status, 'pending');
  assert.equal(failed?.playerId, opponentId);
  assert.equal(ledger.escrow(roomId).status, 3);
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, 0);
  await economy.settleCasual({ roomId, creatorId, opponentId, winnerId: opponentId });
  assert.equal(ledger.escrow(roomId).status, 4);
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, 1);
  assert.equal(ledger.balance(opponent.publicKey), START - COLLATERAL + (COLLATERAL * 2n - FEE));
  assert.equal((await chainStore.getIntentByScope('sol_match_win', roomId))?.status, 'confirmed');
  assert.equal(ledger.total(), opened);
});

test('settlement is refused when the escrow is not active', async () => {
  const { ledger, economy, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  const before = ledger.balance(creator.publicKey);
  await assert.rejects(
    () => economy.settleCasual({ roomId, creatorId, opponentId, winnerId: creatorId }),
    /Refusing sol_match_win/,
  );
  assert.equal(ledger.escrow(roomId).status, 1);
  assert.equal(ledger.applied.includes('settle_match_win'), false);
  assert.equal(ledger.applied.includes('charge_match_fee'), false);
  assert.equal(ledger.balance(creator.publicKey), before);
  assert.equal((await chainStore.getIntentByScope('sol_match_win', roomId))?.status, 'pending');
  assert.equal(ledger.total(), opened);
});

test('startup recovery settles a persisted win and does not pay a landed settlement twice', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await persistRoom(economics, roomId, creatorId, 'battling', opponentId);
  await economy.prepareCasualStart(roomId);
  const recorded = await chainStore.createIntent({
    kind: 'sol_match_win',
    scopeId: roomId,
    playerId: creatorId,
    asset: 'SOL',
    amount: 0,
    idempotencyKey: `sol_match_win:${roomId}`,
    roomId,
    metadata: { settlementPhase: 'recorded', winnerId: creatorId },
  });
  await chainStore.setIntentStatus(recorded.id, 'pending');
  await recoverDurableState({
    economics,
    tournaments: new InMemoryTournamentStore(),
    recoverSolCasualRoom: room => economy.recoverCasualRoom(room, economics),
  });
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, 1);
  assert.equal((await economics.getCasualRoom(roomId))?.status, 'completed');
  assert.equal((await economics.getCasualRoom(roomId))?.winnerId, creatorId);
  const paid = ledger.balance(creator.publicKey);

  await chainStore.setIntentStatus(recorded.id, 'pending');
  await economy.settleCasual({ roomId, creatorId, opponentId, winnerId: creatorId });
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, 1);
  assert.equal(ledger.balance(creator.publicKey), paid);
  assert.equal(ledger.total(), opened);
});

test('process restart during an unconfirmed deposit does not cancel the room', async () => {
  const { economy, economics, chainStore, creator, opened, ledger } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  await persistRoom(economics, roomId, creatorId);
  const intent = await chainStore.createIntent({
    kind: 'sol_wager_deposit',
    scopeId: `${roomId}:creator`,
    playerId: creatorId,
    asset: 'SOL',
    amount: Number(COLLATERAL),
    idempotencyKey: `sol_wager_deposit:${roomId}:creator`,
    roomId,
    metadata: {
      signature: 'inflight-deposit-signature',
      lastValidBlockHeight: 1,
      side: 0,
    },
  });
  await chainStore.setIntentStatus(intent.id, 'pending');
  const report = await recoverDurableState({
    economics,
    tournaments: new InMemoryTournamentStore(),
    recoverSolCasualRoom: room => economy.recoverCasualRoom(room, economics),
  });
  assert.equal(report.cancelledCasualRoomIds.includes(roomId), false);
  assert.equal((await economics.getCasualRoom(roomId))?.status, 'pending_deposit');
  assert.equal(ledger.total(), opened);
});

test('a stale escrow read after a landed settlement does not fail or pay twice', async () => {
  let activeReads = 0;
  const { ledger, economy, chainStore, programId, creator, opponent, opened } = harness({
    readMatchEscrowState: (roomId, source) => {
      const view = source.view(roomId);
      if (view.status !== 3) return view;
      activeReads += 1;
      // The fee wait and the settlement's first read stay on Active.
      // The read after the failed submit observes the landed Settled account.
      if (activeReads <= 2) return view;
      return { ...view, status: 4, feeCharged: true };
    },
  });
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await economy.prepareCasualStart(roomId);
  const winsBefore = ledger.applied.filter(name => name === 'settle_match_win').length;
  ledger.failNext = true;
  const payout = await economy.settleCasual({ roomId, creatorId, opponentId, winnerId: creatorId });
  assert.equal(payout.amount, Number(COLLATERAL * 2n - FEE));
  assert.equal(ledger.failNext, false);
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, winsBefore);
  assert.equal((await chainStore.getIntentByScope('sol_match_win', roomId))?.status, 'confirmed');
  assert.equal(ledger.escrow(roomId).status, 3);
  assert.equal(ledger.total(), opened);
});

test('a confirmed settlement completes when the escrow read lags behind the transaction', async () => {
  const { ledger, economy, chainStore, programId, creator, opponent, opened } = harness({
    settledReadLags: true,
    readMatchEscrowState: (roomId, source) => {
      const view = source.view(roomId);
      if (view.status === 4) return { ...view, status: 3, feeCharged: true };
      return view;
    },
  });
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await economy.prepareCasualStart(roomId);
  const payout = await economy.settleCasual({ roomId, creatorId, opponentId, winnerId: creatorId });
  assert.equal(payout.amount, Number(COLLATERAL * 2n - FEE));
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, 1);
  assert.equal((await chainStore.getIntentByScope('sol_match_win', roomId))?.status, 'confirmed');
  assert.equal(ledger.escrow(roomId).status, 4);
  assert.equal(ledger.total(), opened);
});

test('boot recovery completes a battling room whose escrow is already settled', async () => {
  const { ledger, economy, economics, chainStore, programId, creator, opponent, opened } = harness();
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  await economy.seatMatchOpponent({ roomId, opponentId });
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await economy.prepareCasualStart(roomId);
  await economy.settleCasual({ roomId, creatorId, opponentId, winnerId: creatorId });
  await persistRoom(economics, roomId, creatorId, 'battling', opponentId);
  const paid = {
    creator: ledger.balance(creator.publicKey),
    opponent: ledger.balance(opponent.publicKey),
    wins: ledger.applied.filter(name => name === 'settle_match_win').length,
  };
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  const room = await economics.getCasualRoom(roomId);
  assert.equal(room?.status, 'completed');
  assert.equal(room?.resultStatus, 'win');
  assert.equal(room?.winnerId, creatorId);
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, paid.wins);
  assert.equal(ledger.balance(creator.publicKey), paid.creator);
  assert.equal(ledger.balance(opponent.publicKey), paid.opponent);
  await economy.recoverCasualRoom((await economics.getCasualRoom(roomId))!, economics);
  assert.equal((await economics.getCasualRoom(roomId))?.status, 'completed');
  assert.equal(ledger.applied.filter(name => name === 'settle_match_win').length, paid.wins);
  assert.equal(ledger.balance(creator.publicKey), paid.creator);
  assert.equal(ledger.total(), opened);
});

test('a lagging confirmed read still seats the opponent and charges the fee', async () => {
  const { ledger, economy, chainStore, programId, creator, opponent, opened } = harness({
    laggingConfirmedReads: true,
  });
  const roomId = randomUUID();
  const creatorId = creator.publicKey.toBase58();
  const opponentId = opponent.publicKey.toBase58();
  ledger.open(roomId, creator.publicKey);
  ledger.apply(deposit(programId, creator.publicKey, roomId, 0));
  const intent = await economy.createSolWagerDepositIntent({
    roomId,
    playerId: opponentId,
    side: 1,
    collateralLamports: Number(COLLATERAL),
  });
  assert.equal(intent.serializedTx.length > 0, true);
  assert.equal(ledger.escrow(roomId).opponent.equals(opponent.publicKey), true);
  ledger.apply(deposit(programId, opponent.publicKey, roomId, 1));
  await confirmDeposits(chainStore, roomId, creatorId, opponentId);
  await economy.prepareCasualStart(roomId);
  assert.equal(ledger.escrow(roomId).status, 3);
  assert.equal(ledger.escrow(roomId).feeCharged, true);
  assert.equal(ledger.applied.filter(name => name === 'charge_match_fee').length, 1);
  assert.equal(ledger.total(), opened);
});
