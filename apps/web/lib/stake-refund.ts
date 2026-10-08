import { formatPoke, formatSolLamports } from './api-client';
import type { CasualRoom } from './protocol';

const STARTED = new Set(['starting', 'battling', 'completed']);

export function stakeRefundNotice(
  previous: CasualRoom | undefined,
  next: CasualRoom,
  playerId: string | null,
): string | null {
  if (!playerId || !previous) return null;
  if (next.id !== previous.id || next.status !== 'cancelled' || previous.status === 'cancelled') return null;
  if (STARTED.has(previous.status)) return null;
  const refunded = previous.creatorId === playerId
    ? previous.rail !== 'sol_chain' || Boolean(previous.deposits?.creator)
    : previous.opponentId === playerId
      ? previous.rail !== 'sol_chain' || Boolean(previous.deposits?.opponent)
      : false;
  if (!refunded) return null;
  const amount = previous.rail === 'sol_chain'
    ? formatSolLamports(previous.economics.collateral)
    : formatPoke(previous.economics.collateral);
  return `Your ${amount} stake has been refunded.`;
}
