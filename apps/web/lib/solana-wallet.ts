'use client';

export type DetectedWallet = {
  id: string;
  name: string;
  icon?: string;
  adapter: SolanaWalletAdapter;
};

export type SolanaWalletAdapter = {
  publicKey?: { toString(): string } | null;
  isConnected?: boolean;
  connect(): Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<Uint8Array | { signature: Uint8Array }>;
  signTransaction?<T>(transaction: T): Promise<T>;
  signAndSendTransaction?<T>(
    transaction: T,
    options?: { skipPreflight?: boolean },
  ): Promise<{ signature: string } | string>;
  sendTransaction?<T>(
    transaction: T,
    connection?: unknown,
    options?: { skipPreflight?: boolean },
  ): Promise<string>;
};

declare global {
  interface Window {
    solana?: SolanaWalletAdapter & { isPhantom?: boolean; isBackpack?: boolean };
    phantom?: { solana?: SolanaWalletAdapter & { isPhantom?: boolean } };
    backpack?: SolanaWalletAdapter & { isBackpack?: boolean };
  }
}

function asAdapter(value: unknown): SolanaWalletAdapter | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as SolanaWalletAdapter;
  if (typeof candidate.connect !== 'function' || typeof candidate.signMessage !== 'function') {
    return null;
  }
  return candidate;
}

export function detectSolanaWallets(): DetectedWallet[] {
  if (typeof window === 'undefined') return [];
  const found: DetectedWallet[] = [];
  const seen = new Set<SolanaWalletAdapter>();

  const push = (id: string, name: string, adapter: SolanaWalletAdapter | null | undefined) => {
    if (!adapter || seen.has(adapter)) return;
    seen.add(adapter);
    found.push({ id, name, adapter });
  };

  push('phantom', 'Phantom', asAdapter(window.phantom?.solana) ?? (window.solana?.isPhantom ? asAdapter(window.solana) : null));
  push('backpack', 'Backpack', asAdapter(window.backpack) ?? (window.solana?.isBackpack ? asAdapter(window.solana) : null));
  // Generic injected Solana provider (includes some MetaMask Solana snaps / wallets).
  if (window.solana && !window.solana.isPhantom && !window.solana.isBackpack) {
    push('solana', 'Solana Wallet', asAdapter(window.solana));
  } else if (window.solana && found.length === 0) {
    push('solana', 'Solana Wallet', asAdapter(window.solana));
  }

  return found;
}

export async function connectWallet(adapter: SolanaWalletAdapter): Promise<string> {
  const result = await adapter.connect();
  const fromResult = result && typeof result === 'object' && result.publicKey
    ? result.publicKey.toString()
    : null;
  const fromAdapter = adapter.publicKey?.toString() ?? null;
  const address = fromResult || fromAdapter;
  if (!address) throw new Error('Wallet connected without a public key.');
  return address;
}

export async function disconnectWallet(adapter: SolanaWalletAdapter): Promise<void> {
  if (typeof adapter.disconnect === 'function') {
    await adapter.disconnect();
  }
}

export async function signAuthMessage(
  adapter: SolanaWalletAdapter,
  message: string,
): Promise<string> {
  const encoded = new TextEncoder().encode(message);
  const result = await adapter.signMessage(encoded);
  const signature = result instanceof Uint8Array ? result : result.signature;
  return bytesToBase58(signature);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bytesToBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const size = Math.ceil(bytes.length * 1.37) + 1;
  const digits = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    let j = 0;
    for (let k = size - 1; k >= 0 && (carry !== 0 || j < length); k -= 1, j += 1) {
      carry += 256 * digits[k]!;
      digits[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }
  let start = size - length;
  while (start < size && digits[start] === 0) start += 1;
  let out = '1'.repeat(zeros);
  for (let i = start; i < size; i += 1) out += BASE58_ALPHABET[digits[i]!]!;
  return out;
}
