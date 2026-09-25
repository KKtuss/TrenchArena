import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CASUAL_FEE_BPS, MockEconomics } from '../src/mock-economics';

test('mock economics calculates a one-time 2% fee on the total pot', () => {
  const economics = new MockEconomics();
  const preview = economics.previewCasual(100_000);
  assert.equal(preview.totalPot, 200_000);
  assert.equal(preview.protocolFee, 4_000);
  assert.equal(preview.winnerPayout, 196_000);
  assert.equal(preview.feeRateBps, CASUAL_FEE_BPS);
  assert.equal(preview.protocolFee, Math.floor((preview.totalPot * 200) / 10_000));
});

test('mock economics rejects over-balance collateral and settles winner credits', () => {
  const economics = new MockEconomics();
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.throws(() => economics.assertAffordable('demo-player-1', 10_000_001));

  economics.lockCollateral('demo-player-1', 100_000);
  economics.lockCollateral('demo-player-2', 100_000);
  const payout = economics.settleCasualWin({
    winnerId: 'demo-player-1',
    loserId: 'demo-player-2',
    collateral: 100_000,
  });
  assert.equal(payout.mocked, true);
  assert.equal(payout.amount, 196_000);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 100_000 + 196_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - 100_000);
});

test('tournament treasury uses 90/10 split', () => {
  const economics = new MockEconomics();
  const preview = economics.previewTournament(100_000, 4);
  assert.equal(preview.totalEntries, 400_000);
  assert.equal(preview.prizePool, 360_000);
  assert.equal(preview.devOpsShare, 40_000);
});
