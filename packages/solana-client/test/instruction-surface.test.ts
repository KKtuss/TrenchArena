/**
 * Release certification: every canonical client instruction exists on the
 * fresh program and executes. Fails if CARDS handlers are missing.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
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
  TransactionInstruction,
} from '@solana/web3.js';
import {
  IX,
  REQUIRED_CARDS_INSTRUCTIONS,
  REQUIRED_PROGRAM_INSTRUCTIONS,
  burnPokeEntryIx,
  buybackAndBurnPokeIx,
  chargeMatchFeeIx,
  claimOperatorFeesIx,
  closeFinalEntryIx,
  closeSettledMatchIx,
  configPda,
  createMatchEscrowIx,
  depositPokeEntryIx,
  depositSolWagerIx,
  depositTreasurySolIx,
  entryEscrowPda,
  feeVaultPda,
  initializeConfigIx,
  instructionSurfaceManifest,
  operatorVaultPda,
  replayPda,
  payPrizeIx,
  refundPokeEntryIx,
  refundSolWagerIx,
  releasePrizeIx,
  reservePrizeIx,
  seatMatchOpponentIx,
  setPokeMintIx,
  setPrizeWinnerIx,
  settleMatchTieIx,
  settleMatchWinIx,
  treasuryVaultPda,
} from '../src/index';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/token';
import { TOURNAMENT_BURN_FEE_ATOMS } from '../src/poke-units';

const PROGRAM_ID = new PublicKey('6dHMWQd1M2ZZSmrkQLGZcFpHnvHi8rcH68QqQJ4Kj4r8');
const SO_PATH = join(__dirname, '../../../../target/deploy/arena_escrow_pinocchio.so');
const UNAUTHORIZED = 6002;

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
  getAccount: (address: PublicKey) => { data: Uint8Array; lamports: number; owner: PublicKey } | null;
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
} catch (e) {
  loadError = e instanceof Error ? e.message : String(e);
}

function svmReady(): boolean {
  return Boolean(LiteSVM && existsSync(SO_PATH));
}

function loadSvm(): Svm {
  if (!LiteSVM) throw new Error(loadError || 'litesvm unavailable');
  const local = join(tmpdir(), `${basename(SO_PATH)}.${process.pid}.${Date.now()}.so`);
  copyFileSync(SO_PATH, local);
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM_ID, local);
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

function logs(result: unknown): string {
  try {
    const meta = (result as { meta?: () => { logs?: () => string[] } }).meta?.();
    return (meta?.logs?.() ?? []).join(' | ');
  } catch {
    return '';
  }
}

function customError(result: unknown): number | null {
  const match = logs(result).match(/custom program error: 0x([0-9a-f]+)/i);
  return match ? Number.parseInt(match[1], 16) : null;
}

function fund(svm: Svm, key: PublicKey, sol = 20): void {
  svm.airdrop(key, BigInt(sol * LAMPORTS_PER_SOL));
}

function mintData(): Buffer {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(1_000_000_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  return data;
}

function installMint(svm: Svm, mint: PublicKey): void {
  svm.setAccount(mint, {
    lamports: Number(svm.minimumBalanceForRentExemption(82n)),
    data: mintData(),
    owner: TOKEN_2022_PROGRAM_ID,
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

function installToken(svm: Svm, address: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint): void {
  svm.setAccount(address, {
    lamports: Number(svm.minimumBalanceForRentExemption(165n)),
    data: tokenAccount(mint, owner, amount),
    owner: TOKEN_2022_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
}

test('canonical client instruction surface matches the frozen program list', () => {
  const clientKeys = Object.keys(IX).sort();
  const required = [...REQUIRED_PROGRAM_INSTRUCTIONS].sort();
  assert.deepEqual(clientKeys, required);
  for (const name of REQUIRED_CARDS_INSTRUCTIONS) {
    assert.equal(name in IX, true, `missing CARDS instruction ${name}`);
    assert.equal(IX[name].length, 8);
  }
  const manifest = instructionSurfaceManifest();
  assert.equal(manifest.instructions.length, 31);
  const outDir = join(__dirname, '../../../../scripts/solana/parity-out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'instruction-surface.json'), `${JSON.stringify(manifest, null, 2)}\n`);
});

test('fresh program dispatches every canonical client discriminator', {
  skip: !svmReady() && (loadError ?? 'artifact missing'),
}, () => {
  const svm = loadSvm();
  const payer = Keypair.generate();
  fund(svm, payer.publicKey);
  for (const name of REQUIRED_PROGRAM_INSTRUCTIONS) {
    const result = send(svm, payer, [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [],
        data: Buffer.from(IX[name]),
      }),
    ]);
    assert.equal(failed(result), true, `${name} should not succeed with zero accounts`);
    assert.equal(
      /invalid instruction data/i.test(logs(result)),
      false,
      `${name} is missing from program dispatch: ${logs(result)}`,
    );
  }
  const unknown = send(svm, payer, [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [],
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    }),
  ]);
  assert.equal(failed(unknown), true);
  assert.equal(/invalid instruction data/i.test(logs(unknown)), true, logs(unknown));
});

test('canonical SOL, POKE, and admin instructions execute', {
  skip: !svmReady() && (loadError ?? 'artifact missing'),
}, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const player = Keypair.generate();
  const opponent = Keypair.generate();
  const mint = Keypair.generate();
  fund(svm, authority.publicKey);
  fund(svm, keeper.publicKey);
  fund(svm, player.publicKey);
  fund(svm, opponent.publicKey);
  installMint(svm, mint.publicKey);

  const init = send(svm, authority, [
    initializeConfigIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      pokeMint: PublicKey.default,
      quoteAuthority: authority.publicKey,
      keeper: keeper.publicKey,
      buybackBps: 2500,
      minBuybackLamports: 1,
    }),
  ]);
  assert.equal(failed(init), false, logs(init));
  const config = configPda(PROGRAM_ID)[0];
  assert.equal(svm.getAccount(config)?.data.length, 305);

  const setMint = send(svm, authority, [
    setPokeMintIx({ programId: PROGRAM_ID, authority: authority.publicKey, pokeMint: mint.publicKey }),
  ]);
  assert.equal(failed(setMint), false, logs(setMint));
  const feeVault = feeVaultPda(PROGRAM_ID)[0];
  assert.equal(failed(send(svm, authority, [
    SystemProgram.transfer({
      fromPubkey: authority.publicKey,
      toPubkey: feeVault,
      lamports: 2_000_000,
    }),
  ])), false);

  const refundRoom = createHash('sha256').update('refund-room').digest().subarray(0, 16);
  assert.equal(failed(send(svm, player, [
    createMatchEscrowIx({
      programId: PROGRAM_ID,
      creator: player.publicKey,
      config,
      roomId: refundRoom,
      collateralLamports: 1_000_000,
    }),
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: player.publicKey,
      roomId: refundRoom,
      side: 0,
    }),
  ])), false);
  const refunded = send(svm, keeper, [
    refundSolWagerIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      recipient: player.publicKey,
      roomId: refundRoom,
      side: 0,
    }),
  ]);
  assert.equal(failed(refunded), false, logs(refunded));

  const tieRoom = createHash('sha256').update('tie-room').digest().subarray(0, 16);
  assert.equal(failed(send(svm, player, [
    createMatchEscrowIx({
      programId: PROGRAM_ID,
      creator: player.publicKey,
      config,
      roomId: tieRoom,
      collateralLamports: 1_000_000,
    }),
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: player.publicKey,
      roomId: tieRoom,
      side: 0,
    }),
  ])), false);
  assert.equal(failed(send(svm, keeper, [
    seatMatchOpponentIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      opponent: opponent.publicKey,
      roomId: tieRoom,
    }),
  ])), false);
  assert.equal(failed(send(svm, opponent, [
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: opponent.publicKey,
      roomId: tieRoom,
      side: 1,
    }),
  ])), false);
  const tied = send(svm, keeper, [
    settleMatchTieIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      creator: player.publicKey,
      opponent: opponent.publicKey,
      roomId: tieRoom,
      settlementKey: createHash('sha256').update('tie-key').digest(),
    }),
  ]);
  assert.equal(failed(tied), false, logs(tied));

  const winRoom = createHash('sha256').update('win-room').digest().subarray(0, 16);
  const winKey = createHash('sha256').update('win-key').digest();
  assert.equal(failed(send(svm, player, [
    createMatchEscrowIx({
      programId: PROGRAM_ID,
      creator: player.publicKey,
      config,
      roomId: winRoom,
      collateralLamports: 1_000_000,
    }),
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: player.publicKey,
      roomId: winRoom,
      side: 0,
    }),
  ])), false);
  assert.equal(failed(send(svm, keeper, [
    seatMatchOpponentIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      opponent: opponent.publicKey,
      roomId: winRoom,
    }),
  ])), false);
  assert.equal(failed(send(svm, opponent, [
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: opponent.publicKey,
      roomId: winRoom,
      side: 1,
    }),
  ])), false);
  const charged = send(svm, keeper, [
    chargeMatchFeeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      feeVault,
      roomId: winRoom,
    }),
  ]);
  assert.equal(failed(charged), false, logs(charged));
  const replayed = send(svm, keeper, [
    settleMatchWinIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      winner: player.publicKey,
      roomId: winRoom,
      settlementKey: winKey,
    }),
  ]);
  assert.equal(failed(replayed), false, logs(replayed));
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, winKey)[0])?.data[40], 0);
  const closedMatch = send(svm, keeper, [
    closeSettledMatchIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: player.publicKey,
      roomId: winRoom,
      settlementKey: winKey,
    }),
  ]);
  assert.equal(failed(closedMatch), false, logs(closedMatch));
  const secondWin = send(svm, keeper, [
    settleMatchWinIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      winner: player.publicKey,
      roomId: winRoom,
      settlementKey: winKey,
    }),
  ]);
  assert.equal(failed(secondWin), true);

  const playerPoke = Keypair.generate().publicKey;
  installToken(svm, playerPoke, mint.publicKey, player.publicKey, BigInt(TOURNAMENT_BURN_FEE_ATOMS) * 3n);
  const refundTour = createHash('sha256').update('refund-tour').digest().subarray(0, 16);
  const quote = createHash('sha256').update('quote').digest();
  const wrongAmount = send(svm, player, [
    depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: player.publicKey,
      config,
      pokeMint: mint.publicKey,
      playerPoke,
      tournamentId: refundTour,
      amount: 1n,
      quoteId: quote,
      priceMicroUsd: 400_000,
    }),
  ]);
  assert.equal(failed(wrongAmount), true);
  assert.equal(customError(wrongAmount), 6000);
  const classicSpl = depositPokeEntryIx({
    programId: PROGRAM_ID,
    player: player.publicKey,
    config,
    pokeMint: mint.publicKey,
    playerPoke,
    tournamentId: refundTour,
    amount: BigInt(TOURNAMENT_BURN_FEE_ATOMS),
    quoteId: quote,
    priceMicroUsd: 400_000,
  });
  classicSpl.keys[6].pubkey = TOKEN_PROGRAM_ID;
  assert.equal(failed(send(svm, player, [classicSpl])), true);
  const deposited = send(svm, player, [
    depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: player.publicKey,
      config,
      pokeMint: mint.publicKey,
      playerPoke,
      tournamentId: refundTour,
      amount: BigInt(TOURNAMENT_BURN_FEE_ATOMS),
      quoteId: quote,
      priceMicroUsd: 400_000,
    }),
  ]);
  assert.equal(failed(deposited), false, logs(deposited));
  const entryAccount = svm.getAccount(
    entryEscrowPda(PROGRAM_ID, refundTour, player.publicKey)[0],
  );
  assert.equal(entryAccount?.data.length, 138);
  assert.deepEqual(Buffer.from(entryAccount!.data.subarray(106, 138)), Buffer.alloc(32));
  const refundedEntry = send(svm, keeper, [
    refundPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      pokeMint: mint.publicKey,
      playerPoke,
      tournamentId: refundTour,
      player: player.publicKey,
    }),
  ]);
  assert.equal(failed(refundedEntry), false, logs(refundedEntry));
  const closedRefund = send(svm, keeper, [
    closeFinalEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: player.publicKey,
      tournamentId: refundTour,
      player: player.publicKey,
      burnKey: createHash('sha256').update('unused-refund-close').digest(),
    }),
  ]);
  assert.equal(failed(closedRefund), false, logs(closedRefund));

  const burnTour = createHash('sha256').update('burn-tour').digest().subarray(0, 16);
  assert.equal(failed(send(svm, player, [
    depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: player.publicKey,
      config,
      pokeMint: mint.publicKey,
      playerPoke,
      tournamentId: burnTour,
      amount: BigInt(TOURNAMENT_BURN_FEE_ATOMS),
      quoteId: createHash('sha256').update('quote-2').digest(),
      priceMicroUsd: 400_000,
    }),
  ])), false);
  const burnKey = createHash('sha256').update('burn-key').digest();
  const burned = send(svm, keeper, [
    burnPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      pokeMint: mint.publicKey,
      player: player.publicKey,
      tournamentId: burnTour,
      burnKey,
    }),
  ]);
  assert.equal(failed(burned), false, logs(burned));
  const burnedEntry = svm.getAccount(entryEscrowPda(PROGRAM_ID, burnTour, player.publicKey)[0]);
  assert.deepEqual(Buffer.from(burnedEntry!.data.subarray(106, 138)), Buffer.from(burnKey));
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, burnKey)[0])?.data[40], 2);
  const closedBurn = send(svm, keeper, [
    closeFinalEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: player.publicKey,
      tournamentId: burnTour,
      player: player.publicKey,
      burnKey,
    }),
  ]);
  assert.equal(failed(closedBurn), false, logs(closedBurn));

  const treasury = send(svm, authority, [
    depositTreasurySolIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      payer: authority.publicKey,
      config,
      treasuryVault: treasuryVaultPda(PROGRAM_ID)[0],
      operatorVault: operatorVaultPda(PROGRAM_ID)[0],
      claimKey: createHash('sha256').update('treasury-claim').digest(),
      grossLamports: 1_000_000,
    }),
  ]);
  assert.equal(failed(treasury), false, logs(treasury));
  const operatorVault = operatorVaultPda(PROGRAM_ID)[0];
  const beforeClaim = svm.getAccount(operatorVault)?.lamports ?? 0;
  const claimedOps = send(svm, authority, [
    claimOperatorFeesIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      operatorVault,
      destination: authority.publicKey,
    }),
  ]);
  assert.equal(failed(claimedOps), false, logs(claimedOps));
  assert.ok((svm.getAccount(operatorVault)?.lamports ?? 0) < beforeClaim);
  const stranger = Keypair.generate();
  fund(svm, stranger.publicKey);
  const denied = send(svm, keeper, [
    claimOperatorFeesIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      operatorVault,
      destination: keeper.publicKey,
    }),
  ]);
  assert.equal(failed(denied), true);
  assert.equal(customError(denied), UNAUTHORIZED);

  const prizeId = createHash('sha256').update('prize-tour').digest().subarray(0, 16);
  const reserved = send(svm, keeper, [
    reservePrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      treasuryVault: treasuryVaultPda(PROGRAM_ID)[0],
      tournamentId: prizeId,
      amount: 100_000,
    }),
  ]);
  assert.equal(failed(reserved), false, logs(reserved));
  assert.equal(failed(send(svm, keeper, [
    setPrizeWinnerIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      winner: player.publicKey,
      tournamentId: prizeId,
    }),
  ])), false);
  const paid = send(svm, keeper, [
    payPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      winner: player.publicKey,
      tournamentId: prizeId,
      settlementKey: createHash('sha256').update('prize-pay').digest(),
    }),
  ]);
  assert.equal(failed(paid), false, logs(paid));

  const releaseId = createHash('sha256').update('prize-release').digest().subarray(0, 16);
  assert.equal(failed(send(svm, keeper, [
    reservePrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      treasuryVault: treasuryVaultPda(PROGRAM_ID)[0],
      tournamentId: releaseId,
      amount: 50_000,
    }),
  ])), false);
  const released = send(svm, keeper, [
    releasePrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      treasuryVault: treasuryVaultPda(PROGRAM_ID)[0],
      tournamentId: releaseId,
    }),
  ]);
  assert.equal(failed(released), false, logs(released));

  const swapWallet = Keypair.generate();
  fund(svm, swapWallet.publicKey, 1);
  const burnSource = Keypair.generate().publicKey;
  installToken(svm, burnSource, mint.publicKey, authority.publicKey, 1_000_000n);
  const beforeFee = svm.getAccount(feeVault)?.lamports ?? 0;
  const beforeSwap = svm.getAccount(swapWallet.publicKey)?.lamports ?? 0;
  const buyback = send(svm, authority, [
    buybackAndBurnPokeIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      config,
      feeVault,
      swapWallet: swapWallet.publicKey,
      pokeMint: mint.publicKey,
      pokeBurnSource: burnSource,
      buybackKey: createHash('sha256').update('buyback').digest(),
      solAmount: 1_000_000,
      minPokeOut: 1,
    }),
  ]);
  assert.equal(failed(buyback), false, logs(buyback));
  const spend = Math.floor((1_000_000 * 2500) / 10_000);
  assert.equal(svm.getAccount(feeVault)?.lamports, beforeFee - spend);
  assert.equal(svm.getAccount(swapWallet.publicKey)?.lamports, beforeSwap + spend);
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, createHash('sha256').update('buyback').digest())[0])?.data[40], 5);
});
