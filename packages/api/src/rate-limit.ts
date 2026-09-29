export class RateLimitedError extends Error {
  constructor() {
    super('Too many requests. Try again shortly.');
    this.name = 'RateLimitedError';
  }
}

export interface RateLimitConfig {
  windowMs: number;
  authChallenge: number;
  casualCreate: number;
  tournamentCreate: number;
  teamSearch: number;
  teamInspect: number;
  matchChoice: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  windowMs: 60_000,
  authChallenge: 10,
  casualCreate: 20,
  tournamentCreate: 10,
  teamSearch: 180,
  teamInspect: 90,
  matchChoice: 120,
};

function envRate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveRateLimitConfig(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    windowMs: overrides.windowMs ?? envRate('POKEARENA_RATE_WINDOW_MS', DEFAULT_RATE_LIMITS.windowMs),
    authChallenge: overrides.authChallenge ?? envRate('POKEARENA_RATE_AUTH_CHALLENGE', DEFAULT_RATE_LIMITS.authChallenge),
    casualCreate: overrides.casualCreate ?? envRate('POKEARENA_RATE_CASUAL_CREATE', DEFAULT_RATE_LIMITS.casualCreate),
    tournamentCreate: overrides.tournamentCreate
      ?? envRate('POKEARENA_RATE_TOURNAMENT_CREATE', DEFAULT_RATE_LIMITS.tournamentCreate),
    teamSearch: overrides.teamSearch ?? envRate('POKEARENA_RATE_TEAM_SEARCH', DEFAULT_RATE_LIMITS.teamSearch),
    teamInspect: overrides.teamInspect ?? envRate('POKEARENA_RATE_TEAM_INSPECT', DEFAULT_RATE_LIMITS.teamInspect),
    matchChoice: overrides.matchChoice ?? envRate('POKEARENA_RATE_MATCH_CHOICE', DEFAULT_RATE_LIMITS.matchChoice),
  };
}

/**
 * In-memory sliding window. Safe only for a single API process.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const stamps = this.pruneKey(key, now);
    if (stamps.length >= this.max) {
      this.hits.set(key, stamps);
      return false;
    }
    stamps.push(now);
    this.hits.set(key, stamps);
    return true;
  }

  prune(now = Date.now()): number {
    for (const key of [...this.hits.keys()]) {
      const stamps = this.pruneKey(key, now);
      if (stamps.length === 0) this.hits.delete(key);
      else this.hits.set(key, stamps);
    }
    return this.hits.size;
  }

  get size(): number {
    return this.hits.size;
  }

  private pruneKey(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    return (this.hits.get(key) ?? []).filter(stamp => stamp > cutoff);
  }
}

export class ProtocolRateLimiter {
  readonly authChallenge: SlidingWindowLimiter;
  readonly casualCreate: SlidingWindowLimiter;
  readonly tournamentCreate: SlidingWindowLimiter;
  readonly teamSearch: SlidingWindowLimiter;
  readonly teamInspect: SlidingWindowLimiter;
  readonly matchChoice: SlidingWindowLimiter;
  private readonly timer: NodeJS.Timeout;

  constructor(readonly config: RateLimitConfig) {
    this.authChallenge = new SlidingWindowLimiter(config.windowMs, config.authChallenge);
    this.casualCreate = new SlidingWindowLimiter(config.windowMs, config.casualCreate);
    this.tournamentCreate = new SlidingWindowLimiter(config.windowMs, config.tournamentCreate);
    this.teamSearch = new SlidingWindowLimiter(config.windowMs, config.teamSearch);
    this.teamInspect = new SlidingWindowLimiter(config.windowMs, config.teamInspect);
    this.matchChoice = new SlidingWindowLimiter(config.windowMs, config.matchChoice);
    this.timer = setInterval(() => this.prune(), Math.max(config.windowMs, 1_000));
    this.timer.unref?.();
  }

  take(limiter: SlidingWindowLimiter, key: string, now = Date.now()): void {
    if (!limiter.allow(key, now)) throw new RateLimitedError();
  }

  prune(now = Date.now()): void {
    this.authChallenge.prune(now);
    this.casualCreate.prune(now);
    this.tournamentCreate.prune(now);
    this.teamSearch.prune(now);
    this.teamInspect.prune(now);
    this.matchChoice.prune(now);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
