'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { PageHeader, Panel } from '@/components/shell';
import { EconomyBreakdown, TrainerVersus } from '@/components/ui';
import { useArena } from '@/lib/arena-context';
import type { CasualRoom } from '@/lib/protocol';

export default function CasualRoomPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const { client, playerId } = useArena();
  const router = useRouter();
  const [room, setRoom] = useState<CasualRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const isPlayer = room && (room.creatorId === playerId || room.opponentId === playerId);
  const canAccept = room && room.status === 'open' && room.creatorId !== playerId
    && (!room.invitedPlayerId || room.invitedPlayerId === playerId);

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

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Casual // pre-battle lobby"
        title={room ? `Challenge ${room.id.slice(0, 8)}` : 'Finding your room…'}
        description="Both trainers ready? Step into the arena."
      />
      <Panel strong>
        {room ? (
          <div className="stack">
            <div className="room-status-line"><span className="live-status"><span />{room.status}</span><span className="challenge-format">{room.format} · {room.battleSize}</span></div>
            <TrainerVersus
              left={room.creatorId === playerId ? playerId : room.opponentId ?? room.creatorId}
              right={room.creatorId === playerId ? room.opponentId : room.creatorId}
              leftReady={Boolean(room.ready[playerId])}
              rightReady={Boolean(Object.entries(room.ready).find(([id]) => id !== playerId)?.[1])}
            />
          </div>
        ) : <p className="muted">Subscribing to room…</p>}
      </Panel>

      {room ? (
        <div className="grid-2">
          <Panel eyebrow="Match economics" title="Winner takes the stake">
            <EconomyBreakdown economics={room.economics} />
          </Panel>
          <Panel eyebrow="Room code" title="Bring your rival">
            <div className="share-callout">
              <strong>{room.id.slice(0, 8).toUpperCase()}</strong>
              <span className="muted">{room.roomType === 'private' ? 'Private challenge' : 'Open challenge'}</span>
              <button type="button" className="btn btn-secondary" onClick={() => void navigator.clipboard?.writeText(window.location.href)}>Copy challenge link</button>
            </div>
          </Panel>
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="action-bar">
        {canAccept ? (
          <button
            type="button"
            className="btn btn-primary"
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
            className="btn"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({
                type: 'casual.ready',
                roomId,
                ready: !room.ready[playerId],
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
            className="btn btn-primary"
            disabled={busy || !room.opponentId}
            onClick={() => void act(async () => {
              const response = await client.request({ type: 'casual.start', roomId });
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
          <span className="coming-soon-inline">2v2 Multi · Coming soon</span>
        ) : null}
        {room?.status === 'battling' ? (
          <Link className="btn btn-primary" href={`/battle/${room.matchId}`}>Enter Battle</Link>
        ) : null}
        {room?.status === 'completed' ? (
          <Link className="btn btn-primary" href={`/result/${room.id}`}>View result</Link>
        ) : null}
        {isPlayer && room && room.status !== 'battling' && room.status !== 'completed' ? (
          <button
            type="button"
            className="btn btn-danger"
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
