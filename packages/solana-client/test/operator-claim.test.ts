/**
 * Executes claim_operator_fees against the built Pinocchio BPF artifact.
 * The Anchor artifact aborts LiteSVM while loading (std::bad_alloc), so that
 * path is opt-in via POKEARENA_OPERATOR_CLAIM_ANCHOR_LITESVM=1 and is executed
 * on solana-test-validator instead. LiteSVM is local-only and does not contact Mainnet.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  CASUAL_FEE_BPS,
  OPERATOR_BPS,
  TREASURY_BPS,
  claimOperatorFeesIx,
  configPda,
  depositTreasurySolIx,
  feeVaultPda,
  initializeConfigIx,
  operatorVaultPda,
  previewTreasurySplit,
  treasuryVaultPda,
} from '../src/index';
import { TOKEN_PROGRAM_ID } from '../src/token';

const PROGRAM_ID = new PublicKey('6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98');
const UNAUTHORIZED = 6002;
const INSUFFICIENT_FUNDS = 6015;
const ARTIFACTS = [
  ['pinocchio', join(__dirname, '../../../../target/deploy/arena_escrow_pinocchio.so')],
  ...(process.env.POKEARENA_OPERATOR_CLAIM_ANCHOR_LITESVM === '1'
    ? [['anchor', join(__dirname, '../../../../target/deploy/arena_escrow.so')] as const]
    : []),
] as const;

type Svm = {
  addProgramFromFile: (id: PublicKey, path: string) => void;
  setAccount: (address: PublicKey, account: {
    lamports: number;
    data: Buffer;
    owner: PublicKey;
    executable: boolean;
    rentEpoch: number;
  }) => void;
  airdrop: (address: PublicKey, lamports: bigint) => unknown;
  getAccount: (address: PublicKey) => { data: Uint8Array; lamports: number } | null;
  latestBlockhash: () => string;
  sendTransaction: (tx: Transaction) => unknown;
  expireBlockhash?: () => void;
  minimumBalanceForRentExemption: (n: bigint) => bigint;
};

let LiteSVM: (new () => Svm) | null = null;
let FailedTransactionMetadata: (new (...args: never[]) => unknown) | null = null;
let loadError: string | null = null;
try {
  const mod = require('litesvm') as {
    LiteSVM: new () => Svm;
    FailedTransactionMetadata: new (...args: never[]) => unknown;
  };
  LiteSVM = mod.LiteSVM;
  FailedTransactionMetadata = mod.FailedTransactionMetadata;
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error);
}

function loadSvm(soPath: string): Svm {
  if (!LiteSVM) throw new Error(loadError ?? 'litesvm unavailable');
  const localSo = join(tmpdir(), `${basename(soPath)}.${process.pid}.${Date.now()}.so`);
  copyFileSync(soPath, localSo);
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM_ID, localSo);
  return svm;
}

function send(svm: Svm, payer: Keypair, ixs: TransactionInstruction[], extra: Keypair[] = []): unknown {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: svm.latestBlockhash(),
  }).add(...ixs);
  tx.sign(payer, ...extra);
  const result = svm.sendTransaction(tx);
  svm.expireBlockhash?.();
  return result;
}

function failed(result: unknown): boolean {
  return Boolean(FailedTransactionMetadata && result instanceof FailedTransactionMetadata);
}

function customError(result: unknown): number | null {
  if (!failed(result)) return null;
  try {
    const meta = (result as { meta?: () => { logs?: () => string[] } }).meta?.();
    const logs = meta?.logs?.() ?? [];
    const match = logs.join('\n').match(/custom program error: 0x([0-9a-f]+)/i);
    return match ? Number.parseInt(match[1], 16) : null;
  } catch {
    return null;
  }
}

function assertError(result: unknown, code: number): void {
  assert.equal(failed(result), true);
  assert.equal(customError(result), code);
}

function lamports(svm: Svm, address: PublicKey): number {
  return svm.getAccount(address)?.lamports ?? 0;
}

function key32(label: string): Buffer {
  return createHash('sha256').update(label).digest();
}

function installMint(svm: Svm, mint: PublicKey): void {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(0n, 36);
  data[44] = 6;
  data[45] = 1;
  svm.setAccount(mint, {
    lamports: Number(svm.minimumBalanceForRentExemption(82n)),
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
}

function claimIx(authority: PublicKey, vault: PublicKey, destination: PublicKey): TransactionInstruction {
  return claimOperatorFeesIx({
    programId: PROGRAM_ID,
    authority,
    operatorVault: vault,
    destination,
  });
}

for (const [engine, soPath] of ARTIFACTS) {
  test(`${engine}: claim_operator_fees preserves economics, rent, and authorization`, {
    skip: !LiteSVM || !existsSync(soPath) ? (loadError ?? `${engine} artifact missing`) : false,
  }, () => {
    assert.equal(CASUAL_FEE_BPS, 200);
    assert.equal(TREASURY_BPS, 9000);
    assert.equal(OPERATOR_BPS, 1000);

    const svm = loadSvm(soPath);
    const authority = Keypair.generate();
    const keeper = Keypair.generate();
    const player = Keypair.generate();
    const stranger = Keypair.generate();
    const mint = Keypair.generate();
    for (const wallet of [authority, keeper, player, stranger]) {
      svm.airdrop(wallet.publicKey, BigInt(50 * LAMPORTS_PER_SOL));
    }
    installMint(svm, mint.publicKey);

    const initialized = send(svm, authority, [
      initializeConfigIx({
        programId: PROGRAM_ID,
        authority: authority.publicKey,
        pokeMint: mint.publicKey,
        quoteAuthority: authority.publicKey,
        keeper: keeper.publicKey,
        buybackBps: 0,
        minBuybackLamports: 50_000_000,
      }),
    ]);
    assert.equal(failed(initialized), false, `initialize failed ${customError(initialized)}`);

    const [config] = configPda(PROGRAM_ID);
    const [operatorVault] = operatorVaultPda(PROGRAM_ID);
    const [treasuryVault] = treasuryVaultPda(PROGRAM_ID);
    const [feeVault] = feeVaultPda(PROGRAM_ID);
    const rent = Number(svm.minimumBalanceForRentExemption(8n));
    assert.equal(lamports(svm, operatorVault), rent);
    assert.equal(lamports(svm, treasuryVault), rent);
    assert.equal(lamports(svm, feeVault), rent);
    const configAccount = svm.getAccount(config);
    assert.ok(configAccount);
    assert.equal(new PublicKey(configAccount.data.subarray(136, 168)).equals(mint.publicKey), true);

    const empty = send(svm, authority, [claimIx(authority.publicKey, operatorVault, authority.publicKey)]);
    assertError(empty, INSUFFICIENT_FUNDS);
    assert.equal(lamports(svm, operatorVault), rent);

    function deposit(gross: number, label: string): void {
      const split = previewTreasurySplit(gross);
      assert.equal(split.treasuryLamports, Number((BigInt(gross) * 9000n) / 10_000n));
      assert.equal(split.operatorLamports, gross - split.treasuryLamports);
      const treasuryBefore = lamports(svm, treasuryVault);
      const operatorBefore = lamports(svm, operatorVault);
      const result = send(svm, authority, [
        depositTreasurySolIx({
          programId: PROGRAM_ID,
          authority: authority.publicKey,
          payer: authority.publicKey,
          config,
          treasuryVault,
          operatorVault,
          claimKey: key32(`${engine}:${label}:${gross}`),
          grossLamports: gross,
        }),
      ]);
      assert.equal(failed(result), false, `deposit ${label} failed ${customError(result)}`);
      assert.equal(lamports(svm, treasuryVault) - treasuryBefore, split.treasuryLamports);
      assert.equal(lamports(svm, operatorVault) - operatorBefore, split.operatorLamports);
    }

    function claim(expected: number): void {
      const vaultBefore = lamports(svm, operatorVault);
      const authorityBefore = lamports(svm, authority.publicKey);
      const treasuryBefore = lamports(svm, treasuryVault);
      const feeBefore = lamports(svm, feeVault);
      const result = send(svm, authority, [claimIx(authority.publicKey, operatorVault, authority.publicKey)]);
      assert.equal(failed(result), false, `claim failed ${customError(result)}`);
      const vaultAfter = lamports(svm, operatorVault);
      const authorityAfter = lamports(svm, authority.publicKey);
      const withdrawn = vaultBefore - vaultAfter;
      const fee = withdrawn - (authorityAfter - authorityBefore);
      assert.equal(withdrawn, expected);
      assert.equal(vaultAfter, rent);
      assert.ok(fee > 0 && fee < 20_000);
      assert.equal(vaultBefore + authorityBefore, vaultAfter + authorityAfter + fee);
      assert.equal(lamports(svm, treasuryVault), treasuryBefore);
      assert.equal(lamports(svm, feeVault), feeBefore);
    }

    function reject(signer: Keypair, destination: PublicKey, vault: PublicKey, code: number): void {
      const vaultBefore = lamports(svm, operatorVault);
      const treasuryBefore = lamports(svm, treasuryVault);
      const destinationBefore = lamports(svm, destination);
      const result = send(svm, signer, [claimIx(signer.publicKey, vault, destination)]);
      assertError(result, code);
      assert.equal(lamports(svm, operatorVault), vaultBefore);
      assert.equal(lamports(svm, treasuryVault), treasuryBefore);
      if (!destination.equals(signer.publicKey)) {
        assert.equal(lamports(svm, destination), destinationBefore);
      }
    }

    deposit(1, 'rent-plus-one');
    assert.equal(lamports(svm, operatorVault), rent + 1);
    claim(1);
    reject(authority, authority.publicKey, operatorVault, INSUFFICIENT_FUNDS);

    const meaningful = 1_000_000_000;
    const meaningfulOperator = previewTreasurySplit(meaningful).operatorLamports;
    deposit(meaningful, 'meaningful');
    reject(keeper, keeper.publicKey, operatorVault, UNAUTHORIZED);
    reject(player, player.publicKey, operatorVault, UNAUTHORIZED);
    reject(stranger, stranger.publicKey, operatorVault, UNAUTHORIZED);
    reject(authority, keeper.publicKey, operatorVault, UNAUTHORIZED);
    reject(authority, player.publicKey, operatorVault, UNAUTHORIZED);
    reject(authority, authority.publicKey, treasuryVault, UNAUTHORIZED);
    reject(authority, authority.publicKey, feeVault, UNAUTHORIZED);
    assert.equal(lamports(svm, operatorVault), rent + meaningfulOperator);
    claim(meaningfulOperator);
    reject(authority, authority.publicKey, operatorVault, INSUFFICIENT_FUNDS);

    const repeat = 101;
    const repeatOperator = previewTreasurySplit(repeat).operatorLamports;
    assert.equal(repeatOperator, 11);
    deposit(repeat, 'repeat');
    claim(repeatOperator);
    reject(authority, authority.publicKey, operatorVault, INSUFFICIENT_FUNDS);

    const treasuryExpected = rent
      + previewTreasurySplit(1).treasuryLamports
      + previewTreasurySplit(meaningful).treasuryLamports
      + previewTreasurySplit(repeat).treasuryLamports;
    assert.equal(lamports(svm, treasuryVault), treasuryExpected);
    assert.equal(lamports(svm, feeVault), rent);
    assert.equal(lamports(svm, operatorVault), rent);
  });
}
