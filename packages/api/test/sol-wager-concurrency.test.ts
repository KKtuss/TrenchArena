/**
 * Concurrent SOL wager isolation.
 * The ledger applies the same instruction builders as the API and the same
 * per-escrow rules as the program. Postgres unique keys are modeled here;
 * this file does not talk to a live validator or a live database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type {
  ChainIntentRow,
  ChainIntentStatus,
  CreateIntentInput,
  PostgresChainStore,
} from '@pokearena/db';
import {
  IX,
  configPda,
  depositSolWagerIx,
  feeVaultPda,
  matchEscrowPda,
  uuidToBytes,
  type ArenaChainClient,
  type SentTransaction,
} from '@pokearena/solana-client';

import { ChainEconomyService } from '../src/chain-economy';
import { InMemoryEconomicsStore } from '../src/memory-economics-store';

const START = 100_000_000_000n;
const RENT = 890_880n;

interface Escrow {
  roomId: string;
  creator: PublicKey;
  opponent: PublicKey;
  collateral: bigint;
  creatorDeposited: boolean;
  opponentDeposited: boolean;
  feeCharged: boolean;
  status: number;
  vault: bigint;
  fees: number;
  wins: number;
  ties: number;
}

class SolLedger {
  readonly replays = new Set<string>();
  feeVault = 0n;
  maxInflight = 0;
  submissions = 0;
  failRooms = new Set<string>();
  timeoutRooms = new Set<string>();
  /** Room whose chain apply waits until `releaseHeld` is called. */
  holdRoom?: string;
  private holdEntered?: () => void;
  readonly enteredHold = new Promise<void>(resolve => {
    this.holdEntered = resolve;
  });
  private readonly held: Array<() => void> = [];
  private inflight = 0;
  private signature = 0;
  private readonly balances = new Map<string, bigint>();
  private readonly byEscrow = new Map<string, Escrow>();
  private readonly accountChain = new Map<string, Promise<void>>();

  constructor(
    readonly programId: PublicKey,
    readonly keeper: PublicKey,
    readonly feeVaultKey: PublicKey,
  ) {}

  credit(owner: PublicKey, amount = START): void {
    this.balances.set(owner.toBase58(), (this.balances.get(owner.toBase58()) ?? 0n) + amount);
  }

  ensure(owner: PublicKey): void {
    if (!this.balances.has(owner.toBase58())) this.credit(owner);
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

  open(roomId: string, creator: PublicKey, collateral: bigint): void {
    const [escrow] = matchEscrowPda(this.programId, uuidToBytes(roomId));
    if (this.byEscrow.has(escrow.toBase58())) throw new Error('Escrow already exists.');
    this.debit(creator, RENT);
    this.byEscrow.set(escrow.toBase58(), {
      roomId,
      creator,
      opponent: PublicKey.default,
      collateral,
      creatorDeposited: false,
      opponentDeposited: false,
      feeCharged: false,
      status: 0,
      vault: RENT,
      fees: 0,
      wins: 0,
      ties: 0,
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

  releaseHeld(): void {
    this.holdRoom = undefined;
    for (const wake of this.held.splice(0)) wake();
  }

  async submit(instructions: TransactionInstruction[]): Promise<SentTransaction> {
    this.submissions += 1;
    this.signature += 1;
    const signature = `sol-concurrent-${this.signature}`;
    const escrow = this.escrowAccount(this.escrowKey(instructions[0]));
    if (this.failRooms.has(escrow.roomId)) {
      return { signature, status: 'failed', error: 'Simulated keeper transaction failure.' };
    }
    if (this.timeoutRooms.has(escrow.roomId)) {
      return { signature, status: 'expired', error: 'Simulated keeper confirmation timeout.' };
    }
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    await Promise.resolve();
    const address = this.escrowKey(instructions[0]).toBase58();
    try {
      await this.onAccount(address, async () => {
        if (this.holdRoom === escrow.roomId) {
          this.holdEntered?.();
          await new Promise<void>(resolve => {
            this.held.push(resolve);
          });
        }
        for (const instruction of instructions) this.apply(instruction);
      });
      return { signature, status: 'confirmed', slot: this.signature };
    } catch (error) {
      return {
        signature,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.inflight -= 1;
    }
  }

  private onAccount(address: string, run: () => Promise<void>): Promise<void> {
    const previous = this.accountChain.get(address) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.accountChain.set(address, next.then(() => undefined, () => undefined));
    return next;
  }

  private apply(instruction: TransactionInstruction): void {
    const data = Buffer.from(instruction.data);
    const disc = data.subarray(0, 8);
    if (disc.equals(IX.depositSolWager)) this.deposit(instruction, data[8] ?? 255);
    else if (disc.equals(IX.seatMatchOpponent)) this.seat(instruction);
    else if (disc.equals(IX.chargeMatchFee)) this.chargeFee(instruction);
    else if (disc.equals(IX.settleMatchTie)) this.settleTie(instruction, data.subarray(8, 40));
    else if (disc.equals(IX.settleMatchWin)) this.settleWin(instruction, data.subarray(8, 40));
    else throw new Error('Unexpected instruction in SOL concurrency test.');
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
  }

  private seat(instruction: TransactionInstruction): void {
    const authority = instruction.keys[0]?.pubkey;
    const opponent = instruction.keys[2]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[3]?.pubkey);
    if (!authority?.equals(this.keeper)) throw new Error('Unauthorized');
    if (!opponent) throw new Error('Missing opponent.');
    if (escrow.status !== 0 && escrow.status !== 1) throw new Error('InvalidMatchStatus');
    if (!escrow.opponent.equals(PublicKey.default) && !escrow.opponent.equals(opponent)) {
      throw new Error('Unauthorized');
    }
    escrow.opponent = opponent;
  }

  private chargeFee(instruction: TransactionInstruction): void {
    const authority = instruction.keys[0]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[2]?.pubkey);
    const feeVault = instruction.keys[4]?.pubkey;
    if (!authority?.equals(this.keeper)) throw new Error('Unauthorized');
    if (!feeVault?.equals(this.feeVaultKey)) throw new Error('Unauthorized');
    if (escrow.status !== 2) throw new Error('InvalidMatchStatus');
    if (escrow.feeCharged) throw new Error('FeeAlreadyCharged');
    const fee = (escrow.collateral * 2n * 200n) / 10_000n;
    escrow.vault -= fee;
    this.feeVault += fee;
    escrow.feeCharged = true;
    escrow.status = 3;
    escrow.fees += 1;
  }

  private settleTie(instruction: TransactionInstruction, settlementKey: Buffer): void {
    const authority = instruction.keys[0]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[2]?.pubkey);
    const creator = instruction.keys[3]?.pubkey;
    const opponent = instruction.keys[4]?.pubkey;
    const replay = instruction.keys[6]?.pubkey;
    if (!authority?.equals(this.keeper)) throw new Error('Unauthorized');
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
    escrow.ties += 1;
  }

  private settleWin(instruction: TransactionInstruction, settlementKey: Buffer): void {
    const authority = instruction.keys[0]?.pubkey;
    const winner = instruction.keys[2]?.pubkey;
    const escrow = this.escrowAccount(instruction.keys[3]?.pubkey);
    const replay = instruction.keys[5]?.pubkey;
    if (!authority?.equals(this.keeper)) throw new Error('Unauthorized');
    if (!winner || (!winner.equals(escrow.creator) && !winner.equals(escrow.opponent))) {
      throw new Error('Unauthorized');
    }
    this.consumeReplay(replay, settlementKey);
    if (escrow.status !== 3 || !escrow.feeCharged) throw new Error('InvalidMatchStatus');
    const payout = escrow.vault - RENT;
    escrow.vault = RENT;
    this.creditTo(winner, payout);
    escrow.status = 4;
    escrow.wins += 1;
  }

  private consumeReplay(replay: PublicKey | undefined, settlementKey: Buffer): void {
    if (!replay || settlementKey.length !== 32) throw new Error('Invalid settlement key.');
    if (this.replays.has(replay.toBase58())) throw new Error('Replay account already exists.');
    this.replays.add(replay.toBase58());
  }

  private escrowKey(instruction: TransactionInstruction | undefined): PublicKey {
    const data = instruction ? Buffer.from(instruction.data) : Buffer.alloc(0);
    const disc = data.subarray(0, 8);
    const index = disc.equals(IX.depositSolWager) ? 1
      : disc.equals(IX.seatMatchOpponent) ? 3
        : disc.equals(IX.chargeMatchFee) ? 2
          : disc.equals(IX.settleMatchWin) ? 3
            : disc.equals(IX.settleMatchTie) ? 2
              : -1;
    const key = instruction?.keys[index]?.pubkey;
    if (!key) throw new Error('Instruction is missing its escrow account.');
    return key;
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

/**
 * Models chain_intents UNIQUE (idempotency_key) and UNIQUE (kind, scope_id),
 * plus setIntentStatus FOR UPDATE that refuses to leave `confirmed`.
 * An await between the existence check and the insert matches the two
 * round-trips in PostgresChainStore.createIntent.
 */
class RacingChainStore {
  readonly intents = new Map<string, ChainIntentRow>();
  conflictReturns = 0;
  private readonly locks = new Map<string, Promise<void>>();

  async createIntent(input: CreateIntentInput): Promise<ChainIntentRow> {
    const existing = [...this.intents.values()].find(row => row.idempotencyKey === input.idempotencyKey);
    if (existing) return clone(existing);
    await Promise.resolve();
    const winner = [...this.intents.values()].find(row => row.idempotencyKey === input.idempotencyKey);
    if (winner) {
      this.conflictReturns += 1;
      return clone(winner);
    }
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
    return clone(row);
  }

  async getIntent(id: string): Promise<ChainIntentRow | undefined> {
    const row = this.intents.get(id);
    return row ? clone(row) : undefined;
  }

  async getIntentByScope(kind: ChainIntentRow['kind'], scopeId: string): Promise<ChainIntentRow | undefined> {
    const row = [...this.intents.values()].find(item => item.kind === kind && item.scopeId === scopeId);
    return row ? clone(row) : undefined;
  }

  async setIntentStatus(id: string, status: ChainIntentStatus): Promise<ChainIntentRow> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(async () => {
      await Promise.resolve();
      const row = this.intents.get(id);
      if (!row) throw new Error(`Unknown chain intent: ${id}`);
      const retryable = status === 'confirmed' || status === 'pending';
      if (
        row.status === 'confirmed'
        || row.status === 'cancelled'
        || ((row.status === 'failed' || row.status === 'expired') && !retryable)
      ) {
        return clone(row);
      }
      row.status = status;
      return clone(row);
    });
    this.locks.set(id, run.then(() => undefined, () => undefined));
    return run;
  }
}

function clone(row: ChainIntentRow): ChainIntentRow {
  return { ...row, metadata: { ...row.metadata } };
}

function feeOf(collateral: bigint): bigint {
  return (collateral * 2n * 200n) / 10_000n;
}

function payoutOf(collateral: bigint): bigint {
  return collateral * 2n - feeOf(collateral);
}

interface RoomSpec {
  id: string;
  collateral: bigint;
  creator: Keypair;
  opponent: Keypair;
  winner: 'creator' | 'opponent';
}

function harness() {
  const keeper = Keypair.generate();
  const programId = Keypair.generate().publicKey;
  const ledger = new SolLedger(programId, keeper.publicKey, feeVaultPda(programId)[0]);
  const chainStore = new RacingChainStore();
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
      getMatchEscrowState: async (roomId: Uint8Array) => {
        await Promise.resolve();
        return ledger.view(roomId);
      },
    } as unknown as ArenaChainClient,
    keeper,
    submitKeeper: instructions => ledger.submit(instructions),
  });
  const economics = new InMemoryEconomicsStore();
  return { keeper, programId, ledger, chainStore, economy, economics };
}

function wallet(): Keypair {
  const key = Keypair.generate();
  return key;
}

async function fundRoom(
  env: ReturnType<typeof harness>,
  spec: RoomSpec,
): Promise<void> {
  const { ledger, economy, economics, chainStore, programId } = env;
  ledger.ensure(spec.creator.publicKey);
  ledger.ensure(spec.opponent.publicKey);
  ledger.open(spec.id, spec.creator.publicKey, spec.collateral);
  await economics.createCasualRoomWithHold({
    id: spec.id,
    matchId: `casual-${spec.id}`,
    roomType: 'private',
    battleSize: '1v1',
    creatorId: spec.creator.publicKey.toBase58(),
    collateral: Number(spec.collateral),
    rail: 'sol_chain',
    collateralLamports: Number(spec.collateral),
  });
  await economics.acceptCasualRoomWithHold({
    roomId: spec.id,
    opponentId: spec.opponent.publicKey.toBase58(),
    collateral: Number(spec.collateral),
  });
  await ledger.submit([depositSolWagerIx({
    programId,
    depositor: spec.creator.publicKey,
    roomId: uuidToBytes(spec.id),
    side: 0,
  })]);
  await economy.seatMatchOpponent({
    roomId: spec.id,
    opponentId: spec.opponent.publicKey.toBase58(),
  });
  await ledger.submit([depositSolWagerIx({
    programId,
    depositor: spec.opponent.publicKey,
    roomId: uuidToBytes(spec.id),
    side: 1,
  })]);
  for (const [scope, player] of [
    ['creator', spec.creator],
    ['opponent', spec.opponent],
  ] as const) {
    const intent = await chainStore.createIntent({
      kind: 'sol_wager_deposit',
      scopeId: `${spec.id}:${scope}`,
      playerId: player.publicKey.toBase58(),
      asset: 'SOL',
      amount: Number(spec.collateral),
      idempotencyKey: `sol_wager_deposit:${spec.id}:${scope}`,
      roomId: spec.id,
    });
    await chainStore.setIntentStatus(intent.id, 'confirmed');
  }
}

function winnerOf(spec: RoomSpec): PublicKey {
  return spec.winner === 'creator' ? spec.creator.publicKey : spec.opponent.publicKey;
}

async function settleRoom(env: ReturnType<typeof harness>, spec: RoomSpec) {
  const winner = winnerOf(spec);
  const payout = await env.economy.settleCasual({
    roomId: spec.id,
    creatorId: spec.creator.publicKey.toBase58(),
    opponentId: spec.opponent.publicKey.toBase58(),
    winnerId: winner.toBase58(),
  });
  await env.economics.completeCasualWin({
    roomId: spec.id,
    winnerId: winner.toBase58(),
    loserId: (spec.winner === 'creator' ? spec.opponent : spec.creator).publicKey.toBase58(),
    collateral: Number(spec.collateral),
    reason: 'casual-win',
  });
  return payout;
}

function assertRoom(env: ReturnType<typeof harness>, spec: RoomSpec, before: Map<string, bigint>): void {
  const escrowAddress = matchEscrowPda(env.programId, uuidToBytes(spec.id))[0];
  const escrow = env.ledger.escrow(spec.id);
  const fee = feeOf(spec.collateral);
  const payout = payoutOf(spec.collateral);
  const winner = winnerOf(spec);
  const loser = spec.winner === 'creator' ? spec.opponent.publicKey : spec.creator.publicKey;
  assert.equal(escrowAddress.toBase58(), matchEscrowPda(env.programId, uuidToBytes(spec.id))[0].toBase58());
  assert.equal(escrow.creator.toBase58(), spec.creator.publicKey.toBase58());
  assert.equal(escrow.opponent.toBase58(), spec.opponent.publicKey.toBase58());
  assert.equal(escrow.collateral, spec.collateral);
  assert.equal(escrow.fees, 1);
  assert.equal(escrow.wins, 1);
  assert.equal(escrow.ties, 0);
  assert.equal(escrow.status, 4);
  assert.equal(escrow.vault, RENT);
  assert.equal(env.ledger.balance(winner) - (before.get(winner.toBase58()) ?? 0n), payout);
  assert.equal(env.ledger.balance(loser) - (before.get(loser.toBase58()) ?? 0n), 0n);
}

test('concurrent inserts for one settlement key collapse to one intent', async () => {
  const store = new RacingChainStore();
  const rows = await Promise.all(Array.from({ length: 8 }, () => store.createIntent({
    kind: 'sol_match_win',
    scopeId: 'room-a',
    asset: 'SOL',
    amount: 0,
    idempotencyKey: 'sol_match_win:room-a',
    roomId: 'room-a',
  })));
  assert.equal(new Set(rows.map(row => row.id)).size, 1);
  assert.equal(store.intents.size, 1);
  assert.equal(store.conflictReturns >= 1, true);
});

test('four different stakes settle concurrently without crossing escrow', async () => {
  const env = harness();
  const specs: RoomSpec[] = [
    { id: randomUUID(), collateral: 10_000_000n, creator: wallet(), opponent: wallet(), winner: 'creator' },
    { id: randomUUID(), collateral: 20_000_000n, creator: wallet(), opponent: wallet(), winner: 'opponent' },
    { id: randomUUID(), collateral: 50_000_000n, creator: wallet(), opponent: wallet(), winner: 'creator' },
    { id: randomUUID(), collateral: 100_000_000n, creator: wallet(), opponent: wallet(), winner: 'opponent' },
  ];
  for (const spec of specs) await fundRoom(env, spec);
  const opened = env.ledger.total();
  for (const spec of specs) await env.economy.prepareCasualStart(spec.id);
  const before = new Map<string, bigint>();
  for (const spec of specs) {
    before.set(spec.creator.publicKey.toBase58(), env.ledger.balance(spec.creator.publicKey));
    before.set(spec.opponent.publicKey.toBase58(), env.ledger.balance(spec.opponent.publicKey));
  }
  const results = await Promise.all(specs.map(spec => settleRoom(env, spec)));
  assert.equal(env.ledger.maxInflight > 1, true);
  const keys = new Set(results.map(result => result.settlementKey));
  assert.equal(keys.size, specs.length);
  for (const spec of specs) {
    assertRoom(env, spec, before);
    const room = await env.economics.getCasualRoom(spec.id);
    assert.equal(room?.status, 'completed');
    assert.equal(room?.resultStatus, 'win');
    assert.equal(room?.winnerId, winnerOf(spec).toBase58());
    const win = await env.chainStore.getIntentByScope('sol_match_win', spec.id);
    const tie = await env.chainStore.getIntentByScope('sol_match_tie', spec.id);
    const fee = await env.chainStore.getIntentByScope('sol_match_fee', spec.id);
    assert.equal(win?.status, 'confirmed');
    assert.equal(win?.playerId, winnerOf(spec).toBase58());
    assert.equal(tie, undefined);
    assert.equal(fee?.status, 'confirmed');
    assert.equal(fee?.amount, Number(feeOf(spec.collateral)));
    assert.equal(results.find(result => result.settlementKey === `sol_match_win:${spec.id}`)?.amount, Number(payoutOf(spec.collateral)));
  }
  const winIds = new Set<string>();
  for (const spec of specs) {
    const win = await env.chainStore.getIntentByScope('sol_match_win', spec.id);
    assert.ok(win);
    assert.equal(winIds.has(win.id), false);
    winIds.add(win.id);
  }
  assert.equal(env.ledger.feeVault, specs.reduce((sum, spec) => sum + feeOf(spec.collateral), 0n));
  assert.equal(env.ledger.total(), opened);
  assert.equal(env.ledger.replays.size, specs.length);
});

test('one creator cannot fund two active rooms at the same time', async () => {
  const env = harness();
  const creator = wallet();
  const specs: RoomSpec[] = [
    { id: randomUUID(), collateral: 10_000_000n, creator, opponent: wallet(), winner: 'creator' },
    { id: randomUUID(), collateral: 50_000_000n, creator, opponent: wallet(), winner: 'opponent' },
  ];
  await fundRoom(env, specs[0]!);
  await assert.rejects(
    () => fundRoom(env, specs[1]!),
    /one active casual room/,
  );
});

test('two rooms with the same stake and two with different stakes settle together', async () => {
  const env = harness();
  const specs: RoomSpec[] = [
    { id: randomUUID(), collateral: 20_000_000n, creator: wallet(), opponent: wallet(), winner: 'creator' },
    { id: randomUUID(), collateral: 20_000_000n, creator: wallet(), opponent: wallet(), winner: 'opponent' },
    { id: randomUUID(), collateral: 10_000_000n, creator: wallet(), opponent: wallet(), winner: 'creator' },
    { id: randomUUID(), collateral: 50_000_000n, creator: wallet(), opponent: wallet(), winner: 'opponent' },
  ];
  for (const spec of specs) await fundRoom(env, spec);
  await Promise.all(specs.map(spec => env.economy.prepareCasualStart(spec.id)));
  const before = new Map(specs.flatMap(spec => [
    [spec.creator.publicKey.toBase58(), env.ledger.balance(spec.creator.publicKey)] as const,
    [spec.opponent.publicKey.toBase58(), env.ledger.balance(spec.opponent.publicKey)] as const,
  ]));
  await Promise.all(specs.map(spec => settleRoom(env, spec)));
  for (const spec of specs) assertRoom(env, spec, before);
  assert.equal(env.ledger.escrow(specs[0]!.id).wins, 1);
  assert.equal(env.ledger.escrow(specs[1]!.id).wins, 1);
  assert.notEqual(
    matchEscrowPda(env.programId, uuidToBytes(specs[0]!.id))[0].toBase58(),
    matchEscrowPda(env.programId, uuidToBytes(specs[1]!.id))[0].toBase58(),
  );
});

test('duplicate settlement of one room while three others settle pays each room once', async () => {
  const env = harness();
  const specs: RoomSpec[] = [10_000_000n, 20_000_000n, 50_000_000n, 100_000_000n].map(collateral => ({
    id: randomUUID(),
    collateral,
    creator: wallet(),
    opponent: wallet(),
    winner: 'creator' as const,
  }));
  for (const spec of specs) await fundRoom(env, spec);
  await Promise.all(specs.map(spec => env.economy.prepareCasualStart(spec.id)));
  const first = specs[0]!;
  const settled = await Promise.allSettled([
    settleRoom(env, first),
    settleRoom(env, first),
    settleRoom(env, first),
    ...specs.slice(1).map(spec => settleRoom(env, spec)),
  ]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length >= 4, true);
  for (const spec of specs) {
    assert.equal(env.ledger.escrow(spec.id).wins, 1);
    assert.equal(env.ledger.escrow(spec.id).status, 4);
  }
});

test('one failed settlement and one timeout leave the other rooms paid once', async () => {
  const env = harness();
  const specs: RoomSpec[] = [10_000_000n, 20_000_000n, 50_000_000n, 100_000_000n].map(collateral => ({
    id: randomUUID(),
    collateral,
    creator: wallet(),
    opponent: wallet(),
    winner: 'opponent' as const,
  }));
  for (const spec of specs) await fundRoom(env, spec);
  await Promise.all(specs.map(spec => env.economy.prepareCasualStart(spec.id)));
  env.ledger.failRooms.add(specs[0]!.id);
  env.ledger.timeoutRooms.add(specs[1]!.id);
  const settled = await Promise.allSettled(specs.map(spec => settleRoom(env, spec)));
  assert.equal(settled[0]?.status, 'rejected');
  assert.equal(settled[1]?.status, 'rejected');
  assert.equal(settled[2]?.status, 'fulfilled');
  assert.equal(settled[3]?.status, 'fulfilled');
  assert.equal(env.ledger.escrow(specs[0]!.id).wins, 0);
  assert.equal(env.ledger.escrow(specs[0]!.id).status, 3);
  assert.equal(env.ledger.escrow(specs[1]!.id).wins, 0);
  assert.equal(env.ledger.escrow(specs[1]!.id).status, 3);
  assert.equal(env.ledger.escrow(specs[2]!.id).wins, 1);
  assert.equal(env.ledger.escrow(specs[3]!.id).wins, 1);
  const failedIntent = await env.chainStore.getIntentByScope('sol_match_win', specs[0]!.id);
  const timedOut = await env.chainStore.getIntentByScope('sol_match_win', specs[1]!.id);
  assert.equal(failedIntent?.status, 'pending');
  assert.equal(timedOut?.status, 'pending');
  assert.equal((await env.economics.getCasualRoom(specs[2]!.id))?.status, 'completed');
  assert.equal((await env.economics.getCasualRoom(specs[0]!.id))?.status, 'full');
});

test('a delayed settlement still pays its own room after the others finish', async () => {
  const env = harness();
  const specs: RoomSpec[] = [10_000_000n, 20_000_000n, 50_000_000n].map((collateral, index) => ({
    id: randomUUID(),
    collateral,
    creator: wallet(),
    opponent: wallet(),
    winner: index === 0 ? 'creator' as const : 'opponent' as const,
  }));
  for (const spec of specs) await fundRoom(env, spec);
  await Promise.all(specs.map(spec => env.economy.prepareCasualStart(spec.id)));
  env.ledger.holdRoom = specs[0]!.id;
  const winnerBefore = env.ledger.balance(winnerOf(specs[0]!));
  const pending = Promise.all(specs.map(spec => settleRoom(env, spec)));
  await env.ledger.enteredHold;
  for (let attempt = 0; attempt < 20
    && (env.ledger.escrow(specs[1]!.id).status !== 4 || env.ledger.escrow(specs[2]!.id).status !== 4);
    attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(env.ledger.escrow(specs[1]!.id).status, 4);
  assert.equal(env.ledger.escrow(specs[2]!.id).status, 4);
  assert.equal(env.ledger.escrow(specs[0]!.id).status, 3);
  env.ledger.releaseHeld();
  await pending;
  assert.equal(env.ledger.escrow(specs[0]!.id).wins, 1);
  assert.equal(env.ledger.escrow(specs[0]!.id).status, 4);
  assert.equal(env.ledger.balance(winnerOf(specs[0]!)) - winnerBefore, payoutOf(specs[0]!.collateral));
});

test('ten concurrent rooms keep independent fees, payouts, and intents', async () => {
  const env = harness();
  const stakes = [10_000_000n, 20_000_000n, 30_000_000n, 40_000_000n, 50_000_000n];
  const specs: RoomSpec[] = Array.from({ length: 10 }, (_, index) => ({
    id: randomUUID(),
    collateral: stakes[index % stakes.length]!,
    creator: wallet(),
    opponent: wallet(),
    winner: index % 2 === 0 ? 'creator' as const : 'opponent' as const,
  }));
  for (const spec of specs) await fundRoom(env, spec);
  const opened = env.ledger.total();
  await Promise.all(specs.map(async spec => {
    await env.economy.prepareCasualStart(spec.id);
    await settleRoom(env, spec);
  }));
  assert.equal(env.ledger.maxInflight > 1, true);
  const intents = new Set<string>();
  for (const spec of specs) {
    const escrow = env.ledger.escrow(spec.id);
    assert.equal(escrow.wins, 1);
    assert.equal(escrow.fees, 1);
    assert.equal(escrow.collateral, spec.collateral);
    const win = await env.chainStore.getIntentByScope('sol_match_win', spec.id);
    assert.equal(win?.status, 'confirmed');
    assert.equal(intents.has(win!.id), false);
    intents.add(win!.id);
  }
  assert.equal(env.ledger.total(), opened);
  assert.equal(env.ledger.replays.size, 10);
});

test('a second fee charge against a funded room is rejected', async () => {
  const env = harness();
  const spec: RoomSpec = {
    id: randomUUID(),
    collateral: 10_000_000n,
    creator: wallet(),
    opponent: wallet(),
    winner: 'creator',
  };
  await fundRoom(env, spec);
  const settled = await Promise.allSettled([
    env.economy.prepareCasualStart(spec.id),
    env.economy.prepareCasualStart(spec.id),
  ]);
  assert.equal(settled.some(result => result.status === 'fulfilled'), true);
  assert.equal(env.ledger.escrow(spec.id).fees, 1);
  assert.equal(env.ledger.feeVault, feeOf(spec.collateral));
});

test('recovery of a landed win before the intent is confirmed records that winner', async () => {
  const env = harness();
  const spec: RoomSpec = {
    id: randomUUID(),
    collateral: 10_000_000n,
    creator: wallet(),
    opponent: wallet(),
    winner: 'creator',
  };
  await fundRoom(env, spec);
  await env.economics.setCasualRoomStatus(spec.id, 'battling');
  await env.economy.prepareCasualStart(spec.id);
  const winnerBefore = env.ledger.balance(spec.creator.publicKey);
  const loserBefore = env.ledger.balance(spec.opponent.publicKey);
  const setIntentStatus = env.chainStore.setIntentStatus.bind(env.chainStore);
  let databaseUpdateInterrupted = true;
  env.chainStore.setIntentStatus = async (...args) => {
    if (databaseUpdateInterrupted) {
      databaseUpdateInterrupted = false;
      throw new Error('Database update delayed.');
    }
    return setIntentStatus(...args);
  };
  await assert.rejects(() => settleRoom(env, spec), /Database update delayed/);
  assert.equal(env.ledger.escrow(spec.id).wins, 1);
  assert.equal(env.ledger.escrow(spec.id).status, 4);
  const room = (await env.economics.getCasualRoom(spec.id))!;
  await env.economy.recoverCasualRoom(room, env.economics);
  const after = await env.economics.getCasualRoom(spec.id);
  assert.equal(after?.resultStatus, 'win');
  assert.equal(after?.winnerId, spec.creator.publicKey.toBase58());
  assert.equal(env.ledger.balance(spec.creator.publicKey) - winnerBefore, payoutOf(spec.collateral));
  assert.equal(env.ledger.balance(spec.opponent.publicKey) - loserBefore, 0n);
  assert.equal(env.ledger.escrow(spec.id).ties, 0);
  const winnerAfterRecovery = env.ledger.balance(spec.creator.publicKey);
  await env.economy.recoverCasualRoom(after!, env.economics);
  assert.equal(env.ledger.balance(spec.creator.publicKey), winnerAfterRecovery);
  assert.equal((await env.chainStore.getIntentByScope('sol_match_win', spec.id))?.status, 'confirmed');
});

test('boot-style recovery tie-settles a dead battle and leaves a settled room paid once', async () => {
  const env = harness();
  const live: RoomSpec = {
    id: randomUUID(),
    collateral: 20_000_000n,
    creator: wallet(),
    opponent: wallet(),
    winner: 'creator',
  };
  const done: RoomSpec = {
    id: randomUUID(),
    collateral: 10_000_000n,
    creator: wallet(),
    opponent: wallet(),
    winner: 'opponent',
  };
  await fundRoom(env, live);
  await fundRoom(env, done);
  await env.economy.prepareCasualStart(live.id);
  await env.economy.prepareCasualStart(done.id);
  await settleRoom(env, done);
  const creatorBefore = env.ledger.balance(live.creator.publicKey);
  const opponentBefore = env.ledger.balance(live.opponent.publicKey);
  const liveRoom = (await env.economics.getCasualRoom(live.id))!;
  await env.economics.setCasualRoomStatus(live.id, 'battling');
  await env.economy.recoverCasualRoom(
    { ...liveRoom, status: 'battling' },
    env.economics,
  );
  const split = (live.collateral * 2n - feeOf(live.collateral)) / 2n;
  assert.equal(env.ledger.escrow(live.id).ties, 1);
  assert.equal(env.ledger.escrow(live.id).status, 4);
  assert.equal(env.ledger.balance(live.creator.publicKey) - creatorBefore, split);
  assert.equal(env.ledger.balance(live.opponent.publicKey) - opponentBefore, split);
  assert.equal((await env.economics.getCasualRoom(live.id))?.status, 'completed');
  assert.equal((await env.economics.getCasualRoom(live.id))?.resultStatus, 'tie');
  assert.equal((await env.economics.getCasualRoom(live.id))?.winnerId, undefined);
  assert.equal(env.ledger.escrow(done.id).wins, 1);
  assert.equal((await env.economics.getCasualRoom(done.id))?.resultStatus, 'win');
});
