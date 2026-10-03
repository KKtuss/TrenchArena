/**
 * Test-only byte-level corruption fuzz against a LIVE local validator.
 *
 * Strategy (batch overlays):
 * 1. Create many valid accounts of each multi-instance type.
 * 2. Dump account bytes, apply deterministic mutations offline.
 * 3. Restart validator with --bpf-program + --account overlays for mutated PDAs
 *    (orchestrated by run-hardening-campaign.ps1).
 * 4. Probe each mutated account; expect reject + no cross-account mutation.
 *
 * This file exposes plan/probe helpers; the shell orchestrator drives restarts.
 * When POKEARENA_CORRUPT_PHASE=plan|probe it runs the corresponding phase.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
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
  refundPokeEntryIx,
  reservePrizeIx,
  setPrizeWinnerIx,
  payPrizeIx,
  depositTreasurySolIx,
  depositPokeEntryIx,
} from '../src/instructions';
import {
  configPda,
  matchEscrowPda,
  entryEscrowPda,
  prizeReservePda,
  replayPda,
  treasuryDepositPda,
} from '../src/pdas';
import { getAssociatedTokenAddressSync } from '../src/token';

const SEED = Number(process.env.POKEARENA_HARDENING_SEED ?? 0x504f4b45);
const CASES = Number(process.env.POKEARENA_CORRUPT_CASES ?? 48);
const PHASE = (process.env.POKEARENA_CORRUPT_PHASE ?? '').toLowerCase();
const OUT_DIR = join(__dirname, '../../../../scripts/solana/parity-out/hardening/corrupt');
const IMPL = process.env.POKEARENA_PARITY_IMPL || 'unknown';

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

function labeled16(label: string, i: number): Buffer {
  return createHash('sha256').update(`c16:${SEED}:${label}:${i}`).digest().subarray(0, 16);
}
function labeled32(label: string, i: number): Buffer {
  return createHash('sha256').update(`c32:${SEED}:${label}:${i}`).digest();
}

function mutate(rng: () => number, data: Buffer, i: number): {
  data: Buffer;
  mutation: string;
  offset: number;
  mustReject: boolean;
} {
  const copy = Buffer.from(data);
  const pick = (Math.floor(rng() * 1000) + i) % 9;
  if (pick === 0) {
    const offset = Math.floor(rng() * 8);
    copy[offset] ^= 0xa5;
    return { data: copy, mutation: 'disc-byte-flip', offset, mustReject: true };
  }
  if (pick === 1) {
    const offset = Math.floor(rng() * copy.length);
    copy[offset] ^= 0xff;
    return { data: copy, mutation: 'random-byte-flip', offset, mustReject: false };
  }
  if (pick === 2) {
    const offset = copy.length - 3;
    copy[offset] = 0xff;
    return { data: copy, mutation: 'enum-status-ff', offset, mustReject: true };
  }
  if (pick === 3) {
    const offset = copy.length - 1;
    copy[offset] = (copy[offset] + 19) & 0xff;
    return { data: copy, mutation: 'bump-corrupt', offset, mustReject: true };
  }
  if (pick === 4) {
    const offset = Math.min(24, copy.length - 32);
    Buffer.alloc(32, 0).copy(copy, offset);
    return { data: copy, mutation: 'pubkey-zero', offset, mustReject: true };
  }
  if (pick === 5) {
    const len = Math.max(0, Math.floor(rng() * 12));
    return { data: copy.subarray(0, len), mutation: 'truncate', offset: 0, mustReject: true };
  }
  if (pick === 6) {
    createHash('sha256').update(String(i)).digest().subarray(0, 8).copy(copy, 0);
    return { data: copy, mutation: 'disc-replace', offset: 0, mustReject: true };
  }
  if (pick === 7) {
    const offset = copy.length - 5;
    copy[offset] = copy[offset] ? 0 : 1;
    return { data: copy, mutation: 'bool-toggle', offset, mustReject: true };
  }
  const o = Math.min(88, copy.length - 8);
  Buffer.alloc(8, 0xff).copy(copy, o);
  return { data: copy, mutation: 'u64-max', offset: o, mustReject: false };
}

function toAccountJson(pubkey: string, info: { lamports: number; owner: PublicKey; data: Buffer; executable: boolean }): object {
  return {
    pubkey,
    account: {
      lamports: info.lamports,
      data: [info.data.toString('base64'), 'base64'],
      owner: info.owner.toBase58(),
      executable: info.executable,
      rentEpoch: 0,
      space: info.data.length,
    },
  };
}

async function send(
  connection: Connection,
  payer: Keypair,
  ixs: Transaction['instructions'] extends (infer _)[] ? Parameters<Transaction['add']> : never,
): Promise<boolean> {
  try {
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({
      feePayer: payer.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    for (const ix of ixs as unknown as Parameters<Transaction['add']>[0][]) tx.add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    return true;
  } catch {
    return false;
  }
}

test('hardening corrupt phase (validator overlays)', async (t) => {
  if (!PHASE) {
    t.skip('Set POKEARENA_CORRUPT_PHASE=plan|probe');
    return;
  }
  if ((process.env.POKEARENA_CHAIN_ECONOMY ?? '').toLowerCase() !== 'true') {
    t.skip('chain economy not enabled');
    return;
  }
  const rpc = process.env.POKEARENA_SOLANA_RPC || 'http://127.0.0.1:8899';
  const programId = new PublicKey(process.env.POKEARENA_PROGRAM_ID!);
  const keyDir = process.env.POKEARENA_SOLANA_KEYS || join(__dirname, '../../../../scripts/solana/keys');
  const connection = new Connection(rpc, 'confirmed');
  try {
    await connection.getVersion();
  } catch {
    t.skip('rpc down');
    return;
  }
  const authority = loadKeypair(join(keyDir, 'authority.json'));
  const player1 = loadKeypair(join(keyDir, 'player1.json'));
  const player2 = loadKeypair(join(keyDir, 'player2.json'));
  const [config] = configPda(programId);
  const feeVault = new PublicKey(process.env.POKEARENA_FEE_VAULT!);
  const treasuryVault = new PublicKey(process.env.POKEARENA_TREASURY_VAULT!);
  const operatorVault = new PublicKey(process.env.POKEARENA_OPERATOR_VAULT!);
  const pokeMint = new PublicKey(process.env.POKEARENA_POKE_MINT!);
  const player1Ata = getAssociatedTokenAddressSync(pokeMint, player1.publicKey, true);

  mkdirSync(OUT_DIR, { recursive: true });
  const planPath = join(OUT_DIR, `${IMPL}-plan.json`);

  if (PHASE === 'plan') {
    const rng = mulberry32(SEED);
    const fixtures: Array<{
      id: string;
      kind: string;
      pubkey: string;
      mutation: string;
      offset: number;
      mustReject: boolean;
      probe: string;
      meta: Record<string, string>;
    }> = [];

    // MatchEscrow fixtures (Funded, ready for charge)
    for (let i = 0; i < CASES; i++) {
      const roomId = labeled16('match', i);
      const ok = await send(connection, player1, [
        createMatchEscrowIx({
          programId,
          creator: player1.publicKey,
          config,
          roomId,
          collateralLamports: 20_000_000,
        }),
        depositSolWagerIx({ programId, depositor: player1.publicKey, roomId, side: 0 }),
      ] as never);
      assert.ok(ok, `create match ${i}`);
      assert.ok(
        await send(connection, authority, [
          seatMatchOpponentIx({
            programId,
            authority: authority.publicKey,
            config,
            opponent: player2.publicKey,
            roomId,
          }),
        ] as never),
      );
      assert.ok(
        await send(connection, player2, [
          depositSolWagerIx({ programId, depositor: player2.publicKey, roomId, side: 1 }),
        ] as never),
      );
      const [escrow] = matchEscrowPda(programId, roomId);
      const info = await connection.getAccountInfo(escrow, 'confirmed');
      assert.ok(info);
      const m = mutate(rng, Buffer.from(info.data), i);
      const file = join(OUT_DIR, `${IMPL}-match-${i}.json`);
      writeFileSync(
        file,
        JSON.stringify(
          toAccountJson(escrow.toBase58(), {
            lamports: info.lamports,
            owner: info.owner,
            data: m.data,
            executable: false,
          }),
        ),
      );
      fixtures.push({
        id: `MatchEscrow/${m.mutation}/${i}`,
        kind: 'MatchEscrow',
        pubkey: escrow.toBase58(),
        mutation: m.mutation,
        offset: m.offset,
        mustReject: m.mustReject,
        probe: 'charge_match_fee',
        meta: { roomId: Buffer.from(roomId).toString('hex'), accountFile: file },
      });
    }

    // PrizeReserve fixtures
    for (let i = 0; i < CASES; i++) {
      const tid = labeled16('prize', i);
      assert.ok(
        await send(connection, authority, [
          reservePrizeIx({
            programId,
            authority: authority.publicKey,
            config,
            treasuryVault,
            tournamentId: tid,
            amount: 1_000_000 + i,
          }),
        ] as never),
      );
      assert.ok(
        await send(connection, authority, [
          setPrizeWinnerIx({
            programId,
            authority: authority.publicKey,
            config,
            winner: player1.publicKey,
            tournamentId: tid,
          }),
        ] as never),
      );
      const [reserve] = prizeReservePda(programId, tid);
      const info = await connection.getAccountInfo(reserve, 'confirmed');
      assert.ok(info);
      const m = mutate(rng, Buffer.from(info.data), i + 1000);
      const file = join(OUT_DIR, `${IMPL}-prize-${i}.json`);
      writeFileSync(
        file,
        JSON.stringify(
          toAccountJson(reserve.toBase58(), {
            lamports: info.lamports,
            owner: info.owner,
            data: m.data,
            executable: false,
          }),
        ),
      );
      fixtures.push({
        id: `PrizeReserve/${m.mutation}/${i}`,
        kind: 'PrizeReserve',
        pubkey: reserve.toBase58(),
        mutation: m.mutation,
        offset: m.offset,
        mustReject: m.mustReject,
        probe: 'pay_prize',
        meta: { tournamentId: Buffer.from(tid).toString('hex'), accountFile: file },
      });
    }

    // EntryEscrow fixtures
    for (let i = 0; i < Math.min(CASES, 32); i++) {
      const tid = labeled16('entry', i);
      const ok = await send(connection, player1, [
        depositPokeEntryIx({
          programId,
          player: player1.publicKey,
          config,
          pokeMint,
          playerPoke: player1Ata,
          tournamentId: tid,
          amount: 1_000n,
          quoteId: labeled32('eq', i),
          priceMicroUsd: 400_000,
        }),
      ] as never);
      if (!ok) continue;
      const [entry] = entryEscrowPda(programId, tid, player1.publicKey);
      const info = await connection.getAccountInfo(entry, 'confirmed');
      if (!info) continue;
      const m = mutate(rng, Buffer.from(info.data), i + 2000);
      const file = join(OUT_DIR, `${IMPL}-entry-${i}.json`);
      writeFileSync(
        file,
        JSON.stringify(
          toAccountJson(entry.toBase58(), {
            lamports: info.lamports,
            owner: info.owner,
            data: m.data,
            executable: false,
          }),
        ),
      );
      fixtures.push({
        id: `EntryEscrow/${m.mutation}/${i}`,
        kind: 'EntryEscrow',
        pubkey: entry.toBase58(),
        mutation: m.mutation,
        offset: m.offset,
        mustReject: m.mustReject,
        probe: 'refund_poke_entry',
        meta: { tournamentId: Buffer.from(tid).toString('hex'), accountFile: file },
      });
    }

    // Config mutations (single PDA — write N overlay files for sequential reloads)
    {
      const info = await connection.getAccountInfo(config, 'confirmed');
      assert.ok(info);
      for (let i = 0; i < Math.min(CASES, 24); i++) {
        const m = mutate(rng, Buffer.from(info.data), i + 3000);
        const file = join(OUT_DIR, `${IMPL}-config-${i}.json`);
        writeFileSync(
          file,
          JSON.stringify(
            toAccountJson(config.toBase58(), {
              lamports: info.lamports,
              owner: info.owner,
              data: m.data,
              executable: false,
            }),
          ),
        );
        fixtures.push({
          id: `Config/${m.mutation}/${i}`,
          kind: 'Config',
          pubkey: config.toBase58(),
          mutation: m.mutation,
          offset: m.offset,
          mustReject: m.mustReject,
          probe: 'charge_match_fee',
          meta: { accountFile: file, sequential: '1' },
        });
      }
    }

    // Also dump supporting accounts for reload (config golden, vaults, mint) — orchestrator handles.
    const supportDir = join(OUT_DIR, `${IMPL}-support`);
    mkdirSync(supportDir, { recursive: true });
    for (const [name, pk] of [
      ['config', config],
      ['fee', feeVault],
      ['treasury', treasuryVault],
      ['operator', operatorVault],
      ['player1', player1.publicKey],
      ['player2', player2.publicKey],
      ['authority', authority.publicKey],
    ] as const) {
      const info = await connection.getAccountInfo(pk, 'confirmed');
      if (!info) continue;
      writeFileSync(
        join(supportDir, `${name}.json`),
        JSON.stringify(
          toAccountJson(pk.toBase58(), {
            lamports: info.lamports,
            owner: info.owner,
            data: Buffer.from(info.data),
            executable: info.executable,
          }),
        ),
      );
    }

    writeFileSync(
      planPath,
      JSON.stringify({ seed: SEED, impl: IMPL, generatedAt: new Date().toISOString(), fixtures }, null, 2),
    );
    console.log(JSON.stringify({ phase: 'plan', fixtures: fixtures.length, planPath }, null, 2));
    assert.ok(fixtures.length >= 50, `expected substantial plan, got ${fixtures.length}`);
    return;
  }

  if (PHASE === 'probe') {
    assert.ok(existsSync(planPath), 'plan missing — run plan phase first');
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      fixtures: Array<{
        id: string;
        kind: string;
        pubkey: string;
        mutation: string;
        mustReject: boolean;
        probe: string;
        meta: Record<string, string>;
      }>;
    };

    // Only probe non-sequential fixtures in batch mode (config handled separately).
    const batch = plan.fixtures.filter((f) => f.meta.sequential !== '1');
    const results: Array<{
      id: string;
      ok: boolean;
      mustReject: boolean;
      unexpectedAccept: boolean;
      probe: string;
      err?: string;
    }> = [];

    for (const f of batch) {
      let ok = false;
      let err: string | undefined;
      try {
        if (f.probe === 'charge_match_fee') {
          const roomId = Buffer.from(f.meta.roomId!, 'hex');
          ok = await send(connection, authority, [
            chargeMatchFeeIx({
              programId,
              authority: authority.publicKey,
              config,
              feeVault,
              roomId,
            }),
          ] as never);
        } else if (f.probe === 'pay_prize') {
          const tid = Buffer.from(f.meta.tournamentId!, 'hex');
          ok = await send(connection, authority, [
            payPrizeIx({
              programId,
              authority: authority.publicKey,
              config,
              winner: player1.publicKey,
              tournamentId: tid,
              settlementKey: labeled32('pay', Number(f.id.split('/').pop())),
            }),
          ] as never);
        } else if (f.probe === 'refund_poke_entry') {
          const tid = Buffer.from(f.meta.tournamentId!, 'hex');
          ok = await send(connection, authority, [
            refundPokeEntryIx({
              programId,
              authority: authority.publicKey,
              config,
              pokeMint,
              playerPoke: player1Ata,
              tournamentId: tid,
              player: player1.publicKey,
            }),
          ] as never);
        }
      } catch (e) {
        ok = false;
        err = e instanceof Error ? e.message : String(e);
      }
      results.push({
        id: f.id,
        ok,
        mustReject: f.mustReject,
        unexpectedAccept: f.mustReject && ok,
        probe: f.probe,
        err,
      });
    }

    const summary = {
      total: results.length,
      accepted: results.filter((r) => r.ok).length,
      rejected: results.filter((r) => !r.ok).length,
      unexpectedAccept: results.filter((r) => r.unexpectedAccept).length,
    };
    const out = join(OUT_DIR, `${IMPL}-probe-report.json`);
    writeFileSync(
      out,
      JSON.stringify({ generatedAt: new Date().toISOString(), seed: SEED, impl: IMPL, summary, results }, null, 2),
    );
    console.log(JSON.stringify({ phase: 'probe', out, summary }, null, 2));
    assert.equal(summary.unexpectedAccept, 0, 'unexpected accept of corrupted account');
    return;
  }

  t.skip(`unknown phase ${PHASE}`);
});

void settleMatchWinIx;
void depositTreasurySolIx;
void replayPda;
void treasuryDepositPda;
void readdirSync;
