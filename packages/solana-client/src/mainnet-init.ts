import { resolve, relative, isAbsolute, sep } from 'node:path';

import { PublicKey } from '@solana/web3.js';

import { CASUAL_FEE_BPS, OPERATOR_BPS, TREASURY_BPS } from './constants';
import { configPda, feeVaultPda, operatorVaultPda, treasuryVaultPda } from './pdas';
import { POKE_MINT_DECIMALS, TOURNAMENT_FIELD_SIZE } from './poke-units';
import { TOKEN_PROGRAM_ID } from './token';

/** Production Pinocchio program. Deployment and initialization both use this ID. */
export const MAINNET_PROGRAM_ID = '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W';
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const UPGRADEABLE_LOADER_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** Config::pack layout in programs/arena-escrow-pinocchio/src/state.rs. */
export const CONFIG_DISCRIMINATOR = Buffer.from([
  0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82,
]);
export const CONFIG_ACCOUNT_SPACE = 273;
export const VAULT_ACCOUNT_SPACE = 8;
export const REPLAY_ACCOUNT_SPACE = 42;
export const PRIZE_RESERVE_ACCOUNT_SPACE = 67;
export const PRIZE_VAULT_ACCOUNT_SPACE = 0;

/** One base-fee signature. A tournament pay transaction includes set-winner and pay. */
export const SIGNATURE_FEE_LAMPORTS = 5_000;
export const TOURNAMENT_KEEPER_TRANSACTIONS = 1 + TOURNAMENT_FIELD_SIZE + 1;
export const CASUAL_KEEPER_TRANSACTIONS = 2;
/** Headroom for the single initialize_config signature. Rent is separate. */
export const INIT_FEE_RESERVE_LAMPORTS = 10_000_000;

export class MainnetInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MainnetInitError';
  }
}

export interface MainnetInitRequest {
  cluster: string;
  rpc: string;
  programId: string;
  pokeMint: string;
  keeper: string;
  quoteAuthority: string;
  authorityKeypairPath: string;
  buybackBps: number;
  minBuybackLamports: number;
}

export interface InitAccounts {
  config: string;
  configBump: number;
  feeVault: string;
  treasuryVault: string;
  operatorVault: string;
}

export interface DecodedConfig {
  authority: string;
  feeVault: string;
  treasuryVault: string;
  operatorVault: string;
  pokeMint: string;
  quoteAuthority: string;
  keeper: string;
  feeBps: bigint;
  treasuryBps: bigint;
  operatorBps: bigint;
  buybackBps: bigint;
  minBuybackLamports: bigint;
  bump: number;
}

export interface AccountPresence {
  owner: string;
  data: Uint8Array;
}

export type InitAssessment =
  | { status: 'absent' }
  | { status: 'initialized' }
  | { status: 'mismatch'; reasons: string[] }
  | { status: 'partial'; reasons: string[] };

export function assertMainnetEndpoint(cluster: string | undefined, rpc: string | undefined): void {
  const normalized = (cluster ?? '').trim().toLowerCase();
  if (normalized !== 'mainnet-beta' && normalized !== 'mainnet') {
    throw new MainnetInitError(
      'Set POKEARENA_SOLANA_CLUSTER=mainnet-beta. This initialization refuses devnet, testnet, and localnet.',
    );
  }
  const url = (rpc ?? '').trim();
  if (!url) {
    throw new MainnetInitError('Set POKEARENA_SOLANA_RPC to an explicit mainnet HTTPS URL.');
  }
  if (!/^https:\/\//i.test(url)) {
    throw new MainnetInitError(
      'POKEARENA_SOLANA_RPC must be an explicit https URL, not a cluster nickname or local endpoint.',
    );
  }
  const lower = url.toLowerCase();
  if (
    lower.includes('devnet')
    || lower.includes('testnet')
    || lower.includes('localnet')
    || lower.includes('localhost')
    || lower.includes('127.0.0.1')
    || lower.includes('0.0.0.0')
    || lower.includes('[::1]')
  ) {
    throw new MainnetInitError(`Refusing non-mainnet RPC: ${url}`);
  }
}

export function assertMainnetGenesis(genesis: string): void {
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new MainnetInitError(
      `RPC genesis is ${genesis}, not mainnet-beta (${MAINNET_GENESIS_HASH}). Refusing to initialize.`,
    );
  }
}

function requirePubkey(name: string, raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value) throw new MainnetInitError(`${name} is required. This initialization has no default address.`);
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new MainnetInitError(`${name} is not a valid Solana public key.`);
  }
}

/** Empty or `unset` stores the zero pubkey. A real mint must be a public key. */
function readOptionalPokeMint(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value || value.toLowerCase() === 'unset') return PublicKey.default.toBase58();
  return requirePubkey('POKEARENA_POKE_MINT', value);
}

function requireExplicitInt(name: string, raw: string | undefined, max: number): number {
  const value = raw?.trim() ?? '';
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new MainnetInitError(
      `${name} must be set explicitly to an integer. This initialization does not apply a development default.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new MainnetInitError(`${name} must be an integer in [0, ${max}].`);
  }
  return parsed;
}

/**
 * Read the operator-supplied initialization values.
 * Buyback, mint, keeper, quote authority, and the authority keypair are required.
 * A treasury-seed variable is rejected so the local 2 SOL deposit cannot run here.
 */
export function readMainnetInitRequest(env: NodeJS.ProcessEnv): MainnetInitRequest {
  if (env.POKEARENA_TREASURY_SEED_LAMPORTS?.trim()) {
    throw new MainnetInitError(
      'POKEARENA_TREASURY_SEED_LAMPORTS is set. This initialization does not deposit treasury SOL. Unset it and fund the treasury later with an explicit amount.',
    );
  }
  if (env.POKEARENA_SOLANA_KEYS?.trim()) {
    throw new MainnetInitError(
      'POKEARENA_SOLANA_KEYS is set. Mainnet initialization does not read scripts/solana/keys.',
    );
  }
  assertMainnetEndpoint(env.POKEARENA_SOLANA_CLUSTER, env.POKEARENA_SOLANA_RPC);
  const programId = requirePubkey('POKEARENA_PROGRAM_ID', env.POKEARENA_PROGRAM_ID);
  if (programId !== MAINNET_PROGRAM_ID) {
    throw new MainnetInitError(
      `POKEARENA_PROGRAM_ID is ${programId}. Mainnet initialization only accepts ${MAINNET_PROGRAM_ID}.`,
    );
  }
  const authorityKeypairPath = env.POKEARENA_AUTHORITY_KEYPAIR?.trim() ?? '';
  if (!authorityKeypairPath) {
    throw new MainnetInitError(
      'Set POKEARENA_AUTHORITY_KEYPAIR to the production config-authority keypair. This initialization does not choose or create one.',
    );
  }
  return {
    cluster: (env.POKEARENA_SOLANA_CLUSTER ?? '').trim().toLowerCase(),
    rpc: env.POKEARENA_SOLANA_RPC!.trim(),
    programId,
    pokeMint: readOptionalPokeMint(env.POKEARENA_POKE_MINT),
    keeper: requirePubkey('POKEARENA_KEEPER', env.POKEARENA_KEEPER),
    quoteAuthority: requirePubkey('POKEARENA_QUOTE_AUTHORITY', env.POKEARENA_QUOTE_AUTHORITY),
    authorityKeypairPath,
    buybackBps: requireExplicitInt('POKEARENA_BUYBACK_BPS', env.POKEARENA_BUYBACK_BPS, 10_000),
    minBuybackLamports: requireExplicitInt(
      'POKEARENA_MIN_BUYBACK_LAMPORTS',
      env.POKEARENA_MIN_BUYBACK_LAMPORTS,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function assertProductionKeypairPath(keypairPath: string, repoRoot: string): void {
  const resolved = resolve(keypairPath);
  const keysDir = resolve(repoRoot, 'scripts', 'solana', 'keys');
  const fromKeys = relative(keysDir, resolved);
  const outsideKeys = fromKeys === '..'
    || fromKeys.startsWith(`..${sep}`)
    || fromKeys.startsWith('../')
    || fromKeys.startsWith('..\\')
    || isAbsolute(fromKeys);
  if (!outsideKeys) {
    throw new MainnetInitError(
      `Refusing local test keypair ${resolved}. Mainnet initialization does not use scripts/solana/keys.`,
    );
  }
}

export function assertNotLocalTestPubkey(
  role: string,
  pubkey: string,
  localPubkeys: readonly string[],
): void {
  if (localPubkeys.includes(pubkey)) {
    throw new MainnetInitError(
      `${role} ${pubkey} matches a local test key. Use a production key.`,
    );
  }
  if (pubkey === MAINNET_PROGRAM_ID) {
    throw new MainnetInitError(`${role} must not be the program ID.`);
  }
}

export function deriveInitAccounts(programId: PublicKey): InitAccounts {
  const [config, configBump] = configPda(programId);
  const [feeVault] = feeVaultPda(programId);
  const [treasuryVault] = treasuryVaultPda(programId);
  const [operatorVault] = operatorVaultPda(programId);
  return {
    config: config.toBase58(),
    configBump,
    feeVault: feeVault.toBase58(),
    treasuryVault: treasuryVault.toBase58(),
    operatorVault: operatorVault.toBase58(),
  };
}

export function assertPokeMintAccount(owner: PublicKey, data: Uint8Array): void {
  if (!owner.equals(TOKEN_PROGRAM_ID)) {
    throw new MainnetInitError(
      'POKEARENA_POKE_MINT is not a classic SPL token mint. The program accepts Tokenkeg mint accounts.',
    );
  }
  if (data.length < 82) {
    throw new MainnetInitError('POKEARENA_POKE_MINT account is too small to be a token mint.');
  }
  const decimals = data[44];
  if (decimals !== POKE_MINT_DECIMALS) {
    throw new MainnetInitError(
      `POKE mint decimals are ${decimals}. Production initialization requires ${POKE_MINT_DECIMALS} decimals.`,
    );
  }
}

function readPubkey(data: Uint8Array, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readU64(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(offset);
}

export function decodeConfigAccount(data: Uint8Array): DecodedConfig {
  if (data.length < CONFIG_ACCOUNT_SPACE) {
    throw new MainnetInitError(`Config account is ${data.length} bytes; expected at least ${CONFIG_ACCOUNT_SPACE}.`);
  }
  const discriminator = Buffer.from(data.subarray(0, 8));
  if (!discriminator.equals(CONFIG_DISCRIMINATOR)) {
    throw new MainnetInitError('Config account discriminator does not match the Pinocchio program.');
  }
  return {
    authority: readPubkey(data, 8),
    feeVault: readPubkey(data, 40),
    treasuryVault: readPubkey(data, 72),
    operatorVault: readPubkey(data, 104),
    pokeMint: readPubkey(data, 136),
    quoteAuthority: readPubkey(data, 168),
    keeper: readPubkey(data, 200),
    feeBps: readU64(data, 232),
    treasuryBps: readU64(data, 240),
    operatorBps: readU64(data, 248),
    buybackBps: readU64(data, 256),
    minBuybackLamports: readU64(data, 264),
    bump: data[272] ?? 0,
  };
}

export function packConfigAccount(config: DecodedConfig): Buffer {
  const data = Buffer.alloc(CONFIG_ACCOUNT_SPACE);
  CONFIG_DISCRIMINATOR.copy(data, 0);
  new PublicKey(config.authority).toBuffer().copy(data, 8);
  new PublicKey(config.feeVault).toBuffer().copy(data, 40);
  new PublicKey(config.treasuryVault).toBuffer().copy(data, 72);
  new PublicKey(config.operatorVault).toBuffer().copy(data, 104);
  new PublicKey(config.pokeMint).toBuffer().copy(data, 136);
  new PublicKey(config.quoteAuthority).toBuffer().copy(data, 168);
  new PublicKey(config.keeper).toBuffer().copy(data, 200);
  data.writeBigUInt64LE(config.feeBps, 232);
  data.writeBigUInt64LE(config.treasuryBps, 240);
  data.writeBigUInt64LE(config.operatorBps, 248);
  data.writeBigUInt64LE(config.buybackBps, 256);
  data.writeBigUInt64LE(config.minBuybackLamports, 264);
  data[272] = config.bump;
  return data;
}

function vaultProblem(
  name: string,
  account: AccountPresence | null,
  expectedAddress: string,
  programId: string,
): string | undefined {
  if (!account) return `${name} ${expectedAddress} is missing.`;
  if (account.owner !== programId) return `${name} is owned by ${account.owner}, not the program.`;
  if (account.data.length < VAULT_ACCOUNT_SPACE) {
    return `${name} is ${account.data.length} bytes; expected at least ${VAULT_ACCOUNT_SPACE}.`;
  }
  return undefined;
}

export function assessInitialization(input: {
  programId: string;
  authority: string;
  pokeMint: string;
  quoteAuthority: string;
  keeper: string;
  buybackBps: number;
  minBuybackLamports: number;
  accounts: InitAccounts;
  config: AccountPresence | null;
  feeVault: AccountPresence | null;
  treasuryVault: AccountPresence | null;
  operatorVault: AccountPresence | null;
}): InitAssessment {
  const vaults = [
    vaultProblem('fee vault', input.feeVault, input.accounts.feeVault, input.programId),
    vaultProblem('treasury vault', input.treasuryVault, input.accounts.treasuryVault, input.programId),
    vaultProblem('operator vault', input.operatorVault, input.accounts.operatorVault, input.programId),
  ].filter((reason): reason is string => reason !== undefined);

  if (!input.config) {
    const missingVaults = vaults.filter(reason => reason.includes('is missing'));
    if (missingVaults.length === 3) return { status: 'absent' };
    return {
      status: 'partial',
      reasons: [
        'Config account is missing while one or more vaults already exist.',
        ...vaults.filter(reason => !reason.includes('is missing')),
      ],
    };
  }
  if (input.config.owner !== input.programId) {
    return {
      status: 'mismatch',
      reasons: [`Config account is owned by ${input.config.owner}, not the program.`],
    };
  }
  let decoded: DecodedConfig;
  try {
    decoded = decodeConfigAccount(input.config.data);
  } catch (error) {
    return {
      status: 'mismatch',
      reasons: [error instanceof Error ? error.message : 'Config account could not be decoded.'],
    };
  }
  const expected: Array<[string, string, string]> = [
    ['authority', decoded.authority, input.authority],
    ['fee vault', decoded.feeVault, input.accounts.feeVault],
    ['treasury vault', decoded.treasuryVault, input.accounts.treasuryVault],
    ['operator vault', decoded.operatorVault, input.accounts.operatorVault],
    ['POKE mint', decoded.pokeMint, input.pokeMint],
    ['quote authority', decoded.quoteAuthority, input.quoteAuthority],
    ['keeper', decoded.keeper, input.keeper],
    ['fee bps', decoded.feeBps.toString(), String(CASUAL_FEE_BPS)],
    ['treasury bps', decoded.treasuryBps.toString(), String(TREASURY_BPS)],
    ['operator bps', decoded.operatorBps.toString(), String(OPERATOR_BPS)],
    ['buyback bps', decoded.buybackBps.toString(), String(input.buybackBps)],
    ['min buyback lamports', decoded.minBuybackLamports.toString(), String(input.minBuybackLamports)],
    ['config bump', String(decoded.bump), String(input.accounts.configBump)],
  ];
  const reasons = expected
    .filter(([, actual, want]) => actual !== want)
    .map(([label, actual, want]) => `${label} is ${actual}; this plan expects ${want}.`);
  reasons.push(...vaults);
  if (reasons.length > 0) return { status: 'mismatch', reasons };
  return { status: 'initialized' };
}

export function initializationRentLamports(rentLamports: (space: number) => number): number {
  return rentLamports(CONFIG_ACCOUNT_SPACE) + (3 * rentLamports(VAULT_ACCOUNT_SPACE));
}

export interface KeeperSettlementCost {
  perTournamentLamports: number;
  perCasualMatchLamports: number;
  tournamentTransactions: number;
  casualTransactions: number;
}

/**
 * SOL the keeper spends as fee payer. Prize SOL stays in the treasury vault.
 * Replay, prize-reserve, and prize-vault rent is spent and not reclaimed.
 */
export function keeperSettlementCost(rentLamports: (space: number) => number): KeeperSettlementCost {
  const replayRent = rentLamports(REPLAY_ACCOUNT_SPACE);
  const perTournamentLamports = rentLamports(PRIZE_RESERVE_ACCOUNT_SPACE)
    + rentLamports(PRIZE_VAULT_ACCOUNT_SPACE)
    + (TOURNAMENT_FIELD_SIZE * replayRent)
    + replayRent
    + (TOURNAMENT_KEEPER_TRANSACTIONS * SIGNATURE_FEE_LAMPORTS);
  const perCasualMatchLamports = replayRent + (CASUAL_KEEPER_TRANSACTIONS * SIGNATURE_FEE_LAMPORTS);
  return {
    perTournamentLamports,
    perCasualMatchLamports,
    tournamentTransactions: TOURNAMENT_KEEPER_TRANSACTIONS,
    casualTransactions: CASUAL_KEEPER_TRANSACTIONS,
  };
}

/** Smallest gross deposit whose 90% treasury share covers `prizeLamports`. */
export function minimumTreasuryGrossLamports(prizeLamports: bigint): bigint {
  if (prizeLamports <= 0n) throw new MainnetInitError('Prize lamports must be positive.');
  return (prizeLamports * 10_000n + BigInt(TREASURY_BPS) - 1n) / BigInt(TREASURY_BPS);
}

export function initDecision(input: {
  assessment: InitAssessment['status'];
  confirm: boolean;
  balanceLamports: bigint;
  requiredLamports: bigint;
}): { action: 'send' | 'stop'; exitCode: number; message: string } {
  if (input.assessment === 'initialized') {
    return {
      action: 'stop',
      exitCode: 0,
      message: 'Config is already initialized with these values. No transaction will be sent.',
    };
  }
  if (input.assessment === 'mismatch' || input.assessment === 'partial') {
    return {
      action: 'stop',
      exitCode: 1,
      message: 'On-chain initialization does not match this plan. No transaction will be sent.',
    };
  }
  if (input.balanceLamports < input.requiredLamports) {
    return {
      action: 'stop',
      exitCode: 1,
      message: 'Authority balance is below the printed requirement. No transaction was sent.',
    };
  }
  if (!input.confirm) {
    return {
      action: 'stop',
      exitCode: 2,
      message: 'Refusing to initialize. Re-run with --confirm-mainnet after reviewing this plan. No funds were moved.',
    };
  }
  return { action: 'send', exitCode: 0, message: 'Sending initialize_config.' };
}
