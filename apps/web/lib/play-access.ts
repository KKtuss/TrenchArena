import type { PassportSnapshot } from './protocol';

export type CasualPlayAccess = {
  ok: boolean;
  reason: string | null;
};

/** Wallet + passport gate for creating or joining a casual challenge. */
export function casualChallengeAccess(input: {
  walletConnected: boolean;
  chainEconomyEnabled: boolean;
  passport?: PassportSnapshot | null;
}): CasualPlayAccess {
  if (!input.walletConnected) {
    return { ok: false, reason: 'No wallet connected' };
  }
  if (input.chainEconomyEnabled && input.passport?.eligible !== true) {
    return { ok: false, reason: 'Not holding required amount of $POKE' };
  }
  return { ok: true, reason: null };
}
