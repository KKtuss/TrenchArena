#!/usr/bin/env node
/**
 * Initialize the deployed Pinocchio arena program on mainnet.
 *
 * This is not deployment. It sends one initialize_config transaction, which
 * creates the config, fee vault, treasury vault, and operator vault. It does
 * not deploy a program, create a mint, create a keeper, or deposit treasury SOL.
 *
 * The plan is printed and no transaction is sent unless --confirm-mainnet is
 * present. A second run that finds the same config exits without sending.
 */
import { existsSync, readFileSync } from 'node:fs';
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

function die(message, exitCode = 1) {
  console.error(`error: ${message}`);
  process.exit(exitCode);
}

function sol(lamports) {
  return `${(Number(lamports) / 1_000_000_000).toFixed(9)} SOL`;
}

function loadKeypair(path) {
  const secret = JSON.parse(readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function localTestPubkeys() {
  const keysDir = join(root, 'scripts', 'solana', 'keys');
  const pubs = [];
  for (const name of ['authority.json', 'keeper.json', 'player1.json', 'player2.json']) {
    const file = join(keysDir, name);
    if (!existsSync(file)) continue;
    try {
      pubs.push(loadKeypair(file).publicKey.toBase58());
    } catch {
      // An unreadable local file cannot be compared. The path check still applies.
    }
  }
  return pubs;
}

const confirm = process.argv.slice(2);
if (confirm.some(arg => arg !== '--confirm-mainnet')) {
  die(`unknown argument: ${confirm.find(arg => arg !== '--confirm-mainnet')}`);
}

const client = loadClient();
const {
  INIT_FEE_RESERVE_LAMPORTS,
  UPGRADEABLE_LOADER_ID,
  MainnetInitError,
  readMainnetInitRequest,
  assertMainnetGenesis,
  assertProductionKeypairPath,
  assertNotLocalTestPubkey,
  assertPokeMintAccount,
  deriveInitAccounts,
  assessInitialization,
  initializationRentLamports,
  keeperSettlementCost,
  minimumTreasuryGrossLamports,
  initDecision,
  initializeConfigIx,
} = client;

let request;
try {
  request = readMainnetInitRequest(process.env);
  assertProductionKeypairPath(request.authorityKeypairPath, root);
} catch (error) {
  die(error instanceof MainnetInitError || error instanceof Error ? error.message : String(error));
}

if (!existsSync(request.authorityKeypairPath)) {
  die(`authority keypair not found: ${request.authorityKeypairPath}`);
}
const authority = loadKeypair(request.authorityKeypairPath);
const localPubkeys = localTestPubkeys();
try {
  assertNotLocalTestPubkey('Authority', authority.publicKey.toBase58(), localPubkeys);
  assertNotLocalTestPubkey('Keeper', request.keeper, localPubkeys);
  assertNotLocalTestPubkey('Quote authority', request.quoteAuthority, localPubkeys);
  assertNotLocalTestPubkey('POKE mint', request.pokeMint, localPubkeys);
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}

const programId = new PublicKey(request.programId);
const connection = new Connection(request.rpc, 'confirmed');
const genesis = await connection.getGenesisHash();
try {
  assertMainnetGenesis(genesis);
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}

const program = await connection.getAccountInfo(programId);
if (!program) {
  die('Program account is not on this cluster. Deploy with scripts/solana/deploy-pinocchio-mainnet.sh before initialization. This script does not deploy.');
}
if (!program.executable || program.owner.toBase58() !== UPGRADEABLE_LOADER_ID) {
  die('Program account is not an upgradeable BPF program. Refusing to initialize.');
}

const mintUnset = request.pokeMint === PublicKey.default.toBase58();
const mintKey = mintUnset ? PublicKey.default : new PublicKey(request.pokeMint);
if (!mintUnset) {
  const mint = await connection.getAccountInfo(mintKey);
  if (!mint) die('POKE mint account was not found on mainnet.');
  try {
    assertPokeMintAccount(mint.owner, mint.data);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

const accounts = deriveInitAccounts(programId);
const [configInfo, feeInfo, treasuryInfo, operatorInfo] = await connection.getMultipleAccountsInfo([
  new PublicKey(accounts.config),
  new PublicKey(accounts.feeVault),
  new PublicKey(accounts.treasuryVault),
  new PublicKey(accounts.operatorVault),
]);
const presence = info => (info ? { owner: info.owner.toBase58(), data: info.data } : null);
const assessment = assessInitialization({
  programId: request.programId,
  authority: authority.publicKey.toBase58(),
  pokeMint: request.pokeMint,
  quoteAuthority: request.quoteAuthority,
  keeper: request.keeper,
  buybackBps: request.buybackBps,
  minBuybackLamports: request.minBuybackLamports,
  accounts,
  config: presence(configInfo),
  feeVault: presence(feeInfo),
  treasuryVault: presence(treasuryInfo),
  operatorVault: presence(operatorInfo),
});

const configRent = await connection.getMinimumBalanceForRentExemption(273);
const vaultRent = await connection.getMinimumBalanceForRentExemption(8);
const initRent = initializationRentLamports(space => (space === 273 ? configRent : vaultRent));
const payerReserve = await connection.getMinimumBalanceForRentExemption(0);
const required = BigInt(initRent + INIT_FEE_RESERVE_LAMPORTS + payerReserve);
const balance = BigInt(await connection.getBalance(authority.publicKey));
const replayRent = await connection.getMinimumBalanceForRentExemption(42);
const reserveRent = await connection.getMinimumBalanceForRentExemption(67);
const emptyRent = payerReserve;
const liveKeeper = keeperSettlementCost(space => {
  if (space === 42) return replayRent;
  if (space === 67) return reserveRent;
  if (space === 0) return emptyRent;
  throw new Error(`Unexpected rent space ${space}.`);
});
const defaultPrize = 100_000_000n;
const treasuryGross = minimumTreasuryGrossLamports(defaultPrize);

console.log('');
console.log('Pinocchio mainnet initialization plan');
console.log('  This is initialization, not deployment. No program bytes are uploaded.');
console.log('  No treasury SOL is deposited and no keeper wallet is created.');
console.log(`  Program ID:         ${request.programId}`);
console.log(`  RPC genesis:        ${genesis}`);
console.log(`  Config authority:   ${authority.publicKey.toBase58()}`);
console.log(`  Authority keypair:  ${request.authorityKeypairPath}`);
console.log(`  Keeper:             ${request.keeper}`);
console.log('  Keeper signs later settlements. It does not sign initialize_config.');
console.log(`  Quote authority:    ${request.quoteAuthority}`);
console.log(`  POKE mint:          ${mintUnset ? 'unset (System Program sentinel, stored as the zero pubkey)' : request.pokeMint}`);
console.log(`  POKE decimals:      ${mintUnset ? 'not configured' : '6'}`);
console.log(`  Buyback bps:        ${request.buybackBps}`);
console.log(`  Min buyback:        ${request.minBuybackLamports} lamports`);
console.log('  Fee bps:            200 (fixed by the program)');
console.log('  Treasury bps:       9000 (fixed by the program)');
console.log('  Operator bps:       1000 (fixed by the program)');
console.log(`  Config PDA:         ${accounts.config}`);
console.log(`  Fee vault PDA:      ${accounts.feeVault}`);
console.log(`  Treasury vault PDA: ${accounts.treasuryVault}`);
console.log(`  Operator vault PDA: ${accounts.operatorVault}`);
console.log(`  Init rent:          ${sol(initRent)}`);
console.log(`  Fee reserve:        ${sol(INIT_FEE_RESERVE_LAMPORTS)}`);
console.log(`  Payer rent reserve: ${sol(payerReserve)}`);
console.log(`  Required balance:   ${sol(required)}`);
console.log(`  Authority balance:  ${sol(balance)}`);
console.log(`  State:              ${assessment.status}`);
if (assessment.reasons) {
  for (const reason of assessment.reasons) console.log(`  - ${reason}`);
}
console.log(`  Keeper cost per completed 32-player tournament: ${sol(liveKeeper.perTournamentLamports)} (${liveKeeper.tournamentTransactions} transactions)`);
console.log(`  Keeper cost per settled casual match: ${sol(liveKeeper.perCasualMatchLamports)}`);
console.log('  Prize SOL is paid from the treasury vault, not from the keeper.');
console.log(`  A later explicit treasury deposit of at least ${sol(treasuryGross)} gives the treasury its 90% share of one ${sol(defaultPrize)} prize.`);
console.log('  That deposit is not part of this command.');
console.log('');

const decision = initDecision({
  assessment: assessment.status,
  confirm: confirm.includes('--confirm-mainnet'),
  balanceLamports: balance,
  requiredLamports: required,
});
if (decision.action !== 'send') {
  console.error(decision.message);
  process.exit(decision.exitCode);
}

const ix = initializeConfigIx({
  programId,
  authority: authority.publicKey,
  pokeMint: mintKey,
  quoteAuthority: new PublicKey(request.quoteAuthority),
  keeper: new PublicKey(request.keeper),
  buybackBps: request.buybackBps,
  minBuybackLamports: request.minBuybackLamports,
});
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
const tx = new Transaction({
  feePayer: authority.publicKey,
  blockhash,
  lastValidBlockHeight,
}).add(ix);
console.log(`==> Sending initialize_config. Config authority remains ${authority.publicKey.toBase58()}.`);
const signature = await sendAndConfirmTransaction(connection, tx, [authority]);
console.log(`initialize_config confirmed ${signature}`);
