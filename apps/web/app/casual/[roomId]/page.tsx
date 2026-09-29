'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';

import { CasualSelectBoard } from '@/components/casual-select';
import { TeamStrip } from '@/components/showdown-visuals';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import type { CasualRoom } from '@/lib/protocol';
import { formatCasualRoomLabel } from '@/lib/protocol';
import { battlePaste, readSavedTeam, type SavedTeam } from '@/lib/team';

function formatLabel(room: CasualRoom): string {
  return formatCasualRoomLabel(room).toUpperCase();
}

function lobbyNote(input: {
  room: CasualRoom;
  competitive: boolean;
  countingDown: boolean;
  countdownLeft: number;
  youReady: boolean;
  rivalReady: boolean;
  yoursConfirmed: boolean;
  rivalConfirmed: boolean;
}): string {
  const {
    room,
    competitive,
    countingDown,
    countdownLeft,
    youReady,
    rivalReady,
    yoursConfirmed,
    rivalConfirmed,
  } = input;
  if (room.battleSize === '2v2') return '2v2 rooms can be configured, but starts are not live yet.';
  if (room.status === 'cancelled') return 'This challenge was cancelled.';
  if (competitive) {
    if (!room.opponentId) return 'Waiting for a rival. Keep your Gen 9 OU team ready — nothing is revealed yet.';
    if (youReady && rivalReady) {
      return countingDown && countdownLeft > 0
        ? `Both trainers locked. Battle starts in ${countdownLeft}.`
        : 'Both trainers locked. Starting the fight.';
    }
    if (youReady) return 'You locked your six. Waiting for the rival to ready up.';
    return 'Lock the active team from My Teams. The rival cannot see your paste.';
  }
  if (!room.opponentId) {
    return 'Waiting for a rival. Ready up together — random sixes stay sealed until the countdown ends.';
  }
  if (room.status === 'drafting') {
    if (yoursConfirmed && rivalConfirmed) return 'Both trainers locked three. Starting the fight.';
    if (yoursConfirmed) return 'You locked three. Waiting for the rival to confirm.';
    return 'Pick three Pokémon, then confirm. The rival cannot see your pick until both lock.';
  }
  if (youReady && rivalReady) {
    return countingDown && countdownLeft > 0
      ? `Both trainers ready. Teams drop in ${countdownLeft}.`
      : 'Countdown done. Dealing your random sixes.';
  }
  if (youReady) return 'You are ready. Waiting for the rival to ready up.';
  return 'Ready up. Random sixes drop after both trainers ready and the countdown ends.';
}

function sideReadyLabel(input: {
  isYou: boolean;
  hasRival: boolean;
  competitive: boolean;
  drafting: boolean;
  ready: boolean;
  waitingForJoin: boolean;
}): string {
  const { isYou, hasRival, competitive, drafting, ready, waitingForJoin } = input;
  if (!isYou && !hasRival) return 'Open queue';
  if (drafting) return ready ? 'Locked' : 'Picking';
  if (competitive) return ready ? 'Locked' : (isYou ? 'Team pending' : 'Joined');
  if (waitingForJoin) return 'Waiting';
  return ready ? 'Ready' : (isYou ? 'Not ready' : 'Joined');
}

export default function CasualRoomPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const { client, playerId, connected } = useArena();
  const router = useRouter();
  const [room, setRoom] = useState<CasualRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [savedTeam, setSavedTeam] = useState<SavedTeam | null>(null);
  const [starterPaste, setStarterPaste] = useState<string>();
  const [clock, setClock] = useState(() => Date.now());
  const startRequested = useRef(false);

  useEffect(() => {
    setSavedTeam(playerId ? readSavedTeam(playerId) : null);
  }, [playerId]);

  useEffect(() => {
    if (!connected) return;
    const unsubscribe = client.onMessage(message => {
      if ((message.type === 'casual.state' || message.type === 'casual.created') && message.room.id === roomId) {
        setRoom(message.room);
      }
      if (message.type === 'casual.result' && message.room.id === roomId) {
        setRoom(message.room);
      }
    });
    void client.request({ type: 'casual.subscribe', roomId }).then(response => {
      if (response.type === 'casual.state') setRoom(response.room);
    }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    return unsubscribe;
  }, [client, connected, roomId]);

  const youAreCreator = Boolean(room && playerId && room.creatorId === playerId);
  const yours = useMemo(
    () => room?.teamPreview?.find(preview => preview.playerId === playerId),
    [playerId, room],
  );
  const rivalPreview = useMemo(
    () => room?.teamPreview?.find(preview => preview.playerId !== playerId),
    [playerId, room],
  );

  useEffect(() => {
    setSelected(yours?.selectedSlots ?? []);
  }, [yours?.presetId, yours?.selectedSlots?.join(',')]);

  const isPlayer = Boolean(room && playerId && (room.creatorId === playerId || room.opponentId === playerId));
  const canAccept = Boolean(room && playerId && room.status === 'open' && room.creatorId !== playerId
    && (!room.invitedPlayerId || room.invitedPlayerId === playerId));

  const yourId = room
    ? (youAreCreator ? room.creatorId : (room.opponentId ?? playerId ?? 'You'))
    : (playerId ?? 'You');
  const rivalId = room
    ? (youAreCreator ? room.opponentId : room.creatorId)
    : undefined;
  const youReady = Boolean(playerId && room?.ready[playerId]);
  const rivalReady = Boolean(room && rivalId ? room.ready[rivalId] : false);
  const casualSelect = Boolean(room && (room.ruleset ?? 'casual') === 'casual' && room.battleSize === '1v1');
  const competitive = Boolean(room && room.ruleset === 'competitive' && room.battleSize === '1v1');
  const drafting = Boolean(casualSelect && room?.status === 'drafting');
  const selecting = drafting;
  const revealed = Boolean(yours?.confirmed && rivalPreview?.confirmed);
  const canConfirm = selecting && isPlayer && !yours?.confirmed && selected.length === 3;
  const ownPaste = (playerId ? battlePaste(playerId) : undefined) ?? starterPaste;
  const canLockCompetitive = Boolean(ownPaste);
  const countdownEndsAt = room?.status === 'ready' && room.battleSize === '1v1' ? room.countdownEndsAt : undefined;
  const countdownLeft = countdownEndsAt
    ? Math.max(0, Math.ceil((countdownEndsAt - clock) / 1000))
    : 0;
  const countingDown = Boolean(countdownEndsAt);

  useEffect(() => {
    if (!countdownEndsAt) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [countdownEndsAt]);

  useEffect(() => {
    startRequested.current = false;
  }, [room?.status]);

  useEffect(() => {
    if (!connected || !competitive || savedTeam?.validated) return;
    let cancelled = false;
    void client.request({ type: 'team.starter' }).then(response => {
      if (!cancelled && response.type === 'team.starter') setStarterPaste(response.paste);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, connected, competitive, savedTeam?.validated]);

  useEffect(() => {
    if (!room || !isPlayer || room.battleSize !== '1v1') return;
    const countdownPending = Boolean(room.countdownEndsAt && clock < room.countdownEndsAt);
    const shouldAdvanceReady = room.status === 'ready' && !countdownPending;
    if (!shouldAdvanceReady) return;
    if (startRequested.current || busy) return;
    startRequested.current = true;
    void client.request({ type: 'casual.start', roomId }).then(response => {
      if (response.type === 'casual.state') {
        setRoom(response.room);
        if (response.room.status === 'battling') {
          router.push(`/battle/${response.room.matchId}`);
        }
      }
    }).catch(err => {
      startRequested.current = false;
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [
    busy,
    client,
    clock,
    isPlayer,
    room,
    roomId,
    router,
  ]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendSelection = async (slots: number[], confirm = false) => {
    const response = await client.request({
      type: 'casual.select',
      roomId,
      slots,
      confirm,
    });
    if (response.type === 'casual.state') setRoom(response.room);
  };

  const toggleSlot = (slot: number) => {
    if (yours?.confirmed || busy) return;
    const next = selected.includes(slot)
      ? selected.filter(item => item !== slot)
      : selected.length < 3
        ? [...selected, slot]
        : selected;
    setSelected(next);
    void act(() => sendSelection(next));
  };

  const code = room ? room.id.slice(0, 8).toUpperCase() : '········';

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <p className="pa-kicker"><i /> — {room ? formatCasualRoomLabel(room) : 'Arena fight'} —</p>
          <h1>{room ? `Challenge ${code}` : 'Finding your room…'}</h1>
          <p className="pa-lead">
            {competitive
              ? 'Bring a legal Gen 9 OU team. The rival cannot see your paste until the fight starts.'
              : 'Ready up after a rival joins. Random sixes drop after the countdown, then pick three.'}
          </p>
        </div>
        <Link className="pa-btn pa-btn-surface" href="/arena">Back to arena</Link>
      </header>

      <section className="pa-lobby">
        {room ? (
          <>
            <div className="pa-lobby-rail">
              <span className={`pa-live-pill status-${room.status}`}>
                <i /> {room.status}
              </span>
              <span className="pa-chip">{formatLabel(room)}</span>
              <span className="pa-chip">{room.battleSize.toUpperCase()}</span>
            </div>

            <p className="pa-lobby-note">
              {room ? lobbyNote({
                room,
                competitive,
                countingDown,
                countdownLeft,
                youReady,
                rivalReady,
                yoursConfirmed: Boolean(yours?.confirmed),
                rivalConfirmed: Boolean(rivalPreview?.confirmed),
              }) : ''}
            </p>

            {casualSelect && drafting ? (
              <CasualSelectBoard
                yours={yours}
                rival={rivalPreview}
                selected={selected}
                confirmed={Boolean(yours?.confirmed)}
                rivalConfirmed={Boolean(rivalPreview?.confirmed)}
                revealed={revealed}
                disabled={busy}
                onToggle={toggleSlot}
              />
            ) : null}

            {casualSelect && !drafting && room.status !== 'starting' && room.status !== 'battling' && room.status !== 'completed' && room.status !== 'cancelled' ? (
              <div className="pa-protocol">
                <span>
                  {countingDown
                    ? 'Random sixes drop when the countdown ends'
                    : room.opponentId
                      ? 'Ready up to deal random sixes'
                      : 'Sixes stay sealed until both trainers ready and the countdown ends'}
                </span>
                <TeamStrip slots={6} />
              </div>
            ) : null}

            {competitive ? (
              <div className="pa-protocol">
                <span>
                  {savedTeam?.validated
                    ? savedTeam.name
                    : starterPaste
                      ? 'Demo Circuit'
                      : 'No legal team locked on this trainer'}
                </span>
                <TeamStrip species={savedTeam?.species} slots={6} />
                {!canLockCompetitive ? (
                  <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/teams">Open My Teams</Link>
                ) : null}
              </div>
            ) : null}

            {room.battleSize === '2v2' ? (
              <div className="pa-protocol">
                <span>2v2 roster</span>
                <TeamStrip slots={3} />
              </div>
            ) : null}

            {countingDown ? (
              <div className="pa-countdown" role="status" aria-live="polite">
                <small>
                  {casualSelect
                    ? (countdownLeft > 0 ? 'Teams drop in' : 'Deal!')
                    : (countdownLeft > 0 ? 'Battle starts in' : 'Fight!')}
                </small>
                <b>{countdownLeft > 0 ? countdownLeft : 'GO'}</b>
              </div>
            ) : null}

            <div className="pa-lobby-vs">
              <article className="pa-lobby-side cyan">
                <small>Your trainer</small>
                <ProfileTrainerSprite label={yourId} side="left" />
                <strong><TrainerName playerId={yourId} /></strong>
                <span className={`pa-lobby-ready ${youReady ? 'on' : ''}`}>
                  {sideReadyLabel({
                    isYou: true,
                    hasRival: Boolean(rivalId),
                    competitive,
                    drafting,
                    ready: youReady,
                    waitingForJoin: !room.opponentId,
                  })}
                </span>
              </article>
              <div className="pa-lobby-mid">
                <span>VS</span>
              </div>
              <article className="pa-lobby-side coral">
                <small>Opponent</small>
                {rivalId ? <ProfileTrainerSprite label={rivalId} side="right" /> : <span className="pa-fight-open" aria-hidden />}
                <strong>{rivalId ? <TrainerName playerId={rivalId} /> : 'Waiting…'}</strong>
                <span className={`pa-lobby-ready ${rivalReady ? 'on' : ''}`}>
                  {sideReadyLabel({
                    isYou: false,
                    hasRival: Boolean(rivalId),
                    competitive,
                    drafting,
                    ready: rivalReady,
                    waitingForJoin: !room.opponentId,
                  })}
                </span>
              </article>
            </div>
          </>
        ) : (
          <p className="pa-empty">Subscribing to room…</p>
        )}
      </section>

      {room ? (
        <section className="pa-split">
          <div className="pa-vault">
            <header>
              <h2>Match economics</h2>
              <span className="ok">Player-funded</span>
            </header>
            <div className="pa-econ-rows">
              <div><span>Collateral each</span><strong>{formatPoke(room.economics.collateral)}</strong></div>
              <div><span>Gross match pool</span><strong>{formatPoke(room.economics.totalPot)}</strong></div>
              <div className="fee"><span>Protocol fee · 2% at match start</span><strong>{formatPoke(room.economics.protocolFee)}</strong></div>
              <div className="payout"><span>Winner receives</span><strong>{formatPoke(room.economics.winnerPayout)}</strong></div>
            </div>
            <p className="pa-econ-note">One fee from the gross pool. No withdrawal tax.</p>
          </div>
          <div className="pa-vault">
            <header>
              <h2>Room code</h2>
              <span className="ok">Bring your rival</span>
            </header>
            <div className="pa-room-code">
              <strong>{code}</strong>
              <span>{room.roomType === 'private' ? 'Private challenge' : 'Open challenge'}</span>
              <button
                type="button"
                className="pa-btn pa-btn-surface pa-btn-sm"
                onClick={() => void navigator.clipboard?.writeText(window.location.href)}
              >
                Copy challenge link
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <ErrorToast error={error} onDismiss={() => setError(null)} />

      <div className="pa-lobby-actions">
        {canAccept ? (
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({ type: 'casual.accept', roomId });
              if (response.type === 'casual.state') setRoom(response.room);
            })}
          >
            Accept challenge
          </button>
        ) : null}
        {isPlayer && selecting && !yours?.confirmed && !countingDown ? (
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={busy || !canConfirm}
            onClick={() => void act(() => sendSelection(selected, true))}
          >
            Confirm three
          </button>
        ) : null}
        {isPlayer && selecting && yours?.confirmed && !countingDown ? (
          <button
            type="button"
            className="pa-btn pa-btn-surface"
            disabled={busy}
            onClick={() => void act(() => sendSelection(selected, false))}
          >
            Unconfirm
          </button>
        ) : null}
        {isPlayer && casualSelect && room && (room.status === 'full' || room.status === 'ready') ? (
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={busy}
            onClick={() => void act(async () => {
              if (!playerId) return;
              const response = await client.request({
                type: 'casual.ready',
                roomId,
                ready: !youReady,
              });
              if (response.type === 'casual.state') setRoom(response.room);
            })}
          >
            {youReady ? 'Unready' : 'Ready up'}
          </button>
        ) : null}
        {isPlayer && competitive && room && (room.status === 'full' || room.status === 'ready') && !countingDown ? (
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={busy || (!youReady && !canLockCompetitive)}
            onClick={() => void act(async () => {
              if (!playerId) return;
              const response = await client.request({
                type: 'casual.ready',
                roomId,
                ready: !youReady,
                ...(!youReady && ownPaste ? { team: ownPaste } : {}),
              });
              if (response.type === 'casual.state') setRoom(response.room);
            })}
          >
            {youReady ? 'Unready' : 'Lock team'}
          </button>
        ) : null}
        {isPlayer && room && room.battleSize === '2v2' && (room.status === 'full' || room.status === 'ready') ? (
          <button
            type="button"
            className="pa-btn pa-btn-surface"
            disabled={busy}
            onClick={() => void act(async () => {
              if (!playerId) return;
              const response = await client.request({
                type: 'casual.ready',
                roomId,
                ready: !room.ready[playerId],
              });
              if (response.type === 'casual.state') setRoom(response.room);
            })}
          >
            {playerId && room.ready[playerId] ? 'Unready' : 'Ready up'}
          </button>
        ) : null}
        {room?.battleSize === '2v2' ? (
          <span className="pa-soon" style={{ border: 0, padding: 0 }}>2v2 Multi · Coming soon</span>
        ) : null}
        {room?.status === 'battling' ? (
          <Link className="pa-btn pa-btn-primary" href={`/battle/${room.matchId}`}>Rejoin fight</Link>
        ) : null}
        {isPlayer && room?.status === 'battling' ? (
          <button
            type="button"
            className="pa-btn pa-btn-danger"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({ type: 'casual.forfeit', roomId });
              if (response.type === 'casual.state') {
                setRoom(response.room);
                router.push(`/result/${response.room.id}`);
              }
            })}
          >
            Forfeit fight
          </button>
        ) : null}
        {room?.status === 'completed' ? (
          <Link className="pa-btn pa-btn-primary" href={`/result/${room.id}`}>View result</Link>
        ) : null}
        {isPlayer && room && room.status !== 'battling' && room.status !== 'completed' ? (
          <button
            type="button"
            className="pa-btn pa-btn-danger"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({ type: 'casual.cancel', roomId });
              if (response.type === 'casual.state') setRoom(response.room);
            })}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
