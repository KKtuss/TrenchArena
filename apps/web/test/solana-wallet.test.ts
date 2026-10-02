import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connectWallet, type SolanaWalletAdapter } from '../lib/solana-wallet';

test('connectWallet forwards trusted-only restoration options', async () => {
  let received: { onlyIfTrusted?: boolean } | undefined;
  const adapter = {
    connect(options: { onlyIfTrusted?: boolean }) {
      received = options;
      return Promise.resolve({ publicKey: { toString: () => 'wallet-address' } });
    },
    disconnect: async () => undefined,
    signMessage: async () => new Uint8Array([1]),
  } as SolanaWalletAdapter;

  assert.equal(await connectWallet(adapter, { onlyIfTrusted: true }), 'wallet-address');
  assert.deepEqual(received, { onlyIfTrusted: true });
});
