import { sha256Bytes } from './sha256';

/** Anchor global instruction discriminator: sha256("global:<name>")[0..8]. */
export function anchorDiscriminator(name: string): Buffer {
  return Buffer.from(sha256Bytes(`global:${name}`)).subarray(0, 8);
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
  setPokeMint: anchorDiscriminator('set_poke_mint'),
  claimOperatorFees: anchorDiscriminator('claim_operator_fees'),
  setCardsMint: anchorDiscriminator('set_cards_mint'),
  fundCardsPrize: anchorDiscriminator('fund_cards_prize'),
  setCardsPrizeWinner: anchorDiscriminator('set_cards_prize_winner'),
  payCardsPrize: anchorDiscriminator('pay_cards_prize'),
  releaseCardsPrize: anchorDiscriminator('release_cards_prize'),
  claimFeeVault: anchorDiscriminator('claim_fee_vault'),
  initCardsRewardVaults: anchorDiscriminator('init_cards_reward_vaults'),
  claimCardsOperator: anchorDiscriminator('claim_cards_operator'),
  fundCardsPrizeFromTreasury: anchorDiscriminator('fund_cards_prize_from_treasury'),
  closeSettledMatch: anchorDiscriminator('close_settled_match'),
  closeFinalEntry: anchorDiscriminator('close_final_entry'),
  closeFinalCardsPrize: anchorDiscriminator('close_final_cards_prize'),
} as const;
