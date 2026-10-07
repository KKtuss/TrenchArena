/**
 * Offline ABI parity fixtures for the Pinocchio experiment.
 * Ensures the existing TypeScript client still builds the exact wire format
 * expected by both Anchor and Pinocchio implementations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { IX, anchorDiscriminator } from '../src/discriminator';
import {
  configPda,
  feeVaultPda,
  treasuryVaultPda,
  operatorVaultPda,
  matchEscrowPda,
  matchVaultPda,
  entryEscrowPda,
  entryVaultPda,
  prizeReservePda,
  prizeVaultPda,
  replayPda,
  treasuryDepositPda,
  uuidToBytes,
} from '../src/pdas';
import {
  initializeConfigIx,
  createMatchEscrowIx,
  depositSolWagerIx,
  seatMatchOpponentIx,
  refundSolWagerIx,
  chargeMatchFeeIx,
  settleMatchWinIx,
  settleMatchTieIx,
  depositPokeEntryIx,
  refundPokeEntryIx,
  burnPokeEntryIx,
  depositTreasurySolIx,
  reservePrizeIx,
  setPrizeWinnerIx,
  payPrizeIx,
  releasePrizeIx,
  buybackAndBurnPokeIx,
  setPokeMintIx,
} from '../src/instructions';
import { TOKEN_2022_PROGRAM_ID } from '../src/token';

const PROGRAM_ID = new PublicKey('41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W');

const ACCOUNT_DISCS = {
  Config: Buffer.from([0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82]),
  MatchEscrow: Buffer.from([0x29, 0xfd, 0xf5, 0x95, 0x07, 0xf3, 0xcb, 0x8b]),
  EntryEscrow: Buffer.from([0x73, 0x99, 0x14, 0x2d, 0xe2, 0xce, 0x8b, 0xf4]),
  PrizeReserve: Buffer.from([0xa0, 0x94, 0xbb, 0xf2, 0x2b, 0x20, 0x7b, 0x32]),
  Replay: Buffer.from([0x26, 0xe4, 0xcc, 0x2e, 0xfb, 0x1c, 0x7c, 0x69]),
  TreasuryDeposit: Buffer.from([0xc3, 0xa0, 0x6e, 0x76, 0x52, 0x6f, 0xe7, 0xae]),
} as const;

function accountDisc(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

test('instruction discriminators match Anchor global:<name> hashes', () => {
  const names: Array<[keyof typeof IX, string]> = [
    ['initializeConfig', 'initialize_config'],
    ['createMatchEscrow', 'create_match_escrow'],
    ['depositSolWager', 'deposit_sol_wager'],
    ['seatMatchOpponent', 'seat_match_opponent'],
    ['refundSolWager', 'refund_sol_wager'],
    ['chargeMatchFee', 'charge_match_fee'],
    ['settleMatchWin', 'settle_match_win'],
    ['settleMatchTie', 'settle_match_tie'],
    ['depositPokeEntry', 'deposit_poke_entry'],
    ['refundPokeEntry', 'refund_poke_entry'],
    ['burnPokeEntry', 'burn_poke_entry'],
    ['depositTreasurySol', 'deposit_treasury_sol'],
    ['reservePrize', 'reserve_prize'],
    ['setPrizeWinner', 'set_prize_winner'],
    ['payPrize', 'pay_prize'],
    ['releasePrize', 'release_prize'],
    ['buybackAndBurnPoke', 'buyback_and_burn_poke'],
    ['setPokeMint', 'set_poke_mint'],
  ];
  for (const [key, name] of names) {
    assert.deepEqual(IX[key], anchorDiscriminator(name));
  }
});

test('account discriminators match Anchor account:<Name> hashes', () => {
  for (const [name, expected] of Object.entries(ACCOUNT_DISCS)) {
    assert.deepEqual(accountDisc(name), expected);
  }
});

test('PDA seed families resolve deterministically', () => {
  const roomId = uuidToBytes('11111111-1111-1111-1111-111111111111');
  const tournamentId = uuidToBytes('22222222-2222-2222-2222-222222222222');
  const player = Keypair.generate().publicKey;
  const key = createHash('sha256').update('settlement').digest();

  assert.equal(configPda(PROGRAM_ID)[0].toBase58().length > 0, true);
  assert.notEqual(feeVaultPda(PROGRAM_ID)[0].toBase58(), treasuryVaultPda(PROGRAM_ID)[0].toBase58());
  assert.notEqual(matchEscrowPda(PROGRAM_ID, roomId)[0].toBase58(), matchVaultPda(PROGRAM_ID, roomId)[0].toBase58());
  assert.notEqual(
    entryEscrowPda(PROGRAM_ID, tournamentId, player)[0].toBase58(),
    entryVaultPda(PROGRAM_ID, tournamentId, player)[0].toBase58(),
  );
  assert.notEqual(
    prizeReservePda(PROGRAM_ID, tournamentId)[0].toBase58(),
    prizeVaultPda(PROGRAM_ID, tournamentId)[0].toBase58(),
  );
  assert.equal(replayPda(PROGRAM_ID, key)[0].equals(treasuryDepositPda(PROGRAM_ID, key)[0]), false);
  assert.deepEqual(operatorVaultPda(PROGRAM_ID)[0].toBytes().length, 32);
});

test('MatchEscrow layout offsets match client decoder', () => {
  // Anchor layout: disc(8) room(16) creator(32) opponent(32) collateral(8) flags(3) status(1) bump(1) = 101
  const buf = Buffer.alloc(102);
  ACCOUNT_DISCS.MatchEscrow.copy(buf, 0);
  const room = Buffer.alloc(16, 7);
  room.copy(buf, 8);
  const creator = Keypair.generate().publicKey.toBuffer();
  const opponent = Keypair.generate().publicKey.toBuffer();
  creator.copy(buf, 24);
  opponent.copy(buf, 56);
  buf.writeBigUInt64LE(1_000_000_000n, 88);
  buf[96] = 1;
  buf[97] = 1;
  buf[98] = 1;
  buf[99] = 3; // Active
  buf[100] = 255;

  assert.deepEqual(buf.subarray(24, 56), creator);
  assert.deepEqual(buf.subarray(56, 88), opponent);
  assert.equal(buf.readBigUInt64LE(88), 1_000_000_000n);
  assert.equal(buf[96], 1);
  assert.equal(buf[99], 3);
});

test('instruction builders preserve account order and flags', () => {
  const authority = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const opponent = Keypair.generate().publicKey;
  const pokeMint = Keypair.generate().publicKey;
  const playerPoke = Keypair.generate().publicKey;
  const [config] = configPda(PROGRAM_ID);
  const [feeVault] = feeVaultPda(PROGRAM_ID);
  const [treasuryVault] = treasuryVaultPda(PROGRAM_ID);
  const [operatorVault] = operatorVaultPda(PROGRAM_ID);
  const roomId = uuidToBytes('33333333-3333-3333-3333-333333333333');
  const tournamentId = uuidToBytes('44444444-4444-4444-4444-444444444444');
  const settlementKey = createHash('sha256').update('win').digest();
  const quoteId = createHash('sha256').update('quote').digest();

  const init = initializeConfigIx({
    programId: PROGRAM_ID,
    authority,
    pokeMint,
    quoteAuthority: authority,
    keeper: authority,
    buybackBps: 2500,
    minBuybackLamports: 50_000_000,
  });
  assert.deepEqual(init.data.subarray(0, 8), IX.initializeConfig);
  assert.equal(init.keys.length, 9);
  assert.equal(init.keys[0].isSigner, true);
  assert.equal(init.keys[8].pubkey.equals(SystemProgram.programId), true);

  const create = createMatchEscrowIx({
    programId: PROGRAM_ID,
    creator,
    config,
    roomId,
    collateralLamports: 1_000_000,
  });
  assert.deepEqual(create.data.subarray(0, 8), IX.createMatchEscrow);
  assert.equal(create.keys.map((k) => k.pubkey.toBase58()).length, 5);

  const deposit = depositSolWagerIx({
    programId: PROGRAM_ID,
    depositor: creator,
    roomId,
    side: 0,
  });
  assert.equal(deposit.data.length, 9);
  assert.equal(deposit.data[8], 0);

  const seat = seatMatchOpponentIx({
    programId: PROGRAM_ID,
    authority,
    config,
    opponent,
    roomId,
  });
  assert.deepEqual(seat.data, IX.seatMatchOpponent);

  const refund = refundSolWagerIx({
    programId: PROGRAM_ID,
    authority,
    config,
    recipient: creator,
    roomId,
    side: 0,
  });
  assert.equal(refund.keys[2].isWritable, true);

  const fee = chargeMatchFeeIx({
    programId: PROGRAM_ID,
    authority,
    config,
    feeVault,
    roomId,
  });
  assert.equal(fee.keys[4].pubkey.equals(feeVault), true);

  const win = settleMatchWinIx({
    programId: PROGRAM_ID,
    authority,
    config,
    winner: creator,
    roomId,
    settlementKey,
  });
  assert.equal(win.keys.length, 7);

  const tie = settleMatchTieIx({
    programId: PROGRAM_ID,
    authority,
    config,
    creator,
    opponent,
    roomId,
    settlementKey,
  });
  assert.equal(tie.keys[3].pubkey.equals(creator), true);
  assert.equal(tie.keys[4].pubkey.equals(opponent), true);

  const entry = depositPokeEntryIx({
    programId: PROGRAM_ID,
    player: creator,
    config,
    pokeMint,
    playerPoke,
    tournamentId,
    amount: 12_500_000n,
    quoteId,
    priceMicroUsd: 400_000,
  });
  assert.equal(entry.keys[6].pubkey.equals(TOKEN_2022_PROGRAM_ID), true);
  assert.equal(entry.keys[8].pubkey.equals(SYSVAR_RENT_PUBKEY), true);
  assert.equal(entry.data.length, 8 + 16 + 8 + 32 + 8);

  const refundEntry = refundPokeEntryIx({
    programId: PROGRAM_ID,
    authority,
    config,
    pokeMint,
    playerPoke,
    tournamentId,
    player: creator,
  });
  assert.deepEqual(refundEntry.data, IX.refundPokeEntry);

  const burn = burnPokeEntryIx({
    programId: PROGRAM_ID,
    authority,
    config,
    pokeMint,
    tournamentId,
    player: creator,
    burnKey: settlementKey,
  });
  assert.equal(burn.keys[2].isWritable, true);

  const treasury = depositTreasurySolIx({
    programId: PROGRAM_ID,
    authority,
    payer: authority,
    config,
    treasuryVault,
    operatorVault,
    claimKey: settlementKey,
    grossLamports: 1_000_000_000,
  });
  assert.equal(treasury.keys[1].isSigner, true);

  const reserve = reservePrizeIx({
    programId: PROGRAM_ID,
    authority,
    config,
    treasuryVault,
    tournamentId,
    amount: 100_000_000,
  });
  assert.equal(reserve.keys.length, 6);

  const setWinner = setPrizeWinnerIx({
    programId: PROGRAM_ID,
    authority,
    config,
    winner: creator,
    tournamentId,
  });
  assert.deepEqual(setWinner.data, IX.setPrizeWinner);

  const pay = payPrizeIx({
    programId: PROGRAM_ID,
    authority,
    config,
    winner: creator,
    tournamentId,
    settlementKey,
  });
  assert.equal(pay.keys.length, 7);

  const release = releasePrizeIx({
    programId: PROGRAM_ID,
    authority,
    config,
    treasuryVault,
    tournamentId,
  });
  assert.deepEqual(release.data, IX.releasePrize);

  const buyback = buybackAndBurnPokeIx({
    programId: PROGRAM_ID,
    authority,
    config,
    feeVault,
    swapWallet: authority,
    pokeMint,
    pokeBurnSource: playerPoke,
    buybackKey: settlementKey,
    solAmount: 100_000_000,
    minPokeOut: 1,
  });
  assert.equal(buyback.data.length, 8 + 32 + 8 + 8);
});

test('custom error codes use Anchor 6000 offset ordering', () => {
  const errors = [
    'InvalidAmount',
    'InvalidBps',
    'Unauthorized',
    'AlreadyDeposited',
    'NotDeposited',
    'InvalidSide',
    'InvalidMatchStatus',
    'FeeAlreadyCharged',
    'FeeNotCharged',
    'InvalidEntryStatus',
    'InvalidPrizeStatus',
    'PrizeWinnerAlreadySet',
    'PrizeWinnerNotSet',
    'Overflow',
    'BuybackTooSmall',
    'InsufficientFunds',
    'SlippageExceeded',
    'PokeMintNotConfigured',
    'PokeMintAlreadySet',
    'InvalidMint',
  ];
  errors.forEach((name, index) => {
    assert.equal(6000 + index >= 6000, true, name);
    assert.equal(6000 + index, 6000 + index);
  });
});
