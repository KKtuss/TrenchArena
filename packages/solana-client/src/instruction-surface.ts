import { createHash } from 'node:crypto';
import { IX } from './discriminator';

/** Every instruction the canonical TypeScript client can invoke. */
export const REQUIRED_PROGRAM_INSTRUCTIONS = [
  'initializeConfig',
  'createMatchEscrow',
  'depositSolWager',
  'seatMatchOpponent',
  'refundSolWager',
  'chargeMatchFee',
  'settleMatchWin',
  'settleMatchTie',
  'depositPokeEntry',
  'refundPokeEntry',
  'burnPokeEntry',
  'depositTreasurySol',
  'reservePrize',
  'setPrizeWinner',
  'payPrize',
  'releasePrize',
  'buybackAndBurnPoke',
  'setPokeMint',
  'claimOperatorFees',
  'setCardsMint',
  'fundCardsPrize',
  'setCardsPrizeWinner',
  'payCardsPrize',
  'releaseCardsPrize',
  'claimFeeVault',
  'initCardsRewardVaults',
  'claimCardsOperator',
  'fundCardsPrizeFromTreasury',
  'closeSettledMatch',
  'closeFinalEntry',
  'closeFinalCardsPrize',
] as const satisfies ReadonlyArray<keyof typeof IX>;

export const REQUIRED_CARDS_INSTRUCTIONS = [
  'setCardsMint',
  'fundCardsPrize',
  'setCardsPrizeWinner',
  'payCardsPrize',
  'releaseCardsPrize',
  'fundCardsPrizeFromTreasury',
  'initCardsRewardVaults',
  'claimCardsOperator',
  'closeFinalCardsPrize',
  'claimFeeVault',
] as const satisfies ReadonlyArray<keyof typeof IX>;

export type RequiredProgramInstruction = (typeof REQUIRED_PROGRAM_INSTRUCTIONS)[number];

export function instructionSurfaceManifest(): {
  instructions: Array<{ name: RequiredProgramInstruction; discriminator: string }>;
  hash: string;
} {
  const instructions = REQUIRED_PROGRAM_INSTRUCTIONS.map((name) => ({
    name,
    discriminator: Buffer.from(IX[name]).toString('hex'),
  }));
  const hash = createHash('sha256')
    .update(instructions.map((row) => `${row.name}:${row.discriminator}`).join('\n'))
    .digest('hex');
  return { instructions, hash };
}
