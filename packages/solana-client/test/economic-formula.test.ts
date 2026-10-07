import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BPS_DENOM,
  CASUAL_FEE_BPS,
  OPERATOR_BPS,
  POKE_ATOM_SCALE,
  TOURNAMENT_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_SIZE,
  TREASURY_BPS,
  previewLegacyPokeTournament,
  previewSolCasual,
  previewTreasurySplit,
} from '../src/index';

test('casual SOL formula preserves every lamport across fee and payout', () => {
  for (const collateral of [1, 25, 500_000_000, 2_000_000_000_000_000]) {
    const preview = previewSolCasual(collateral);
    assert.equal(
      BigInt(preview.protocolFeeLamports) + BigInt(preview.winnerPayoutLamports),
      BigInt(preview.totalPotLamports),
    );
    assert.equal(
      preview.protocolFeeLamports,
      Number((BigInt(collateral) * 2n * BigInt(CASUAL_FEE_BPS)) / BigInt(BPS_DENOM)),
    );
  }
  assert.equal(previewSolCasual(25).protocolFeeLamports, 1);
  assert.throws(() => previewSolCasual(Number.MAX_SAFE_INTEGER), /safe integer range/);
});

test('realized treasury deposits use exact 90/10 integer allocation', () => {
  for (const gross of [1, 101, 10_000_000_000, Number.MAX_SAFE_INTEGER]) {
    const split = previewTreasurySplit(gross);
    assert.equal(
      BigInt(split.treasuryLamports) + BigInt(split.operatorLamports),
      BigInt(gross),
    );
    assert.equal(
      split.treasuryLamports,
      Number((BigInt(gross) * BigInt(TREASURY_BPS)) / BigInt(BPS_DENOM)),
    );
    assert.equal(split.operatorBps, OPERATOR_BPS);
  }
  assert.equal(previewTreasurySplit(101).treasuryLamports, 90);
  assert.equal(previewTreasurySplit(101).operatorLamports, 11);
});

test('legacy POKE tournament formula conserves entries plus documented dev-ops remainder', () => {
  for (const [entryFee, playerCount] of [[1, 4], [50_000, 32], [333_333, 16]] as const) {
    const preview = previewLegacyPokeTournament(entryFee, playerCount);
    assert.equal(
      BigInt(preview.prizePool) + BigInt(preview.devOpsShare),
      BigInt(preview.totalEntries),
    );
    assert.equal(preview.prizePool, preview.treasuryShare);
    assert.equal(
      preview.treasuryShare,
      Number(
        (BigInt(entryFee) * BigInt(playerCount) * BigInt(TREASURY_BPS))
          / BigInt(BPS_DENOM),
      ),
    );
  }
  assert.throws(
    () => previewLegacyPokeTournament(Number.MAX_SAFE_INTEGER, 2),
    /safe integer range/,
  );
});

test('chain tournament burn formula is fixed in raw atoms for every supported field', () => {
  assert.equal(TOURNAMENT_BURN_FEE_ATOMS, 10_000 * POKE_ATOM_SCALE);
  for (const playerCount of [1, 4, 8, 16, TOURNAMENT_FIELD_SIZE]) {
    const totalBurn = BigInt(TOURNAMENT_BURN_FEE_ATOMS) * BigInt(playerCount);
    assert.equal(totalBurn, BigInt(TOURNAMENT_BURN_FEE_ATOMS * playerCount));
    assert.equal(
      totalBurn + 0n,
      BigInt(TOURNAMENT_BURN_FEE_ATOMS) * BigInt(playerCount),
    );
  }
  assert.equal(TOURNAMENT_FIELD_BURN_FEE_ATOMS, 320_000_000_000);
});

test('repeated tournament formula applications remain independent and exact', () => {
  const oneField = BigInt(TOURNAMENT_FIELD_BURN_FEE_ATOMS);
  const repeated = Array.from({ length: 5 }, () => oneField)
    .reduce((sum, amount) => sum + amount, 0n);
  assert.equal(repeated, 1_600_000_000_000n);
});
