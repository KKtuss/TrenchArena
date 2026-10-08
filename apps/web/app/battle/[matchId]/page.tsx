'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';
import { CasualSelectBoard } from '@/components/casual-select';
import { BattleIntro } from '@/components/motion';

import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { ShowdownBattle } from '@/components/showdown-battle';
import { useArena } from '@/lib/arena-context';
import { formatRoomAmount, formatTournamentPrize } from '@/lib/api-client';

export default function BattlePage() {
  const params = useParams<{ matchId: string }>();
  const matchId = params?.matchId ?? '';
  const router = useRouter();
  const openedResult = useRef(false);
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
  const [selectedSlots, setSelectedSlots] = useState<number[]>([]);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const introRestore = useRef<boolean | null>(null);
  const seenOpen = useRef(connectionState === 'open');

  useEffect(() => {
    if (connectionState === 'open') seenOpen.current = true;
  }, [connectionState]);

  if (match && introRestore.current === null) {
    introRestore.current = connectionState === 'reconnecting'
      || match.status === 'completed'
      || (battleView?.turn ?? 0) > 1;
  }

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
  const tournamentSelection = match?.tournamentId ? match.selection : undefined;
  const selectionLeft = tournamentSelection
    ? Math.max(0, Math.ceil((tournamentSelection.selectionEndsAt - clock) / 1000))
    : null;

  useEffect(() => {
    setSelectedSlots(tournamentSelection?.selectedSlots ?? []);
  }, [tournamentSelection?.selectedSlots?.join(',')]);

  useEffect(() => {
    if (!tournamentSelection) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [tournamentSelection?.selectionEndsAt]);

  const sendTournamentSelection = async (slots: number[], confirm = false) => {
    setSelectionBusy(true);
    setError(null);
    try {
      await client.request({
        type: 'tournament.select',
        matchId,
        slots,
        confirm,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelectionBusy(false);
    }
  };

  const toggleTournamentSlot = (slot: number) => {
    if (tournamentSelection?.confirmed || selectionBusy) return;
    const next = selectedSlots.includes(slot)
      ? selectedSlots.filter(item => item !== slot)
      : selectedSlots.length < 3
        ? [...selectedSlots, slot]
        : selectedSlots;
    setSelectedSlots(next);
    void sendTournamentSelection(next);
  };

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
  const fightOver = Boolean(battleView?.result);
  const payoutSettled = match?.status === 'completed';

  useEffect(() => {
    if (!payoutSettled || !resultHref || openedResult.current) return;
    openedResult.current = true;
    router.push(resultHref);
  }, [payoutSettled, resultHref, router]);

  return (
    <div className="pa-page battle-page">
      <header className="pa-battle-bar">
        <div className="pa-battle-bar-fighters">
          <ProfileTrainerSprite label={you ?? 'You'} side="left" />
          <div>
            <b>{you ? <TrainerName playerId={you} /> : 'You'}</b>
            <small>{contextLabel}</small>
          </div>
          <span className="pa-fight-vs">vs</span>
          <div className="end">
            <b>{rival ? <TrainerName playerId={rival} fallback="Opponent" /> : 'Opponent'}</b>
            <small>Rival</small>
          </div>
          <ProfileTrainerSprite label={rival ?? 'Opponent'} side="right" />
        </div>
        <div className="pa-battle-bar-meta">
          {match?.tournamentId ? (
            <span>Prize <strong>{formatTournamentPrize(tournament)}</strong></span>
          ) : (
            <>
              <span>Stake <strong>{casualRoom ? formatRoomAmount(casualRoom.collateral, casualRoom.rail) : '—'}</strong></span>
              <span>Pot <strong>{casualRoom ? formatRoomAmount(casualRoom.economics.totalPot, casualRoom.rail) : '—'}</strong></span>
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

      <BattleIntro active={Boolean(match)} restoring={introRestore.current === true}>
        {introRestore.current ? 'Restoring this fight' : (
          <>
            <span>{you ? <TrainerName playerId={you} /> : 'You'}</span>
            <b>VS</b>
            <span>{rival ? <TrainerName playerId={rival} fallback="Rival" /> : 'Rival'}</span>
          </>
        )}
      </BattleIntro>

      {seenOpen.current && connectionState === 'reconnecting' ? (
        <div className="pa-live-strip pa-restore" role="status">
          <span className="pa-live-pill warn"><i /> Restoring</span>
          <span>Reconnecting. This fight stays where it was.</span>
        </div>
      ) : null}

      <ErrorToast error={error} onDismiss={() => setError(null)} />
      {tournamentSelection ? (
        <CasualSelectBoard
          yours={{
            playerId: playerId ?? 'you',
            presetId: tournamentSelection.presetId,
            presetName: tournamentSelection.presetName,
            pokemon: tournamentSelection.pokemon,
            confirmed: tournamentSelection.confirmed,
            selectedSlots: tournamentSelection.selectedSlots,
          }}
          selected={selectedSlots}
          confirmed={tournamentSelection.confirmed}
          rivalConfirmed={tournamentSelection.rivalConfirmed}
          secondsLeft={selectionLeft}
          poolLabel={`Round ${tournamentSelection.round} pool`}
          disabled={selectionBusy}
          busy={selectionBusy}
          onToggle={toggleTournamentSlot}
          onLock={() => void sendTournamentSelection(selectedSlots, true)}
        />
      ) : null}
      {fightOver && !payoutSettled ? (
        <div className="pa-live-strip pa-fight-banner" role="status">
          <span className="pa-live-pill warn"><i /> Settling</span>
          <span>Fight is over. Waiting for the on-chain SOL payout to confirm.</span>
          {resultHref ? (
            <Link className="pa-btn pa-btn-surface pa-btn-sm" href={resultHref}>Open result</Link>
          ) : null}
        </div>
      ) : null}
      {payoutSettled && resultHref ? (
        <div className="pa-live-strip pa-fight-banner">
          <span className="pa-live-pill"><i /> Fight over</span>
          <span>This fight is over. {match?.winner ? `${match.winner} takes it.` : 'The pot is settled.'}</span>
          <Link className="pa-btn pa-btn-primary pa-btn-sm" href={resultHref}>View result</Link>
        </div>
      ) : null}

      {playerId && !tournamentSelection ? (
        <ShowdownBattle
          playerId={playerId}
          matchId={matchId}
          battleInstanceId={match?.battleInstanceId}
          battleView={battleView}
          events={events}
          client={client}
          onError={onRendererError}
        />
      ) : !tournamentSelection ? (
        <div className="error-banner">Connect a wallet to join this fight.</div>
      ) : null}

      {resultHref && match?.status === 'completed' ? (
        <div className="pa-lobby-actions">
          <Link className="pa-btn pa-btn-primary" href={resultHref}>View result</Link>
          <Link className="pa-btn pa-btn-surface" href="/arena">Back to arena</Link>
        </div>
      ) : null}
    </div>
  );
}
