'use client';

import { TRAINER_SPRITE_BASE } from '@/lib/trainer-profile';

const GEN1_SPRITE = '/showdown/sprites/gen1';

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
