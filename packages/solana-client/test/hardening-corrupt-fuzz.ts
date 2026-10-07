/**
 * Test-only byte-level account-data corruption fuzz.
 * Loads the exact Anchor/Pinocchio .so artifacts into LiteSVM (same BPF as local
 * validator genesis load) so account bytes can be mutated via setAccount.
 * Does not modify production programs or ABI.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { IX } from '../src/discriminator';

type SvmInstance = {
  addProgramFromFile: (id: PublicKey, path: string) => void;
  setAccount: (address: PublicKey, account: {
    lamports: number;
    data: Buffer | Uint8Array;
    owner: PublicKey;
    executable: boolean;
    rentEpoch: number;
  }) => void;
  airdrop: (address: PublicKey, lamports: bigint) => unknown;
  minimumBalanceForRentExemption: (n: bigint) => bigint;
  getAccount: (address: PublicKey) => { data: Uint8Array } | null;
  latestBlockhash: () => string;
  sendTransaction: (tx: Transaction) => unknown;
  expireBlockhash?: () => void;
  withTransactionHistory?: (n: bigint) => SvmInstance;
  withSigverify?: (v: boolean) => SvmInstance;
};
type FailedTransactionMetadataCtor = new (...args: never[]) => unknown;

let LiteSVMCtor: (new () => SvmInstance) | null = null;
let FailedTransactionMetadata: FailedTransactionMetadataCtor | null = null;
let litesvmLoadError: string | null = null;
try {
  // Native binding is Linux/macOS only in this environment; Windows host skips.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('litesvm') as {
    LiteSVM: new () => SvmInstance;
    FailedTransactionMetadata: FailedTransactionMetadataCtor;
  };
  LiteSVMCtor = mod.LiteSVM;
  FailedTransactionMetadata = mod.FailedTransactionMetadata;
} catch (e) {
  litesvmLoadError = e instanceof Error ? e.message : String(e);
}
import {
  configPda,
  feeVaultPda,
  treasuryVaultPda,
  operatorVaultPda,
  matchEscrowPda,
  matchVaultPda,
  entryEscrowPda,
  entryVaultPda,
  prizeReservePda,
  prizeVaultPda,
  replayPda,
  treasuryDepositPda,
  cardsPrizeReservePda,
} from '../src/pdas';
import {
  chargeMatchFeeIx,
  depositSolWagerIx,
  settleMatchWinIx,
  refundPokeEntryIx,
  setPrizeWinnerIx,
  payPrizeIx,
  depositTreasurySolIx,
  seatMatchOpponentIx,
  setCardsPrizeWinnerIx,
} from '../src/instructions';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '../src/token';

const PROGRAM_ID = new PublicKey('6dHMWQd1M2ZZSmrkQLGZcFpHnvHi8rcH68QqQJ4Kj4r8');
// dist/test -> repo root is ../../../.. ; source test/ -> ../../..
const ROOT = existsSync(join(__dirname, '../../../../target/deploy/arena_escrow_pinocchio.so'))
  ? join(__dirname, '../../../..')
  : join(__dirname, '../../..');
const OUT_DIR = join(ROOT, 'scripts/solana/parity-out/hardening');
const SEED = Number(process.env.POKEARENA_HARDENING_SEED ?? 0x504f4b45); // 'POKE'
const CASES_PER_TYPE = Number(process.env.POKEARENA_CORRUPT_CASES ?? 80);

const DISC = {
  Config: Buffer.from([0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82]),
  MatchEscrow: Buffer.from([0x29, 0xfd, 0xf5, 0x95, 0x07, 0xf3, 0xcb, 0x8b]),
  EntryEscrow: Buffer.from([0x73, 0x99, 0x14, 0x2d, 0xe2, 0xce, 0x8b, 0xf4]),
  PrizeReserve: Buffer.from([0xa0, 0x94, 0xbb, 0xf2, 0x2b, 0x20, 0x7b, 0x32]),
  Replay: Buffer.from([0x26, 0xe4, 0xcc, 0x2e, 0xfb, 0x1c, 0x7c, 0x69]),
  TreasuryDeposit: Buffer.from([0xc3, 0xa0, 0x6e, 0x76, 0x52, 0x6f, 0xe7, 0xae]),
  CardsPrizeReserve: Buffer.from([0xb5, 0x15, 0x86, 0x05, 0x7d, 0x1d, 0x88, 0xb1]),
} as const;

type AccountKind =
  | 'Config'
  | 'MatchEscrow'
  | 'EntryEscrow'
  | 'PrizeReserve'
  | 'Replay'
  | 'TreasuryDeposit'
  | 'TokenAccount'
  | 'CardsPrizeReserve';

type CorruptCase = {
  id: string;
  seed: number;
  caseIndex: number;
  accountKind: AccountKind;
  mutation: string;
  offset: number;
  beforeByte: number | null;
  afterByte: number | null;
  truncatedTo: number | null;
  probeIx: string;
  mustReject: boolean;
  pinocchio: { ok: boolean; err: string | null; mutatedOther: boolean };
  anchor: { ok: boolean; err: string | null; mutatedOther: boolean };
  unexpectedAccept: boolean;
  acceptMismatch: boolean;
};

function mulberry32(a: number): () => number {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function u64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function writePk(buf: Buffer, off: number, pk: PublicKey): void {
  pk.toBuffer().copy(buf, off);
}

function packConfig(input: {
  authority: PublicKey;
  feeVault: PublicKey;
  treasuryVault: PublicKey;
  operatorVault: PublicKey;
  pokeMint: PublicKey;
  quoteAuthority: PublicKey;
  keeper: PublicKey;
  bump: number;
}): Buffer {
  const buf = Buffer.alloc(305);
  DISC.Config.copy(buf, 0);
  writePk(buf, 8, input.authority);
  writePk(buf, 40, input.feeVault);
  writePk(buf, 72, input.treasuryVault);
  writePk(buf, 104, input.operatorVault);
  writePk(buf, 136, input.pokeMint);
  writePk(buf, 168, input.quoteAuthority);
  writePk(buf, 200, input.keeper);
  u64(200).copy(buf, 232);
  u64(9000).copy(buf, 240);
  u64(1000).copy(buf, 248);
  u64(2500).copy(buf, 256);
  u64(50_000_000).copy(buf, 264);
  buf[272] = input.bump;
  return buf;
}

function packMatch(input: {
  roomId: Buffer;
  creator: PublicKey;
  opponent: PublicKey;
  collateral: bigint;
  creatorDep: boolean;
  opponentDep: boolean;
  feeCharged: boolean;
  status: number;
  bump: number;
}): Buffer {
  const buf = Buffer.alloc(133);
  DISC.MatchEscrow.copy(buf, 0);
  input.roomId.copy(buf, 8);
  writePk(buf, 24, input.creator);
  writePk(buf, 56, input.opponent);
  u64(input.collateral).copy(buf, 88);
  buf[96] = input.creatorDep ? 1 : 0;
  buf[97] = input.opponentDep ? 1 : 0;
  buf[98] = input.feeCharged ? 1 : 0;
  buf[99] = input.status;
  buf[100] = input.bump;
  return buf;
}

function packEntry(input: {
  tournamentId: Buffer;
  player: PublicKey;
  amount: bigint;
  quoteId: Buffer;
  price: bigint;
  status: number;
  bump: number;
}): Buffer {
  const buf = Buffer.alloc(138);
  DISC.EntryEscrow.copy(buf, 0);
  input.tournamentId.copy(buf, 8);
  writePk(buf, 24, input.player);
  u64(input.amount).copy(buf, 56);
  input.quoteId.copy(buf, 64);
  u64(input.price).copy(buf, 96);
  buf[104] = input.status;
  buf[105] = input.bump;
  return buf;
}

function packCardsReserve(input: {
  tournamentId: Buffer;
  funder: PublicKey;
  winner: PublicKey;
  amount: bigint;
  status: number;
  winnerSet: boolean;
  bump: number;
  fundKey?: Buffer;
  payKey?: Buffer;
}): Buffer {
  const buf = Buffer.alloc(163);
  DISC.CardsPrizeReserve.copy(buf, 0);
  input.tournamentId.copy(buf, 8);
  writePk(buf, 24, input.funder);
  writePk(buf, 56, input.winner);
  u64(input.amount).copy(buf, 88);
  buf[96] = input.status;
  buf[97] = input.winnerSet ? 1 : 0;
  buf[98] = input.bump;
  (input.fundKey ?? Buffer.alloc(32)).copy(buf, 99);
  (input.payKey ?? Buffer.alloc(32)).copy(buf, 131);
  return buf;
}

function packPrize(input: {
  tournamentId: Buffer;
  winner: PublicKey;
  amount: bigint;
  status: number;
  winnerSet: boolean;
  bump: number;
}): Buffer {
  const buf = Buffer.alloc(67);
  DISC.PrizeReserve.copy(buf, 0);
  input.tournamentId.copy(buf, 8);
  writePk(buf, 24, input.winner);
  u64(input.amount).copy(buf, 56);
  buf[64] = input.status;
  buf[65] = input.winnerSet ? 1 : 0;
  buf[66] = input.bump;
  return buf;
}

function packReplay(input: { key: Buffer; kind: number; bump: number }): Buffer {
  const buf = Buffer.alloc(42);
  DISC.Replay.copy(buf, 0);
  input.key.copy(buf, 8);
  buf[40] = input.kind;
  buf[41] = input.bump;
  return buf;
}

function packTreasuryDeposit(input: {
  claimKey: Buffer;
  gross: bigint;
  treasury: bigint;
  operator: bigint;
  bump: number;
}): Buffer {
  const buf = Buffer.alloc(65);
  DISC.TreasuryDeposit.copy(buf, 0);
  input.claimKey.copy(buf, 8);
  u64(input.gross).copy(buf, 40);
  u64(input.treasury).copy(buf, 48);
  u64(input.operator).copy(buf, 56);
  buf[64] = input.bump;
  return buf;
}

/** Minimal SPL token account (165 bytes). */
function packTokenAccount(input: {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
}): Buffer {
  const buf = Buffer.alloc(165);
  writePk(buf, 0, input.mint);
  writePk(buf, 32, input.owner);
  u64(input.amount).copy(buf, 64);
  buf[108] = 1; // initialized
  return buf;
}

function sha(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Layout metadata for program-owned accounts (and SPL token for refund probes). */
const LAYOUT: Record<
  AccountKind,
  {
    dataLen: number; // minimum accepted by unpack
    bump?: number;
    status?: number;
    bools: number[];
    /** Offsets that feed PDA seeds / checked identities for the default probe. */
    criticalPubkeys: Array<{ start: number; len: number }>;
    criticalBools: number[]; // bool offsets the probe requires in a specific state
  }
> = {
  Config: {
    dataLen: 305,
    bump: 272, // mutated for coverage; not must-reject on seat probe (Anchor parity)
    bools: [],
    criticalPubkeys: [
      { start: 8, len: 32 }, // authority checked by authority_or_keeper
    ],
    criticalBools: [],
  },
  MatchEscrow: {
    dataLen: 133,
    bump: 100,
    status: 99,
    bools: [96, 97, 98],
    // room_id is PDA seed material; creator/opponent unused by charge_match_fee
    criticalPubkeys: [{ start: 8, len: 16 }],
    criticalBools: [98], // fee_charged must stay false
  },
  EntryEscrow: {
    dataLen: 138,
    bump: 105,
    status: 104,
    bools: [],
    criticalPubkeys: [
      { start: 8, len: 16 }, // tournament_id
      { start: 24, len: 32 }, // player
    ],
    criticalBools: [],
  },
  PrizeReserve: {
    dataLen: 67,
    bump: 66,
    status: 64,
    bools: [65],
    criticalPubkeys: [
      { start: 8, len: 16 },
      { start: 24, len: 32 }, // winner checked on pay
    ],
    criticalBools: [65], // winner_set
  },
  Replay: {
    dataLen: 42,
    bump: 41,
    status: 40,
    bools: [],
    criticalPubkeys: [{ start: 8, len: 32 }],
    criticalBools: [],
  },
  TreasuryDeposit: {
    dataLen: 65,
    bump: 64,
    bools: [],
    criticalPubkeys: [{ start: 8, len: 32 }],
    criticalBools: [],
  },
  CardsPrizeReserve: {
    dataLen: 163,
    bump: 98,
    status: 96,
    bools: [97],
    criticalPubkeys: [
      { start: 8, len: 16 },
    ],
    criticalBools: [97],
  },
  TokenAccount: {
    dataLen: 165,
    bools: [],
    criticalPubkeys: [
      { start: 0, len: 32 }, // mint
      { start: 32, len: 32 }, // owner
    ],
    criticalBools: [],
  },
};

function mutate(
  rng: () => number,
  kind: AccountKind,
  data: Buffer,
  strategy: number,
): {
  data: Buffer;
  mutation: string;
  offset: number;
  before: number | null;
  after: number | null;
  truncatedTo: number | null;
} {
  const layout = LAYOUT[kind];
  const copy = Buffer.from(data);
  const pick = strategy % 10;
  if (pick === 0 && kind !== 'TokenAccount') {
    const offset = Math.floor(rng() * 8);
    const before = copy[offset]!;
    copy[offset] = before ^ (1 + Math.floor(rng() * 255));
    return { data: copy, mutation: 'disc-byte-flip', offset, before, after: copy[offset]!, truncatedTo: null };
  }
  if (pick === 1) {
    const offset = Math.floor(rng() * copy.length);
    const before = copy[offset]!;
    copy[offset] = before ^ 0xff;
    return { data: copy, mutation: 'random-byte-flip', offset, before, after: copy[offset]!, truncatedTo: null };
  }
  if (pick === 2 && layout.status !== undefined) {
    const offset = layout.status;
    const before = copy[offset]!;
    copy[offset] = 0xff;
    return { data: copy, mutation: 'enum-status-ff', offset, before, after: 0xff, truncatedTo: null };
  }
  if (pick === 3 && layout.bools.length > 0) {
    const offset = layout.bools[Math.floor(rng() * layout.bools.length)]!;
    const before = copy[offset]!;
    copy[offset] = before ? 0 : 1;
    return { data: copy, mutation: 'bool-toggle', offset, before, after: copy[offset]!, truncatedTo: null };
  }
  if (pick === 4) {
    const offset = 8 + Math.floor(rng() * Math.max(1, copy.length - 16));
    const aligned = offset - (offset % 8);
    const o = Math.min(aligned, copy.length - 8);
    const before = copy[o]!;
    Buffer.alloc(8, 0xff).copy(copy, o);
    return { data: copy, mutation: 'u64-max', offset: o, before, after: 0xff, truncatedTo: null };
  }
  if (pick === 5 && layout.criticalPubkeys.length + 1 > 0) {
    // Prefer critical regions half the time; otherwise any pubkey-sized window.
    const useCritical = rng() < 0.55 && layout.criticalPubkeys.length > 0;
    let start: number;
    let len = 32;
    if (useCritical) {
      const region = layout.criticalPubkeys[Math.floor(rng() * layout.criticalPubkeys.length)]!;
      start = region.start;
      len = region.len;
    } else {
      start = 8 + Math.floor(rng() * Math.max(1, copy.length - 40));
      start = Math.min(start, copy.length - 32);
    }
    const before = copy[start]!;
    Buffer.alloc(len, 0).copy(copy, start);
    return { data: copy, mutation: 'pubkey-zero', offset: start, before, after: 0, truncatedTo: null };
  }
  if (pick === 6 && layout.bump !== undefined) {
    const offset = layout.bump;
    const before = copy[offset]!;
    copy[offset] = (before + 17) & 0xff;
    return { data: copy, mutation: 'bump-corrupt', offset, before, after: copy[offset]!, truncatedTo: null };
  }
  if (pick === 7) {
    const len = Math.max(0, Math.floor(rng() * Math.min(copy.length, 16)));
    return {
      data: copy.subarray(0, len),
      mutation: 'truncate',
      offset: 0,
      before: null,
      after: null,
      truncatedTo: len,
    };
  }
  if (pick === 8) {
    const extra = Buffer.alloc(8 + Math.floor(rng() * 32), 0xab);
    return {
      data: Buffer.concat([copy, extra]),
      mutation: 'trailing-garbage',
      offset: copy.length,
      before: null,
      after: 0xab,
      truncatedTo: null,
    };
  }
  if (kind !== 'TokenAccount') {
    randomBytes(8).copy(copy, 0);
    return { data: copy, mutation: 'disc-replace', offset: 0, before: data[0]!, after: copy[0]!, truncatedTo: null };
  }
  // TokenAccount fallback: flip amount / state byte
  const offset = 64 + Math.floor(rng() * 8);
  const before = copy[offset]!;
  copy[offset] = before ^ 0xff;
  return { data: copy, mutation: 'random-byte-flip', offset, before, after: copy[offset]!, truncatedTo: null };
}

function overlaps(
  offset: number,
  span: number,
  region: { start: number; len: number },
): boolean {
  return offset < region.start + region.len && offset + span > region.start;
}

/** Whether acceptance would be a true hardening failure for the default probe. */
function mustRejectMutation(
  kind: AccountKind,
  mutation: string,
  offset: number,
  truncatedTo: number | null,
  afterByte: number | null,
): boolean {
  const layout = LAYOUT[kind];
  if (mutation === 'disc-byte-flip' || mutation === 'disc-replace') return kind !== 'TokenAccount';
  if (mutation === 'truncate') return (truncatedTo ?? 0) < layout.dataLen;
  if (mutation === 'bump-corrupt') {
    // Config.bump is stored but not re-verified on the seat probe (same as Anchor).
    if (kind === 'Config') return false;
    return layout.bump !== undefined && offset === layout.bump;
  }
  if (mutation === 'enum-status-ff') return layout.status !== undefined && offset === layout.status;
  if (mutation === 'bool-toggle') {
    return layout.criticalBools.includes(offset);
  }
  if (mutation === 'pubkey-zero') {
    // Zeroing PDA seed material or probe-checked identities must reject.
    const span = kind === 'MatchEscrow' && offset === 8 ? 16 : 32;
    return layout.criticalPubkeys.some((r) => overlaps(offset, Math.min(span, r.len), r));
  }
  // trailing-garbage / u64-max / random-byte-flip / non-critical bools: soft
  void afterByte;
  return false;
}

function txOk(result: unknown): boolean {
  return !(FailedTransactionMetadata && result instanceof FailedTransactionMetadata);
}

function errText(result: unknown): string | null {
  if (!(FailedTransactionMetadata && result instanceof FailedTransactionMetadata)) return null;
  try {
    const meta = (result as { meta?: () => unknown }).meta?.() ?? result;
    const logs = (meta as { logs?: () => string[] }).logs?.() ?? [];
    return logs.join('\n').slice(0, 500) || 'failed';
  } catch {
    return 'failed';
  }
}

function loadSvm(soPath: string): SvmInstance {
  if (!LiteSVMCtor) throw new Error(litesvmLoadError || 'litesvm unavailable');
  // Copy off /mnt/* to a native Linux tmp path — WSL 9p mounts can OOM LiteSVM.
  // Unique path per process to avoid parallel races on /tmp/<so-name>.
  const localSo = join(
    tmpdir(),
    `${basename(soPath)}.${process.pid}.${Date.now()}.so`,
  );
  copyFileSync(soPath, localSo);
  console.log(`loading SVM program from ${localSo} (${readFileSync(localSo).length} bytes)`);
  let svm: SvmInstance = new LiteSVMCtor();
  if (svm.withTransactionHistory) svm = svm.withTransactionHistory(0n);
  svm.addProgramFromFile(PROGRAM_ID, localSo);
  return svm;
}

function setProgAccount(
  svm: SvmInstance,
  address: PublicKey,
  data: Buffer,
  lamports: number,
  owner: PublicKey = PROGRAM_ID,
): void {
  svm.setAccount(address, {
    lamports,
    data,
    owner,
    executable: false,
    rentEpoch: 0,
  });
}

function fund(svm: SvmInstance, kp: Keypair, lamports = 10 * LAMPORTS_PER_SOL): void {
  svm.airdrop(kp.publicKey, BigInt(lamports));
}

type Fixtures = {
  authority: Keypair;
  keeper: Keypair;
  player1: Keypair;
  player2: Keypair;
  pokeMint: Keypair;
  roomId: Buffer;
  tournamentId: Buffer;
  settlementKey: Buffer;
  claimKey: Buffer;
  burnReplayKey: Buffer;
  config: PublicKey;
  configBump: number;
  feeVault: PublicKey;
  treasuryVault: PublicKey;
  operatorVault: PublicKey;
  matchEscrow: PublicKey;
  matchBump: number;
  matchVault: PublicKey;
  entryEscrow: PublicKey;
  entryBump: number;
  prizeReserve: PublicKey;
  prizeBump: number;
  prizeVault: PublicKey;
  replay: PublicKey;
  replayBump: number;
  treasuryDeposit: PublicKey;
  treasuryBump: number;
  cardsReserve: PublicKey;
  cardsBump: number;
  player1Ata: PublicKey;
  golden: Record<AccountKind, Buffer>;
  watchKeys: PublicKey[];
};

function buildFixtures(): Fixtures {
  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const player1 = Keypair.generate();
  const player2 = Keypair.generate();
  const pokeMint = Keypair.generate();
  const roomId = createHash('sha256').update('harden-room').digest().subarray(0, 16);
  const tournamentId = createHash('sha256').update('harden-tour').digest().subarray(0, 16);
  const settlementKey = createHash('sha256').update('harden-settle').digest();
  const claimKey = createHash('sha256').update('harden-claim').digest();
  const burnReplayKey = createHash('sha256').update('harden-burn-replay').digest();

  const [config, configBump] = configPda(PROGRAM_ID);
  const [feeVault] = feeVaultPda(PROGRAM_ID);
  const [treasuryVault] = treasuryVaultPda(PROGRAM_ID);
  const [operatorVault] = operatorVaultPda(PROGRAM_ID);
  const [matchEscrow, matchBump] = matchEscrowPda(PROGRAM_ID, roomId);
  const [matchVault] = matchVaultPda(PROGRAM_ID, roomId);
  const [entryEscrow, entryBump] = entryEscrowPda(PROGRAM_ID, tournamentId, player1.publicKey);
  const [prizeReserve, prizeBump] = prizeReservePda(PROGRAM_ID, tournamentId);
  const [prizeVault] = prizeVaultPda(PROGRAM_ID, tournamentId);
  const [replay, replayBump] = replayPda(PROGRAM_ID, settlementKey);
  const [treasuryDeposit, treasuryBump] = treasuryDepositPda(PROGRAM_ID, claimKey);
  const [cardsReserve, cardsBump] = cardsPrizeReservePda(PROGRAM_ID, tournamentId);
  const player1Ata = getAssociatedTokenAddressSync(
    pokeMint.publicKey,
    player1.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  const golden: Record<AccountKind, Buffer> = {
    Config: packConfig({
      authority: authority.publicKey,
      feeVault,
      treasuryVault,
      operatorVault,
      pokeMint: pokeMint.publicKey,
      quoteAuthority: authority.publicKey,
      keeper: keeper.publicKey,
      bump: configBump,
    }),
    MatchEscrow: packMatch({
      roomId,
      creator: player1.publicKey,
      opponent: player2.publicKey,
      collateral: 100_000_000n,
      creatorDep: true,
      opponentDep: true,
      feeCharged: false,
      status: 2, // Funded
      bump: matchBump,
    }),
    EntryEscrow: packEntry({
      tournamentId,
      player: player1.publicKey,
      amount: 5_000n,
      quoteId: createHash('sha256').update('q').digest(),
      price: 400_000n,
      status: 0,
      bump: entryBump,
    }),
    PrizeReserve: packPrize({
      tournamentId,
      winner: player1.publicKey,
      amount: 50_000_000n,
      status: 0,
      winnerSet: true,
      bump: prizeBump,
    }),
    Replay: packReplay({ key: settlementKey, kind: 0, bump: replayBump }),
    TreasuryDeposit: packTreasuryDeposit({
      claimKey,
      gross: 1_000_000_000n,
      treasury: 900_000_000n,
      operator: 100_000_000n,
      bump: treasuryBump,
    }),
    TokenAccount: packTokenAccount({
      mint: pokeMint.publicKey,
      owner: player1.publicKey,
      amount: 1_000_000n,
    }),
    CardsPrizeReserve: packCardsReserve({
      tournamentId,
      funder: keeper.publicKey,
      winner: PublicKey.default,
      amount: 100n,
      status: 0,
      winnerSet: false,
      bump: cardsBump,
      fundKey: createHash('sha256').update('cards-fund').digest(),
    }),
  };

  return {
    authority,
    keeper,
    player1,
    player2,
    pokeMint,
    roomId,
    tournamentId,
    settlementKey,
    claimKey,
    burnReplayKey,
    config,
    configBump,
    feeVault,
    treasuryVault,
    operatorVault,
    matchEscrow,
    matchBump,
    matchVault,
    entryEscrow,
    entryBump,
    prizeReserve,
    prizeBump,
    prizeVault,
    replay,
    replayBump,
    treasuryDeposit,
    treasuryBump,
    cardsReserve,
    cardsBump,
    player1Ata,
    golden,
    watchKeys: [config, matchEscrow, entryEscrow, prizeReserve, replay, treasuryDeposit, player1Ata, cardsReserve],
  };
}

function entryVaultOf(fx: Fixtures): PublicKey {
  return entryVaultPda(PROGRAM_ID, fx.tournamentId, fx.player1.publicKey)[0];
}

function installUniverseFixed(
  svm: SvmInstance,
  fx: Fixtures,
  corrupt?: { kind: AccountKind; data: Buffer },
): void {
  fund(svm, fx.authority);
  fund(svm, fx.keeper);
  fund(svm, fx.player1);
  fund(svm, fx.player2);

  const rent0 = Number(svm.minimumBalanceForRentExemption(0n));
  const rent = (n: number) => Number(svm.minimumBalanceForRentExemption(BigInt(n)));

  const data = (kind: AccountKind) =>
    corrupt && corrupt.kind === kind ? corrupt.data : fx.golden[kind];

  setProgAccount(svm, fx.config, data('Config'), rent(305));
  setProgAccount(svm, fx.feeVault, Buffer.alloc(0), rent0 + 50_000_000);
  setProgAccount(svm, fx.treasuryVault, Buffer.alloc(0), rent0 + 2_000_000_000);
  setProgAccount(svm, fx.operatorVault, Buffer.alloc(0), rent0 + 200_000_000);
  setProgAccount(svm, fx.matchEscrow, data('MatchEscrow'), rent(133));
  setProgAccount(svm, fx.matchVault, Buffer.alloc(0), rent0 + 200_000_000);
  setProgAccount(svm, fx.entryEscrow, data('EntryEscrow'), rent(138));
  setProgAccount(svm, fx.cardsReserve, data('CardsPrizeReserve'), rent(163));
  setProgAccount(svm, entryVaultOf(fx), Buffer.alloc(0), rent0 + 10_000);
  setProgAccount(svm, fx.prizeReserve, data('PrizeReserve'), rent(67));
  setProgAccount(svm, fx.prizeVault, Buffer.alloc(0), rent0 + 50_000_000);
  // Replay / treasury deposit: only install golden when NOT the corruption target
  // (for init probes we omit them; for corrupt-target we install corrupted bytes).
  if (corrupt?.kind === 'Replay') {
    setProgAccount(svm, fx.replay, data('Replay'), rent(42));
  }
  if (corrupt?.kind === 'TreasuryDeposit') {
    setProgAccount(svm, fx.treasuryDeposit, data('TreasuryDeposit'), rent(65));
  }
  setProgAccount(
    svm,
    fx.player1Ata,
    data('TokenAccount'),
    rent(165),
    TOKEN_2022_PROGRAM_ID,
  );
  const mintData = Buffer.alloc(82);
  mintData[0] = 1;
  mintData[44] = 6;
  mintData[45] = 1;
  svm.setAccount(fx.pokeMint.publicKey, {
    lamports: rent(82),
    data: mintData,
    owner: TOKEN_2022_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
}

function snapshot(svm: SvmInstance, keys: PublicKey[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of keys) {
    const acc = svm.getAccount(k);
    m.set(k.toBase58(), acc ? sha(Buffer.from(acc.data)) : 'missing');
  }
  return m;
}

function otherMutated(
  before: Map<string, string>,
  after: Map<string, string>,
  target: PublicKey,
): boolean {
  for (const [k, v] of before) {
    if (k === target.toBase58()) continue;
    if (after.get(k) !== v) return true;
  }
  return false;
}

function probeFor(
  kind: AccountKind,
  fx: Fixtures,
): { ix: TransactionInstruction; payer: Keypair; name: string; target: PublicKey } {
  switch (kind) {
    case 'Config':
      return {
        name: 'seat_match_opponent',
        payer: fx.authority,
        target: fx.config,
        ix: seatMatchOpponentIx({
          programId: PROGRAM_ID,
          authority: fx.authority.publicKey,
          config: fx.config,
          opponent: fx.player2.publicKey,
          roomId: fx.roomId,
        }),
      };
    case 'MatchEscrow':
      return {
        name: 'charge_match_fee',
        payer: fx.authority,
        target: fx.matchEscrow,
        ix: chargeMatchFeeIx({
          programId: PROGRAM_ID,
          authority: fx.authority.publicKey,
          config: fx.config,
          feeVault: fx.feeVault,
          roomId: fx.roomId,
        }),
      };
    case 'EntryEscrow':
      return {
        name: 'refund_poke_entry',
        payer: fx.authority,
        target: fx.entryEscrow,
        ix: refundPokeEntryIx({
          programId: PROGRAM_ID,
          authority: fx.authority.publicKey,
          config: fx.config,
          pokeMint: fx.pokeMint.publicKey,
          playerPoke: fx.player1Ata,
          tournamentId: fx.tournamentId,
          player: fx.player1.publicKey,
        }),
      };
    case 'PrizeReserve':
      return {
        name: 'pay_prize',
        payer: fx.authority,
        target: fx.prizeReserve,
        ix: payPrizeIx({
          programId: PROGRAM_ID,
          authority: fx.authority.publicKey,
          config: fx.config,
          winner: fx.player1.publicKey,
          tournamentId: fx.tournamentId,
          settlementKey: createHash('sha256').update('pay-probe').digest(),
        }),
      };
    case 'Replay':
      return {
        name: 'settle_match_win',
        payer: fx.authority,
        target: fx.replay,
        ix: settleMatchWinIx({
          programId: PROGRAM_ID,
          authority: fx.authority.publicKey,
          config: fx.config,
          winner: fx.player1.publicKey,
          roomId: fx.roomId,
          settlementKey: fx.settlementKey,
        }),
      };
    case 'TreasuryDeposit':
      return {
        name: 'deposit_treasury_sol',
        payer: fx.authority,
        target: fx.treasuryDeposit,
        ix: depositTreasurySolIx({
          programId: PROGRAM_ID,
          authority: fx.authority.publicKey,
          payer: fx.authority.publicKey,
          config: fx.config,
          treasuryVault: fx.treasuryVault,
          operatorVault: fx.operatorVault,
          claimKey: fx.claimKey,
          grossLamports: 1_000_000,
        }),
      };
    case 'TokenAccount':
      return {
        name: 'refund_poke_entry',
        payer: fx.authority,
        target: fx.player1Ata,
        ix: refundPokeEntryIx({
          programId: PROGRAM_ID,
          authority: fx.authority.publicKey,
          config: fx.config,
          pokeMint: fx.pokeMint.publicKey,
          playerPoke: fx.player1Ata,
          tournamentId: fx.tournamentId,
          player: fx.player1.publicKey,
        }),
      };
    case 'CardsPrizeReserve':
      return {
        name: 'set_cards_prize_winner',
        payer: fx.authority,
        target: fx.cardsReserve,
        ix: setCardsPrizeWinnerIx({
          programId: PROGRAM_ID,
          authority: fx.authority.publicKey,
          config: fx.config,
          winner: fx.player2.publicKey,
          tournamentId: fx.tournamentId,
        }),
      };
    default:
      throw new Error('unknown kind');
  }
}

function runProbe(svm: SvmInstance, fx: Fixtures, kind: AccountKind, corrupted: Buffer): {
  ok: boolean;
  err: string | null;
  mutatedOther: boolean;
} {
  installUniverseFixed(svm, fx, { kind, data: corrupted });
  // Config probe (seat_match_opponent) needs an Open/Funding match, not Funded.
  if (kind === 'Config') {
    const open = Buffer.from(fx.golden.MatchEscrow);
    Buffer.alloc(32, 0).copy(open, 56); // clear opponent pubkey → default
    open[96] = 1; // creator deposited
    open[97] = 0; // opponent not deposited
    open[98] = 0;
    open[99] = 1; // Funding
    setProgAccount(
      svm,
      fx.matchEscrow,
      open,
      Number(svm.minimumBalanceForRentExemption(133n)),
    );
  }
  // For Replay probe, also need fee_charged Active match:
  if (kind === 'Replay') {
    const active = Buffer.from(fx.golden.MatchEscrow);
    active[98] = 1; // fee charged
    active[99] = 3; // Active
    setProgAccount(
      svm,
      fx.matchEscrow,
      active,
      Number(svm.minimumBalanceForRentExemption(133n)),
    );
  }
  const probe = probeFor(kind, fx);
  const before = snapshot(svm, fx.watchKeys);
  const tx = new Transaction({
    feePayer: probe.payer.publicKey,
    recentBlockhash: svm.latestBlockhash(),
  }).add(probe.ix);
  tx.sign(probe.payer);
  const result = svm.sendTransaction(tx);
  const after = snapshot(svm, fx.watchKeys);
  // Advance blockhash so subsequent identical txs are not rejected as duplicates.
  try {
    (svm as SvmInstance & { expireBlockhash?: () => void }).expireBlockhash?.();
  } catch {
    /* optional */
  }
  const ok = txOk(result);
  // Successful probes intentionally write related accounts (vaults, escrow status).
  // Only rejected txs mutating non-target state is unauthorized.
  const mutatedOther = !ok && otherMutated(before, after, probe.target);
  return {
    ok,
    err: errText(result),
    mutatedOther,
  };
}

function runCampaign(): {
  seed: number;
  cases: CorruptCase[];
  summary: Record<string, number>;
} {
  const pinocchioSo = join(ROOT, 'target/deploy/arena_escrow_pinocchio.so');
  const anchorSo = join(ROOT, 'target/deploy/arena_escrow.so');
  assert.ok(existsSync(pinocchioSo), 'pinocchio .so missing');

  const fx = buildFixtures();
  const allKinds: AccountKind[] = [
    'Config',
    'MatchEscrow',
    'EntryEscrow',
    'PrizeReserve',
    'Replay',
    'TreasuryDeposit',
    'TokenAccount',
    'CardsPrizeReserve',
  ];
  const kindFilter = (process.env.POKEARENA_CORRUPT_KIND ?? '').trim();
  const kinds: AccountKind[] = kindFilter
    ? allKinds.filter((k) => k === kindFilter)
    : allKinds;
  assert.ok(kinds.length > 0, `unknown POKEARENA_CORRUPT_KIND=${kindFilter}`);
  const caseIndexFilter = process.env.POKEARENA_CORRUPT_CASE_INDEX;
  const onlyIndex =
    caseIndexFilter !== undefined && caseIndexFilter !== ''
      ? Number(caseIndexFilter)
      : null;

  type PartialCase = Omit<CorruptCase, 'pinocchio' | 'anchor' | 'unexpectedAccept' | 'acceptMismatch'> & {
    corrupted: Buffer;
  };
  const planned: PartialCase[] = [];
  let caseIndex = 0;
  for (const kind of kinds) {
    for (let i = 0; i < CASES_PER_TYPE; i++) {
      // Per-case RNG so one-case-per-process Anchor runs match bulk Pinocchio planning.
      const rng = mulberry32(
        (SEED ^ Math.imul(kind.length + 1, 0x9e3779b9) ^ CASES_PER_TYPE ^ Math.imul(i + 1, 0x85ebca6b)) >>>
          0,
      );
      if (onlyIndex !== null && i !== onlyIndex) {
        caseIndex++;
        continue;
      }
      const golden = fx.golden[kind];
      const m = mutate(rng, kind, golden, Math.floor(rng() * 1000) + i);
      const mustReject = mustRejectMutation(kind, m.mutation, m.offset, m.truncatedTo, m.after);
      const probe = probeFor(kind, fx);
      planned.push({
        id: `${kind}/${m.mutation}/${i}`,
        seed: SEED,
        caseIndex: caseIndex++,
        accountKind: kind,
        mutation: m.mutation,
        offset: m.offset,
        beforeByte: m.before,
        afterByte: m.after,
        truncatedTo: m.truncatedTo,
        probeIx: probe.name,
        mustReject,
        corrupted: m.data,
      });
    }
  }

  const impl = (process.env.POKEARENA_CORRUPT_IMPL ?? 'both').toLowerCase();
  const runOne = (label: 'pinocchio' | 'anchor', so: string) => {
    // Anchor BPF (~420KB) leaks/grows under LiteSVM across many txs; refresh periodically.
    const refreshEvery = label === 'anchor' ? 1 : 10_000;
    let svm = loadSvm(so);
    let n = 0;
    return planned.map((p) => {
      if (n > 0 && n % refreshEvery === 0) {
        svm = loadSvm(so);
      }
      n += 1;
      return {
        id: p.id,
        mustReject: p.mustReject,
        partial: p,
        result: runProbe(svm, fx, p.accountKind, p.corrupted),
      };
    });
  };

  // Optional single-impl mode avoids holding two large BPF images in one process.
  if (impl === 'pinocchio' || impl === 'anchor') {
    const so = impl === 'pinocchio' ? pinocchioSo : anchorSo;
    const rows = runOne(impl, so);
    const cases: CorruptCase[] = rows.map((r) => {
      const empty = { ok: false, err: 'not-run', mutatedOther: false };
      const pinocchio = impl === 'pinocchio' ? r.result : empty;
      const anchor = impl === 'anchor' ? r.result : empty;
      return {
        id: r.partial.id,
        seed: r.partial.seed,
        caseIndex: r.partial.caseIndex,
        accountKind: r.partial.accountKind,
        mutation: r.partial.mutation,
        offset: r.partial.offset,
        beforeByte: r.partial.beforeByte,
        afterByte: r.partial.afterByte,
        truncatedTo: r.partial.truncatedTo,
        probeIx: r.partial.probeIx,
        mustReject: r.partial.mustReject,
        pinocchio,
        anchor,
        unexpectedAccept: r.partial.mustReject && r.result.ok,
        acceptMismatch: false,
      };
    });
    const summary = {
      total: cases.length,
      mustReject: cases.filter((c) => c.mustReject).length,
      pinocchioAccepted: cases.filter((c) => c.pinocchio.ok).length,
      pinocchioRejected: cases.filter((c) => !c.pinocchio.ok).length,
      anchorAccepted: cases.filter((c) => c.anchor.ok).length,
      anchorRejected: cases.filter((c) => !c.anchor.ok).length,
      unexpectedAccept: cases.filter((c) => c.unexpectedAccept).length,
      acceptMismatch: 0,
      pinocchioMutatedOther: cases.filter((c) => c.pinocchio.mutatedOther).length,
      anchorMutatedOther: cases.filter((c) => c.anchor.mutatedOther).length,
    };
    return { seed: SEED, cases, summary };
  }

  // Default: spawn-less sequential via child processes is handled by the shell script.
  // In-process fallback runs Pinocchio only to stay within allocator limits.
  const rows = runOne('pinocchio', pinocchioSo);
  const cases: CorruptCase[] = rows.map((r) => ({
    id: r.partial.id,
    seed: r.partial.seed,
    caseIndex: r.partial.caseIndex,
    accountKind: r.partial.accountKind,
    mutation: r.partial.mutation,
    offset: r.partial.offset,
    beforeByte: r.partial.beforeByte,
    afterByte: r.partial.afterByte,
    truncatedTo: r.partial.truncatedTo,
    probeIx: r.partial.probeIx,
    mustReject: r.partial.mustReject,
    pinocchio: r.result,
    anchor: { ok: false, err: 'deferred-to-second-process', mutatedOther: false },
    unexpectedAccept: r.partial.mustReject && r.result.ok,
    acceptMismatch: false,
  }));
  const summary = {
    total: cases.length,
    pinocchioAccepted: cases.filter((c) => c.pinocchio.ok).length,
    pinocchioRejected: cases.filter((c) => !c.pinocchio.ok).length,
    anchorAccepted: 0,
    anchorRejected: 0,
    unexpectedAccept: cases.filter((c) => c.unexpectedAccept).length,
    acceptMismatch: 0,
    pinocchioMutatedOther: cases.filter((c) => c.pinocchio.mutatedOther).length,
    anchorMutatedOther: 0,
  };
  return { seed: SEED, cases, summary };
}

function runExplicitRejects(): { id: string; ok: boolean; err: string | null }[] {
  const pinocchioSo = join(ROOT, 'target/deploy/arena_escrow_pinocchio.so');
  const fx = buildFixtures();
  const svm = loadSvm(pinocchioSo);
  const rows: { id: string; ok: boolean; err: string | null }[] = [];

  const stale: Array<{ id: string; kind: AccountKind; size: number }> = [
    { id: 'stale-config-273', kind: 'Config', size: 273 },
    { id: 'stale-match-102', kind: 'MatchEscrow', size: 102 },
    { id: 'stale-entry-106', kind: 'EntryEscrow', size: 106 },
    { id: 'stale-cards-missing-pay-key', kind: 'CardsPrizeReserve', size: 131 },
    { id: 'match-missing-settlement-key', kind: 'MatchEscrow', size: 101 },
    { id: 'entry-missing-burn-key', kind: 'EntryEscrow', size: 106 },
  ];
  for (const row of stale) {
    const truncated = Buffer.from(fx.golden[row.kind].subarray(0, row.size));
    const result = runProbe(svm, fx, row.kind, truncated);
    rows.push({ id: row.id, ok: result.ok, err: result.err });
  }

  const classic = Buffer.from(fx.golden.TokenAccount);
  installUniverseFixed(svm, fx, { kind: 'TokenAccount', data: classic });
  svm.setAccount(fx.player1Ata, {
    lamports: Number(svm.minimumBalanceForRentExemption(165n)),
    data: classic,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
  });
  const probe = probeFor('TokenAccount', fx);
  const tx = new Transaction({
    feePayer: probe.payer.publicKey,
    recentBlockhash: svm.latestBlockhash(),
  }).add(probe.ix);
  tx.sign(probe.payer);
  const classicResult = svm.sendTransaction(tx);
  svm.expireBlockhash?.();
  rows.push({
    id: 'token-classic-spl-owner',
    ok: txOk(classicResult),
    err: errText(classicResult),
  });

  installUniverseFixed(svm, fx);
  svm.setAccount(fx.config, {
    lamports: Number(svm.minimumBalanceForRentExemption(305n)),
    data: fx.golden.Config,
    owner: SystemProgram.programId,
    executable: false,
    rentEpoch: 0,
  });
  const cfgProbe = probeFor('Config', fx);
  const cfgTx = new Transaction({
    feePayer: cfgProbe.payer.publicKey,
    recentBlockhash: svm.latestBlockhash(),
  }).add(cfgProbe.ix);
  cfgTx.sign(cfgProbe.payer);
  const cfgResult = svm.sendTransaction(cfgTx);
  rows.push({
    id: 'config-wrong-owner',
    ok: txOk(cfgResult),
    err: errText(cfgResult),
  });
  return rows;
}

function writeAndAssert(report: ReturnType<typeof runCampaign>): void {
  const extras = runExplicitRejects();
  const extraAccepts = extras.filter((row) => row.ok);
  mkdirSync(OUT_DIR, { recursive: true });
  const out = process.env.POKEARENA_CORRUPT_OUT
    ? process.env.POKEARENA_CORRUPT_OUT
    : join(OUT_DIR, 'corrupt-fuzz-report.json');
  writeFileSync(
    out,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        engine: 'litesvm',
        note: 'Executes identical .so artifacts as local-validator genesis load; setAccount enables byte mutations.',
        seed: report.seed,
        casesPerType: CASES_PER_TYPE,
        accountKinds: 8,
        summary: report.summary,
        explicitRejects: extras,
        failures: report.cases.filter((c) => c.unexpectedAccept || c.acceptMismatch || c.pinocchio.mutatedOther),
        cases: report.cases,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({
    out,
    seed: report.seed,
    summary: report.summary,
    explicitRejects: extras.map((row) => ({ id: row.id, rejected: !row.ok })),
  }, null, 2));

  assert.equal(extraAccepts.length, 0, `stale/wrong-owner/token-program cases accepted: ${extraAccepts.map((r) => r.id).join(',')}`);
  assert.equal(report.summary.unexpectedAccept, 0, 'unexpected accept of must-reject corruption');
  assert.equal(report.summary.pinocchioMutatedOther, 0, 'pinocchio mutated non-target accounts');
  const hardMismatch = report.cases.filter((c) => c.acceptMismatch && c.unexpectedAccept);
  assert.equal(hardMismatch.length, 0, `hard accept/reject mismatch: ${hardMismatch.map((c) => c.id).join(',')}`);
}

// CLI mode avoids node:test + LiteSVM native teardown abort on large Anchor BPF.
if (process.env.POKEARENA_CORRUPT_CLI === '1') {
  if (!LiteSVMCtor || !FailedTransactionMetadata) {
    console.error(`litesvm unavailable: ${litesvmLoadError ?? 'unknown'}`);
    process.exit(2);
  }
  try {
    writeAndAssert(runCampaign());
    // Hard-exit before native SVM destructors (can SIGABRT on large programs).
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
} else {
  test('hardening: byte-level account corruption fuzz (LiteSVM BPF)', (t) => {
    if (!LiteSVMCtor || !FailedTransactionMetadata) {
      t.skip(`litesvm native binding unavailable: ${litesvmLoadError ?? 'unknown'}`);
      return;
    }
    writeAndAssert(runCampaign());
  });
}

// silence unused import warnings for helpers kept for probes
void depositSolWagerIx;
void setPrizeWinnerIx;
void readFileSync;
void SystemProgram;
void TransactionInstruction;
void IX;
