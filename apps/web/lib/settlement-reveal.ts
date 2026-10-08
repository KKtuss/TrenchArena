/** Keep the battle on screen long enough for the last attack to finish. */
export const SETTLEMENT_REVEAL_MS = 4_500;

export function settlementRevealDelay(input: {
  alreadyFinished: boolean;
  fightEndedAt: number;
  now: number;
}): number {
  if (input.alreadyFinished) return 0;
  return Math.max(0, SETTLEMENT_REVEAL_MS - (input.now - input.fightEndedAt));
}
