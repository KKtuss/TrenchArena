import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';

import { ArenaChainClient, type ArenaChainConfig, IX } from '../src/index';

const programId = new PublicKey('26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke');
const expectedSigner = new PublicKey('11111111111111111111111111111111');
const wrongSigner = new PublicKey('SysvarRent111111111111111111111111111111111');

function config(): ArenaChainConfig {
  return {
    cluster: 'localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    programId,
    pokeMint: PublicKey.default,
    feeVault: PublicKey.default,
    treasuryVault: PublicKey.default,
    operatorVault: PublicKey.default,
    quoteAuthority: PublicKey.default,
    keeper: PublicKey.default,
    authority: PublicKey.default,
    buybackBps: 2500,
    minBuybackLamports: 1,
    chainEconomyEnabled: true,
    commitment: 'confirmed',
  };
}

test('intent verification rejects a confirmed transaction from another signer', async () => {
  const client = new ArenaChainClient(config());
  (client as unknown as { connection: unknown }).connection = {
    getParsedTransaction: async () => ({
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: [{ pubkey: wrongSigner, signer: true }],
          instructions: [],
        },
      },
    }),
  };
  const result = await client.verifyIntentTransaction('unrelated-signature', {
    expectedSigner,
    expectedProgram: programId,
    discriminator: IX.depositSolWager,
    accounts: [expectedSigner],
    kind: 'sol_wager_deposit',
    roomId: Buffer.alloc(16),
    side: 0,
    amount: 1n,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /signer/i);
});

test('intent verification rejects a same-signer transaction without the expected action', async () => {
  const client = new ArenaChainClient(config());
  (client as unknown as { connection: unknown }).connection = {
    getParsedTransaction: async () => ({
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: [{ pubkey: expectedSigner, signer: true }],
          instructions: [],
        },
      },
    }),
  };
  const result = await client.verifyIntentTransaction('unrelated-signature', {
    expectedSigner,
    expectedProgram: programId,
    discriminator: IX.depositSolWager,
    accounts: [expectedSigner],
    kind: 'sol_wager_deposit',
    roomId: Buffer.alloc(16),
    side: 0,
    amount: 1n,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /instruction/i);
});
