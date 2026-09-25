'use client';

import Link from 'next/link';

import { PageHeader, SectionHeader } from '@/components/shell';
import { CasualRoomCard, FeaturedMatchup, TournamentCard } from '@/components/ui';
import { useArena } from '@/lib/arena-context';

export default function ArenaPage() {
  const { snapshot, connected } = useArena();
  const openRooms = snapshot?.openCasualRooms ?? [];
  const lead = openRooms[0];
  const rest = openRooms.slice(1, 5);
  const tournaments = snapshot?.tournaments.slice(0, 2) ?? [];

  return (
    <div className="arena-floor">
      <PageHeader
        eyebrow="Live floor"
        title="Find your fight."
        description="The stadium is live. Join an open matchup or call one."
        action={<Link className="btn btn-primary" href="/casual/create">Create challenge</Link>}
      />

      <div className="live-strip">
        <span className="live-status"><span />{connected ? 'Arena live' : 'Connecting'}</span>
        <strong>{openRooms.length} open</strong>
        <Link className="text-link" href="/casual">View all →</Link>
      </div>

      <section className="matchup-board">
        {lead ? <FeaturedMatchup room={lead} /> : (
          <div className="matchup-empty">
            <p>No trainers on the board yet. Call the first matchup.</p>
            <Link className="text-link" href="/casual/create">Create challenge →</Link>
          </div>
        )}
        {rest.map(room => <CasualRoomCard key={room.id} room={room} />)}
      </section>

      {tournaments.length ? (
        <section className="stack-tight">
          <SectionHeader
            eyebrow="Championship"
            action={<Link className="text-link" href="/tournaments">All tournaments →</Link>}
          />
          {tournaments.map(tournament => (
            <TournamentCard key={tournament.id} tournament={tournament} />
          ))}
        </section>
      ) : null}

      <div className="coming-soon-compact">
        <span className="broadcast-label">Coming soon</span>
        <strong>2v2 Multi</strong>
        <span className="muted">Singles are live now.</span>
      </div>
    </div>
  );
}
