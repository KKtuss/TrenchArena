'use client';

import { TrainerSprite as BaseTrainerSprite } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import { publicTrainerName, publicTrainerSpriteId } from '@/lib/trainer-profile';

/** Renders a trainer sprite from the public directory, falling back to the local profile for you. */
export function ProfileTrainerSprite({
  label,
  side,
  spriteId,
}: {
  label: string;
  side?: 'left' | 'right';
  spriteId?: string | null;
}) {
  const { playerId, trainerSpriteId, trainers } = useArena();
  const resolved = spriteId
    ?? publicTrainerSpriteId(label, trainers, { id: playerId, spriteId: trainerSpriteId });
  return <BaseTrainerSprite label={label} side={side} spriteId={resolved} />;
}

export function TrainerName({
  playerId,
  fallback = 'Waiting',
  overlayName,
}: {
  playerId?: string | null;
  fallback?: string;
  overlayName?: string | null;
}) {
  const { playerId: selfId, trainerUsername, trainers } = useArena();
  if (!playerId) return fallback;
  return publicTrainerName(playerId, trainers, { id: selfId, username: trainerUsername }, overlayName);
}
