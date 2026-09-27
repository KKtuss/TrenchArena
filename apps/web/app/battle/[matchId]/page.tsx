'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';

import { ProfileTrainerSprite } from '@/components/profile-trainer';
import { ShowdownBattle } from '@/components/showdown-battle';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import { shortenAddress } from '@/lib/trainer-profile';

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
    if (!playerId) return;
    setActiveMatchSubscription(matchId);
    void client.request({ type: 'match.subscribe', matchId }).catch(err => {
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => setActiveMatchSubscription(null);
  }, [client, matchId, playerId, setActiveMatchSubscription]);

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

  const you = match?.player1 === playerId ? match.player1 : match?.player2;
  const rival = match?.player1 === playerId ? match?.player2 : match?.player1;
  const contextLabel = match?.tournamentId
    ? `${tournament?.title ?? 'Cup'} · R${match?.round ?? '—'}`
    : `${casualRoom?.battleSize ?? '1v1'} · Gen 9 OU`;

  const resultHref = match?.roomId
    ? `/result/${match.roomId}`
    : match?.id
      ? `/result/${match.id}`
      : null;

  return (
    <div className="pa-page battle-page">
      <header className="pa-battle-bar">
        <div className="pa-battle-bar-fighters">
          <ProfileTrainerSprite label={you ?? 'You'} side="left" />
          <div>
            <b>{you ? shortenAddress(you) : 'You'}</b>
            <small>{contextLabel}</small>
          </div>
          <span className="pa-fight-vs">vs</span>
          <div className="end">
            <b>{rival ? shortenAddress(rival) : 'Opponent'}</b>
            <small>Rival</small>
          </div>
          <ProfileTrainerSprite label={rival ?? 'Opponent'} side="right" />
        </div>
        <div className="pa-battle-bar-meta">
          {match?.tournamentId ? (
            <span>Prize <strong>{tournament ? formatPoke(tournament.economics.prizePool) : '—'}</strong></span>
          ) : (
            <>
              <span>Stake <strong>{casualRoom ? formatPoke(casualRoom.collateral) : '—'}</strong></span>
              <span>Pot <strong>{casualRoom ? formatPoke(casualRoom.economics.totalPot) : '—'}</strong></span>
            </>
          )}
          <span className={`pa-live-pill ${connectionState === 'open' ? '' : 'warn'}`}>
            <i /> {connectionState}
          </span>
          <span className={`pa-chip ${match?.status === 'completed' ? 'amber' : ''}`}>
            {(match?.status ?? 'loading').toUpperCase()}
          </span>
          <span className="pa-battle-id">#{matchId.slice(0, 8)}</span>
        </div>
      </header>

      <ErrorToast error={error} onDismiss={() => setError(null)} />
      {match?.status === 'completed' && resultHref ? (
        <div className="live-fight-banner">
          <span>This fight is over. {match.winner ? `${match.winner} takes it.` : 'The pot is settled.'}</span>
          <Link className="pa-btn pa-btn-primary pa-btn-sm" href={resultHref}>View result</Link>
        </div>
      ) : null}

      {playerId ? (
        <ShowdownBattle
          playerId={playerId}
          matchId={matchId}
          battleInstanceId={match?.battleInstanceId}
          battleView={battleView}
          events={events}
          client={client}
          onError={onRendererError}
        />
      ) : (
        <div className="error-banner">Connect a wallet to join this fight.</div>
      )}

      {resultHref && match?.status === 'completed' ? (
        <div className="pa-lobby-actions">
          <Link className="pa-btn pa-btn-primary" href={resultHref}>View result</Link>
          <Link className="pa-btn pa-btn-surface" href="/arena">Back to arena</Link>
        </div>
      ) : null}
    </div>
  );
}
