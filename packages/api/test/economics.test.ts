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

test('production wallets start at zero and the dev faucet pays a known wallet once', () => {
  const address = '8qbHbw2BbbRYBWQyPgemYbUqueezHPYmEkFNmUgHEf3g';
  const production = new MockEconomics();
  assert.equal(production.getBalance(address), 0);
  const unfunded = production.ensureWallet(address);
  assert.equal(unfunded.playerId, address);
  assert.equal(unfunded.balance, 0);
  assert.equal(unfunded.eligible, false);
  assert.equal(production.ensureWallet(address).balance, 0);

  const dev = new MockEconomics({ devFaucet: true });
  const funded = dev.ensureWallet(address);
  assert.equal(funded.balance, 10_000_000);
  assert.equal(funded.eligible, true);
  assert.equal(dev.ensureWallet(address).balance, 10_000_000);
});

test('paired reservations debit both players or neither', () => {
  const economics = new MockEconomics();
  economics.lockCollateral('demo-player-2', 10_000_000);
  assert.throws(() => economics.reserveAll([
    { holdKey: 'creator', playerId: 'demo-player-1', amount: 1_000 },
    { holdKey: 'opponent', playerId: 'demo-player-2', amount: 1_000 },
  ]), /Collateral exceeds/);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 0);
  assert.equal(economics.hasHold('creator'), false);
  assert.equal(economics.hasHold('opponent'), false);

  assert.throws(() => economics.reserveAll([
    { holdKey: 'first', playerId: 'demo-player-1', amount: 6_000_000 },
    { holdKey: 'second', playerId: 'demo-player-1', amount: 6_000_000 },
  ]), /Collateral exceeds/);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.hasHold('first'), false);
});

test('a hold refunds once and a settlement key pays once', () => {
  const economics = new MockEconomics();
  assert.equal(economics.reserve('creator', 'demo-player-1', 100_000), true);
  assert.equal(economics.reserve('creator', 'demo-player-1', 100_000), false);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 100_000);
  assert.equal(economics.release('missing'), 0);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 100_000);

  economics.reserve('opponent', 'demo-player-2', 100_000);
  economics.consume('creator');
  economics.consume('opponent');
  assert.equal(economics.release('creator'), 0);
  const payout = economics.settleCasualWin({
    winnerId: 'demo-player-1',
    loserId: 'demo-player-2',
    collateral: 100_000,
    settlementKey: 'fight-1',
  });
  const repeat = economics.settleCasualWin({
    winnerId: 'demo-player-1',
    loserId: 'demo-player-2',
    collateral: 100_000,
    settlementKey: 'fight-1',
  });
  assert.equal(payout.amount, 196_000);
  assert.equal(repeat.amount, 196_000);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 100_000 + 196_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - 100_000);
});
