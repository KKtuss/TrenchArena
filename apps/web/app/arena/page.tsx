'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CupIcon } from '@/components/cup-icons';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { formatRoomAmount } from '@/lib/api-client';
import { roomAccent, roomCode, roomStatusLabel, roomStatusPulses, roomStatusTone } from '@/lib/arena-room';
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

type FightFilter = 'all' | 'casual' | 'competitive';

export default function ArenaPage() {
  const { client, playerId, snapshot, refreshSnapshot, connected, chainEconomyEnabled } = useArena();
  const [filter, setFilter] = useState<FightFilter>('all');

  useEffect(() => {
    if (!connected) return;
    void client.request({ type: 'casual.list' }).then(() => refreshSnapshot()).catch(() => undefined);
  }, [client, connected, refreshSnapshot]);

  const rooms = [...(snapshot?.openCasualRooms ?? [])].sort((a, b) => roomRank(a) - roomRank(b));
  const shown = filter === 'all' ? rooms : rooms.filter(room => (room.ruleset ?? 'casual') === filter);
  const openCount = rooms.filter(room => room.status === 'open').length;

  return (
    <div className="pa-page cup-page">
      <header className="cup-head">
        <div className="cup-head-copy">
          <h1 className="cup-title">Find your fight.</h1>
          <p className="cup-lead">
            {chainEconomyEnabled
              ? 'Real challenges lock the same SOL stake from both trainers. A 2% fee comes off the pool when the match starts, and the winner is paid from escrow. Mock POKE fights stay available when you create a challenge.'
              : 'Mock fights use the development POKE ledger. Casual deals a random six after both trainers ready up. Competitive uses your own Gen 9 OU team.'}
          </p>
        </div>
        <div className="cup-actions">
          <Link className="pa-btn pa-btn-surface" href="/leaderboard">Leaderboard</Link>
          <Link className="pa-btn pa-btn-primary" href="/casual/create">Create challenge</Link>
        </div>
      </header>

      <div className="cup-ticker">
        <span className={connected ? 'is-on' : 'is-off'}>
          <i className={`cup-dot${connected ? ' is-pulse' : ''}`} aria-hidden />
          {connected ? 'Arena live' : 'Connecting'}
        </span>
        <span><CupIcon name="swords" /><b>{openCount}</b> open</span>
        <span><CupIcon name="users" /><b>{rooms.length}</b> on the board</span>
        <span className="arena-ticker-end">No withdrawal tax</span>
      </div>

      <section className="cup-section" aria-labelledby="arena-board-title">
        <div className="cup-section-head">
          <h2 id="arena-board-title">Available fights</h2>
          <div className="arena-board-tools">
            <span>{shown.length} {shown.length === 1 ? 'matchup' : 'matchups'}</span>
            <div className="cup-segment arena-filter" role="group" aria-label="Fight format">
              {(['all', 'casual', 'competitive'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? `is-on is-${value}` : undefined}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>
        {shown.length ? (
          <div className="arena-board">
            {shown.map(room => <FightRow key={room.id} room={room} playerId={playerId} />)}
          </div>
        ) : (
          <p className="cup-empty">
            {rooms.length
              ? `No ${filter} fights on the board.`
              : 'No fights on the board yet.'}
          </p>
        )}
      </section>
    </div>
  );
}

function FightRow({ room, playerId }: { room: CasualRoom; playerId?: string | null }) {
  const mine = Boolean(playerId && (room.creatorId === playerId || room.opponentId === playerId));
  const live = room.status === 'battling';
  const real = room.rail === 'sol_chain';

  return (
    <Link
      href={roomHref(room)}
      className={`cup-panel is-accent cup-accent-${roomAccent(room)} arena-fight${mine ? ' is-you' : ''}${live ? ' is-live' : ''}`}
    >
      <header className="arena-fight-head">
        <span className={`cup-pill ${roomStatusTone(room.status)}`}>
          {roomStatusPulses(room.status) ? <i className="cup-dot is-pulse" aria-hidden /> : null}
          {roomStatusLabel(room.status)}
        </span>
        <span className="cup-chip arena-mark">{formatLabel(room)}</span>
        <span className="cup-chip">{room.battleSize}</span>
        <span className={`cup-chip${real ? ' is-sol' : ''}`}>{real ? 'Real SOL' : 'Mock POKE'}</span>
        {mine ? <span className="cup-pill is-you">You</span> : null}
        <code className="arena-fight-code">#{roomCode(room)}</code>
      </header>

      <div className="arena-fight-body">
        <div className="arena-versus">
          <div className="arena-fighter">
            <span className="arena-fighter-art">
              <ProfileTrainerSprite label={room.creatorId} side="left" />
            </span>
            <div>
              <b><TrainerName playerId={room.creatorId} /></b>
              <small>Challenger</small>
            </div>
          </div>
          <span className="arena-versus-mark" aria-hidden>VS</span>
          <div className={`arena-fighter is-rival${room.opponentId ? '' : ' is-open'}`}>
            <span className="arena-fighter-art">
              {room.opponentId ? (
                <ProfileTrainerSprite label={room.opponentId} side="right" />
              ) : (
                <i aria-hidden>?</i>
              )}
            </span>
            <div>
              <b>{room.opponentId ? <TrainerName playerId={room.opponentId} /> : 'Open slot'}</b>
              <small>{room.opponentId ? 'Rival' : 'Waiting'}</small>
            </div>
          </div>
        </div>

        <div className="cup-stat arena-fight-stake">
          <span><CupIcon name="coins" />Stake each</span>
          <strong>{formatRoomAmount(room.collateral, room.rail)}</strong>
          <small>
            Pool {formatRoomAmount(room.economics.totalPot, room.rail)} · winner {formatRoomAmount(room.economics.winnerPayout, room.rail)} · 2% fee
          </small>
        </div>
      </div>
    </Link>
  );
}
