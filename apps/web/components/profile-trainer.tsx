'use client';

import { TrainerSprite as BaseTrainerSprite } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';

/** Renders a trainer sprite, using the connected wallet profile when the label is you. */
export function ProfileTrainerSprite({
  label,
  side,
  spriteId,
}: {
  label: string;
  side?: 'left' | 'right';
  spriteId?: string | null;
}) {
  const { playerId, trainerSpriteId } = useArena();
  const resolved = spriteId
    ?? (playerId && label === playerId ? trainerSpriteId : null);
  return <BaseTrainerSprite label={label} side={side} spriteId={resolved} />;
}
