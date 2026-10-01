import { createHash } from 'node:crypto';

/** Anchor global instruction discriminator: sha256("global:<name>")[0..8]. */
export function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

export const IX = {
  initializeConfig: anchorDiscriminator('initialize_config'),
  createMatchEscrow: anchorDiscriminator('create_match_escrow'),
  depositSolWager: anchorDiscriminator('deposit_sol_wager'),
  seatMatchOpponent: anchorDiscriminator('seat_match_opponent'),
  refundSolWager: anchorDiscriminator('refund_sol_wager'),
  chargeMatchFee: anchorDiscriminator('charge_match_fee'),
  settleMatchWin: anchorDiscriminator('settle_match_win'),
  settleMatchTie: anchorDiscriminator('settle_match_tie'),
  depositPokeEntry: anchorDiscriminator('deposit_poke_entry'),
  refundPokeEntry: anchorDiscriminator('refund_poke_entry'),
  burnPokeEntry: anchorDiscriminator('burn_poke_entry'),
  depositTreasurySol: anchorDiscriminator('deposit_treasury_sol'),
  reservePrize: anchorDiscriminator('reserve_prize'),
  setPrizeWinner: anchorDiscriminator('set_prize_winner'),
  payPrize: anchorDiscriminator('pay_prize'),
  releasePrize: anchorDiscriminator('release_prize'),
  buybackAndBurnPoke: anchorDiscriminator('buyback_and_burn_poke'),
} as const;
