/**
 * LiteSVM coverage for the CARDS rail on the fresh Pinocchio program.
 * Instruction bytes come from the existing client builders.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync } from 'node:fs';
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
  anchorDiscriminator,
  cardsOperatorAuthorityPda,
  cardsOperatorVaultPda,
  cardsPrizeReservePda,
  cardsPrizeVaultPda,
  cardsTreasuryAuthorityPda,
  cardsTreasuryVaultPda,
  chargeMatchFeeIx,
  claimCardsOperatorIx,
  claimFeeVaultIx,
  closeFinalCardsPrizeIx,
  closeSettledMatchIx,
  configPda,
  decodeConfigAccount,
  createMatchEscrowIx,
  depositSolWagerIx,
  feeVaultPda,
  fundCardsPrizeFromTreasuryIx,
  fundCardsPrizeIx,
  initCardsRewardVaultsIx,
  initializeConfigIx,
  payCardsPrizeIx,
  releaseCardsPrizeIx,
  replayPda,
  seatMatchOpponentIx,
  setCardsMintIx,
  setCardsPrizeWinnerIx,
  settleMatchWinIx,
} from '../src/index';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/token';

const PROGRAM_ID = new PublicKey(process.env.CARDS_PROGRAM_ID ?? '6dHMWQd1M2ZZSmrkQLGZcFpHnvHi8rcH68QqQJ4Kj4r8');
const SO_PATH = process.env.CARDS_SO
  ?? join(__dirname, '../../../../target/deploy/arena_escrow_pinocchio.so');
const UNAUTHORIZED = 6002;
const INVALID_MATCH = 6006;
const INVALID_PRIZE = 6010;
const WINNER_ALREADY = 6011;
const INVALID_AMOUNT = 6000;

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
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error);
}

function svmReady(): boolean {
  return Boolean(LiteSVM && existsSync(SO_PATH));
}

function loadSvm(): Svm {
  if (!LiteSVM) throw new Error(loadError ?? 'litesvm unavailable');
  const localSo = join(tmpdir(), `${basename(SO_PATH)}.cards.${process.pid}.${Date.now()}.so`);
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

function assertError(result: unknown, code: number): void {
  assert.equal(failed(result), true, logs(result));
  assert.equal(customError(result), code, logs(result));
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

function installMint(svm: Svm, mint: PublicKey, owner = TOKEN_PROGRAM_ID): void {
  svm.setAccount(mint, {
    lamports: Number(svm.minimumBalanceForRentExemption(82n)),
    data: mintData(),
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

function installToken(svm: Svm, address: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint): void {
  svm.setAccount(address, {
    lamports: Number(svm.minimumBalanceForRentExemption(165n)),
    data: tokenAccount(mint, owner, amount),
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
}

function tokenAmount(svm: Svm, address: PublicKey): bigint {
  const account = svm.getAccount(address);
  assert.ok(account, `${address.toBase58()} missing`);
  const data = Buffer.from(account.data);
  return data.readBigUInt64LE(64);
}

function boot(svm: Svm, authority: Keypair, keeper: PublicKey, cardsMint: PublicKey): void {
  fund(svm, authority.publicKey);
  const init = send(svm, authority, [
    initializeConfigIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      pokeMint: PublicKey.default,
      quoteAuthority: authority.publicKey,
      keeper,
      buybackBps: 0,
      minBuybackLamports: 50_000_000,
    }),
    setCardsMintIx({ programId: PROGRAM_ID, authority: authority.publicKey, cardsMint }),
  ]);
  assert.equal(failed(init), false, logs(init));
  const config = svm.getAccount(configPda(PROGRAM_ID)[0]);
  assert.ok(config, 'config account missing after initialization');
  assert.equal(config.owner.toBase58(), PROGRAM_ID.toBase58());
  assert.equal(config.data.length, 305);
  assert.equal(decodeConfigAccount(config.data).cardsMint, cardsMint.toBase58());
}

test('client CARDS builders keep proven discriminators, PDAs, and classic SPL', () => {
  const names: Array<[keyof typeof IX, string]> = [
    ['setCardsMint', 'set_cards_mint'],
    ['fundCardsPrize', 'fund_cards_prize'],
    ['setCardsPrizeWinner', 'set_cards_prize_winner'],
    ['payCardsPrize', 'pay_cards_prize'],
    ['releaseCardsPrize', 'release_cards_prize'],
    ['fundCardsPrizeFromTreasury', 'fund_cards_prize_from_treasury'],
    ['initCardsRewardVaults', 'init_cards_reward_vaults'],
    ['claimCardsOperator', 'claim_cards_operator'],
    ['closeFinalCardsPrize', 'close_final_cards_prize'],
    ['claimFeeVault', 'claim_fee_vault'],
    ['claimOperatorFees', 'claim_operator_fees'],
    ['closeSettledMatch', 'close_settled_match'],
    ['closeFinalEntry', 'close_final_entry'],
  ];
  for (const [key, name] of names) {
    assert.deepEqual(IX[key], anchorDiscriminator(name));
  }
  const tournamentId = Buffer.alloc(16, 7);
  const fundingKey = Buffer.alloc(32, 9);
  const fund = fundCardsPrizeIx({
    programId: PROGRAM_ID,
    fundingAuthority: Keypair.generate().publicKey,
    config: configPda(PROGRAM_ID)[0],
    cardsMint: Keypair.generate().publicKey,
    fundingCards: Keypair.generate().publicKey,
    tournamentId,
    amount: 100n,
    fundingKey,
  });
  assert.equal(fund.keys[7].pubkey.equals(TOKEN_PROGRAM_ID), true);
  assert.equal(fund.keys[8].pubkey.equals(SystemProgram.programId), true);
  assert.deepEqual(fund.keys[4].pubkey.toBytes(), cardsPrizeReservePda(PROGRAM_ID, tournamentId)[0].toBytes());
  assert.deepEqual(fund.keys[5].pubkey.toBytes(), cardsPrizeVaultPda(PROGRAM_ID, tournamentId)[0].toBytes());
  assert.equal(fund.data.length, 8 + 16 + 8 + 32);
  const pay = payCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: Keypair.generate().publicKey,
    config: configPda(PROGRAM_ID)[0],
    cardsMint: Keypair.generate().publicKey,
    winner: Keypair.generate().publicKey,
    winnerCards: Keypair.generate().publicKey,
    tournamentId,
    settlementKey: fundingKey,
  });
  assert.equal(pay.keys.length, 10);
  assert.equal(pay.keys[8].pubkey.equals(TOKEN_PROGRAM_ID), true);
  assert.equal(pay.keys[4].isWritable, false);
});

test('atomic initialization stores the configured CARDS mint in the 305-byte config', { skip: !svmReady() && (loadError ?? 'artifact missing') }, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const cardsMint = Keypair.generate().publicKey;
  installMint(svm, cardsMint);

  boot(svm, authority, keeper.publicKey, cardsMint);

  const config = svm.getAccount(configPda(PROGRAM_ID)[0]);
  assert.ok(config);
  assert.equal(decodeConfigAccount(config.data).cardsMint, cardsMint.toBase58());
});

test('CARDS fund, pay, release, treasury, fee claim, and match close', { skip: !svmReady() && (loadError ?? 'artifact missing') }, () => {
  const svm = loadSvm();
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const stranger = Keypair.generate();
  const player = Keypair.generate();
  const mint = Keypair.generate();
  const otherMint = Keypair.generate();
  fund(svm, keeper.publicKey);
  fund(svm, stranger.publicKey);
  fund(svm, player.publicKey);
  installMint(svm, mint.publicKey);
  installMint(svm, otherMint.publicKey);
  boot(svm, authority, keeper.publicKey, mint.publicKey);

  const config = svm.getAccount(configPda(PROGRAM_ID)[0]);
  assert.ok(config);
  assert.equal(config.data.length, 305);
  assert.deepEqual(Buffer.from(config.data.subarray(136, 168)), Buffer.alloc(32));
  assert.deepEqual(Buffer.from(config.data.subarray(273, 305)), mint.publicKey.toBuffer());

  const tournamentId = createHash('sha256').update('cards-cup').digest().subarray(0, 16);
  const fundingKey = createHash('sha256').update('cards-fund').digest();
  const keeperCards = Keypair.generate().publicKey;
  installToken(svm, keeperCards, mint.publicKey, keeper.publicKey, 1_000n);
  const configAddress = configPda(PROGRAM_ID)[0];

  assertError(send(svm, stranger, [
    fundCardsPrizeIx({
      programId: PROGRAM_ID,
      fundingAuthority: stranger.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      fundingCards: keeperCards,
      tournamentId,
      amount: 100n,
      fundingKey,
    }),
  ]), UNAUTHORIZED);

  assertError(send(svm, keeper, [
    fundCardsPrizeIx({
      programId: PROGRAM_ID,
      fundingAuthority: keeper.publicKey,
      config: configAddress,
      cardsMint: otherMint.publicKey,
      fundingCards: keeperCards,
      tournamentId,
      amount: 100n,
      fundingKey,
    }),
  ]), UNAUTHORIZED);

  const wrongProgram = fundCardsPrizeIx({
    programId: PROGRAM_ID,
    fundingAuthority: keeper.publicKey,
    config: configAddress,
    cardsMint: mint.publicKey,
    fundingCards: keeperCards,
    tournamentId,
    amount: 100n,
    fundingKey,
  });
  wrongProgram.keys[7].pubkey = TOKEN_2022_PROGRAM_ID;
  assert.equal(failed(send(svm, keeper, [wrongProgram])), true);

  const funded = send(svm, keeper, [
    fundCardsPrizeIx({
      programId: PROGRAM_ID,
      fundingAuthority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      fundingCards: keeperCards,
      tournamentId,
      amount: 100n,
      fundingKey,
    }),
  ]);
  assert.equal(failed(funded), false, logs(funded));
  const reserveAddress = cardsPrizeReservePda(PROGRAM_ID, tournamentId)[0];
  const vaultAddress = cardsPrizeVaultPda(PROGRAM_ID, tournamentId)[0];
  const reserve = svm.getAccount(reserveAddress);
  const vault = svm.getAccount(vaultAddress);
  assert.ok(reserve && vault);
  assert.equal(reserve.data.length, 163);
  assert.equal(vault.data.length, 165);
  assert.equal(vault.owner.equals(TOKEN_PROGRAM_ID), true);
  assert.equal(Buffer.from(reserve.data.subarray(24, 56)).equals(keeper.publicKey.toBuffer()), true);
  assert.equal(Buffer.from(reserve.data).readBigUInt64LE(88), 100n);
  assert.equal(reserve.data[96], 0);
  assert.equal(reserve.data[97], 0);
  assert.deepEqual(Buffer.from(reserve.data.subarray(99, 131)), Buffer.from(fundingKey));
  assert.deepEqual(Buffer.from(reserve.data.subarray(131, 163)), Buffer.alloc(32));
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, fundingKey)[0])?.data[40], 6);
  assert.equal(tokenAmount(svm, vaultAddress), 100n);
  assert.equal(tokenAmount(svm, keeperCards), 900n);

  const again = send(svm, keeper, [
    fundCardsPrizeIx({
      programId: PROGRAM_ID,
      fundingAuthority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      fundingCards: keeperCards,
      tournamentId,
      amount: 100n,
      fundingKey: createHash('sha256').update('other-key').digest(),
    }),
  ]);
  assert.equal(failed(again), true, 'duplicate reserve must fail');

  const winnerSet = send(svm, keeper, [
    setCardsPrizeWinnerIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      winner: keeper.publicKey,
      tournamentId,
    }),
  ]);
  assert.equal(failed(winnerSet), false, logs(winnerSet));
  assert.equal(svm.getAccount(reserveAddress)?.data[97], 1);

  assertError(send(svm, keeper, [
    releaseCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      funderCards: keeperCards,
      tournamentId,
    }),
  ]), WINNER_ALREADY);

  const settlementKey = createHash('sha256').update('cards-pay').digest();
  const paid = send(svm, keeper, [
    payCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      winner: keeper.publicKey,
      winnerCards: keeperCards,
      tournamentId,
      settlementKey,
    }),
  ]);
  assert.equal(failed(paid), false, logs(paid));
  assert.equal(tokenAmount(svm, vaultAddress), 0n);
  assert.equal(tokenAmount(svm, keeperCards), 1_000n);
  const paidReserve = svm.getAccount(reserveAddress);
  assert.equal(paidReserve?.data[96], 1);
  assert.deepEqual(Buffer.from(paidReserve!.data.subarray(131, 163)), Buffer.from(settlementKey));
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, settlementKey)[0])?.data[40], 7);

  assertError(send(svm, keeper, [
    payCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      winner: keeper.publicKey,
      winnerCards: keeperCards,
      tournamentId,
      settlementKey: createHash('sha256').update('second-pay').digest(),
    }),
  ]), INVALID_PRIZE);

  const replayPay = send(svm, keeper, [
    payCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      winner: keeper.publicKey,
      winnerCards: keeperCards,
      tournamentId,
      settlementKey,
    }),
  ]);
  assert.equal(failed(replayPay), true);

  const first = Keypair.generate().publicKey;
  const second = Keypair.generate().publicKey;
  const third = Keypair.generate().publicKey;
  installToken(svm, first, mint.publicKey, player.publicKey, 0n);
  installToken(svm, second, mint.publicKey, player.publicKey, 0n);
  installToken(svm, third, mint.publicKey, player.publicKey, 0n);
  const shares = { first: 50n, second: 35n, third: 15n };
  const split = send(svm, keeper, [50n, 35n, 15n].map((amount, index) => {
    const destination = [first, second, third][index]!;
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(amount, 1);
    return new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: keeperCards, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });
  }));
  assert.equal(failed(split), false, logs(split));
  assert.equal(tokenAmount(svm, first), shares.first);
  assert.equal(tokenAmount(svm, second), shares.second);
  assert.equal(tokenAmount(svm, third), shares.third);
  assert.equal(tokenAmount(svm, keeperCards), 900n);

  const closed = send(svm, keeper, [
    closeFinalCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: authority.publicKey,
      cardsMint: mint.publicKey,
      tournamentId,
      fundingKey,
      payoutKey: settlementKey,
    }),
  ]);
  assert.equal(failed(closed), false, logs(closed));
  assert.equal(svm.getAccount(vaultAddress), null);
  assert.equal(svm.getAccount(reserveAddress)?.lamports ?? 0, 0);

  const releaseId = createHash('sha256').update('cards-release').digest().subarray(0, 16);
  const releaseKey = createHash('sha256').update('cards-release-fund').digest();
  const released = send(svm, keeper, [
    fundCardsPrizeIx({
      programId: PROGRAM_ID,
      fundingAuthority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      fundingCards: keeperCards,
      tournamentId: releaseId,
      amount: 40n,
      fundingKey: releaseKey,
    }),
  ]);
  assert.equal(failed(released), false, logs(released));
  const giveBack = send(svm, keeper, [
    releaseCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      funderCards: keeperCards,
      tournamentId: releaseId,
    }),
  ]);
  assert.equal(failed(giveBack), false, logs(giveBack));
  const releaseReserve = cardsPrizeReservePda(PROGRAM_ID, releaseId)[0];
  assert.equal(svm.getAccount(releaseReserve)?.data[96], 2);
  assert.equal(tokenAmount(svm, cardsPrizeVaultPda(PROGRAM_ID, releaseId)[0]), 0n);
  assertError(send(svm, keeper, [
    releaseCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      funderCards: keeperCards,
      tournamentId: releaseId,
    }),
  ]), INVALID_PRIZE);
  const releaseClosed = send(svm, keeper, [
    closeFinalCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: authority.publicKey,
      cardsMint: mint.publicKey,
      tournamentId: releaseId,
      fundingKey: releaseKey,
      payoutKey: createHash('sha256').update('no-pay').digest(),
    }),
  ]);
  assert.equal(failed(releaseClosed), false, logs(releaseClosed));

  const vaults = send(svm, authority, [
    initCardsRewardVaultsIx({
      programId: PROGRAM_ID,
      payer: authority.publicKey,
      cardsMint: mint.publicKey,
    }),
  ]);
  assert.equal(failed(vaults), false, logs(vaults));
  const treasuryVault = cardsTreasuryVaultPda(PROGRAM_ID)[0];
  const treasuryAuthority = cardsTreasuryAuthorityPda(PROGRAM_ID)[0];
  const operatorVault = cardsOperatorVaultPda(PROGRAM_ID)[0];
  const operatorAuthority = cardsOperatorAuthorityPda(PROGRAM_ID)[0];
  assert.equal(svm.getAccount(treasuryVault)?.owner.equals(TOKEN_PROGRAM_ID), true);
  assert.equal(svm.getAccount(operatorVault)?.owner.equals(TOKEN_PROGRAM_ID), true);
  installToken(svm, treasuryVault, mint.publicKey, treasuryAuthority, 250n);
  installToken(svm, operatorVault, mint.publicKey, operatorAuthority, 80n);

  const treasuryId = createHash('sha256').update('treasury-cup').digest().subarray(0, 16);
  const treasuryFunded = send(svm, keeper, [
    fundCardsPrizeFromTreasuryIx({
      programId: PROGRAM_ID,
      fundingAuthority: keeper.publicKey,
      cardsMint: mint.publicKey,
      tournamentId: treasuryId,
      amount: 100n,
      fundingKey: createHash('sha256').update('treasury-fund').digest(),
    }),
  ]);
  assert.equal(failed(treasuryFunded), false, logs(treasuryFunded));
  assert.equal(tokenAmount(svm, cardsPrizeVaultPda(PROGRAM_ID, treasuryId)[0]), 100n);
  assert.equal(tokenAmount(svm, treasuryVault), 150n);
  const treasuryReserve = svm.getAccount(cardsPrizeReservePda(PROGRAM_ID, treasuryId)[0]);
  assert.ok(treasuryReserve);
  assert.equal(Buffer.from(treasuryReserve.data.subarray(24, 56)).equals(treasuryVault.toBuffer()), true);
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, createHash('sha256').update('treasury-fund').digest())[0])?.data[40], 10);

  const destination = Keypair.generate().publicKey;
  installToken(svm, destination, mint.publicKey, authority.publicKey, 0n);
  const claimKey = createHash('sha256').update('operator-claim').digest();
  const claimed = send(svm, authority, [
    claimCardsOperatorIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      cardsMint: mint.publicKey,
      destination,
      amount: 30n,
      claimKey,
    }),
  ]);
  assert.equal(failed(claimed), false, logs(claimed));
  assert.equal(tokenAmount(svm, destination), 30n);
  assert.equal(tokenAmount(svm, operatorVault), 50n);
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, claimKey)[0])?.data[40], 9);
  assert.equal(failed(send(svm, keeper, [
    claimCardsOperatorIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      cardsMint: mint.publicKey,
      destination,
      amount: 30n,
      claimKey,
    }),
  ])), true);

  const roomId = createHash('sha256').update('fee-room').digest().subarray(0, 16);
  const settlement = createHash('sha256').update('fee-room-win').digest();
  const opened = send(svm, player, [
    createMatchEscrowIx({
      programId: PROGRAM_ID,
      creator: player.publicKey,
      config: configAddress,
      roomId,
      collateralLamports: 1_000_000,
    }),
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: player.publicKey,
      roomId,
      side: 0,
    }),
  ]);
  assert.equal(failed(opened), false, logs(opened));
  assert.equal(failed(send(svm, keeper, [
    seatMatchOpponentIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      opponent: stranger.publicKey,
      roomId,
    }),
  ])), false);
  assert.equal(failed(send(svm, stranger, [
    depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: stranger.publicKey,
      roomId,
      side: 1,
    }),
  ])), false);
  const feeVault = feeVaultPda(PROGRAM_ID)[0];
  const beforeFee = svm.getAccount(feeVault)?.lamports ?? 0;
  assert.equal(failed(send(svm, keeper, [
    chargeMatchFeeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      feeVault,
      roomId,
    }),
  ])), false);
  const afterFee = svm.getAccount(feeVault)?.lamports ?? 0;
  const fee = afterFee - beforeFee;
  assert.ok(fee > 0);
  const feeClaimKey = createHash('sha256').update('fee-claim').digest();
  const feeClaim = send(svm, authority, [
    claimFeeVaultIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      feeVault,
      destination: authority.publicKey,
      claimKey: feeClaimKey,
    }),
  ]);
  assert.equal(failed(feeClaim), false, logs(feeClaim));
  assert.equal((svm.getAccount(feeVault)?.lamports ?? 0), beforeFee);
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, feeClaimKey)[0])?.data[40], 8);
  assert.equal(failed(send(svm, authority, [
    claimFeeVaultIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      feeVault,
      destination: authority.publicKey,
      claimKey: feeClaimKey,
    }),
  ])), true);

  assertError(send(svm, stranger, [
    closeSettledMatchIx({
      programId: PROGRAM_ID,
      authority: stranger.publicKey,
      recipient: stranger.publicKey,
      roomId,
      settlementKey: settlement,
    }),
  ]), UNAUTHORIZED);
  assertError(send(svm, keeper, [
    closeSettledMatchIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: player.publicKey,
      roomId,
      settlementKey: settlement,
    }),
  ]), INVALID_MATCH);
  assertError(send(svm, keeper, [
    closeSettledMatchIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: keeper.publicKey,
      roomId,
      settlementKey: settlement,
    }),
  ]), UNAUTHORIZED);
  assert.equal(failed(send(svm, keeper, [
    settleMatchWinIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      winner: player.publicKey,
      roomId,
      settlementKey: settlement,
    }),
  ])), false);
  const matchClosed = send(svm, keeper, [
    closeSettledMatchIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: player.publicKey,
      roomId,
      settlementKey: settlement,
    }),
  ]);
  assert.equal(failed(matchClosed), false, logs(matchClosed));
  assert.equal(svm.getAccount(replayPda(PROGRAM_ID, settlement)[0])?.lamports ?? 0, 0);

  const storedId = createHash('sha256').update('stored-amount').digest().subarray(0, 16);
  const storedKey = createHash('sha256').update('stored-amount-fund').digest();
  const beforeStored = tokenAmount(svm, keeperCards);
  assert.equal(failed(send(svm, keeper, [
    fundCardsPrizeIx({
      programId: PROGRAM_ID,
      fundingAuthority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      fundingCards: keeperCards,
      tournamentId: storedId,
      amount: 10n,
      fundingKey: storedKey,
    }),
  ])), false);
  const storedVault = cardsPrizeVaultPda(PROGRAM_ID, storedId)[0];
  const storedOwner = new PublicKey(Buffer.from(svm.getAccount(storedVault)!.data.subarray(32, 64)));
  installToken(svm, storedVault, mint.publicKey, storedOwner, 15n);
  assert.equal(failed(send(svm, keeper, [
    releaseCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config: configAddress,
      cardsMint: mint.publicKey,
      funderCards: keeperCards,
      tournamentId: storedId,
    }),
  ])), false);
  assert.equal(tokenAmount(svm, storedVault), 5n);
  assert.equal(tokenAmount(svm, keeperCards), beforeStored);

  assertError(send(svm, keeper, [
    claimCardsOperatorIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      cardsMint: mint.publicKey,
      destination,
      amount: 0n,
      claimKey: createHash('sha256').update('zero').digest(),
    }),
  ]), INVALID_AMOUNT);
});
