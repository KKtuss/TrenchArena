import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';

/**
 * Decide whether a close transaction should be sent again.
 * A missing account, or a zero-lamport system account, means the close already
 * landed. The caller must not build a second close against a different event.
 */
export async function closureState(
  connection: Connection,
  addresses: PublicKey[],
): Promise<'closed' | 'open'> {
  const infos = await connection.getMultipleAccountsInfo(addresses, 'confirmed');
  const closed = infos.every(
    (info) =>
      info == null ||
      (info.lamports === 0 && info.data.length === 0 && info.owner.equals(SystemProgram.programId)),
  );
  return closed ? 'closed' : 'open';
}
