#!/usr/bin/env node

/*
 * Internal staging-only smoke harness.
 *
 * This intentionally creates only a disposable database tournament row and
 * then delegates all CARDS movement to ChainEconomyService's production
 * reserveTournamentCardsPrize path. It is not a public API route.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Keypair, PublicKey } = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const { Client } = require('pg');
const {
  TOURNAMENT_BURN_FEE_ATOMS,
  cardsPrizeVaultPda,
  uuidToBytes,
} = require('@pokearena/solana-client');
const {
  assertStagingFundingSmokeAccess,
} = require('../dist/src/chain-economy.js');
const { createApiServer } = require('../dist/src/server.js');

const EXPECTED_PROGRAM = 'HRN7567mTaH27Bhngu4Rg7JUQ8bvZp6Ymmf7XRT99rZk';
const EXPECTED_CARDS = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp';
const EXPECTED_CREATOR = 'J7ZwQKeY4aVG5kAJKkxynRnSaC9xgArN4ry4ihh6Xs12';
const EXPECTED_KEEPER = 'DFo1hqiFQ5crfZrrUVfV82RputSKPevRsZjNDwCfs6Co';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseAmount() {
  const value = Number(arg('amount', '1'));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('--amount must be a positive safe integer.');
  }
  return value;
}

function loadCreator() {
  const path = required(
    process.env.POKEARENA_CREATOR_REWARDS_KEYPAIR,
    'POKEARENA_CREATOR_REWARDS_KEYPAIR',
  );
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))));
}

async function tokenBalance(connection, mint, owner) {
  const ata = splToken.getAssociatedTokenAddressSync(mint, owner, true);
  try {
    const account = await connection.getAccountInfo(ata, 'confirmed');
    if (!account) {
      return { address: ata.toBase58(), amount: 0n };
    }
    return {
      address: ata.toBase58(),
      amount: BigInt((await connection.getTokenAccountBalance(ata, 'confirmed')).value.amount),
    };
  } catch {
    return { address: ata.toBase58(), amount: 0n };
  }
}

async function directTokenBalance(connection, address) {
  try {
    const account = await connection.getAccountInfo(address, 'confirmed');
    if (!account) {
      return { address: address.toBase58(), amount: 0n };
    }
    return {
      address: address.toBase58(),
      amount: BigInt((await connection.getTokenAccountBalance(address, 'confirmed')).value.amount),
    };
  } catch {
    return { address: address.toBase58(), amount: 0n };
  }
}

async function readLedger(db, mint) {
  const result = await db.query(
    `SELECT gross_raw, tournament_allocated_raw, operator_allocated_raw,
            operator_claimed_raw, tournament_committed_raw
       FROM creator_reward_ledger
      WHERE cards_mint = $1`,
    [mint.toBase58()],
  );
  if (!result.rows[0]) throw new Error('Creator-reward ledger is missing.');
  return result.rows[0];
}

async function readIntent(db, tournamentId) {
  const result = await db.query(
    `SELECT i.id, i.status, i.metadata, i.amount,
            tx.signature, tx.status AS tx_status
       FROM chain_intents i
       LEFT JOIN LATERAL (
         SELECT signature, status
           FROM chain_txs
          WHERE intent_id = i.id
          ORDER BY created_at DESC
          LIMIT 1
       ) tx ON true
      WHERE i.kind = $1 AND i.scope_id = $2
      ORDER BY i.created_at DESC
      LIMIT 1`,
    ['cards_prize_fund', tournamentId],
  );
  return result.rows[0] ?? null;
}

async function main() {
  const token = required(arg('token'), '--token');
  const amountRaw = parseAmount();
  assertStagingFundingSmokeAccess(process.env, token);
  console.error('[staging-funding-smoke] authorization ok');

  const creator = loadCreator();
  const server = await createApiServer();
  console.error('[staging-funding-smoke] api initialized');
  const db = new Client({ connectionString: process.env.POKEARENA_DATABASE_URL });
  await db.connect();
  console.error('[staging-funding-smoke] database connected');

  try {
    const economy = server.chainEconomy;
    const client = economy.client;
    if (!client) throw new Error('Chain client is unavailable.');
    if (economy.config.programId.toBase58() !== EXPECTED_PROGRAM) {
      throw new Error('Unexpected staging program.');
    }
    if (economy.config.cardsMint.toBase58() !== EXPECTED_CARDS) {
      throw new Error('Unexpected staging CARDS mint.');
    }
    if (economy.config.keeper.toBase58() !== EXPECTED_KEEPER) {
      throw new Error('Unexpected staging keeper.');
    }
    if (creator.publicKey.toBase58() !== EXPECTED_CREATOR) {
      throw new Error('Unexpected creator-reward signer.');
    }
    if (!Number.isSafeInteger(amountRaw) || amountRaw <= 0) {
      throw new Error('Prize amount must be positive.');
    }

    const ledgerBefore = await readLedger(db, economy.config.cardsMint);
    console.error('[staging-funding-smoke] ledger preflight ok');
    const available = Number(ledgerBefore.tournament_allocated_raw)
      - Number(ledgerBefore.tournament_committed_raw);
    if (available < amountRaw) throw new Error('Tournament allocation is insufficient.');
    if (Number(ledgerBefore.operator_claimed_raw)
      !== Number(ledgerBefore.operator_allocated_raw)) {
      throw new Error('Operator allocation is not fully claimed; refusing to use it.');
    }

    const creatorCardsBefore = await tokenBalance(
      client.connection,
      economy.config.cardsMint,
      creator.publicKey,
    );
    console.error('[staging-funding-smoke] creator CARDS read');
    const keeperCardsBefore = await tokenBalance(
      client.connection,
      economy.config.cardsMint,
      economy.config.keeper,
    );
    console.error('[staging-funding-smoke] keeper CARDS read');
    const creatorSolBefore = await client.getSolBalance(creator.publicKey);
    const keeperSolBefore = await client.getSolBalance(economy.config.keeper);
    if (creatorCardsBefore.amount < BigInt(amountRaw)) {
      throw new Error('Creator wallet lacks the requested CARDS amount.');
    }

    let tournamentId = arg('tournament-id', randomUUID());
    const existingTournament = await server.tournaments.getTournament(tournamentId).catch(() => null);
    if (!existingTournament) {
      const tournament = await server.tournaments.createTournament({
        title: `Internal funding smoke ${tournamentId}`,
        format: 'gen9ou',
        ruleset: 'gen9ou',
        maxPlayers: 32,
        matchTimeoutMs: 300_000,
        hostId: `staging-funding-smoke-${tournamentId}`,
        entryFee: 0,
        rail: 'sol_chain',
        entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
        prizeCardsRaw: amountRaw,
      });
      await server.tournaments.openRegistration(tournament.id);
      tournamentId = tournament.id;
    } else if (existingTournament.prizeCardsRaw !== amountRaw) {
      throw new Error('Existing smoke tournament prize does not match --amount.');
    }
    console.error(`[staging-funding-smoke] using tournament id ${tournamentId}`);
    const tournamentBytes = uuidToBytes(tournamentId);
    console.error('[staging-funding-smoke] uuid encoded');
    const [vault] = cardsPrizeVaultPda(economy.config.programId, tournamentBytes);
    console.error(`[staging-funding-smoke] vault derived ${vault.toBase58()}`);
    const prizeVaultBefore = await directTokenBalance(client.connection, vault);
    console.error('[staging-funding-smoke] prize vault read');
    const existingReserve = await client.getCardsPrizeReserveState(tournamentBytes).catch(() => null);
    if (existingReserve && (
      existingReserve.status !== 0
      || existingReserve.cardsAmount !== BigInt(amountRaw)
    )) {
      throw new Error('Existing smoke tournament prize reserve does not match --amount.');
    }
    const existingIntent = await readIntent(db, tournamentId);
    const creatorTransferAlreadyConfirmed = existingIntent?.metadata?.creatorTransfer === 'confirmed'
      && typeof existingIntent.metadata.creatorTransferSignature === 'string';
    if (keeperCardsBefore.amount !== 0n) {
      if (!creatorTransferAlreadyConfirmed || keeperCardsBefore.amount !== BigInt(amountRaw)) {
        throw new Error('Keeper CARDS account is nonzero without a matching recoverable funding operation.');
      }
    }
    if (!existingReserve) {
      const reserveRent = await client.connection.getMinimumBalanceForRentExemption(98);
      const vaultRent = await client.connection.getMinimumBalanceForRentExemption(165);
      const estimatedFundingLamports = reserveRent + vaultRent + 10_000;
      if (keeperSolBefore < BigInt(estimatedFundingLamports)) {
        throw new Error(
          `Keeper SOL is insufficient for prize reserve/vault rent and fees: `
          + `${keeperSolBefore} < ${estimatedFundingLamports} lamports.`,
        );
      }
    }
    console.error(`[staging-funding-smoke] tournament row ready ${tournamentId}`);

    const funding = await economy.runStagingTournamentFundingSmoke({
      tournamentId,
      prizeCardsRaw: amountRaw,
      authorization: token,
    });
    console.error('[staging-funding-smoke] first funding invocation complete');
    const repeatFunding = await economy.runStagingTournamentFundingSmoke({
      tournamentId,
      prizeCardsRaw: amountRaw,
      authorization: token,
    });
    console.error('[staging-funding-smoke] repeat funding invocation complete');

    const creatorCardsAfter = await tokenBalance(
      client.connection,
      economy.config.cardsMint,
      creator.publicKey,
    );
    const keeperCardsAfter = await tokenBalance(
      client.connection,
      economy.config.cardsMint,
      economy.config.keeper,
    );
    const prizeVaultAfter = await directTokenBalance(client.connection, vault);
    const reserveAfter = await client.getCardsPrizeReserveState(tournamentBytes);
    const ledgerAfter = await readLedger(db, economy.config.cardsMint);
    const intentAfter = await readIntent(db, tournamentId);
    const expectedCreatorDelta = creatorTransferAlreadyConfirmed ? 0n : BigInt(amountRaw);
    const expectedPrizeDelta = existingReserve ? 0n : BigInt(amountRaw);
    if (creatorCardsBefore.amount - creatorCardsAfter.amount !== expectedCreatorDelta) {
      throw new Error('Creator CARDS delta does not equal the requested prize.');
    }
    if (keeperCardsAfter.amount !== 0n) {
      throw new Error('Keeper retained CARDS after prize funding.');
    }
    if (prizeVaultAfter.amount - prizeVaultBefore.amount !== expectedPrizeDelta) {
      throw new Error('Prize vault delta does not equal the requested prize.');
    }
    if (reserveAfter.status !== 0 || reserveAfter.cardsAmount !== BigInt(amountRaw)) {
      throw new Error('On-chain CARDS prize reserve is not confirmed.');
    }
    if (Number(ledgerAfter.tournament_committed_raw)
      - Number(ledgerBefore.tournament_committed_raw) !== Number(creatorTransferAlreadyConfirmed
        ? 0n
        : BigInt(amountRaw))) {
      throw new Error('Tournament ledger commitment delta is incorrect.');
    }

    process.stdout.write(JSON.stringify({
      tournamentId,
      amountRaw,
      creator: creator.publicKey.toBase58(),
      keeper: economy.config.keeper.toBase58(),
      prizeVault: vault.toBase58(),
      creatorCardsBefore: creatorCardsBefore.amount.toString(),
      creatorCardsAfter: creatorCardsAfter.amount.toString(),
      keeperCardsBefore: keeperCardsBefore.amount.toString(),
      keeperCardsAfter: keeperCardsAfter.amount.toString(),
      prizeVaultBefore: prizeVaultBefore.amount.toString(),
      prizeVaultAfter: prizeVaultAfter.amount.toString(),
      creatorSolBefore: creatorSolBefore.toString(),
      keeperSolBefore: keeperSolBefore.toString(),
      ledgerBefore,
      ledgerAfter,
      intent: intentAfter,
      funding,
      repeatFunding,
      repeatedInvocationIdempotent: true,
      resumedExistingCreatorTransfer: creatorTransferAlreadyConfirmed,
    }, null, 2) + '\n');
  } finally {
    await db.end().catch(error => {
      console.error('[staging-funding-smoke] database close failed', error.message);
    });
    await server.close().catch(error => {
      console.error('[staging-funding-smoke] api close failed', error.message);
    });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
