import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectWallet,
  listWalletOptions,
  signAuthMessage,
  supportsSilentTrustedConnect,
  walletErrorMessage,
  type SolanaWalletAdapter,
} from '../lib/solana-wallet';

function adapter(): SolanaWalletAdapter {
  return {
    connect(options: { onlyIfTrusted?: boolean }) {
      return Promise.resolve({ publicKey: { toString: () => 'wallet-address' } });
    },
    disconnect: async () => undefined,
    signMessage: async () => new Uint8Array([1]),
  };
}

test('connectWallet forwards trusted-only restoration options', async () => {
  let received: { onlyIfTrusted?: boolean } | undefined;
  const selected = adapter();
  selected.connect = (options: { onlyIfTrusted?: boolean }) => {
    received = options;
    return Promise.resolve({ publicKey: { toString: () => 'wallet-address' } });
  };

  assert.equal(await connectWallet(selected, { onlyIfTrusted: true }), 'wallet-address');
  assert.deepEqual(received, { onlyIfTrusted: true });
});

test('listWalletOptions always offers Phantom, Solflare, Backpack, and MetaMask', () => {
  assert.deepEqual(
    listWalletOptions().map(wallet => wallet.id).slice(0, 4),
    ['phantom', 'solflare', 'backpack', 'metamask'],
  );
});

test('signAuthMessage asks the wallet to display utf8', async () => {
  let display: string | undefined;
  const selected = adapter();
  selected.signMessage = async (_message, encoding) => {
    display = encoding;
    return new Uint8Array(64);
  };
  await signAuthMessage(selected, 'PokeArena login');
  assert.equal(display, 'utf8');
});

test('walletErrorMessage keeps Phantom unexpected errors readable', () => {
  assert.equal(
    walletErrorMessage({ message: 'Unexpected error' }),
    'The wallet popup could not finish connecting. Approve it if it is open, then try again.',
  );
  assert.equal(walletErrorMessage({ code: 4001 }), 'Wallet connection was rejected.');
  assert.equal(
    walletErrorMessage({ message: 'close the previous wallet connect session before starting a new one' }),
    'Another wallet popup is still open. Close it, then click Connect Phantom again.',
  );
});

test('MetaMask is never auto-restored as a trusted session', () => {
  assert.equal(supportsSilentTrustedConnect('phantom'), true);
  assert.equal(supportsSilentTrustedConnect('solflare'), true);
  assert.equal(supportsSilentTrustedConnect('backpack'), true);
  assert.equal(supportsSilentTrustedConnect('metamask'), false);
});

test('connectWallet retries after a leftover wallet session', async () => {
  let attempts = 0;
  const selected = adapter();
  selected.connect = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('close the previous wallet connect session before starting a new one');
    }
    return { publicKey: { toString: () => 'wallet-address' } };
  };
  assert.equal(await connectWallet(selected), 'wallet-address');
  assert.equal(attempts, 2);
});
