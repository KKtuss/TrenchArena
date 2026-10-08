'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { useArena } from '@/lib/arena-context';
import { formatSolLamports } from '@/lib/api-client';

export default function TreasuryPage() {
  const { client, snapshot, refreshSnapshot, chainEconomyEnabled } = useArena();
  const [deposits, setDeposits] = useState<Array<{
    claimKey: string;
    source: string;
    grossLamports: number;
    treasuryLamports: number;
    operatorLamports: number;
    signature?: string;
    createdAt: string;
  }>>([]);

  useEffect(() => {
    void Promise.all([
      client.request({ type: 'casual.list' }),
      client.request({ type: 'tournament.list' }),
      client.request({ type: 'treasury.snapshot' }).then(response => {
        if (response.type === 'treasury.snapshot') setDeposits(response.deposits);
      }).catch(() => undefined),
    ]).then(() => refreshSnapshot());
  }, [client, refreshSnapshot]);

  const chain = chainEconomyEnabled;

  return (
    <div className="pa-page">
      <header className="pa-page-head">
        <h1>Treasury &amp; Economy</h1>
        <p className="pa-lead">
          {chain
            ? 'Poke is your passport. CARDS is what you wager in the Arena. $CARDS is what you fight for in the Tournaments.'
            : 'Mock ledger mode. Arena fights wager POKE. Tournament prizes come from held entry fees (90% champion / 10% ops). Arena collateral never funds cups.'}
        </p>
        {chain && snapshot?.solBalances ? (
          <p className="pa-lead">
            Live treasury vault: <strong>{formatSolLamports(snapshot.solBalances.treasuryLamports)}</strong>
          </p>
        ) : null}
      </header>

      {deposits.length > 0 ? (
        <section className="pa-fly">
          <header>
            <div>
              <h2><span>◆</span> Public treasury deposits</h2>
              <p>Realized creator-reward SOL after the 90/10 split.</p>
            </div>
          </header>
          <div className="stack">
            {deposits.map(row => (
              <article key={row.claimKey} className="pa-route-block">
                <div className="pa-route-source">
                  <b>{row.source}</b>
                  <span>{row.createdAt}</span>
                </div>
                <p>
                  Gross {formatSolLamports(row.grossLamports)} → treasury {formatSolLamports(row.treasuryLamports)} ·
                  operator {formatSolLamports(row.operatorLamports)}
                </p>
                {row.signature ? <small>{row.signature}</small> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="pa-fly">
        <header>
          <div>
            <h2><span>◆</span> {chain ? 'Creator rewards routing' : 'Tournament prize split'}</h2>
            <p>
              {chain
                ? 'Token trading rewards split once. This route never includes arena collateral.'
                : 'Held entry fees split once at settlement. Arena collateral never enters this route.'}
            </p>
          </div>
          <span className="pa-live-pill"><i /> {chain ? 'On-chain allocation' : 'Legacy ledger'}</span>
        </header>
        <article className="pa-route-block creator">
          <div className="pa-route-source">
            <b>{chain ? 'Creator / Dev Rewards - $CARDS' : 'Entry fee holds'}</b>
            <span>{chain ? 'Source · token trading activity' : 'Source · registered players'}</span>
          </div>
          <div className="pa-split-bar" role="img" aria-label="90 percent prize path, 10 percent project or ops">
            <span className="treasury">90% {chain ? 'Treasury' : 'Prize'}</span>
            <span className="project">10%</span>
          </div>
          <div className="pa-split-legend">
            <span>
              <i className="treasury" />{' '}
              {chain ? 'Tournament Treasury · funds prize pools' : 'Champion payout · from held entries'}
            </span>
            <span>
              <i className="project" />{' '}
              {chain ? 'Developer / project funds · continued development' : 'Ops share · not a player payout'}
            </span>
          </div>
          <div className="pa-flow">
            <div className="pa-flow-step">
              <b>90% {chain ? 'Treasury' : 'Prize'}</b>
              <span>
                {chain
                  ? 'Banks competition prizes so cups stay low-entry.'
                  : 'Paid to the champion when the cup settles.'}
              </span>
            </div>
            <div className="pa-flow-step">
              <b>10% {chain ? 'Project' : 'Ops'}</b>
              <span>
                {chain
                  ? 'Retained for development and growth. Not a player payout.'
                  : 'Retained by the mock ledger. Not returned to players.'}
              </span>
            </div>
          </div>
        </article>
      </section>

      <section className="pa-fly">
        <header>
          <div>
            <h2><span>◆</span> Arena wager routing</h2>
            <p>A different route. One fee from the player-funded gross pool. No withdrawal tax.</p>
          </div>
          <span className="pa-live-pill">
            <i /> {chain ? 'Charged at match start' : 'Taken at settlement'}
          </span>
        </header>
        <article className="pa-route-block protocol">
          <div className="pa-route-source">
            <b>Gross match pool - SOL</b>
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
          <article className="pa-mode-panel casual">
            <header>
              <div>
                <small>Arena</small>
                <h3>{chain ? 'Wager CARDS in arena fights.' : 'Wager POKE in arena fights.'}</h3>
              </div>
              <span>Player-funded</span>
            </header>
            <div className="pa-flow">
              <div className="pa-flow-step">
                <b>Collateral each</b>
                <span>Every fighter posts the same amount.</span>
              </div>
              <div className="pa-flow-step">
                <b>2% fee</b>
                <span>
                  {chain
                    ? 'One fee from the gross pool at match start. No second tax.'
                    : 'One fee from the gross pool at settlement. No second tax.'}
                </span>
              </div>
              <div className="pa-flow-step">
                <b>Winner</b>
                <span>Receives the pot after fight completion.</span>
              </div>
            </div>
            <Link className="pa-btn pa-btn-primary pa-btn-sm" href="/arena">Open Arena</Link>
          </article>

          <article className="pa-mode-panel cup">
            <header>
              <div>
                <small>Tournament</small>
                <h3>{chain ? 'Burn fee entry. Creator rewards raffle.' : 'Entry hold. Field prize raffle.'}</h3>
              </div>
              <span>{chain ? 'Treasury-funded' : 'Field-funded'}</span>
            </header>
            <div className="pa-flow">
              <div className="pa-flow-step">
                <b>{chain ? 'Burn fee' : 'Entry fee'}</b>
                <span>
                  {chain
                    ? 'Fixed POKE access cost after the field fills. Not the prize source.'
                    : 'Held at join and consumed at settlement. This is the prize source.'}
                </span>
              </div>
              <div className="pa-flow-step">
                <b>{chain ? 'Treasury' : 'Field pool'}</b>
                <span>
                  {chain
                    ? '90% creator rewards bank the CARDS prize pool.'
                    : '90% of held entries fund the prize pool.'}
                </span>
              </div>
              <div className="pa-flow-step">
                <b>Prize split</b>
                <span>
                  {chain
                    ? '1st 50% · 2nd 35% · 3rd 15% of the Treasury CARDS prize.'
                    : '1st 50% · 2nd 35% · 3rd 15% of the field prize.'}
                </span>
              </div>
            </div>
            <Link className="pa-btn pa-btn-danger pa-btn-sm" href="/tournaments">Open tournaments</Link>
          </article>
        </div>
      </section>
    </div>
  );
}
