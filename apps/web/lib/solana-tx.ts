import type { SolanaWalletAdapter } from './solana-wallet';

/**
 * Sign and/or send a serialized transaction produced by the API.
 * `serializedTx` is a wire-format Transaction byte array (number[]).
 */
export async function sendSerializedTransaction(
  adapter: SolanaWalletAdapter,
  serializedTx: number[],
): Promise<string> {
  const bytes = Uint8Array.from(serializedTx);
  if (typeof adapter.signAndSendTransaction === 'function') {
    const { Transaction } = await import('@solana/web3.js');
    const tx = Transaction.from(bytes);
    const result = await adapter.signAndSendTransaction(tx);
    return typeof result === 'string' ? result : result.signature;
  }
  if (typeof adapter.signTransaction === 'function') {
    const { Connection, Transaction } = await import('@solana/web3.js');
    const tx = Transaction.from(bytes);
    const signed = await adapter.signTransaction(tx);
    const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC?.trim();
    if (!rpc) {
      throw new Error('NEXT_PUBLIC_SOLANA_RPC is required for this wallet transaction flow.');
    }
    const connection = new Connection(rpc, 'confirmed');
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  }
  throw new Error('Connected wallet cannot sign Solana transactions.');
}
