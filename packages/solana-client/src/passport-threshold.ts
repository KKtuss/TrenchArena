/**
 * The only passport threshold. Eligibility converts this USD amount through
 * the live quote. Do not copy the amount into other modules.
 */
export const POKEARENA_PASSPORT_MIN_USD = '5.00';

function usdToCents(value: string): number {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error('POKEARENA_PASSPORT_MIN_USD must be a positive USD amount with 2 decimals.');
  }
  return Number(match[1]) * 100 + Number(match[2]);
}

/** Derived from POKEARENA_PASSPORT_MIN_USD. Not a second configuration. */
export const PASSPORT_USD_CENTS = usdToCents(POKEARENA_PASSPORT_MIN_USD);
