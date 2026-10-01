'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { TeamStrip } from '@/components/showdown-visuals';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { formatRoomAmount } from '@/lib/api-client';
import type { CasualRoom } from '@/lib/protocol';
import { formatCasualRoomLabel } from '@/lib/protocol';

function formatLabel(room: CasualRoom): string {
  return formatCasualRoomLabel(room).toUpperCase();
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

  useEffect(() => {
    if (!connected) return;
    void client.request({ type: 'casual.list' }).then(() => refreshSnapshot()).catch(() => undefined);
  }, [client, connected, refreshSnapshot]);

  const rooms = [...(snapshot?.openCasualRooms ?? [])].sort((a, b) => roomRank(a) - roomRank(b));
  const openCount = rooms.filter(room => room.status === 'open').length;

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <h1>Find your fight.</h1>
          <p className="pa-lead">
            {snapshot?.chainEconomyEnabled
              ? 'Real challenges lock the same SOL stake from both trainers. A 2% fee comes off the pool when the match starts, and the winner is paid from escrow. Mock POKE fights stay available when you create a challenge.'
              : 'Mock fights use the development POKE ledger. Casual deals a random six after both trainers ready up. Competitive uses your own Gen 9 OU team.'}
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
          const yours = room.teamPreview?.find(preview => preview.playerId === playerId)
            ?? room.teamPreview?.[0];
          const preview = yours?.pokemon.map(mon => mon.species);
          return (
            <article key={room.id} className="pa-fight-card">
              <div className="pa-fight-trainers">
                <div className="pa-fight-fighter">
                  <ProfileTrainerSprite label={room.creatorId} side="left" />
                  <div>
                    <b><TrainerName playerId={room.creatorId} /></b>
                    <small>Challenger</small>
                  </div>
                </div>
                <span className="pa-fight-vs">vs</span>
                <div className="pa-fight-fighter end">
                  <div>
                    <b>{room.opponentId ? <TrainerName playerId={room.opponentId} /> : 'Open slot'}</b>
                    <small>{room.opponentId ? 'Rival' : 'Waiting'}</small>
                  </div>
                  {room.opponentId ? (
                    <ProfileTrainerSprite label={room.opponentId} side="right" />
                  ) : (
                    <span className="pa-fight-open" aria-hidden />
                  )}
                </div>
              </div>

              <div className="pa-fight-team">
                <span>
                  {preview?.length
                    ? (yours?.presetName ?? 'Shared six')
                    : room.ruleset === 'competitive'
                      ? 'Bring your own six'
                      : 'Teams drop after ready'}
                </span>
                <TeamStrip species={preview} />
              </div>

              <div className="pa-fight-meta">
                <span>{formatLabel(room)}</span>
                <span>{room.rail === 'sol_chain' ? 'Real SOL' : 'Mock POKE'}</span>
                <span>{room.battleSize}</span>
                <span className={`pa-fight-status status-${room.status}`}>{room.status}</span>
              </div>

              <div className="pa-fight-foot">
                <div>
                  <strong>{formatRoomAmount(room.collateral, room.rail)}</strong>
                  <small>
                    Stake each · pool {formatRoomAmount(room.economics.totalPot, room.rail)} · winner {formatRoomAmount(room.economics.winnerPayout, room.rail)} · 2% fee
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

      <div className="pa-soon">
        <span className="pa-kicker" style={{ margin: 0 }}><i /> Coming soon</span>
        <strong>2v2 Multi</strong>
        <span>Rooms can be configured, but starts are not live yet.</span>
      </div>
    </div>
  );
}
