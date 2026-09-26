'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { TeamStrip, TrainerSprite } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import type { CasualRoom } from '@/lib/protocol';
import { readSavedTeam, type SavedTeam } from '@/lib/team';
import { trainerName } from '@/lib/trainers';

function formatLabel(format: string): string {
  return format === 'gen9ou' ? 'GEN 9 OU' : format.toUpperCase();
}

function roomHref(room: CasualRoom): string {
  if (room.status === 'battling' && room.matchId) return `/battle/${room.matchId}`;
  return `/casual/${room.id}`;
}

function roomRank(room: CasualRoom): number {
  if (room.status === 'battling') return 0;
  if (room.status === 'ready') return 1;
  if (room.status === 'open') return 2;
  return 3;
}

function actionLabel(room: CasualRoom): string {
  if (room.status === 'open') return 'Join fight';
  if (room.status === 'battling') return 'Watch live';
  if (room.status === 'ready') return 'Enter lobby';
  return 'Open room';
}

export default function ArenaPage() {
  const { client, playerId, snapshot, refreshSnapshot, connected } = useArena();
  const [saved, setSaved] = useState<SavedTeam | null>(null);

  useEffect(() => {
    void client.request({ type: 'casual.list' }).then(() => refreshSnapshot());
  }, [client, refreshSnapshot]);

  useEffect(() => {
    setSaved(readSavedTeam(playerId));
  }, [playerId]);

  const rooms = [...(snapshot?.openCasualRooms ?? [])].sort((a, b) => roomRank(a) - roomRank(b));
  const openCount = rooms.filter(room => room.status === 'open').length;
  const yourSpecies = saved?.species.filter(Boolean) ?? [];

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <p className="pa-kicker"><i /> — Player-funded fights • Gen 9 OU —</p>
          <h1>Find your fight.</h1>
          <p className="pa-lead">
            Casual rooms are player-funded. Each trainer posts the same collateral. One 2% protocol fee comes off the gross pool when the match starts.
          </p>
        </div>
        <Link className="pa-btn pa-btn-primary" href="/casual/create">Create challenge</Link>
      </header>

      <div className="pa-live-strip">
        <span className="pa-live-pill"><i /> {connected ? 'Arena live' : 'Connecting'}</span>
        <strong>{openCount} open</strong>
        <span>{rooms.length} on the board</span>
        <span style={{ marginLeft: 'auto', color: '#8ea0c0' }}>No withdrawal tax</span>
      </div>

      <section className="pa-floor-board">
        <header>
          <h2>Available fights</h2>
          <span>{rooms.length} {rooms.length === 1 ? 'matchup' : 'matchups'}</span>
        </header>
        {rooms.length ? rooms.map(room => {
          const yours = room.creatorId === playerId || room.opponentId === playerId;
          const preview = yours && yourSpecies.length ? yourSpecies : undefined;
          return (
            <article key={room.id} className="pa-fight-card">
              <div className="pa-fight-trainers">
                <div className="pa-fight-fighter">
                  <TrainerSprite label={trainerName(room.creatorId)} side="left" />
                  <div>
                    <b>{trainerName(room.creatorId)}</b>
                    <small>Challenger</small>
                  </div>
                </div>
                <span className="pa-fight-vs">vs</span>
                <div className="pa-fight-fighter end">
                  <div>
                    <b>{room.opponentId ? trainerName(room.opponentId) : 'Open slot'}</b>
                    <small>{room.opponentId ? 'Rival' : 'Waiting'}</small>
                  </div>
                  {room.opponentId ? (
                    <TrainerSprite label={trainerName(room.opponentId)} side="right" />
                  ) : (
                    <span className="pa-fight-open" aria-hidden />
                  )}
                </div>
              </div>

              <div className="pa-fight-team">
                <span>{preview ? 'Your team' : 'Roster sealed'}</span>
                <TeamStrip species={preview} />
              </div>

              <div className="pa-fight-meta">
                <span>{formatLabel(room.format)}</span>
                <span>{room.battleSize}</span>
                <span className={`pa-fight-status status-${room.status}`}>{room.status}</span>
              </div>

              <div className="pa-fight-foot">
                <div>
                  <strong>{formatPoke(room.collateral)}</strong>
                  <small>
                    Collateral each · gross {formatPoke(room.economics.totalPot)} · winner {formatPoke(room.economics.winnerPayout)}
                  </small>
                </div>
                <Link className="pa-btn pa-btn-primary pa-btn-sm" href={roomHref(room)}>
                  {actionLabel(room)}
                </Link>
              </div>
            </article>
          );
        }) : (
          <p className="pa-empty">
            No fights on the board yet.{' '}
            <Link href="/casual/create">Create challenge →</Link>
          </p>
        )}
      </section>

    </div>
  );
}
