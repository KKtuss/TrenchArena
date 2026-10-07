import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';

import { CASUAL_FEE_BPS, OPERATOR_BPS, TREASURY_BPS } from '../src/constants';
import { initializeConfigIx } from '../src/instructions';
import {
  INIT_FEE_RESERVE_LAMPORTS,
  DEAD_STAGING_KEEPER,
  CLOSED_STAGING_PROGRAM_ID,
  DEAD_STAGING_PROGRAM_ID,
  MAINNET_GENESIS_HASH,
  MAINNET_CARDS_MINT,
  MAINNET_PROGRAM_ID,
  PRODUCTION_PROGRAM_ID,
  MainnetInitError,
  assessInitialization,
  assertMainnetEndpoint,
  assertMainnetGenesis,
  assertNotLocalTestPubkey,
  assertPokeMintAccount,
  referencePokeMintData,
  REFERENCE_POKE_METADATA_LENGTH,
  assertCardsMintAccount,
  assertProductionKeypairPath,
  decodeConfigAccount,
  deriveInitAccounts,
  initDecision,
  initializationRentLamports,
  keeperSettlementCost,
  minimumTreasuryGrossLamports,
  packConfigAccount,
  readMainnetInitRequest,
  type AccountPresence,
  type DecodedConfig,
} from '../src/mainnet-init';
import { POKE_MINT_DECIMALS, TOURNAMENT_FIELD_SIZE } from '../src/poke-units';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/token';

const PROGRAM = new PublicKey(MAINNET_PROGRAM_ID);
const FRESH_PROGRAM = PublicKey.unique().toBase58();
const ACCOUNTS = deriveInitAccounts(PROGRAM);
const AUTHORITY = PublicKey.unique().toBase58();
const MINT = PublicKey.unique().toBase58();
const CARDS_MINT = MAINNET_CARDS_MINT;
const QUOTE = PublicKey.unique().toBase58();
const KEEPER = PublicKey.unique().toBase58();
const LOCAL_KEEPER = PublicKey.unique().toBase58();

function requestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    POKEARENA_STAGING: 'true',
    POKEARENA_SOLANA_CLUSTER: 'mainnet-beta',
    POKEARENA_SOLANA_RPC: 'https://rpc.example.com',
    POKEARENA_PROGRAM_ID: FRESH_PROGRAM,
    POKEARENA_POKE_MINT: '',
    POKEARENA_CARDS_MINT: CARDS_MINT,
    POKEARENA_KEEPER: KEEPER,
    POKEARENA_QUOTE_AUTHORITY: QUOTE,
    POKEARENA_AUTHORITY_KEYPAIR: 'C:/keys/production-authority.json',
    POKEARENA_BUYBACK_BPS: '0',
    POKEARENA_MIN_BUYBACK_LAMPORTS: '50000000',
    ...overrides,
  };
}

function owned(data: Uint8Array, owner = MAINNET_PROGRAM_ID): AccountPresence {
  return { owner, data };
}

function expectedConfig(buybackBps = 0, minBuybackLamports = 50_000_000): DecodedConfig {
  return {
    authority: AUTHORITY,
    feeVault: ACCOUNTS.feeVault,
    treasuryVault: ACCOUNTS.treasuryVault,
    operatorVault: ACCOUNTS.operatorVault,
    pokeMint: MINT,
    cardsMint: CARDS_MINT,
    quoteAuthority: QUOTE,
    keeper: KEEPER,
    feeBps: BigInt(CASUAL_FEE_BPS),
    treasuryBps: BigInt(TREASURY_BPS),
    operatorBps: BigInt(OPERATOR_BPS),
    buybackBps: BigInt(buybackBps),
    minBuybackLamports: BigInt(minBuybackLamports),
    bump: ACCOUNTS.configBump,
  };
}

function vaultsPresent(): Pick<
  Parameters<typeof assessInitialization>[0],
  'feeVault' | 'treasuryVault' | 'operatorVault'
> {
  const vault = owned(Buffer.alloc(8));
  return { feeVault: vault, treasuryVault: vault, operatorVault: vault };
}

test('mainnet initialization requires explicit values and refuses local defaults', () => {
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_STAGING: undefined })),
    /POKEARENA_STAGING=true is required/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_BUYBACK_BPS: undefined })),
    /POKEARENA_BUYBACK_BPS must be set explicitly/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_MIN_BUYBACK_LAMPORTS: '' })),
    /POKEARENA_MIN_BUYBACK_LAMPORTS must be set explicitly/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_TREASURY_SEED_LAMPORTS: '2000000000' })),
    /does not deposit treasury SOL/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_SOLANA_KEYS: 'scripts/solana/keys' })),
    /does not read scripts\/solana\/keys/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_KEEPER: undefined })),
    /POKEARENA_KEEPER is required/,
  );
  assert.equal(
    readMainnetInitRequest(requestEnv({ POKEARENA_POKE_MINT: undefined })).pokeMint,
    PublicKey.default.toBase58(),
  );
  assert.equal(
    readMainnetInitRequest(requestEnv({ POKEARENA_POKE_MINT: 'unset' })).pokeMint,
    PublicKey.default.toBase58(),
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_BUYBACK_BPS: '2500' })),
    /POKEARENA_BUYBACK_BPS must be 0/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_POKE_MINT: MINT })),
    /POKEARENA_POKE_MINT must stay unset/,
  );
  const explicit = readMainnetInitRequest(requestEnv());
  assert.equal(explicit.buybackBps, 0);
  assert.equal(explicit.minBuybackLamports, 50_000_000);
  assert.equal(explicit.programId, FRESH_PROGRAM);
  assert.equal(explicit.pokeMint, PublicKey.default.toBase58());
});

test('mainnet initialization refuses devnet, testnet, and local RPC endpoints', () => {
  assert.throws(() => assertMainnetEndpoint('devnet', 'https://api.devnet.solana.com'), /refuses devnet/);
  assert.throws(() => assertMainnetEndpoint('mainnet-beta', 'http://127.0.0.1:8899'), /explicit https URL/);
  assert.throws(() => assertMainnetEndpoint('mainnet-beta', 'https://api.devnet.solana.com'), /non-mainnet RPC/);
  assert.throws(() => assertMainnetEndpoint('mainnet-beta', 'https://api.testnet.solana.com'), /non-mainnet RPC/);
  assert.throws(() => assertMainnetEndpoint('localnet', 'https://rpc.example.com'), /refuses devnet/);
  assert.doesNotThrow(() => assertMainnetEndpoint('mainnet-beta', 'https://rpc.example.com'));
  assert.throws(() => assertMainnetGenesis('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'), /not mainnet-beta/);
  assert.doesNotThrow(() => assertMainnetGenesis(MAINNET_GENESIS_HASH));
  const anotherProgram = PublicKey.unique().toBase58();
  assert.equal(
    readMainnetInitRequest(requestEnv({ POKEARENA_PROGRAM_ID: anotherProgram })).programId,
    anotherProgram,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_PROGRAM_ID: DEAD_STAGING_PROGRAM_ID })),
    /retired staging identity/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_PROGRAM_ID: CLOSED_STAGING_PROGRAM_ID })),
    /retired staging identity/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_PROGRAM_ID: PRODUCTION_PROGRAM_ID })),
    /production program, upgrade authority, or keeper/,
  );
  assert.throws(
    () => readMainnetInitRequest(requestEnv({ POKEARENA_KEEPER: DEAD_STAGING_KEEPER })),
    /retired staging identity/,
  );
});

test('mainnet initialization refuses local test keypairs and pubkeys', () => {
  const root = mkdtempSync(join(tmpdir(), 'pokearena-init-'));
  assert.throws(
    () => assertProductionKeypairPath(join(root, 'scripts', 'solana', 'keys', 'authority.json'), root),
    /local test keypair/,
  );
  assert.throws(
    () => assertProductionKeypairPath(join(root, 'scripts', 'solana', 'keys', 'keeper.json'), root),
    /local test keypair/,
  );
  assert.doesNotThrow(() => assertProductionKeypairPath(join(root, 'production', 'authority.json'), root));
  assert.throws(
    () => assertNotLocalTestPubkey('Keeper', LOCAL_KEEPER, [LOCAL_KEEPER]),
    /matches a local test key/,
  );
  assert.throws(
    () => assertNotLocalTestPubkey('Authority', MAINNET_PROGRAM_ID, []),
    /must not be a production or staging program ID/,
  );
});

test('POKE mint accepts the reference Token-2022 layout and rejects other extensions', () => {
  const bare = Buffer.alloc(82);
  bare[44] = POKE_MINT_DECIMALS;
  bare[45] = 1;
  assert.doesNotThrow(() => assertPokeMintAccount(TOKEN_2022_PROGRAM_ID, bare));
  bare[44] = 9;
  assert.throws(() => assertPokeMintAccount(TOKEN_2022_PROGRAM_ID, bare), /requires 6 decimals/);
  bare[44] = POKE_MINT_DECIMALS;
  bare[45] = 0;
  assert.throws(() => assertPokeMintAccount(TOKEN_2022_PROGRAM_ID, bare), /not initialized/);
  assert.throws(() => assertPokeMintAccount(TOKEN_PROGRAM_ID, bare), /Token-2022/);
  assert.throws(() => assertPokeMintAccount(TOKEN_2022_PROGRAM_ID, bare.subarray(0, 40)), /too small/);

  const reference = referencePokeMintData();
  assert.equal(reference.length, 412);
  assert.equal(REFERENCE_POKE_METADATA_LENGTH, 174);
  assert.doesNotThrow(() => assertPokeMintAccount(TOKEN_2022_PROGRAM_ID, reference));
  assert.throws(
    () => assertPokeMintAccount(TOKEN_2022_PROGRAM_ID, referencePokeMintData({ decimals: 9 })),
    /requires 6 decimals/,
  );
  assert.throws(
    () => assertPokeMintAccount(TOKEN_PROGRAM_ID, reference),
    /Token-2022/,
  );
  assert.throws(
    () => assertPokeMintAccount(TOKEN_2022_PROGRAM_ID, referencePokeMintData({
      extraExtension: { type: 14, length: 64 },
    })),
    /extension 14 is not supported/,
  );
  const odd = Buffer.alloc(170);
  odd[44] = POKE_MINT_DECIMALS;
  odd[45] = 1;
  assert.throws(
    () => assertPokeMintAccount(TOKEN_2022_PROGRAM_ID, odd),
    /extension header/,
  );
  const cards = Buffer.alloc(82);
  cards[44] = 6;
  cards[45] = 1;
  assert.doesNotThrow(() => assertCardsMintAccount(TOKEN_PROGRAM_ID, cards));
  assert.throws(() => assertCardsMintAccount(TOKEN_2022_PROGRAM_ID, cards), /classic SPL/);
});

test('CARDS mint must be a 6-decimal classic SPL mint', () => {
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  assert.doesNotThrow(() => assertCardsMintAccount(TOKEN_PROGRAM_ID, mint));
  mint[44] = 9;
  assert.throws(() => assertCardsMintAccount(TOKEN_PROGRAM_ID, mint), /requires 6 decimals/);
  mint[44] = 6;
  assert.throws(() => assertCardsMintAccount(PublicKey.unique(), mint), /classic SPL token mint/);
  assert.throws(() => assertCardsMintAccount(TOKEN_PROGRAM_ID, mint.subarray(0, 40)), /too small/);
});

test('config decoding matches the Pinocchio layout and a rerun recognizes it', () => {
  const packed = packConfigAccount(expectedConfig());
  assert.deepEqual(decodeConfigAccount(packed), expectedConfig());
  const common = {
    programId: MAINNET_PROGRAM_ID,
    authority: AUTHORITY,
    pokeMint: MINT,
    cardsMint: CARDS_MINT,
    quoteAuthority: QUOTE,
    keeper: KEEPER,
    buybackBps: 0,
    minBuybackLamports: 50_000_000,
    accounts: ACCOUNTS,
    ...vaultsPresent(),
  };
  assert.equal(assessInitialization({
    ...common,
    config: null,
    feeVault: null,
    treasuryVault: null,
    operatorVault: null,
  }).status, 'absent');
  assert.equal(
    assessInitialization({ ...common, config: owned(packed) }).status,
    'initialized',
  );
  const changedKeeper = packConfigAccount({ ...expectedConfig(), keeper: LOCAL_KEEPER });
  const mismatch = assessInitialization({ ...common, config: owned(changedKeeper) });
  assert.equal(mismatch.status, 'mismatch');
  if (mismatch.status === 'mismatch') {
    assert.match(mismatch.reasons.join('\n'), /keeper is/);
  }
  const partial = assessInitialization({
    ...common,
    config: null,
    feeVault: owned(Buffer.alloc(8)),
    treasuryVault: null,
    operatorVault: null,
  });
  assert.equal(partial.status, 'partial');
});

test('initialize_config encodes the explicit buyback and does not default to 2500', () => {
  const request = readMainnetInitRequest(requestEnv({ POKEARENA_BUYBACK_BPS: '0' }));
  const ix = initializeConfigIx({
    programId: PROGRAM,
    authority: new PublicKey(AUTHORITY),
    pokeMint: new PublicKey(request.pokeMint),
    quoteAuthority: new PublicKey(request.quoteAuthority),
    keeper: new PublicKey(request.keeper),
    buybackBps: request.buybackBps,
    minBuybackLamports: request.minBuybackLamports,
  });
  assert.equal(ix.data.readBigUInt64LE(8), 0n);
  assert.equal(ix.data.readBigUInt64LE(16), 50_000_000n);
  assert.equal(ix.keys[4]?.pubkey.toBase58(), PublicKey.default.toBase58());
  const explicitMint = initializeConfigIx({
    programId: PROGRAM,
    authority: new PublicKey(AUTHORITY),
    pokeMint: new PublicKey(MINT),
    quoteAuthority: new PublicKey(request.quoteAuthority),
    keeper: new PublicKey(request.keeper),
    buybackBps: 0,
    minBuybackLamports: 50_000_000,
  });
  assert.equal(explicitMint.data.readBigUInt64LE(8), 0n);
  assert.equal(explicitMint.keys[4]?.pubkey.toBase58(), MINT);
  const unset = initializeConfigIx({
    programId: PROGRAM,
    authority: new PublicKey(AUTHORITY),
    pokeMint: PublicKey.default,
    quoteAuthority: new PublicKey(request.quoteAuthority),
    keeper: new PublicKey(request.keeper),
    buybackBps: 0,
    minBuybackLamports: 50_000_000,
  });
  assert.equal(unset.keys[4]?.pubkey.toBase58(), PublicKey.default.toBase58());
  assert.equal(ix.keys[6]?.pubkey.toBase58(), KEEPER);
  assert.equal(ix.keys[7]?.pubkey.toBase58(), ACCOUNTS.config);
});

test('a matching initialization is not sent again, and a new one waits for confirmation', () => {
  assert.deepEqual(
    initDecision({
      assessment: 'initialized',
      confirm: true,
      balanceLamports: 0n,
      requiredLamports: 1n,
    }),
    {
      action: 'stop',
      exitCode: 0,
      message: 'Config is already initialized with these values. No transaction will be sent.',
    },
  );
  const unconfirmed = initDecision({
    assessment: 'absent',
    confirm: false,
    balanceLamports: 100n,
    requiredLamports: 100n,
  });
  assert.equal(unconfirmed.action, 'stop');
  assert.equal(unconfirmed.exitCode, 2);
  assert.match(unconfirmed.message, /No funds were moved/);
  assert.equal(initDecision({
    assessment: 'mismatch',
    confirm: true,
    balanceLamports: 100n,
    requiredLamports: 1n,
  }).exitCode, 1);
  assert.equal(initDecision({
    assessment: 'absent',
    confirm: true,
    balanceLamports: 10n,
    requiredLamports: 11n,
  }).exitCode, 1);
  assert.equal(initDecision({
    assessment: 'absent',
    confirm: true,
    balanceLamports: 11n,
    requiredLamports: 11n,
  }).action, 'send');
});

test('keeper settlement cost covers 32 burns exactly once and treasury funding stays separate', () => {
  const rent = (space: number) => (space + 128) * 5_080;
  const cost = keeperSettlementCost(rent);
  assert.equal(cost.tournamentTransactions, TOURNAMENT_FIELD_SIZE + 2);
  const expected = rent(163) + rent(165) + ((TOURNAMENT_FIELD_SIZE + 2) * rent(42)) + (cost.tournamentTransactions * 5_000);
  assert.equal(cost.perTournamentLamports, expected);
  assert.equal(initializationRentLamports(rent), rent(305) + (3 * rent(8)));
  assert.equal(minimumTreasuryGrossLamports(100_000_000n), 111_111_112n);
  const gross = minimumTreasuryGrossLamports(100_000_000n);
  assert.ok((gross * 9_000n) / 10_000n >= 100_000_000n);
  assert.ok(((gross - 1n) * 9_000n) / 10_000n < 100_000_000n);
  assert.equal(INIT_FEE_RESERVE_LAMPORTS, 10_000_000);
  assert.ok(cost.perTournamentLamports > INIT_FEE_RESERVE_LAMPORTS);
});

test('MainnetInitError is the refusal type', () => {
  assert.ok(new MainnetInitError('stop') instanceof MainnetInitError);
});
