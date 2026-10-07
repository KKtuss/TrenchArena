'use client';

import { useState } from 'react';

import { PokemonIcon } from '@/components/showdown-visuals';
import { SHOWDOWN_SPRITE_CDN, showdownSpriteSrc } from '@/lib/showdown-visuals';

function pokemonSrc(name: string): string | null {
  return showdownSpriteSrc(name);
}

function trainerSrc(id: string): string {
  return `${SHOWDOWN_SPRITE_CDN}/sprites/trainers/${id}.png`;
}

function StageMon({
  name,
  className,
}: {
  name: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = pokemonSrc(name);
  if (!src || failed) {
    return (
      <span className={className} title={name}>
        <PokemonIcon name={name} />
      </span>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt=""
      title={name}
      onError={() => setFailed(true)}
    />
  );
}

export function FormatStage({
  trainer,
  pokemon,
  compact = false,
}: {
  trainer: string;
  pokemon: readonly string[];
  compact?: boolean;
}) {
  const [leftFar, leftNear, rightNear, rightFar] = pokemon;
  return (
    <div className={`pa-gen1-stage${compact ? ' is-compact' : ''}`} aria-hidden>
      <div className="pa-gen1-floor" />
      <div className="pa-gen1-scene">
        {leftFar ? <StageMon name={leftFar} className="pa-gen1-flank is-far" /> : null}
        {leftNear ? <StageMon name={leftNear} className="pa-gen1-flank is-near" /> : null}
        <div className="pa-gen1-center">
          <img
            className="pa-gen1-hero pa-gen1-red"
            src={trainerSrc(trainer)}
            alt=""
          />
        </div>
        {rightNear ? <StageMon name={rightNear} className="pa-gen1-flank is-near" /> : null}
        {rightFar ? <StageMon name={rightFar} className="pa-gen1-flank is-far" /> : null}
      </div>
    </div>
  );
}

/**
 * Scene (left → right): Charizard · Venusaur · Red+Pikachu · Blastoise · Mewtwo
 * Red + Pikachu stay as the duo centerpiece.
 */
export function Gen1CupArt({
  compact = false,
}: {
  compact?: boolean;
}) {
  return (
    <div className={`pa-gen1-stage${compact ? ' is-compact' : ''}`} aria-hidden>
      <div className="pa-gen1-floor" />
      <div className="pa-gen1-scene">
        <img
          className="pa-gen1-flank is-far"
          src={pokemonSrc('Charizard') ?? ''}
          alt=""
          title="Charizard"
        />
        <img
          className="pa-gen1-flank is-near"
          src={pokemonSrc('Venusaur') ?? ''}
          alt=""
          title="Venusaur"
        />
        <div className="pa-gen1-center">
          <img
            className="pa-gen1-hero pa-gen1-red"
            src={trainerSrc('red-gen1')}
            alt=""
          />
          <img
            className="pa-gen1-hero pa-gen1-pikachu"
            src={pokemonSrc('Pikachu') ?? ''}
            alt=""
            title="Pikachu"
          />
        </div>
        <img
          className="pa-gen1-flank is-near"
          src={pokemonSrc('Blastoise') ?? ''}
          alt=""
          title="Blastoise"
        />
        <img
          className="pa-gen1-flank is-far pa-gen1-mewtwo"
          src={pokemonSrc('Mewtwo') ?? ''}
          alt=""
          title="Mewtwo"
        />
      </div>
    </div>
  );
}
