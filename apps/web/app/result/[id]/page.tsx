'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';

import { TeamStrip } from '@/components/showdown-visuals';
import { AnimatedAmount } from '@/components/motion';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { formatRoomAmount } from '@/lib/api-client';

export default function ResultPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { client, lastCasualResult, lastTournamentResult, snapshot, playerId } = useArena();
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
      }).catch(() => undefined);
    });
  }, [client, id, snapshot]);

  const payout = casualRoom?.payout ?? tournament?.payout ?? lastCasualResult?.payout ?? lastTournamentResult?.payout;
  const stakeRail = casualRoom?.rail === 'sol_chain' || tournament?.rail === 'sol_chain' || payout?.symbol === 'SOL'
    ? 'sol_chain' as const
    : 'legacy_poke' as const;
  const money = (amount: number) => formatRoomAmount(amount, stakeRail);
  const feeAmount = shownProtocolFee(payout, casualRoom?.collateral);
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

  const challengerRoster = casualRoom?.rosters?.find(roster => roster.playerId === challenger);
  const rivalRoster = rival ? casualRoom?.rosters?.find(roster => roster.playerId === rival) : undefined;
  const teamSlots = Math.max(filledRosterCount(challengerRoster), filledRosterCount(rivalRoster));
  const viewer = viewerOutcome(playerId, winner, challenger, rival);
  const sides = orderSides({
    challenger,
    rival,
    winner,
    challengerRoster,
    rivalRoster,
    payoutAmount: payout?.amount,
    teamSlots,
    money,
  });

  return (
    <div className="pa-page result-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <h1>{title}</h1>
          <p className="pa-lead">Match settlement. With chain economy enabled, SOL payouts settle on-chain.</p>
        </div>
        <span className="pa-chip amber">{payoutReasonLabel(payout?.reason).toUpperCase()}</span>
      </header>

      <ErrorToast error={error} onDismiss={() => setError(null)} />

      <section className={`pa-result-card tone-${viewer} outcome-${viewer} ${stakeRail === 'sol_chain' ? 'rail-sol' : 'rail-poke'}${winner ? ' tone-decided' : ''}`}>
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
            <strong><AnimatedAmount value={payout.amount} format={money} /></strong>
            <span className="pa-result-banner-who"><TrainerName playerId={winner} /></span>
          </div>
        ) : (
          <div className="pa-result-summary">
            <span>{format}</span>
            <div className="pa-result-payout">
              <small>Payout</small>
              <strong>{payout ? <AnimatedAmount value={payout.amount} format={money} /> : '—'}</strong>
            </div>
          </div>
        )}

        {payout ? (
          <div className="pa-econ-rows pa-result-ledger">
            <div><span>Format</span><strong>{format}</strong></div>
            <div><span>Reason</span><strong>{payoutReasonLabel(payout.reason)}</strong></div>
            {feeAmount !== undefined ? (
              <div className="fee"><span>Protocol fee · 2% at match start</span><strong>{money(feeAmount)}</strong></div>
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

function viewerOutcome(
  playerId: string | null | undefined,
  winner?: string,
  challenger?: string,
  rival?: string,
): 'win' | 'loss' | 'tie' | 'watch' {
  if (!winner) return 'tie';
  if (playerId && playerId === winner) return 'win';
  if (playerId && (playerId === challenger || playerId === rival)) return 'loss';
  return 'watch';
}

function shownProtocolFee(
  payout: { amount: number; protocolFee?: number; winnerId?: string } | undefined,
  collateral?: number,
): number | undefined {
  if (!payout) return undefined;
  if (payout.protocolFee !== undefined) return payout.protocolFee;
  if (collateral === undefined) return undefined;
  const pot = collateral * 2;
  return payout.winnerId ? pot - payout.amount : pot - payout.amount * 2;
}

function payoutReasonLabel(reason?: string): string {
  switch (reason) {
    case 'casual-forfeit':
      return 'Forfeit';
    case 'casual-win':
      return 'Casual win';
    case 'casual-tie':
      return 'Casual tie';
    case 'tournament-win':
      return 'Tournament win';
    case 'refund':
      return 'Refund';
    default:
      return 'Settled';
  }
}

function outcomeFor(playerId: string, winner?: string): 'win' | 'loss' | 'tie' {
  if (!winner) return 'tie';
  return playerId === winner ? 'win' : 'loss';
}

function filledRosterCount(roster?: { pokemon: { species: string }[] }): number {
  return roster?.pokemon.filter(mon => Boolean(mon.species)).length ?? 0;
}

function orderSides(input: {
  challenger?: string;
  rival?: string;
  winner?: string;
  challengerRoster?: { pokemon: { species: string; fainted: boolean }[] };
  rivalRoster?: { pokemon: { species: string; fainted: boolean }[] };
  payoutAmount?: number;
  teamSlots: number;
  money: (amount: number) => string;
}) {
  if (!input.challenger) return null;

  const challengerSide = {
    playerId: input.challenger,
    role: 'Challenger',
    outcome: outcomeFor(input.challenger, input.winner),
    roster: input.challengerRoster,
    payout: input.winner === input.challenger ? input.payoutAmount : undefined,
    teamSlots: input.teamSlots,
    money: input.money,
  };
  const rivalSide = {
    playerId: input.rival ?? 'Open slot',
    role: input.rival ? 'Rival' : 'Waiting',
    outcome: input.rival ? outcomeFor(input.rival, input.winner) : null,
    roster: input.rivalRoster,
    payout: input.rival && input.winner === input.rival ? input.payoutAmount : undefined,
    teamSlots: input.teamSlots,
    money: input.money,
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
  teamSlots,
  money,
  end = false,
}: {
  playerId: string;
  role: string;
  outcome: 'win' | 'loss' | 'tie' | null;
  roster?: { pokemon: { species: string; fainted: boolean }[] };
  payout?: number;
  teamSlots: number;
  money: (amount: number) => string;
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
        <ProfileTrainerSprite label={playerId} side={end ? 'right' : 'left'} />
        <span className="pa-result-sprite-foot">{footer}</span>
      </div>
      <div className="pa-result-side-meta">
        <b><TrainerName playerId={playerId} /></b>
        <small>{role}</small>
        {outcome === 'win' && payout !== undefined ? (
          <em className="pa-result-side-take">+{money(payout)}</em>
        ) : outcome === 'loss' ? (
          <em className="pa-result-side-take loss">Stake lost</em>
        ) : null}
        {teamSlots > 0 ? <TeamStrip species={species} fainted={fainted} slots={teamSlots} /> : null}
      </div>
    </div>
  );
}
