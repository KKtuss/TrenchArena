'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';

export default function TreasuryPage() {
  const { client, snapshot, refreshSnapshot } = useArena();

  useEffect(() => {
    void Promise.all([
      client.request({ type: 'casual.list' }),
      client.request({ type: 'tournament.list' }),
    ]).then(() => refreshSnapshot());
  }, [client, refreshSnapshot]);

  const rooms = snapshot?.openCasualRooms ?? [];
  const tournaments = snapshot?.tournaments ?? [];
  const prizeTargets = tournaments.reduce((sum, item) => sum + item.economics.prizePool, 0);
  const projectShare = tournaments.reduce((sum, item) => sum + item.economics.devOpsShare, 0);
  const casualGross = rooms.reduce((sum, room) => sum + room.economics.totalPot, 0);
  const casualFees = rooms.reduce((sum, room) => sum + room.economics.protocolFee, 0);
  const paidOut = (snapshot?.recentCasualResults ?? []).reduce((sum, room) => sum + (room.payout?.amount ?? 0), 0);

  return (
    <div className="pa-page">
      <header className="pa-page-head">
        <p className="pa-kicker"><i /> — Funding map • mock ledger —</p>
        <h1>Treasury &amp; Economy</h1>
        <p className="pa-lead">
          Two separate routes. Creator and developer rewards fund tournaments. Casual fights stay player-funded and pay one protocol fee at match start. Neither route is an immediately withdrawable vault.
        </p>
      </header>

      <section className="pa-fly">
        <header>
          <div>
            <h2><span>◆</span> Creator rewards routing</h2>
            <p>Token trading rewards split once. This route never includes casual collateral.</p>
          </div>
          <span className="pa-live-pill"><i /> Intended allocation</span>
        </header>
        <article className="pa-route-block creator">
          <div className="pa-route-source">
            <b>Creator / dev rewards</b>
            <span>Source · token trading activity</span>
          </div>
          <div className="pa-split-bar" role="img" aria-label="90 percent Tournament Treasury, 10 percent developer project funds">
            <span className="treasury">90% Treasury</span>
            <span className="project">10%</span>
          </div>
          <div className="pa-split-legend">
            <span><i className="treasury" /> Tournament Treasury · funds prize pools</span>
            <span><i className="project" /> Developer / project funds · continued development</span>
          </div>
          <div className="pa-flow">
            <div className="pa-flow-step">
              <b>90% Treasury</b>
              <span>Banks competition prizes so cups stay low-entry.</span>
            </div>
            <div className="pa-flow-step">
              <b>10% Project</b>
              <span>Retained for development and growth. Not a player payout.</span>
            </div>
          </div>
        </article>
      </section>

      <section className="pa-fly">
        <header>
          <div>
            <h2><span>◆</span> Casual protocol fee</h2>
            <p>A different route. One fee from the player-funded gross pool. No withdrawal tax.</p>
          </div>
          <span className="pa-live-pill"><i /> Charged at match start</span>
        </header>
        <article className="pa-route-block protocol">
          <div className="pa-route-source">
            <b>Gross match pool</b>
            <span>Source · collateral from every fighter</span>
          </div>
          <div className="pa-split-bar" role="img" aria-label="98 percent winner payout, 2 percent protocol fee">
            <span className="winner">98% winner</span>
            <span className="fee">2%</span>
          </div>
          <div className="pa-split-legend">
            <span><i className="winner" /> Winner receives the remaining pool</span>
            <span><i className="fee" /> Protocol fee · once, from the gross pool</span>
          </div>
          <p className="pa-route-copy">
            Player collateral stays with the fighters until settlement. It is not Tournament Treasury liquidity.
          </p>
        </article>
      </section>

      <section className="pa-fly">
        <header>
          <div>
            <h2><span>◆</span> Two modes</h2>
            <p>Same stadium. Separate contracts.</p>
          </div>
        </header>
        <div className="pa-mode-pair">
          <article className="pa-mode-panel cup">
            <header>
              <div>
                <small>Tournament</small>
                <h3>Low entry. Treasury prize.</h3>
              </div>
              <span>Treasury-funded</span>
            </header>
            <div className="pa-flow">
              <div className="pa-flow-step">
                <b>Entry fee</b>
                <span>Small access cost. Not the prize source.</span>
              </div>
              <div className="pa-flow-step">
                <b>Treasury</b>
                <span>90% creator rewards bank the prize pool.</span>
              </div>
              <div className="pa-flow-step">
                <b>Champion</b>
                <span>Takes the Treasury-funded prize.</span>
              </div>
            </div>
            <div className="pa-vault-grid">
              <div>
                <small>Prize targets</small>
                <strong>{prizeTargets ? formatPoke(prizeTargets) : '—'}</strong>
                <span>Mock estimate · not withdrawable</span>
              </div>
              <div>
                <small>Project-fund figure</small>
                <strong>{projectShare ? formatPoke(projectShare) : '—'}</strong>
                <span>Mock 10% display from the ledger</span>
              </div>
            </div>
            <Link className="pa-btn pa-btn-primary pa-btn-sm" href="/tournaments">Open tournaments</Link>
          </article>

          <article className="pa-mode-panel casual">
            <header>
              <div>
                <small>Casual</small>
                <h3>Stake your own POKE.</h3>
              </div>
              <span>Player-funded</span>
            </header>
            <div className="pa-flow">
              <div className="pa-flow-step">
                <b>Collateral each</b>
                <span>Every fighter posts the same amount.</span>
              </div>
              <div className="pa-flow-step">
                <b>2% at start</b>
                <span>One fee from the gross pool. No second tax.</span>
              </div>
              <div className="pa-flow-step">
                <b>Winner</b>
                <span>Receives the remaining 98%.</span>
              </div>
            </div>
            <div className="pa-vault-grid">
              <div>
                <small>Open gross pools</small>
                <strong>{casualGross ? formatPoke(casualGross) : '—'}</strong>
                <span>{rooms.length} room{rooms.length === 1 ? '' : 's'} · player collateral</span>
              </div>
              <div>
                <small>Start fees on board</small>
                <strong>{casualFees ? formatPoke(casualFees) : '—'}</strong>
                <span>Recent payouts {paidOut ? formatPoke(paidOut) : '—'}</span>
              </div>
            </div>
            <Link className="pa-btn pa-btn-primary pa-btn-sm" href="/arena">Open Arena</Link>
          </article>
        </div>
        <p className="pa-route-copy">
          Availability note: creator-reward inflows and a live Tournament Treasury balance are not represented by the API yet. Figures are mock estimates.
        </p>
      </section>
    </div>
  );
}
