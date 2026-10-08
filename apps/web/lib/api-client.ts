import {
  formatPokeFromAtoms,
  TOURNAMENT_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_BURN_FEE_ATOMS,
} from '@pokearena/solana-client/poke-units';

import { isDemoAuthEnabled } from './demo-auth';
import type { ClientMessage, ServerMessage } from './protocol';

export {
  formatPokeFromAtoms,
  TOURNAMENT_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_BURN_FEE_ATOMS,
};

type MessageHandler = (message: ServerMessage) => void;
export type ArenaConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

type WalletAuthHandlers = {
  address: string;
  signMessage: (message: string) => Promise<string>;
};

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getDefaultWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:3000/ws';
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const apiHost = process.env.NEXT_PUBLIC_API_HOST;
  if (apiHost) return `${protocol}//${apiHost}/ws`;
  const pageHost = window.location.hostname;
  if (pageHost === 'localhost' || pageHost === '127.0.0.1' || pageHost === '[::1]') {
    return `${protocol}//127.0.0.1:3000/ws`;
  }
  return `${protocol}//${window.location.host}/ws`;
}

export class ArenaApiClient {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private readonly handlers = new Set<MessageHandler>();
  private readonly connectionStateHandlers = new Set<(state: ArenaConnectionState) => void>();
  private readonly pending = new Map<string, {
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
  }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private identity: string | null = null;
  private authMode: 'demo' | 'wallet' | null = null;
  private walletAuth: WalletAuthHandlers | null = null;
  private resubscribeIds: string[] = [];
  /**
   * A replaced wallet session must not reconnect automatically. If it did,
   * two tabs (or an old page during refresh) could continuously evict each
   * other and reopen the wallet signature prompt.
   */
  private sessionReplaced = false;
  connectionState: ArenaConnectionState = 'idle';

  constructor(private readonly url = getDefaultWsUrl()) {}

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onConnectionState(handler: (state: ArenaConnectionState) => void): () => void {
    this.connectionStateHandlers.add(handler);
    handler(this.connectionState);
    return () => this.connectionStateHandlers.delete(handler);
  }

  getIdentity(): string | null {
    return this.identity;
  }

  async connect(playerId?: string): Promise<ServerMessage> {
    if (!isDemoAuthEnabled()) {
      throw new Error('Demo authentication is disabled.');
    }
    this.sessionReplaced = false;
    this.intentionallyClosed = false;
    if (playerId) {
      this.identity = playerId;
      this.authMode = 'demo';
      this.walletAuth = null;
    }
    await this.openSocket({ restore: false });
    if (!this.identity || this.authMode !== 'demo') {
      throw new Error('Identify with a development player before using the arena API.');
    }
    return this.request({ type: 'identify', playerId: this.identity });
  }

  async authenticateWallet(handlers: WalletAuthHandlers): Promise<ServerMessage> {
    this.sessionReplaced = false;
    this.intentionallyClosed = false;
    this.identity = handlers.address;
    this.authMode = 'wallet';
    this.walletAuth = handlers;
    await this.openSocket({ restore: false });
    return this.runWalletAuth(handlers);
  }

  /** Open the socket without authenticating so public capabilities (e.g. chain economy) can arrive. */
  async ensureOpen(): Promise<void> {
    this.intentionallyClosed = false;
    await this.openSocket({ restore: Boolean(this.identity) });
  }

  clearAuth(): void {
    this.identity = null;
    this.authMode = null;
    this.walletAuth = null;
  }

  setIdentity(playerId: string): void {
    this.identity = playerId;
    this.authMode = 'demo';
    this.walletAuth = null;
  }

  rememberSubscriptions(ids: string[]): void {
    this.resubscribeIds = [...ids];
  }

  async request(message: ClientMessage): Promise<ServerMessage> {
    return this.sendRequest(message, true);
  }

  private async sendRequest(message: ClientMessage, waitForReady: boolean): Promise<ServerMessage> {
    if (waitForReady && (this.opening || !this.socket || this.socket.readyState !== WebSocket.OPEN)) {
      await this.openSocket();
    }
    const requestId = createRequestId();
    const payload = { ...message, requestId };
    return new Promise<ServerMessage>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: value => {
          if (value.type === 'error') {
            reject(new Error(`${value.code}: ${value.message}`));
            return;
          }
          resolve(value);
        },
        reject,
      });
      this.socket!.send(JSON.stringify(payload));
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectPending(new Error('WebSocket closed by client.'));
    this.socket?.close();
    this.socket = null;
    this.setConnectionState('closed');
  }

  private async runWalletAuth(
    handlers: WalletAuthHandlers,
    waitForReady = true,
  ): Promise<ServerMessage> {
    const challenge = await this.sendRequest(
      { type: 'auth.challenge', address: handlers.address },
      waitForReady,
    );
    if (challenge.type !== 'auth.challenge') {
      throw new Error('Server did not return an authentication challenge.');
    }
    const signature = await handlers.signMessage(challenge.message);
    return this.sendRequest({
      type: 'auth.verify',
      address: handlers.address,
      signature,
      nonce: challenge.nonce,
    }, waitForReady);
  }

  private openSocket(options: { restore?: boolean } = {}): Promise<void> {
    if (this.opening) return this.opening;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    const shouldRestore = options.restore !== false;
    this.setConnectionState(this.connectionState === 'open' ? 'reconnecting' : 'connecting');
    this.opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.onopen = async () => {
        try {
          if (shouldRestore) await this.restoreSession();
          this.setConnectionState('open');
          this.opening = null;
          resolve();
        } catch (error) {
          this.opening = null;
          reject(error instanceof Error ? error : new Error(String(error)));
          socket.close();
        }
      };
      socket.onerror = () => {
        this.opening = null;
        reject(new Error('WebSocket connection failed.'));
      };
      socket.onclose = () => {
        this.opening = null;
        this.rejectPending(new Error('WebSocket connection closed.'));
        this.setConnectionState(this.intentionallyClosed ? 'closed' : 'reconnecting');
        if (!this.intentionallyClosed && !this.sessionReplaced) this.scheduleReconnect();
      };
      socket.onmessage = event => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'error' && message.code === 'SessionReplacedError') {
          this.sessionReplaced = true;
          this.intentionallyClosed = true;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.setConnectionState('closed');
        }
        if (message.requestId && this.pending.has(message.requestId)) {
          const pending = this.pending.get(message.requestId)!;
          this.pending.delete(message.requestId);
          pending.resolve(message);
        }
        for (const handler of this.handlers) handler(message);
      };
    });
    return this.opening;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket().catch(() => this.scheduleReconnect());
    }, 1000);
  }

  private async restoreSession(): Promise<void> {
    if (!this.identity) return;
    if (this.authMode === 'wallet' && this.walletAuth) {
      await this.runWalletAuth(this.walletAuth, false);
    } else if (this.authMode === 'demo') {
      await this.sendRequest({ type: 'identify', playerId: this.identity }, false);
    } else {
      return;
    }
    for (const matchId of this.resubscribeIds) {
      await this.sendRequest({ type: 'match.subscribe', matchId }, false);
    }
  }

  private setConnectionState(state: ArenaConnectionState): void {
    this.connectionState = state;
    for (const handler of this.connectionStateHandlers) handler(state);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function formatPoke(amount: number): string {
  return `${formatPokeValue(amount)} POKE`;
}

export function formatPokeValue(amount: number): string {
  return amount.toLocaleString('en-US');
}

/** Whole POKE from raw 6-decimal atoms. */
export function formatPokeAtomsValue(atoms: string | number): string {
  const raw = typeof atoms === 'number' ? BigInt(Math.trunc(atoms)) : BigInt(atoms);
  if (raw < 0n) return '0';
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  const wholeText = whole.toLocaleString('en-US');
  if (frac === 0n) return wholeText;
  const fracText = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${wholeText}.${fracText}`;
}

export function formatCardsRaw(raw: number): string {
  return `${raw.toLocaleString('en-US')} CARDS`;
}

/** SOL rooms store lamports on `collateral`. Mock rooms store POKE. */
export function formatRoomAmount(amount: number, rail?: 'legacy_poke' | 'sol_chain' | null): string {
  return rail === 'sol_chain' ? formatSolLamports(amount) : formatPoke(amount);
}

export function formatSolLamports(lamports: number | string): string {
  return `${formatSolLamportsValue(lamports)} SOL`;
}

export function formatSolLamportsValue(lamports: number | string): string {
  const value = typeof lamports === 'string' ? Number(lamports) : lamports;
  if (!Number.isFinite(value)) return '—';
  return (value / 1e9).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Fields needed to show cup prize/entry without mixing rails. */
export type TournamentMoneyFields = {
  rail?: 'legacy_poke' | 'sol_chain' | null;
  entryFee?: number;
  entryAtoms?: number;
  burnFeeAtoms?: number;
  prizeLamports?: number;
  prizeCardsRaw?: number;
  economics?: { prizePool?: number; entryFee?: number } | null;
};

/** Chain cups pay a reserved CARDS prize. Legacy cups derive POKE from entry holds. */
export function formatTournamentPrize(tournament: TournamentMoneyFields | null | undefined): string {
  if (!tournament) return '—';
  if (tournament.prizeCardsRaw !== undefined) {
    return `${tournament.prizeCardsRaw.toLocaleString('en-US')} CARDS`;
  }
  if (tournament.rail === 'sol_chain') {
    if (tournament.prizeLamports === undefined) return '—';
    return formatSolLamports(tournament.prizeLamports);
  }
  const pool = tournament.economics?.prizePool;
  return pool !== undefined ? formatPoke(pool) : '—';
}

/** Chain cups charge a fixed POKE burn after fill; legacy cups hold entryFee at join. */
export function formatTournamentEntry(tournament: TournamentMoneyFields | null | undefined): string {
  if (!tournament) return '—';
  if (tournament.rail === 'sol_chain') {
    const burn = tournament.burnFeeAtoms ?? tournament.entryAtoms;
    return burn !== undefined ? formatPokeFromAtoms(burn) : '—';
  }
  const fee = tournament.entryFee ?? tournament.economics?.entryFee;
  return fee !== undefined ? formatPoke(fee) : '—';
}

export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function choiceFromAvailable(choice: {
  type: string;
  slot?: number;
  terastallize?: boolean;
}): import('./protocol').PlayerChoice {
  switch (choice.type) {
    case 'team-preview':
      return { type: 'team-preview' };
    case 'pass':
      return { type: 'pass' };
    case 'move':
      return {
        type: 'move',
        slot: choice.slot ?? 1,
        ...(choice.terastallize ? { terastallize: true } : {}),
      };
    case 'switch':
      return { type: 'switch', slot: choice.slot ?? 1 };
    default:
      throw new Error(`Unsupported choice type: ${choice.type}`);
  }
}
