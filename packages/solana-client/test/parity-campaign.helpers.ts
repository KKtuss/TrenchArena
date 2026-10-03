/**
 * Test-only helpers for the Anchor↔Pinocchio local parity campaign.
 * Not used by production code paths.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SendTransactionError,
} from '@solana/web3.js';
import { configPda } from '../src/pdas';

export type CaseOutcome = {
  id: string;
  ix: string;
  category: string;
  ok: boolean;
  /** Anchor-compatible custom code (6000+N) when parseable; else null. */
  customError: number | null;
  /** Truncated raw error text for debugging non-custom failures. */
  errorText: string | null;
  /** Coarse class used for differential compare when codes differ in framework noise. */
  expectReject: boolean;
  /** Program-owned account snapshots (data hash + lamports). */
  accounts: Record<string, { exists: boolean; lamports: number; dataSha256: string | null; owner: string | null }>;
  /** Named balance deltas measured around the attempt. */
  deltas: Record<string, number>;
  note?: string;
};

export type CampaignReport = {
  impl: string;
  programId: string;
  programDataLen: number | null;
  startedAt: string;
  finishedAt: string;
  cases: CaseOutcome[];
  summary: { total: number; ok: number; rejected: number; unexpectedOk: number; unexpectedReject: number };
};

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

export function envEnabled(): boolean {
  return (process.env.POKEARENA_CHAIN_ECONOMY ?? '').toLowerCase() === 'true';
}

export async function rpcReady(rpc: string): Promise<boolean> {
  try {
    const connection = new Connection(rpc, 'confirmed');
    await connection.getVersion();
    return true;
  } catch {
    return false;
  }
}

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Deterministic 16-byte room/tournament id from a stable label. */
export function labeledId16(label: string): Buffer {
  return createHash('sha256').update(`parity16:${label}`).digest().subarray(0, 16);
}

/** Deterministic 32-byte key from a stable label. */
export function labeledKey32(label: string): Buffer {
  return createHash('sha256').update(`parity32:${label}`).digest();
}

export function parseCustomError(err: unknown): number | null {
  const msg =
    err instanceof Error
      ? `${err.message}\n${err instanceof SendTransactionError ? (err.logs ?? []).join('\n') : ''}`
      : String(err);
  const hex = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/i);
  if (hex) return Number.parseInt(hex[1], 16);
  const dec = msg.match(/Custom["\s:]*(\d+)/);
  if (dec) return Number.parseInt(dec[1], 10);
  return null;
}

export async function snapshotAccounts(
  connection: Connection,
  named: Record<string, PublicKey>,
): Promise<CaseOutcome['accounts']> {
  const out: CaseOutcome['accounts'] = {};
  for (const [name, pk] of Object.entries(named)) {
    const info = await connection.getAccountInfo(pk, 'confirmed');
    if (!info) {
      out[name] = { exists: false, lamports: 0, dataSha256: null, owner: null };
    } else {
      out[name] = {
        exists: true,
        lamports: info.lamports,
        dataSha256: sha256Hex(Buffer.from(info.data)),
        owner: info.owner.toBase58(),
      };
    }
  }
  return out;
}

export async function sendIx(input: {
  connection: Connection;
  payer: Keypair;
  signers?: Keypair[];
  ix: TransactionInstruction | TransactionInstruction[];
}): Promise<{ ok: true } | { ok: false; customError: number | null; errorText: string; error: unknown }> {
  try {
    const { blockhash, lastValidBlockHeight } = await input.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({
      feePayer: input.payer.publicKey,
      blockhash,
      lastValidBlockHeight,
    });
    const ixs = Array.isArray(input.ix) ? input.ix : [input.ix];
    for (const ix of ixs) tx.add(ix);
    await sendAndConfirmTransaction(input.connection, tx, [input.payer, ...(input.signers ?? [])], {
      commitment: 'confirmed',
    });
    return { ok: true };
  } catch (error) {
    let errorText = error instanceof Error ? error.message : String(error);
    if (error instanceof SendTransactionError) {
      try {
        const logs = await error.getLogs(input.connection);
        errorText = `${errorText}\n${logs.join('\n')}`;
      } catch {
        if (error.logs?.length) errorText = `${errorText}\n${error.logs.join('\n')}`;
      }
    }
    return { ok: false, customError: parseCustomError(errorText), errorText: errorText.slice(0, 1500), error };
  }
}

export async function runCase(input: {
  id: string;
  ix: string;
  category: string;
  expectOk: boolean;
  connection: Connection;
  payer: Keypair;
  signers?: Keypair[];
  instruction: TransactionInstruction | TransactionInstruction[];
  watch?: Record<string, PublicKey>;
  deltaKeys?: Record<string, PublicKey>;
  note?: string;
}): Promise<CaseOutcome> {
  const beforeBalances: Record<string, number> = {};
  if (input.deltaKeys) {
    for (const [k, pk] of Object.entries(input.deltaKeys)) {
      beforeBalances[k] = await input.connection.getBalance(pk, 'confirmed');
    }
  }

  const result = await sendIx({
    connection: input.connection,
    payer: input.payer,
    signers: input.signers,
    ix: input.instruction,
  });

  const deltas: Record<string, number> = {};
  if (input.deltaKeys) {
    for (const [k, pk] of Object.entries(input.deltaKeys)) {
      const after = await input.connection.getBalance(pk, 'confirmed');
      deltas[k] = after - beforeBalances[k];
    }
  }

  const accounts = input.watch
    ? await snapshotAccounts(input.connection, input.watch)
    : {};

  return {
    id: input.id,
    ix: input.ix,
    category: input.category,
    ok: result.ok,
    customError: result.ok ? null : result.customError,
    errorText: result.ok ? null : result.errorText,
    expectReject: !input.expectOk,
    accounts,
    deltas,
    note: input.note,
  };
}

export function assertCase(outcome: CaseOutcome): void {
  if (outcome.expectReject && outcome.ok) {
    throw new Error(`expected reject for ${outcome.id} but tx succeeded`);
  }
  if (!outcome.expectReject && !outcome.ok) {
    throw new Error(
      `expected ok for ${outcome.id} but rejected customError=${outcome.customError} err=${outcome.errorText ?? ''}`,
    );
  }
}

export function finalizeReport(partial: Omit<CampaignReport, 'finishedAt' | 'summary'>): CampaignReport {
  const unexpectedOk = partial.cases.filter((c) => c.expectReject && c.ok).length;
  const unexpectedReject = partial.cases.filter((c) => !c.expectReject && !c.ok).length;
  return {
    ...partial,
    finishedAt: new Date().toISOString(),
    summary: {
      total: partial.cases.length,
      ok: partial.cases.filter((c) => c.ok).length,
      rejected: partial.cases.filter((c) => !c.ok).length,
      unexpectedOk,
      unexpectedReject,
    },
  };
}

export function maybeWriteReport(report: CampaignReport): string | null {
  const out = process.env.POKEARENA_PARITY_OUT;
  if (!out) return null;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  return out;
}

export type Ctx = {
  connection: Connection;
  programId: PublicKey;
  authority: Keypair;
  keeper: Keypair;
  player1: Keypair;
  player2: Keypair;
  config: PublicKey;
  feeVault: PublicKey;
  treasuryVault: PublicKey;
  operatorVault: PublicKey;
  pokeMint: PublicKey;
  keyDir: string;
  impl: string;
};

export async function loadCtx(): Promise<Ctx | null> {
  if (!envEnabled()) return null;
  const rpc = process.env.POKEARENA_SOLANA_RPC || 'http://127.0.0.1:8899';
  if (!(await rpcReady(rpc))) return null;
  const programIdStr = process.env.POKEARENA_PROGRAM_ID;
  const keyDir =
    process.env.POKEARENA_SOLANA_KEYS || join(__dirname, '../../../scripts/solana/keys');
  if (!programIdStr || !existsSync(join(keyDir, 'authority.json'))) return null;

  const programId = new PublicKey(programIdStr);
  const connection = new Connection(rpc, 'confirmed');
  const [config] = configPda(programId);
  if (!(await connection.getAccountInfo(config))) return null;

  const feeVault = new PublicKey(process.env.POKEARENA_FEE_VAULT!);
  const treasuryVault = new PublicKey(process.env.POKEARENA_TREASURY_VAULT!);
  const operatorVault = new PublicKey(process.env.POKEARENA_OPERATOR_VAULT!);
  const pokeMint = new PublicKey(process.env.POKEARENA_POKE_MINT!);

  let programDataLen: number | null = null;
  try {
    const info = await connection.getAccountInfo(programId);
    programDataLen = info?.data.length ?? null;
  } catch {
    programDataLen = null;
  }
  void programDataLen;

  return {
    connection,
    programId,
    authority: loadKeypair(join(keyDir, 'authority.json')),
    keeper: loadKeypair(join(keyDir, 'keeper.json')),
    player1: loadKeypair(join(keyDir, 'player1.json')),
    player2: loadKeypair(join(keyDir, 'player2.json')),
    config,
    feeVault,
    treasuryVault,
    operatorVault,
    pokeMint,
    keyDir,
    impl: process.env.POKEARENA_PARITY_IMPL || 'unknown',
  };
}

export async function programExecutableLen(connection: Connection, programId: PublicKey): Promise<number | null> {
  try {
    const info = await connection.getAccountInfo(programId, 'confirmed');
    if (!info) return null;
    // BPF upgradeable: program account points at ProgramData; data[4..] is the ProgramData pubkey.
    if (info.data.length >= 36) {
      const programData = new PublicKey(info.data.subarray(4, 36));
      const pd = await connection.getAccountInfo(programData, 'confirmed');
      if (pd && pd.data.length > 45) return pd.data.length - 45;
    }
    return info.data.length;
  } catch {
    return null;
  }
}
