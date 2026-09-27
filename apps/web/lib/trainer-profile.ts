import catalog from './trainer-sprites.json';

export type TrainerSpriteEntry = {
  id: string;
  file: string;
  name: string;
  credit: string | null;
  source: string;
};

export const TRAINER_SPRITES = catalog as TrainerSpriteEntry[];
export const DEFAULT_TRAINER_SPRITE_ID = 'blue-gen3';
export const TRAINER_SPRITE_BASE = '/showdown/sprites/trainers';

const byId = new Map(TRAINER_SPRITES.map(entry => [entry.id, entry]));

export function getTrainerSprite(id: string | null | undefined): TrainerSpriteEntry {
  if (id && byId.has(id)) return byId.get(id)!;
  return byId.get(DEFAULT_TRAINER_SPRITE_ID)
    ?? byId.get('unknown')
    ?? {
      id: 'unknown',
      file: 'unknown.png',
      name: 'Unknown',
      credit: null,
      source: `${TRAINER_SPRITE_BASE}/unknown.png`,
    };
}

export function trainerSpriteSrc(id: string | null | undefined): string {
  const entry = getTrainerSprite(id);
  return `${TRAINER_SPRITE_BASE}/${entry.file}`;
}

export function normalizeWalletAddress(address: string): string {
  return address.trim();
}

export function trainerProfileStorageKey(walletAddress: string): string {
  return `pokearena.trainer.${normalizeWalletAddress(walletAddress)}`;
}

export type TrainerProfile = {
  username: string;
  spriteId: string;
};

export function isTrainerUsername(value: string): boolean {
  const name = value.trim();
  return name.length >= 2 && name.length <= 16 && /^[A-Za-z0-9 _-]+$/.test(name);
}

export function parseStoredTrainerProfile(raw: string | null): TrainerProfile | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { username?: unknown; spriteId?: unknown };
    if (typeof parsed.spriteId === 'string') {
      return {
        username: typeof parsed.username === 'string' ? parsed.username.trim() : '',
        spriteId: parsed.spriteId,
      };
    }
  } catch {
    // Older profiles stored only the sprite id.
  }
  const spriteId = raw.trim();
  if (!spriteId || spriteId.startsWith('{')) return null;
  return { username: '', spriteId };
}

export function readTrainerProfile(walletAddress: string): TrainerProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseStoredTrainerProfile(window.localStorage.getItem(trainerProfileStorageKey(walletAddress)));
  } catch {
    return null;
  }
}

export function writeTrainerProfile(walletAddress: string, profile: TrainerProfile): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(trainerProfileStorageKey(walletAddress), JSON.stringify({
    username: profile.username.trim(),
    spriteId: profile.spriteId,
  }));
}

export function searchTrainerSprites(query: string, limit = 120): TrainerSpriteEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return TRAINER_SPRITES.slice(0, limit);
  const scored: { entry: TrainerSpriteEntry; score: number }[] = [];
  for (const entry of TRAINER_SPRITES) {
    const hay = `${entry.id} ${entry.name} ${entry.credit ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) continue;
    let score = 0;
    if (entry.id === needle) score = 100;
    else if (entry.id.startsWith(needle)) score = 80;
    else if (entry.name.toLowerCase().startsWith(needle)) score = 70;
    else if (entry.id.includes(needle)) score = 50;
    else score = 20;
    scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map(item => item.entry);
}

export function shortenAddress(address: string, size = 4): string {
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}
