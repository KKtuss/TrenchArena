#!/usr/bin/env node
/**
 * Local-validator proof of the final economy against the real Pinocchio program.
 * Refuses mainnet genesis. Does not print key material.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rootRequire = createRequire(new URL('../../package.json', import.meta.url));
const localRequire = createRequire(import.meta.url);
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
} = rootRequire('@solana/web3.js');
const client = localRequire('../../packages/solana-client/dist/src/index.js');

const FRESH_PROGRAM = 'HRN7567mTaH27Bhngu4Rg7JUQ8bvZp6Ymmf7XRT99rZk';
const FRESH_DEPLOYER = '8C5oWBFxk4J57BXkHrSE1Dg2F7tkvsJrAWPLSSpLKFwC';
const FRESH_AUTHORITY = '67sQcfcocfoq91oHZKxPZyiGndQvSgNfu2UmmNuRbFGi';
const FRESH_KEEPER = 'DFo1hqiFQ5crfZrrUVfV82RputSKPevRsZjNDwCfs6Co';
const RETIRED = new Set([
  '54Ji1Z32wH4NfDqpd3WMTbSBeK119ptAMmYcQirCUmmU',
  '6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98',
  'AXHoz3WVjyK1chetSrcWMnDDq8VZjvfoUW5yMyKNRpki',
  'Bs919SY62WM6J22HZo1GPnSnxpL7B66JFXtjwCDC1fNJ',
  '8Z1iUEpFmLeTFZquJXF66pEcSWYfRZMaztQHcbYwWgK8',
  '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W',
  'GGRAzZM9wnuLNCWQb6JYykRyfp4pXjHvp35JEmaps51Z',
  'AZn8PqCeQLKyKLDUgy67NsvLtTiFzDY9S491fGC15iAL',
  'Fmb7DLU6fTrQEGh8g6HSsYz3MviMjjS6nnB9n2TATdzw',
]);
const RPC = process.env.POKEARENA_SOLANA_RPC ?? 'http://127.0.0.1:8899';
const KEY_DIR = process.env.POKEARENA_STAGING_KEYS
  ?? 'C:/Users/Jules/.pokearena/staging-mainnet';
const PROGRAM_ID = new PublicKey(FRESH_PROGRAM);
const TOKEN_2022 = client.TOKEN_2022_PROGRAM_ID;
const TOKENKEG = client.TOKEN_PROGRAM_ID;
const ATA_PROGRAM = client.ASSOCIATED_TOKEN_PROGRAM_ID;
const ENTRY = BigInt(client.TOURNAMENT_BURN_FEE_ATOMS);
const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i;

function keypair(name) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(KEY_DIR, `${name}.json`), 'utf8'))));
}

function id16(label) {
  return createHash('sha256').update(`final-economy:${label}`).digest().subarray(0, 16);
}

function key32(label) {
  return createHash('sha256').update(`final-economy:${label}`).digest();
}

function u64(value) {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(value));
  return data;
}

function tokenIx(program, keys, data) {
  return new TransactionInstruction({ programId: program, keys, data });
}

function initializeMintIx(program, mint, authority) {
  return tokenIx(program, [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ], Buffer.concat([Buffer.from([0, 6]), authority.toBuffer(), Buffer.from([0, 0, 0, 0])]));
}

function mintToIx(program, mint, destination, authority, amount) {
  return tokenIx(program, [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ], Buffer.concat([Buffer.from([7]), u64(amount)]));
}

function ata(mint, owner, program) {
  return client.getAssociatedTokenAddressSync(mint, owner, true, program);
}

function createAtaIx(payer, owner, mint, program) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(mint, owner, program), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function transferIx(program, source, destination, owner, amount) {
  return tokenIx(program, [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ], Buffer.concat([Buffer.from([3]), u64(amount)]));
}

async function send(connection, payer, instructions, signers = []) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...instructions);
  return sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: 'confirmed' });
}

async function expectReject(label, operation) {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message.split('\n')[0] : String(error);
  }
  throw new Error(`${label}: expected rejection`);
}

async function airdrop(connection, wallet, sol = 20) {
  const signature = await connection.requestAirdrop(wallet.publicKey, sol * 1_000_000_000);
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
}

async function createMint(connection, payer, program) {
  const mint = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(82);
  await send(connection, payer, [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: rent,
      space: 82,
      programId: program,
    }),
    initializeMintIx(program, mint.publicKey, payer.publicKey),
  ], [mint]);
  return mint.publicKey;
}

async function balance(connection, address) {
  try {
    return BigInt((await connection.getTokenAccountBalance(address, 'confirmed')).value.amount);
  } catch {
    return 0n;
  }
}

async function main() {
  if (!LOCAL_RPC.test(RPC)) throw new Error(`Refusing non-local RPC: ${RPC}`);
  const connection = new Connection(RPC, 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
    throw new Error('Refusing mainnet genesis.');
  }

  const program = keypair('program');
  const deployer = keypair('deployer');
  const authority = keypair('authority');
  const keeper = keypair('keeper');
  const ids = [program, deployer, authority, keeper].map(item => item.publicKey.toBase58());
  if (new Set(ids).size !== 4) throw new Error('Staging identities are not distinct.');
  if (program.publicKey.toBase58() !== FRESH_PROGRAM) throw new Error('Program keypair does not match the fresh program id.');
  if (deployer.publicKey.toBase58() !== FRESH_DEPLOYER) throw new Error('Deployer keypair mismatch.');
  if (authority.publicKey.toBase58() !== FRESH_AUTHORITY) throw new Error('Authority keypair mismatch.');
  if (keeper.publicKey.toBase58() !== FRESH_KEEPER) throw new Error('Keeper keypair mismatch.');
  for (const id of ids) {
    if (RETIRED.has(id)) throw new Error('Retired or production identity was loaded.');
  }

  const programAccount = await connection.getAccountInfo(PROGRAM_ID, 'confirmed');
  if (!programAccount?.executable) throw new Error('Fresh program is not deployed on this local validator.');
  const [config] = client.configPda(PROGRAM_ID);
  const derivedConfig = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];
  if (!config.equals(derivedConfig)) throw new Error('Config PDA was not derived from the fresh program id.');

  const player = Keypair.generate();
  const opponent = Keypair.generate();
  const winner = Keypair.generate();
  const intruder = Keypair.generate();
  for (const wallet of [authority, keeper, player, opponent, winner, intruder]) {
    await airdrop(connection, wallet);
  }

  const pokeMint = await createMint(connection, authority, TOKEN_2022);
  const cardsMint = await createMint(connection, authority, TOKENKEG);
  const classicPoke = await createMint(connection, authority, TOKENKEG);
  const pokeInfo = await connection.getAccountInfo(pokeMint, 'confirmed');
  const cardsInfo = await connection.getAccountInfo(cardsMint, 'confirmed');
  if (!pokeInfo?.owner.equals(TOKEN_2022) || pokeInfo.data.length !== 82) {
    throw new Error('POKE mint is not a Token-2022 mint without extensions.');
  }
  if (!cardsInfo?.owner.equals(TOKENKEG) || cardsInfo.data.length !== 82) {
    throw new Error('CARDS mint is not a classic SPL mint.');
  }

  const [feeVault] = client.feeVaultPda(PROGRAM_ID);
  await send(connection, authority, [client.initializeConfigIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    pokeMint: PublicKey.default,
    quoteAuthority: authority.publicKey,
    keeper: keeper.publicKey,
    buybackBps: 0,
    minBuybackLamports: 0,
  })]);
  await expectReject('classic SPL mint cannot be POKE', () => send(connection, authority, [client.setPokeMintIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    pokeMint: classicPoke,
  })]));
  await send(connection, authority, [client.setPokeMintIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    pokeMint,
  })]);
  await send(connection, authority, [client.setCardsMintIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    cardsMint,
  })]);

  const quote = client.createMockQuote({ priceMicroUsd: 1_000_000, decimals: 6 });
  const exactAtoms = client.passportAtoms(quote);
  const belowStatus = client.evaluatePassport({ liquidAtoms: exactAtoms - 1n, quote });
  const exactStatus = client.evaluatePassport({ liquidAtoms: exactAtoms, quote });
  const aboveStatus = client.evaluatePassport({ liquidAtoms: exactAtoms + 1n, quote });
  if (belowStatus.eligible || !exactStatus.eligible || !aboveStatus.eligible) {
    throw new Error('Passport $5 boundary failed.');
  }
  if (client.POKEARENA_PASSPORT_MIN_USD !== '5.00') throw new Error('Passport constant drifted.');

  const playerPoke = ata(pokeMint, player.publicKey, TOKEN_2022);
  const shortPoke = ata(pokeMint, intruder.publicKey, TOKEN_2022);
  await send(connection, authority, [
    createAtaIx(authority.publicKey, player.publicKey, pokeMint, TOKEN_2022),
    createAtaIx(authority.publicKey, intruder.publicKey, pokeMint, TOKEN_2022),
    mintToIx(TOKEN_2022, pokeMint, playerPoke, authority.publicKey, ENTRY * 2n),
    mintToIx(TOKEN_2022, pokeMint, shortPoke, authority.publicKey, 1n),
  ]);

  const tournamentId = id16('entry');
  await expectReject('insufficient POKE', () => send(connection, intruder, [client.depositPokeEntryIx({
    programId: PROGRAM_ID,
    player: intruder.publicKey,
    config,
    pokeMint,
    playerPoke: shortPoke,
    tournamentId: id16('short'),
    amount: ENTRY,
    quoteId: key32('short'),
    priceMicroUsd: 1_000_000,
  })]));
  const wrongProgram = client.depositPokeEntryIx({
    programId: PROGRAM_ID,
    player: player.publicKey,
    config,
    pokeMint,
    playerPoke,
    tournamentId: id16('wrong-program'),
    amount: ENTRY,
    quoteId: key32('wrong-program'),
    priceMicroUsd: 1_000_000,
  });
  wrongProgram.keys[6] = { pubkey: TOKENKEG, isSigner: false, isWritable: false };
  await expectReject('wrong POKE token program', () => send(connection, player, [wrongProgram]));
  await expectReject('POKE mint cannot be replaced', () => send(connection, authority, [client.setPokeMintIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    pokeMint: classicPoke,
  })]));

  const supplyBefore = BigInt((await connection.getTokenSupply(pokeMint, 'confirmed')).value.amount);
  await send(connection, player, [client.depositPokeEntryIx({
    programId: PROGRAM_ID,
    player: player.publicKey,
    config,
    pokeMint,
    playerPoke,
    tournamentId,
    amount: ENTRY,
    quoteId: key32('entry'),
    priceMicroUsd: 1_000_000,
  })]);
  await send(connection, keeper, [client.burnPokeEntryIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    pokeMint,
    tournamentId,
    player: player.publicKey,
    burnKey: key32('burn'),
  })]);
  const supplyAfter = BigInt((await connection.getTokenSupply(pokeMint, 'confirmed')).value.amount);
  if (supplyBefore - supplyAfter !== ENTRY) throw new Error('POKE entry was not burned for the exact amount.');
  await expectReject('replayed burn', () => send(connection, keeper, [client.burnPokeEntryIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    pokeMint,
    tournamentId,
    player: player.publicKey,
    burnKey: key32('burn'),
  })]));
  await expectReject('wrong keeper', () => send(connection, intruder, [client.burnPokeEntryIx({
    programId: PROGRAM_ID,
    authority: intruder.publicKey,
    config,
    pokeMint,
    tournamentId: id16('other'),
    player: player.publicKey,
    burnKey: key32('other-burn'),
  })]));

  const gross = 1_000n;
  const split = { operator: gross / 10n, tournament: gross - gross / 10n };
  const authorityCards = ata(cardsMint, authority.publicKey, TOKENKEG);
  const [treasuryVault] = client.cardsTreasuryVaultPda(PROGRAM_ID);
  const [operatorVault] = client.cardsOperatorVaultPda(PROGRAM_ID);
  await send(connection, authority, [
    createAtaIx(authority.publicKey, authority.publicKey, cardsMint, TOKENKEG),
    mintToIx(TOKENKEG, cardsMint, authorityCards, authority.publicKey, gross),
    client.initCardsRewardVaultsIx({ programId: PROGRAM_ID, payer: authority.publicKey, cardsMint }),
  ]);
  await send(connection, authority, [
    transferIx(TOKENKEG, authorityCards, treasuryVault, authority.publicKey, split.tournament),
    transferIx(TOKENKEG, authorityCards, operatorVault, authority.publicKey, split.operator),
  ]);
  if (await balance(connection, treasuryVault) !== split.tournament) throw new Error('Tournament treasury did not receive 90%.');
  if (await balance(connection, operatorVault) !== split.operator) throw new Error('Operator allocation did not receive 10%.');

  const keeperCards = ata(cardsMint, keeper.publicKey, TOKENKEG);
  await send(connection, authority, [createAtaIx(authority.publicKey, keeper.publicKey, cardsMint, TOKENKEG)]);
  await expectReject('operator claim to a non-authority destination', () => send(connection, authority, [client.claimCardsOperatorIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    cardsMint,
    destination: keeperCards,
    amount: split.operator,
    claimKey: key32('bad-destination'),
  })]));
  await expectReject('unauthorized operator claim', () => send(connection, keeper, [client.claimCardsOperatorIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    cardsMint,
    destination: authorityCards,
    amount: split.operator,
    claimKey: key32('bad-authority'),
  })]));
  await send(connection, authority, [client.claimCardsOperatorIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    cardsMint,
    destination: authorityCards,
    amount: split.operator,
    claimKey: key32('operator-claim'),
  })]);
  if (await balance(connection, authorityCards) !== split.operator) throw new Error('Operator claim did not pay the authority.');
  if (await balance(connection, operatorVault) !== 0n) throw new Error('Operator vault was not debited.');
  await expectReject('replayed operator claim', () => send(connection, authority, [client.claimCardsOperatorIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    cardsMint,
    destination: authorityCards,
    amount: 1n,
    claimKey: key32('operator-claim'),
  })]));

  const prizeId = id16('prize');
  const prizeVault = client.cardsPrizeVaultPda(PROGRAM_ID, prizeId)[0];
  await expectReject('prize funding above the treasury', () => send(connection, keeper, [client.fundCardsPrizeFromTreasuryIx({
    programId: PROGRAM_ID,
    fundingAuthority: keeper.publicKey,
    cardsMint,
    tournamentId: id16('too-much'),
    amount: split.tournament + 1n,
    fundingKey: key32('too-much'),
  })]));
  await send(connection, keeper, [client.fundCardsPrizeFromTreasuryIx({
    programId: PROGRAM_ID,
    fundingAuthority: keeper.publicKey,
    cardsMint,
    tournamentId: prizeId,
    amount: split.tournament,
    fundingKey: key32('fund-prize'),
  })]);
  if (await balance(connection, treasuryVault) !== 0n) throw new Error('Treasury was not moved into the prize reserve.');
  if (await balance(connection, prizeVault) !== split.tournament) throw new Error('Prize vault was not funded.');
  await send(connection, keeper, [client.setCardsPrizeWinnerIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    winner: winner.publicKey,
    tournamentId: prizeId,
  })]);
  const winnerCards = ata(cardsMint, winner.publicKey, TOKENKEG);
  if (await connection.getAccountInfo(winnerCards, 'confirmed')) throw new Error('Winner ATA already existed.');
  await expectReject('wrong winner payout', () => send(connection, keeper, [client.payCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    cardsMint,
    winner: intruder.publicKey,
    winnerCards: ata(cardsMint, intruder.publicKey, TOKENKEG),
    tournamentId: prizeId,
    settlementKey: key32('wrong-winner'),
  })]));
  await send(connection, keeper, [
    createAtaIx(keeper.publicKey, winner.publicKey, cardsMint, TOKENKEG),
    client.payCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      cardsMint,
      winner: winner.publicKey,
      winnerCards,
      tournamentId: prizeId,
      settlementKey: key32('pay-prize'),
    }),
  ]);
  if (await balance(connection, winnerCards) !== split.tournament) throw new Error('Winner did not receive the prize.');
  if (await balance(connection, prizeVault) !== 0n) throw new Error('Prize vault was not debited exactly.');
  await expectReject('replayed prize payout', () => send(connection, keeper, [client.payCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    cardsMint,
    winner: winner.publicKey,
    winnerCards,
    tournamentId: prizeId,
    settlementKey: key32('pay-prize'),
  })]));

  const roomId = id16('wager');
  const collateral = 1_000_000_000;
  await send(connection, player, [
    client.createMatchEscrowIx({
      programId: PROGRAM_ID,
      creator: player.publicKey,
      config,
      roomId,
      collateralLamports: collateral,
    }),
    client.depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: player.publicKey,
      roomId,
      side: 0,
    }),
  ]);
  await send(connection, keeper, [client.seatMatchOpponentIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    opponent: opponent.publicKey,
    roomId,
  })]);
  await send(connection, opponent, [client.depositSolWagerIx({
    programId: PROGRAM_ID,
    depositor: opponent.publicKey,
    roomId,
    side: 1,
  })]);
  const feeVaultBefore = await connection.getBalance(feeVault, 'confirmed');
  await send(connection, keeper, [client.chargeMatchFeeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    feeVault,
    roomId,
  })]);
  const fee = 40_000_000;
  const feeVaultAfter = await connection.getBalance(feeVault, 'confirmed');
  if (feeVaultAfter - feeVaultBefore !== fee) throw new Error(`2% fee was ${feeVaultAfter - feeVaultBefore}, expected ${fee}.`);
  const winnerBefore = await connection.getBalance(player.publicKey, 'confirmed');
  await send(connection, keeper, [client.settleMatchWinIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    winner: player.publicKey,
    roomId,
    settlementKey: key32('settle'),
  })]);
  const winnerGain = (await connection.getBalance(player.publicKey, 'confirmed')) - winnerBefore;
  if (winnerGain !== collateral * 2 - fee) throw new Error(`Winner payout was ${winnerGain}.`);
  await expectReject('replayed settlement', () => send(connection, keeper, [client.settleMatchWinIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    winner: player.publicKey,
    roomId,
    settlementKey: key32('settle'),
  })]));

  const vaultBeforeClaim = await connection.getBalance(feeVault, 'confirmed');
  await send(connection, authority, [client.claimFeeVaultIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    feeVault,
    destination: authority.publicKey,
    claimKey: key32('fee-claim'),
  })]);
  const claimed = vaultBeforeClaim - await connection.getBalance(feeVault, 'confirmed');
  if (claimed !== fee) throw new Error(`Fee-vault claim paid ${claimed}, expected ${fee}.`);
  await expectReject('replayed fee-vault claim', () => send(connection, authority, [client.claimFeeVaultIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    feeVault,
    destination: authority.publicKey,
    claimKey: key32('fee-claim'),
  })]));
  await expectReject('keeper cannot claim the fee vault', () => send(connection, keeper, [client.claimFeeVaultIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    feeVault,
    destination: keeper.publicKey,
    claimKey: key32('keeper-fee'),
  })]));
  await expectReject('legacy SOL prize', () => send(connection, keeper, [client.reservePrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    treasuryVault: client.treasuryVaultPda(PROGRAM_ID)[0],
    tournamentId: id16('sol-prize'),
    amount: 1,
  })]));
  await expectReject('buyback swap', () => send(connection, keeper, [client.buybackAndBurnPokeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    feeVault,
    swapWallet: keeper.publicKey,
    pokeMint,
    pokeBurnSource: playerPoke,
    buybackKey: key32('buyback'),
    solAmount: 1,
    minPokeOut: 1,
  })]));

  await send(connection, authority, [
    mintToIx(TOKEN_2022, pokeMint, playerPoke, authority.publicKey, ENTRY * 8n),
    mintToIx(TOKENKEG, cardsMint, authorityCards, authority.publicKey, 20_000n),
  ]);
  await send(connection, authority, [
    transferIx(TOKENKEG, authorityCards, treasuryVault, authority.publicKey, 20_000n),
  ]);

  async function rentOf(pubkey) {
    const info = await connection.getAccountInfo(pubkey, 'confirmed');
    if (!info) throw new Error(`Account missing: ${pubkey.toBase58()}`);
    return info.lamports;
  }

  async function assertGone(pubkeys) {
    for (const pubkey of pubkeys) {
      if (await connection.getAccountInfo(pubkey, 'confirmed')) {
        throw new Error(`Closed account still exists: ${pubkey.toBase58()}`);
      }
    }
  }

  const collateralSmall = 1_000_000;
  async function openAndSettle(label) {
    const matchRoom = id16(label);
    const settlementKey = key32(`${label}-settle`);
    await send(connection, player, [
      client.createMatchEscrowIx({
        programId: PROGRAM_ID,
        creator: player.publicKey,
        config,
        roomId: matchRoom,
        collateralLamports: collateralSmall,
      }),
      client.depositSolWagerIx({
        programId: PROGRAM_ID,
        depositor: player.publicKey,
        roomId: matchRoom,
        side: 0,
      }),
    ]);
    await send(connection, keeper, [client.seatMatchOpponentIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      opponent: opponent.publicKey,
      roomId: matchRoom,
    })]);
    await send(connection, opponent, [client.depositSolWagerIx({
      programId: PROGRAM_ID,
      depositor: opponent.publicKey,
      roomId: matchRoom,
      side: 1,
    })]);
    await send(connection, keeper, [client.chargeMatchFeeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      feeVault,
      roomId: matchRoom,
    })]);
    await send(connection, keeper, [client.settleMatchWinIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      winner: player.publicKey,
      roomId: matchRoom,
      settlementKey,
    })]);
    return { matchRoom, settlementKey };
  }

  function matchCloseIx(matchRoom, settlementKey, authoritySigner, recipient) {
    return client.closeSettledMatchIx({
      programId: PROGRAM_ID,
      authority: authoritySigner,
      recipient,
      roomId: matchRoom,
      settlementKey,
    });
  }

  function matchAccountsOf(matchRoom, settlementKey) {
    return [
      client.matchEscrowPda(PROGRAM_ID, matchRoom)[0],
      client.matchVaultPda(PROGRAM_ID, matchRoom)[0],
      client.replayPda(PROGRAM_ID, settlementKey)[0],
    ];
  }

  const activeRoom = id16('active-match');
  await send(connection, player, [client.createMatchEscrowIx({
    programId: PROGRAM_ID,
    creator: player.publicKey,
    config,
    roomId: activeRoom,
    collateralLamports: collateralSmall,
  })]);
  await expectReject('active match cannot close', () => send(connection, keeper, [
    matchCloseIx(activeRoom, key32('active-match-settle'), keeper.publicKey, player.publicKey),
  ]));

  const reservedEntry = id16('active-entry');
  await send(connection, player, [client.depositPokeEntryIx({
    programId: PROGRAM_ID,
    player: player.publicKey,
    config,
    pokeMint,
    playerPoke,
    tournamentId: reservedEntry,
    amount: ENTRY,
    quoteId: key32('active-entry'),
    priceMicroUsd: 1_000_000,
  })]);
  await expectReject('active entry cannot close', () => send(connection, keeper, [client.closeFinalEntryIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    recipient: player.publicKey,
    tournamentId: reservedEntry,
    player: player.publicKey,
    burnKey: key32('active-entry-burn'),
  })]));

  const unpaidPrize = id16('unpaid-prize');
  await send(connection, keeper, [client.fundCardsPrizeFromTreasuryIx({
    programId: PROGRAM_ID,
    fundingAuthority: keeper.publicKey,
    cardsMint,
    tournamentId: unpaidPrize,
    amount: 1_000n,
    fundingKey: key32('unpaid-fund'),
  })]);
  await expectReject('unpaid prize cannot close', () => send(connection, keeper, [client.closeFinalCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    recipient: authority.publicKey,
    cardsMint,
    tournamentId: unpaidPrize,
    fundingKey: key32('unpaid-fund'),
    payoutKey: key32('unpaid-pay'),
  })]));

  await expectReject('unauthorized match close', () => send(connection, intruder, [
    matchCloseIx(roomId, key32('settle'), intruder.publicKey, player.publicKey),
  ]));
  const wrongVault = matchCloseIx(roomId, key32('settle'), keeper.publicKey, player.publicKey);
  wrongVault.keys[4] = { pubkey: feeVault, isSigner: false, isWritable: true };
  await expectReject('wrong match vault', () => send(connection, keeper, [wrongVault]));
  const wrongReplay = matchCloseIx(roomId, key32('settle'), keeper.publicKey, player.publicKey);
  wrongReplay.keys[5] = {
    pubkey: client.replayPda(PROGRAM_ID, key32('fee-claim'))[0],
    isSigner: false,
    isWritable: true,
  };
  await expectReject('wrong settlement replay', () => send(connection, keeper, [wrongReplay]));
  await expectReject('fee-vault replay still blocks a second claim', () => send(connection, authority, [client.claimFeeVaultIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    feeVault,
    destination: authority.publicKey,
    claimKey: key32('fee-claim'),
  })]));

  const settledAccounts = matchAccountsOf(roomId, key32('settle'));
  const settledRent = (await rentOf(settledAccounts[0])) + (await rentOf(settledAccounts[1])) + (await rentOf(settledAccounts[2]));
  const creatorBeforeClose = await connection.getBalance(player.publicKey, 'confirmed');
  await send(connection, keeper, [matchCloseIx(roomId, key32('settle'), keeper.publicKey, player.publicKey)]);
  const creatorRentGain = (await connection.getBalance(player.publicKey, 'confirmed')) - creatorBeforeClose;
  if (creatorRentGain !== settledRent) throw new Error(`Match rent went to creator as ${creatorRentGain}, expected ${settledRent}.`);
  await assertGone(settledAccounts);
  const settledClosure = await client.closureState(connection, settledAccounts);
  if (settledClosure !== 'closed') throw new Error('Settled match close was not reconciled.');
  let resentClose = false;
  if (settledClosure === 'open') {
    resentClose = true;
    await send(connection, keeper, [matchCloseIx(roomId, key32('settle'), keeper.publicKey, player.publicKey)]);
  }
  if (resentClose) throw new Error('Unknown RPC result submitted a second close.');
  const creatorAfterReconcile = await connection.getBalance(player.publicKey, 'confirmed');
  await expectReject('duplicate match close', () => send(connection, keeper, [
    matchCloseIx(roomId, key32('settle'), keeper.publicKey, player.publicKey),
  ]));
  if ((await connection.getBalance(player.publicKey, 'confirmed')) !== creatorAfterReconcile) {
    throw new Error('Duplicate close moved rent a second time.');
  }
  await expectReject('closed match settlement replay', () => send(connection, keeper, [client.settleMatchWinIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    winner: player.publicKey,
    roomId,
    settlementKey: key32('settle'),
  })]));

  const burnedEntryAccounts = [
    client.entryEscrowPda(PROGRAM_ID, tournamentId, player.publicKey)[0],
    client.entryVaultPda(PROGRAM_ID, tournamentId, player.publicKey)[0],
    client.replayPda(PROGRAM_ID, key32('burn'))[0],
  ];
  const entryRent = (await rentOf(burnedEntryAccounts[0])) + (await rentOf(burnedEntryAccounts[1])) + (await rentOf(burnedEntryAccounts[2]));
  const playerBeforeEntryClose = await connection.getBalance(player.publicKey, 'confirmed');
  await send(connection, keeper, [client.closeFinalEntryIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    recipient: player.publicKey,
    tournamentId,
    player: player.publicKey,
    burnKey: key32('burn'),
  })]);
  const entryRentGain = (await connection.getBalance(player.publicKey, 'confirmed')) - playerBeforeEntryClose;
  if (entryRentGain !== entryRent) throw new Error(`Entry rent went to player as ${entryRentGain}, expected ${entryRent}.`);
  await assertGone(burnedEntryAccounts);
  await expectReject('closed entry burn replay', () => send(connection, keeper, [client.burnPokeEntryIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    pokeMint,
    tournamentId,
    player: player.publicKey,
    burnKey: key32('burn'),
  })]));

  await expectReject('prize rent cannot be redirected', () => send(connection, keeper, [client.closeFinalCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    recipient: keeper.publicKey,
    cardsMint,
    tournamentId: prizeId,
    fundingKey: key32('fund-prize'),
    payoutKey: key32('pay-prize'),
  })]));
  const prizeAccounts = [
    client.cardsPrizeReservePda(PROGRAM_ID, prizeId)[0],
    client.cardsPrizeVaultPda(PROGRAM_ID, prizeId)[0],
    client.replayPda(PROGRAM_ID, key32('fund-prize'))[0],
    client.replayPda(PROGRAM_ID, key32('pay-prize'))[0],
  ];
  const prizeRent = (await rentOf(prizeAccounts[0])) + (await rentOf(prizeAccounts[1])) + (await rentOf(prizeAccounts[2])) + (await rentOf(prizeAccounts[3]));
  const authorityBeforePrizeClose = await connection.getBalance(authority.publicKey, 'confirmed');
  await send(connection, keeper, [client.closeFinalCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    recipient: authority.publicKey,
    cardsMint,
    tournamentId: prizeId,
    fundingKey: key32('fund-prize'),
    payoutKey: key32('pay-prize'),
  })]);
  const prizeRentGain = (await connection.getBalance(authority.publicKey, 'confirmed')) - authorityBeforePrizeClose;
  if (prizeRentGain !== prizeRent) throw new Error(`Prize rent went to authority as ${prizeRentGain}, expected ${prizeRent}.`);
  await assertGone(prizeAccounts);
  await expectReject('closed prize payout replay', () => send(connection, keeper, [client.payCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    cardsMint,
    winner: winner.publicKey,
    winnerCards,
    tournamentId: prizeId,
    settlementKey: key32('pay-prize'),
  })]));

  const nonzero = await openAndSettle('nonzero-match');
  const nonzeroVault = client.matchVaultPda(PROGRAM_ID, nonzero.matchRoom)[0];
  await send(connection, keeper, [SystemProgram.transfer({
    fromPubkey: keeper.publicKey,
    toPubkey: nonzeroVault,
    lamports: 1,
  })]);
  await expectReject('close with non-zero balance', () => send(connection, keeper, [
    matchCloseIx(nonzero.matchRoom, nonzero.settlementKey, keeper.publicKey, player.publicKey),
  ]));

  await send(connection, player, [client.depositSolWagerIx({
    programId: PROGRAM_ID,
    depositor: player.publicKey,
    roomId: activeRoom,
    side: 0,
  })]);
  await send(connection, keeper, [client.seatMatchOpponentIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    opponent: opponent.publicKey,
    roomId: activeRoom,
  })]);
  await send(connection, opponent, [client.depositSolWagerIx({
    programId: PROGRAM_ID,
    depositor: opponent.publicKey,
    roomId: activeRoom,
    side: 1,
  })]);
  await send(connection, keeper, [client.chargeMatchFeeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    feeVault,
    roomId: activeRoom,
  })]);
  await send(connection, keeper, [client.settleMatchWinIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    winner: player.publicKey,
    roomId: activeRoom,
    settlementKey: key32('active-match-settle'),
  })]);
  await send(connection, keeper, [matchCloseIx(activeRoom, key32('active-match-settle'), keeper.publicKey, player.publicKey)]);

  const activeBurnKey = key32('active-entry-burn');
  await send(connection, keeper, [client.burnPokeEntryIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    pokeMint,
    tournamentId: reservedEntry,
    player: player.publicKey,
    burnKey: activeBurnKey,
  })]);
  await send(connection, keeper, [client.closeFinalEntryIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    recipient: player.publicKey,
    tournamentId: reservedEntry,
    player: player.publicKey,
    burnKey: activeBurnKey,
  })]);

  await send(connection, keeper, [client.setCardsPrizeWinnerIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    winner: winner.publicKey,
    tournamentId: unpaidPrize,
  })]);
  await send(connection, keeper, [client.payCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    config,
    cardsMint,
    winner: winner.publicKey,
    winnerCards,
    tournamentId: unpaidPrize,
    settlementKey: key32('unpaid-pay'),
  })]);
  await send(connection, keeper, [client.closeFinalCardsPrizeIx({
    programId: PROGRAM_ID,
    authority: keeper.publicKey,
    recipient: authority.publicKey,
    cardsMint,
    tournamentId: unpaidPrize,
    fundingKey: key32('unpaid-fund'),
    payoutKey: key32('unpaid-pay'),
  })]);

  async function programSnapshot() {
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed' });
    let lamports = 0;
    let unexpectedExcess = 0;
    for (const account of accounts) {
      lamports += account.account.lamports;
      const rent = await connection.getMinimumBalanceForRentExemption(account.account.data.length);
      const extra = account.account.lamports - rent;
      if (extra !== 0 && !account.pubkey.equals(nonzeroVault)) unexpectedExcess += extra;
    }
    return { count: accounts.length, lamports, unexpectedExcess };
  }

  await send(connection, authority, [client.claimFeeVaultIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    feeVault,
    destination: authority.publicKey,
    claimKey: key32('lifecycle-fee-claim'),
  })]);
  const beforeStress = await programSnapshot();
  if (beforeStress.unexpectedExcess !== 0) {
    throw new Error(`Protocol funds already trapped: ${beforeStress.unexpectedExcess} lamports.`);
  }
  const stressPrize = 1_000n;
  for (let index = 0; index < 3; index += 1) {
    const label = `stress-${index}`;
    const finished = await openAndSettle(label);
    await send(connection, keeper, [matchCloseIx(finished.matchRoom, finished.settlementKey, keeper.publicKey, player.publicKey)]);
    const stressEntry = id16(`${label}-entry`);
    const stressBurn = key32(`${label}-burn`);
    await send(connection, player, [client.depositPokeEntryIx({
      programId: PROGRAM_ID,
      player: player.publicKey,
      config,
      pokeMint,
      playerPoke,
      tournamentId: stressEntry,
      amount: ENTRY,
      quoteId: key32(`${label}-quote`),
      priceMicroUsd: 1_000_000,
    })]);
    await send(connection, keeper, [client.burnPokeEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      pokeMint,
      tournamentId: stressEntry,
      player: player.publicKey,
      burnKey: stressBurn,
    })]);
    await send(connection, keeper, [client.closeFinalEntryIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: player.publicKey,
      tournamentId: stressEntry,
      player: player.publicKey,
      burnKey: stressBurn,
    })]);
    const stressPrizeId = id16(`${label}-prize`);
    const stressFund = key32(`${label}-fund`);
    const stressPay = key32(`${label}-pay`);
    await send(connection, keeper, [client.fundCardsPrizeFromTreasuryIx({
      programId: PROGRAM_ID,
      fundingAuthority: keeper.publicKey,
      cardsMint,
      tournamentId: stressPrizeId,
      amount: stressPrize,
      fundingKey: stressFund,
    })]);
    await send(connection, keeper, [client.setCardsPrizeWinnerIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      winner: winner.publicKey,
      tournamentId: stressPrizeId,
    })]);
    await send(connection, keeper, [client.payCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      config,
      cardsMint,
      winner: winner.publicKey,
      winnerCards,
      tournamentId: stressPrizeId,
      settlementKey: stressPay,
    })]);
    await send(connection, keeper, [client.closeFinalCardsPrizeIx({
      programId: PROGRAM_ID,
      authority: keeper.publicKey,
      recipient: authority.publicKey,
      cardsMint,
      tournamentId: stressPrizeId,
      fundingKey: stressFund,
      payoutKey: stressPay,
    })]);
    await assertGone([
      ...matchAccountsOf(finished.matchRoom, finished.settlementKey),
      client.entryEscrowPda(PROGRAM_ID, stressEntry, player.publicKey)[0],
      client.entryVaultPda(PROGRAM_ID, stressEntry, player.publicKey)[0],
      client.replayPda(PROGRAM_ID, stressBurn)[0],
      client.cardsPrizeReservePda(PROGRAM_ID, stressPrizeId)[0],
      client.cardsPrizeVaultPda(PROGRAM_ID, stressPrizeId)[0],
      client.replayPda(PROGRAM_ID, stressFund)[0],
      client.replayPda(PROGRAM_ID, stressPay)[0],
    ]);
  }
  const stressFees = 3 * Math.floor((collateralSmall * 2 * 200) / 10_000);
  const afterEvents = await programSnapshot();
  if (afterEvents.count !== beforeStress.count) {
    throw new Error(`Completed events left accounts behind: ${beforeStress.count} to ${afterEvents.count}.`);
  }
  if (afterEvents.unexpectedExcess !== stressFees) {
    throw new Error(`Unclaimed match fees were ${afterEvents.unexpectedExcess}, expected ${stressFees}.`);
  }
  const feeVaultBeforeStressClaim = await connection.getBalance(feeVault, 'confirmed');
  await send(connection, authority, [client.claimFeeVaultIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    feeVault,
    destination: authority.publicKey,
    claimKey: key32('stress-fee-claim'),
  })]);
  const stressClaimed = feeVaultBeforeStressClaim - await connection.getBalance(feeVault, 'confirmed');
  if (stressClaimed !== stressFees) throw new Error(`Stress fees claimed ${stressClaimed}, expected ${stressFees}.`);
  await expectReject('replayed stress fee claim', () => send(connection, authority, [client.claimFeeVaultIx({
    programId: PROGRAM_ID,
    authority: authority.publicKey,
    feeVault,
    destination: authority.publicKey,
    claimKey: key32('stress-fee-claim'),
  })]));
  const afterStress = await programSnapshot();
  if (afterStress.count !== beforeStress.count + 1) {
    throw new Error(`Fee-claim replay did not account for the count change: ${beforeStress.count} to ${afterStress.count}.`);
  }
  if (afterStress.unexpectedExcess !== 0) {
    throw new Error(`Protocol funds trapped after stress: ${afterStress.unexpectedExcess} lamports.`);
  }
  if (await balance(connection, treasuryVault) !== 20_000n - 1_000n - stressPrize * 3n) {
    throw new Error('Treasury CARDS balance does not match prizes paid.');
  }

  const elf = readFileSync(join(process.cwd(), 'target/deploy/arena_escrow_pinocchio.so'));
  const programDataRent = await connection.getMinimumBalanceForRentExemption(45 + elf.length);
  console.log(JSON.stringify({
    ok: true,
    programId: FRESH_PROGRAM,
    genesis,
    artifactBytes: elf.length,
    programDataRentLamports: programDataRent,
    passport: client.POKEARENA_PASSPORT_MIN_USD,
    entryAtoms: ENTRY.toString(),
    cardsSplit: { gross: gross.toString(), tournament: split.tournament.toString(), operator: split.operator.toString() },
    feeLamports: fee,
    lifecycle: {
      matchRentToCreator: creatorRentGain,
      entryRentToPlayer: entryRentGain,
      prizeRentToAuthority: prizeRentGain,
      programAccountsBeforeStress: beforeStress.count,
      programAccountsAfterEvents: afterEvents.count,
      programAccountsAfterFeeClaim: afterStress.count,
      trappedLamports: afterStress.unexpectedExcess,
    },
  }));
}

main().catch(async error => {
  if (error instanceof SendTransactionError) {
    try {
      console.error((await error.getLogs(new Connection(RPC, 'confirmed'))).join('\n'));
    } catch {
      // Keep the original error.
    }
  }
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
