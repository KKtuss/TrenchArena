import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'packages/solana-client/package.json'));
const { Keypair, PublicKey } = require('@solana/web3.js');

const PRODUCTION_PROGRAM_ID = '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W';
const PRODUCTION_UPGRADE_AUTHORITY = 'GGRAzZM9wnuLNCWQb6JYykRyfp4pXjHvp35JEmaps51Z';
const PRODUCTION_KEEPER = 'AZn8PqCeQLKyKLDUgy67NsvLtTiFzDY9S491fGC15iAL';
const KNOWN_PRODUCTION_AUTHORITY = 'Fmb7DLU6fTrQEGh8g6HSsYz3MviMjjS6nnB9n2TATdzw';
const CLOSED_STAGING_PROGRAM_ID = '54Ji1Z32wH4NfDqpd3WMTbSBeK119ptAMmYcQirCUmmU';
const DEAD_STAGING_PROGRAM_ID = '6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98';
const DEAD_STAGING_DEPLOYER = 'AXHoz3WVjyK1chetSrcWMnDDq8VZjvfoUW5yMyKNRpki';
const DEAD_STAGING_AUTHORITY = 'Bs919SY62WM6J22HZo1GPnSnxpL7B66JFXtjwCDC1fNJ';
const DEAD_STAGING_KEEPER = '8Z1iUEpFmLeTFZquJXF66pEcSWYfRZMaztQHcbYwWgK8';
const KNOWN_LOCAL_KEEPER = '3WphHMahyVLN3rzTE36RUGBKJNNkMK3rQaEEb6JKaP42';
const KNOWN_LOCAL_MINT = 'AuUsb5a2g6pfVMQWwa3F1GysGwRokAuhzRJH6uSJdDXT';
const CANONICAL_CARDS_MINT = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp';
const ZERO_PUBKEY = '11111111111111111111111111111111';

const RETIRED = new Set([
  CLOSED_STAGING_PROGRAM_ID,
  DEAD_STAGING_PROGRAM_ID,
  DEAD_STAGING_DEPLOYER,
  DEAD_STAGING_AUTHORITY,
  DEAD_STAGING_KEEPER,
]);
const PRODUCTION = new Set([
  PRODUCTION_PROGRAM_ID,
  PRODUCTION_UPGRADE_AUTHORITY,
  PRODUCTION_KEEPER,
  KNOWN_PRODUCTION_AUTHORITY,
]);
const LOCAL = new Set([KNOWN_LOCAL_KEEPER, KNOWN_LOCAL_MINT]);

function fail(message) {
  throw new Error(message);
}

export function readEnv(file) {
  const values = {};
  for (const [index, raw] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) fail(`${file}:${index + 1}: expected KEY=VALUE`);
    values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return values;
}

function classifyPubkey(role, pubkey) {
  if (!pubkey) return `${role}: NOT GENERATED`;
  if (RETIRED.has(pubkey)) return `${role} ${pubkey} is a retired staging identity.`;
  if (PRODUCTION.has(pubkey)) return `${role} ${pubkey} is a production identity.`;
  if (LOCAL.has(pubkey)) return `${role} ${pubkey} is a local test identity.`;
  try {
    return new PublicKey(pubkey).toBase58() === pubkey ? null : `${role} is not a Solana public key.`;
  } catch {
    return `${role} is not a Solana public key.`;
  }
}

export function assessDeclaredProgramIds({ anchorId, declaredId, idlAddress, configuredId }) {
  const problems = [];
  const entries = [
    ['Anchor.toml', anchorId],
    ['declare_id', declaredId],
    ['IDL', idlAddress],
    ['POKEARENA_PROGRAM_ID', configuredId],
  ];
  for (const [label, id] of entries) {
    if (!id) problems.push(`${label} program ID is NOT GENERATED.`);
    else if (id === CLOSED_STAGING_PROGRAM_ID || id === DEAD_STAGING_PROGRAM_ID) {
      problems.push(`${label} still declares the retired staging program ${id}.`);
    } else if (id === PRODUCTION_PROGRAM_ID) {
      problems.push(`${label} declares the production program ${PRODUCTION_PROGRAM_ID}.`);
    }
  }
  const present = entries.map(([, id]) => id).filter(Boolean);
  if (new Set(present).size > 1) problems.push('Declared program IDs do not match.');
  return problems;
}

export function assessStagingSigners({ programId, deployer, authority, keeper }) {
  const problems = [];
  const roles = [
    ['program ID', programId],
    ['deployer', deployer],
    ['config authority', authority],
    ['keeper', keeper],
  ];
  for (const [role, pubkey] of roles) {
    const problem = classifyPubkey(role, pubkey);
    if (problem) problems.push(problem);
  }
  if (deployer && programId && deployer === programId) {
    problems.push('Deployer must be distinct from the program ID.');
  }
  if (authority && deployer && authority === deployer) {
    problems.push('Config authority must be distinct from the deployer.');
  }
  if (authority && programId && authority === programId) {
    problems.push('Config authority must be distinct from the program ID.');
  }
  if (keeper && deployer && keeper === deployer) {
    problems.push('Keeper must be distinct from the deployer.');
  }
  if (keeper && authority && keeper === authority) {
    problems.push('Keeper must be distinct from the config authority.');
  }
  if (keeper && programId && keeper === programId) {
    problems.push('Keeper must be distinct from the program ID.');
  }
  return problems;
}

function publicKey(file, name) {
  let secret;
  try {
    secret = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${name} is not readable JSON.`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
  } catch {
    fail(`${name} is not a valid Solana keypair.`);
  }
}

function pubkeyFromPath(env, pathName, role) {
  const raw = env[pathName]?.trim() ?? '';
  if (!raw || !fs.existsSync(raw)) return null;
  return publicKey(path.resolve(raw), role);
}

function main() {
  const envFile = process.argv[2] ?? 'deploy/env/api.staging.mainnet.local.env';
  if (!fs.existsSync(envFile)) fail(`staging environment file does not exist: ${envFile}`);
  const env = readEnv(envFile);
  if (env.POKEARENA_STAGING?.toLowerCase() !== 'true') fail('POKEARENA_STAGING=true is required.');

  const anchor = fs.readFileSync('Anchor.toml', 'utf8');
  const anchorId = anchor.match(/arena_escrow\s*=\s*"([^"]+)"/)?.[1] ?? '';
  const anchorSource = fs.readFileSync('programs/arena-escrow/src/lib.rs', 'utf8');
  const declaredId = anchorSource.match(/declare_id!\("([^"]+)"\)/)?.[1] ?? '';
  const idl = JSON.parse(fs.readFileSync('packages/solana-client/idl/arena_escrow.json', 'utf8'));
  const configuredId = env.POKEARENA_PROGRAM_ID?.trim() ?? '';
  const problems = assessDeclaredProgramIds({
    anchorId,
    declaredId,
    idlAddress: idl.address ?? '',
    configuredId,
  });

  const programFromKey = pubkeyFromPath(env, 'POKEARENA_PROGRAM_KEYPAIR', 'program keypair');
  const deployerFromKey = pubkeyFromPath(env, 'POKEARENA_DEPLOY_KEYPAIR', 'deployer keypair');
  const authorityFromKey = pubkeyFromPath(env, 'POKEARENA_AUTHORITY_KEYPAIR', 'authority keypair');
  const keeperFromKey = pubkeyFromPath(env, 'POKEARENA_KEEPER_KEYPAIR', 'keeper keypair');
  const programId = configuredId || programFromKey;
  const deployer = deployerFromKey || env.POKEARENA_DEPLOYER?.trim() || null;
  const authority = env.POKEARENA_AUTHORITY?.trim() || authorityFromKey;
  const keeper = env.POKEARENA_KEEPER?.trim() || keeperFromKey;
  if (programFromKey && configuredId && programFromKey !== configuredId) {
    problems.push('Program keypair does not match POKEARENA_PROGRAM_ID.');
  }
  if (authorityFromKey && authority && authorityFromKey !== authority) {
    problems.push('Config-authority keypair does not match POKEARENA_AUTHORITY.');
  }
  if (keeperFromKey && keeper && keeperFromKey !== keeper) {
    problems.push('Keeper keypair does not match POKEARENA_KEEPER.');
  }
  problems.push(...assessStagingSigners({ programId, deployer, authority, keeper }));

  const cards = env.POKEARENA_CARDS_MINT?.trim() ?? '';
  if (cards !== CANONICAL_CARDS_MINT) {
    problems.push(`POKEARENA_CARDS_MINT must be the shared prize mint ${CANONICAL_CARDS_MINT}.`);
  }
  const poke = (env.POKEARENA_POKE_MINT ?? '').trim().toLowerCase();
  if (poke && poke !== 'unset' && poke !== ZERO_PUBKEY) problems.push('POKEARENA_POKE_MINT must stay unset.');
  if ((env.POKEARENA_BUYBACK_BPS ?? '').trim() !== '0') problems.push('POKEARENA_BUYBACK_BPS must be 0.');

  const lines = [
    'STAGING RUNTIME VERIFICATION',
    `program ID: ${programId || 'NOT GENERATED'}`,
    `deployer: ${deployer || 'NOT GENERATED'}`,
    `config authority: ${authority || 'NOT GENERATED'}`,
    `keeper: ${keeper || 'NOT GENERATED'}`,
    'Mainnet generation: NOT PERFORMED',
    'Mainnet funding: NOT PERFORMED',
    'privateKeys=not printed',
  ];
  if (problems.length > 0) {
    for (const problem of problems) lines.push(`identity: ${problem}`);
    fail(lines.join('\n'));
  }
  console.log(lines.join('\n'));
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`STAGING RUNTIME VERIFICATION FAILED: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
