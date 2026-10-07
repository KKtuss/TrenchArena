import { IX } from './discriminator';

export const CASUAL_FEE_BPS = 200;
export const TREASURY_BPS = 9000;
export const OPERATOR_BPS = 1000;
export const BPS_DENOM = 10_000;

export { PASSPORT_USD_CENTS, POKEARENA_PASSPORT_MIN_USD } from './passport-threshold';
/** Approximate tournament entry cost in USD cents. */
export const TOURNAMENT_ENTRY_USD_CENTS = 500;
export {
  POKE_MINT_DECIMALS,
  POKE_ATOM_SCALE,
  TOURNAMENT_BURN_FEE_POKE,
  TOURNAMENT_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_SIZE,
  TOURNAMENT_FIELD_BURN_FEE_POKE,
  TOURNAMENT_FIELD_BURN_FEE_ATOMS,
  formatPokeFromAtoms,
  assertTournamentBurnFeeAtoms,
  tournamentBurnFeeRequirement,
} from './poke-units';

/** Reject quotes older than this many milliseconds. */
export const QUOTE_MAX_AGE_MS = 120_000;
/** Reject quotes whose confidence band is wider than this fraction of price (bps). */
export const QUOTE_MAX_CONFIDENCE_BPS = 200;

export const DEFAULT_RPC = 'http://127.0.0.1:8899';

/** Anchor discriminators (sha256("global:<name>")[0..8]). */
export const DISCRIMINATORS = IX;
