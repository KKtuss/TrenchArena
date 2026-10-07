import { Connection, PublicKey } from '@solana/web3.js';

import {
  createSplConnection,
  readSplBalance,
  TOKEN_2022_PROGRAM_ID,
  type SplBalanceConnection,
} from './play-token-balance';
import {
  canonicalizeDecimal,
  decimalToScaled,
  formatScaled,
  formatTokenAmount,
  numberToDecimalString,
  usdScaledFromRaw,
  USD_PRICE_SCALE,
} from './play-token-math';
import {
  canonicalMint,
  DEFAULT_MIN_LIQUIDITY_USD,
  DEFAULT_NEGATIVE_CACHE_TTL_MS,
  DEFAULT_PRICE_CACHE_TTL_MS,
  DEFAULT_UPSTREAM_CACHE_TTL_MS,
  JupiterTokenPriceOracle,
  JUPITER_PRICE_SOURCE,
  readNonNegativeInt,
  resolveJupiterPriceEndpoint,
  type PriceFetcher,
  type TokenPriceOracle,
  type TokenUsdPrice,
} from './play-token-oracle';

import { POKEARENA_PASSPORT_MIN_USD } from '@pokearena/solana-client';

export const DEFAULT_PLAY_TOKEN_MIN_USD = POKEARENA_PASSPORT_MIN_USD;
export const DEFAULT_PLAY_TOKEN_RPC = 'https://api.mainnet-beta.solana.com';

export type PlayTokenStatus =
  | 'ok'
  | 'price_unavailable'
  | 'rpc_error'
  | 'invalid_request'
  | 'invalid_mint'
  | 'not_configured';

export interface PlayTokenCheckResult {
  status: PlayTokenStatus;
  mint: string | null;
  wallet: string | null;
  /** Exact human token amount. Null when the balance was not read. */
  tokenBalance: string | null;
  tokenBalanceRaw: string | null;
  decimals: number | null;
  /** Source price. Null when no usable price exists. Never coerced to "0". */
  priceUsd: string | null;
  /** Floored USD value at 18 decimal places. Null when it cannot be calculated. */
  usdValue: string | null;
  minimumUsd: string | null;
  /** True only when a reliable price and balance were both read and the value meets the minimum. */
  eligible: boolean;
  priceSource: string | null;
  priceTimestamp: string | null;
  priceBlockId: number | null;
  liquidityUsd: string | null;
  priceDecimals: number | null;
  cacheHit: boolean;
  reason: string;
}

export interface PlayTokenCheckInput {
  mint: string;
  wallet: string;
  minimumUsd: string | number;
}

export interface PlayTokenConfig {
  /** Canonical mint, or null when unset or not a public key. */
  mint: string | null;
  /** True when PLAY_TOKEN_MINT is present but not a Solana address. */
  mintInvalid: boolean;
  /** Canonical positive USD minimum, or null when the env value is unusable. */
  minimumUsd: string | null;
  minimumInvalid: boolean;
  rpcUrl: string;
  minLiquidityUsd: number;
  cacheTtlMs: number;
  negativeCacheTtlMs: number;
  upstreamCacheTtlMs: number;
}

/**
 * Backend holding check. Price, balance, USD value, and eligibility are computed here.
 * Callers must not supply those values.
 */
export class PlayTokenEligibilityService {
  constructor(
    private readonly oracle: TokenPriceOracle,
    private readonly balances: SplBalanceConnection,
    private readonly config: PlayTokenConfig,
  ) {}

  /**
   * Eligibility for the configured PokeArena mint.
   * Returns not_configured (and does not grant access) until PLAY_TOKEN_MINT is set.
   */
  async checkConfiguredWallet(wallet: string): Promise<PlayTokenCheckResult> {
    const walletKey = canonicalMint(wallet);
    if (this.config.mintInvalid || this.config.minimumInvalid || !this.config.minimumUsd) {
      return result({
        status: 'invalid_request',
        mint: this.config.mint,
        wallet: walletKey,
        minimumUsd: this.config.minimumUsd,
        reason: this.config.mintInvalid ? 'invalid_mint' : 'invalid_minimum',
      });
    }
    if (!this.config.mint) {
      return result({
        status: 'not_configured',
        wallet: walletKey,
        minimumUsd: this.config.minimumUsd,
        reason: 'not_configured',
      });
    }
    return this.check({
      mint: this.config.mint,
      wallet,
      minimumUsd: this.config.minimumUsd,
    });
  }

  async check(input: PlayTokenCheckInput): Promise<PlayTokenCheckResult> {
    const mint = canonicalMint(input.mint);
    const wallet = canonicalMint(input.wallet);
    const minimum = normalizeMinimum(input.minimumUsd);
    if (!mint || !wallet || !minimum) {
      return result({
        status: 'invalid_request',
        mint,
        wallet,
        minimumUsd: minimum,
        reason: !mint ? 'invalid_mint' : !wallet ? 'invalid_wallet' : 'invalid_minimum',
      });
    }
    const minimumScaled = decimalToScaled(minimum, USD_PRICE_SCALE);
    if (minimumScaled === null || minimumScaled <= 0n) {
      return result({
        status: 'invalid_request',
        mint,
        wallet,
        minimumUsd: minimum,
        reason: 'invalid_minimum',
      });
    }

    const price = await this.oracle.getUsdPrice(mint);
    let balance: Awaited<ReturnType<typeof readSplBalance>>;
    try {
      balance = await readSplBalance(
        this.balances,
        new PublicKey(wallet),
        new PublicKey(mint),
        TOKEN_2022_PROGRAM_ID,
      );
    } catch {
      return result({
        status: 'rpc_error',
        mint,
        wallet,
        minimumUsd: minimum,
        price,
        reason: 'rpc_error',
      });
    }

    if (!balance.ok) {
      const status = balance.code === 'not_mint' ? 'invalid_mint' : 'rpc_error';
      return result({
        status,
        mint,
        wallet,
        minimumUsd: minimum,
        price,
        reason: balance.code,
      });
    }

    const tokenBalance = formatTokenAmount(balance.raw, balance.decimals);
    if (!price.available || price.priceScaled === null || price.priceUsd === null) {
      return result({
        status: 'price_unavailable',
        mint,
        wallet,
        minimumUsd: minimum,
        tokenBalance,
        tokenBalanceRaw: balance.raw.toString(),
        decimals: balance.decimals,
        price,
        reason: price.reason === 'ok' ? 'invalid_price' : price.reason,
      });
    }

    const usdScaled = usdScaledFromRaw(balance.raw, price.priceScaled, balance.decimals);
    const eligible = usdScaled >= minimumScaled;
    return result({
      status: 'ok',
      mint,
      wallet,
      minimumUsd: minimum,
      tokenBalance,
      tokenBalanceRaw: balance.raw.toString(),
      decimals: balance.decimals,
      usdValue: formatScaled(usdScaled, USD_PRICE_SCALE),
      price,
      eligible,
      reason: eligible ? 'eligible' : 'below_threshold',
    });
  }
}

export function loadPlayTokenConfig(env: NodeJS.ProcessEnv): PlayTokenConfig {
  const mintRaw = env.PLAY_TOKEN_MINT?.trim() ?? '';
  const mint = mintRaw ? canonicalMint(mintRaw) : null;
  const minimumRaw = env.PLAY_TOKEN_MIN_USD?.trim() ?? '';
  const minimum = minimumRaw ? normalizeMinimum(minimumRaw) : DEFAULT_PLAY_TOKEN_MIN_USD;
  return {
    mint,
    mintInvalid: Boolean(mintRaw) && !mint,
    minimumUsd: minimum,
    minimumInvalid: Boolean(minimumRaw) && !minimum,
    rpcUrl: env.PLAY_TOKEN_RPC?.trim()
      || env.POKEARENA_SOLANA_RPC?.trim()
      || DEFAULT_PLAY_TOKEN_RPC,
    minLiquidityUsd: readNonNegativeInt(
      env.PLAY_TOKEN_MIN_LIQUIDITY_USD,
      DEFAULT_MIN_LIQUIDITY_USD,
      1_000_000_000_000,
    ),
    cacheTtlMs: readNonNegativeInt(env.PLAY_TOKEN_PRICE_CACHE_TTL_MS, DEFAULT_PRICE_CACHE_TTL_MS, 86_400_000),
    negativeCacheTtlMs: readNonNegativeInt(
      env.PLAY_TOKEN_PRICE_NEGATIVE_CACHE_TTL_MS,
      DEFAULT_NEGATIVE_CACHE_TTL_MS,
      86_400_000,
    ),
    upstreamCacheTtlMs: readNonNegativeInt(
      env.PLAY_TOKEN_PRICE_UPSTREAM_CACHE_TTL_MS,
      DEFAULT_UPSTREAM_CACHE_TTL_MS,
      86_400_000,
    ),
  };
}

export function createPlayTokenEligibilityService(options: {
  env?: NodeJS.ProcessEnv;
  connection?: Connection | null;
  oracle?: TokenPriceOracle;
  fetcher?: PriceFetcher;
  now?: () => number;
} = {}): PlayTokenEligibilityService {
  const env = options.env ?? process.env;
  const config = loadPlayTokenConfig(env);
  const endpoint = resolveJupiterPriceEndpoint(env);
  const oracle = options.oracle ?? new JupiterTokenPriceOracle({
    endpoint: endpoint.url,
    headers: endpoint.headers,
    minLiquidityUsd: config.minLiquidityUsd,
    cacheTtlMs: config.cacheTtlMs,
    negativeCacheTtlMs: config.negativeCacheTtlMs,
    upstreamCacheTtlMs: config.upstreamCacheTtlMs,
    fetcher: options.fetcher,
    now: options.now,
  });
  const connection = options.connection && sameRpc(options.connection, config.rpcUrl)
    ? options.connection
    : createSplConnection(config.rpcUrl);
  return new PlayTokenEligibilityService(oracle, connection, config);
}

export function normalizeMinimum(value: string | number): string | null {
  const text = typeof value === 'number' ? numberToDecimalString(value) : canonicalizeDecimal(value);
  if (!text || text === '0') return null;
  return text;
}

function sameRpc(connection: Connection, url: string): boolean {
  try {
    return new URL(connection.rpcEndpoint).href === new URL(url).href;
  } catch {
    return connection.rpcEndpoint === url;
  }
}

function result(input: {
  status: PlayTokenStatus;
  mint?: string | null;
  wallet?: string | null;
  minimumUsd?: string | null;
  tokenBalance?: string | null;
  tokenBalanceRaw?: string | null;
  decimals?: number | null;
  usdValue?: string | null;
  price?: TokenUsdPrice;
  eligible?: boolean;
  reason: string;
}): PlayTokenCheckResult {
  const price = input.price;
  const eligible = input.status === 'ok' && input.eligible === true && price?.available === true;
  return {
    status: input.status,
    mint: input.mint ?? null,
    wallet: input.wallet ?? null,
    tokenBalance: input.tokenBalance ?? null,
    tokenBalanceRaw: input.tokenBalanceRaw ?? null,
    decimals: input.decimals ?? null,
    priceUsd: price?.available ? price.priceUsd : null,
    usdValue: input.status === 'ok' ? input.usdValue ?? null : null,
    minimumUsd: input.minimumUsd ?? null,
    eligible,
    priceSource: price ? JUPITER_PRICE_SOURCE : null,
    priceTimestamp: price?.timestamp ?? null,
    priceBlockId: price?.blockId ?? null,
    liquidityUsd: price?.liquidityUsd ?? null,
    priceDecimals: price?.priceDecimals ?? null,
    cacheHit: price?.cacheHit ?? false,
    reason: input.reason,
  };
}
