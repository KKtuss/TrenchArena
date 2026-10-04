import type { SolanaWalletAdapter } from './solana-wallet';
import { bytesToBase58 } from './solana-wallet';

/**
 * Sign and/or send a serialized transaction produced by the API.
 * `serializedTx` is a wire-format Transaction byte array (number[]).
 */
export async function sendSerializedTransaction(
  adapter: SolanaWalletAdapter,
  serializedTx: number[],
): Promise<string> {
  const signed = await signSerializedTransaction(adapter, serializedTx);
  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC?.trim();
  if (!rpc) {
    throw new Error('NEXT_PUBLIC_SOLANA_RPC is required for this wallet transaction flow.');
  }
  const { Connection } = await import('@solana/web3.js');
  const connection = new Connection(rpc, 'confirmed');
  await connection.sendRawTransaction(Uint8Array.from(signed.signedTransaction), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(signed.signature, 'confirmed');
  return signed.signature;
}

export async function signSerializedTransaction(
  adapter: SolanaWalletAdapter,
  serializedTx: number[],
): Promise<{ signature: string; signedTransaction: number[] }> {
  const bytes = Uint8Array.from(serializedTx);
  if (typeof adapter.signTransaction === 'function') {
    const { Transaction } = await import('@solana/web3.js');
    const tx = Transaction.from(bytes);
    const signed = await adapter.signTransaction(tx);
    if (!signed.signature) {
      throw new Error('Wallet returned a transaction without a signature.');
    }
    const signedBytes = signed.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    });
    const signedTx = Transaction.from(signedBytes);
    return {
      signature: bytesToBase58(signed.signature),
      signedTransaction: [...signedBytes],
    };
  }
  if (typeof adapter.signAndSendTransaction === 'function') {
    throw new Error('This wallet cannot sign the server-issued transaction without modifying it.');
  }
  throw new Error('Connected wallet cannot sign Solana transactions.');
}

