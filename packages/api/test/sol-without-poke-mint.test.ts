import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { ArenaChainClient } from '@pokearena/solana-client';

import { ChainEconomyService } from '../src/chain-economy';

const PROGRAM_ID = '6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98';

test('chain economy can enable SOL wagers while the POKE mint stays unset', async () => {
  const keeper = Keypair.generate();
  const service = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'mainnet-beta',
      POKEARENA_SOLANA_RPC: 'https://api.mainnet-beta.solana.com',
      POKEARENA_PROGRAM_ID: PROGRAM_ID,
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
    },
    keeper,
    client: {} as ArenaChainClient,
  });
  assert.equal(service.enabled, true);
  assert.equal(service.pokeConfigured, false);
  assert.equal(service.config.pokeMint.equals(PublicKey.default), true);

  await assert.rejects(
    () => service.createPokeEntryDepositIntent({
      tournamentId: '11111111-1111-1111-1111-111111111111',
      playerId: keeper.publicKey.toBase58(),
      fixedBurnFee: true,
    }),
    /POKE economy is not configured/,
  );
  await assert.rejects(
    () => service.lockTournament({
      tournamentId: '11111111-1111-1111-1111-111111111111',
      playerIds: [keeper.publicKey.toBase58()],
      prizeCardsRaw: 1,
    }),
    /POKE economy is not configured/,
  );
  await assert.rejects(
    () => service.createSolWagerDepositIntent({
      roomId: '22222222-2222-2222-2222-222222222222',
      playerId: keeper.publicKey.toBase58(),
      side: 0,
      collateralLamports: 1_000_000,
    }),
    /Chain store is required for SOL wagers/,
  );
});
