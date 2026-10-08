'use client';

export type DetectedWallet = {
  id: string;
  name: string;
  icon?: string;
  adapter: SolanaWalletAdapter;
};

export type WalletOption = {
  id: string;
  name: string;
  installUrl: string;
  installed: boolean;
  adapter?: SolanaWalletAdapter;
};

export type SolanaWalletAdapter = {
  publicKey?: { toString(): string } | null;
  isConnected?: boolean;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect(): Promise<void>;
  signMessage(
    message: Uint8Array,
    display?: 'utf8' | 'hex',
  ): Promise<Uint8Array | { signature: Uint8Array }>;
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

export const KNOWN_WALLETS = [
  { id: 'phantom', name: 'Phantom', installUrl: 'https://phantom.app/download' },
  { id: 'solflare', name: 'Solflare', installUrl: 'https://solflare.com/download' },
  { id: 'backpack', name: 'Backpack', installUrl: 'https://backpack.app/download' },
  { id: 'metamask', name: 'MetaMask', installUrl: 'https://metamask.io/download' },
] as const;

/** Wallets whose `connect({ onlyIfTrusted: true })` rejects quietly instead of opening a popup. */
export const SILENT_TRUSTED_WALLET_IDS = new Set(['phantom', 'solflare', 'backpack']);

export function supportsSilentTrustedConnect(id: string): boolean {
  return SILENT_TRUSTED_WALLET_IDS.has(id);
}

declare global {
  interface Window {
    solana?: SolanaWalletAdapter & {
      isPhantom?: boolean;
      isBackpack?: boolean;
      isSolflare?: boolean;
      isMetaMask?: boolean;
    };
    phantom?: { solana?: SolanaWalletAdapter & { isPhantom?: boolean } };
    backpack?: SolanaWalletAdapter & { isBackpack?: boolean };
    solflare?: SolanaWalletAdapter & { isSolflare?: boolean };
    metamask?: { solana?: SolanaWalletAdapter };
    glow?: SolanaWalletAdapter;
    okxwallet?: { solana?: SolanaWalletAdapter };
    exodus?: { solana?: SolanaWalletAdapter };
  }
}

type StandardAccount = {
  address: string;
};

type StandardWallet = {
  name: string;
  accounts: StandardAccount[];
  features: Record<string, unknown>;
};

const STANDARD_CONNECT = 'standard:connect';
const STANDARD_DISCONNECT = 'standard:disconnect';
const SOLANA_SIGN_MESSAGE = 'solana:signMessage';

const standardWallets = new Map<string, StandardWallet>();
let standardBridgeStarted = false;

function asAdapter(value: unknown): SolanaWalletAdapter | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as SolanaWalletAdapter;
  if (typeof candidate.connect !== 'function' || typeof candidate.signMessage !== 'function') {
    return null;
  }
  return candidate;
}

function hasSolanaStandard(wallet: StandardWallet): boolean {
  return Boolean(
    wallet.features[STANDARD_CONNECT]
    && wallet.features[SOLANA_SIGN_MESSAGE],
  );
}

function standardWalletId(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower.includes('phantom')) return 'phantom';
  if (lower.includes('solflare')) return 'solflare';
  if (lower.includes('backpack')) return 'backpack';
  if (lower.includes('metamask')) return 'metamask';
  return lower.replace(/[^a-z0-9]+/g, '-') || 'solana';
}

function standardAdapter(wallet: StandardWallet): SolanaWalletAdapter {
  let account: StandardAccount | undefined = wallet.accounts[0];
  const connectFeature = wallet.features[STANDARD_CONNECT] as {
    connect(input?: { silent?: boolean }): Promise<{ accounts: StandardAccount[] }>;
  };
  const disconnectFeature = wallet.features[STANDARD_DISCONNECT] as {
    disconnect?: () => Promise<void>;
  } | undefined;
  const signFeature = wallet.features[SOLANA_SIGN_MESSAGE] as {
    signMessage(input: { account: StandardAccount; message: Uint8Array }): Promise<Array<{ signature: Uint8Array }>>;
  };

  return {
    get publicKey() {
      return account ? { toString: () => account!.address } : null;
    },
    async connect(options) {
      const silent = options?.onlyIfTrusted === true;
      const result = await connectFeature.connect({ silent });
      const connected = result.accounts[0] ?? (silent ? undefined : wallet.accounts[0]);
      if (!connected) {
        throw new Error(silent
          ? 'Wallet is not already authorized.'
          : 'Wallet connected without a public key.');
      }
      account = connected;
      return { publicKey: { toString: () => connected.address } };
    },
    async disconnect() {
      await disconnectFeature?.disconnect?.();
      account = undefined;
    },
    async signMessage(message) {
      if (!account) throw new Error('Wallet has no connected account.');
      const signed = await signFeature.signMessage({ account, message });
      const signature = signed[0]?.signature;
      if (!signature) throw new Error('Wallet did not return a signature.');
      return signature;
    },
  };
}

function registerStandardWallet(wallet: StandardWallet): void {
  if (!hasSolanaStandard(wallet)) return;
  standardWallets.set(wallet.name, wallet);
}

export function ensureWalletStandardBridge(): void {
  if (typeof window === 'undefined' || standardBridgeStarted) return;
  standardBridgeStarted = true;
  const onRegister = (event: Event) => {
    const detail = (event as CustomEvent<{ register?: (wallet: (candidate: StandardWallet) => void) => void }>).detail;
    try {
      detail?.register?.(registerStandardWallet);
    } catch {
      // A wallet that fails to register must not break detection of the others.
    }
  };
  window.addEventListener('wallet-standard:register-wallet', onRegister);
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
    detail: { register: registerStandardWallet },
  }));
}

export function detectSolanaWallets(): DetectedWallet[] {
  if (typeof window === 'undefined') return [];
  ensureWalletStandardBridge();
  const found: DetectedWallet[] = [];
  const seen = new Set<SolanaWalletAdapter>();

  const push = (id: string, name: string, adapter: SolanaWalletAdapter | null | undefined) => {
    if (!adapter || seen.has(adapter)) return;
    seen.add(adapter);
    found.push({ id, name, adapter });
  };

  push(
    'phantom',
    'Phantom',
    asAdapter(window.phantom?.solana)
      ?? (window.solana?.isPhantom && !window.solana.isMetaMask ? asAdapter(window.solana) : null),
  );
  push(
    'solflare',
    'Solflare',
    asAdapter(window.solflare) ?? (window.solana?.isSolflare ? asAdapter(window.solana) : null),
  );
  push(
    'backpack',
    'Backpack',
    asAdapter(window.backpack) ?? (window.solana?.isBackpack ? asAdapter(window.solana) : null),
  );
  push(
    'metamask',
    'MetaMask',
    asAdapter(window.metamask?.solana)
      ?? (window.solana?.isMetaMask && !window.solana.isPhantom ? asAdapter(window.solana) : null),
  );
  push('glow', 'Glow', asAdapter(window.glow));
  push('okx', 'OKX Wallet', asAdapter(window.okxwallet?.solana));
  push('exodus', 'Exodus', asAdapter(window.exodus?.solana));

  if (
    window.solana
    && !window.solana.isPhantom
    && !window.solana.isBackpack
    && !window.solana.isSolflare
    && !window.solana.isMetaMask
  ) {
    push('solana', 'Solana Wallet', asAdapter(window.solana));
  } else if (window.solana && found.length === 0) {
    push('solana', 'Solana Wallet', asAdapter(window.solana));
  }

  for (const wallet of standardWallets.values()) {
    const id = standardWalletId(wallet.name);
    if (found.some(item => item.id === id)) continue;
    push(id, wallet.name, standardAdapter(wallet));
  }

  return found;
}

export function listWalletOptions(): WalletOption[] {
  const detected = detectSolanaWallets();
  const used = new Set<string>();
  const options: WalletOption[] = KNOWN_WALLETS.map(known => {
    const found = detected.find(item => item.id === known.id);
    if (found) used.add(found.id);
    return {
      id: known.id,
      name: known.name,
      installUrl: known.installUrl,
      installed: Boolean(found),
      adapter: found?.adapter,
    };
  });
  for (const extra of detected) {
    if (used.has(extra.id)) continue;
    options.push({
      id: extra.id,
      name: extra.name,
      installUrl: 'https://solana.com/ecosystem/explore?categories=wallet',
      installed: true,
      adapter: extra.adapter,
    });
  }
  return options;
}

export function walletErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
    const code = (error as { code?: unknown }).code;
    if (code === 4001 || code === '4001') return 'Wallet connection was rejected.';
  }
  return 'Wallet connection failed.';
}

export function isWalletSessionBusyError(error: unknown): boolean {
  return /previous wallet connect session/i.test(walletErrorText(error));
}

export function walletErrorMessage(error: unknown): string {
  const raw = walletErrorText(error);
  if (raw === 'Unexpected error') {
    return 'The wallet popup could not finish connecting. Approve it if it is open, then try again.';
  }
  if (isWalletSessionBusyError(raw)) {
    return 'Another wallet popup is still open. Close it, then click Connect Phantom again.';
  }
  return raw;
}

export async function disconnectOtherWallets(keep?: SolanaWalletAdapter): Promise<void> {
  await Promise.allSettled(
    detectSolanaWallets()
      .filter(wallet => wallet.adapter !== keep)
      .map(wallet => disconnectWallet(wallet.adapter)),
  );
}

export async function connectWallet(
  adapter: SolanaWalletAdapter,
  options?: { onlyIfTrusted?: boolean },
): Promise<string> {
  const connectOnce = async () => {
    const already = adapter.isConnected ? adapter.publicKey?.toString() : null;
    if (already && !options?.onlyIfTrusted) return already;
    const result = options?.onlyIfTrusted
      ? await adapter.connect({ onlyIfTrusted: true })
      : await adapter.connect();
    const fromResult = result && typeof result === 'object' && result.publicKey
      ? result.publicKey.toString()
      : null;
    const fromAdapter = adapter.publicKey?.toString() ?? null;
    const address = fromResult || fromAdapter;
    if (!address) throw new Error('Wallet connected without a public key.');
    return address;
  };
  try {
    return await connectOnce();
  } catch (error) {
    if (options?.onlyIfTrusted || !isWalletSessionBusyError(error)) throw error;
    await disconnectOtherWallets(adapter);
    return connectOnce();
  }
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
  let result: Uint8Array | { signature: Uint8Array };
  try {
    result = await adapter.signMessage(encoded, 'utf8');
  } catch (error) {
    if (walletErrorText(error) !== 'Unexpected error') throw error;
    result = await adapter.signMessage(encoded);
  }
  const signature = result instanceof Uint8Array ? result : result.signature;
  if (!(signature instanceof Uint8Array) || signature.length === 0) {
    throw new Error('Wallet did not return a signature.');
  }
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
