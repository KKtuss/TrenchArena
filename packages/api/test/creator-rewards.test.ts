import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  InMemoryCreatorRewardsStore,
  type ChainIntentRow,
  type ChainIntentStatus,
  type CreateIntentInput,
  type CreatorRewardsStore,
  type PostgresChainStore,
} from '@pokearena/db';
import {
  IX,
  configPda,
  type ArenaChainClient,
  type SentTransaction,
} from '@pokearena/solana-client';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from '@solana/web3.js';

import { assertStagingFundingSmokeAccess, ChainEconomyService } from '../src/chain-economy';
import { CreatorRewardsWorker, CreatorRewardFundingError, splitCardsCreatorReward } from '../src/creator-rewards';
import { encodeBase58 } from '../src/wallet-auth';

const PROGRAM_ID = new PublicKey('HRN7567mTaH27Bhngu4Rg7JUQ8bvZp6Ymmf7XRT99rZk');

const {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const CARDS = Keypair.generate().publicKey;
const KEEPER = Keypair.generate().publicKey;
const OPERATOR = Keypair.generate().publicKey;

function writeSigner(signer: Keypair): string {
  const directory = mkdtempSync(join(tmpdir(), 'pokearena-creator-rewards-'));
  const path = join(directory, 'creator.json');
  writeFileSync(path, JSON.stringify([...signer.secretKey]), { mode: 0o600 });
  return path;
}

function parsedToken(mint: PublicKey, owner: PublicKey, amount: bigint) {
  return {
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 1,
    data: {
      program: 'spl-token',
      parsed: {
        type: 'account',
        info: {
          mint: mint.toBase58(),
          owner: owner.toBase58(),
          tokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: 0 },
        },
      },
    },
  };
}

function makeHarness(options: {
  claimable?: bigint;
  includeSol?: boolean;
  token2022?: boolean;
  unknownSignatures?: Set<string>;
  unknownNext?: boolean;
  wrongDestination?: boolean;
} = {}) {
  const signer = Keypair.generate();
  const creatorAta = getAssociatedTokenAddressSync(CARDS, signer.publicKey);
  const keeperAta = getAssociatedTokenAddressSync(CARDS, KEEPER);
  const operatorAta = getAssociatedTokenAddressSync(CARDS, OPERATOR);
  let creatorAmount = 0n;
  let keeperAmount = 0n;
  let operatorAmount = 0n;
  let claimable = options.claimable ?? 100n;
  let sends = 0;
  const signatures = new Set<string>();
  const unknownSignatures = options.unknownSignatures ?? new Set<string>();
  let unknownNext = options.unknownNext ?? false;
  const logs: unknown[] = [];

  const connection = {
    async getParsedAccountInfo(address: PublicKey) {
      if (address.equals(CARDS)) {
        return {
          context: { slot: 1 },
          value: {
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            lamports: 1,
            data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6 } } },
          },
        };
      }
      if (address.equals(keeperAta) && options.wrongDestination) {
        return {
          context: { slot: 1 },
          value: parsedToken(CARDS, Keypair.generate().publicKey, 0n),
        };
      }
      if (address.equals(creatorAta)) {
        return { context: { slot: 1 }, value: parsedToken(CARDS, signer.publicKey, creatorAmount) };
      }
      if (address.equals(operatorAta)) {
        return { context: { slot: 1 }, value: parsedToken(CARDS, OPERATOR, operatorAmount) };
      }
      return { context: { slot: 1 }, value: null };
    },
    async getAccountInfo(address: PublicKey) {
      return address.equals(creatorAta)
        ? { owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, data: Buffer.alloc(165) }
        : null;
    },
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };
    },
    async sendRawTransaction(raw: Buffer) {
      sends += 1;
      const transaction = Transaction.from(raw);
      const transferInstruction = transaction.instructions.find(instruction => (
        instruction.data.length >= 9 && instruction.data[0] === 12
      ));
      const destination = transferInstruction?.keys[2]?.pubkey;
      const signature = destination?.equals(operatorAta)
        ? encodeBase58(transaction.signature!)
        : `sig-${sends}`;
      signatures.add(signature);
      if (unknownNext && destination?.equals(operatorAta)) {
        unknownSignatures.add(signature);
        unknownNext = false;
      }
      let transferred = 0n;
      for (const instruction of transaction.instructions) {
        if (instruction.data.length >= 9 && instruction.data[0] === 12) {
          transferred = instruction.data.readBigUInt64LE(1);
        }
      }
      if (transferred > 0n && destination?.equals(operatorAta)) {
        creatorAmount -= transferred;
        operatorAmount += transferred;
      } else if (transferred > 0n) {
        creatorAmount -= transferred;
        keeperAmount += transferred;
      } else {
        creatorAmount += claimable;
        claimable = 0n;
      }
      return signature;
    },
    async confirmTransaction(input: { signature?: string }) {
      if (input.signature && unknownSignatures.has(input.signature)) throw new Error('timeout');
      return { value: { err: null } };
    },
    async getSignatureStatuses(values: string[]) {
      return {
        context: { slot: 1 },
        value: values.map(signature => (
          unknownSignatures.has(signature)
            ? null
            : { confirmationStatus: signatures.has(signature) ? 'confirmed' : null, err: null }
        )),
      };
    },
  } as unknown as Connection;

  const pump = {
    async getCreatorVaultQuoteBalances() {
      const balances: any[] = [
        {
          mint: CARDS,
          quoteTokenProgram: options.token2022 ? SystemProgram.programId : TOKEN_PROGRAM_ID,
          total: { toString: () => claimable.toString() },
        },
      ];
      if (options.includeSol) {
        balances.push({
          mint: NATIVE_MINT,
          quoteTokenProgram: SystemProgram.programId,
          total: { toString: () => '999' },
        });
      }
      return balances;
    },
    async collectCoinCreatorFeeV2Instructions() {
      return [{
        keys: [],
        programId: SystemProgram.programId,
        data: Buffer.alloc(0),
      }];
    },
  };
  return {
    signer,
    connection,
    pump,
    logs,
    get sends() {
      return sends;
    },
    get balances() {
      return { creatorAmount, keeperAmount, operatorAmount };
    },
    unknownSignatures,
  };
}

function workerFor(
  harness: ReturnType<typeof makeHarness>,
  store: CreatorRewardsStore = new InMemoryCreatorRewardsStore(),
  cardsMint: PublicKey = CARDS,
) {
  return new CreatorRewardsWorker({
    env: {
      POKEARENA_CREATOR_REWARDS_ENABLED: 'true',
      POKEARENA_CREATOR_REWARDS_KEYPAIR: writeSigner(harness.signer),
      POKEARENA_CREATOR_REWARDS_CARDS_MINT: cardsMint.toBase58(),
      POKEARENA_PROGRAM_ID: PROGRAM_ID.toBase58(),
      POKEARENA_CREATOR_REWARDS_KEEPER: KEEPER.toBase58(),
      POKEARENA_AUTHORITY: OPERATOR.toBase58(),
      POKEARENA_CREATOR_REWARDS_OPERATOR: OPERATOR.toBase58(),
      POKEARENA_CREATOR_REWARDS_OPERATOR_TOKEN: 'test-operator-token',
      POKEARENA_CREATOR_REWARDS_MIN_CARDS_RAW: '1',
    },
    connection: harness.connection,
    pumpClient: harness.pump,
    store,
    logger: {
      info: (...args) => harness.logs.push(args),
      warn: (...args) => harness.logs.push(args),
      error: (...args) => harness.logs.push(args),
    },
  });
}

test('claims CARDS into the creator wallet and records 90/10 without sweeping', async () => {
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const result = await workerFor(harness, store).checkNow('startup');
  assert.deepEqual(splitCardsCreatorReward(100n), { gross: 100n, tournament: 90n, operator: 10n });
  assert.equal(result.claimableCardsRaw, 100n);
  assert.equal(result.sweptCardsRaw, 0n);
  assert.equal(result.tournamentAvailableRaw, 90n);
  assert.equal(result.operatorAllocatedRaw, 10n);
  assert.deepEqual(harness.balances, { creatorAmount: 100n, keeperAmount: 0n, operatorAmount: 0n });
  assert.equal(harness.sends, 1);
  const ledger = await store.getLedger(CARDS.toBase58());
  assert.equal(ledger?.grossRaw, 100);
  assert.equal(ledger?.tournamentAllocatedRaw, 90);
  assert.equal(ledger?.operatorAllocatedRaw, 10);
  assert.equal(ledger?.tournamentCommittedRaw, 0);
});

test('staging funding smoke authorization is rejected outside staging', () => {
  assert.throws(
    () => assertStagingFundingSmokeAccess({
      POKEARENA_STAGING: 'false',
      POKEARENA_STAGING_SMOKE_TOKEN: 'secret',
    }, 'secret'),
    /staging-only/,
  );
  assert.throws(
    () => assertStagingFundingSmokeAccess({
      POKEARENA_STAGING: 'true',
      POKEARENA_STAGING_SMOKE_TOKEN: 'secret',
    }, 'wrong'),
    /authorization failed/,
  );
});

test('production cannot enable the staging funding smoke harness', () => {
  assert.throws(
    () => assertStagingFundingSmokeAccess({
      NODE_ENV: 'production',
      POKEARENA_ENV: 'production',
      POKEARENA_STAGING: 'true',
      POKEARENA_STAGING_SMOKE_TOKEN: 'secret',
    }, 'secret'),
    /staging-only/,
  );
});

test('keeps claimed CARDS in the creator wallet when no tournament starts', async () => {
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');
  const again = await worker.checkNow('poll');
  assert.equal(again.tournamentAvailableRaw, 90n);
  assert.equal(again.operatorAllocatedRaw, 10n);
  assert.deepEqual(harness.balances, { creatorAmount: 100n, keeperAmount: 0n, operatorAmount: 0n });
  assert.equal(harness.sends, 1);
});

test('claims exactly the ledger operator allocation and leaves tournament allocation available', async () => {
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');

  const result = await worker.claimOperatorShare('test-operator-token');
  assert.equal(result.amountRaw, 10);
  assert.ok(result.signature);
  assert.deepEqual(harness.balances, {
    creatorAmount: 90n,
    keeperAmount: 0n,
    operatorAmount: 10n,
  });
  const ledger = await store.getLedger(CARDS.toBase58());
  assert.equal(ledger?.operatorClaimedRaw, 10);
  assert.equal(ledger?.tournamentAllocatedRaw, 90);
  assert.equal(ledger?.tournamentCommittedRaw, 0);

  const second = await worker.claimOperatorShare('test-operator-token');
  assert.equal(second.amountRaw, 0);
  assert.equal(harness.sends, 2);
});

test('concurrent operator claims collapse into one transaction', async () => {
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');

  const results = await Promise.all([
    worker.claimOperatorShare('test-operator-token'),
    worker.claimOperatorShare('test-operator-token'),
    worker.claimOperatorShare('test-operator-token'),
  ]);
  assert.equal(results.filter(result => result.amountRaw === 10).length, 1);
  assert.equal(harness.sends, 2);
  assert.equal((await store.getLedger(CARDS.toBase58()))?.operatorClaimedRaw, 10);
});

test('operator claim reconciles an unknown original signature without resubmitting', async () => {
  const unknown = new Set<string>();
  const harness = makeHarness({ claimable: 100n, unknownSignatures: unknown, unknownNext: true });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');
  await assert.rejects(
    () => worker.claimOperatorShare('test-operator-token'),
    (error: unknown) => error instanceof CreatorRewardFundingError && error.code === 'unknown',
  );
  assert.equal(harness.sends, 2);
  assert.equal((await store.getLedger(CARDS.toBase58()))?.operatorClaimedRaw, 0);

  const operation = await store.getOpen();
  assert.ok(operation?.signature);
  unknown.delete(operation.signature);
  const recovered = await worker.claimOperatorShare('test-operator-token');
  assert.equal(recovered.signature, operation.signature);
  assert.equal(harness.sends, 2);
  assert.equal((await store.getLedger(CARDS.toBase58()))?.operatorClaimedRaw, 10);
});

test('operator claim rejects unauthorized callers', async () => {
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');
  await assert.rejects(
    () => worker.claimOperatorShare('wrong-token'),
    (error: unknown) => error instanceof CreatorRewardFundingError && error.code === 'rejected',
  );
  assert.equal(harness.sends, 1);
});

test('transfers only the tournament amount from the creator wallet to the keeper', async () => {
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');
  const tournamentId = '11111111-1111-4111-8111-111111111111';
  const funded = await worker.fundTournament({ tournamentId, amountRaw: 30 });
  assert.equal(funded.signature, 'sig-2');
  assert.deepEqual(harness.balances, { creatorAmount: 70n, keeperAmount: 30n, operatorAmount: 0n });
  const ledger = await store.getLedger(CARDS.toBase58());
  assert.equal(ledger?.tournamentCommittedRaw, 30);
  assert.equal(ledger?.tournamentAllocatedRaw - ledger!.tournamentCommittedRaw, 60);
  assert.equal(ledger?.operatorAllocatedRaw, 10);
  const repeated = await worker.fundTournament({ tournamentId, amountRaw: 30 });
  assert.equal(repeated.signature, 'sig-2');
  assert.equal(harness.sends, 2);
});

test('rejects tournament funding above the remaining 90 percent allocation', async () => {
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');
  await assert.rejects(
    () => worker.fundTournament({
      tournamentId: '22222222-2222-4222-8222-222222222222',
      amountRaw: 91,
    }),
    (error: unknown) => error instanceof CreatorRewardFundingError && error.code === 'insufficient',
  );
  assert.deepEqual(harness.balances, { creatorAmount: 100n, keeperAmount: 0n, operatorAmount: 0n });
  assert.equal(harness.sends, 1);
  assert.equal((await store.getLedger(CARDS.toBase58()))?.tournamentCommittedRaw, 0);
});

test('two tournament starts cannot spend the same 90 percent allocation', async () => {
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');
  const results = await Promise.allSettled([
    worker.fundTournament({ tournamentId: '33333333-3333-4333-8333-333333333333', amountRaw: 60 }),
    worker.fundTournament({ tournamentId: '44444444-4444-4444-8444-444444444444', amountRaw: 60 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(harness.balances.keeperAmount, 60n);
  assert.equal(harness.balances.creatorAmount, 40n);
  assert.equal((await store.getLedger(CARDS.toBase58()))?.tournamentCommittedRaw, 60);
  assert.equal((await store.getLedger(CARDS.toBase58()))?.operatorAllocatedRaw, 10);
});

test('reconciles an unknown creator-to-keeper transfer without resending it', async () => {
  const unknownSignatures = new Set(['sig-2']);
  const harness = makeHarness({ claimable: 100n, unknownSignatures });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  await worker.checkNow('startup');
  const tournamentId = '55555555-5555-4555-8555-555555555555';
  await assert.rejects(
    () => worker.fundTournament({ tournamentId, amountRaw: 30 }),
    (error: unknown) => error instanceof CreatorRewardFundingError
      && error.code === 'unknown'
      && error.signature === 'sig-2',
  );
  await assert.rejects(
    () => worker.fundTournament({ tournamentId, amountRaw: 30 }),
    (error: unknown) => error instanceof CreatorRewardFundingError && error.code === 'unknown',
  );
  assert.equal(harness.sends, 2);
  unknownSignatures.delete('sig-2');
  const resolved = await worker.fundTournament({ tournamentId, amountRaw: 30 });
  assert.equal(resolved.signature, 'sig-2');
  assert.equal(harness.sends, 2);
  assert.equal(harness.balances.keeperAmount, 30n);
});

test('resumes claim and funding state after a new worker is constructed', async () => {
  const unknownSignatures = new Set(['sig-1']);
  const harness = makeHarness({ claimable: 100n, unknownSignatures });
  const store = new InMemoryCreatorRewardsStore();
  const first = workerFor(harness, store);
  await first.checkNow('poll');
  assert.equal(harness.sends, 1);
  const restarted = workerFor(harness, store);
  const credited = await restarted.checkNow('poll');
  assert.equal(harness.sends, 1);
  assert.equal(credited.tournamentAvailableRaw, 90n);
  assert.equal(credited.operatorAllocatedRaw, 10n);
  assert.equal(harness.balances.creatorAmount, 100n);
  unknownSignatures.add('sig-2');
  await assert.rejects(
    () => restarted.fundTournament({
      tournamentId: '66666666-6666-4666-8666-666666666666',
      amountRaw: 30,
    }),
    (error: unknown) => error instanceof CreatorRewardFundingError && error.code === 'unknown',
  );
  const third = workerFor(harness, store);
  unknownSignatures.delete('sig-2');
  const funded = await third.fundTournament({
    tournamentId: '66666666-6666-4666-8666-666666666666',
    amountRaw: 30,
  });
  assert.equal(funded.signature, 'sig-2');
  assert.equal(harness.sends, 2);
  assert.equal((await store.getLedger(CARDS.toBase58()))?.operatorAllocatedRaw, 10);
});

test('rejects a keeper-owned creator signer and a wrong funding destination', async () => {
  const harness = makeHarness();
  const keeperSigner = Keypair.generate();
  await assert.rejects(
    async () => {
      new CreatorRewardsWorker({
      env: {
        POKEARENA_CREATOR_REWARDS_ENABLED: 'true',
        POKEARENA_CREATOR_REWARDS_KEYPAIR: writeSigner(keeperSigner),
        POKEARENA_CREATOR_REWARDS_CARDS_MINT: CARDS.toBase58(),
        POKEARENA_PROGRAM_ID: PROGRAM_ID.toBase58(),
        POKEARENA_CREATOR_REWARDS_KEEPER: keeperSigner.publicKey.toBase58(),
      },
      connection: harness.connection,
      pumpClient: harness.pump,
      store: new InMemoryCreatorRewardsStore(),
      });
    },
    /separate from the tournament keeper/,
  );
  const wrong = makeHarness({ wrongDestination: true, claimable: 100n });
  const worker = workerFor(wrong);
  await worker.checkNow('startup');
  await assert.rejects(
    () => worker.fundTournament({
      tournamentId: '77777777-7777-4777-8777-777777777777',
      amountRaw: 30,
    }),
    /does not belong to the keeper/,
  );
  assert.equal(wrong.sends, 1);
  assert.equal(wrong.balances.keeperAmount, 0n);
});

test('does not claim or sweep SOL creator rewards', async () => {
  const harness = makeHarness({ claimable: 0n, includeSol: true });
  const result = await workerFor(harness).checkNow('poll');
  assert.equal(result.claimableCardsRaw, 0n);
  assert.equal(harness.sends, 0);
  assert.ok(harness.logs.some(entry => JSON.stringify(entry).includes('non_cards_asset_rejected')));
});

test('rejects Token-2022 CARDS creator rewards', async () => {
  const harness = makeHarness({ token2022: true });
  await assert.rejects(() => workerFor(harness).checkNow('poll'), /Token-2022/);
  assert.equal(harness.sends, 0);
});

test('rejects a configured mint that is not the expected classic CARDS mint account', async () => {
  const harness = makeHarness();
  await assert.rejects(
    () => workerFor(harness, new InMemoryCreatorRewardsStore(), Keypair.generate().publicKey).checkNow('poll'),
    /classic SPL Token mint/,
  );
  assert.equal(harness.sends, 0);
});

test('supports an immediate tournament-start reward check', async () => {
  const harness = makeHarness({ claimable: 0n });
  const result = await workerFor(harness).checkNow('tournament-start');
  assert.equal(result.claimableCardsRaw, 0n);
  assert.ok(harness.logs.some(entry => JSON.stringify(entry).includes('tournament-start')));
});

test('reconciles an unknown claim outcome without resubmitting the claim', async () => {
  const harness = makeHarness({ claimable: 100n, unknownSignatures: new Set(['sig-1']) });
  const store = new InMemoryCreatorRewardsStore();
  const worker = workerFor(harness, store);
  const first = await worker.checkNow('poll');
  assert.equal(first.sweptCardsRaw, 0n);
  assert.equal(first.tournamentAvailableRaw, 0n);
  assert.equal(harness.sends, 1);
  const second = await worker.checkNow('poll');
  assert.equal(second.tournamentAvailableRaw, 90n);
  assert.equal(second.operatorAllocatedRaw, 10n);
  assert.equal(second.sweptCardsRaw, 0n);
  assert.equal(harness.sends, 1);
  assert.equal(harness.balances.creatorAmount, 100n);
  assert.equal(harness.balances.keeperAmount, 0n);
});

test('reconciles an unknown keeper prize-funding signature without submitting another', async () => {
  const keeper = Keypair.generate();
  const harness = makeHarness({ claimable: 100n });
  const store = new InMemoryCreatorRewardsStore();
  const worker = new CreatorRewardsWorker({
    env: {
      POKEARENA_CREATOR_REWARDS_ENABLED: 'true',
      POKEARENA_CREATOR_REWARDS_KEYPAIR: writeSigner(harness.signer),
      POKEARENA_CREATOR_REWARDS_CARDS_MINT: CARDS.toBase58(),
      POKEARENA_PROGRAM_ID: PROGRAM_ID.toBase58(),
      POKEARENA_CREATOR_REWARDS_KEEPER: keeper.publicKey.toBase58(),
    },
    connection: harness.connection,
    pumpClient: harness.pump,
    store,
  });
  await worker.checkNow('startup');
  const tournamentId = '88888888-8888-4888-8888-888888888888';
  const intents = new Map<string, ChainIntentRow>();
  let prizeSubmits = 0;
  let prizeKnown = false;
  const chainStore = {
    async createIntent(input: CreateIntentInput): Promise<ChainIntentRow> {
      const existing = [...intents.values()].find(row => row.idempotencyKey === input.idempotencyKey);
      if (existing) return { ...existing, metadata: { ...existing.metadata } };
      const row: ChainIntentRow = {
        id: randomUUID(),
        kind: input.kind,
        scopeId: input.scopeId,
        asset: input.asset,
        amount: input.amount,
        status: 'created',
        idempotencyKey: input.idempotencyKey,
        tournamentId: input.tournamentId,
        metadata: { ...(input.metadata ?? {}) },
      };
      intents.set(row.id, row);
      return { ...row, metadata: { ...row.metadata } };
    },
    async setIntentStatus(id: string, status: ChainIntentStatus): Promise<ChainIntentRow> {
      const row = intents.get(id);
      if (!row) throw new Error('missing intent');
      row.status = status;
      return { ...row, metadata: { ...row.metadata } };
    },
    async mergeIntentMetadata(id: string, patch: Record<string, unknown>): Promise<ChainIntentRow> {
      const row = intents.get(id);
      if (!row) throw new Error('missing intent');
      row.metadata = { ...row.metadata, ...patch };
      return { ...row, metadata: { ...row.metadata } };
    },
    async recordPrizeReserve(): Promise<void> {},
  };
  const economy = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'localnet',
      POKEARENA_PROGRAM_ID: PROGRAM_ID.toBase58(),
      POKEARENA_POKE_MINT: Keypair.generate().publicKey.toBase58(),
      POKEARENA_CARDS_MINT: CARDS.toBase58(),
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: Keypair.generate().publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: Keypair.generate().publicKey.toBase58(),
      POKEARENA_BUYBACK_BPS: '0',
    },
    keeper,
    chainStore: chainStore as unknown as PostgresChainStore,
    creatorRewardFunder: worker,
    client: {
      configAddress: configPda(PROGRAM_ID)[0],
      getCardsAta: () => Keypair.generate().publicKey,
      async getCardsPrizeReserveState() {
        if (!prizeKnown) throw new Error('Prize reserve account was not found.');
        return { winner: PublicKey.default, cardsAmount: 30n, status: 0, winnerSet: false };
      },
      connection: {
        async getSignatureStatuses() {
          return {
            context: { slot: 1 },
            value: [prizeKnown ? { err: null, confirmationStatus: 'confirmed' } : null],
          };
        },
      },
    } as unknown as ArenaChainClient,
    submitKeeper: (instructions) => {
      prizeSubmits += 1;
      const data = Buffer.from(instructions[0]!.data);
      assert.ok(data.subarray(0, 8).equals(IX.fundCardsPrize));
      assert.equal(data.readBigUInt64LE(24), 30n);
      return Promise.resolve({ signature: 'prize-1', status: 'pending' } satisfies SentTransaction);
    },
  });
  await assert.rejects(
    () => economy.lockTournament({ tournamentId, playerIds: [], prizeCardsRaw: 30 }),
    /CARDS funding unavailable/,
  );
  await assert.rejects(
    () => economy.lockTournament({ tournamentId, playerIds: [], prizeCardsRaw: 30 }),
    /still unconfirmed/,
  );
  assert.equal(prizeSubmits, 1);
  assert.equal(harness.balances.keeperAmount, 30n);
  assert.equal(harness.sends, 2);
  prizeKnown = true;
  await economy.lockTournament({ tournamentId, playerIds: [], prizeCardsRaw: 30 });
  assert.equal(prizeSubmits, 1);
  const ledger = await store.getLedger(CARDS.toBase58());
  assert.equal(ledger?.tournamentCommittedRaw, 30);
  assert.equal(ledger?.operatorAllocatedRaw, 10);
});

test('a 1v1 SOL wager does not use the creator-reward wallet', async () => {
  const keeper = Keypair.generate();
  let fundingCalls = 0;
  const service = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'localnet',
      POKEARENA_PROGRAM_ID: PROGRAM_ID.toBase58(),
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: Keypair.generate().publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: Keypair.generate().publicKey.toBase58(),
      POKEARENA_BUYBACK_BPS: '0',
    },
    keeper,
    client: {} as ArenaChainClient,
    creatorRewardFunder: {
      async fundTournament() {
        fundingCalls += 1;
        return { signature: 'unused' };
      },
    },
  });
  await assert.rejects(
    () => service.createSolWagerDepositIntent({
      roomId: '99999999-9999-4999-8999-999999999999',
      playerId: keeper.publicKey.toBase58(),
      side: 0,
      collateralLamports: 1_000_000,
    }),
    /Chain store is required for SOL wagers/,
  );
  assert.equal(fundingCalls, 0);
});
