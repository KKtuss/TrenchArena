import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MemoryPlacePayoutStore,
  PrizePayoutUnknownError,
  settlePrizePlaces,
  type PlacePayoutRecord,
} from '../src/tournament-payout';

const PLAYERS = [
  '11111111111111111111111111111111',
  '22222222222222222222222222222222',
  '33333333333333333333333333333333',
] as const;

test('place payouts reconcile an unknown signature and never replace a confirmed one', async () => {
  const store = new MemoryPlacePayoutStore();
  const broadcasts: string[] = [];
  let outcome: 'confirmed' | 'failed' | 'unknown' = 'unknown';
  const signatures = new Map<string, 'confirmed' | 'failed' | 'unknown'>();
  let sequence = 0;

  const broadcast = async (record: PlacePayoutRecord) => {
    sequence += 1;
    const signature = `sig-${record.place}-${sequence}`;
    broadcasts.push(signature);
    signatures.set(signature, outcome);
    return { signature, outcome };
  };
  const reconcile = async (record: PlacePayoutRecord) => signatures.get(record.signature ?? '') ?? 'unknown';
  const input = {
    lockKey: 'cup-a',
    prizePool: 100,
    recipients: { 1: PLAYERS[0], 2: PLAYERS[1], 3: PLAYERS[2] } as const,
    store,
    reconcile,
    broadcast,
  };

  await assert.rejects(() => settlePrizePlaces(input), PrizePayoutUnknownError);
  assert.equal(broadcasts.length, 1);
  const submitted = await store.load(1);
  assert.equal(submitted?.status, 'submitted');
  assert.equal(submitted?.signature, broadcasts[0]);

  await assert.rejects(() => settlePrizePlaces({ ...input, lockKey: 'cup-a-retry' }), PrizePayoutUnknownError);
  assert.equal(broadcasts.length, 1);

  signatures.set(broadcasts[0]!, 'confirmed');
  outcome = 'confirmed';
  const paid = await settlePrizePlaces({ ...input, lockKey: 'cup-a-confirm' });
  assert.equal(paid[0]?.status, 'confirmed');
  assert.equal(paid[0]?.signature, broadcasts[0]);
  const afterConfirm = broadcasts.length;

  outcome = 'failed';
  await settlePrizePlaces({ ...input, lockKey: 'cup-a-ignore-failure' });
  assert.equal(broadcasts.length, afterConfirm);
  const kept = await store.load(1);
  assert.equal(kept?.status, 'confirmed');
  assert.equal(kept?.signature, broadcasts[0]);
  assert.equal(kept?.amount, 50);
  assert.equal((await store.load(2))?.amount, 35);
  assert.equal((await store.load(3))?.amount, 15);
  assert.equal(50 + 35 + 15, 100);
});

test('a failed place payout can be retried without losing the failed signature', async () => {
  const store = new MemoryPlacePayoutStore();
  const seen: string[] = [];
  let mode: 'failed' | 'confirmed' = 'failed';
  let sequence = 0;
  const signatures = new Map<string, 'failed' | 'confirmed'>();
  const paid = await settlePrizePlaces({
    lockKey: 'cup-b',
    prizePool: 10,
    recipients: { 1: PLAYERS[0], 2: PLAYERS[1], 3: PLAYERS[2] },
    store,
    reconcile: async record => signatures.get(record.signature ?? '') ?? 'unknown',
    broadcast: async record => {
      sequence += 1;
      const signature = `try-${record.place}-${sequence}`;
      seen.push(signature);
      signatures.set(signature, mode);
      return { signature, outcome: mode };
    },
  }).catch(error => error);
  assert.ok(paid instanceof Error);
  const failed = await store.load(1);
  assert.equal(failed?.status, 'failed');
  assert.ok(failed?.signature);

  mode = 'confirmed';
  const confirmed = await settlePrizePlaces({
    lockKey: 'cup-b-retry',
    prizePool: 10,
    recipients: { 1: PLAYERS[0], 2: PLAYERS[1], 3: PLAYERS[2] },
    store,
    reconcile: async record => signatures.get(record.signature ?? '') ?? 'unknown',
    broadcast: async record => {
      sequence += 1;
      const signature = `try-${record.place}-${sequence}`;
      seen.push(signature);
      signatures.set(signature, 'confirmed');
      return { signature, outcome: 'confirmed' };
    },
  });
  assert.equal(confirmed[0]?.status, 'confirmed');
  assert.notEqual(confirmed[0]?.signature, failed?.signature);
  assert.ok(confirmed[0]?.previousSignatures.includes(failed!.signature!));
  assert.equal(confirmed[0]!.amount + confirmed[1]!.amount + confirmed[2]!.amount, 10);
});

test('a place signature is stored before broadcast and a crash does not send twice', async () => {
  const store = new MemoryPlacePayoutStore();
  let sends = 0;
  const input = {
    lockKey: 'cup-crash',
    prizePool: 100,
    recipients: { 1: PLAYERS[0], 2: PLAYERS[1], 3: PLAYERS[2] } as const,
    store,
    reconcile: async () => 'unknown' as const,
    arm: async (record: PlacePayoutRecord) => ({ signature: `armed-${record.place}` }),
    broadcast: async (record: PlacePayoutRecord) => {
      const stored = await store.load(record.place);
      assert.equal(stored?.signature, `armed-${record.place}`);
      assert.equal(stored?.status, 'submitted');
      sends += 1;
      if (record.place === 1) throw new Error('crash after signature persist');
      return { signature: record.signature, outcome: 'confirmed' as const };
    },
  };
  await assert.rejects(() => settlePrizePlaces(input), /crash after signature persist/);
  assert.equal(sends, 1);
  assert.equal((await store.load(1))?.signature, 'armed-1');
  await assert.rejects(() => settlePrizePlaces({ ...input, lockKey: 'cup-crash-retry' }), /not confirmed yet/);
  assert.equal(sends, 1);
});
