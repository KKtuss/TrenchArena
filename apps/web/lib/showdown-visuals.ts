import iconIndex from './showdown-icon-index.json';
import itemIcons from './showdown-item-icons.json';

const icons = iconIndex as Record<string, number>;

export const SHOWDOWN_SPRITES = '/showdown/sprites';
export const SHOWDOWN_SPRITE_CDN = 'https://play.pokemonshowdown.com';

export function speciesId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Bases whose own name contains a hyphen. That hyphen is not a forme split
 * (Ho-Oh, Jangmo-o, Wo-Chien), unlike Rotom-Wash or Tauros-Paldea-Aqua.
 * Longer names come first so "Pokestar F-002" is not read as "Pokestar F-00".
 */
const HYPHENATED_BASES = [
  'pokestar brycen-man',
  'pokestar f-002',
  'pokestar f-00',
  'nidoran-f',
  'nidoran-m',
  'porygon-z',
  'jangmo-o',
  'hakamo-o',
  'kommo-o',
  'wo-chien',
  'chien-pao',
  'ting-lu',
  'chi-yu',
  'ho-oh',
].sort((left, right) => right.length - left.length);

/**
 * Filename used by Showdown gen5 sheets.
 * `toID(base)` plus, for a forme, `-${toID(forme)}`. Hyphens inside either
 * part are removed, so Tauros-Paldea-Aqua is `tauros-paldeaaqua`.
 */
export function fullSpriteId(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const base = HYPHENATED_BASES.find(candidate => (
    lower === candidate || lower.startsWith(`${candidate}-`)
  ));
  let spriteid: string;
  if (base) {
    const forme = lower.slice(base.length).replace(/^-/, '');
    spriteid = forme ? `${speciesId(base)}-${speciesId(forme)}` : speciesId(base);
  } else {
    const dash = lower.indexOf('-');
    spriteid = dash === -1
      ? speciesId(trimmed)
      : `${speciesId(lower.slice(0, dash))}-${speciesId(lower.slice(dash + 1))}`;
  }
  // Totem and Rockruff-Dusk reuse the base sheet. Greninja-Bond's sheet is Ash-Greninja.
  if (spriteid.endsWith('totem')) spriteid = spriteid.slice(0, -5);
  if (spriteid === 'greninja-bond') spriteid = 'greninja-ash';
  if (spriteid === 'rockruff-dusk') spriteid = 'rockruff';
  if (spriteid.endsWith('-')) spriteid = spriteid.slice(0, -1);
  return spriteid || null;
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

const itemSpriteNums = itemIcons as Record<string, number>;

/** Showdown item-icon sheet cell. Null when the item has no sprite. */
export function itemIconOffset(name: string): { left: number; top: number } | null {
  const num = itemSpriteNums[speciesId(name)];
  if (!num) return null;
  return { left: (num % 16) * 24, top: Math.floor(num / 16) * 24 };
}

export function typeIconSrc(type: string): string {
  const label = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
  return `${SHOWDOWN_SPRITES}/types/${label}.png`;
}
