import { PASSPORT_USD_CENTS, TOURNAMENT_BURN_FEE_ATOMS } from './constants';
import {
  assertFreshQuote,
  passportAtoms,
  usdCentsFromAtoms,
  type PokeUsdQuote,
  QuoteError,
} from './quote';

export type PassportReason =
  | 'ok'
  | 'below_threshold'
  | 'stale_price'
  | 'wide_confidence'
  | 'invalid_price'
  | 'wallet_unavailable';

export interface PassportStatus {
  eligible: boolean;
  liquidAtoms: string;
  heldEntryAtoms: string;
  qualifyingAtoms: string;
  usdCents: number;
  thresholdUsdCents: number;
  reason: PassportReason;
  quote: PokeUsdQuote;
  /** Atoms still needed to reach the passport threshold (0 when eligible). */
  shortfallAtoms: string;
  /** Atoms required to enter a cup and remain eligible (~$25 at $0.40). */
  atomsForEntryAndPassport: string;
}

export function evaluatePassport(input: {
  liquidAtoms: bigint;
  heldEntryAtoms?: bigint;
  quote: PokeUsdQuote;
  now?: number;
}): PassportStatus {
  const now = input.now ?? Date.now();
  const held = input.heldEntryAtoms ?? 0n;
  const qualifying = input.liquidAtoms > held ? input.liquidAtoms - held : 0n;

  try {
    assertFreshQuote(input.quote, now);
    if (input.quote.source === 'env') {
      throw new QuoteError(
        'An operator-set POKE price cannot authorize passport eligibility.',
        'invalid_price',
      );
    }
  } catch (error) {
    const code = error instanceof QuoteError ? error.code : 'invalid_price';
    return {
      eligible: false,
      liquidAtoms: input.liquidAtoms.toString(),
      heldEntryAtoms: held.toString(),
      qualifyingAtoms: qualifying.toString(),
      usdCents: 0,
      thresholdUsdCents: PASSPORT_USD_CENTS,
      reason: code === 'wallet_unavailable' ? 'wallet_unavailable' : code,
      quote: input.quote,
      shortfallAtoms: passportAtoms({ ...createSafeQuote(input.quote), source: 'mock' }).toString(),
      atomsForEntryAndPassport: (
        passportAtoms({ ...createSafeQuote(input.quote), source: 'mock' }) + BigInt(TOURNAMENT_BURN_FEE_ATOMS)
      ).toString(),
    };
  }

  const required = passportAtoms(input.quote, now);
  const entry = BigInt(TOURNAMENT_BURN_FEE_ATOMS);
  const usdCents = usdCentsFromAtoms(qualifying, input.quote, now);
  const eligible = qualifying >= required;
  const shortfall = qualifying >= required ? 0n : required - qualifying;

  return {
    eligible,
    liquidAtoms: input.liquidAtoms.toString(),
    heldEntryAtoms: held.toString(),
    qualifyingAtoms: qualifying.toString(),
    usdCents,
    thresholdUsdCents: PASSPORT_USD_CENTS,
    reason: eligible ? 'ok' : 'below_threshold',
    quote: input.quote,
    shortfallAtoms: shortfall.toString(),
    atomsForEntryAndPassport: (required + entry).toString(),
  };
}

function createSafeQuote(quote: PokeUsdQuote): PokeUsdQuote {
  return {
    ...quote,
    observedAt: Date.now(),
    confidenceBps: Math.min(quote.confidenceBps, 0),
    priceMicroUsd: quote.priceMicroUsd > 0 ? quote.priceMicroUsd : 400_000,
  };
}

export function assertPassportEligible(status: PassportStatus): void {
  if (status.eligible) return;
  throw new QuoteError(
    status.reason === 'below_threshold'
      ? `Hold at least $${(PASSPORT_USD_CENTS / 100).toFixed(0)} of POKE to enter the Arena.`
      : `Arena eligibility check failed: ${status.reason}.`,
    status.reason === 'ok' ? 'below_threshold' : status.reason,
  );
}
