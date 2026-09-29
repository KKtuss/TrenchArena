export const DEFAULT_BIND_HOST = '127.0.0.1';
export const DEFAULT_MAX_CONNECTIONS = 512;
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 16;
/** Cap above team paste framing and the Gen 9 OU species catalog (~46 KB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 96_000;
export const DEFAULT_CHALLENGE_CLEANUP_MS = 15_000;
export const DEFAULT_AUTH_ORIGIN = 'http://127.0.0.1';

export type OriginMode = 'development' | 'strict';

export interface NetworkPolicy {
  bindHost: string;
  originMode: OriginMode;
  allowedOrigins: string[];
  allowMissingOrigin: boolean;
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxPayloadBytes: number;
  trustProxy: boolean;
  authOrigin: string;
  challengeTtlMs: number;
  challengeCleanupMs: number;
}

export function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw?.trim()) return [];
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

export function parseOriginHeader(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (value !== url.origin) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isLocalDevelopmentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

export function resolveOriginMode(override?: OriginMode): OriginMode {
  if (override) return override;
  const raw = process.env.POKEARENA_ORIGIN_MODE?.trim().toLowerCase();
  if (raw === 'strict' || raw === 'development') return raw;
  if (envList('POKEARENA_ALLOWED_ORIGINS').length > 0) return 'strict';
  return process.env.NODE_ENV === 'production' ? 'strict' : 'development';
}

export function resolveBindHost(override?: string): string {
  const host = override ?? process.env.POKEARENA_BIND_HOST?.trim() ?? DEFAULT_BIND_HOST;
  if (!host) return DEFAULT_BIND_HOST;
  return host;
}

export function resolveNetworkPolicy(overrides: Partial<NetworkPolicy> = {}): NetworkPolicy {
  const originMode = resolveOriginMode(overrides.originMode);
  const allowedOrigins = (overrides.allowedOrigins ?? envList('POKEARENA_ALLOWED_ORIGINS'))
    .map(origin => parseOriginHeader(origin))
    .filter((origin): origin is string => Boolean(origin));
  const allowMissingOrigin = overrides.allowMissingOrigin
    ?? (originMode === 'development');
  const authOrigin = parseOriginHeader(overrides.authOrigin)
    ?? parseOriginHeader(process.env.POKEARENA_AUTH_ORIGIN)
    ?? allowedOrigins[0]
    ?? DEFAULT_AUTH_ORIGIN;

  return {
    bindHost: resolveBindHost(overrides.bindHost),
    originMode,
    allowedOrigins,
    allowMissingOrigin,
    maxConnections: overrides.maxConnections ?? envInt('POKEARENA_MAX_WS_CONNECTIONS', DEFAULT_MAX_CONNECTIONS),
    maxConnectionsPerIp: overrides.maxConnectionsPerIp
      ?? envInt('POKEARENA_MAX_WS_CONNECTIONS_PER_IP', DEFAULT_MAX_CONNECTIONS_PER_IP),
    maxPayloadBytes: overrides.maxPayloadBytes ?? envInt('POKEARENA_MAX_WS_PAYLOAD', DEFAULT_MAX_PAYLOAD_BYTES),
    trustProxy: overrides.trustProxy ?? envFlag('POKEARENA_TRUST_PROXY'),
    authOrigin,
    challengeTtlMs: overrides.challengeTtlMs ?? envInt('POKEARENA_AUTH_CHALLENGE_TTL_MS', 5 * 60_000),
    challengeCleanupMs: overrides.challengeCleanupMs
      ?? envInt('POKEARENA_AUTH_CHALLENGE_CLEANUP_MS', DEFAULT_CHALLENGE_CLEANUP_MS),
  };
}

export function clientIp(request: {
  headers: { [key: string]: string | string[] | undefined };
  socket: { remoteAddress?: string };
}, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(',')[0]?.trim();
    if (first) return first;
    const realIp = request.headers['x-real-ip'];
    const real = Array.isArray(realIp) ? realIp[0] : realIp;
    if (real?.trim()) return real.trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

export type UpgradeDecision =
  | { ok: true; origin: string | null; ip: string }
  | { ok: false; status: number; reason: 'origin' | 'limit' | 'per-ip' };

export function authorizeOrigin(
  header: string | undefined,
  policy: Pick<NetworkPolicy, 'originMode' | 'allowedOrigins' | 'allowMissingOrigin'>,
): { ok: true; origin: string | null } | { ok: false } {
  if (!header) {
    return policy.allowMissingOrigin ? { ok: true, origin: null } : { ok: false };
  }
  const origin = parseOriginHeader(header);
  if (!origin) return { ok: false };
  if (policy.allowedOrigins.includes(origin)) return { ok: true, origin };
  if (policy.originMode === 'development' && isLocalDevelopmentOrigin(origin)) {
    return { ok: true, origin };
  }
  return { ok: false };
}

export function rejectUpgrade(socket: { write: (chunk: string) => void; destroy: () => void }, status: number): void {
  const reason = status === 429 ? 'Too Many Requests' : 'Forbidden';
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    // The TCP socket may already be gone.
  }
  socket.destroy();
}
