import { PublicKey } from '@solana/web3.js';

import { CASUAL_FEE_BPS, OPERATOR_BPS, TREASURY_BPS } from './constants';
import { configPda, feeVaultPda, operatorVaultPda, treasuryVaultPda } from './pdas';
import { POKE_MINT_DECIMALS, TOURNAMENT_FIELD_SIZE } from './poke-units';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './token';

/** Immutable production ID; staging must never target it. */
export const PRODUCTION_PROGRAM_ID = '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W';
export const PRODUCTION_UPGRADE_AUTHORITY = 'GGRAzZM9wnuLNCWQb6JYykRyfp4pXjHvp35JEmaps51Z';
export const PRODUCTION_KEEPER = 'AZn8PqCeQLKyKLDUgy67NsvLtTiFzDY9S491fGC15iAL';
export const KNOWN_PRODUCTION_AUTHORITY = 'Fmb7DLU6fTrQEGh8g6HSsYz3MviMjjS6nnB9n2TATdzw';
/** Fresh staging program. The Pinocchio artifact accepts only this id. */
export const STAGING_PROGRAM_ID = 'HRN7567mTaH27Bhngu4Rg7JUQ8bvZp6Ymmf7XRT99rZk';
/** Staging program whose ProgramData cannot be reused. Fresh staging must reject it. */
export const CLOSED_STAGING_PROGRAM_ID = '54Ji1Z32wH4NfDqpd3WMTbSBeK119ptAMmYcQirCUmmU';
/** Earlier retired staging program. Fresh staging must reject it. */
export const DEAD_STAGING_PROGRAM_ID = '6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98';
export const DEAD_STAGING_DEPLOYER = 'AXHoz3WVjyK1chetSrcWMnDDq8VZjvfoUW5yMyKNRpki';
export const DEAD_STAGING_AUTHORITY = 'Bs919SY62WM6J22HZo1GPnSnxpL7B66JFXtjwCDC1fNJ';
export const DEAD_STAGING_KEEPER = '8Z1iUEpFmLeTFZquJXF66pEcSWYfRZMaztQHcbYwWgK8';
/** Shared Pump CARDS prize mint. Not a staging signer. */
export const MAINNET_CARDS_MINT = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp';
/** Initializer and unit-test program id. This is the fresh staging program. */
export const MAINNET_PROGRAM_ID = STAGING_PROGRAM_ID;

const RETIRED_STAGING_PUBKEYS = new Set([
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
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const UPGRADEABLE_LOADER_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** Config::pack layout in programs/arena-escrow-pinocchio/src/state.rs. */
export const CONFIG_DISCRIMINATOR = Buffer.from([
  0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82,
]);
export const CONFIG_ACCOUNT_SPACE = 305;
export const VAULT_ACCOUNT_SPACE = 8;
export const REPLAY_ACCOUNT_SPACE = 42;
export const PRIZE_RESERVE_ACCOUNT_SPACE = 67;
export const PRIZE_VAULT_ACCOUNT_SPACE = 0;
export const CARDS_PRIZE_RESERVE_ACCOUNT_SPACE = 163;
export const CARDS_PRIZE_VAULT_ACCOUNT_SPACE = 165;

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
  cardsMint: string;
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
  cardsMint: string;
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
  if (!['1', 'true', 'yes', 'on'].includes((env.POKEARENA_STAGING ?? '').trim().toLowerCase())) {
    throw new MainnetInitError(
      'POKEARENA_STAGING=true is required. This worktree is staging-only and will not initialize production.',
    );
  }
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
  assertFreshStagingIdentity('POKEARENA_PROGRAM_ID', programId);
  const authorityKeypairPath = env.POKEARENA_AUTHORITY_KEYPAIR?.trim() ?? '';
  if (!authorityKeypairPath) {
    throw new MainnetInitError(
      'Set POKEARENA_AUTHORITY_KEYPAIR to the fresh staging config-authority keypair. This initialization does not choose or create one.',
    );
  }
  const cardsMint = requirePubkey('POKEARENA_CARDS_MINT', env.POKEARENA_CARDS_MINT);
  if (cardsMint !== MAINNET_CARDS_MINT) {
    throw new MainnetInitError(
      `POKEARENA_CARDS_MINT is ${cardsMint}. Staging prizes use the shared CARDS mint ${MAINNET_CARDS_MINT}.`,
    );
  }
  const pokeMint = readOptionalPokeMint(env.POKEARENA_POKE_MINT);
  if (pokeMint !== PublicKey.default.toBase58()) {
    throw new MainnetInitError(
      'POKEARENA_POKE_MINT must stay unset. The fresh staging POKE mint is not created by this initialization.',
    );
  }
  const keeper = requirePubkey('POKEARENA_KEEPER', env.POKEARENA_KEEPER);
  const quoteAuthority = requirePubkey('POKEARENA_QUOTE_AUTHORITY', env.POKEARENA_QUOTE_AUTHORITY);
  assertFreshStagingIdentity('POKEARENA_KEEPER', keeper);
  assertFreshStagingIdentity('POKEARENA_QUOTE_AUTHORITY', quoteAuthority);
  if (keeper === programId) {
    throw new MainnetInitError('Keeper must be distinct from the program ID.');
  }
  if (quoteAuthority === programId) {
    throw new MainnetInitError('Quote authority must be distinct from the program ID.');
  }
  const buybackBps = requireExplicitInt('POKEARENA_BUYBACK_BPS', env.POKEARENA_BUYBACK_BPS, 10_000);
  if (buybackBps !== 0) {
    throw new MainnetInitError('POKEARENA_BUYBACK_BPS must be 0. Fresh staging does not enable buyback.');
  }
  return {
    cluster: (env.POKEARENA_SOLANA_CLUSTER ?? '').trim().toLowerCase(),
    rpc: env.POKEARENA_SOLANA_RPC!.trim(),
    programId,
    pokeMint,
    cardsMint,
    keeper,
    quoteAuthority,
    authorityKeypairPath,
    buybackBps,
    minBuybackLamports: requireExplicitInt(
      'POKEARENA_MIN_BUYBACK_LAMPORTS',
      env.POKEARENA_MIN_BUYBACK_LAMPORTS,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function assertProductionKeypairPath(keypairPath: string, repoRoot: string): void {
  const resolved = absolutePath(keypairPath);
  const keysDir = absolutePath(`${repoRoot}/scripts/solana/keys`);
  if (isInsidePath(resolved, keysDir)) {
    throw new MainnetInitError(
      `Refusing local test keypair ${resolved}. Mainnet initialization does not use scripts/solana/keys.`,
    );
  }
}

function absolutePath(value: string): string {
  const slash = value.replace(/\\/g, '/');
  const rooted = /^[A-Za-z]:\//.test(slash) || slash.startsWith('/')
    ? slash
    : `${process.cwd().replace(/\\/g, '/')}/${slash}`;
  const drive = /^[A-Za-z]:/.test(rooted) ? rooted.slice(0, 2) : '';
  const parts: string[] = [];
  for (const part of (drive ? rooted.slice(2) : rooted).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${drive ? `${drive}/` : rooted.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

function isInsidePath(child: string, parent: string): boolean {
  const left = child.toLowerCase();
  const right = parent.toLowerCase().replace(/\/$/, '');
  return left === right || left.startsWith(`${right}/`);
}

export function assertFreshStagingIdentity(role: string, pubkey: string): void {
  if (RETIRED_STAGING_PUBKEYS.has(pubkey)) {
    throw new MainnetInitError(
      `${role} ${pubkey} is a retired staging identity. Fresh staging must use a new key.`,
    );
  }
  if (PRODUCTION_PUBKEYS.has(pubkey)) {
    throw new MainnetInitError(
      `${role} ${pubkey} is a production program, upgrade authority, or keeper. Staging initialization rejects it.`,
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
  if (pubkey === PRODUCTION_PROGRAM_ID || pubkey === STAGING_PROGRAM_ID) {
    throw new MainnetInitError(`${role} must not be a production or staging program ID.`);
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

const MINT_BASE = 82;
const ACCOUNT_TYPE_AT = 165;
const TLV_AT = 166;
const MAX_POKE_MINT = 1024;
const MINT_ACCOUNT_TYPE = 1;
const EXT_METADATA_POINTER = 18;
const EXT_TOKEN_METADATA = 19;
const POINTER_LEN = 64;

/** 412-byte launch layout: MetadataPointer (64) plus a 174-byte TokenMetadata body. */
export const REFERENCE_POKE_METADATA_LENGTH = 174;

/**
 * Bare 82-byte Token-2022 mint, or the launch layout: Mint account type,
 * zero padding, MetadataPointer and TokenMetadata, and no other extension.
 * MetadataPointer and TokenMetadata do not add Transfer or Burn accounts.
 */
export function assertPokeMintAccount(owner: PublicKey, data: Uint8Array): void {
  if (!owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new MainnetInitError(
      'POKEARENA_POKE_MINT is not a Token-2022 mint. POKE requires Token-2022.',
    );
  }
  if (data.length < MINT_BASE) {
    throw new MainnetInitError('POKE mint account is too small to be a Token-2022 mint.');
  }
  if (data.length > MAX_POKE_MINT) {
    throw new MainnetInitError(`POKE mint account is ${data.length} bytes. The supported maximum is ${MAX_POKE_MINT}.`);
  }
  const decimals = data[44];
  if (decimals !== POKE_MINT_DECIMALS) {
    throw new MainnetInitError(
      `POKE mint decimals are ${decimals}. Production initialization requires ${POKE_MINT_DECIMALS} decimals.`,
    );
  }
  if (data[45] !== 1) {
    throw new MainnetInitError('POKE mint is not initialized.');
  }
  if (data.length === MINT_BASE) return;
  if (data.length < TLV_AT || data[ACCOUNT_TYPE_AT] !== MINT_ACCOUNT_TYPE) {
    throw new MainnetInitError('POKE mint extension header is not a Token-2022 mint.');
  }
  for (let index = MINT_BASE; index < ACCOUNT_TYPE_AT; index += 1) {
    if (data[index] !== 0) {
      throw new MainnetInitError('POKE mint extension padding is not empty.');
    }
  }
  let offset = TLV_AT;
  let pointer = false;
  let metadata = false;
  while (offset < data.length) {
    if (data.length - offset < 4) {
      throw new MainnetInitError('POKE mint extension data is truncated.');
    }
    const kind = data[offset]! | (data[offset + 1]! << 8);
    const extLen = data[offset + 2]! | (data[offset + 3]! << 8);
    const next = offset + 4 + extLen;
    if (next > data.length) {
      throw new MainnetInitError('POKE mint extension data is truncated.');
    }
    if (kind === EXT_METADATA_POINTER) {
      if (pointer || extLen !== POINTER_LEN) {
        throw new MainnetInitError('POKE mint MetadataPointer extension is invalid.');
      }
      pointer = true;
    } else if (kind === EXT_TOKEN_METADATA) {
      if (metadata || extLen === 0) {
        throw new MainnetInitError('POKE mint TokenMetadata extension is invalid.');
      }
      metadata = true;
    } else {
      throw new MainnetInitError(`POKE mint extension ${kind} is not supported.`);
    }
    offset = next;
  }
  if (!pointer || !metadata) {
    throw new MainnetInitError('POKE mint extensions are incomplete.');
  }
}

/** Token-2022 mint bytes matching the reference launch extension structure. */
export function referencePokeMintData(options: {
  decimals?: number;
  initialized?: boolean;
  metadataLength?: number;
  extraExtension?: { type: number; length: number };
  supply?: bigint;
} = {}): Buffer {
  const metadataLength = options.metadataLength ?? REFERENCE_POKE_METADATA_LENGTH;
  const extra = options.extraExtension;
  const length = TLV_AT + 4 + POINTER_LEN + 4 + metadataLength + (extra ? 4 + extra.length : 0);
  const data = Buffer.alloc(length);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(options.supply ?? 1_000_000_000_000n, 36);
  data[44] = options.decimals ?? POKE_MINT_DECIMALS;
  data[45] = options.initialized === false ? 0 : 1;
  data[ACCOUNT_TYPE_AT] = MINT_ACCOUNT_TYPE;
  let offset = TLV_AT;
  data.writeUInt16LE(EXT_METADATA_POINTER, offset);
  data.writeUInt16LE(POINTER_LEN, offset + 2);
  offset += 4 + POINTER_LEN;
  data.writeUInt16LE(EXT_TOKEN_METADATA, offset);
  data.writeUInt16LE(metadataLength, offset + 2);
  offset += 4 + metadataLength;
  if (extra) {
    data.writeUInt16LE(extra.type, offset);
    data.writeUInt16LE(extra.length, offset + 2);
  }
  return data;
}

export function assertCardsMintAccount(owner: PublicKey, data: Uint8Array): void {
  if (!owner.equals(TOKEN_PROGRAM_ID)) {
    throw new MainnetInitError(
      'POKEARENA_CARDS_MINT is not a classic SPL token mint. CARDS requires Tokenkeg.',
    );
  }
  if (data.length < 82) {
    throw new MainnetInitError('POKEARENA_CARDS_MINT account is too small to be a token mint.');
  }
  const decimals = data[44];
  if (decimals !== POKE_MINT_DECIMALS) {
    throw new MainnetInitError(
      `CARDS mint decimals are ${decimals}. Production initialization requires ${POKE_MINT_DECIMALS} decimals.`,
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
    cardsMint: readPubkey(data, 273),
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
  new PublicKey(config.cardsMint).toBuffer().copy(data, 273);
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
  cardsMint: string;
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
    ['CARDS mint', decoded.cardsMint, input.cardsMint],
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
 * SOL the keeper spends up front as fee payer. CARDS prize funds stay in the
 * CARDS vault. Close later returns match, entry, and prize rent to the creator,
 * player, or config authority. The keeper does not receive that rent.
 */
export function keeperSettlementCost(rentLamports: (space: number) => number): KeeperSettlementCost {
  const replayRent = rentLamports(REPLAY_ACCOUNT_SPACE);
  const perTournamentLamports = rentLamports(CARDS_PRIZE_RESERVE_ACCOUNT_SPACE)
    + rentLamports(CARDS_PRIZE_VAULT_ACCOUNT_SPACE)
    + ((TOURNAMENT_FIELD_SIZE + 2) * replayRent)
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
