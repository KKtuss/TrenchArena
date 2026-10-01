#!/usr/bin/env node
/**
 * Call arena-escrow initialize_config against a local/devnet cluster.
 * Reads addresses from env (typically scripts/solana/.local.env).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const clientRequire = createRequire(join(root, 'packages/solana-client/package.json'));
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = clientRequire('@solana/web3.js');

function loadClient() {
  try {
    return clientRequire(join(root, 'packages/solana-client/dist/src/index.js'));
  } catch {
    throw new Error('Build @pokearena/solana-client first (npm run build in packages/solana-client).');
  }
}

function loadKeypair(path) {
  const secret = JSON.parse(readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const {
  initializeConfigIx,
  configPda,
  feeVaultPda,
  treasuryVaultPda,
  operatorVaultPda,
  depositTreasurySolIx,
  sha256Key,
} = loadClient();

const rpc = process.env.POKEARENA_SOLANA_RPC || 'http://127.0.0.1:8899';
const keyDir = process.env.POKEARENA_SOLANA_KEYS || join(root, 'scripts/solana/keys');
const authority = loadKeypair(join(keyDir, 'authority.json'));
const keeper = loadKeypair(join(keyDir, 'keeper.json'));
const programId = new PublicKey(requireEnv('POKEARENA_PROGRAM_ID'));
const pokeMint = new PublicKey(requireEnv('POKEARENA_POKE_MINT'));
const [feeVault] = feeVaultPda(programId);
const [treasuryVault] = treasuryVaultPda(programId);
const [operatorVault] = operatorVaultPda(programId);
const buybackBps = Number(process.env.POKEARENA_BUYBACK_BPS || 2500);
const minBuyback = Number(process.env.POKEARENA_MIN_BUYBACK_LAMPORTS || 50_000_000);

const connection = new Connection(rpc, 'confirmed');
const [configAddress] = configPda(programId);
console.log('fee_vault', feeVault.toBase58());
console.log('treasury_vault', treasuryVault.toBase58());
console.log('operator_vault', operatorVault.toBase58());
const existing = await connection.getAccountInfo(configAddress);
if (existing) {
  console.log('Config already initialized at', configAddress.toBase58());
} else {
  const ix = initializeConfigIx({
    programId,
    authority: authority.publicKey,
    pokeMint,
    quoteAuthority: authority.publicKey,
    keeper: keeper.publicKey,
    buybackBps,
    minBuybackLamports: minBuyback,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: authority.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
  console.log('initialize_config ok', sig);
}

const seedLamports = Number(process.env.POKEARENA_TREASURY_SEED_LAMPORTS || 2_000_000_000);
if (seedLamports > 0) {
  const claimKey = sha256Key(['treasury-seed', String(Date.now())]);
  const ix = depositTreasurySolIx({
    programId,
    authority: authority.publicKey,
    payer: authority.publicKey,
    config: configAddress,
    treasuryVault,
    operatorVault,
    claimKey,
    grossLamports: seedLamports,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: authority.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(ix);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
    console.log('treasury seed deposit ok', sig, 'gross', seedLamports);
  } catch (error) {
    console.warn('treasury seed skipped/failed:', error instanceof Error ? error.message : error);
  }
}
