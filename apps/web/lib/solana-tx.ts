import type { SolanaWalletAdapter } from './solana-wallet';
import { bytesToBase58 } from './solana-wallet';

/**
 * Matches the chain client's retryable RPC classification. The browser sends
 * on its own connection, so this stays next to that send instead of calling
 * back into the API.
 */
function retryableRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate limit|temporarily unavailable|timeout|timed out|fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|ENOTFOUND|EPIPE|503|502|504|service unavailable|blockhash/i.test(message);
}

const SUBMIT_ATTEMPTS = 4;

export interface SignedSubmissionRpc {
  sendRawTransaction(
    rawTransaction: Uint8Array,
    options?: { skipPreflight?: boolean },
  ): Promise<string>;
  confirmTransaction(signature: string, commitment: 'confirmed'): Promise<unknown>;
}

/**
 * First attempt is immediate. Later attempts only resend the same signed bytes
 * after Helius (or another RPC) could not say whether that signature was accepted.
 */
export function submitRetryDelayMs(attempt: number): number {
  return Math.min(2_000, 200 * (2 ** attempt));
}

function alreadyAccepted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already processed|already confirmed|duplicate/i.test(message);
}

/**
 * Submit one already-signed transaction.
 * A 429 or an unknown RPC result retries that same payload. It never builds
 * or signs a replacement. The returned signature is the original one.
 */
export async function submitSignedTransaction(
  connection: SignedSubmissionRpc,
  signedTransaction: Uint8Array,
  signature: string,
  options?: {
    attempts?: number;
    retryDelayMs?: (attempt: number) => number;
  },
): Promise<string> {
  const attempts = options?.attempts ?? SUBMIT_ATTEMPTS;
  const delayMs = options?.retryDelayMs ?? submitRetryDelayMs;
  let submitted = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await connection.sendRawTransaction(signedTransaction, {
        skipPreflight: attempt > 0,
      });
      submitted = true;
      break;
    } catch (error) {
      if (alreadyAccepted(error)) {
        submitted = true;
        break;
      }
      if (!retryableRpcError(error)) throw error;
      if (attempt + 1 < attempts) {
        const wait = delayMs(attempt);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }

  if (!submitted) return signature;
  try {
    await connection.confirmTransaction(signature, 'confirmed');
  } catch (error) {
    if (retryableRpcError(error)) return signature;
    throw error;
  }
  return signature;
}

/**
 * Sign and/or send a serialized transaction produced by the API.
 * `serializedTx` is a wire-format Transaction byte array (number[]).
 * The wallet signs once. Submission retries reuse those exact bytes.
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
  const connection = new Connection(rpc, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  return submitSignedTransaction(
    connection,
    Uint8Array.from(signed.signedTransaction),
    signed.signature,
  );
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

