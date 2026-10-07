import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CASUAL_FEE_BPS,
  TOURNAMENT_DEV_OPS_BPS,
  TOURNAMENT_TREASURY_BPS,
  previewCasual,
  previewTournament,
  previewTreasuryDeposit,
} from '../src/index';

test('legacy casual POKE allocation is exact at rounding boundaries', () => {
  for (const collateral of [1, 25, 100_000, 2_000_000_000_000_000]) {
    const preview = previewCasual(collateral);
    assert.equal(
      BigInt(preview.protocolFee) + BigInt(preview.winnerPayout),
      BigInt(preview.totalPot),
    );
    assert.equal(
      preview.protocolFee,
      Number((BigInt(collateral) * 2n * BigInt(CASUAL_FEE_BPS)) / 10_000n),
    );
  }
  assert.equal(previewCasual(25).protocolFee, 1);
  assert.throws(() => previewCasual(Number.MAX_SAFE_INTEGER), /safe integer range/);
});

test('legacy tournament allocation preserves all entry atoms', () => {
  for (const [entryFee, playerCount] of [[1, 4], [50_000, 32], [333_333, 16]] as const) {
    const preview = previewTournament(entryFee, playerCount);
    assert.equal(
      BigInt(preview.prizePool) + BigInt(preview.devOpsShare),
      BigInt(preview.totalEntries),
    );
    assert.equal(preview.treasuryShare, preview.prizePool);
    assert.equal(preview.treasuryBps, TOURNAMENT_TREASURY_BPS);
    assert.equal(preview.devOpsBps, TOURNAMENT_DEV_OPS_BPS);
  }
  assert.throws(
    () => previewTournament(Number.MAX_SAFE_INTEGER, 2),
    /safe integer range/,
  );
});

test('realized treasury deposit allocates exact lamports with remainder to operator', () => {
  for (const gross of [1, 101, 111_111_112, Number.MAX_SAFE_INTEGER]) {
    const split = previewTreasuryDeposit(gross);
    assert.equal(
      BigInt(split.treasuryLamports) + BigInt(split.operatorLamports),
      BigInt(gross),
    );
    assert.equal(split.treasuryBps, TOURNAMENT_TREASURY_BPS);
    assert.equal(split.operatorBps, TOURNAMENT_DEV_OPS_BPS);
  }
  assert.equal(previewTreasuryDeposit(101).treasuryLamports, 90);
  assert.equal(previewTreasuryDeposit(101).operatorLamports, 11);
});
