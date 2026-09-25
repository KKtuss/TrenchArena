'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ShowdownBattle } from '@/components/showdown-battle';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';

export default function BattlePage() {
  const params = useParams<{ matchId: string }>();
  const matchId = params.matchId;
  const {
    client,
    playerId,
    match,
    battleView,
    events,
    connectionState,
    snapshot,
    setActiveMatchSubscription,
  } = useArena();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setActiveMatchSubscription(matchId);
    void client.request({ type: 'match.subscribe', matchId }).catch(err => {
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => setActiveMatchSubscription(null);
  }, [client, matchId, setActiveMatchSubscription]);

  const onRendererError = useCallback((message: string) => {
    setError(message);
  }, []);

  const casualRoom = useMemo(
    () => snapshot?.myCasualRooms.find(room => room.matchId === matchId),
    [matchId, snapshot?.myCasualRooms],
  );
  const tournament = useMemo(
    () => (match?.tournamentId
      ? snapshot?.tournaments.find(item => item.id === match.tournamentId)
      : undefined),
    [match?.tournamentId, snapshot?.tournaments],
  );
  const contextLabel = match?.tournamentId
    ? `${tournament?.title ?? 'Tournament'} · Round ${match?.round ?? '—'}`
    : `Casual · ${casualRoom?.battleSize ?? '1v1'}`;

  const resultHref = match?.roomId
    ? `/result/${match.roomId}`
    : match?.id
      ? `/result/${match.id}`
      : null;

  return (
    <div className="battle-page">
      <div className="battle-page-header row">
        <div>
          <div className="micro-label">{contextLabel}</div>
          <h1 style={{ margin: '6px 0' }}>
            {match?.player1 ?? 'P1'} vs {match?.player2 ?? 'P2'}
          </h1>
        </div>
        <div className="row">
          <span className="badge badge-live">{match?.status ?? 'loading'}</span>
        </div>
      </div>
      <div className="battle-context-strip">
        {match?.tournamentId ? (
          <>
            <span>Opponent <strong>{match.player1 === playerId ? match.player2 : match.player1}</strong></span>
            <span>Round <strong>{match.round ?? '—'}</strong></span>
            <span>Prize pool <strong>{tournament ? formatPoke(tournament.economics.prizePool) : '—'}</strong></span>
          </>
        ) : (
          <>
            <span>Opponent <strong>{match?.player1 === playerId ? match.player2 : match?.player1 ?? '—'}</strong></span>
            <span>Collateral <strong>{casualRoom ? formatPoke(casualRoom.collateral) : '—'}</strong></span>
            <span>Total pot <strong>{casualRoom ? formatPoke(casualRoom.economics.totalPot) : '—'}</strong></span>
          </>
        )}
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <ShowdownBattle
        playerId={playerId}
        matchId={matchId}
        battleInstanceId={match?.battleInstanceId}
        battleView={battleView}
        events={events}
        client={client}
        onError={onRendererError}
      />
      <div className="battle-page-footer row">
        <div className="row">
          <span className={`badge ${connectionState === 'reconnecting' ? 'badge-danger' : 'badge-success'}`}>
            Connection: {connectionState}
          </span>
          <span className="badge">Match #{matchId.slice(0, 8)}</span>
        </div>
        {resultHref && match?.status === 'completed' ? (
          <Link className="btn btn-primary" href={resultHref}>View result</Link>
        ) : null}
      </div>
    </div>
  );
}
