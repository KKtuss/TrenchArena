import iconIndex from './showdown-icon-index.json';

const icons = iconIndex as Record<string, number>;

/** Gen 5 front sprites that the local Showdown manifest actually ships. */
const FULL_SPRITES = new Set([
  'clodsire',
  'corviknight',
  'dragapult',
  'dragonite',
  'gholdengo',
  'greattusk',
  'heatran',
  'ironvaliant',
  'kingambit',
  'meowscarada',
  'rotom-wash',
  'samurott-hisui',
]);

export const SHOWDOWN_SPRITES = '/showdown/sprites';

export function speciesId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Filename used by the vendored gen5 sheets. Hyphenated formes keep the hyphen. */
export function fullSpriteId(name: string): string | null {
  const hyphen = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const compact = speciesId(name);
  if (FULL_SPRITES.has(hyphen)) return hyphen;
  if (FULL_SPRITES.has(compact)) return compact;
  return null;
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
