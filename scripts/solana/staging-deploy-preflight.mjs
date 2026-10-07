/**
 * Read-only preflight for the staging Pinocchio deploy.
 *
 * This module never sends a transaction, never initializes config, and never
 * closes an account. The shell script may invoke the Solana deploy command
 * only after `planStagingDeploy` returns exit code 0.
 *
 * Same-ID redeploy of a closed program is classified here and then refused.
 * solana-cli 4.2.2 (agave v4.2.2 cli/src/program.rs) returns
 * "Program <id> has been closed, use a new Program Id" before
 * `do_process_program_deploy`, so `check_payer` and `send_deploy_messages`
 * never run.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'packages/solana-client/package.json'));
const { PublicKey } = require('@solana/web3.js');

/** Retired on-chain staging identities. Fresh staging must not reuse them. */
export const CLOSED_STAGING_PROGRAM_ID = '54Ji1Z32wH4NfDqpd3WMTbSBeK119ptAMmYcQirCUmmU';
export const DEAD_STAGING_PROGRAM_ID = '6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98';
export const DEAD_STAGING_DEPLOYER = 'AXHoz3WVjyK1chetSrcWMnDDq8VZjvfoUW5yMyKNRpki';
export const DEAD_STAGING_AUTHORITY = 'Bs919SY62WM6J22HZo1GPnSnxpL7B66JFXtjwCDC1fNJ';
export const DEAD_STAGING_KEEPER = '8Z1iUEpFmLeTFZquJXF66pEcSWYfRZMaztQHcbYwWgK8';

export const PRODUCTION_PROGRAM_ID = '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W';
export const PRODUCTION_UPGRADE_AUTHORITY = 'GGRAzZM9wnuLNCWQb6JYykRyfp4pXjHvp35JEmaps51Z';
export const PRODUCTION_KEEPER = 'AZn8PqCeQLKyKLDUgy67NsvLtTiFzDY9S491fGC15iAL';
export const KNOWN_PRODUCTION_AUTHORITY = 'Fmb7DLU6fTrQEGh8g6HSsYz3MviMjjS6nnB9n2TATdzw';
export const KNOWN_LOCAL_KEEPER = '3WphHMahyVLN3rzTE36RUGBKJNNkMK3rQaEEb6JKaP42';
export const KNOWN_LOCAL_MINT = 'AuUsb5a2g6pfVMQWwa3F1GysGwRokAuhzRJH6uSJdDXT';
/**
 * Shared Pump CARDS prize mint. It is not a staging signer and was not created
 * by the retired staging deployment. Tournament prizes and creator rewards use it.
 */
export const CANONICAL_CARDS_MINT = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp';

export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const UPGRADEABLE_LOADER_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const ZERO_PUBKEY = '11111111111111111111111111111111';
export const CONFIG_DISCRIMINATOR = Buffer.from([
  0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82,
]);

export const PROGRAM_ACCOUNT_DATA_LEN = 36;
export const PROGRAMDATA_METADATA_LEN = 45;
export const BUFFER_METADATA_LEN = 37;
/** Script balance floor. Not a fee measured by the Solana CLI. */
export const SAFETY_FLOOR_LAMPORTS = 50_000_000n;

export const SOLANA_CLI_CLOSED_PROGRAM_ERROR =
  'Program {programId} has been closed, use a new Program Id';

const RETIRED_PUBKEYS = new Set([
  CLOSED_STAGING_PROGRAM_ID,
  DEAD_STAGING_PROGRAM_ID,
  DEAD_STAGING_DEPLOYER,
  DEAD_STAGING_AUTHORITY,
  DEAD_STAGING_KEEPER,
]);
const PRODUCTION_PUBKEYS = new Set([
  PRODUCTION_PROGRAM_ID,
  PRODUCTION_UPGRADE_AUTHORITY,
  PRODUCTION_KEEPER,
  KNOWN_PRODUCTION_AUTHORITY,
]);
const LOCAL_PUBKEYS = new Set([
  KNOWN_LOCAL_KEEPER,
  KNOWN_LOCAL_MINT,
]);

export class StagingDeployError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StagingDeployError';
  }
}

export function sol(lamports) {
  const value = BigInt(lamports);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000_000n;
  const fraction = (absolute % 1_000_000_000n).toString().padStart(9, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function redactRpc(rpc) {
  const url = new URL(rpc);
  for (const name of ['api-key', 'api_key', 'apikey']) {
    if (url.searchParams.has(name)) url.searchParams.set(name, 'REDACTED');
  }
  return url.toString();
}

function requirePubkey(name, raw) {
  const value = raw?.trim() ?? '';
  if (!value) throw new StagingDeployError(`${name} is required.`);
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new StagingDeployError(`${name} is not a Solana public key.`);
  }
}

function rejectForbidden(role, pubkey) {
  if (RETIRED_PUBKEYS.has(pubkey)) {
    throw new StagingDeployError(
      `${role} ${pubkey} is a retired staging identity. Fresh staging must use a new key.`,
    );
  }
  if (PRODUCTION_PUBKEYS.has(pubkey)) {
    throw new StagingDeployError(
      `${role} ${pubkey} is a production program, upgrade authority, or keeper. Staging deploy rejects it.`,
    );
  }
  if (LOCAL_PUBKEYS.has(pubkey)) {
    throw new StagingDeployError(
      `${role} ${pubkey} is a local test identity. Fresh staging must use a new key.`,
    );
  }
}

function optionalPubkey(raw) {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  return requirePubkey('public key', value);
}

function sameKey(left, right) {
  return left !== null && right !== null && left === right;
}

export function readPokeMint(raw) {
  const value = raw?.trim() ?? '';
  if (!value || value.toLowerCase() === 'unset') return ZERO_PUBKEY;
  const mint = requirePubkey('POKEARENA_POKE_MINT', value);
  if (mint !== ZERO_PUBKEY) {
    throw new StagingDeployError(
      'POKEARENA_POKE_MINT must stay unset. Token-2022 POKE is not part of this deploy.',
    );
  }
  return mint;
}

export function readBuybackBps(raw) {
  const value = raw?.trim() ?? '';
  if (value !== '0') {
    throw new StagingDeployError(
      'POKEARENA_BUYBACK_BPS must be 0. This deploy does not change buyback.',
    );
  }
  return 0;
}

function requireStagingFlag(env) {
  if ((env.POKEARENA_STAGING ?? '').trim() !== 'true') {
    throw new StagingDeployError('Set POKEARENA_STAGING=true. This deploy is staging-only.');
  }
}

function readCluster(env) {
  const cluster = (env.POKEARENA_SOLANA_CLUSTER ?? '').trim().toLowerCase();
  if (cluster !== 'mainnet-beta' && cluster !== 'mainnet') {
    throw new StagingDeployError('Set POKEARENA_SOLANA_CLUSTER=mainnet-beta.');
  }
  const rpc = (env.POKEARENA_SOLANA_RPC ?? '').trim();
  if (!/^https:\/\//i.test(rpc)) {
    throw new StagingDeployError('POKEARENA_SOLANA_RPC must be an explicit https URL.');
  }
  const lower = rpc.toLowerCase();
  if (
    lower.includes('devnet')
    || lower.includes('testnet')
    || lower.includes('localnet')
    || lower.includes('localhost')
    || lower.includes('127.0.0.1')
    || lower.includes('0.0.0.0')
  ) {
    throw new StagingDeployError(`Refusing non-mainnet RPC: ${redactRpc(rpc)}`);
  }
  return { cluster, rpc, rpcRedacted: redactRpc(rpc) };
}

function identityLine(label, value) {
  const shown = value ?? 'NOT GENERATED';
  return [
    `  ${label}: ${shown}`,
    '    Mainnet generation: NOT PERFORMED',
    '    Mainnet funding: NOT PERFORMED',
  ];
}

/**
 * Resolve the four fresh staging signers from explicit env and keypair pubkeys.
 * Missing keys stay ungenerated. This function does not create or fund them.
 */
export function evaluateStagingIdentities(env, pubkeys = {}) {
  requireStagingFlag(env);
  const errors = [];
  const programFromEnv = optionalPubkey(env.POKEARENA_PROGRAM_ID);
  const programFromKey = optionalPubkey(pubkeys.programPubkey);
  const deployerFromEnv = optionalPubkey(env.POKEARENA_DEPLOYER);
  const deployerFromKey = optionalPubkey(pubkeys.deployerPubkey);
  const authorityFromEnv = optionalPubkey(env.POKEARENA_AUTHORITY);
  const authorityFromKey = optionalPubkey(pubkeys.authorityPubkey);
  const keeperFromEnv = optionalPubkey(env.POKEARENA_KEEPER);
  const keeperFromKey = optionalPubkey(pubkeys.keeperPubkey);

  let programId = programFromEnv ?? programFromKey;
  let deployer = deployerFromKey ?? deployerFromEnv;
  let authority = authorityFromEnv ?? authorityFromKey;
  let keeper = keeperFromEnv ?? keeperFromKey;

  const provided = [
    ['Program', programFromEnv],
    ['Program keypair', programFromKey],
    ['Deployer', deployerFromEnv],
    ['Deployer keypair', deployerFromKey],
    ['Config authority', authorityFromEnv],
    ['Config-authority keypair', authorityFromKey],
    ['Keeper', keeperFromEnv],
    ['Keeper keypair', keeperFromKey],
  ];
  for (const [role, pubkey] of provided) {
    if (!pubkey) continue;
    try {
      rejectForbidden(role, pubkey);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!programFromEnv || !programFromKey) {
    programId = null;
    errors.push('Program ID and program keypair are NOT GENERATED.');
  } else if (programFromEnv !== programFromKey) {
    errors.push(
      `Program keypair pubkey is ${programFromKey}. POKEARENA_PROGRAM_ID is ${programFromEnv}. They must match.`,
    );
  }
  if (!deployerFromKey) {
    deployer = null;
    errors.push('Deployer keypair is NOT GENERATED.');
  } else if (deployerFromEnv && deployerFromEnv !== deployerFromKey) {
    errors.push(
      `POKEARENA_DEPLOYER is ${deployerFromEnv}. Deployer keypair pubkey is ${deployerFromKey}. They must match.`,
    );
  }
  if (!authorityFromEnv) {
    authority = null;
    errors.push('Config authority is NOT GENERATED.');
  } else if (authorityFromKey && authorityFromKey !== authorityFromEnv) {
    errors.push(
      `Config-authority keypair pubkey is ${authorityFromKey}. POKEARENA_AUTHORITY is ${authorityFromEnv}. They must match.`,
    );
  }
  if (!keeperFromEnv) {
    keeper = null;
    errors.push('Keeper is NOT GENERATED.');
  } else if (keeperFromKey && keeperFromKey !== keeperFromEnv) {
    errors.push(
      `Keeper keypair pubkey is ${keeperFromKey}. POKEARENA_KEEPER is ${keeperFromEnv}. They must match.`,
    );
  }

  if (sameKey(deployer, programId)) errors.push('Deployer must be distinct from the program ID.');
  if (sameKey(authority, deployer)) errors.push('Config authority must be distinct from the deployer.');
  if (sameKey(authority, programId)) errors.push('Config authority must be distinct from the program ID.');
  if (sameKey(keeper, deployer)) errors.push('Keeper must be distinct from the deployer.');
  if (sameKey(keeper, authority)) errors.push('Keeper must be distinct from the config authority.');
  if (sameKey(keeper, programId)) errors.push('Keeper must be distinct from the program ID.');

  let cardsMint = null;
  let pokeMint = null;
  let buybackBps = null;
  try {
    cardsMint = requirePubkey('POKEARENA_CARDS_MINT', env.POKEARENA_CARDS_MINT);
    if (cardsMint !== CANONICAL_CARDS_MINT) {
      errors.push(
        `POKEARENA_CARDS_MINT is ${cardsMint}. Staging prizes use the shared CARDS mint ${CANONICAL_CARDS_MINT}.`,
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    pokeMint = readPokeMint(env.POKEARENA_POKE_MINT);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    buybackBps = readBuybackBps(env.POKEARENA_BUYBACK_BPS);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const lines = [
    'Fresh staging identities',
    ...identityLine('program ID', programId),
    ...identityLine('deployer', deployer),
    ...identityLine('config authority', authority),
    ...identityLine('keeper', keeper),
    '  This tool does not generate or fund Mainnet identities.',
  ];
  for (const error of errors) lines.push(`  identity: ${error}`);
  const ok = errors.length === 0 && programId && deployer && authority && keeper
    && cardsMint === CANONICAL_CARDS_MINT && pokeMint === ZERO_PUBKEY && buybackBps === 0;
  return {
    ok,
    errors,
    report: `${lines.join('\n')}\n`,
    identity: ok
      ? { programId, deployer, authority, keeper, cardsMint, pokeMint, buybackBps }
      : null,
  };
}

export function assertStagingDeployIdentity(env, pubkeys) {
  requireStagingFlag(env);
  const endpoint = readCluster(env);
  const evaluated = evaluateStagingIdentities(env, pubkeys);
  if (!evaluated.ok || !evaluated.identity) {
    throw new StagingDeployError(evaluated.errors[0] ?? 'Staging identities are incomplete.');
  }
  return { ...endpoint, ...evaluated.identity };
}

export function configPda(programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    new PublicKey(programId),
  )[0].toBase58();
}

function readPubkeyAt(data, offset) {
  return new PublicKey(Buffer.from(data.subarray(offset, offset + 32))).toBase58();
}

export function decodeStagingConfig(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < 305) {
    throw new StagingDeployError(`Config account is ${bytes.length} bytes; expected 305.`);
  }
  if (!bytes.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) {
    throw new StagingDeployError('Config discriminator does not match the staging Pinocchio program.');
  }
  return {
    authority: readPubkeyAt(bytes, 8),
    pokeMint: readPubkeyAt(bytes, 136),
    keeper: readPubkeyAt(bytes, 200),
    buybackBps: bytes.readBigUInt64LE(256),
    cardsMint: readPubkeyAt(bytes, 273),
  };
}

export function assessStagingConfig(account, expected) {
  if (!account) {
    return {
      exists: false,
      matches: false,
      problems: ['Config account is NOT FOUND. This deploy will not initialize one.'],
    };
  }
  if (account.owner !== expected.programId) {
    return {
      exists: true,
      matches: false,
      problems: [`Config account is owned by ${account.owner}, not ${expected.programId}.`],
    };
  }
  try {
    const decoded = decodeStagingConfig(account.data);
    const problems = [];
    if (decoded.authority !== expected.authority) {
      problems.push(`Config authority is ${decoded.authority}; expected ${expected.authority}.`);
    }
    if (decoded.keeper !== expected.keeper) {
      problems.push(`Config keeper is ${decoded.keeper}; expected ${expected.keeper}.`);
    }
    if (decoded.cardsMint !== expected.cardsMint) {
      problems.push(`Config CARDS mint is ${decoded.cardsMint}; expected ${expected.cardsMint}.`);
    }
    if (decoded.pokeMint !== ZERO_PUBKEY) {
      problems.push(`Config POKE mint is ${decoded.pokeMint}. It must remain unset.`);
    }
    if (decoded.buybackBps !== 0n) {
      problems.push(`Config buyback bps is ${decoded.buybackBps}. It must remain 0.`);
    }
    return { exists: true, matches: problems.length === 0, decoded, problems };
  } catch (error) {
    return {
      exists: true,
      matches: false,
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function classifyUpgradeableProgram(programAccount, programDataAccount) {
  if (!programAccount) {
    return { state: 'absent', programDataAddress: null, authority: null };
  }
  if (programAccount.owner !== UPGRADEABLE_LOADER_ID) {
    return {
      state: 'foreign-owner',
      programDataAddress: null,
      authority: null,
      owner: programAccount.owner,
    };
  }
  const data = Buffer.from(programAccount.data);
  if (data.length < PROGRAM_ACCOUNT_DATA_LEN) {
    return { state: 'unrecognized', programDataAddress: null, authority: null };
  }
  const tag = data.readUInt32LE(0);
  if (!programAccount.executable) {
    return {
      state: 'non-executable',
      programDataAddress: tag === 2 ? readPubkeyAt(data, 4) : null,
      authority: null,
    };
  }
  if (tag !== 2) {
    return { state: 'unrecognized', programDataAddress: null, authority: null };
  }
  const programDataAddress = readPubkeyAt(data, 4);
  if (!programDataAccount) {
    return { state: 'closed-programdata', programDataAddress, authority: null };
  }
  const programData = Buffer.from(programDataAccount.data);
  if (programData.length < 45 || programData.readUInt32LE(0) !== 3) {
    return { state: 'closed-programdata', programDataAddress, authority: null };
  }
  if (programData[12] !== 1) {
    return { state: 'immutable', programDataAddress, authority: null };
  }
  return {
    state: 'deployed',
    programDataAddress,
    authority: readPubkeyAt(programData, 13),
  };
}

function shortfall(balance, required) {
  return balance >= required ? 0n : required - balance;
}

export function planStagingDeploy(input) {
  const identity = input.identity;
  const program = classifyUpgradeableProgram(input.programAccount, input.programDataAccount);
  const config = assessStagingConfig(input.configAccount, input.identity);
  const programDataRent = BigInt(input.programDataRentLamports);
  const programAccountRent = BigInt(input.programAccountRentLamports);
  const bufferRent = BigInt(input.bufferRentLamports);
  const balance = BigInt(input.payerBalanceLamports);
  const held = BigInt(input.programAccount?.lamports ?? 0);
  const gate = programDataRent + SAFETY_FLOOR_LAMPORTS;
  const initializeConfig = false;
  const closeAccounts = false;
  let wouldSendTransaction = false;
  let exitCode = 2;
  let mode = program.state;
  let blocker = null;

  if (config.exists && !config.matches) {
    mode = 'config-mismatch';
    exitCode = 1;
    blocker = 'Existing staging config does not match the required identity. No initialize_config and no deploy will be sent.';
  } else if (program.state === 'absent') {
    mode = 'initial';
    if (!input.confirm) {
      exitCode = 2;
    } else if (balance < gate) {
      exitCode = 1;
      blocker = 'Payer balance is below ProgramData rent plus the script safety floor. No transaction was sent.';
    } else {
      exitCode = 0;
      wouldSendTransaction = true;
    }
  } else if (program.state === 'deployed') {
    mode = 'upgrade';
    if (program.authority !== identity.deployer) {
      exitCode = 1;
      blocker = `On-chain upgrade authority is ${program.authority}; staging deployer is ${identity.deployer}.`;
    } else if (!input.confirm) {
      exitCode = 2;
    } else if (balance < gate) {
      exitCode = 1;
      blocker = 'Payer balance is below ProgramData rent plus the script safety floor. No transaction was sent.';
    } else {
      exitCode = 0;
      wouldSendTransaction = true;
    }
  } else if (program.state === 'closed-programdata') {
    mode = 'closed-programdata';
    exitCode = 3;
    blocker = `solana-cli 4.2.2 rejects same-ID redeploy before sending: ${SOLANA_CLI_CLOSED_PROGRAM_ERROR.replace('{programId}', identity.programId)}`;
  } else {
    mode = program.state;
    exitCode = 1;
    blocker = `Program account state ${program.state} is not a deployable staging state. No transaction was sent.`;
  }

  if (!input.confirm) wouldSendTransaction = false;
  if (wouldSendTransaction && exitCode !== 0) wouldSendTransaction = false;

  const additionalForThisInvocation = wouldSendTransaction ? shortfall(balance, gate) : 0n;
  const lines = [
    'Pinocchio STAGING deployment preflight',
    ...identityLine('program ID', identity.programId),
    ...identityLine('deployer', identity.deployer),
    ...identityLine('config authority', identity.authority),
    ...identityLine('keeper', identity.keeper),
    '  This tool does not generate or fund Mainnet identities.',
    `  RPC/cluster: ${identity.cluster} ${identity.rpcRedacted}`,
    `  RPC genesis: ${identity.genesis ?? 'not checked by this planner'}`,
    `  artifact path: ${input.artifact.path}`,
    `  artifact byte size: ${input.artifact.bytes}`,
    `  artifact SHA-256: ${input.artifact.sha256}`,
    `  current program account state: ${program.state}`,
    `  ProgramData address: ${program.programDataAddress ?? 'none'}`,
    `  ProgramData state: ${input.programDataAccount ? 'present' : 'NOT FOUND'}`,
    `  exact ProgramData rent required: ${programDataRent} lamports (${sol(programDataRent)} SOL)`,
    `  existing program-account rent: ${programAccountRent} lamports (${sol(programAccountRent)} SOL)`,
    `  program-account lamports already held: ${held}`,
    `  buffer rent exemption (size_of_buffer, not added into the CLI balance check): ${bufferRent} lamports (${sol(bufferRent)} SOL)`,
    `  CLI check_payer balance_needed when deploy proceeds: ${programDataRent} lamports (ProgramData rent transferred into the buffer)`,
    `  transaction fees: NOT MEASURED`,
    '  transaction fee source: solana-cli 4.2.2 getFeeForMessage inside check_payer, immediately before send_deploy_messages',
    '  priority fee: not set (deploy command does not pass --with-compute-unit-price)',
    `  script safety floor: ${SAFETY_FLOOR_LAMPORTS} lamports (${sol(SAFETY_FLOOR_LAMPORTS)} SOL)`,
    '  script safety floor is not a measured transaction fee',
    `  payer balance: ${balance} lamports (${sol(balance)} SOL)`,
    `  exact additional balance required: ${additionalForThisInvocation} lamports (${sol(additionalForThisInvocation)} SOL)`,
    `  config already exists: ${config.exists ? 'yes' : 'no'}`,
    `  config matches staging identity: ${config.exists ? (config.matches ? 'yes' : 'no') : 'not applicable'}`,
    `  initialize_config: ${initializeConfig ? 'yes' : 'no'}`,
    `  account closure: ${closeAccounts ? 'yes' : 'no'}`,
    `  this invocation would send a transaction: ${wouldSendTransaction ? 'yes' : 'no'}`,
    '  preflight transactions sent: 0',
  ];
  if (config.problems.length > 0) {
    for (const problem of config.problems) lines.push(`  config: ${problem}`);
  }
  if (mode === 'closed-programdata') {
    lines.push('  same-ID redeploy: blocked by solana-cli 4.2.2 before any transaction');
    lines.push(`  ProgramData rent remains unfunded because this invocation will not create it: ${programDataRent} lamports`);
  }
  if (blocker) lines.push(`  blocker: ${blocker}`);
  lines.push('');

  return {
    mode,
    exitCode,
    wouldSendTransaction,
    initializeConfig,
    closeAccounts,
    transactionsSent: 0,
    program,
    config,
    programDataRentLamports: programDataRent,
    programAccountRentLamports: programAccountRent,
    bufferRentLamports: bufferRent,
    safetyFloorLamports: SAFETY_FLOOR_LAMPORTS,
    transactionFeesLamports: null,
    additionalBalanceLamports: additionalForThisInvocation,
    blocker,
    report: lines.join('\n'),
  };
}

function accountFromRpc(value) {
  if (!value) return null;
  const [encoded] = value.data;
  return {
    owner: value.owner,
    executable: value.executable,
    lamports: value.lamports,
    data: Buffer.from(encoded, 'base64'),
  };
}

async function rpc(url, method, params) {
  let payload;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StagingDeployError(`RPC ${method} failed: ${message.replace(/api-key=[^&\s]+/gi, 'api-key=REDACTED')}`);
  }
  if (payload.error) {
    throw new StagingDeployError(`RPC ${method} failed: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

export function readArtifact(path) {
  const bytes = readFileSync(path);
  return {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function runStagingDeployPreflight(env, pubkeys, options) {
  const identity = assertStagingDeployIdentity(env, pubkeys);
  const artifactPath = options.artifactPath
    ?? env.POKEARENA_ARTIFACT
    ?? join(root, 'target/deploy/arena_escrow_pinocchio.so');
  const artifact = readArtifact(artifactPath);
  if (artifact.bytes < 1) throw new StagingDeployError(`Artifact is empty: ${artifactPath}`);

  const genesis = await rpc(identity.rpc, 'getGenesisHash', []);
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new StagingDeployError(
      `RPC genesis is ${genesis}, not mainnet-beta (${MAINNET_GENESIS_HASH}).`,
    );
  }
  const programDataLen = artifact.bytes + PROGRAMDATA_METADATA_LEN;
  const bufferLen = artifact.bytes + BUFFER_METADATA_LEN;
  const configAddress = configPda(identity.programId);
  const [programValue, configValue, balanceValue, programAccountRent, programDataRent, bufferRent] = await Promise.all([
    rpc(identity.rpc, 'getAccountInfo', [identity.programId, { encoding: 'base64' }]),
    rpc(identity.rpc, 'getAccountInfo', [configAddress, { encoding: 'base64' }]),
    rpc(identity.rpc, 'getBalance', [identity.deployer]),
    rpc(identity.rpc, 'getMinimumBalanceForRentExemption', [PROGRAM_ACCOUNT_DATA_LEN]),
    rpc(identity.rpc, 'getMinimumBalanceForRentExemption', [programDataLen]),
    rpc(identity.rpc, 'getMinimumBalanceForRentExemption', [bufferLen]),
  ]);
  const programAccount = accountFromRpc(programValue.value);
  let programDataAccount = null;
  if (programAccount) {
    const classified = classifyUpgradeableProgram(programAccount, null);
    if (classified.programDataAddress) {
      const programDataValue = await rpc(identity.rpc, 'getAccountInfo', [
        classified.programDataAddress,
        { encoding: 'base64' },
      ]);
      programDataAccount = accountFromRpc(programDataValue.value);
    }
  }
  const plan = planStagingDeploy({
    confirm: options.confirm === true,
    identity: { ...identity, genesis },
    artifact,
    payerBalanceLamports: BigInt(balanceValue.value),
    programAccount,
    programDataAccount,
    configAccount: accountFromRpc(configValue.value),
    programAccountRentLamports: BigInt(programAccountRent),
    programDataRentLamports: BigInt(programDataRent),
    bufferRentLamports: BigInt(bufferRent),
  });
  return plan;
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--confirm-mainnet', '--dry-run']);
  const unknown = args.find(arg => !allowed.has(arg));
  if (unknown) throw new StagingDeployError(`unknown argument: ${unknown}`);
  const confirm = args.includes('--confirm-mainnet');
  if (confirm && args.includes('--dry-run')) {
    throw new StagingDeployError('--dry-run cannot be combined with --confirm-mainnet.');
  }
  const pubkeys = {
    deployerPubkey: process.env.POKEARENA_DEPLOYER_PUBKEY,
    programPubkey: process.env.POKEARENA_PROGRAM_KEYPAIR_PUBKEY,
    authorityPubkey: process.env.POKEARENA_AUTHORITY_KEYPAIR_PUBKEY,
    keeperPubkey: process.env.POKEARENA_KEEPER_KEYPAIR_PUBKEY,
  };
  const evaluated = evaluateStagingIdentities(process.env, pubkeys);
  if (!evaluated.ok) {
    process.stdout.write(evaluated.report);
    process.stdout.write('  this invocation would send a transaction: no\n');
    process.stdout.write('  preflight transactions sent: 0\n');
    process.exitCode = 1;
    return;
  }
  const plan = await runStagingDeployPreflight(process.env, pubkeys, {
    confirm,
    artifactPath: process.env.POKEARENA_ARTIFACT,
  });
  process.stdout.write(plan.report);
  process.exitCode = plan.exitCode;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
