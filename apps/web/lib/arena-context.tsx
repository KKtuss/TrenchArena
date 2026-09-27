'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ArenaApiClient } from './api-client';
import { isDemoAuthEnabled } from './demo-auth';
import type {
  ArenaSnapshot,
  BattleView,
  CasualRoom,
  MatchPayload,
  MockPayoutResult,
  PlayerId,
  ServerMessage,
  TournamentSummary,
} from './protocol';
import {
  connectWallet,
  detectSolanaWallets,
  disconnectWallet,
  signAuthMessage,
  type DetectedWallet,
  type SolanaWalletAdapter,
} from './solana-wallet';
import {
  DEFAULT_TRAINER_SPRITE_ID,
  getTrainerSprite,
  isTrainerUsername,
  readTrainerProfile,
  shortenAddress,
  writeTrainerProfile,
} from './trainer-profile';

interface ArenaContextValue {
  client: ArenaApiClient;
  playerId: PlayerId | null;
  playerLabel: string;
  connected: boolean;
  connectionState: string;
  snapshot: ArenaSnapshot | null;
  error: string | null;
  clearError: () => void;
  refreshSnapshot: () => Promise<void>;
  lastCasualResult: { room: CasualRoom; payout?: MockPayoutResult } | null;
  lastTournamentResult: { tournament: any; payout?: MockPayoutResult } | null;
  match: MatchPayload | null;
  battleView: BattleView | null;
  events: any[];
  setActiveMatchSubscription: (matchId: string | null) => void;
  walletAddress: string | null;
  walletConnected: boolean;
  availableWallets: DetectedWallet[];
  connectingWallet: boolean;
  connectInjectedWallet: (wallet?: DetectedWallet) => Promise<void>;
  connectPreviewSession: () => Promise<void>;
  disconnectInjectedWallet: () => Promise<void>;
  previewSession: boolean;
  trainerSpriteId: string;
  trainerUsername: string | null;
  needsProfileSetup: boolean;
  saveTrainerProfile: (username: string, spriteId: string) => void;
  authBusy: boolean;
}

const ArenaContext = createContext<ArenaContextValue | null>(null);
const PREVIEW_PLAYER_ID = 'demo-player-1';

const emptySnapshot = (playerId: PlayerId): ArenaSnapshot => ({
  wallet: {
    playerId,
    symbol: 'POKE',
    balance: 0,
    eligible: false,
  },
  tournaments: [],
  openCasualRooms: [],
  myCasualRooms: [],
  recentCasualResults: [],
});

export function ArenaProvider({ children }: { children: ReactNode }) {
  const [playerId, setPlayerIdState] = useState<PlayerId | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletAdapter, setWalletAdapter] = useState<SolanaWalletAdapter | null>(null);
  const [availableWallets, setAvailableWallets] = useState<DetectedWallet[]>([]);
  const [connectingWallet, setConnectingWallet] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [trainerSpriteId, setTrainerSpriteIdState] = useState(DEFAULT_TRAINER_SPRITE_ID);
  const [trainerUsername, setTrainerUsername] = useState<string | null>(null);
  const [needsProfileSetup, setNeedsProfileSetup] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState('idle');
  const [snapshot, setSnapshot] = useState<ArenaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCasualResult, setLastCasualResult] = useState<{
    room: CasualRoom;
    payout?: MockPayoutResult;
  } | null>(null);
  const [lastTournamentResult, setLastTournamentResult] = useState<{
    tournament: any;
    payout?: MockPayoutResult;
  } | null>(null);
  const [match, setMatch] = useState<MatchPayload | null>(null);
  const [battleView, setBattleView] = useState<BattleView | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);

  const client = useMemo(() => new ArenaApiClient(), []);

  useEffect(() => {
    const refresh = () => setAvailableWallets(detectSolanaWallets());
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const handleMessage = useCallback((message: ServerMessage) => {
    setConnectionState(client.connectionState);
    switch (message.type) {
      case 'arena.snapshot':
        setSnapshot(message.snapshot);
        break;
      case 'casual.state':
      case 'casual.created':
        setSnapshot(current => {
          if (!current) return current;
          const rooms = current.myCasualRooms.filter(room => room.id !== message.room.id);
          return {
            ...current,
            myCasualRooms: [message.room, ...rooms],
            openCasualRooms: message.room.roomType === 'open'
              ? [
                  message.room,
                  ...current.openCasualRooms.filter(room => room.id !== message.room.id),
                ]
              : current.openCasualRooms.filter(room => room.id !== message.room.id),
          };
        });
        break;
      case 'casual.result':
        setLastCasualResult({ room: message.room, payout: message.payout });
        break;
      case 'tournament.result':
        setLastTournamentResult({ tournament: message.tournament, payout: message.payout });
        break;
      case 'tournament.list':
        setSnapshot(current => current
          ? { ...current, tournaments: message.tournaments }
          : playerId
            ? { ...emptySnapshot(playerId), tournaments: message.tournaments }
            : current);
        break;
      case 'match.subscribed':
      case 'match.update':
        if (activeMatchId && message.match.id !== activeMatchId) break;
        setMatch(message.match);
        setBattleView(message.view ?? null);
        setEvents(message.events ?? []);
        break;
      case 'error':
        setError(`${message.code}: ${message.message}`);
        break;
      default:
        break;
    }
  }, [activeMatchId, client, playerId]);

  useEffect(() => {
    const unsubscribe = client.onMessage(handleMessage);
    return unsubscribe;
  }, [client, handleMessage]);

  const resetMatchState = useCallback(() => {
    setActiveMatchId(null);
    client.rememberSubscriptions([]);
    setMatch(null);
    setBattleView(null);
    setEvents([]);
    setLastCasualResult(null);
    setLastTournamentResult(null);
  }, [client]);

  const connectInjectedWallet = useCallback(async (wallet?: DetectedWallet) => {
    const selected = wallet ?? detectSolanaWallets()[0];
    if (!selected) {
      setError('No Solana wallet detected. Install Phantom, Backpack, or a compatible MetaMask Solana wallet.');
      return;
    }
    setConnectingWallet(true);
    setAuthBusy(true);
    setError(null);
    try {
      const address = await connectWallet(selected.adapter);
      setWalletAdapter(selected.adapter);
      setWalletAddress(address);
      const stored = readTrainerProfile(address);
      setTrainerSpriteIdState(getTrainerSprite(stored?.spriteId).id);
      setTrainerUsername(stored?.username || null);
      setNeedsProfileSetup(!stored?.username);
      await client.authenticateWallet({
        address,
        signMessage: message => signAuthMessage(selected.adapter, message),
      });
      setPlayerIdState(address);
      setConnected(true);
      setConnectionState(client.connectionState);
      resetMatchState();
    } catch (err) {
      setConnected(false);
      setPlayerIdState(null);
      setWalletAddress(null);
      client.clearAuth();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectingWallet(false);
      setAuthBusy(false);
    }
  }, [client, resetMatchState]);

  const connectPreviewSession = useCallback(async () => {
    if (!isDemoAuthEnabled()) {
      setError('Demo authentication is disabled.');
      return;
    }
    setConnectingWallet(true);
    setAuthBusy(true);
    setError(null);
    try {
      await client.connect(PREVIEW_PLAYER_ID);
      const stored = readTrainerProfile(PREVIEW_PLAYER_ID);
      setWalletAdapter(null);
      setWalletAddress(PREVIEW_PLAYER_ID);
      setTrainerSpriteIdState(getTrainerSprite(stored?.spriteId).id);
      setTrainerUsername(stored?.username || null);
      setNeedsProfileSetup(!stored?.username);
      setPlayerIdState(PREVIEW_PLAYER_ID);
      setConnected(true);
      setConnectionState(client.connectionState);
      resetMatchState();
    } catch (err) {
      setConnected(false);
      setPlayerIdState(null);
      setWalletAddress(null);
      client.clearAuth();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectingWallet(false);
      setAuthBusy(false);
    }
  }, [client, resetMatchState]);

  const disconnectInjectedWallet = useCallback(async () => {
    setAuthBusy(true);
    try {
      if (walletAdapter) await disconnectWallet(walletAdapter);
    } catch {
      // Ignore wallet disconnect errors; clear local session either way.
    }
    client.close();
    client.clearAuth();
    setWalletAdapter(null);
    setWalletAddress(null);
    setPlayerIdState(null);
    setConnected(false);
    setSnapshot(null);
    setTrainerSpriteIdState(DEFAULT_TRAINER_SPRITE_ID);
    setTrainerUsername(null);
    setNeedsProfileSetup(false);
    resetMatchState();
    setConnectionState('closed');
    setAuthBusy(false);
  }, [client, resetMatchState, walletAdapter]);

  const saveTrainerProfile = useCallback((username: string, spriteId: string) => {
    const name = username.trim();
    if (!walletAddress || !isTrainerUsername(name)) return;
    const sprite = getTrainerSprite(spriteId).id;
    setTrainerUsername(name);
    setTrainerSpriteIdState(sprite);
    setNeedsProfileSetup(false);
    writeTrainerProfile(walletAddress, { username: name, spriteId: sprite });
  }, [walletAddress]);

  const refreshSnapshot = useCallback(async () => {
    const response = await client.request({ type: 'arena.snapshot' });
    if (response.type === 'arena.snapshot') setSnapshot(response.snapshot);
  }, [client]);

  const setActiveMatchSubscription = useCallback((matchId: string | null) => {
    setActiveMatchId(matchId);
    client.rememberSubscriptions(matchId ? [matchId] : []);
    if (!matchId) {
      setMatch(null);
      setBattleView(null);
      setEvents([]);
    }
  }, [client]);

  const value: ArenaContextValue = {
    client,
    playerId,
    playerLabel: trainerUsername ?? (
      playerId === PREVIEW_PLAYER_ID ? 'Preview' : playerId ? shortenAddress(playerId) : 'Not connected'
    ),
    connected,
    connectionState,
    snapshot,
    error,
    clearError: () => setError(null),
    refreshSnapshot,
    lastCasualResult,
    lastTournamentResult,
    match,
    battleView,
    events,
    setActiveMatchSubscription,
    walletAddress,
    walletConnected: Boolean(walletAddress),
    availableWallets,
    connectingWallet,
    connectInjectedWallet,
    connectPreviewSession,
    disconnectInjectedWallet,
    previewSession: walletAddress === PREVIEW_PLAYER_ID,
    trainerSpriteId,
    trainerUsername,
    needsProfileSetup,
    saveTrainerProfile,
    authBusy,
  };

  return <ArenaContext.Provider value={value}>{children}</ArenaContext.Provider>;
}

export function useArena(): ArenaContextValue {
  const value = useContext(ArenaContext);
  if (!value) throw new Error('useArena must be used within ArenaProvider.');
  return value;
}

export function findTournament(
  snapshot: ArenaSnapshot | null,
  tournamentId: string,
): TournamentSummary | undefined {
  return snapshot?.tournaments.find(item => item.id === tournamentId);
}
