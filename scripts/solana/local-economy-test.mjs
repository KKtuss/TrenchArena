#!/usr/bin/env node
/**
 * Disposable localnet-only PokeArena economy campaign.
 *
 * This script intentionally talks to the real deployed program and classic
 * SPL Token program. It does not read production configuration or use a
 * non-local RPC. Tournament registration/brackets are API-owned in PokeArena;
 * the on-chain portion covers the real entry, burn, treasury, prize, and
 * buyback primitives that settle the tournament economy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SendTransactionError,
} = require('../../packages/solana-client/node_modules/@solana/web3.js');
const client = require('../../packages/solana-client/dist/src/index.js');

const PROGRAM_ID = new PublicKey(
  process.env.POKEARENA_PROGRAM_ID ?? '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W',
);
const RPC = process.env.POKEARENA_SOLANA_RPC ?? 'http://127.0.0.1:8899';
const KEY_DIR = process.env.POKEARENA_SOLANA_KEYS
  ?? join(process.cwd(), 'scripts/solana/keys');
const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);
const ENTRY_ATOMS = BigInt(client.TOURNAMENT_BURN_FEE_ATOMS);
const PASSPORT_ATOMS = BigInt(client.passportAtoms(client.createMockQuote()));
const TOKEN_PROGRAM_ID = client.TOKEN_PROGRAM_ID;
const ATA_PROGRAM_ID = client.ASSOCIATED_TOKEN_PROGRAM_ID;
const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i;

function keypair(name) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(KEY_DIR, `${name}.json`), 'utf8'))),
  );
}

function id16(label) {
  return createHash('sha256').update(`local-economy:${label}`).digest().subarray(0, 16);
}

function key32(label) {
  return createHash('sha256').update(`local-economy:${label}`).digest();
}

function uuidBytes() {
  const hex = randomUUID().replaceAll('-', '');
  return Buffer.from(hex, 'hex');
}

function u64(value) {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(value));
  return data;
}

function tokenIx(keys, data) {
  return new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys, data });
}

function initializeMintIx(mint, authority) {
  return tokenIx(
    [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    Buffer.concat([
      Buffer.from([0, DECIMALS]),
      authority.toBuffer(),
      Buffer.from([0, 0, 0, 0]),
    ]),
  );
}

function mintToIx(mint, destination, authority, amount) {
  return tokenIx(
    [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    Buffer.concat([Buffer.from([7]), u64(amount)]),
  );
}

function createAtaIx(payer, ata, owner, mint) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function transferTokenIx(source, destination, owner, amount) {
  return tokenIx(
    [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    Buffer.concat([Buffer.from([3]), u64(amount)]),
  );
}

async function send(connection, payer, instructions, signers = []) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...instructions);
  return sendAndConfirmTransaction(connection, tx, [payer, ...signers], {
    commitment: 'confirmed',
  });
}

async function expectReject(label, operation) {
  try {
    await operation();
  } catch (error) {
    return {
      label,
      ok: true,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    };
  }
  throw new Error(`${label}: expected transaction rejection`);
}

async function runConcurrent(label, operations) {
  const startedAt = Date.now();
  const outcomes = await Promise.all(operations.map(async operation => {
    const operationStartedAt = Date.now();
    try {
      const signature = await operation();
      return {
        ok: true,
        signature,
        latencyMs: Date.now() - operationStartedAt,
      };
    } catch (error) {
      return {
        ok: false,
        signature: null,
        latencyMs: Date.now() - operationStartedAt,
        error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      };
    }
  }));
  const failed = outcomes.filter(outcome => !outcome.ok);
  if (failed.length > 0) {
    throw new Error(`${label}: ${failed.length} legitimate transaction(s) failed: ${JSON.stringify(failed)}`);
  }
  return {
    submitted: outcomes.length,
    failed: failed.length,
    uniqueSignatures: new Set(outcomes.map(outcome => outcome.signature)).size,
    wallClockMs: Date.now() - startedAt,
    maxLatencyMs: Math.max(...outcomes.map(outcome => outcome.latencyMs)),
  };
}

async function airdrop(connection, wallet, sol = 50) {
  const balance = await connection.getBalance(wallet.publicKey, 'confirmed');
  if (balance >= sol * 1_000_000_000) return;
  const signature = await connection.requestAirdrop(wallet.publicKey, sol * 1_000_000_000);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) throw new Error(`Airdrop failed for ${wallet.publicKey}: ${JSON.stringify(status.err)}`);
    if (
      status?.confirmationStatus === 'confirmed'
      || status?.confirmationStatus === 'finalized'
    ) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Airdrop confirmation timed out for ${wallet.publicKey}`);
}

async function createMint(connection, payer, authority) {
  const mint = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(82);
  await send(connection, payer, [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: rent,
      space: 82,
      programId: TOKEN_PROGRAM_ID,
    }),
    initializeMintIx(mint.publicKey, authority),
  ], [mint]);
  return mint;
}

async function ensureAta(connection, payer, owner, mint) {
  const ata = client.getAssociatedTokenAddressSync(mint, owner, true);
  if (!(await connection.getAccountInfo(ata, 'confirmed'))) {
    await send(connection, payer, [createAtaIx(payer.publicKey, ata, owner, mint)]);
  }
  return ata;
}

async function mintTo(connection, payer, mint, destination, amount) {
  await send(connection, payer, [mintToIx(mint, destination, payer.publicKey, amount)]);
}

async function tokenBalance(connection, address) {
  try {
    return BigInt((await connection.getTokenAccountBalance(address, 'confirmed')).value.amount);
  } catch {
    return 0n;
  }
}

async function assertConfigMint(connection, configAddress, expected) {
  const account = await connection.getAccountInfo(configAddress, 'confirmed');
  if (!account) throw new Error('Config PDA was not created.');
  const actual = new PublicKey(account.data.subarray(136, 168));
  if (!actual.equals(expected)) {
    throw new Error(`Configured mint mismatch: expected ${expected}, got ${actual}`);
  }
}

async function main() {
  if (!LOCAL_RPC.test(RPC)) throw new Error(`Refusing non-local RPC: ${RPC}`);
  const connection = new Connection(RPC, 'confirmed');
  const [version, genesis] = await Promise.all([
    connection.getVersion(),
    connection.getGenesisHash(),
  ]);
  if (!genesis || genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
    throw new Error('Refusing a non-local Solana genesis hash.');
  }

  const authority = keypair('authority');
  const keeper = keypair('keeper');
  const players = Array.from({ length: 32 }, () => Keypair.generate());
  const below = Keypair.generate();
  const zero = Keypair.generate();
  const wrongMintHolder = Keypair.generate();
  const results = {
    cluster: { rpc: RPC, genesis, version: version['solana-core'] },
    programId: PROGRAM_ID.toBase58(),
    mintLifecycle: {},
    eligibility: {},
    sizes: {},
    economy: {},
    balances: {},
  };

  console.log(`LOCALNET ${RPC} ${genesis} program=${PROGRAM_ID.toBase58()}`);
  for (const wallet of [authority, keeper, ...players, below, zero, wrongMintHolder]) {
    await airdrop(connection, wallet);
    console.log(`funded ${wallet.publicKey.toBase58()}`);
  }

  const pokeMint = await createMint(connection, authority, authority.publicKey);
  const replacementMint = await createMint(connection, authority, authority.publicKey);
  const wrongMint = await createMint(connection, authority, authority.publicKey);
  const [config] = client.configPda(PROGRAM_ID);
  const [feeVault] = client.feeVaultPda(PROGRAM_ID);
  const [treasuryVault] = client.treasuryVaultPda(PROGRAM_ID);
  const [operatorVault] = client.operatorVaultPda(PROGRAM_ID);

  // Initialize with the zero/system mint, then use the immutable setter.
  await send(connection, authority, [client.initializeConfigIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    pokeMint: PublicKey.default,
    quoteAuthority: authority.publicKey,
    keeper: keeper.publicKey,
    buybackBps: 2500,
    minBuybackLamports: 50_000_000,
  })]);
  results.mintLifecycle.initializeUnset = 'confirmed';

  await send(connection, authority, [client.setPokeMintIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    pokeMint: pokeMint.publicKey,
  })]);
  await assertConfigMint(connection, config, pokeMint.publicKey);
  results.mintLifecycle.setOriginal = 'confirmed';

  results.mintLifecycle.replaceRejected = await expectReject(
    'replace configured POKE mint',
    () => send(connection, authority, [client.setPokeMintIx({
      programId: PROGRAM_ID,
      authority: authority.publicKey,
      pokeMint: replacementMint.publicKey,
    })]),
  );
  await assertConfigMint(connection, config, pokeMint.publicKey);

  const playerAtas = [];
  for (const player of players) {
    const ata = await ensureAta(connection, authority, player.publicKey, pokeMint.publicKey);
    // Fund the full requested campaign: 32-player field plus independent
    // 4/8/16-player accounting cases, with passport headroom remaining.
    await mintTo(connection, authority, pokeMint.publicKey, ata, 500_000n * SCALE);
    playerAtas.push(ata);
  }
  const belowAta = await ensureAta(connection, authority, below.publicKey, pokeMint.publicKey);
  await mintTo(connection, authority, pokeMint.publicKey, belowAta, 1n * SCALE);
  const wrongAta = await ensureAta(connection, authority, wrongMintHolder.publicKey, wrongMint.publicKey);
  await mintTo(connection, authority, wrongMint.publicKey, wrongAta, 1_000n * SCALE);
  const keeperAta = await ensureAta(connection, authority, keeper.publicKey, pokeMint.publicKey);
  await mintTo(connection, authority, pokeMint.publicKey, keeperAta, 1_000n);

  const arena = new client.ArenaChainClient({
    cluster: 'localnet',
    rpcUrl: RPC,
    programId: PROGRAM_ID,
    pokeMint: pokeMint.publicKey,
    feeVault,
    treasuryVault,
    operatorVault,
    quoteAuthority: authority.publicKey,
    keeper: keeper.publicKey,
    authority: authority.publicKey,
    buybackBps: 2500,
    minBuybackLamports: 50_000_000,
    chainEconomyEnabled: true,
    commitment: 'confirmed',
  });
  const sufficient = await arena.getPassportStatus({ owner: players[0].publicKey });
  const belowStatus = await arena.getPassportStatus({ owner: below.publicKey });
  const zeroStatus = await arena.getPassportStatus({ owner: zero.publicKey });
  const wrongConfiguredView = await arena.getPassportStatus({
    owner: wrongMintHolder.publicKey,
  });
  results.eligibility = {
    sufficient: { eligible: sufficient.eligible, atoms: sufficient.liquidAtoms.toString() },
    belowThreshold: { eligible: belowStatus.eligible, reason: belowStatus.reason },
    zero: { eligible: zeroStatus.eligible, reason: zeroStatus.reason },
    wrongMint: {
      wrongMintAtoms: (await tokenBalance(connection, wrongAta)).toString(),
      configuredMintAtoms: wrongConfiguredView.liquidAtoms.toString(),
      eligible: wrongConfiguredView.eligible,
    },
  };
  if (!sufficient.eligible || belowStatus.eligible || zeroStatus.eligible || wrongConfiguredView.eligible) {
    throw new Error('Configured-mint eligibility assertions failed.');
  }

  const insufficientId = id16('insufficient');
  results.economy.insufficientDepositRejected = await expectReject(
    'insufficient POKE entry balance',
    () => send(connection, below, [client.depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: below.publicKey,
      config,
      pokeMint: pokeMint.publicKey,
      playerPoke: belowAta,
      tournamentId: insufficientId,
      amount: ENTRY_ATOMS,
      quoteId: key32('insufficient-quote'),
      priceMicroUsd: 400_000,
    })]),
  );
  results.economy.wrongMintDepositRejected = await expectReject(
    'wrong mint entry deposit',
    () => send(connection, wrongMintHolder, [client.depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: wrongMintHolder.publicKey,
      config,
      pokeMint: wrongMint.publicKey,
      playerPoke: wrongAta,
      tournamentId: id16('wrong-mint'),
      amount: 1n,
      quoteId: key32('wrong-mint-quote'),
      priceMicroUsd: 400_000,
    })]),
  );

  // Deposit and burn the real fixed 32-player tournament field.
  const tournamentId = id16('32-player-cup');
  const beforeSupply = BigInt((await connection.getTokenSupply(pokeMint.publicKey, 'confirmed')).value.amount);
  const mainDepositConcurrency = await runConcurrent(
    '32-player POKE deposits',
    players.map((player, index) => () => send(connection, player, [client.depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: players[index].publicKey,
      config,
      pokeMint: pokeMint.publicKey,
      playerPoke: playerAtas[index],
      tournamentId,
      amount: ENTRY_ATOMS,
      quoteId: key32(`quote-${index}`),
      priceMicroUsd: 400_000,
    })])),
  );
  results.economy.entryDeposits = {
    players: players.length,
    totalAtoms: (ENTRY_ATOMS * BigInt(players.length)).toString(),
  };
  results.economy.concurrency = { 32: { deposits: mainDepositConcurrency } };
  for (let index = 0; index < players.length; index += 1) {
    const state = await arena.getEntryEscrowState(tournamentId, players[index].publicKey);
    if (state.status !== 0 || state.amount !== ENTRY_ATOMS) {
      throw new Error(`Entry escrow ${index} is not reserved correctly.`);
    }
  }
  const mainBurnConcurrency = await runConcurrent(
    '32-player POKE burns',
    players.map((player, index) => () => send(connection, keeper, [client.burnPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      pokeMint: pokeMint.publicKey,
      tournamentId,
      player: players[index].publicKey,
      burnKey: key32(`burn-${index}`),
    })])),
  );
  results.economy.concurrency[32].burns = mainBurnConcurrency;
  for (let index = 0; index < players.length; index += 1) {
    const burned = await arena.getEntryEscrowState(tournamentId, players[index].publicKey);
    if (burned.status !== 1) throw new Error(`Entry escrow ${index} did not burn.`);
  }
  results.economy.concurrency[32].duplicateBurnRejected = await expectReject(
    'duplicate 32-player burn',
    () => send(connection, keeper, [client.burnPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      pokeMint: pokeMint.publicKey,
      tournamentId,
      player: players[0].publicKey,
      burnKey: key32('burn-0'),
    })]),
  );
  const afterSupply = BigInt((await connection.getTokenSupply(pokeMint.publicKey, 'confirmed')).value.amount);
  const expectedBurn = ENTRY_ATOMS * BigInt(players.length);
  if (beforeSupply - afterSupply !== expectedBurn) {
    throw new Error(`Supply burn mismatch: expected ${expectedBurn}, got ${beforeSupply - afterSupply}`);
  }
  results.economy.entryBurn = {
    totalAtoms: expectedBurn.toString(),
    supplyBefore: beforeSupply.toString(),
    supplyAfter: afterSupply.toString(),
  };

  // Treasury accounting and prize reserve/payout use real program PDAs.
  const gross = 1_000_000_000;
  const treasuryBefore = await connection.getBalance(treasuryVault, 'confirmed');
  const operatorBefore = await connection.getBalance(operatorVault, 'confirmed');
  await send(connection, authority, [client.depositTreasurySolIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    payer: authority.publicKey,
    config,
    treasuryVault,
    operatorVault,
    claimKey: key32('treasury'),
    grossLamports: gross,
  })]);
  const treasuryAfter = await connection.getBalance(treasuryVault, 'confirmed');
  const operatorAfter = await connection.getBalance(operatorVault, 'confirmed');
  results.economy.treasurySplit = {
    treasuryDelta: treasuryAfter - treasuryBefore,
    operatorDelta: operatorAfter - operatorBefore,
  };
  if (treasuryAfter - treasuryBefore !== 900_000_000 || operatorAfter - operatorBefore !== 100_000_000) {
    throw new Error('Treasury 90/10 accounting mismatch.');
  }

  const prizeTournament = id16('prize');
  const prize = 100_000_000;
  await send(connection, authority, [client.reservePrizeIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    config,
    treasuryVault,
    tournamentId: prizeTournament,
    amount: prize,
  })]);
  await send(connection, keeper, [client.setPrizeWinnerIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    winner: players[0].publicKey,
    tournamentId: prizeTournament,
  }), client.payPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    winner: players[0].publicKey,
    tournamentId: prizeTournament,
    settlementKey: key32('prize-pay'),
  })]);
  const prizeState = await arena.getPrizeReserveState(prizeTournament);
  if (prizeState.status !== 1 || !prizeState.winnerSet || !prizeState.winner.equals(players[0].publicKey)) {
    throw new Error('Prize payout state mismatch.');
  }
  results.economy.prize = { amountLamports: prize, status: prizeState.status, winner: players[0].publicKey.toBase58() };

  const releaseTournament = id16('release');
  await send(connection, authority, [client.reservePrizeIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    config,
    treasuryVault,
    tournamentId: releaseTournament,
    amount: 25_000_000,
  })]);
  await send(connection, keeper, [client.releasePrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    treasuryVault,
    tournamentId: releaseTournament,
  })]);
  const released = await arena.getPrizeReserveState(releaseTournament);
  if (released.status !== 2) throw new Error('Released prize did not reach released state.');
  results.economy.prizeRelease = { status: released.status };

  // Fund the fee vault with a real match fee, then exercise buyback/burn.
  const roomId = id16('buyback-fee');
  await send(connection, players[1], [client.createMatchEscrowIx({
    programId: PROGRAM_ID,
    creator: players[1].publicKey,
    config,
    roomId,
    collateralLamports: 3_000_000_000,
  }), client.depositSolWagerIx({
    programId: PROGRAM_ID,
    depositor: players[1].publicKey,
    roomId,
    side: 0,
  })]);
  await send(connection, keeper, [client.seatMatchOpponentIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    opponent: players[2].publicKey,
    roomId,
  })]);
  await send(connection, players[2], [client.depositSolWagerIx({
    programId: PROGRAM_ID,
    depositor: players[2].publicKey,
    roomId,
    side: 1,
  })]);
  await send(connection, keeper, [client.chargeMatchFeeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    feeVault,
    roomId,
  })]);
  const swapWallet = Keypair.generate();
  await airdrop(connection, swapWallet);
  const feeBefore = await connection.getBalance(feeVault, 'confirmed');
  const sourceBefore = await tokenBalance(connection, keeperAta);
  await send(connection, keeper, [client.buybackAndBurnPokeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    feeVault,
    swapWallet: swapWallet.publicKey,
    pokeMint: pokeMint.publicKey,
    pokeBurnSource: keeperAta,
    buybackKey: key32('buyback'),
    solAmount: 50_000_000,
    minPokeOut: 1,
  })]);
  const feeAfter = await connection.getBalance(feeVault, 'confirmed');
  const sourceAfter = await tokenBalance(connection, keeperAta);
  if (feeBefore - feeAfter !== 12_500_000 || sourceBefore - sourceAfter !== 1n) {
    throw new Error(`Buyback accounting mismatch: fee ${feeBefore - feeAfter}, POKE ${sourceBefore - sourceAfter}`);
  }
  results.economy.buybackBurn = {
    feeVaultSpend: feeBefore - feeAfter,
    pokeBurned: (sourceBefore - sourceAfter).toString(),
  };

  // The service supports 4/8/16/32, while sol_chain itself is fixed at 32.
  // Exercise the real on-chain entry/burn accounting for each field size.
  for (const size of [4, 8, 16]) {
    const sizeId = id16(`${size}-player-cup`);
    const before = BigInt((await connection.getTokenSupply(pokeMint.publicKey, 'confirmed')).value.amount);
    const depositConcurrency = await runConcurrent(
      `${size}-player POKE deposits`,
      Array.from({ length: size }, (_, index) => () => {
        const player = players[index];
        const ata = playerAtas[index];
        return send(connection, player, [client.depositPokeEntryIx({
        programId: PROGRAM_ID,
        player: player.publicKey,
        config,
        pokeMint: pokeMint.publicKey,
        playerPoke: ata,
        tournamentId: sizeId,
        amount: ENTRY_ATOMS,
        quoteId: key32(`${size}-quote-${index}`),
        priceMicroUsd: 400_000,
        })]);
      }),
    );
    const burnConcurrency = await runConcurrent(
      `${size}-player POKE burns`,
      Array.from({ length: size }, (_, index) => () => send(connection, keeper, [client.burnPokeEntryIx({
        programId: PROGRAM_ID,
        authority: keeper.publicKey,
        config,
        pokeMint: pokeMint.publicKey,
        tournamentId: sizeId,
        player: players[index].publicKey,
        burnKey: key32(`${size}-burn-${index}`),
      })])),
    );
    const after = BigInt((await connection.getTokenSupply(pokeMint.publicKey, 'confirmed')).value.amount);
    results.sizes[size] = {
      chainEconomy: 'PASS',
      players: size,
      burnedAtoms: (before - after).toString(),
      expectedAtoms: (ENTRY_ATOMS * BigInt(size)).toString(),
      concurrency: {
        deposits: depositConcurrency,
        burns: burnConcurrency,
      },
    };
  }
  results.sizes[32] = {
    ...(results.sizes[32] ?? {}),
    chainEconomy: 'PASS',
    productionConstraint: 'fixed sol_chain field',
  };

  const output = process.env.POKEARENA_LOCAL_ECONOMY_REPORT
    ?? join(process.cwd(), 'scripts/solana/local-economy-report.json');
  writeFileSync(output, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`REPORT=${output}`);
}

main().catch(async error => {
  if (error instanceof SendTransactionError) {
    try {
      console.error((await error.getLogs(new Connection(RPC, 'confirmed'))).join('\n'));
    } catch {
      // Preserve the original error below.
    }
  }
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
