'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { TeamStrip, TrainerSprite } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import type { CasualRoom } from '@/lib/protocol';
import { battlePaste, readSavedTeam, type SavedTeam } from '@/lib/team';

function formatLabel(format: string): string {
  return format === 'gen9ou' ? 'GEN 9 OU' : format.toUpperCase();
}

export default function CasualRoomPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const { client, playerId } = useArena();
  const router = useRouter();
  const [room, setRoom] = useState<CasualRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedTeam | null>(null);

  useEffect(() => {
    setSaved(readSavedTeam(playerId));
  }, [playerId]);

  useEffect(() => {
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
  }, [client, roomId]);

  const paste = saved?.validated ? battlePaste(playerId) : undefined;
  const isPlayer = room && (room.creatorId === playerId || room.opponentId === playerId);
  const canAccept = room && room.status === 'open' && room.creatorId !== playerId
    && (!room.invitedPlayerId || room.invitedPlayerId === playerId);

  const youAreCreator = room?.creatorId === playerId;
  const yourId = room ? (youAreCreator ? room.creatorId : (room.opponentId ?? playerId)) : playerId;
  const rivalId = room
    ? (youAreCreator ? room.opponentId : room.creatorId)
    : undefined;
  const youReady = Boolean(room?.ready[playerId]);
  const rivalReady = Boolean(
    room && rivalId ? room.ready[rivalId] : false,
  );

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

  const code = room ? room.id.slice(0, 8).toUpperCase() : '········';

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <p className="pa-kicker"><i /> — Casual · pre-battle lobby —</p>
          <h1>{room ? `Challenge ${code}` : 'Finding your room…'}</h1>
          <p className="pa-lead">Player-funded room. Lock collateral each, then ready up. The 2% fee is taken once from the gross pool at match start.</p>
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
              <span className="pa-chip">{formatLabel(room.format)}</span>
              <span className="pa-chip">{room.battleSize.toUpperCase()}</span>
            </div>

            <p className="pa-lobby-note">
              {paste
                ? `Bringing ${saved?.name ?? 'saved team'}: ${(saved?.species ?? []).filter(Boolean).join(' · ')}`
                : saved
                  ? 'This draft does not pass Gen 9 OU, so the locked demo team will be brought instead.'
                  : 'No saved team. The locked demo team will be brought.'}
            </p>

            {paste && saved?.species.some(Boolean) ? (
              <div className="pa-protocol">
                <span>Your team</span>
                <TeamStrip species={saved.species} />
              </div>
            ) : null}

            <div className="pa-lobby-vs">
              <article className="pa-lobby-side cyan">
                <small>Your trainer</small>
                <TrainerSprite label={yourId} side="left" />
                <strong>{yourId}</strong>
                <span className={`pa-lobby-ready ${youReady ? 'on' : ''}`}>
                  {youReady ? 'Ready' : 'Preparing'}
                </span>
              </article>
              <div className="pa-lobby-mid">
                <span>VS</span>
              </div>
              <article className="pa-lobby-side coral">
                <small>Opponent</small>
                {rivalId ? <TrainerSprite label={rivalId} side="right" /> : <span className="pa-fight-open" aria-hidden />}
                <strong>{rivalId ?? 'Waiting…'}</strong>
                <span className={`pa-lobby-ready ${rivalReady ? 'on' : ''}`}>
                  {rivalId ? (rivalReady ? 'Ready' : 'Joined') : 'Open queue'}
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

      {error ? <div className="error-banner">{error}</div> : null}

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
        {isPlayer && room && (room.status === 'full' || room.status === 'ready') ? (
          <button
            type="button"
            className="pa-btn pa-btn-surface"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({
                type: 'casual.ready',
                roomId,
                ready: !room.ready[playerId],
                ...(!room.ready[playerId] && paste ? { team: paste } : {}),
              });
              if (response.type === 'casual.state') setRoom(response.room);
            })}
          >
            {room.ready[playerId] ? 'Unready' : 'Ready up'}
          </button>
        ) : null}
        {isPlayer && room && room.battleSize === '1v1' && (room.status === 'ready' || room.status === 'full') ? (
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={busy || !room.opponentId}
            onClick={() => void act(async () => {
              const response = await client.request({
                type: 'casual.start',
                roomId,
                ...(paste ? { team: paste } : {}),
              });
              if (response.type === 'casual.state') {
                setRoom(response.room);
                if (response.room.status === 'battling') {
                  router.push(`/battle/${response.room.matchId}`);
                }
              }
            })}
          >
            Start battle
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
