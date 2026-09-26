import {
  SHOWDOWN_SPRITES,
  fullSpriteId,
  pokemonIconOffset,
  typeIconSrc,
} from '@/lib/showdown-visuals';

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
  const file = fullSpriteId(name);
  const sprite = file ? (
    <img
      className="ps-sprite"
      src={`${SHOWDOWN_SPRITES}/gen5/${file}.png`}
      alt={name}
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
}: {
  label: string;
  side?: 'left' | 'right';
}) {
  const trainer = side === 'left' ? 'blue-gen3' : side === 'right' ? 'red-gen3' : 'unknown';
  return (
    <img
      className="ps-trainer-img"
      src={`${SHOWDOWN_SPRITES}/trainers/${trainer}.png`}
      alt={label}
    />
  );
}

export function TypeMark({ type }: { type: string }) {
  return (
    <img className="ps-type" src={typeIconSrc(type)} alt="" />
  );
}

export function TeamStrip({
  species,
  fainted,
  slots = 6,
}: {
  species?: readonly string[];
  fainted?: readonly boolean[];
  slots?: number;
}) {
  const filled = (species ?? []).filter(Boolean).slice(0, slots);
  return (
    <span className="ps-team">
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
