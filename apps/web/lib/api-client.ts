import { isDemoAuthEnabled } from './demo-auth';
import type { ClientMessage, ServerMessage } from './protocol';

type MessageHandler = (message: ServerMessage) => void;

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
  const host = process.env.NEXT_PUBLIC_API_HOST ?? '127.0.0.1:3000';
  return `${protocol}//${host}/ws`;
}

export class ArenaApiClient {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private readonly handlers = new Set<MessageHandler>();
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
  connectionState: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' = 'idle';

  constructor(private readonly url = getDefaultWsUrl()) {}

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getIdentity(): string | null {
    return this.identity;
  }

  async connect(playerId?: string): Promise<ServerMessage> {
    if (!isDemoAuthEnabled()) {
      throw new Error('Demo authentication is disabled.');
    }
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
    this.intentionallyClosed = false;
    this.identity = handlers.address;
    this.authMode = 'wallet';
    this.walletAuth = handlers;
    await this.openSocket({ restore: false });
    return this.runWalletAuth(handlers);
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
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
    this.socket?.close();
    this.socket = null;
    this.connectionState = 'closed';
  }

  private async runWalletAuth(handlers: WalletAuthHandlers): Promise<ServerMessage> {
    const challenge = await this.request({ type: 'auth.challenge', address: handlers.address });
    if (challenge.type !== 'auth.challenge') {
      throw new Error('Server did not return an authentication challenge.');
    }
    const signature = await handlers.signMessage(challenge.message);
    return this.request({
      type: 'auth.verify',
      address: handlers.address,
      signature,
      nonce: challenge.nonce,
    });
  }

  private openSocket(options: { restore?: boolean } = {}): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.opening) return this.opening;

    const shouldRestore = options.restore !== false;
    this.connectionState = this.connectionState === 'open' ? 'reconnecting' : 'connecting';
    this.opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.onopen = () => {
        this.connectionState = 'open';
        this.opening = null;
        resolve();
        if (shouldRestore) void this.restoreSession();
      };
      socket.onerror = () => {
        this.opening = null;
        reject(new Error('WebSocket connection failed.'));
      };
      socket.onclose = () => {
        this.opening = null;
        this.connectionState = this.intentionallyClosed ? 'closed' : 'reconnecting';
        if (!this.intentionallyClosed) this.scheduleReconnect();
      };
      socket.onmessage = event => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
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
    try {
      if (this.authMode === 'wallet' && this.walletAuth) {
        await this.runWalletAuth(this.walletAuth);
      } else if (this.authMode === 'demo') {
        await this.request({ type: 'identify', playerId: this.identity });
      } else {
        return;
      }
      for (const matchId of this.resubscribeIds) {
        await this.request({ type: 'match.subscribe', matchId });
      }
    } catch {
      // Reconnect restoration is best-effort; UI surfaces connection state.
    }
  }
}

export function formatPoke(amount: number): string {
  return `${amount.toLocaleString('en-US')} POKE`;
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
