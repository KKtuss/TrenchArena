'use client';

import { useState } from 'react';

import { PokemonIcon } from '@/components/showdown-visuals';
import { SHOWDOWN_SPRITE_CDN, fullSpriteId } from '@/lib/showdown-visuals';
import { TRAINER_SPRITE_BASE } from '@/lib/trainer-profile';

const GEN1_SPRITE = '/showdown/sprites/gen1';
const LOCAL_GEN1 = new Set([
  'charizard', 'venusaur', 'blastoise', 'pikachu', 'mewtwo', 'gengar', 'snorlax',
  'gyarados', 'mew', 'moltres', 'dragonite', 'alakazam', 'zapdos', 'eevee', 'articuno',
]);

function pokemonSrc(name: string): string | null {
  const file = fullSpriteId(name);
  if (!file) return null;
  if (LOCAL_GEN1.has(file)) return `${GEN1_SPRITE}/${file}.png`;
  return `${SHOWDOWN_SPRITE_CDN}/sprites/gen5/${file}.png`;
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
            src={`${TRAINER_SPRITE_BASE}/${trainer}.png`}
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
          src={`${GEN1_SPRITE}/charizard.png`}
          alt=""
          title="Charizard"
        />
        <img
          className="pa-gen1-flank is-near"
          src={`${GEN1_SPRITE}/venusaur.png`}
          alt=""
          title="Venusaur"
        />
        <div className="pa-gen1-center">
          <img
            className="pa-gen1-hero pa-gen1-red"
            src={`${TRAINER_SPRITE_BASE}/red-gen1.png`}
            alt=""
          />
          <img
            className="pa-gen1-hero pa-gen1-pikachu"
            src={`${GEN1_SPRITE}/pikachu.png`}
            alt=""
            title="Pikachu"
          />
        </div>
        <img
          className="pa-gen1-flank is-near"
          src={`${GEN1_SPRITE}/blastoise.png`}
          alt=""
          title="Blastoise"
        />
        <img
          className="pa-gen1-flank is-far pa-gen1-mewtwo"
          src={`${GEN1_SPRITE}/mewtwo.png`}
          alt=""
          title="Mewtwo"
        />
      </div>
    </div>
  );
}
