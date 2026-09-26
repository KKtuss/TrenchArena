'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { TournamentEconomicsBlock } from '@/components/ui';
import { TrainerSprite } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import type { TournamentSummary } from '@/lib/protocol';

function isLiveEvent(tournament: TournamentSummary): boolean {
  return ['registration', 'ready', 'in-progress', 'active', 'draft'].includes(tournament.status);
}

function formatLabel(format: string): string {
  return format === 'gen9ou' ? 'GEN 9 OU' : format.toUpperCase();
}

function eventStatus(tournament: TournamentSummary): string {
  if (tournament.status === 'completed') return tournament.winner ? 'Crown awarded' : 'Completed';
  if (tournament.status === 'registration') return 'Registration';
  if (tournament.status === 'ready') return 'Ready to start';
  if (tournament.status === 'in-progress' || tournament.status === 'active') return 'Bracket live';
  if (tournament.status === 'draft') return 'Draft';
  return tournament.status;
}

function actionLabel(tournament: TournamentSummary): string {
  if (tournament.status === 'registration') return 'Register';
  if (tournament.status === 'completed') return 'View result';
  return 'Watch bracket';
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
        entryFee: 10_000,
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
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <p className="pa-kicker"><i /> — Championship circuit —</p>
          <h1>Low entry. Large prize.</h1>
          <p className="pa-lead">
            Tournaments are not casual collateral wagers. Pay a small entry fee and compete for prizes funded by the Tournament Treasury.
          </p>
        </div>
        <button
          type="button"
          className="pa-btn pa-btn-primary"
          disabled={busy}
          onClick={() => void createTournament()}
        >
          {busy ? 'Creating…' : 'Create tournament'}
        </button>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {featured ? (
        <section className="pa-cup-featured">
          <header>
            <span>{isLiveEvent(featured) ? 'Featured cup' : 'Latest cup'}</span>
            <small>{eventStatus(featured)}</small>
          </header>
          <div className="pa-cup-body">
            <div>
              <small>{formatLabel(featured.format)} · Championship</small>
              <h2>{featured.title}</h2>
              {featured.winner ? <p>Champion {featured.winner}</p> : (
                <p>{featured.playerCount}/{featured.maxPlayers} on the field</p>
              )}
              {featured.playerCount > 0 ? (
                <div className="ps-field" aria-hidden>
                  {Array.from({ length: Math.min(featured.playerCount, 4) }, (_, index) => (
                    <TrainerSprite key={index} label="" />
                  ))}
                </div>
              ) : null}
            </div>
            <TournamentEconomicsBlock
              economics={featured.economics}
              entryFee={featured.entryFee}
            />
          </div>
          <div className="pa-cup-actions">
            <Link className="pa-btn pa-btn-primary" href={`/tournament/${featured.id}`}>
              {actionLabel(featured)}
            </Link>
            <Link className="pa-btn pa-btn-surface" href={`/tournament/${featured.id}`}>Rules</Link>
          </div>
        </section>
      ) : (
        <section className="pa-team-file pa-team-empty">
          <p>No cups on the calendar. Create a PokeArena Open to open registration.</p>
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={busy}
            onClick={() => void createTournament()}
          >
            {busy ? 'Creating…' : 'Create tournament'}
          </button>
        </section>
      )}

      {restLive.length ? (
        <section className="pa-floor-board">
          <header>
            <h2>Live / upcoming</h2>
            <span>{restLive.length} cups</span>
          </header>
          {restLive.map(tournament => (
            <article key={tournament.id} className="pa-board">
              <div className="pa-board-mark">CUP</div>
              <div>
                <p><b>{tournament.title}</b></p>
                <small>
                  {formatLabel(tournament.format)} · {eventStatus(tournament)} · entry {formatPoke(tournament.entryFee)}
                </small>
              </div>
              <div className="pa-board-side">
                <strong>{formatPoke(tournament.economics.prizePool)}</strong>
                <small style={{ display: 'block', color: '#8ea0c0' }}>Treasury prize</small>
                <Link href={`/tournament/${tournament.id}`}>{actionLabel(tournament)}</Link>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {restSettled.length ? (
        <section className="pa-floor-board">
          <header>
            <h2>Completed</h2>
            <span>{restSettled.length} cups</span>
          </header>
          {restSettled.map(tournament => (
            <article key={tournament.id} className="pa-board">
              <div className="pa-board-mark">WIN</div>
              <div>
                <p><b>{tournament.title}</b></p>
                <small>
                  {formatLabel(tournament.format)}
                  {tournament.winner ? ` · ${tournament.winner}` : ''}
                </small>
              </div>
              <div className="pa-board-side">
                <strong>{formatPoke(tournament.economics.prizePool)}</strong>
                <small style={{ display: 'block', color: '#8ea0c0' }}>Treasury prize</small>
                <Link href={`/tournament/${tournament.id}`}>View bracket</Link>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      <div className="pa-soon">
        <span>Register</span>
        <span aria-hidden>→</span>
        <span>Bracket</span>
        <span aria-hidden>→</span>
        <span>Final</span>
        <span aria-hidden>→</span>
        <span>Champion</span>
      </div>
    </div>
  );
}
