/** Fixed-point scale for USD prices. 18 digits keeps sub-micro-dollar SPL prices. */
export const USD_PRICE_SCALE = 18;

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Normalize a non-negative decimal (optional scientific exponent) to plain digits.
 * Returns null when the text is not a usable decimal. Zero stays "0".
 */
export function canonicalizeDecimal(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 80) return null;
  const match = DECIMAL_PATTERN.exec(trimmed);
  if (!match) return null;
  const whole = match[1]!;
  const frac = match[2] ?? '';
  const exp = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isInteger(exp) || Math.abs(exp) > 80) return null;

  const digits = `${whole}${frac}`;
  const point = whole.length + exp;
  let normalized: string;
  if (point <= 0) {
    normalized = `0.${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    normalized = `${digits}${'0'.repeat(point - digits.length)}`;
  } else {
    normalized = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }

  const [wholePart = '0', fracPart] = normalized.split('.');
  const wholeOut = wholePart.replace(/^0+(?=\d)/, '') || '0';
  if (fracPart === undefined) return wholeOut;
  const fracOut = fracPart.replace(/0+$/, '');
  if (!fracOut) return wholeOut;
  return `${wholeOut}.${fracOut}`;
}

/** Floor a decimal into `scale` digits after the point. Zero returns 0n. Null if unusable. */
export function decimalToScaled(input: string, scale: number): bigint | null {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36) return null;
  const canonical = canonicalizeDecimal(input);
  if (!canonical || canonical === '0') return canonical === '0' ? 0n : null;
  const [whole = '0', frac = ''] = canonical.split('.');
  const fracDigits = frac.slice(0, scale).padEnd(scale, '0');
  try {
    return BigInt(`${whole}${fracDigits}`);
  } catch {
    return null;
  }
}

export function formatScaled(value: bigint, scale: number): string {
  if (value < 0n) throw new Error('Scaled USD value cannot be negative.');
  if (!Number.isInteger(scale) || scale < 0) throw new Error('Invalid decimal scale.');
  if (scale === 0) return value.toString();
  const base = 10n ** BigInt(scale);
  const whole = value / base;
  const frac = (value % base).toString().padStart(scale, '0').replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

/**
 * Human token amount from raw base units. Exact decimal string; the raw amount is never
 * converted through a JavaScript number.
 */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  if (raw < 0n) throw new Error('Token amount cannot be negative.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Token decimals are invalid.');
  }
  return formatScaled(raw, decimals);
}

/** Floor(raw * price / 10^decimals) at USD_PRICE_SCALE. */
export function usdScaledFromRaw(raw: bigint, priceScaled: bigint, decimals: number): bigint {
  if (raw < 0n || priceScaled < 0n) throw new Error('Token amount and price must be non-negative.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Token decimals are invalid.');
  }
  const scale = 10n ** BigInt(decimals);
  return (raw * priceScaled) / scale;
}

export function numberToDecimalString(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const raw = value.toString();
  if (!/[eE]/.test(raw)) return canonicalizeDecimal(raw);
  return canonicalizeDecimal(raw.toLowerCase());
}
