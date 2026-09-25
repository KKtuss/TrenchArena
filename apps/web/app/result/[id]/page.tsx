'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Panel } from '@/components/shell';
import { ResultCard } from '@/components/ui';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';

export default function ResultPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { client, lastCasualResult, lastTournamentResult, snapshot } = useArena();
  const [casualRoom, setCasualRoom] = useState(lastCasualResult?.room ?? null);
  const [tournament, setTournament] = useState(lastTournamentResult?.tournament ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromSnapshot = snapshot?.recentCasualResults.find(room => room.id === id)
      ?? snapshot?.myCasualRooms.find(room => room.id === id);
    if (fromSnapshot) {
      setCasualRoom(fromSnapshot);
      return;
    }

    void client.request({ type: 'casual.subscribe', roomId: id }).then(response => {
      if (response.type === 'casual.state') setCasualRoom(response.room);
    }).catch(() => {
      void client.request({ type: 'tournament.subscribe', tournamentId: id }).then(response => {
        if (response.type === 'tournament.state') setTournament(response.tournament);
      }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    });
  }, [client, id, snapshot]);

  const payout = casualRoom?.payout ?? tournament?.payout ?? lastCasualResult?.payout ?? lastTournamentResult?.payout;

  return (
    <div className="stack">
      <Panel eyebrow="Result" title="Match / tournament outcome" strong>
        <p className="muted">
          Economic values below are mocked development POKE settlements — not on-chain payouts.
        </p>
      </Panel>
      {error ? <div className="error-banner">{error}</div> : null}
      {casualRoom ? (
        <ResultCard
          title={`Casual room ${casualRoom.id.slice(0, 8)}`}
          winner={casualRoom.winnerId}
          payoutAmount={casualRoom.payout?.amount}
          reason={casualRoom.payout?.reason}
        />
      ) : null}
      {tournament ? (
        <ResultCard
          title={tournament.title ?? 'Tournament'}
          winner={tournament.winner}
          payoutAmount={tournament.payout?.amount ?? payout?.amount}
          reason={tournament.payout?.reason ?? 'tournament-win'}
        />
      ) : null}
      {payout ? (
        <Panel eyebrow="Mock ledger" title="POKE settlement">
          <div className="stack">
            <div className="row"><span className="muted">Amount</span><strong>{formatPoke(payout.amount)}</strong></div>
            <div className="row"><span className="muted">Reason</span><strong>{payout.reason}</strong></div>
            {payout.protocolFee !== undefined ? (
              <div className="row"><span className="muted">Protocol fee</span><strong>{formatPoke(payout.protocolFee)}</strong></div>
            ) : null}
          </div>
        </Panel>
      ) : null}
      <div className="row">
        <Link className="btn" href="/arena">Back to Arena</Link>
        <Link className="btn" href="/casual">Casual lobby</Link>
        <Link className="btn" href="/tournaments">Tournaments</Link>
      </div>
    </div>
  );
}
