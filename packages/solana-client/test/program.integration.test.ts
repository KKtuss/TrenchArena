/**
 * Real-tx integration against solana-test-validator + deployed arena-escrow.
 * Skips automatically when POKEARENA_CHAIN_ECONOMY is not true or RPC is down.
 *
 * Run after:
 *   ./scripts/solana/start-validator.sh
 *   ./scripts/solana/bootstrap-local.sh
 *   set -a; source scripts/solana/.local.env; set +a
 *   npm test -- --test-name-pattern program.integration
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  atomsForUsdCents,
  createMatchEscrowIx,
  depositSolWagerIx,
  chargeMatchFeeIx,
  settleMatchWinIx,
  settleMatchTieIx,
  depositTreasurySolIx,
  depositPokeEntryIx,
  refundPokeEntryIx,
  reservePrizeIx,
  setPrizeWinnerIx,
  payPrizeIx,
  getAssociatedTokenAddressSync,
  evaluatePassport,
  createMockQuote,
  passportAtoms,
  configPda,
  sha256Key,
  uuidToBytes,
  previewSolCasual,
  previewTreasurySplit,
  CASUAL_FEE_BPS,
} from '../src/index';

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

function envEnabled(): boolean {
  return (process.env.POKEARENA_CHAIN_ECONOMY ?? '').toLowerCase() === 'true';
}

async function rpcReady(rpc: string): Promise<boolean> {
  try {
    const connection = new Connection(rpc, 'confirmed');
    await connection.getVersion();
    return true;
  } catch {
    return false;
  }
}

test('passport math: $20 threshold and ~$5 entry ceil', () => {
  const quote = createMockQuote({ priceMicroUsd: 400_000, decimals: 6 }); // $0.40
  assert.equal(passportAtoms(quote), 50_000_000n); // 50 POKE
  assert.equal(atomsForUsdCents(500, quote), 12_500_000n); // 12.5 POKE
  const status = evaluatePassport({
    liquidAtoms: 50_000_000n,
    heldEntryAtoms: 0n,
    quote,
  });
  assert.equal(status.eligible, true);
  const below = evaluatePassport({
    liquidAtoms: 49_999_999n,
    heldEntryAtoms: 0n,
    quote,
  });
  assert.equal(below.eligible, false);
});

test('SOL casual fee is integer floor 200 bps', () => {
  const preview = previewSolCasual(1_000_000_000);
  assert.equal(preview.feeRateBps, CASUAL_FEE_BPS);
  assert.equal(preview.protocolFeeLamports, 40_000_000);
  assert.equal(preview.winnerPayoutLamports, 1_960_000_000);
});

test('treasury deposit split is 90/10', () => {
  const split = previewTreasurySplit(1_000_000_000);
  assert.equal(split.treasuryLamports, 900_000_000);
  assert.equal(split.operatorLamports, 100_000_000);
});

test('program: SOL wager fee + win against local validator', async (t) => {
  if (!envEnabled()) {
    t.skip('POKEARENA_CHAIN_ECONOMY not enabled');
    return;
  }
  const rpc = process.env.POKEARENA_SOLANA_RPC || 'http://127.0.0.1:8899';
  if (!(await rpcReady(rpc))) {
    t.skip('validator RPC not reachable');
    return;
  }
  const programIdStr = process.env.POKEARENA_PROGRAM_ID;
  if (!programIdStr) {
    t.skip('POKEARENA_PROGRAM_ID missing');
    return;
  }
  const keyDir = process.env.POKEARENA_SOLANA_KEYS
    || join(__dirname, '../../../scripts/solana/keys');
  if (!existsSync(join(keyDir, 'authority.json'))) {
    t.skip('bootstrap keys missing');
    return;
  }

  const programId = new PublicKey(programIdStr);
  const authority = loadKeypair(join(keyDir, 'authority.json'));
  const player1 = loadKeypair(join(keyDir, 'player1.json'));
  const player2 = loadKeypair(join(keyDir, 'player2.json'));
  const feeVault = new PublicKey(process.env.POKEARENA_FEE_VAULT!);
  const connection = new Connection(rpc, 'confirmed');
  const [config] = configPda(programId);
  const configInfo = await connection.getAccountInfo(config);
  if (!configInfo) {
    t.skip('config PDA not initialized');
    return;
  }

  const roomId = uuidToBytes(crypto.randomUUID());
  const collateral = Math.floor(0.1 * LAMPORTS_PER_SOL);

  const createAndDeposit = createMatchEscrowIx({
    programId,
    creator: player1.publicKey,
    config,
    roomId,
    collateralLamports: collateral,
  });
  const deposit1 = depositSolWagerIx({
    programId,
    depositor: player1.publicKey,
    roomId,
    side: 0,
  });
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: player1.publicKey, blockhash, lastValidBlockHeight })
      .add(createAndDeposit, deposit1);
    await sendAndConfirmTransaction(connection, tx, [player1]);
  }

  const deposit2 = depositSolWagerIx({
    programId,
    depositor: player2.publicKey,
    roomId,
    side: 1,
  });
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: player2.publicKey, blockhash, lastValidBlockHeight })
      .add(deposit2);
    await sendAndConfirmTransaction(connection, tx, [player2]);
  }

  const feeBefore = await connection.getBalance(feeVault);
  const charge = chargeMatchFeeIx({
    programId,
    authority: authority.publicKey,
    config,
    feeVault,
    roomId,
  });
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight })
      .add(charge);
    await sendAndConfirmTransaction(connection, tx, [authority]);
  }
  const feeAfter = await connection.getBalance(feeVault);
  const expectedFee = Math.floor((collateral * 2 * CASUAL_FEE_BPS) / 10_000);
  assert.equal(feeAfter - feeBefore, expectedFee);

  const winnerBefore = await connection.getBalance(player1.publicKey);
  const settlementKey = sha256Key(['test-win', Buffer.from(roomId).toString('hex')]);
  const win = settleMatchWinIx({
    programId,
    authority: authority.publicKey,
    config,
    winner: player1.publicKey,
    roomId,
    settlementKey,
  });
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight })
      .add(win);
    await sendAndConfirmTransaction(connection, tx, [authority]);
  }
  const winnerAfter = await connection.getBalance(player1.publicKey);
  assert.ok(winnerAfter > winnerBefore);

  // Duplicate settle must fail (replay PDA occupied).
  await assert.rejects(async () => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight })
      .add(win);
    await sendAndConfirmTransaction(connection, tx, [authority]);
  });
});

test('program: treasury 90/10 deposit', async (t) => {
  if (!envEnabled()) {
    t.skip('POKEARENA_CHAIN_ECONOMY not enabled');
    return;
  }
  const rpc = process.env.POKEARENA_SOLANA_RPC || 'http://127.0.0.1:8899';
  if (!(await rpcReady(rpc))) {
    t.skip('validator RPC not reachable');
    return;
  }
  const programIdStr = process.env.POKEARENA_PROGRAM_ID;
  const keyDir = process.env.POKEARENA_SOLANA_KEYS
    || join(__dirname, '../../../scripts/solana/keys');
  if (!programIdStr || !existsSync(join(keyDir, 'authority.json'))) {
    t.skip('program/keys not ready');
    return;
  }
  const programId = new PublicKey(programIdStr);
  const authority = loadKeypair(join(keyDir, 'authority.json'));
  const treasuryVault = new PublicKey(process.env.POKEARENA_TREASURY_VAULT!);
  const operatorVault = new PublicKey(process.env.POKEARENA_OPERATOR_VAULT!);
  const connection = new Connection(rpc, 'confirmed');
  const [config] = configPda(programId);
  if (!(await connection.getAccountInfo(config))) {
    t.skip('config PDA not initialized');
    return;
  }

  const gross = 1_000_000_000;
  const claimKey = sha256Key(['itest-treasury', String(Date.now())]);
  const tBefore = await connection.getBalance(treasuryVault);
  const oBefore = await connection.getBalance(operatorVault);
  const ix = depositTreasurySolIx({
    programId,
    authority: authority.publicKey,
    payer: authority.publicKey,
    config,
    treasuryVault,
    operatorVault,
    claimKey,
    grossLamports: gross,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight })
    .add(ix);
  await sendAndConfirmTransaction(connection, tx, [authority]);
  const tAfter = await connection.getBalance(treasuryVault);
  const oAfter = await connection.getBalance(operatorVault);
  assert.equal(tAfter - tBefore, 900_000_000);
  assert.equal(oAfter - oBefore, 100_000_000);
});

test('program: POKE refund cannot redirect to another wallet', async (t) => {
  if (!envEnabled()) {
    t.skip('POKEARENA_CHAIN_ECONOMY not enabled');
    return;
  }
  const rpc = process.env.POKEARENA_SOLANA_RPC || 'http://127.0.0.1:8899';
  if (!(await rpcReady(rpc))) {
    t.skip('validator RPC not reachable');
    return;
  }
  const keyDir = process.env.POKEARENA_SOLANA_KEYS
    || join(__dirname, '../../../scripts/solana/keys');
  if (!existsSync(join(keyDir, 'authority.json'))) {
    t.skip('bootstrap keys missing');
    return;
  }
  const connection = new Connection(rpc, 'confirmed');
  const programId = new PublicKey(process.env.POKEARENA_PROGRAM_ID!);
  const authority = loadKeypair(join(keyDir, 'authority.json'));
  const player1 = loadKeypair(join(keyDir, 'player1.json'));
  const player2 = loadKeypair(join(keyDir, 'player2.json'));
  const config = configPda(programId)[0];
  const pokeMint = new PublicKey(process.env.POKEARENA_POKE_MINT!);
  const tournamentId = uuidToBytes(crypto.randomUUID());
  const player1Ata = getAssociatedTokenAddressSync(pokeMint, player1.publicKey, true);
  const player2Ata = getAssociatedTokenAddressSync(pokeMint, player2.publicKey, true);

  const deposit = depositPokeEntryIx({
    programId,
    player: player1.publicKey,
    config,
    pokeMint,
    playerPoke: player1Ata,
    tournamentId,
    amount: 1_000n,
    quoteId: sha256Key(['refund-test']),
    priceMicroUsd: 400_000,
  });
  {
    const latest = await connection.getLatestBlockhash();
    const tx = new Transaction({
      feePayer: player1.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(deposit);
    await sendAndConfirmTransaction(connection, tx, [player1]);
  }

  const wrongRefund = refundPokeEntryIx({
    programId,
    authority: authority.publicKey,
    config,
    pokeMint,
    playerPoke: player2Ata,
    tournamentId,
    player: player1.publicKey,
  });
  await assert.rejects(async () => {
    const latest = await connection.getLatestBlockhash();
    const tx = new Transaction({
      feePayer: authority.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(wrongRefund);
    await sendAndConfirmTransaction(connection, tx, [authority]);
  });
});

test('program: prize payment is bound to the stored winner', async (t) => {
  if (!envEnabled()) {
    t.skip('POKEARENA_CHAIN_ECONOMY not enabled');
    return;
  }
  const rpc = process.env.POKEARENA_SOLANA_RPC || 'http://127.0.0.1:8899';
  if (!(await rpcReady(rpc))) {
    t.skip('validator RPC not reachable');
    return;
  }
  const keyDir = process.env.POKEARENA_SOLANA_KEYS
    || join(__dirname, '../../../scripts/solana/keys');
  if (!existsSync(join(keyDir, 'authority.json'))) {
    t.skip('bootstrap keys missing');
    return;
  }
  const connection = new Connection(rpc, 'confirmed');
  const programId = new PublicKey(process.env.POKEARENA_PROGRAM_ID!);
  const authority = loadKeypair(join(keyDir, 'authority.json'));
  const player1 = loadKeypair(join(keyDir, 'player1.json'));
  const player2 = loadKeypair(join(keyDir, 'player2.json'));
  const config = configPda(programId)[0];
  const treasuryVault = new PublicKey(process.env.POKEARENA_TREASURY_VAULT!);
  const tournamentId = uuidToBytes(crypto.randomUUID());

  const reserve = reservePrizeIx({
    programId,
    authority: authority.publicKey,
    config,
    treasuryVault,
    tournamentId,
    amount: 50_000_000,
  });
  const latest = await connection.getLatestBlockhash();
  await sendAndConfirmTransaction(
    connection,
    new Transaction({
      feePayer: authority.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(reserve),
    [authority],
  );

  const setWinner = setPrizeWinnerIx({
    programId,
    authority: authority.publicKey,
    config,
    winner: player1.publicKey,
    tournamentId,
  });
  const winnerBlockhash = await connection.getLatestBlockhash();
  await sendAndConfirmTransaction(
    connection,
    new Transaction({
      feePayer: authority.publicKey,
      blockhash: winnerBlockhash.blockhash,
      lastValidBlockHeight: winnerBlockhash.lastValidBlockHeight,
    }).add(setWinner),
    [authority],
  );

  const wrongPay = payPrizeIx({
    programId,
    authority: authority.publicKey,
    config,
    winner: player2.publicKey,
    tournamentId,
    settlementKey: sha256Key(['wrong-prize-recipient']),
  });
  await assert.rejects(async () => {
    const current = await connection.getLatestBlockhash();
    await sendAndConfirmTransaction(
      connection,
      new Transaction({
        feePayer: authority.publicKey,
        blockhash: current.blockhash,
        lastValidBlockHeight: current.lastValidBlockHeight,
      }).add(wrongPay),
      [authority],
    );
  });
});

// Keep settleMatchTieIx imported for type surface / future tie fixture.
void settleMatchTieIx;
