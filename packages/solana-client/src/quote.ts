import {
  PASSPORT_USD_CENTS,
  QUOTE_MAX_AGE_MS,
  QUOTE_MAX_CONFIDENCE_BPS,
  TOURNAMENT_ENTRY_USD_CENTS,
} from './constants';

export type QuoteSource = 'env' | 'mock' | 'oracle' | 'pyth' | 'switchboard';

export interface PokeUsdQuote {
  /** Micro-USD per whole POKE token (1e6 micro-USD = $1). */
  priceMicroUsd: number;
  /** SPL mint decimals. */
  decimals: number;
  observedAt: number;
  source: QuoteSource;
  /** Confidence band width in bps of the mid price. */
  confidenceBps: number;
  /** Opaque quote id for persistence / on-chain reference. */
  quoteId: string;
}

export class QuoteError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'stale_price'
      | 'wide_confidence'
      | 'invalid_price'
      | 'wallet_unavailable'
      | 'below_threshold',
  ) {
    super(message);
    this.name = 'QuoteError';
  }
}

export function assertFreshQuote(quote: PokeUsdQuote, now = Date.now()): void {
  if (!Number.isSafeInteger(quote.priceMicroUsd) || quote.priceMicroUsd <= 0) {
    throw new QuoteError('POKE price is missing or invalid.', 'invalid_price');
  }
  if (!Number.isInteger(quote.decimals) || quote.decimals < 0 || quote.decimals > 18) {
    throw new QuoteError('POKE mint decimals are invalid.', 'invalid_price');
  }
  if (now - quote.observedAt > QUOTE_MAX_AGE_MS) {
    throw new QuoteError('POKE/USD quote is stale.', 'stale_price');
  }
  if (quote.confidenceBps > QUOTE_MAX_CONFIDENCE_BPS) {
    throw new QuoteError('POKE/USD quote confidence band is too wide.', 'wide_confidence');
  }
}

/**
 * atoms = ceil(usdCents × 10^decimals × 10_000 / priceMicroUsd)
 * priceMicroUsd is micro-USD per 1 whole token; usdCents is USD cents.
 * 1 USD = 1_000_000 micro-USD = 100 cents → micro per cent = 10_000.
 */
export function atomsForUsdCents(usdCents: number, quote: PokeUsdQuote, now = Date.now()): bigint {
  assertFreshQuote(quote, now);
  if (!Number.isInteger(usdCents) || usdCents <= 0) {
    throw new QuoteError('USD amount must be a positive integer number of cents.', 'invalid_price');
  }
  const scale = 10n ** BigInt(quote.decimals);
  const numerator = BigInt(usdCents) * scale * 10_000n;
  const denominator = BigInt(quote.priceMicroUsd);
  return (numerator + denominator - 1n) / denominator;
}

export function passportAtoms(quote: PokeUsdQuote, now = Date.now()): bigint {
  return atomsForUsdCents(PASSPORT_USD_CENTS, quote, now);
}

export function tournamentEntryAtoms(quote: PokeUsdQuote, now = Date.now()): bigint {
  return atomsForUsdCents(TOURNAMENT_ENTRY_USD_CENTS, quote, now);
}

/** Liquid balance valued in USD cents using floor (never inflate eligibility). */
export function usdCentsFromAtoms(atoms: bigint, quote: PokeUsdQuote, now = Date.now()): number {
  assertFreshQuote(quote, now);
  if (atoms < 0n) throw new QuoteError('Token amount cannot be negative.', 'invalid_price');
  const scale = 10n ** BigInt(quote.decimals);
  // cents = atoms * priceMicroUsd / (10^decimals * 10_000)
  const cents = (atoms * BigInt(quote.priceMicroUsd)) / (scale * 10_000n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(cents);
}

export function createEnvQuote(env: NodeJS.ProcessEnv = process.env): PokeUsdQuote | undefined {
  const raw = env.POKEARENA_POKE_PRICE_MICRO_USD;
  if (!raw) return undefined;
  const priceMicroUsd = Number(raw);
  const decimals = Number(env.POKEARENA_POKE_DECIMALS ?? 6);
  const confidenceBps = Number(env.POKEARENA_POKE_PRICE_CONFIDENCE_BPS ?? 0);
  return {
    priceMicroUsd,
    decimals,
    observedAt: Date.now(),
    source: 'env',
    confidenceBps,
    quoteId: env.POKEARENA_POKE_QUOTE_ID ?? `env-${priceMicroUsd}-${Date.now()}`,
  };
}

/** Local-validator default: $0.40 / POKE with 6 decimals. */
export function createMockQuote(overrides: Partial<PokeUsdQuote> = {}): PokeUsdQuote {
  return {
    priceMicroUsd: 400_000,
    decimals: 6,
    observedAt: Date.now(),
    source: 'mock',
    confidenceBps: 0,
    quoteId: `mock-${Date.now()}`,
    ...overrides,
  };
}
