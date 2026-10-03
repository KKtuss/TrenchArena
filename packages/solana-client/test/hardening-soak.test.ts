/**
 * Test-only concurrent / soak campaign against a live local validator.
 * Deterministic seed. Does not modify production programs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createMatchEscrowIx,
  depositSolWagerIx,
  seatMatchOpponentIx,
  chargeMatchFeeIx,
  settleMatchWinIx,
  settleMatchTieIx,
  refundSolWagerIx,
  reservePrizeIx,
  setPrizeWinnerIx,
  payPrizeIx,
  releasePrizeIx,
  depositTreasurySolIx,
} from '../src/instructions';
import { configPda, matchEscrowPda, replayPda } from '../src/pdas';

const SEED = Number(process.env.POKEARENA_HARDENING_SEED ?? 0x504f4b45);
const WALLETS = Number(process.env.POKEARENA_SOAK_WALLETS ?? 8);
const LIFECYCLES = Number(process.env.POKEARENA_SOAK_LIFECYCLES ?? 40);
const CONCURRENCY = Number(process.env.POKEARENA_SOAK_CONCURRENCY ?? 6);
// dist/test -> repo root is ../../../.. ; source test/ -> ../../..
const ROOT = existsSync(join(__dirname, '../../../../scripts/solana/parity-out'))
  ? join(__dirname, '../../../..')
  : join(__dirname, '../../..');
const OUT_DIR = join(ROOT, 'scripts/solana/parity-out/hardening');

function mulberry32(a: number): () => number {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

function labeled(seed: number, label: string, i: number): Buffer {
  return createHash('sha256').update(`soak:${seed}:${label}:${i}`).digest().subarray(0, 16);
}

function labeled32(seed: number, label: string, i: number): Buffer {
  return createHash('sha256').update(`soak32:${seed}:${label}:${i}`).digest();
}

async function airdrop(connection: Connection, pk: PublicKey, sol = 20): Promise<void> {
  const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');
}

async function send(
  connection: Connection,
  payer: Keypair,
  ixs: Parameters<Transaction['add']>[0][],
  signers: Keypair[] = [],
): Promise<{ ok: boolean; err?: string }> {
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
    for (const ix of ixs) tx.add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: 'confirmed' });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  }
}

type LifecycleResult = {
  id: string;
  kind: string;
  ok: boolean;
  txs: number;
  err?: string;
  invariant?: string;
};

async function mapPool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

test('hardening: concurrent soak lifecycles on local validator', async (t) => {
  if ((process.env.POKEARENA_CHAIN_ECONOMY ?? '').toLowerCase() !== 'true') {
    t.skip('POKEARENA_CHAIN_ECONOMY not enabled');
    return;
  }
  const rpc = process.env.POKEARENA_SOLANA_RPC || 'http://127.0.0.1:8899';
  const programIdStr = process.env.POKEARENA_PROGRAM_ID;
  const keyDir = process.env.POKEARENA_SOLANA_KEYS || join(ROOT, 'scripts/solana/keys');
  if (!programIdStr || !existsSync(join(keyDir, 'authority.json'))) {
    t.skip('program/keys not ready');
    return;
  }

  const connection = new Connection(rpc, 'confirmed');
  try {
    await connection.getVersion();
  } catch {
    t.skip('validator RPC not reachable');
    return;
  }

  const programId = new PublicKey(programIdStr);
  const authority = loadKeypair(join(keyDir, 'authority.json'));
  const [config] = configPda(programId);
  if (!(await connection.getAccountInfo(config))) {
    t.skip('config not initialized');
    return;
  }
  const feeVault = new PublicKey(process.env.POKEARENA_FEE_VAULT!);
  const treasuryVault = new PublicKey(process.env.POKEARENA_TREASURY_VAULT!);
  const operatorVault = new PublicKey(process.env.POKEARENA_OPERATOR_VAULT!);

  const wallets: Keypair[] = [];
  for (let i = 0; i < WALLETS; i++) {
    // Deterministic wallets from seed
    const buf = createHash('sha256').update(`wallet:${SEED}:${i}`).digest();
    wallets.push(Keypair.fromSeed(buf));
  }
  for (const w of wallets) {
    const bal = await connection.getBalance(w.publicKey);
    if (bal < 5 * LAMPORTS_PER_SOL) await airdrop(connection, w.publicKey, 50);
  }
  {
    const bal = await connection.getBalance(authority.publicKey);
    if (bal < 20 * LAMPORTS_PER_SOL) await airdrop(connection, authority.publicKey, 100);
  }

  const treasuryBefore = await connection.getBalance(treasuryVault);
  const feeBefore = await connection.getBalance(feeVault);
  const results: LifecycleResult[] = [];
  let txCount = 0;
  let timeouts = 0;
  let invariantViolations = 0;

  const jobs = Array.from({ length: LIFECYCLES }, (_, i) => i);

  const lifecycleResults = await mapPool(jobs, CONCURRENCY, async (i) => {
    // Per-lifecycle RNG so concurrency does not scramble the seed stream.
    const rng = mulberry32((SEED ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
    const kindRoll = rng();
    const creator = wallets[i % wallets.length]!;
    const opponent = wallets[(i + 1) % wallets.length]!;
    const collateral = Math.floor(0.05 * LAMPORTS_PER_SOL) + (i % 7) * 1_000_000;
    let localTxs = 0;

    // Prize path
    if (kindRoll < 0.2) {
      const tid = labeled(SEED, 'prize', i);
      const amount = 1_000_000 + i * 1000;
      let r = await send(connection, authority, [
        reservePrizeIx({
          programId,
          authority: authority.publicKey,
          config,
          treasuryVault,
          tournamentId: tid,
          amount,
        }),
      ]);
      localTxs++;
      if (!r.ok) return { id: `prize-${i}`, kind: 'prize', ok: false, txs: localTxs, err: r.err };

      if (rng() < 0.5) {
        r = await send(connection, authority, [
          setPrizeWinnerIx({
            programId,
            authority: authority.publicKey,
            config,
            winner: creator.publicKey,
            tournamentId: tid,
          }),
        ]);
        localTxs++;
        if (!r.ok) return { id: `prize-${i}`, kind: 'prize', ok: false, txs: localTxs, err: r.err };
        // wrong winner race
        const wrong = await send(connection, authority, [
          payPrizeIx({
            programId,
            authority: authority.publicKey,
            config,
            winner: opponent.publicKey,
            tournamentId: tid,
            settlementKey: labeled32(SEED, 'prize-wrong', i),
          }),
        ]);
        localTxs++;
        if (wrong.ok) {
          return {
            id: `prize-${i}`,
            kind: 'prize',
            ok: false,
            txs: localTxs,
            invariant: 'wrong-winner-pay-accepted',
          };
        }
        const payKey = labeled32(SEED, 'prize-pay', i);
        r = await send(connection, authority, [
          payPrizeIx({
            programId,
            authority: authority.publicKey,
            config,
            winner: creator.publicKey,
            tournamentId: tid,
            settlementKey: payKey,
          }),
        ]);
        localTxs++;
        if (!r.ok) return { id: `prize-${i}`, kind: 'prize', ok: false, txs: localTxs, err: r.err };
        // replay
        const replay = await send(connection, authority, [
          payPrizeIx({
            programId,
            authority: authority.publicKey,
            config,
            winner: creator.publicKey,
            tournamentId: tid,
            settlementKey: payKey,
          }),
        ]);
        localTxs++;
        if (replay.ok) {
          return { id: `prize-${i}`, kind: 'prize', ok: false, txs: localTxs, invariant: 'double-pay' };
        }
      } else {
        r = await send(connection, authority, [
          releasePrizeIx({
            programId,
            authority: authority.publicKey,
            config,
            treasuryVault,
            tournamentId: tid,
          }),
        ]);
        localTxs++;
        if (!r.ok) return { id: `prize-${i}`, kind: 'prize-release', ok: false, txs: localTxs, err: r.err };
      }
      return { id: `prize-${i}`, kind: 'prize', ok: true, txs: localTxs };
    }

    // Treasury deposit
    if (kindRoll < 0.3) {
      const claim = labeled32(SEED, 'treasury', i);
      const r = await send(connection, authority, [
        depositTreasurySolIx({
          programId,
          authority: authority.publicKey,
          payer: authority.publicKey,
          config,
          treasuryVault,
          operatorVault,
          claimKey: claim,
          grossLamports: 10_000_000 + i,
        }),
      ]);
      localTxs++;
      if (!r.ok) return { id: `treasury-${i}`, kind: 'treasury', ok: false, txs: localTxs, err: r.err };
      const dup = await send(connection, authority, [
        depositTreasurySolIx({
          programId,
          authority: authority.publicKey,
          payer: authority.publicKey,
          config,
          treasuryVault,
          operatorVault,
          claimKey: claim,
          grossLamports: 10_000_000 + i,
        }),
      ]);
      localTxs++;
      if (dup.ok) {
        return { id: `treasury-${i}`, kind: 'treasury', ok: false, txs: localTxs, invariant: 'treasury-replay' };
      }
      return { id: `treasury-${i}`, kind: 'treasury', ok: true, txs: localTxs };
    }

    // SOL wager lifecycle (win / tie / refund-cancel)
    const roomId = labeled(SEED, 'room', i);
    let r = await send(connection, creator, [
      createMatchEscrowIx({
        programId,
        creator: creator.publicKey,
        config,
        roomId,
        collateralLamports: collateral,
      }),
      depositSolWagerIx({
        programId,
        depositor: creator.publicKey,
        roomId,
        side: 0,
      }),
    ]);
    localTxs++;
    if (!r.ok) return { id: `wager-${i}`, kind: 'wager', ok: false, txs: localTxs, err: r.err };

    r = await send(connection, authority, [
      seatMatchOpponentIx({
        programId,
        authority: authority.publicKey,
        config,
        opponent: opponent.publicKey,
        roomId,
      }),
    ]);
    localTxs++;
    if (!r.ok) return { id: `wager-${i}`, kind: 'wager', ok: false, txs: localTxs, err: r.err };

    // Concurrent race: two deposits of side 1 — only one should succeed
    if (rng() < 0.25) {
      const [d1, d2] = await Promise.all([
        send(connection, opponent, [
          depositSolWagerIx({ programId, depositor: opponent.publicKey, roomId, side: 1 }),
        ]),
        send(connection, opponent, [
          depositSolWagerIx({ programId, depositor: opponent.publicKey, roomId, side: 1 }),
        ]),
      ]);
      localTxs += 2;
      const successes = [d1, d2].filter((x) => x.ok).length;
      if (successes !== 1) {
        return {
          id: `wager-${i}`,
          kind: 'race-deposit',
          ok: false,
          txs: localTxs,
          invariant: `duplicate-deposit-successes=${successes}`,
        };
      }
    } else {
      r = await send(connection, opponent, [
        depositSolWagerIx({ programId, depositor: opponent.publicKey, roomId, side: 1 }),
      ]);
      localTxs++;
      if (!r.ok) return { id: `wager-${i}`, kind: 'wager', ok: false, txs: localTxs, err: r.err };
    }

    // Cancel/refund path (~20%)
    if (kindRoll > 0.85) {
      // Funded — refund must fail
      const refund = await send(connection, authority, [
        refundSolWagerIx({
          programId,
          authority: authority.publicKey,
          config,
          recipient: creator.publicKey,
          roomId,
          side: 0,
        }),
      ]);
      localTxs++;
      if (refund.ok) {
        return {
          id: `wager-${i}`,
          kind: 'refund-funded',
          ok: false,
          txs: localTxs,
          invariant: 'funded-refund-accepted',
        };
      }
      // still settle so funds aren't stuck forever in vault for soak accounting
    }

    r = await send(connection, authority, [
      chargeMatchFeeIx({
        programId,
        authority: authority.publicKey,
        config,
        feeVault,
        roomId,
      }),
    ]);
    localTxs++;
    if (!r.ok) return { id: `wager-${i}`, kind: 'wager', ok: false, txs: localTxs, err: r.err };

    // Race double fee charge
    const fee2 = await send(connection, authority, [
      chargeMatchFeeIx({
        programId,
        authority: authority.publicKey,
        config,
        feeVault,
        roomId,
      }),
    ]);
    localTxs++;
    if (fee2.ok) {
      return { id: `wager-${i}`, kind: 'wager', ok: false, txs: localTxs, invariant: 'double-fee' };
    }

    const settleKey = labeled32(SEED, 'settle', i);
    const tie = rng() < 0.35;
    if (tie) {
      r = await send(connection, authority, [
        settleMatchTieIx({
          programId,
          authority: authority.publicKey,
          config,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          roomId,
          settlementKey: settleKey,
        }),
      ]);
    } else {
      const winner = rng() < 0.5 ? creator : opponent;
      r = await send(connection, authority, [
        settleMatchWinIx({
          programId,
          authority: authority.publicKey,
          config,
          winner: winner.publicKey,
          roomId,
          settlementKey: settleKey,
        }),
      ]);
    }
    localTxs++;
    if (!r.ok) return { id: `wager-${i}`, kind: tie ? 'tie' : 'win', ok: false, txs: localTxs, err: r.err };

    // Concurrent double settle race
    const [s1, s2] = await Promise.all([
      send(connection, authority, [
        settleMatchWinIx({
          programId,
          authority: authority.publicKey,
          config,
          winner: creator.publicKey,
          roomId,
          settlementKey: settleKey,
        }),
      ]),
      send(connection, authority, [
        settleMatchTieIx({
          programId,
          authority: authority.publicKey,
          config,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          roomId,
          settlementKey: settleKey,
        }),
      ]),
    ]);
    localTxs += 2;
    if (s1.ok || s2.ok) {
      return {
        id: `wager-${i}`,
        kind: 'settle-race',
        ok: false,
        txs: localTxs,
        invariant: 'double-settle',
      };
    }

    // Replay PDA must exist
    const [replay] = replayPda(programId, settleKey);
    const replayInfo = await connection.getAccountInfo(replay);
    if (!replayInfo) {
      return {
        id: `wager-${i}`,
        kind: 'settle',
        ok: false,
        txs: localTxs,
        invariant: 'missing-replay-pda',
      };
    }

    const [escrow] = matchEscrowPda(programId, roomId);
    const escrowInfo = await connection.getAccountInfo(escrow);
    if (!escrowInfo || escrowInfo.data[99] !== 4) {
      // status Settled = 4
      return {
        id: `wager-${i}`,
        kind: 'settle',
        ok: false,
        txs: localTxs,
        invariant: `bad-status=${escrowInfo?.data[99]}`,
      };
    }

    return { id: `wager-${i}`, kind: tie ? 'tie' : 'win', ok: true, txs: localTxs };
  });

  for (const r of lifecycleResults) {
    results.push(r);
    txCount += r.txs;
    if (r.err && /block height exceeded|timeout/i.test(r.err)) timeouts++;
    if (r.invariant) invariantViolations++;
  }

  const failed = results.filter((r) => !r.ok);
  const summary = {
    seed: SEED,
    wallets: WALLETS,
    concurrency: CONCURRENCY,
    lifecycles: LIFECYCLES,
    completedOk: results.filter((r) => r.ok).length,
    failed: failed.length,
    txCount,
    timeouts,
    invariantViolations,
    feeVaultDelta: (await connection.getBalance(feeVault)) - feeBefore,
    treasuryVaultDelta: (await connection.getBalance(treasuryVault)) - treasuryBefore,
    byKind: Object.fromEntries(
      [...new Set(results.map((r) => r.kind))].map((k) => [
        k,
        {
          total: results.filter((r) => r.kind === k).length,
          ok: results.filter((r) => r.kind === k && r.ok).length,
        },
      ]),
    ),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const impl = process.env.POKEARENA_PARITY_IMPL || 'unknown';
  const out = join(OUT_DIR, `soak-${impl}-report.json`);
  writeFileSync(
    out,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        impl,
        programId: programIdStr,
        summary,
        failures: failed,
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ out, summary }, null, 2));

  assert.equal(invariantViolations, 0, `invariant violations: ${failed.map((f) => f.invariant || f.err).join('; ')}`);
  assert.ok(summary.completedOk >= Math.floor(LIFECYCLES * 0.9), `too many failures: ${summary.failed}`);
});
