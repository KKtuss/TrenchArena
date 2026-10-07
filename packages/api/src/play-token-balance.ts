import { Connection, PublicKey, type Commitment } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@pokearena/solana-client';

/** SPL Token-2022 program id. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const COMMITMENT: Commitment = 'confirmed';

export class SplRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplRpcError';
  }
}

export type SplBalanceResult =
  | { ok: true; raw: bigint; decimals: number }
  | { ok: false; code: 'not_mint' | 'rpc_error' | 'inconsistent_decimals'; message: string };

interface TokenAccountLike {
  pubkey: PublicKey;
  account: {
    data: unknown;
  };
}

export interface SplBalanceConnection {
  getParsedAccountInfo(
    address: PublicKey,
    commitment?: Commitment,
  ): Promise<{ value: { owner: PublicKey; data: unknown } | null }>;
  getParsedTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey } | { programId: PublicKey },
    commitment?: Commitment,
  ): Promise<{ value: TokenAccountLike[] }>;
}

/**
 * Sum every token account for `mint` owned by `wallet`.
 * Decimals come from the mint account. Raw `amount` strings are summed as integers.
 * RPC failures throw into a not-ok result and never look like a zero balance.
 */
export async function readSplBalance(
  connection: SplBalanceConnection,
  wallet: PublicKey,
  mint: PublicKey,
  tokenProgram?: PublicKey,
): Promise<SplBalanceResult> {
  let mintAccount: { owner: PublicKey; data: unknown } | null;
  try {
    mintAccount = (await connection.getParsedAccountInfo(mint, COMMITMENT)).value;
  } catch {
    return { ok: false, code: 'rpc_error', message: 'Solana RPC failed while reading the mint account.' };
  }
  if (!mintAccount) {
    return { ok: false, code: 'not_mint', message: 'The address is not an SPL mint account.' };
  }
  if (tokenProgram && !mintAccount.owner.equals(tokenProgram)) {
    return { ok: false, code: 'not_mint', message: 'incorrect token program' };
  }
  const decimals = readMintDecimals(mintAccount);
  if (decimals === null) {
    return { ok: false, code: 'not_mint', message: 'The address is not an SPL mint account.' };
  }

  let accounts: TokenAccountLike[];
  try {
    accounts = await loadTokenAccounts(connection, wallet, mint, mintAccount.owner);
  } catch (error) {
    if (error instanceof SplRpcError) {
      return { ok: false, code: 'rpc_error', message: error.message };
    }
    return { ok: false, code: 'rpc_error', message: 'Solana RPC failed while reading token accounts.' };
  }

  let raw = 0n;
  const seen = new Set<string>();
  for (const account of accounts) {
    const key = account.pubkey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = readTokenAmount(account.account.data);
    if (!parsed || parsed.mint !== mint.toBase58()) continue;
    if (parsed.decimals !== decimals) {
      return {
        ok: false,
        code: 'inconsistent_decimals',
        message: 'A token account reported decimals that do not match the mint.',
      };
    }
    raw += parsed.amount;
  }
  return { ok: true, raw, decimals };
}

async function loadTokenAccounts(
  connection: SplBalanceConnection,
  wallet: PublicKey,
  mint: PublicKey,
  mintOwner: PublicKey,
): Promise<TokenAccountLike[]> {
  let byMint: TokenAccountLike[];
  try {
    byMint = (await connection.getParsedTokenAccountsByOwner(wallet, { mint }, COMMITMENT)).value;
  } catch {
    throw new SplRpcError('Solana RPC failed while reading token accounts.');
  }
  if (!mintOwner.equals(TOKEN_2022_PROGRAM_ID)) return byMint;

  let token2022: TokenAccountLike[];
  try {
    token2022 = (await connection.getParsedTokenAccountsByOwner(
      wallet,
      { programId: TOKEN_2022_PROGRAM_ID },
      COMMITMENT,
    )).value;
  } catch {
    throw new SplRpcError('Solana RPC failed while reading Token-2022 accounts.');
  }
  return token2022;
}

function readMintDecimals(account: { owner: PublicKey; data: unknown } | null): number | null {
  if (!account) return null;
  const tokenProgram = account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!tokenProgram) return null;
  const data = account.data;
  if (!data || typeof data !== 'object' || !('parsed' in data)) return null;
  const parsed = (data as { parsed?: { type?: unknown; info?: { decimals?: unknown } } }).parsed;
  if (!parsed || parsed.type !== 'mint') return null;
  const decimals = parsed.info?.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return null;
  }
  return decimals;
}

function readTokenAmount(data: unknown): { mint: string; amount: bigint; decimals: number } | null {
  if (!data || typeof data !== 'object' || !('parsed' in data)) return null;
  const parsed = (data as {
    parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } };
  }).parsed;
  const info = parsed?.info;
  if (!info || typeof info.mint !== 'string') return null;
  const amountText = info.tokenAmount?.amount;
  const decimals = info.tokenAmount?.decimals;
  if (typeof amountText !== 'string' || !/^\d+$/.test(amountText)) return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return null;
  }
  return { mint: info.mint, amount: BigInt(amountText), decimals };
}

export function createSplConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: COMMITMENT,
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(12_000),
    }),
  });
}
