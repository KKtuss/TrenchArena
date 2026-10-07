import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';

import { depositPokeEntryIx } from '../src/instructions';
import {
  assertTournamentBurnFeeAtoms,
  formatPokeFromAtoms,
  POKE_MINT_DECIMALS,
  TOURNAMENT_BURN_FEE_ATOMS,
  TOURNAMENT_BURN_FEE_POKE,
  TOURNAMENT_FIELD_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_BURN_FEE_POKE,
  TOURNAMENT_FIELD_SIZE,
} from '../src/poke-units';

const PROGRAM_ID = new PublicKey('41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W');

test('one player burns 10,000 POKE, which is 10,000,000,000 raw atoms', () => {
  assert.equal(POKE_MINT_DECIMALS, 6);
  assert.equal(TOURNAMENT_FIELD_SIZE, 32);
  assert.equal(TOURNAMENT_BURN_FEE_POKE, 10_000);
  assert.equal(TOURNAMENT_BURN_FEE_ATOMS, 10_000 * 10 ** 6);
  assert.equal(TOURNAMENT_BURN_FEE_ATOMS, 10_000_000_000);
  assert.notEqual(TOURNAMENT_BURN_FEE_ATOMS, TOURNAMENT_BURN_FEE_POKE);
  assert.equal(TOURNAMENT_FIELD_BURN_FEE_POKE, 320_000);
  assert.equal(TOURNAMENT_FIELD_BURN_FEE_ATOMS, 320_000_000_000);
  assert.equal(TOURNAMENT_FIELD_BURN_FEE_ATOMS, TOURNAMENT_BURN_FEE_ATOMS * 32);
  assert.equal(formatPokeFromAtoms(TOURNAMENT_BURN_FEE_ATOMS), '10,000 POKE');
  assert.equal(formatPokeFromAtoms(TOURNAMENT_FIELD_BURN_FEE_ATOMS), '320,000 POKE');
  assert.equal(formatPokeFromAtoms(10_000), '0.01 POKE');
  assert.notEqual(formatPokeFromAtoms(10_000), '10,000 POKE');
  assert.throws(() => assertTournamentBurnFeeAtoms(10_000), /10,000,000,000 raw atoms/);
  assert.doesNotThrow(() => assertTournamentBurnFeeAtoms(10_000_000_000n));
});

test('deposit_poke_entry encodes 10,000 POKE as raw atoms, not display units', () => {
  const player = PublicKey.unique();
  const mint = PublicKey.unique();
  const tournamentId = Buffer.alloc(16, 7);
  const quoteId = Buffer.alloc(32, 9);
  const canonical = depositPokeEntryIx({
    programId: PROGRAM_ID,
    player,
    config: PublicKey.unique(),
    pokeMint: mint,
    playerPoke: PublicKey.unique(),
    tournamentId,
    amount: BigInt(TOURNAMENT_BURN_FEE_ATOMS),
    quoteId,
    priceMicroUsd: 400_000,
  });
  const displayUnitsAsRaw = depositPokeEntryIx({
    programId: PROGRAM_ID,
    player,
    config: PublicKey.unique(),
    pokeMint: mint,
    playerPoke: PublicKey.unique(),
    tournamentId,
    amount: BigInt(TOURNAMENT_BURN_FEE_POKE),
    quoteId,
    priceMicroUsd: 400_000,
  });
  assert.equal(canonical.data.readBigUInt64LE(24), 10_000_000_000n);
  assert.equal(displayUnitsAsRaw.data.readBigUInt64LE(24), 10_000n);
  assert.notEqual(
    canonical.data.readBigUInt64LE(24),
    displayUnitsAsRaw.data.readBigUInt64LE(24),
  );
});
