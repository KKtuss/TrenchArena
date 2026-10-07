/**
 * Executes the Pinocchio program in LiteSVM.
 * Covers unset-mint initialization, SOL settlement, and one-time set_poke_mint.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  IX,
  buybackAndBurnPokeIx,
  burnPokeEntryIx,
  chargeMatchFeeIx,
  configPda,
  createMatchEscrowIx,
  depositPokeEntryIx,
  depositSolWagerIx,
  feeVaultPda,
  initializeConfigIx,
  refundPokeEntryIx,
  seatMatchOpponentIx,
  setPokeMintIx,
  settleMatchWinIx,
} from '../src/index';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/token';

const PROGRAM_ID = new PublicKey('6dHMWQd1M2ZZSmrkQLGZcFpHnvHi8rcH68QqQJ4Kj4r8');
const SO_PATH = join(__dirname, '../../../../target/deploy/arena_escrow_pinocchio.so');
const UNAUTHORIZED = 6002;
const POKE_UNSET = 6017;
const POKE_ALREADY_SET = 6018;
const INVALID_MINT = 6019;

type Svm = {
  addProgramFromFile: (id: PublicKey, path: string) => void;
  setAccount: (address: PublicKey, account: {
    lamports: number;
    data: Buffer;
    owner: PublicKey;
    executable: boolean;
    rentEpoch: number;
  }) => void;
  airdrop: (address: PublicKey, lamports: bigint) => unknown;
  getAccount: (address: PublicKey) => { data: Uint8Array; lamports: number } | null;
  latestBlockhash: () => string;
  sendTransaction: (tx: Transaction) => unknown;
  expireBlockhash?: () => void;
  minimumBalanceForRentExemption: (n: bigint) => bigint;
};

let LiteSVM: (new () => Svm) | null = null;
let FailedTransactionMetadata: (new (...args: never[]) => unknown) | null = null;
let loadError: string | null = null;
try {
  const mod = require('litesvm') as {
    LiteSVM: new () => Svm;
    FailedTransactionMetadata: new (...args: never[]) => unknown;
  };
  LiteSVM = mod.LiteSVM;
  FailedTransactionMetadata = mod.FailedTransactionMetadata;
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error);
}

function svmReady(): boolean {
  return Boolean(LiteSVM && existsSync(SO_PATH));
}

function loadSvm(): Svm {
  if (!LiteSVM) throw new Error(loadError ?? 'litesvm unavailable');
  const localSo = join(tmpdir(), `${basename(SO_PATH)}.${process.pid}.${Date.now()}.so`);
  copyFileSync(SO_PATH, localSo);
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM_ID, localSo);
  return svm;
}

function send(svm: Svm, payer: Keypair, ixs: TransactionInstruction[], extra: Keypair[] = []): unknown {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: svm.latestBlockhash(),
  }).add(...ixs);
  tx.sign(payer, ...extra);
  const result = svm.sendTransaction(tx);
  svm.expireBlockhash?.();
  return result;
}

function failed(result: unknown): boolean {
  return Boolean(FailedTransactionMetadata && result instanceof FailedTransactionMetadata);
}

function customError(result: unknown): number | null {
  if (!failed(result)) return null;
  try {
    const meta = (result as { meta?: () => { logs?: () => string[] } }).meta?.();
    const logs = meta?.logs?.() ?? [];
    const text = logs.join('\n');
    const match = text.match(/custom program error: 0x([0-9a-f]+)/i);
    return match ? Number.parseInt(match[1], 16) : null;
  } catch {
    return null;
  }
}

function assertError(result: unknown, code: number): void {
  assert.equal(failed(result), true);
  assert.equal(customError(result), code);
}

function fund(svm: Svm, key: PublicKey, sol = 20): void {
  svm.airdrop(key, BigInt(sol * LAMPORTS_PER_SOL));
}

function mintData(decimals: number): Buffer {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(1_000_000_000_000n, 36);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

function installMint(svm: Svm, mint: PublicKey, decimals: number, owner = TOKEN_2022_PROGRAM_ID): void {
  svm.setAccount(mint, {
    lamports: Number(svm.minimumBalanceForRentExemption(82n)),
    data: mintData(decimals),
    owner,
    executable: false,
    rentEpoch: 0,
  });
}

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}

function storedMint(svm: Svm): PublicKey {
  const [config] = configPda(PROGRAM_ID);
  const account = svm.getAccount(config);
  assert.ok(account);
  return new PublicKey(account.data.subarray(136, 168));
}

function init(svm: Svm, authority: Keypair, keeper: PublicKey, pokeMint: PublicKey): void {
  const result = send(svm, authority, [
    initializeConfigIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      pokeMint,
      quoteAuthority: authority.publicKey,
      keeper,
      buybackBps: 0,
      minBuybackLamports: 50_000_000,
    }),
  ]);
  assert.equal(failed(result), false, `initialize failed: ${customError(result)}`);
}

test('initialize with the System Program stores the zero mint', { skip: !svmReady() && (loadError ?? 'artifact missing') }, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  fund(svm, authority.publicKey);
  init(svm, authority, keeper.publicKey, PublicKey.default);
  assert.equal(storedMint(svm).equals(PublicKey.default), true);
  assert.equal(IX.setPokeMint.equals(Buffer.from([0xc4, 0x90, 0xfa, 0x46, 0x5a, 0xa7, 0x80, 0x84])), true);
});

test('initialize with a 6-decimal Token-2022 mint stores that mint', { skip: !svmReady() && (loadError ?? 'artifact missing') }, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const mint = Keypair.generate();
  fund(svm, authority.publicKey);
  installMint(svm, mint.publicKey, 6);
  init(svm, authority, keeper.publicKey, mint.publicKey);
  assert.equal(storedMint(svm).equals(mint.publicKey), true);
});

test('SOL wager settlement works while the mint is unset, and replay rejects a second settle', { skip: !svmReady() && (loadError ?? 'artifact missing') }, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const player1 = Keypair.generate();
  const player2 = Keypair.generate();
  fund(svm, authority.publicKey);
  fund(svm, keeper.publicKey);
  fund(svm, player1.publicKey);
  fund(svm, player2.publicKey);
  init(svm, authority, keeper.publicKey, PublicKey.default);

  const roomId = createHash('sha256').update('sol-room').digest().subarray(0, 16);
  const collateral = 1_000_000;
  const created = send(svm, player1, [
    createMatchEscrowIx({
      programId: PROGRAM_ID,
      creator: player1.publicKey,
      config: configPda(PROGRAM_ID)[0],
      roomId,
      collateralLamports: collateral,
    }),
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: player1.publicKey,
      roomId,
      side: 0,
    }),
  ]);
  assert.equal(failed(created), false, `create/deposit failed ${customError(created)}`);

  const seated = send(svm, keeper, [
    seatMatchOpponentIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configPda(PROGRAM_ID)[0],
      opponent: player2.publicKey,
      roomId,
    }),
  ]);
  assert.equal(failed(seated), false, `seat failed ${customError(seated)}`);

  const deposited = send(svm, player2, [
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: player2.publicKey,
      roomId,
      side: 1,
    }),
  ]);
  assert.equal(failed(deposited), false, `opponent deposit failed ${customError(deposited)}`);

  const fee = send(svm, keeper, [
    chargeMatchFeeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configPda(PROGRAM_ID)[0],
      feeVault: feeVaultPda(PROGRAM_ID)[0],
      roomId,
    }),
  ]);
  assert.equal(failed(fee), false, `fee failed ${customError(fee)}`);

  const settlementKey = createHash('sha256').update('sol-win').digest();
  const before = svm.getAccount(player1.publicKey)?.lamports ?? 0;
  const won = send(svm, keeper, [
    settleMatchWinIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configPda(PROGRAM_ID)[0],
      winner: player1.publicKey,
      roomId,
      settlementKey,
    }),
  ]);
  assert.equal(failed(won), false, `settle failed ${customError(won)}`);
  const after = svm.getAccount(player1.publicKey)?.lamports ?? 0;
  assert.ok(after > before);
  const replay = send(svm, keeper, [
    settleMatchWinIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configPda(PROGRAM_ID)[0],
      winner: player1.publicKey,
      roomId,
      settlementKey,
    }),
  ]);
  assert.equal(failed(replay), true);
});

test('POKE instructions fail while the mint is zero', { skip: !svmReady() && (loadError ?? 'artifact missing') }, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const player = Keypair.generate();
  fund(svm, authority.publicKey);
  fund(svm, keeper.publicKey);
  fund(svm, player.publicKey);
  init(svm, authority, keeper.publicKey, PublicKey.default);
  const tournamentId = createHash('sha256').update('tour').digest().subarray(0, 16);
  const quoteId = createHash('sha256').update('quote').digest();
  const burnKey = createHash('sha256').update('burn').digest();
  const buybackKey = createHash('sha256').update('buyback').digest();
  const config = configPda(PROGRAM_ID)[0];
  const dummyMint = Keypair.generate().publicKey;
  const dummyAta = Keypair.generate().publicKey;
  assertError(send(svm, player, [
    depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: player.publicKey,
      config,
      pokeMint: dummyMint,
      playerPoke: dummyAta,
      tournamentId,
      amount: 10_000_000_000n,
      quoteId,
      priceMicroUsd: 1,
    }),
  ]), POKE_UNSET);
  assertError(send(svm, keeper, [
    refundPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      pokeMint: dummyMint,
      playerPoke: dummyAta,
      tournamentId,
      player: player.publicKey,
    }),
  ]), POKE_UNSET);
  assertError(send(svm, keeper, [
    burnPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      pokeMint: dummyMint,
      player: player.publicKey,
      tournamentId,
      burnKey,
    }),
  ]), POKE_UNSET);
  assertError(send(svm, keeper, [
    buybackAndBurnPokeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      feeVault: feeVaultPda(PROGRAM_ID)[0],
      swapWallet: player.publicKey,
      pokeMint: dummyMint,
      pokeBurnSource: dummyAta,
      buybackKey,
      solAmount: 50_000_000,
      minPokeOut: 1,
    }),
  ]), POKE_UNSET);
});

test('only the config authority can set the mint once, and only a 6-decimal Token-2022 mint', { skip: !svmReady() && (loadError ?? 'artifact missing') }, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const stranger = Keypair.generate();
  const good = Keypair.generate();
  const wrongDecimals = Keypair.generate();
  const wrongOwner = Keypair.generate();
  const classicSpl = Keypair.generate();
  fund(svm, authority.publicKey);
  fund(svm, keeper.publicKey);
  fund(svm, stranger.publicKey);
  init(svm, authority, keeper.publicKey, PublicKey.default);
  installMint(svm, good.publicKey, 6);
  installMint(svm, wrongDecimals.publicKey, 9);
  installMint(svm, wrongOwner.publicKey, 6, SystemProgram.programId);
  installMint(svm, classicSpl.publicKey, 6, TOKEN_PROGRAM_ID);

  assertError(send(svm, keeper, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: keeper.publicKey, pokeMint: good.publicKey }),
  ]), UNAUTHORIZED);
  assertError(send(svm, stranger, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: stranger.publicKey, pokeMint: good.publicKey }),
  ]), UNAUTHORIZED);
  assertError(send(svm, authority, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: authority.publicKey, pokeMint: wrongDecimals.publicKey }),
  ]), INVALID_MINT);
  assertError(send(svm, authority, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: authority.publicKey, pokeMint: wrongOwner.publicKey }),
  ]), INVALID_MINT);
  assertError(send(svm, authority, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: authority.publicKey, pokeMint: classicSpl.publicKey }),
  ]), INVALID_MINT);
  assert.equal(storedMint(svm).equals(PublicKey.default), true);

  const set = send(svm, authority, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: authority.publicKey, pokeMint: good.publicKey }),
  ]);
  assert.equal(failed(set), false, `set_poke_mint failed ${customError(set)}`);
  assert.equal(storedMint(svm).equals(good.publicKey), true);
  assertError(send(svm, authority, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: authority.publicKey, pokeMint: good.publicKey }),
  ]), POKE_ALREADY_SET);
});

test('POKE deposit and burn work after the mint is configured', { skip: !svmReady() && (loadError ?? 'artifact missing') }, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const player = Keypair.generate();
  const mint = Keypair.generate();
  fund(svm, authority.publicKey);
  fund(svm, keeper.publicKey);
  fund(svm, player.publicKey);
  init(svm, authority, keeper.publicKey, PublicKey.default);
  installMint(svm, mint.publicKey, 6);
  const set = send(svm, authority, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: authority.publicKey, pokeMint: mint.publicKey }),
  ]);
  assert.equal(failed(set), false, `set_poke_mint failed ${customError(set)}`);

  const playerPoke = Keypair.generate();
  svm.setAccount(playerPoke.publicKey, {
    lamports: Number(svm.minimumBalanceForRentExemption(165n)),
    data: tokenAccount(mint.publicKey, player.publicKey, 10_000_000_000n),
    owner: TOKEN_2022_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
  const tournamentId = createHash('sha256').update('live-tour').digest().subarray(0, 16);
  const quoteId = createHash('sha256').update('live-quote').digest();
  const INVALID_AMOUNT = 6000;
  assertError(send(svm, player, [
    depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: player.publicKey,
      config: configPda(PROGRAM_ID)[0],
      pokeMint: mint.publicKey,
      playerPoke: playerPoke.publicKey,
      tournamentId,
      amount: 1n,
      quoteId,
      priceMicroUsd: 1_000,
    }),
  ]), INVALID_AMOUNT);
  const deposited = send(svm, player, [
    depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: player.publicKey,
      config: configPda(PROGRAM_ID)[0],
      pokeMint: mint.publicKey,
      playerPoke: playerPoke.publicKey,
      tournamentId,
      amount: 10_000_000_000n,
      quoteId,
      priceMicroUsd: 1_000,
    }),
  ]);
  assert.equal(failed(deposited), false, `deposit failed ${customError(deposited)} ${errText(deposited)}`);
  const burnKey = createHash('sha256').update('live-burn').digest();
  const burned = send(svm, keeper, [
    burnPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configPda(PROGRAM_ID)[0],
      pokeMint: mint.publicKey,
      player: player.publicKey,
      tournamentId,
      burnKey,
    }),
  ]);
  assert.equal(failed(burned), false, `burn failed ${customError(burned)} ${errText(burned)}`);
  const burnedAgain = send(svm, keeper, [
    burnPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configPda(PROGRAM_ID)[0],
      pokeMint: mint.publicKey,
      player: player.publicKey,
      tournamentId,
      burnKey,
    }),
  ]);
  assert.equal(failed(burnedAgain), true);
});

function errText(result: unknown): string {
  try {
    const meta = (result as { meta?: () => { logs?: () => string[] } }).meta?.();
    return (meta?.logs?.() ?? []).join(' | ');
  } catch {
    return '';
  }
}
