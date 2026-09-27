/**
 * Integer POKE amounts. The application uses `Number.isInteger` values.
 * PostgreSQL BIGINT arrives from `pg` as a string. All conversions must pass
 * through this module so a non-integer or unsafe magnitude cannot become a
 * silent rounded balance.
 *
 * Safety: every current protocol amount is a JS integer (demo 10_000_000,
 * default entry 50_000, casual collateral positive integers). Number is safe
 * iff the value is a `Number.isSafeInteger` in `[0, Number.MAX_SAFE_INTEGER]`.
 */
export const MAX_SAFE_POKE = Number.MAX_SAFE_INTEGER;

export class InvalidPokeAmountError extends Error {
  constructor(message = 'Invalid POKE amount.') {
    super(message);
    this.name = 'InvalidPokeAmountError';
  }
}

export function pokeToPg(value: number): string {
  assertSafePoke(value);
  return String(value);
}

export function pokeFromPg(value: unknown): number {
  if (typeof value === 'number') {
    assertSafePoke(value);
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(MAX_SAFE_POKE)) {
      throw new InvalidPokeAmountError('POKE amount exceeds the safe integer range.');
    }
    return Number(value);
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new InvalidPokeAmountError('POKE amount is not an integer.');
    }
    let parsed: bigint;
    try {
      parsed = BigInt(value);
    } catch {
      throw new InvalidPokeAmountError('POKE amount is not an integer.');
    }
    if (parsed > BigInt(MAX_SAFE_POKE)) {
      throw new InvalidPokeAmountError('POKE amount exceeds the safe integer range.');
    }
    return Number(parsed);
  }
  throw new InvalidPokeAmountError('POKE amount is missing.');
}

export function assertSafePoke(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidPokeAmountError();
  }
}
