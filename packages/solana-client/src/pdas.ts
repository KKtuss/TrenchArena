import { PublicKey } from '@solana/web3.js';

import { sha256Bytes } from './sha256';

export function configPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
}

export function feeVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('fee_vault')], programId);
}

export function treasuryVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('treasury_vault')], programId);
}

export function operatorVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('operator_vault')], programId);
}

export function matchEscrowPda(programId: PublicKey, roomId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('match_escrow'), Buffer.from(roomId)], programId);
}

export function matchVaultPda(programId: PublicKey, roomId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('match_vault'), Buffer.from(roomId)], programId);
}

export function entryEscrowPda(
  programId: PublicKey,
  tournamentId: Uint8Array,
  player: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('entry_escrow'), Buffer.from(tournamentId), player.toBuffer()],
    programId,
  );
}

export function entryVaultPda(
  programId: PublicKey,
  tournamentId: Uint8Array,
  player: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('entry_vault'), Buffer.from(tournamentId), player.toBuffer()],
    programId,
  );
}

export function prizeReservePda(programId: PublicKey, tournamentId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('prize_reserve'), Buffer.from(tournamentId)],
    programId,
  );
}

export function prizeVaultPda(programId: PublicKey, tournamentId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('prize_vault'), Buffer.from(tournamentId)],
    programId,
  );
}

export function cardsPrizeReservePda(
  programId: PublicKey,
  tournamentId: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('cards_prize_reserve'), Buffer.from(tournamentId)],
    programId,
  );
}

export function cardsPrizeVaultPda(
  programId: PublicKey,
  tournamentId: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('cards_prize_vault'), Buffer.from(tournamentId)],
    programId,
  );
}

export function replayPda(programId: PublicKey, key: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('replay'), Buffer.from(key)], programId);
}

export function cardsTreasuryVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('cards_treasury_vault')], programId);
}

export function cardsOperatorVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('cards_operator_vault')], programId);
}

export function cardsTreasuryAuthorityPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('cards_treasury')], programId);
}

export function cardsOperatorAuthorityPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('cards_operator')], programId);
}

export function treasuryDepositPda(programId: PublicKey, claimKey: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury_deposit'), Buffer.from(claimKey)],
    programId,
  );
}

/** Encode a UUID string (with or without dashes) as 16 bytes. */
export function uuidToBytes(id: string): Buffer {
  const hex = id.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Expected UUID hex, got: ${id}`);
  }
  return Buffer.from(hex, 'hex');
}

export function sha256Key(parts: string[]): Buffer {
  return Buffer.from(sha256Bytes(parts.join('')));
}
