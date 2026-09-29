import iconIndex from './showdown-icon-index.json';

const icons = iconIndex as Record<string, number>;

export const SHOWDOWN_SPRITES = '/showdown/sprites';
export const SHOWDOWN_SPRITE_CDN = 'https://play.pokemonshowdown.com';

export function speciesId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Filename used by Showdown gen5 sheets. Spaces collapse; formes keep a hyphen. */
export function fullSpriteId(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.includes('-')) {
    return trimmed.toLowerCase().replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-');
  }
  return speciesId(trimmed);
}

export function applyShowdownSpriteCdn(dex?: {
  resourcePrefix?: string;
  fxPrefix?: string;
  loadedSpriteData?: { xy?: number; bw?: number };
}): void {
  if (!dex) return;
  dex.resourcePrefix = `${SHOWDOWN_SPRITE_CDN}/`;
  dex.fxPrefix = `${SHOWDOWN_SPRITE_CDN}/fx/`;
  if (dex.loadedSpriteData) {
    dex.loadedSpriteData.xy = 1;
    dex.loadedSpriteData.bw = 1;
  }
}

export function pokemonIconOffset(name: string, dexNum?: number | null): { left: number; top: number } {
  const indexed = icons[speciesId(name)];
  const num = indexed ?? (typeof dexNum === 'number' && dexNum >= 0 ? dexNum : 0);
  return {
    left: (num % 12) * 40,
    top: Math.floor(num / 12) * 30,
  };
}

export function typeIconSrc(type: string): string {
  const label = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
  return `${SHOWDOWN_SPRITES}/types/${label}.png`;
}
