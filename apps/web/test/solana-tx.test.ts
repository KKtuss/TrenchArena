import assert from 'node:assert/strict';
import test from 'node:test';

import { submitSignedTransaction, type SignedSubmissionRpc } from '../lib/solana-tx';

function rpc(options?: {
  sendResults?: Array<'ok' | '429' | 'unknown' | 'duplicate' | 'reject'>;
  confirmResult?: 'ok' | '429' | 'reject';
}): SignedSubmissionRpc & { sends: Uint8Array[]; confirms: string[] } {
  const sends: Uint8Array[] = [];
  const confirms: string[] = [];
  const script = [...(options?.sendResults ?? ['ok'])];
  return {
    sends,
    confirms,
    async sendRawTransaction(raw) {
      sends.push(raw);
      const next = script.length > 0 ? script.shift()! : 'ok';
      if (next === 'ok') return 'submitted';
      if (next === 'duplicate') throw new Error('Transaction already processed');
      if (next === 'reject') throw new Error('Transaction simulation failed');
      if (next === 'unknown') throw new Error('fetch failed');
      throw new Error('429 Too Many Requests');
    },
    async confirmTransaction(signature) {
      confirms.push(signature);
      if (options?.confirmResult === '429') throw new Error('429 Too Many Requests');
      if (options?.confirmResult === 'reject') throw new Error('Transaction simulation failed');
    },
  };
}

const noWait = () => 0;

test('one entry submits and confirms its signed transaction once', async () => {
  const connection = rpc();
  const payload = Uint8Array.from([1, 2, 3]);
  const signature = await submitSignedTransaction(connection, payload, 'sig-1', {
    retryDelayMs: noWait,
  });
  assert.equal(signature, 'sig-1');
  assert.equal(connection.sends.length, 1);
  assert.deepEqual(connection.confirms, ['sig-1']);
});

test('concurrent entries keep one payload per signature', async () => {
  for (const count of [4, 8]) {
    const calls: string[] = [];
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const signature = `player-${count}-${index}`;
      const payload = Uint8Array.from([count, index]);
      const connection = rpc({ sendResults: ['429', 'ok'] });
      const returned = await submitSignedTransaction(connection, payload, signature, {
        retryDelayMs: noWait,
      });
      assert.equal(returned, signature);
      assert.equal(connection.sends.length, 2);
      assert.deepEqual(connection.sends[0], payload);
      assert.deepEqual(connection.sends[1], payload);
      calls.push(signature);
    }));
    assert.equal(new Set(calls).size, count);
  }
});

test('a 429 during submission retries the same bytes and keeps the signature', async () => {
  const connection = rpc({ sendResults: ['429', '429', 'ok'] });
  const payload = Uint8Array.from([9]);
  const signature = await submitSignedTransaction(connection, payload, 'sig-429', {
    retryDelayMs: noWait,
  });
  assert.equal(signature, 'sig-429');
  assert.equal(connection.sends.length, 3);
  assert.ok(connection.sends.every(bytes => bytes[0] === 9));
});

test('an unknown submission outcome does not create another transaction', async () => {
  const connection = rpc({ sendResults: ['unknown', 'unknown', 'unknown', 'unknown'] });
  const payload = Uint8Array.from([4]);
  const signature = await submitSignedTransaction(connection, payload, 'sig-unknown', {
    retryDelayMs: noWait,
    attempts: 4,
  });
  assert.equal(signature, 'sig-unknown');
  assert.equal(connection.sends.length, 4);
  assert.equal(connection.confirms.length, 0);
});

test('an already processed submission is the original transaction', async () => {
  const connection = rpc({ sendResults: ['duplicate'] });
  const signature = await submitSignedTransaction(
    connection,
    Uint8Array.from([7]),
    'sig-dup',
    { retryDelayMs: noWait },
  );
  assert.equal(signature, 'sig-dup');
  assert.equal(connection.sends.length, 1);
  assert.deepEqual(connection.confirms, ['sig-dup']);
});

test('a 429 during confirmation still returns the original signature', async () => {
  const connection = rpc({ confirmResult: '429' });
  const signature = await submitSignedTransaction(
    connection,
    Uint8Array.from([8]),
    'sig-confirm',
    { retryDelayMs: noWait },
  );
  assert.equal(signature, 'sig-confirm');
  assert.equal(connection.sends.length, 1);
  assert.deepEqual(connection.confirms, ['sig-confirm']);
});

test('a definitive simulation failure is not retried', async () => {
  const connection = rpc({ sendResults: ['reject'] });
  await assert.rejects(
    () => submitSignedTransaction(connection, Uint8Array.from([5]), 'sig-bad', { retryDelayMs: noWait }),
    /simulation failed/,
  );
  assert.equal(connection.sends.length, 1);
  assert.equal(connection.confirms.length, 0);
});
