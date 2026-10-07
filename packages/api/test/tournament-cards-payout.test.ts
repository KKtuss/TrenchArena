import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cardsPlaceRecovery,
  splitCardsPrize,
  settleCardsPlace,
  type CardsPlaceIntent,
  type SignedCardsPlace,
} from '../src/tournament-cards-payout';

test('CARDS shares use integer 50/35/remainder', () => {
  const shares = splitCardsPrize(100n);
  assert.deepEqual(shares, { first: 50n, second: 35n, third: 15n });
  const odd = splitCardsPrize(99n);
  assert.equal(odd.first + odd.second + odd.third, 99n);
  assert.equal(odd.first, 49n);
  assert.equal(odd.second, 34n);
  assert.equal(odd.third, 16n);
});

test('recovery actions keep a replayable signature and replace only a dead one', () => {
  assert.equal(cardsPlaceRecovery({
    outcome: 'confirmed',
    hasSignedTransaction: true,
    blockhashExpired: false,
    mayStillLand: false,
  }), 'confirmed');
  assert.equal(cardsPlaceRecovery({
    outcome: 'unknown',
    hasSignedTransaction: true,
    blockhashExpired: false,
    mayStillLand: false,
  }), 'rebroadcast');
  assert.equal(cardsPlaceRecovery({
    outcome: 'unknown',
    hasSignedTransaction: false,
    blockhashExpired: true,
    mayStillLand: true,
  }), 'wait');
  assert.equal(cardsPlaceRecovery({
    outcome: 'unknown',
    hasSignedTransaction: false,
    blockhashExpired: true,
    mayStillLand: false,
  }), 'replace');
  assert.equal(cardsPlaceRecovery({
    outcome: 'failed',
    hasSignedTransaction: true,
    blockhashExpired: false,
    mayStillLand: true,
  }), 'replace');
  assert.equal(cardsPlaceRecovery({
    outcome: 'unknown',
    hasSignedTransaction: true,
    blockhashExpired: true,
    mayStillLand: true,
  }), 'replace');
});

function memoryPlace(amount = 15) {
  let intent: CardsPlaceIntent = {
    id: 'intent-3',
    status: 'created',
    playerId: 'player-3',
    amount,
    metadata: {},
  };
  const signed: SignedCardsPlace[] = [];
  const rebroadcasts: string[] = [];
  const wire = {
    loadOrCreate: async () => intent,
    remember: async (_id: string, patch: Record<string, unknown>) => {
      intent = { ...intent, metadata: { ...intent.metadata, ...patch } };
    },
    setStatus: async (_id: string, status: CardsPlaceIntent['status'], signature?: string) => {
      intent = {
        ...intent,
        status,
        metadata: signature ? { ...intent.metadata, signature } : intent.metadata,
      };
    },
    reload: async () => intent,
    rebroadcast: async (serializedTx: string) => {
      rebroadcasts.push(serializedTx);
      return 'submitted' as const;
    },
    submit: async (persistSigned: (signed: SignedCardsPlace) => Promise<void>) => {
      const next = signed.length + 1;
      const transaction: SignedCardsPlace = {
        signature: `sig-${next}`,
        serializedTx: `tx-${next}`,
        lastValidBlockHeight: 100 + next,
      };
      signed.push(transaction);
      await persistSigned(transaction);
      return { status: 'pending' as const, signature: transaction.signature };
    },
  };
  return {
    get intent() { return intent; },
    signed,
    rebroadcasts,
    wire,
  };
}

test('a crash after the signed transaction is stored rebroadcasts that same transaction', async () => {
  const place = memoryPlace();
  let crash = true;
  await assert.rejects(() => settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async () => 'unknown',
    blockhashExpired: async () => false,
    mayStillLand: async () => false,
    submit: async persistSigned => {
      await place.wire.submit(persistSigned);
      if (crash) throw new Error('process terminated before broadcast');
      return { status: 'confirmed', signature: place.signed[0]?.signature };
    },
  }), /process terminated before broadcast/);
  assert.equal(place.signed.length, 1);
  assert.equal(place.intent.metadata.serializedTx, 'tx-1');
  assert.equal(place.intent.metadata.signature, 'sig-1');

  crash = false;
  let reconciled = 0;
  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async signature => {
      assert.equal(signature, 'sig-1');
      reconciled += 1;
      return reconciled === 1 ? 'unknown' : 'confirmed';
    },
    blockhashExpired: async () => false,
    mayStillLand: async () => false,
    submit: async () => {
      throw new Error('recovery signed a second place-3 transfer');
    },
  });
  assert.deepEqual(place.rebroadcasts, ['tx-1']);
  assert.equal(place.signed.length, 1);
  assert.equal(place.intent.status, 'confirmed');
  assert.equal(place.intent.metadata.signature, 'sig-1');
});

test('a broadcast whose confirmation is delayed does not sign another transfer', async () => {
  const place = memoryPlace();
  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async () => 'unknown',
    blockhashExpired: async () => false,
  });
  assert.equal(place.signed.length, 1);
  assert.equal(place.intent.status, 'pending');

  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async () => 'unknown',
    blockhashExpired: async () => false,
    submit: async () => {
      throw new Error('delayed confirmation signed another transfer');
    },
  });
  assert.deepEqual(place.rebroadcasts, ['tx-1']);
  assert.equal(place.intent.metadata.signature, 'sig-1');
});

test('an unknown signature that later confirms is not replaced', async () => {
  const place = memoryPlace();
  await place.wire.remember('intent-3', {
    signature: 'sig-landed',
    serializedTx: 'tx-landed',
    settlementPhase: 'signed',
  });
  place.intent.status = 'pending';
  let seen = 0;
  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async () => {
      seen += 1;
      return seen < 2 ? 'unknown' : 'confirmed';
    },
    blockhashExpired: async () => false,
    submit: async () => {
      throw new Error('later confirmation signed another transfer');
    },
  });
  assert.equal(place.intent.status, 'confirmed');
  assert.equal(place.intent.metadata.signature, 'sig-landed');
  assert.equal(place.signed.length, 0);
});

test('a confirmed signature on restart is not broadcast again', async () => {
  const place = memoryPlace();
  place.intent.status = 'pending';
  place.intent.metadata = { signature: 'sig-done', serializedTx: 'tx-done' };
  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async () => 'confirmed',
    rebroadcast: async () => {
      throw new Error('confirmed signature was rebroadcast');
    },
    submit: async () => {
      throw new Error('confirmed signature was signed again');
    },
  });
  assert.equal(place.intent.status, 'confirmed');
});

test('a failed transaction can be replaced once and the old signature is retained', async () => {
  const place = memoryPlace();
  place.intent.status = 'pending';
  place.intent.metadata = { signature: 'sig-bad', serializedTx: 'tx-bad' };
  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async signature => signature === 'sig-bad' ? 'failed' : 'unknown',
    blockhashExpired: async () => true,
  });
  assert.equal(place.signed.length, 1);
  assert.equal(place.intent.metadata.signature, 'sig-1');
  assert.deepEqual(place.intent.metadata.previousSignatures, ['sig-bad']);
  assert.notEqual(place.intent.metadata.serializedTx, 'tx-bad');
});

test('concurrent recovery signs one transaction and the loser rebroadcasts it', async () => {
  const place = memoryPlace();
  const first = settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async () => 'unknown',
    blockhashExpired: async () => false,
    submit: async persistSigned => {
      const transaction = {
        signature: 'sig-shared',
        serializedTx: 'tx-shared',
        lastValidBlockHeight: 50,
      };
      await persistSigned(transaction);
      await new Promise(resolve => setTimeout(resolve, 30));
      return { status: 'pending' as const, signature: transaction.signature };
    },
  });
  while (place.intent.metadata.signature !== 'sig-shared') {
    await new Promise(resolve => setImmediate(resolve));
  }
  const second = settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async () => 'unknown',
    blockhashExpired: async () => false,
    submit: async () => {
      throw new Error('concurrent recovery signed a second transfer');
    },
  });
  await Promise.all([first, second]);
  assert.equal(place.intent.metadata.signature, 'sig-shared');
  assert.deepEqual(place.rebroadcasts, ['tx-shared']);
});

test('repeated restarts rebroadcast the same signed transaction', async () => {
  const place = memoryPlace();
  place.intent.status = 'pending';
  place.intent.metadata = { signature: 'sig-same', serializedTx: 'tx-same' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await settleCardsPlace({
      place: 3,
      playerId: 'player-3',
      amount: 15n,
      ...place.wire,
      reconcile: async () => 'unknown',
      blockhashExpired: async () => false,
      submit: async () => {
        throw new Error('restart signed a new transfer');
      },
    });
  }
  assert.deepEqual(place.rebroadcasts, ['tx-same', 'tx-same', 'tx-same']);
  assert.equal(place.intent.metadata.signature, 'sig-same');
});

test('confirmed places are untouched while a pending place is recovered', async () => {
  const confirmed = memoryPlace(50);
  confirmed.intent.status = 'confirmed';
  confirmed.intent.metadata = { signature: 'sig-place-1', serializedTx: 'tx-place-1' };
  await settleCardsPlace({
    place: 1,
    playerId: 'player-3',
    amount: 50n,
    ...confirmed.wire,
    reconcile: async () => {
      throw new Error('confirmed place was reconciled again');
    },
    submit: async () => {
      throw new Error('confirmed place was signed again');
    },
  });

  const pending = memoryPlace(15);
  pending.intent.status = 'pending';
  pending.intent.metadata = { signature: 'sig-place-3', serializedTx: 'tx-place-3' };
  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...pending.wire,
    reconcile: async () => 'confirmed',
    submit: async () => {
      throw new Error('pending place was signed again after confirmation');
    },
  });
  assert.equal(confirmed.intent.metadata.signature, 'sig-place-1');
  assert.equal(pending.intent.status, 'confirmed');
  assert.equal(pending.intent.metadata.signature, 'sig-place-3');
});

test('a signature with no stored bytes is not replaced while it may still land', async () => {
  const place = memoryPlace();
  place.intent.status = 'pending';
  place.intent.metadata = { signature: 'sig-unbroadcast', settlementPhase: 'submitted' };
  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async () => 'unknown',
    mayStillLand: async () => true,
    submit: async () => {
      throw new Error('a live signature was replaced');
    },
  });
  assert.equal(place.intent.metadata.signature, 'sig-unbroadcast');
  assert.equal(place.signed.length, 0);
});

test('a signature with no stored bytes is replaced once it cannot land', async () => {
  const place = memoryPlace();
  place.intent.status = 'pending';
  place.intent.metadata = { signature: 'sig-dead', settlementPhase: 'submitted' };
  await settleCardsPlace({
    place: 3,
    playerId: 'player-3',
    amount: 15n,
    ...place.wire,
    reconcile: async signature => signature === 'sig-dead' ? 'unknown' : 'unknown',
    mayStillLand: async () => false,
  });
  assert.equal(place.signed.length, 1);
  assert.equal(place.intent.metadata.serializedTx, 'tx-1');
  assert.equal(place.intent.metadata.signature, 'sig-1');
  assert.deepEqual(place.intent.metadata.previousSignatures, ['sig-dead']);
});
