import {
  SHOWDOWN_SPRITE_CDN,
  itemIconOffset,
  pokemonIconOffset,
  showdownSpriteSrc,
  typeIconSrc,
} from '@/lib/showdown-visuals';
import { getTrainerSprite, trainerSpriteSrc } from '@/lib/trainer-profile';

import './showdown-visuals.css';

export function PokemonIcon({
  name,
  dexNum,
}: {
  name: string;
  dexNum?: number | null;
}) {
  const offset = pokemonIconOffset(name, dexNum);
  return (
    <span
      className="ps-icon"
      role="img"
      aria-label={name || 'Empty slot'}
      style={{ backgroundPosition: `-${offset.left}px -${offset.top}px` }}
    />
  );
}

export function PokemonSprite({
  name,
  dexNum,
  framed = false,
}: {
  name: string;
  dexNum?: number | null;
  framed?: boolean;
}) {
  const spriteSrc = showdownSpriteSrc(name);
  const sprite = spriteSrc ? (
    <img
      className="ps-sprite"
      src={spriteSrc}
      alt={name}
      loading="lazy"
      decoding="async"
    />
  ) : (
    <PokemonIcon name={name} dexNum={dexNum} />
  );
  if (!framed) return sprite;
  return (
    <span className="ps-sprite-frame" role="img" aria-label={name || 'Empty slot'}>
      {sprite}
    </span>
  );
}

export function TrainerSprite({
  label,
  side,
  spriteId,
}: {
  label: string;
  side?: 'left' | 'right';
  spriteId?: string | null;
}) {
  const fallback = side === 'left' ? 'blue-gen3' : side === 'right' ? 'red-gen3' : 'unknown';
  const trainer = getTrainerSprite(spriteId ?? fallback);
  const fallbackSrc = trainerSpriteSrc(fallback);
  return (
    <img
      className="ps-trainer-img"
      src={trainerSpriteSrc(trainer.id)}
      alt={label}
      onError={event => {
        if (event.currentTarget.dataset.fallback === 'true') return;
        event.currentTarget.dataset.fallback = 'true';
        event.currentTarget.src = fallbackSrc;
      }}
    />
  );
}

export function ItemIcon({ name }: { name: string }) {
  const offset = itemIconOffset(name);
  if (!offset) return null;
  return (
    <span
      className="ps-item"
      role="img"
      aria-hidden
      style={{
        backgroundImage: `url(${SHOWDOWN_SPRITE_CDN}/sprites/itemicons-sheet.png)`,
        backgroundPosition: `-${offset.left}px -${offset.top}px`,
      }}
    />
  );
}

export function TypeMark({ type }: { type: string }) {
  const normalized = type.trim();
  if (!normalized) return null;
  return <img className="ps-type" src={typeIconSrc(normalized)} alt="" />;
}

export function TeamStrip({
  species,
  fainted,
  slots = 6,
  concealed = false,
}: {
  species?: readonly string[];
  fainted?: readonly boolean[];
  slots?: number;
  concealed?: boolean;
}) {
  const filled = concealed ? [] : (species ?? []).filter(Boolean).slice(0, slots);
  return (
    <span className={`ps-team${concealed ? ' is-concealed' : ''}`} aria-label={concealed ? 'Hidden team' : undefined}>
      {Array.from({ length: slots }, (_, index) => {
        const name = filled[index];
        const isFainted = Boolean(fainted?.[index]);
        return name
          ? (
            <span
              key={`${name}-${index}`}
              className={isFainted ? 'ps-icon-wrap fainted' : 'ps-icon-wrap'}
              title={isFainted ? `${name} (fainted)` : name}
            >
              <PokemonIcon name={name} />
            </span>
          )
          : <span key={`empty-${index}`} className="ps-icon ps-icon-empty" aria-hidden />;
      })}
    </span>
  );
}
