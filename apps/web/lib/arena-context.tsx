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
import type {
  ArenaSnapshot,
  BattleView,
  CasualRoom,
  DemoPlayerId,
  MatchPayload,
  MockPayoutResult,
  ServerMessage,
  TournamentSummary,
} from './protocol';

interface ArenaContextValue {
  client: ArenaApiClient;
  playerId: DemoPlayerId;
  setPlayerId: (playerId: DemoPlayerId) => void;
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
}

const ArenaContext = createContext<ArenaContextValue | null>(null);

const emptySnapshot = (playerId: DemoPlayerId): ArenaSnapshot => ({
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
  const [playerId, setPlayerIdState] = useState<DemoPlayerId>('demo-player-1');
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
          : {
              ...emptySnapshot(playerId),
              tournaments: message.tournaments,
            });
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

  useEffect(() => {
    let cancelled = false;
    const connect = async () => {
      try {
        client.setIdentity(playerId);
        await client.connect(playerId);
        if (!cancelled) {
          setConnected(true);
          setConnectionState(client.connectionState);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setConnected(false);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void connect();
    return () => {
      cancelled = true;
    };
  }, [client, playerId]);

  const setPlayerId = useCallback((next: DemoPlayerId) => {
    setPlayerIdState(next);
    setActiveMatchId(null);
    client.rememberSubscriptions([]);
    setMatch(null);
    setBattleView(null);
    setEvents([]);
    setLastCasualResult(null);
    setLastTournamentResult(null);
  }, []);

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
    setPlayerId,
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
