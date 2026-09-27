import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const AUTH_NONCE_TTL_MS = 5 * 60_000;
export const AUTH_DOMAIN = 'PokeArena';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface AuthChallenge {
  address: string;
  nonce: string;
  message: string;
  expiresAt: number;
  origin: string;
}

export function decodeBase58(value: string): Uint8Array {
  if (!value) throw new Error('Empty base58 value.');
  let zeros = 0;
  while (zeros < value.length && value[zeros] === '1') zeros += 1;

  const size = Math.ceil(value.length * 0.733); // log(58)/log(256)
  const bytes = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < value.length; i += 1) {
    const carryIndex = BASE58_ALPHABET.indexOf(value[i]!);
    if (carryIndex < 0) throw new Error('Invalid base58 character.');
    let carry = carryIndex;
    let j = 0;
    for (let k = size - 1; k >= 0 && (carry !== 0 || j < length); k -= 1, j += 1) {
      carry += 58 * bytes[k]!;
      bytes[k] = carry & 0xff;
      carry >>= 8;
    }
    length = j;
  }

  const start = size - length;
  const result = new Uint8Array(zeros + length);
  result.set(bytes.subarray(start), zeros);
  return result;
}

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  const size = Math.ceil(bytes.length * 1.37);
  const digits = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    let j = 0;
    for (let k = size - 1; k >= 0 && (carry !== 0 || j < length); k -= 1, j += 1) {
      carry += 256 * digits[k]!;
      digits[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }

  let start = size - length;
  while (start < size && digits[start] === 0) start += 1;
  let result = '1'.repeat(zeros);
  for (let i = start; i < size; i += 1) result += BASE58_ALPHABET[digits[i]!]!;
  return result;
}

export function isSolanaAddress(value: string): boolean {
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

export function isDemoPlayerId(value: string): boolean {
  return /^demo-player-[12]$/.test(value);
}

/**
 * Demo identify is off unless POKEARENA_ALLOW_DEMO_AUTH is explicitly true.
 * Unset, empty, and every other value stay off.
 */
export function isDemoAuthEnabled(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  const raw = process.env.POKEARENA_ALLOW_DEMO_AUTH;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export class DemoAuthDisabledError extends Error {
  constructor() {
    super('Demo authentication is disabled.');
    this.name = 'DemoAuthDisabledError';
  }
}

export function isPlayerId(value: string): boolean {
  return isDemoPlayerId(value) || isSolanaAddress(value);
}

export function buildAuthMessage(
  address: string,
  nonce: string,
  issuedAt: number,
  origin: string,
): string {
  return [
    `${AUTH_DOMAIN} login`,
    `URI: ${origin}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
  ].join('\n');
}

export function createAuthChallenge(
  address: string,
  now = Date.now(),
  origin = 'http://127.0.0.1',
  ttlMs = AUTH_NONCE_TTL_MS,
): AuthChallenge {
  if (!isSolanaAddress(address)) {
    throw new Error('wallet address must be a valid Solana base58 public key.');
  }
  const nonce = randomBytes(16).toString('hex');
  const message = buildAuthMessage(address, nonce, now, origin);
  return {
    address,
    nonce,
    message,
    expiresAt: now + ttlMs,
    origin,
  };
}

export function decodeSignature(signature: string): Uint8Array {
  const trimmed = signature.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === 128) {
    return Uint8Array.from(Buffer.from(trimmed, 'hex'));
  }
  try {
    const asBase58 = decodeBase58(trimmed);
    if (asBase58.length === 64) return asBase58;
  } catch {
    // fall through to base64
  }
  return Uint8Array.from(Buffer.from(trimmed, 'base64'));
}

/** Ed25519 SubjectPublicKeyInfo prefix for a raw 32-byte public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifySolanaSignature(input: {
  address: string;
  message: string;
  signature: string;
}): boolean {
  if (!isSolanaAddress(input.address)) return false;
  try {
    const publicKeyRaw = Buffer.from(decodeBase58(input.address));
    const signature = Buffer.from(decodeSignature(input.signature));
    if (publicKeyRaw.length !== 32 || signature.length !== 64) return false;
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(input.message, 'utf8'), keyObject, signature);
  } catch {
    return false;
  }
}

export function challengeFingerprint(challenge: AuthChallenge): string {
  return createHash('sha256')
    .update(`${challenge.address}|${challenge.nonce}|${challenge.message}|${challenge.expiresAt}`)
    .digest('hex');
}
