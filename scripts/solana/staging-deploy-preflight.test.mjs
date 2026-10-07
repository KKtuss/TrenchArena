import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  BUFFER_METADATA_LEN,
  CANONICAL_CARDS_MINT,
  DEAD_STAGING_AUTHORITY,
  DEAD_STAGING_DEPLOYER,
  DEAD_STAGING_KEEPER,
  DEAD_STAGING_PROGRAM_ID,
  PRODUCTION_KEEPER,
  PRODUCTION_PROGRAM_ID,
  PRODUCTION_UPGRADE_AUTHORITY,
  PROGRAMDATA_METADATA_LEN,
  SAFETY_FLOOR_LAMPORTS,
  UPGRADEABLE_LOADER_ID,
  ZERO_PUBKEY,
  StagingDeployError,
  assertStagingDeployIdentity,
  evaluateStagingIdentities,
  planStagingDeploy,
  redactRpc,
} from './staging-deploy-preflight.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'packages/solana-client/package.json'));
const { PublicKey } = require('@solana/web3.js');

const PROGRAM_DATA = PublicKey.unique().toBase58();
const PROGRAM = PublicKey.unique().toBase58();
const DEPLOYER = PublicKey.unique().toBase58();
const AUTHORITY = PublicKey.unique().toBase58();
const KEEPER = PublicKey.unique().toBase58();
const RENT_PROGRAM = 833_120n;
const RENT_DATA = 498_149_880n;
const RENT_BUFFER = 498_109_240n;

function env(overrides = {}) {
  return {
    POKEARENA_STAGING: 'true',
    POKEARENA_SOLANA_CLUSTER: 'mainnet-beta',
    POKEARENA_SOLANA_RPC: 'https://rpc.example.com',
    POKEARENA_PROGRAM_ID: PROGRAM,
    POKEARENA_DEPLOYER: DEPLOYER,
    POKEARENA_AUTHORITY: AUTHORITY,
    POKEARENA_KEEPER: KEEPER,
    POKEARENA_CARDS_MINT: CANONICAL_CARDS_MINT,
    POKEARENA_POKE_MINT: '',
    POKEARENA_BUYBACK_BPS: '0',
    ...overrides,
  };
}

function pubkeys(overrides = {}) {
  return {
    deployerPubkey: DEPLOYER,
    programPubkey: PROGRAM,
    authorityPubkey: AUTHORITY,
    keeperPubkey: KEEPER,
    ...overrides,
  };
}

function identity() {
  return assertStagingDeployIdentity(env(), pubkeys());
}

function programAccount() {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  new PublicKey(PROGRAM_DATA).toBuffer().copy(data, 4);
  return {
    owner: UPGRADEABLE_LOADER_ID,
    executable: true,
    lamports: Number(RENT_PROGRAM),
    data,
  };
}

function programDataAccount(authority = DEPLOYER) {
  const data = Buffer.alloc(45 + 8);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(1n, 4);
  data[12] = 1;
  new PublicKey(authority).toBuffer().copy(data, 13);
  return {
    owner: UPGRADEABLE_LOADER_ID,
    executable: false,
    lamports: Number(RENT_DATA),
    data,
  };
}

function configAccount() {
  const data = Buffer.alloc(305);
  data.set([0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82], 0);
  new PublicKey(AUTHORITY).toBuffer().copy(data, 8);
  new PublicKey(ZERO_PUBKEY).toBuffer().copy(data, 136);
  new PublicKey(KEEPER).toBuffer().copy(data, 200);
  data.writeBigUInt64LE(0n, 256);
  new PublicKey(CANONICAL_CARDS_MINT).toBuffer().copy(data, 273);
  return {
    owner: PROGRAM,
    executable: false,
    lamports: 2_199_640,
    data,
  };
}

function plan(overrides = {}) {
  const { confirm = false, ...rest } = overrides;
  return planStagingDeploy({
    confirm,
    identity: { ...identity(), genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
    artifact: {
      path: 'target/deploy/arena_escrow_pinocchio.so',
      bytes: 97_888,
      sha256: 'abc',
    },
    payerBalanceLamports: RENT_DATA + SAFETY_FLOOR_LAMPORTS,
    programAccount: null,
    programDataAccount: null,
    configAccount: null,
    programAccountRentLamports: RENT_PROGRAM,
    programDataRentLamports: RENT_DATA,
    bufferRentLamports: RENT_BUFFER,
    ...rest,
  });
}

test('A. fresh staging program is an initial deploy and stays dry until confirmed', () => {
  const dry = plan();
  assert.equal(dry.mode, 'initial');
  assert.equal(dry.wouldSendTransaction, false);
  assert.equal(dry.initializeConfig, false);
  assert.equal(dry.transactionsSent, 0);
  assert.equal(dry.exitCode, 2);
  assert.match(dry.report, /this invocation would send a transaction: no/);

  const confirmed = plan({ confirm: true });
  assert.equal(confirmed.mode, 'initial');
  assert.equal(confirmed.wouldSendTransaction, true);
  assert.equal(confirmed.initializeConfig, false);
  assert.equal(confirmed.closeAccounts, false);
  assert.equal(confirmed.exitCode, 0);
  assert.equal(confirmed.transactionFeesLamports, null);
  assert.equal(confirmed.additionalBalanceLamports, 0n);
});

test('B. existing program and ProgramData is an upgrade only when the authority matches', () => {
  const dry = plan({
    programAccount: programAccount(),
    programDataAccount: programDataAccount(),
  });
  assert.equal(dry.mode, 'upgrade');
  assert.equal(dry.wouldSendTransaction, false);
  assert.equal(dry.exitCode, 2);

  const confirmed = plan({
    confirm: true,
    programAccount: programAccount(),
    programDataAccount: programDataAccount(),
  });
  assert.equal(confirmed.wouldSendTransaction, true);
  assert.equal(confirmed.exitCode, 0);
  assert.equal(confirmed.initializeConfig, false);

  const wrongAuthority = plan({
    confirm: true,
    programAccount: programAccount(),
    programDataAccount: programDataAccount(PRODUCTION_UPGRADE_AUTHORITY),
  });
  assert.equal(wrongAuthority.wouldSendTransaction, false);
  assert.equal(wrongAuthority.exitCode, 1);
  assert.match(wrongAuthority.blocker, /upgrade authority/);
});

test('C. existing program with missing ProgramData is recognized and not sent', () => {
  const closed = plan({
    confirm: true,
    programAccount: programAccount(),
    programDataAccount: null,
    configAccount: configAccount(),
  });
  assert.equal(closed.mode, 'closed-programdata');
  assert.equal(closed.program.programDataAddress, PROGRAM_DATA);
  assert.equal(closed.wouldSendTransaction, false);
  assert.equal(closed.transactionsSent, 0);
  assert.equal(closed.exitCode, 3);
  assert.equal(closed.initializeConfig, false);
  assert.equal(closed.closeAccounts, false);
  assert.match(closed.blocker, /has been closed, use a new Program Id/);
  assert.match(closed.report, /ProgramData state: NOT FOUND/);
  assert.match(closed.report, /same-ID redeploy: blocked by solana-cli 4\.2\.2/);
});

test('D. existing staging config is not initialized again', () => {
  const result = plan({
    confirm: true,
    programAccount: programAccount(),
    programDataAccount: programDataAccount(),
    configAccount: configAccount(),
  });
  assert.equal(result.config.exists, true);
  assert.equal(result.config.matches, true);
  assert.equal(result.initializeConfig, false);
  assert.match(result.report, /config already exists: yes/);
  assert.match(result.report, /initialize_config: no/);
  assert.doesNotMatch(result.report, /initialize_config: yes/);
});

test('E. production ID is rejected while staging mode is enabled', () => {
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_PROGRAM_ID: PRODUCTION_PROGRAM_ID }), pubkeys()),
    /production program/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env(), pubkeys({ deployerPubkey: PRODUCTION_UPGRADE_AUTHORITY })),
    /production program, upgrade authority, or keeper/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_AUTHORITY: PRODUCTION_UPGRADE_AUTHORITY }), pubkeys()),
    /production program, upgrade authority, or keeper/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_KEEPER: PRODUCTION_KEEPER }), pubkeys()),
    /production program, upgrade authority, or keeper/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_STAGING: 'false' }), pubkeys()),
    /POKEARENA_STAGING=true/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_BUYBACK_BPS: '1' }), pubkeys()),
    /POKEARENA_BUYBACK_BPS must be 0/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_POKE_MINT: PublicKey.unique().toBase58() }), pubkeys()),
    /must stay unset/,
  );
  assert.equal(assertStagingDeployIdentity(env(), pubkeys()).pokeMint, ZERO_PUBKEY);
  assert.equal(PROGRAMDATA_METADATA_LEN, 45);
  assert.equal(BUFFER_METADATA_LEN, 37);
});

test('F. dry-run produces zero transactions', () => {
  for (const fixture of [
    {},
    { programAccount: programAccount(), programDataAccount: programDataAccount() },
    { programAccount: programAccount(), programDataAccount: null },
    { configAccount: configAccount() },
  ]) {
    const dry = plan(fixture);
    assert.equal(dry.wouldSendTransaction, false);
    assert.equal(dry.transactionsSent, 0);
    assert.match(dry.report, /this invocation would send a transaction: no/);
    assert.match(dry.report, /preflight transactions sent: 0/);
    assert.equal(dry.transactionFeesLamports, null);
  }

  const script = readFileSync(new URL('./deploy-pinocchio-mainnet.sh', import.meta.url), 'utf8');
  assert.match(script, /PREFLIGHT_STATUS/);
  assert.match(script, /if \[\[ "\$CONFIRM" -ne 1 \]\]/);
  assert.match(script, /IDENTITIES_READY/);
  assert.match(script, /refusing retired staging program/);
  assert.doesNotMatch(script, /CONFIGURED_PROGRAM_ID" == "6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98"/);
  assert.doesNotMatch(script, /init-pinocchio-mainnet/);
  assert.doesNotMatch(script, /initialize_config/);
  assert.doesNotMatch(script, /program close/);
  assert.doesNotMatch(script, /solana program show/);
  const deployAt = script.indexOf('solana "${DEPLOY_ARGS[@]}"');
  const guardAt = script.indexOf('PREFLIGHT_STATUS" -ne 0');
  assert.ok(guardAt > 0 && deployAt > guardAt);

  const preflight = readFileSync(new URL('./staging-deploy-preflight.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(preflight, /sendTransaction|sendRawTransaction|program deploy/);
});

test('RPC query secrets are redacted and the safety floor stays separate from rent', () => {
  const redacted = redactRpc('https://mainnet.helius-rpc.com/?api-key=secret-value');
  assert.match(redacted, /api-key=REDACTED/);
  assert.doesNotMatch(redacted, /secret-value/);
  const dry = plan();
  assert.match(dry.report, /script safety floor is not a measured transaction fee/);
  assert.match(dry.report, /transaction fees: NOT MEASURED/);
  assert.equal(dry.safetyFloorLamports, 50_000_000n);
  assert.equal(dry.programDataRentLamports, RENT_DATA);
  assert.throws(() => assertStagingDeployIdentity(env({ POKEARENA_CARDS_MINT: PublicKey.unique().toBase58() }), pubkeys()), StagingDeployError);
  assert.match(dry.report, new RegExp(PROGRAM));
  assert.match(dry.report, new RegExp(DEPLOYER));
  assert.match(dry.report, new RegExp(AUTHORITY));
  assert.match(dry.report, new RegExp(KEEPER));
  assert.match(dry.report, /Mainnet generation: NOT PERFORMED/);
  assert.match(dry.report, /Mainnet funding: NOT PERFORMED/);
});

test('fresh staging signers are independent and the retired identities are rejected', () => {
  const accepted = assertStagingDeployIdentity(env(), pubkeys());
  assert.equal(accepted.programId, PROGRAM);
  assert.equal(accepted.deployer, DEPLOYER);
  assert.equal(accepted.authority, AUTHORITY);
  assert.equal(accepted.keeper, KEEPER);
  assert.equal(accepted.pokeMint, ZERO_PUBKEY);
  assert.equal(accepted.buybackBps, 0);

  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_PROGRAM_ID: DEAD_STAGING_PROGRAM_ID }), pubkeys({ programPubkey: DEAD_STAGING_PROGRAM_ID })),
    /retired staging identity/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env(), pubkeys({ deployerPubkey: DEAD_STAGING_DEPLOYER })),
    /retired staging identity/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_AUTHORITY: DEAD_STAGING_AUTHORITY }), pubkeys()),
    /retired staging identity/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_KEEPER: DEAD_STAGING_KEEPER }), pubkeys()),
    /retired staging identity/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(
      env({ POKEARENA_DEPLOYER: PROGRAM }),
      pubkeys({ deployerPubkey: PROGRAM }),
    ),
    /Deployer must be distinct from the program ID/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_AUTHORITY: DEPLOYER }), pubkeys({ authorityPubkey: DEPLOYER })),
    /Config authority must be distinct from the deployer/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_KEEPER: DEPLOYER }), pubkeys({ keeperPubkey: DEPLOYER })),
    /Keeper must be distinct from the deployer/,
  );
  assert.throws(
    () => assertStagingDeployIdentity(env({ POKEARENA_KEEPER: AUTHORITY }), pubkeys({ keeperPubkey: AUTHORITY })),
    /Keeper must be distinct from the config authority/,
  );

  const missing = evaluateStagingIdentities(env({
    POKEARENA_PROGRAM_ID: '',
    POKEARENA_DEPLOYER: '',
    POKEARENA_AUTHORITY: '',
    POKEARENA_KEEPER: '',
  }), {
    deployerPubkey: '',
    programPubkey: '',
  });
  assert.equal(missing.ok, false);
  assert.match(missing.report, /program ID: NOT GENERATED/);
  assert.match(missing.report, /deployer: NOT GENERATED/);
  assert.match(missing.report, /config authority: NOT GENERATED/);
  assert.match(missing.report, /keeper: NOT GENERATED/);
  assert.match(missing.report, /Mainnet generation: NOT PERFORMED/);
  assert.match(missing.report, /Mainnet funding: NOT PERFORMED/);
  assert.match(missing.report, /does not generate or fund Mainnet identities/);
});
