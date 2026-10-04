import { isRetryableRpcError } from '@pokearena/solana-client';

let installed = false;

/** Retryable RPC failures stay in-process. Anything else still terminates. */
export function handleProcessRpcError(
  operation: 'unhandledRejection' | 'uncaughtException',
  reason: unknown,
): 'contained' | 'fatal' {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (isRetryableRpcError(reason)) {
    console.error('[pokearena-rpc]', {
      operation,
      classified: 'retryable',
      message,
    });
    return 'contained';
  }
  console.error('[pokearena-rpc]', {
    operation,
    classified: 'fatal',
    message,
  });
  return 'fatal';
}

export function installRpcProcessGuard(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', reason => {
    if (handleProcessRpcError('unhandledRejection', reason) === 'fatal') process.exit(1);
  });
  process.on('uncaughtException', error => {
    if (handleProcessRpcError('uncaughtException', error) === 'fatal') process.exit(1);
  });
}

export function containRpc(
  operation: string,
  work: Promise<unknown>,
  context: Record<string, unknown> = {},
): void {
  void work.catch(error => {
    console.error('[pokearena-rpc]', {
      operation,
      classified: isRetryableRpcError(error) ? 'retryable' : 'error',
      message: error instanceof Error ? error.message : String(error),
      ...context,
    });
  });
}
