'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { PageHeader, Panel, SectionHeader } from '@/components/shell';
import { CasualRoomCard, ResultCard } from '@/components/ui';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';

export default function CasualLobbyPage() {
  const { client, snapshot, refreshSnapshot } = useArena();

  useEffect(() => {
    void client.request({ type: 'casual.list' }).then(() => refreshSnapshot());
  }, [client, refreshSnapshot]);

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Casual // trainer queue"
        title="Call your match."
        description="Gen 9 Singles. Choose your stake, find a rival, and get to the battle."
        action={<Link className="btn btn-primary" href="/casual/create">Create challenge</Link>}
      />
      <div className="queue-banner">
        <div><span className="micro-label">Available to stake</span><strong>{snapshot ? formatPoke(snapshot.wallet.balance) : 'Loading…'}</strong></div>
        <span className="muted">Mock economics · 2% fee on total pot · winner receives 98%</span>
      </div>
      <section className="stack">
        <SectionHeader eyebrow="Open challenges" title="Pick a trainer" />
        <div className="matchup-board">
          {(snapshot?.openCasualRooms ?? []).map(room => (
            <CasualRoomCard key={room.id} room={room} />
          ))}
          {!snapshot?.openCasualRooms.length ? (
            <Panel title="No open rooms">
              <p className="muted">Create an open room or wait for a challenge invite.</p>
            </Panel>
          ) : null}
        </div>
      </section>
      <section className="stack">
        <SectionHeader eyebrow="Your board" title="Active challenges" />
        <div className="matchup-board">
          {(snapshot?.myCasualRooms ?? []).map(room => (
            <CasualRoomCard key={room.id} room={room} />
          ))}
        </div>
      </section>
      <section className="stack">
        <SectionHeader eyebrow="Match history" title="Recent results" />
        <div className="grid-2">
          {(snapshot?.recentCasualResults ?? []).map(room => (
            <ResultCard
              key={room.id}
              title={`Casual ${room.id.slice(0, 8)}`}
              winner={room.winnerId}
              payoutAmount={room.payout?.amount}
              reason={room.payout?.reason}
              href={`/result/${room.id}`}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
