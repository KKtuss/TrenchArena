import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { ChainEconomyService } from '../src/chain-economy';
import type { TokenUsdPrice } from '../src/play-token-oracle';

const PROGRAM_ID = 'HRN7567mTaH27Bhngu4Rg7JUQ8bvZp6Ymmf7XRT99rZk';
const POKE_MINT = '4oc27vsDaJeYhbhUybhhoPrjxobDzgPgKpZEMWwWpump';

function price(mint: string, priceUsd: string): TokenUsdPrice {
  return {
    mint,
    available: true,
    priceUsd,
    priceScaled: 40_000n,
    source: 'jupiter-price-v3',
    timestamp: new Date().toISOString(),
    blockId: 7,
    liquidityUsd: '10000',
    priceDecimals: 6,
    reason: 'ok',
    cacheHit: false,
  };
}

test('mainnet passport quotes the configured POKE mint and ignores an env price', async () => {
  const keeper = Keypair.generate();
  const mintReads: string[] = [];
  const service = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'mainnet-beta',
      POKEARENA_SOLANA_RPC: 'http://127.0.0.1:9',
      POKEARENA_PROGRAM_ID: PROGRAM_ID,
      POKEARENA_POKE_MINT: POKE_MINT,
      POKEARENA_POKE_PRICE_MICRO_USD: '400000',
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
    },
    keeper,
    chainStore: null,
    priceOracle: {
      async getUsdPrice(mint) {
        mintReads.push(mint);
        return price(mint, '0.000040');
      },
    },
  });

  const status = await service.getPassport(keeper.publicKey.toBase58(), undefined, { liquidAtoms: 0n });
  assert.deepEqual(mintReads, [POKE_MINT]);
  assert.equal(status.quote.source, 'oracle');
  assert.equal(status.quote.priceMicroUsd, 40);
  assert.equal(status.thresholdUsdCents, 500);
  assert.equal(status.eligible, false);
  assert.equal(status.reason, 'below_threshold');
});

test('a missing live quote does not authorize a mainnet passport', async () => {
  const keeper = Keypair.generate();
  const service = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'mainnet-beta',
      POKEARENA_SOLANA_RPC: 'http://127.0.0.1:9',
      POKEARENA_PROGRAM_ID: PROGRAM_ID,
      POKEARENA_POKE_MINT: POKE_MINT,
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
    },
    keeper,
    chainStore: null,
    priceOracle: {
      async getUsdPrice(mint) {
        return {
          ...price(mint, '0'),
          available: false,
          priceUsd: null,
          priceScaled: null,
          reason: 'not_listed',
        };
      },
    },
  });

  await assert.rejects(
    () => service.getPassport(keeper.publicKey.toBase58(), undefined, { liquidAtoms: 1_000_000_000_000n }),
    /Live POKE quote is unavailable/,
  );
});
