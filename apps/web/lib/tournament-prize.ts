import { formatPoke, formatSolLamports } from './api-client';

/** Integer 50/35/15 split. Third receives the remainder so the shares sum to the pool. */
export function splitTournamentPrize(prizePool: number): { first: number; second: number; third: number } {
  if (!Number.isSafeInteger(prizePool) || prizePool < 0) {
    return { first: 0, second: 0, third: 0 };
  }
  const pool = BigInt(prizePool);
  const first = (pool * 50n) / 100n;
  const second = (pool * 35n) / 100n;
  return {
    first: Number(first),
    second: Number(second),
    third: Number(pool - first - second),
  };
}

export type TournamentPrizeView = {
  /** Reserved CARDS or SOL prize. Undefined on legacy POKE cups. */
  chainLabel?: string;
  label: string;
  shares?: { first: number; second: number; third: number };
  formatShare: (amount: number) => string;
};

/** Prize headline and podium shares in the cup's own rail. `prizePool` is the legacy POKE pool. */
export function tournamentPrizeView(
  tournament: { rail?: string; prizeLamports?: number; prizeCardsRaw?: number } | null | undefined,
  prizePool: number,
): TournamentPrizeView {
  const cardsRaw = tournament?.prizeCardsRaw;
  const solChain = tournament?.rail === 'sol_chain';
  const chainLabel = cardsRaw !== undefined
    ? `${cardsRaw.toLocaleString('en-US')} CARDS`
    : solChain && tournament?.prizeLamports !== undefined
      ? formatSolLamports(tournament.prizeLamports)
      : undefined;
  const sharePool = cardsRaw ?? (solChain ? tournament?.prizeLamports : prizePool);
  const shares = sharePool !== undefined && Number.isSafeInteger(sharePool)
    ? splitTournamentPrize(sharePool)
    : undefined;
  const formatShare = (amount: number) => (
    cardsRaw !== undefined
      ? `${amount.toLocaleString('en-US')} CARDS`
      : solChain
        ? formatSolLamports(amount)
        : formatPoke(amount)
  );
  return { chainLabel, label: chainLabel ?? formatPoke(prizePool), shares, formatShare };
}

export type TournamentPayoutView = {
  /** What the champion was paid. */
  amount: number;
  label: string;
  format: (amount: number) => string;
  /** Per-place amounts, only when the settlement paid a CARDS podium. */
  places?: { first: string; second: string; third: string };
};

/**
 * Settled tournament payout in its own unit. Legacy POKE cups pay the whole pool to the
 * champion. Chain cups with a 3rd-place match pay CARDS 50/35/15 and report the pool as
 * `cardsAmountRaw` next to the champion's `amount`.
 */
export function tournamentPayoutView(
  payout: { symbol?: string; amount: number; cardsAmountRaw?: number } | null | undefined,
): TournamentPayoutView | undefined {
  if (!payout) return undefined;
  if (payout.symbol === 'CARDS') {
    const cards = (amount: number) => `${amount.toLocaleString('en-US')} CARDS`;
    const pool = payout.cardsAmountRaw;
    const split = pool !== undefined && Number.isSafeInteger(pool) && pool > payout.amount
      ? splitTournamentPrize(pool)
      : undefined;
    return {
      amount: payout.amount,
      label: cards(payout.amount),
      format: cards,
      places: split && split.first === payout.amount
        ? { first: cards(split.first), second: cards(split.second), third: cards(split.third) }
        : undefined,
    };
  }
  const format = payout.symbol === 'SOL' ? formatSolLamports : formatPoke;
  return { amount: payout.amount, label: format(payout.amount), format };
}
