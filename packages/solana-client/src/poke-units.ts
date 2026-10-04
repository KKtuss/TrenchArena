/**
 * Canonical POKE denomination.
 *
 * The mint has 6 decimals. Product amounts are whole POKE. Chain transfers
 * use raw atoms: whole POKE × 10^6. Tournament burn fees must be derived
 * from these constants so the chain, API, and UI stay on the same scale.
 */
export const POKE_MINT_DECIMALS = 6;
export const TOURNAMENT_BURN_FEE_POKE = 10_000;
export const TOURNAMENT_FIELD_SIZE = 32;

function atomScale(decimals: number): number {
  let scale = 1;
  for (let i = 0; i < decimals; i += 1) scale *= 10;
  return scale;
}

/** 10^6 raw atoms per whole POKE. */
export const POKE_ATOM_SCALE = atomScale(POKE_MINT_DECIMALS);

/** 10,000 POKE = 10,000,000,000 raw atoms. */
export const TOURNAMENT_BURN_FEE_ATOMS = TOURNAMENT_BURN_FEE_POKE * POKE_ATOM_SCALE;

/** 32 players × 10,000 POKE = 320,000 POKE. */
export const TOURNAMENT_FIELD_BURN_FEE_POKE = TOURNAMENT_BURN_FEE_POKE * TOURNAMENT_FIELD_SIZE;

/** 32 players × 10,000,000,000 raw atoms = 320,000,000,000 raw atoms. */
export const TOURNAMENT_FIELD_BURN_FEE_ATOMS = TOURNAMENT_BURN_FEE_ATOMS * TOURNAMENT_FIELD_SIZE;

if (
  POKE_MINT_DECIMALS !== 6
  || TOURNAMENT_BURN_FEE_POKE !== 10_000
  || TOURNAMENT_BURN_FEE_ATOMS !== 10_000_000_000
  || TOURNAMENT_FIELD_SIZE !== 32
  || TOURNAMENT_FIELD_BURN_FEE_POKE !== 320_000
  || TOURNAMENT_FIELD_BURN_FEE_ATOMS !== 320_000_000_000
) {
  throw new Error('POKE tournament burn denomination invariant failed.');
}

export function formatPokeFromAtoms(rawAtoms: number, decimals = POKE_MINT_DECIMALS): string {
  if (!Number.isSafeInteger(rawAtoms) || rawAtoms < 0) {
    throw new Error('POKE raw amount must be a non-negative safe integer.');
  }
  const scale = decimals === POKE_MINT_DECIMALS ? POKE_ATOM_SCALE : atomScale(decimals);
  const whole = Math.trunc(rawAtoms / scale);
  const fraction = rawAtoms % scale;
  const formattedWhole = whole.toLocaleString('en-US');
  if (fraction === 0) return `${formattedWhole} POKE`;
  const fractionText = String(fraction).padStart(decimals, '0').replace(/0+$/, '');
  return `${formattedWhole}.${fractionText} POKE`;
}

export function tournamentBurnFeeRequirement(playerId?: string): string {
  const who = playerId ? ` for ${playerId}` : '';
  const poke = TOURNAMENT_BURN_FEE_POKE.toLocaleString('en-US');
  const atoms = TOURNAMENT_BURN_FEE_ATOMS.toLocaleString('en-US');
  return `POKE burn fee must be exactly ${poke} POKE (${atoms} raw atoms)${who}.`;
}

export function assertTournamentBurnFeeAtoms(amount: number | bigint, playerId?: string): void {
  const raw = typeof amount === 'bigint' ? amount : BigInt(amount);
  if (raw !== BigInt(TOURNAMENT_BURN_FEE_ATOMS)) {
    throw new Error(tournamentBurnFeeRequirement(playerId));
  }
}
