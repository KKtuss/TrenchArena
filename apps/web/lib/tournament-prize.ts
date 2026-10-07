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
