import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  atomsForUsdCents,
  createMockQuote,
  evaluatePassport,
  passportAtoms,
  previewSolCasual,
  previewTreasurySplit,
  tournamentEntryAtoms,
  usdCentsFromAtoms,
} from '../src/index';

test('atomsForUsdCents rounds up so $20 and $5 never shrink', () => {
  const quote = createMockQuote({ priceMicroUsd: 400_000, decimals: 6 });
  // $0.40/POKE → 50 POKE for $20, 12.5 POKE for $5
  assert.equal(passportAtoms(quote), 50_000_000n);
  assert.equal(tournamentEntryAtoms(quote), 12_500_000n);
  // Uneven price forces ceil
  const odd = createMockQuote({ priceMicroUsd: 333_333, decimals: 6 });
  const atoms = atomsForUsdCents(2_000, odd);
  assert.ok(atoms * 333_333n >= 2_000n * 1_000_000n * 10_000n);
});

test('passport requires $20 after excluding entry holds', () => {
  const quote = createMockQuote();
  const entry = tournamentEntryAtoms(quote);
  const passport = passportAtoms(quote);
  const onlyPassport = evaluatePassport({
    liquidAtoms: passport,
    heldEntryAtoms: 0n,
    quote,
  });
  assert.equal(onlyPassport.eligible, true);
  assert.equal(onlyPassport.reason, 'ok');

  const withEntryHold = evaluatePassport({
    liquidAtoms: passport + entry,
    heldEntryAtoms: entry,
    quote,
  });
  assert.equal(withEntryHold.eligible, true);

  const cannotEnter = evaluatePassport({
    liquidAtoms: passport,
    heldEntryAtoms: 0n,
    quote,
  });
  assert.equal(BigInt(cannotEnter.atomsForEntryAndPassport), passport + entry);
  assert.equal(usdCentsFromAtoms(passport, quote), 2_000);
});

test('stale and wide quotes fail closed', () => {
  const stale = createMockQuote({ observedAt: Date.now() - 180_000 });
  const status = evaluatePassport({ liquidAtoms: 100_000_000n, quote: stale });
  assert.equal(status.eligible, false);
  assert.equal(status.reason, 'stale_price');

  const wide = createMockQuote({ confidenceBps: 500 });
  const wideStatus = evaluatePassport({ liquidAtoms: 100_000_000n, quote: wide });
  assert.equal(wideStatus.eligible, false);
  assert.equal(wideStatus.reason, 'wide_confidence');
});

test('SOL casual preview matches 2% integer floor', () => {
  const preview = previewSolCasual(500_000_000);
  assert.equal(preview.totalPotLamports, 1_000_000_000);
  assert.equal(preview.protocolFeeLamports, 20_000_000);
  assert.equal(preview.winnerPayoutLamports, 980_000_000);
});

test('treasury split is 90/10 with remainder to operator', () => {
  const split = previewTreasurySplit(10_000_000_000);
  assert.equal(split.treasuryLamports, 9_000_000_000);
  assert.equal(split.operatorLamports, 1_000_000_000);
  const odd = previewTreasurySplit(101);
  assert.equal(odd.treasuryLamports + odd.operatorLamports, 101);
  assert.equal(odd.operatorLamports, 101 - Math.floor((101 * 9000) / 10_000));
});
