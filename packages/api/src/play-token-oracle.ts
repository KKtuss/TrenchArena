import { PublicKey } from '@solana/web3.js';

import { canonicalizeDecimal, decimalToScaled, USD_PRICE_SCALE } from './play-token-math';

export const JUPITER_PRICE_SOURCE = 'jupiter-price-v3';
export const JUPITER_LITE_PRICE_URL = 'https://lite-api.jup.ag/price/v3';
export const JUPITER_KEYED_PRICE_URL = 'https://api.jup.ag/price/v3';

export const DEFAULT_PRICE_CACHE_TTL_MS = 30_000;
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 15_000;
export const DEFAULT_UPSTREAM_CACHE_TTL_MS = 5_000;
export const DEFAULT_MIN_LIQUIDITY_USD = 1_000;

export type TokenPriceUnavailableReason =
  | 'not_listed'
  | 'thin_liquidity'
  | 'invalid_price'
  | 'upstream_error'
  | 'invalid_mint';

export interface TokenUsdPrice {
  mint: string;
  available: boolean;
  /** Canonical decimal from the provider. Null when no usable price exists. */
  priceUsd: string | null;
  /** Floor of priceUsd at USD_PRICE_SCALE. Null when unavailable. */
  priceScaled: bigint | null;
  source: typeof JUPITER_PRICE_SOURCE;
  /** When this process observed the quote. Not the token's creation time. */
  timestamp: string;
  blockId: number | null;
  /** Jupiter pool liquidity in USD, when the response included it. */
  liquidityUsd: string | null;
  /** Decimal hint from the price source. On-chain mint decimals stay authoritative. */
  priceDecimals: number | null;
  reason: TokenPriceUnavailableReason | 'ok';
  cacheHit: boolean;
}

export interface TokenPriceOracle {
  getUsdPrice(mintAddress: string): Promise<TokenUsdPrice>;
}

export interface PriceFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type PriceFetcher = (url: string, init: RequestInit) => Promise<PriceFetchResponse>;

interface CacheEntry {
  value: TokenUsdPrice;
  expiresAt: number;
}

export class MemoryTokenPriceCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly negativeTtlMs: number,
    private readonly upstreamTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(mint: string): TokenUsdPrice | undefined {
    const entry = this.entries.get(mint);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(mint);
      return undefined;
    }
    return { ...entry.value, priceScaled: entry.value.priceScaled, cacheHit: true };
  }

  set(mint: string, value: TokenUsdPrice): void {
    const ttl = value.reason === 'upstream_error'
      ? this.upstreamTtlMs
      : value.available ? this.ttlMs : this.negativeTtlMs;
    if (ttl <= 0) return;
    this.entries.set(mint, {
      value: { ...value, cacheHit: false },
      expiresAt: this.now() + ttl,
    });
  }
}

export function resolveJupiterPriceEndpoint(env: NodeJS.ProcessEnv): {
  url: string;
  headers: Record<string, string>;
} {
  const apiKey = env.JUPITER_API_KEY?.trim() || env.PLAY_TOKEN_JUPITER_API_KEY?.trim() || '';
  const override = env.PLAY_TOKEN_PRICE_URL?.trim();
  const url = override || (apiKey ? JUPITER_KEYED_PRICE_URL : JUPITER_LITE_PRICE_URL);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'PokeArena/play-token-oracle',
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  return { url, headers };
}

export function readNonNegativeInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) return fallback;
  return value;
}

export class JupiterTokenPriceOracle implements TokenPriceOracle {
  private readonly cache: MemoryTokenPriceCache;

  constructor(private readonly options: {
    endpoint: string;
    headers: Record<string, string>;
    minLiquidityUsd: number;
    cacheTtlMs?: number;
    negativeCacheTtlMs?: number;
    upstreamCacheTtlMs?: number;
    fetcher?: PriceFetcher;
    now?: () => number;
    timeoutMs?: number;
  }) {
    const now = options.now ?? Date.now;
    this.cache = new MemoryTokenPriceCache(
      options.cacheTtlMs ?? DEFAULT_PRICE_CACHE_TTL_MS,
      options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS,
      options.upstreamCacheTtlMs ?? DEFAULT_UPSTREAM_CACHE_TTL_MS,
      now,
    );
  }

  async getUsdPrice(mintAddress: string): Promise<TokenUsdPrice> {
    const mint = canonicalMint(mintAddress);
    if (!mint) {
      return unavailable({
        mint: mintAddress,
        reason: 'invalid_mint',
        timestamp: new Date().toISOString(),
      });
    }
    const cached = this.cache.get(mint);
    if (cached) return cached;
    const fresh = await this.fetchPrice(mint);
    this.cache.set(mint, fresh);
    return { ...fresh, cacheHit: false };
  }

  private async fetchPrice(mint: string): Promise<TokenUsdPrice> {
    const timestamp = new Date().toISOString();
    let endpoint: URL;
    try {
      endpoint = new URL(this.options.endpoint);
    } catch {
      return unavailable({ mint, reason: 'upstream_error', timestamp });
    }
    endpoint.searchParams.set('ids', mint);
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    const fetcher = this.options.fetcher ?? defaultFetcher;
    let response: PriceFetchResponse;
    try {
      response = await fetcher(endpoint.toString(), {
        method: 'GET',
        headers: this.options.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return unavailable({ mint, reason: 'upstream_error', timestamp });
    }
    if (!response.ok) {
      return unavailable({ mint, reason: 'upstream_error', timestamp });
    }
    let body: string;
    try {
      body = await response.text();
    } catch {
      return unavailable({ mint, reason: 'upstream_error', timestamp });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return unavailable({ mint, reason: 'upstream_error', timestamp });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return unavailable({ mint, reason: 'upstream_error', timestamp });
    }
    const block = extractMintObject(body, mint);
    if (!block || !(mint in parsed)) {
      return unavailable({ mint, reason: 'not_listed', timestamp });
    }
    const usdPrice = jsonNumberToken(block, 'usdPrice');
    const canonicalPrice = usdPrice ? canonicalizeDecimal(usdPrice) : null;
    const priceScaled = canonicalPrice ? decimalToScaled(canonicalPrice, USD_PRICE_SCALE) : null;
    const liquidityToken = jsonNumberToken(block, 'liquidity');
    const liquidityUsd = liquidityToken ? canonicalizeDecimal(liquidityToken) : null;
    const blockId = integerToken(block, 'blockId');
    const priceDecimals = integerToken(block, 'decimals');
    if (!canonicalPrice || canonicalPrice === '0' || priceScaled === null || priceScaled <= 0n) {
      return unavailable({
        mint,
        reason: 'invalid_price',
        timestamp,
        blockId,
        liquidityUsd,
        priceDecimals,
      });
    }
    if (this.options.minLiquidityUsd > 0) {
      const floor = decimalToScaled(String(this.options.minLiquidityUsd), 6);
      const liquidityScaled = liquidityUsd ? decimalToScaled(liquidityUsd, 6) : null;
      if (floor === null || liquidityScaled === null || liquidityScaled < floor) {
        return unavailable({
          mint,
          reason: 'thin_liquidity',
          timestamp,
          blockId,
          liquidityUsd,
          priceDecimals,
        });
      }
    }
    return {
      mint,
      available: true,
      priceUsd: canonicalPrice,
      priceScaled,
      source: JUPITER_PRICE_SOURCE,
      timestamp,
      blockId,
      liquidityUsd,
      priceDecimals,
      reason: 'ok',
      cacheHit: false,
    };
  }
}

function defaultFetcher(url: string, init: RequestInit): Promise<PriceFetchResponse> {
  return fetch(url, init);
}

export function canonicalMint(value: string): string | null {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function unavailable(input: {
  mint: string;
  reason: TokenPriceUnavailableReason;
  timestamp: string;
  blockId?: number | null;
  liquidityUsd?: string | null;
  priceDecimals?: number | null;
}): TokenUsdPrice {
  return {
    mint: input.mint,
    available: false,
    priceUsd: null,
    priceScaled: null,
    source: JUPITER_PRICE_SOURCE,
    timestamp: input.timestamp,
    blockId: input.blockId ?? null,
    liquidityUsd: input.liquidityUsd ?? null,
    priceDecimals: input.priceDecimals ?? null,
    reason: input.reason,
    cacheHit: false,
  };
}

function extractMintObject(body: string, mint: string): string | null {
  const needle = `"${mint}"`;
  const start = body.indexOf(needle);
  if (start < 0) return null;
  const brace = body.indexOf('{', start + needle.length);
  if (brace < 0) return null;
  if (!/^\s*:\s*$/.test(body.slice(start + needle.length, brace))) return null;
  let depth = 0;
  for (let i = brace; i < body.length; i += 1) {
    const char = body[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(brace, i + 1);
    }
  }
  return null;
}

function jsonNumberToken(block: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`).exec(block);
  return match?.[1] ?? null;
}

function integerToken(block: string, key: string): number | null {
  const match = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`).exec(block);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}
