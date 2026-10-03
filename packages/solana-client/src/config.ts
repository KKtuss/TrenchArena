import { PublicKey } from '@solana/web3.js';

import { DEFAULT_RPC } from './constants';
import { feeVaultPda, operatorVaultPda, treasuryVaultPda } from './pdas';

export type SolanaCluster = 'localnet' | 'devnet' | 'mainnet-beta';

export interface ArenaChainConfig {
  cluster: SolanaCluster;
  rpcUrl: string;
  programId: PublicKey;
  pokeMint: PublicKey;
  feeVault: PublicKey;
  treasuryVault: PublicKey;
  operatorVault: PublicKey;
  quoteAuthority: PublicKey;
  keeper: PublicKey;
  authority: PublicKey;
  buybackBps: number;
  minBuybackLamports: number;
  chainEconomyEnabled: boolean;
  commitment: 'processed' | 'confirmed' | 'finalized';
}

export class ChainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainConfigError';
  }
}

function requirePubkey(env: NodeJS.ProcessEnv, key: string, required: boolean): PublicKey | undefined {
  const raw = env[key]?.trim();
  if (!raw) {
    if (required) throw new ChainConfigError(`${key} is required when chain economy is enabled.`);
    return undefined;
  }
  try {
    return new PublicKey(raw);
  } catch {
    throw new ChainConfigError(`${key} is not a valid Solana public key.`);
  }
}

function parseCluster(raw: string | undefined): SolanaCluster {
  const value = (raw ?? 'localnet').trim().toLowerCase();
  if (value === 'localnet' || value === 'local' || value === 'localhost') return 'localnet';
  if (value === 'devnet') return 'devnet';
  if (value === 'mainnet' || value === 'mainnet-beta') return 'mainnet-beta';
  throw new ChainConfigError(`Unknown POKEARENA_SOLANA_CLUSTER: ${raw}`);
}

/**
 * Load chain config from process env.
 * When POKEARENA_CHAIN_ECONOMY is unset/false, returns a disabled config that
 * does not require addresses (legacy mock economics stays active).
 */
export function loadChainConfig(env: NodeJS.ProcessEnv = process.env): ArenaChainConfig {
  const enabled = ['1', 'true', 'yes', 'on'].includes(
    (env.POKEARENA_CHAIN_ECONOMY ?? '').trim().toLowerCase(),
  );
  const cluster = parseCluster(env.POKEARENA_SOLANA_CLUSTER);
  const configuredRpc = env.POKEARENA_SOLANA_RPC?.trim();
  const rpcUrl = configuredRpc || DEFAULT_RPC;
  const productionLike = cluster === 'mainnet-beta' || cluster === 'devnet';
  if (enabled && env.NODE_ENV === 'production' && cluster === 'localnet') {
    const allowLocalnet = ['1', 'true', 'yes', 'on'].includes(
      (env.POKEARENA_ALLOW_LOCALNET_IN_PRODUCTION ?? '').trim().toLowerCase(),
    );
    if (!allowLocalnet) {
      throw new ChainConfigError(
        'Production chain economy cannot target localnet. Set POKEARENA_ALLOW_LOCALNET_IN_PRODUCTION=true for a host that intentionally runs a local validator.',
      );
    }
  }
  if (enabled && productionLike && !configuredRpc) {
    throw new ChainConfigError('POKEARENA_SOLANA_RPC is required for devnet/mainnet chain economy.');
  }

  if (!enabled) {
    const zero = PublicKey.default;
    return {
      cluster,
      rpcUrl,
      programId: zero,
      pokeMint: zero,
      feeVault: zero,
      treasuryVault: zero,
      operatorVault: zero,
      quoteAuthority: zero,
      keeper: zero,
      authority: zero,
      buybackBps: Number(env.POKEARENA_BUYBACK_BPS ?? 0),
      minBuybackLamports: Number(env.POKEARENA_MIN_BUYBACK_LAMPORTS ?? 0),
      chainEconomyEnabled: false,
      commitment: 'confirmed',
    };
  }

  const required = productionLike || enabled;
  const programId = requirePubkey(env, 'POKEARENA_PROGRAM_ID', required);
  const pokeMint = requirePubkey(env, 'POKEARENA_POKE_MINT', required);
  // Vaults are program PDAs; env overrides are optional when program id is known.
  let feeVault = requirePubkey(env, 'POKEARENA_FEE_VAULT', false);
  let treasuryVault = requirePubkey(env, 'POKEARENA_TREASURY_VAULT', false);
  let operatorVault = requirePubkey(env, 'POKEARENA_OPERATOR_VAULT', false);
  if (programId) {
    feeVault = feeVault ?? feeVaultPda(programId)[0];
    treasuryVault = treasuryVault ?? treasuryVaultPda(programId)[0];
    operatorVault = operatorVault ?? operatorVaultPda(programId)[0];
  }
  const quoteAuthority = requirePubkey(env, 'POKEARENA_QUOTE_AUTHORITY', required);
  const keeper = requirePubkey(env, 'POKEARENA_KEEPER', required);
  const authority = requirePubkey(env, 'POKEARENA_AUTHORITY', required);

  if (
    !programId || !pokeMint || !feeVault || !treasuryVault
    || !operatorVault || !quoteAuthority || !keeper || !authority
  ) {
    throw new ChainConfigError('Chain economy is enabled but required addresses are missing.');
  }

  const buybackBps = Number(env.POKEARENA_BUYBACK_BPS ?? 0);
  if (!Number.isInteger(buybackBps) || buybackBps < 0 || buybackBps > 10_000) {
    throw new ChainConfigError('POKEARENA_BUYBACK_BPS must be an integer in [0, 10000].');
  }

  return {
    cluster,
    rpcUrl,
    programId,
    pokeMint,
    feeVault,
    treasuryVault,
    operatorVault,
    quoteAuthority,
    keeper,
    authority,
    buybackBps,
    minBuybackLamports: Number(env.POKEARENA_MIN_BUYBACK_LAMPORTS ?? 50_000_000),
    chainEconomyEnabled: true,
    commitment: (env.POKEARENA_SOLANA_COMMITMENT as ArenaChainConfig['commitment']) ?? 'confirmed',
  };
}
