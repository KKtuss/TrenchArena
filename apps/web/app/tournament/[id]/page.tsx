'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Panel } from '@/components/shell';
import { BracketView } from '@/components/ui';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';

export default function TournamentDetailPage() {
  const params = useParams<{ id: string }>();
  const tournamentId = params.id;
  const { client, playerId } = useArena();
  const [tournament, setTournament] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubscribe = client.onMessage(message => {
      if (
        (message.type === 'tournament.state' || message.type === 'tournament.created' || message.type === 'tournament.result')
        && message.tournament?.id === tournamentId
      ) {
        setTournament(message.tournament);
      }
    });
    void client.request({ type: 'tournament.subscribe', tournamentId }).then(response => {
      if (response.type === 'tournament.state') setTournament(response.tournament);
    }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    return unsubscribe;
  }, [client, tournamentId]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const registered = tournament?.players?.some((player: any) => player.id === playerId && player.status === 'registered');
  const myMatch = tournament?.bracket?.find((match: any) => (
    (match.player1 === playerId || match.player2 === playerId)
    && ['ready', 'active', 'battle-created', 'completed'].includes(match.status)
  ));

  return (
    <div className="stack">
      <Panel eyebrow="Tournament" title={tournament?.title ?? 'Loading…'} strong>
        {tournament ? (
          <div className="stack">
            <div className="row">
              <span className="badge">{tournament.status}</span>
              <span className="badge badge-live">{tournament.format}</span>
              <span className="badge">{tournament.players?.filter((p: any) => p.status === 'registered').length}/{tournament.maxPlayers}</span>
            </div>
            <div className="row">
              <span className="muted">Entry / prize pool</span>
              <strong>
                {formatPoke(tournament.entryFee ?? 0)} / {formatPoke(tournament.economics?.prizePool ?? 0)}
              </strong>
            </div>
            {tournament.winner ? (
              <div className="row">
                <span className="muted">Champion</span>
                <strong>{tournament.winner}</strong>
              </div>
            ) : null}
          </div>
        ) : <p className="muted">Loading tournament…</p>}
      </Panel>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="row">
        {!registered && tournament?.status === 'registration' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({ type: 'tournament.join', tournamentId });
              if (response.type === 'tournament.state') setTournament(response.tournament);
            })}
          >
            Join tournament
          </button>
        ) : null}
        {registered && (tournament?.status === 'registration' || tournament?.status === 'ready') ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({ type: 'tournament.start', tournamentId });
              if (response.type === 'tournament.state') setTournament(response.tournament);
            })}
          >
            Start tournament
          </button>
        ) : null}
        {myMatch ? (
          <Link className="btn" href={`/battle/${myMatch.id}`}>Enter my match</Link>
        ) : null}
        {tournament?.status === 'completed' ? (
          <Link className="btn btn-primary" href={`/result/${tournament.id}`}>View result</Link>
        ) : null}
      </div>

      <Panel eyebrow="Bracket" title="Single elimination">
        {tournament?.bracket?.length ? (
          <BracketView matches={tournament.bracket} />
        ) : (
          <p className="muted">Bracket appears after the tournament starts.</p>
        )}
      </Panel>
    </div>
  );
}
