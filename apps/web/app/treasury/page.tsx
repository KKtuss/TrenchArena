'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { useArena } from '@/lib/arena-context';
import { formatPoke, formatRoomAmount, formatSolLamports, formatTournamentPrize } from '@/lib/api-client';

export default function TreasuryPage() {
  const { client, snapshot, refreshSnapshot } = useArena();
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

  const rooms = snapshot?.openCasualRooms ?? [];
  const tournaments = snapshot?.tournaments ?? [];
  const chain = Boolean(snapshot?.chainEconomyEnabled);

  const chainCups = tournaments.filter(item => item.rail === 'sol_chain');
  const legacyCups = tournaments.filter(item => item.rail !== 'sol_chain');
  const prizeTargetsLamports = chainCups.reduce((sum, item) => sum + (item.prizeLamports ?? 0), 0);
  const prizeTargetsPoke = legacyCups.reduce((sum, item) => sum + item.economics.prizePool, 0);
  const projectSharePoke = legacyCups.reduce((sum, item) => sum + item.economics.devOpsShare, 0);
  const operatorFromDeposits = deposits.reduce((sum, row) => sum + row.operatorLamports, 0);

  const boardRooms = rooms.filter(room => (chain ? room.rail === 'sol_chain' : room.rail !== 'sol_chain'));
  const casualGross = boardRooms.reduce((sum, room) => sum + room.economics.totalPot, 0);
  const casualFees = boardRooms.reduce((sum, room) => sum + room.economics.protocolFee, 0);
  const paidOut = (snapshot?.recentCasualResults ?? []).reduce((sum, room) => {
    if (chain && room.rail !== 'sol_chain') return sum;
    if (!chain && room.rail === 'sol_chain') return sum;
    return sum + (room.payout?.amount ?? 0);
  }, 0);
  const money = (amount: number) => (amount ? formatRoomAmount(amount, chain ? 'sol_chain' : 'legacy_poke') : '—');

  return (
    <div className="pa-page">
      <header className="pa-page-head">
        <h1>Treasury &amp; Economy</h1>
        <p className="pa-lead">
          {chain
            ? 'POKE is your passport. SOL is what you compete for. Creator-reward SOL deposits split 90/10 into the tournament treasury and operator allocation. Casual fights wager SOL with a 2% fee at match start.'
            : 'Mock ledger mode. Casual fights wager POKE. Tournament prizes come from held entry fees (90% champion / 10% ops). Casual collateral never funds cups.'}
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
                ? 'Token trading rewards split once. This route never includes casual collateral.'
                : 'Held entry fees split once at settlement. Casual collateral never enters this route.'}
            </p>
          </div>
          <span className="pa-live-pill"><i /> {chain ? 'On-chain allocation' : 'Legacy ledger'}</span>
        </header>
        <article className="pa-route-block creator">
          <div className="pa-route-source">
            <b>{chain ? 'Creator / dev rewards' : 'Entry fee holds'}</b>
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
            <h2><span>◆</span> Casual protocol fee</h2>
            <p>A different route. One fee from the player-funded gross pool. No withdrawal tax.</p>
          </div>
          <span className="pa-live-pill">
            <i /> {chain ? 'Charged at match start' : 'Taken at settlement'}
          </span>
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
                <h3>{chain ? 'Burn fee. Treasury prize.' : 'Entry hold. Field prize.'}</h3>
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
                    ? '90% creator rewards bank the SOL prize pool.'
                    : '90% of held entries pay the champion.'}
                </span>
              </div>
              <div className="pa-flow-step">
                <b>Champion</b>
                <span>
                  {chain
                    ? 'Takes the Treasury-funded SOL prize.'
                    : 'Takes the field-funded POKE prize.'}
                </span>
              </div>
            </div>
            <div className="pa-vault-grid">
              <div>
                <small>Prize targets</small>
                <strong>
                  {chain
                    ? (prizeTargetsLamports ? formatSolLamports(prizeTargetsLamports) : '—')
                    : (prizeTargetsPoke ? formatPoke(prizeTargetsPoke) : '—')}
                </strong>
                <span>
                  {chain
                    ? 'Sum of open cup SOL prizes'
                    : 'Sum of provisional POKE field prizes'}
                </span>
              </div>
              <div>
                <small>{chain ? 'Operator from deposits' : 'Project-fund figure'}</small>
                <strong>
                  {chain
                    ? (operatorFromDeposits ? formatSolLamports(operatorFromDeposits) : '—')
                    : (projectSharePoke ? formatPoke(projectSharePoke) : '—')}
                </strong>
                <span>
                  {chain
                    ? '10% share from realized creator deposits'
                    : 'Mock 10% display from entry holds'}
                </span>
              </div>
            </div>
            {tournaments[0] ? (
              <p className="pa-route-copy" style={{ marginTop: '0.75rem' }}>
                Flagship example: {formatTournamentPrize(tournaments[0])}
              </p>
            ) : null}
            <Link className="pa-btn pa-btn-primary pa-btn-sm" href="/tournaments">Open tournaments</Link>
          </article>

          <article className="pa-mode-panel casual">
            <header>
              <div>
                <small>Casual</small>
                <h3>{chain ? 'Wager SOL in casual fights.' : 'Wager POKE in casual fights.'}</h3>
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
                <span>Receives the remaining 98%.</span>
              </div>
            </div>
            <div className="pa-vault-grid">
              <div>
                <small>Open gross pools</small>
                <strong>{money(casualGross)}</strong>
                <span>{boardRooms.length} room{boardRooms.length === 1 ? '' : 's'} · player collateral</span>
              </div>
              <div>
                <small>Protocol fees on board</small>
                <strong>{money(casualFees)}</strong>
                <span>Recent payouts {money(paidOut)}</span>
              </div>
            </div>
            <Link className="pa-btn pa-btn-primary pa-btn-sm" href="/arena">Open Arena</Link>
          </article>
        </div>
        <p className="pa-route-copy">
          {chain
            ? 'Live vault balance and public deposits come from the chain API when available. Cup prize targets are the configured SOL prizes for open tournaments.'
            : 'Mock ledger figures. Creator-reward SOL deposits and a live vault appear only when chain economy is enabled.'}
        </p>
      </section>
    </div>
  );
}
