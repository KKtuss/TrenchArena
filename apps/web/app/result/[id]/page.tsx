'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { TeamStrip, TrainerSprite } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import { trainerName } from '@/lib/trainers';

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
  const winner = casualRoom?.winnerId ?? tournament?.winner ?? payout?.winnerId;
  const title = casualRoom
    ? `Casual ${casualRoom.id.slice(0, 8).toUpperCase()}`
    : tournament?.title ?? 'Match outcome';
  const format = casualRoom
    ? `${casualRoom.format.toUpperCase()} · ${casualRoom.battleSize}`
    : tournament
      ? tournament.format.toUpperCase()
      : 'Settlement';
  const challenger = casualRoom?.creatorId;
  const rival = casualRoom?.opponentId;

  const sides = orderSides({
    challenger,
    rival,
    winner,
    challengerRoster: casualRoom?.rosters?.find(roster => roster.playerId === challenger),
    rivalRoster: rival ? casualRoom?.rosters?.find(roster => roster.playerId === rival) : undefined,
    payoutAmount: payout?.amount,
  });

  return (
    <div className="pa-page result-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <p className="pa-kicker"><i /> — Result · settled —</p>
          <h1>{title}</h1>
          <p className="pa-lead">POKE credited to the winner.</p>
        </div>
        <span className="pa-chip amber">{(payout?.reason ?? 'settled').replace(/-/g, ' ').toUpperCase()}</span>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className={`pa-result-card${winner ? ' tone-decided' : ''}`}>
        {sides ? (
          <div className="pa-result-sides">
            <ResultSide {...sides.left} />
            <span className="pa-fight-vs">vs</span>
            <ResultSide {...sides.right} end />
          </div>
        ) : null}

        {winner && payout ? (
          <div className="pa-result-banner">
            <span className="pa-result-banner-kicker">Winner takes</span>
            <strong>{formatPoke(payout.amount)}</strong>
            <span className="pa-result-banner-who">{trainerName(winner)}</span>
          </div>
        ) : (
          <div className="pa-result-summary">
            <span>{format}</span>
            <div className="pa-result-payout">
              <small>Payout</small>
              <strong>{payout ? formatPoke(payout.amount) : '—'}</strong>
            </div>
          </div>
        )}

        {payout ? (
          <div className="pa-econ-rows pa-result-ledger">
            <div><span>Format</span><strong>{format}</strong></div>
            <div><span>Reason</span><strong>{payout.reason}</strong></div>
            {payout.protocolFee !== undefined ? (
              <div className="fee"><span>Protocol fee · 2% at match start</span><strong>{formatPoke(payout.protocolFee)}</strong></div>
            ) : null}
          </div>
        ) : (
          <p className="pa-empty">Settlement details are not available for this result.</p>
        )}
      </section>

      <div className="pa-lobby-actions">
        <Link className="pa-btn pa-btn-primary" href="/arena">Back to Arena</Link>
        <Link className="pa-btn pa-btn-surface" href="/casual">Casual lobby</Link>
        <Link className="pa-btn pa-btn-surface" href="/tournaments">Tournaments</Link>
      </div>
    </div>
  );
}

function outcomeFor(playerId: string, winner?: string): 'win' | 'loss' | 'tie' {
  if (!winner) return 'tie';
  return playerId === winner ? 'win' : 'loss';
}

function orderSides(input: {
  challenger?: string;
  rival?: string;
  winner?: string;
  challengerRoster?: { pokemon: { species: string; fainted: boolean }[] };
  rivalRoster?: { pokemon: { species: string; fainted: boolean }[] };
  payoutAmount?: number;
}) {
  if (!input.challenger) return null;

  const challengerSide = {
    playerId: input.challenger,
    role: 'Challenger',
    outcome: outcomeFor(input.challenger, input.winner),
    roster: input.challengerRoster,
    payout: input.winner === input.challenger ? input.payoutAmount : undefined,
  };
  const rivalSide = {
    playerId: input.rival ?? 'Open slot',
    role: input.rival ? 'Rival' : 'Waiting',
    outcome: input.rival ? outcomeFor(input.rival, input.winner) : null,
    roster: input.rivalRoster,
    payout: input.rival && input.winner === input.rival ? input.payoutAmount : undefined,
  };

  // Winner always left. Ties / unresolved keep challenger left.
  if (input.winner && input.rival && input.winner === input.rival) {
    return { left: rivalSide, right: challengerSide };
  }
  return { left: challengerSide, right: rivalSide };
}

function ResultSide({
  playerId,
  role,
  outcome,
  roster,
  payout,
  end = false,
}: {
  playerId: string;
  role: string;
  outcome: 'win' | 'loss' | 'tie' | null;
  roster?: { pokemon: { species: string; fainted: boolean }[] };
  payout?: number;
  end?: boolean;
}) {
  const species = roster?.pokemon.map(mon => mon.species);
  const fainted = roster?.pokemon.map(mon => mon.fainted);
  const footer = outcome === 'win'
    ? 'Winner'
    : outcome === 'loss'
      ? 'Defeated'
      : outcome === 'tie'
        ? 'Tied'
        : role;

  return (
    <div className={`pa-result-side outcome-${outcome ?? 'open'}${end ? ' end' : ''}`}>
      <div className="pa-result-sprite">
        <TrainerSprite label={playerId} side={end ? 'right' : 'left'} />
        <span className="pa-result-sprite-foot">{footer}</span>
      </div>
      <div className="pa-result-side-meta">
        <b>{trainerName(playerId)}</b>
        <small>{role}</small>
        {outcome === 'win' && payout !== undefined ? (
          <em className="pa-result-side-take">+{formatPoke(payout)}</em>
        ) : outcome === 'loss' ? (
          <em className="pa-result-side-take loss">Stake lost</em>
        ) : null}
        <TeamStrip species={species} fainted={fainted} />
      </div>
    </div>
  );
}
