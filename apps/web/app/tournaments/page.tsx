'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/shell';
import { TournamentEvent } from '@/components/ui';
import { useArena } from '@/lib/arena-context';
import type { TournamentSummary } from '@/lib/protocol';

function isLiveEvent(tournament: TournamentSummary): boolean {
  return ['registration', 'ready', 'in-progress', 'active', 'draft'].includes(tournament.status);
}

export default function TournamentsPage() {
  const { client, snapshot, refreshSnapshot } = useArena();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void client.request({ type: 'tournament.list' }).then(() => refreshSnapshot());
  }, [client, refreshSnapshot]);

  const createTournament = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.request({
        type: 'tournament.create',
        title: 'PokeArena Open',
        maxPlayers: 4,
        entryFee: 100_000,
      });
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const tournaments = snapshot?.tournaments ?? [];
  const liveEvents = tournaments.filter(isLiveEvent);
  const settledEvents = tournaments.filter(tournament => !isLiveEvent(tournament));
  const featured = liveEvents[0] ?? settledEvents[0];
  const restLive = liveEvents.filter(event => event.id !== featured?.id);
  const restSettled = settledEvents.filter(event => event.id !== featured?.id);

  return (
    <div className="league-page">
      <PageHeader
        eyebrow="Championship"
        title="Enter the league."
        description="Compete for the crown."
        action={(
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void createTournament()}>
            {busy ? 'Creating…' : 'Create tournament'}
          </button>
        )}
      />
      {error ? <div className="error-banner">{error}</div> : null}

      {featured ? (
        <section className="league-featured">
          <div className="broadcast-label">
            {isLiveEvent(featured) ? 'Featured cup' : 'Latest cup'}
          </div>
          <TournamentEvent tournament={featured} featured />
        </section>
      ) : (
        <section className="league-empty">
          <p>No cups on the calendar. Create a PokeArena Open to open registration.</p>
        </section>
      )}

      {restLive.length ? (
        <section className="league-list">
          <div className="broadcast-label">Live / upcoming</div>
          {restLive.map(tournament => (
            <TournamentEvent key={tournament.id} tournament={tournament} />
          ))}
        </section>
      ) : null}

      {restSettled.length ? (
        <section className="league-list">
          <div className="broadcast-label">Completed</div>
          {restSettled.map(tournament => (
            <TournamentEvent key={tournament.id} tournament={tournament} />
          ))}
        </section>
      ) : featured && !isLiveEvent(featured) ? (
        <section className="league-note">
          <p className="muted">No live cups right now. The latest result sits above.</p>
          <Link className="text-link" href="/arena">Find a fight in the Arena →</Link>
        </section>
      ) : null}

      <p className="home-loop">
        <span>Register</span>
        <span aria-hidden>→</span>
        <span>Bracket</span>
        <span aria-hidden>→</span>
        <span>Final</span>
        <span aria-hidden>→</span>
        <span>Champion</span>
      </p>
    </div>
  );
}
