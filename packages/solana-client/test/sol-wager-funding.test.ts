import assert from 'node:assert/strict';
import test from 'node:test';

import {
  minimumSolCreatorFunding,
  minimumSolDepositBalance,
} from '../src/economics';

test('creator funding includes post-escrow rent reserve for separate deposit', () => {
  const collateral = 1_000_000;
  const escrowRent = 1_168_400;
  const vaultRent = 650_240;
  const fee = 5_000;
  const payerRentReserve = 650_240;

  const afterCreate = 3_000_000 - escrowRent - vaultRent - fee;
  assert.equal(afterCreate, 1_176_360);
  assert.equal(
    minimumSolDepositBalance(collateral, fee, payerRentReserve),
    1_655_240,
  );
  assert.ok(afterCreate < minimumSolDepositBalance(collateral, fee, payerRentReserve));
  assert.equal(
    minimumSolCreatorFunding(
      collateral,
      escrowRent,
      vaultRent,
      fee,
      payerRentReserve,
    ),
    3_478_880,
  );
  assert.ok(3_000_000 < minimumSolCreatorFunding(
    collateral,
    escrowRent,
    vaultRent,
    fee,
    payerRentReserve,
  ));
});
