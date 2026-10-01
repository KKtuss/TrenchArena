import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import { IX } from './discriminator';
import { TOKEN_PROGRAM_ID } from './token';
import {
  configPda,
  entryEscrowPda,
  entryVaultPda,
  feeVaultPda,
  matchEscrowPda,
  matchVaultPda,
  operatorVaultPda,
  prizeReservePda,
  prizeVaultPda,
  replayPda,
  treasuryDepositPda,
  treasuryVaultPda,
} from './pdas';

function u64(n: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function u8(n: number): Buffer {
  return Buffer.from([n & 0xff]);
}

export function initializeConfigIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  pokeMint: PublicKey;
  quoteAuthority: PublicKey;
  keeper: PublicKey;
  buybackBps: number | bigint;
  minBuybackLamports: number | bigint;
}): TransactionInstruction {
  const [config] = configPda(input.programId);
  const [feeVault] = feeVaultPda(input.programId);
  const [treasuryVault] = treasuryVaultPda(input.programId);
  const [operatorVault] = operatorVaultPda(input.programId);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: treasuryVault, isSigner: false, isWritable: true },
      { pubkey: operatorVault, isSigner: false, isWritable: true },
      { pubkey: input.pokeMint, isSigner: false, isWritable: false },
      { pubkey: input.quoteAuthority, isSigner: false, isWritable: false },
      { pubkey: input.keeper, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX.initializeConfig,
      u64(input.buybackBps),
      u64(input.minBuybackLamports),
    ]),
  });
}

export function createMatchEscrowIx(input: {
  programId: PublicKey;
  creator: PublicKey;
  config: PublicKey;
  roomId: Uint8Array;
  collateralLamports: number | bigint;
}): TransactionInstruction {
  const [matchEscrow] = matchEscrowPda(input.programId, input.roomId);
  const [matchVault] = matchVaultPda(input.programId, input.roomId);
  const data = Buffer.concat([
    IX.createMatchEscrow,
    Buffer.from(input.roomId),
    u64(input.collateralLamports),
  ]);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.creator, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: matchVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function depositSolWagerIx(input: {
  programId: PublicKey;
  depositor: PublicKey;
  roomId: Uint8Array;
  side: 0 | 1;
}): TransactionInstruction {
  const [matchEscrow] = matchEscrowPda(input.programId, input.roomId);
  const [matchVault] = matchVaultPda(input.programId, input.roomId);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.depositor, isSigner: true, isWritable: true },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: matchVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.depositSolWager, u8(input.side)]),
  });
}

export function seatMatchOpponentIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  opponent: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const [matchEscrow] = matchEscrowPda(input.programId, input.roomId);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: false },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.opponent, isSigner: false, isWritable: false },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
    ],
    data: IX.seatMatchOpponent,
  });
}

export function refundSolWagerIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  recipient: PublicKey;
  roomId: Uint8Array;
  side: 0 | 1;
}): TransactionInstruction {
  const [matchEscrow] = matchEscrowPda(input.programId, input.roomId);
  const [matchVault] = matchVaultPda(input.programId, input.roomId);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: false },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.recipient, isSigner: false, isWritable: true },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: matchVault, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([IX.refundSolWager, u8(input.side)]),
  });
}

export function chargeMatchFeeIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  feeVault: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const [matchEscrow] = matchEscrowPda(input.programId, input.roomId);
  const [matchVault] = matchVaultPda(input.programId, input.roomId);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: false },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: matchVault, isSigner: false, isWritable: true },
      { pubkey: input.feeVault, isSigner: false, isWritable: true },
    ],
    data: IX.chargeMatchFee,
  });
}

export function settleMatchWinIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  winner: PublicKey;
  roomId: Uint8Array;
  settlementKey: Uint8Array;
}): TransactionInstruction {
  const [matchEscrow] = matchEscrowPda(input.programId, input.roomId);
  const [matchVault] = matchVaultPda(input.programId, input.roomId);
  const [replay] = replayPda(input.programId, input.settlementKey);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.winner, isSigner: false, isWritable: true },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: matchVault, isSigner: false, isWritable: true },
      { pubkey: replay, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.settleMatchWin, Buffer.from(input.settlementKey)]),
  });
}

export function settleMatchTieIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  creator: PublicKey;
  opponent: PublicKey;
  roomId: Uint8Array;
  settlementKey: Uint8Array;
}): TransactionInstruction {
  const [matchEscrow] = matchEscrowPda(input.programId, input.roomId);
  const [matchVault] = matchVaultPda(input.programId, input.roomId);
  const [replay] = replayPda(input.programId, input.settlementKey);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: input.creator, isSigner: false, isWritable: true },
      { pubkey: input.opponent, isSigner: false, isWritable: true },
      { pubkey: matchVault, isSigner: false, isWritable: true },
      { pubkey: replay, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.settleMatchTie, Buffer.from(input.settlementKey)]),
  });
}

export function depositPokeEntryIx(input: {
  programId: PublicKey;
  player: PublicKey;
  config: PublicKey;
  pokeMint: PublicKey;
  playerPoke: PublicKey;
  tournamentId: Uint8Array;
  amount: bigint;
  quoteId: Uint8Array;
  priceMicroUsd: number | bigint;
}): TransactionInstruction {
  const [entryEscrow] = entryEscrowPda(input.programId, input.tournamentId, input.player);
  const [entryVault] = entryVaultPda(input.programId, input.tournamentId, input.player);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.player, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.pokeMint, isSigner: false, isWritable: false },
      { pubkey: input.playerPoke, isSigner: false, isWritable: true },
      { pubkey: entryEscrow, isSigner: false, isWritable: true },
      { pubkey: entryVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX.depositPokeEntry,
      Buffer.from(input.tournamentId),
      u64(input.amount),
      Buffer.from(input.quoteId),
      u64(input.priceMicroUsd),
    ]),
  });
}

export function burnPokeEntryIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  pokeMint: PublicKey;
  tournamentId: Uint8Array;
  player: PublicKey;
  burnKey: Uint8Array;
}): TransactionInstruction {
  const [entryEscrow] = entryEscrowPda(input.programId, input.tournamentId, input.player);
  const [entryVault] = entryVaultPda(input.programId, input.tournamentId, input.player);
  const [replay] = replayPda(input.programId, input.burnKey);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.pokeMint, isSigner: false, isWritable: true },
      { pubkey: entryEscrow, isSigner: false, isWritable: true },
      { pubkey: entryVault, isSigner: false, isWritable: true },
      { pubkey: replay, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.burnPokeEntry, Buffer.from(input.burnKey)]),
  });
}

export function refundPokeEntryIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  pokeMint: PublicKey;
  playerPoke: PublicKey;
  tournamentId: Uint8Array;
  player: PublicKey;
}): TransactionInstruction {
  const [entryEscrow] = entryEscrowPda(input.programId, input.tournamentId, input.player);
  const [entryVault] = entryVaultPda(input.programId, input.tournamentId, input.player);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: false },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.pokeMint, isSigner: false, isWritable: false },
      { pubkey: entryEscrow, isSigner: false, isWritable: true },
      { pubkey: input.playerPoke, isSigner: false, isWritable: true },
      { pubkey: entryVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: IX.refundPokeEntry,
  });
}

export function depositTreasurySolIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  payer: PublicKey;
  config: PublicKey;
  treasuryVault: PublicKey;
  operatorVault: PublicKey;
  claimKey: Uint8Array;
  grossLamports: number | bigint;
}): TransactionInstruction {
  const [treasuryDeposit] = treasuryDepositPda(input.programId, input.claimKey);
  const [replay] = replayPda(input.programId, input.claimKey);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.treasuryVault, isSigner: false, isWritable: true },
      { pubkey: input.operatorVault, isSigner: false, isWritable: true },
      { pubkey: treasuryDeposit, isSigner: false, isWritable: true },
      { pubkey: replay, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX.depositTreasurySol,
      Buffer.from(input.claimKey),
      u64(input.grossLamports),
    ]),
  });
}

export function reservePrizeIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  treasuryVault: PublicKey;
  tournamentId: Uint8Array;
  amount: number | bigint;
}): TransactionInstruction {
  const [prizeReserve] = prizeReservePda(input.programId, input.tournamentId);
  const [prizeVault] = prizeVaultPda(input.programId, input.tournamentId);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.treasuryVault, isSigner: false, isWritable: true },
      { pubkey: prizeVault, isSigner: false, isWritable: true },
      { pubkey: prizeReserve, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX.reservePrize,
      Buffer.from(input.tournamentId),
      u64(input.amount),
    ]),
  });
}

export function setPrizeWinnerIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  winner: PublicKey;
  tournamentId: Uint8Array;
}): TransactionInstruction {
  const [prizeReserve] = prizeReservePda(input.programId, input.tournamentId);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: false },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: prizeReserve, isSigner: false, isWritable: true },
      { pubkey: input.winner, isSigner: false, isWritable: false },
    ],
    data: IX.setPrizeWinner,
  });
}

export function payPrizeIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  winner: PublicKey;
  tournamentId: Uint8Array;
  settlementKey: Uint8Array;
}): TransactionInstruction {
  const [prizeReserve] = prizeReservePda(input.programId, input.tournamentId);
  const [prizeVault] = prizeVaultPda(input.programId, input.tournamentId);
  const [replay] = replayPda(input.programId, input.settlementKey);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: prizeReserve, isSigner: false, isWritable: true },
      { pubkey: input.winner, isSigner: false, isWritable: true },
      { pubkey: prizeVault, isSigner: false, isWritable: true },
      { pubkey: replay, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.payPrize, Buffer.from(input.settlementKey)]),
  });
}

export function releasePrizeIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  treasuryVault: PublicKey;
  tournamentId: Uint8Array;
}): TransactionInstruction {
  const [prizeReserve] = prizeReservePda(input.programId, input.tournamentId);
  const [prizeVault] = prizeVaultPda(input.programId, input.tournamentId);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: false },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.treasuryVault, isSigner: false, isWritable: true },
      { pubkey: prizeReserve, isSigner: false, isWritable: true },
      { pubkey: prizeVault, isSigner: false, isWritable: true },
    ],
    data: IX.releasePrize,
  });
}

export function buybackAndBurnPokeIx(input: {
  programId: PublicKey;
  authority: PublicKey;
  config: PublicKey;
  feeVault: PublicKey;
  swapWallet: PublicKey;
  pokeMint: PublicKey;
  pokeBurnSource: PublicKey;
  buybackKey: Uint8Array;
  solAmount: number | bigint;
  minPokeOut: number | bigint;
}): TransactionInstruction {
  const [replay] = replayPda(input.programId, input.buybackKey);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.config, isSigner: false, isWritable: false },
      { pubkey: input.feeVault, isSigner: false, isWritable: true },
      { pubkey: input.swapWallet, isSigner: false, isWritable: true },
      { pubkey: input.pokeMint, isSigner: false, isWritable: true },
      { pubkey: input.pokeBurnSource, isSigner: false, isWritable: true },
      { pubkey: replay, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX.buybackAndBurnPoke,
      Buffer.from(input.buybackKey),
      u64(input.solAmount),
      u64(input.minPokeOut),
    ]),
  });
}

export { configPda };
