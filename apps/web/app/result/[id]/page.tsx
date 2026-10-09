'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';

import { CupIcon } from '@/components/cup-icons';
import { TeamStrip } from '@/components/showdown-visuals';
import { AnimatedAmount } from '@/components/motion';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { MatchSummary } from '@/components/tournament-bracket';
import { useArena } from '@/lib/arena-context';
import { formatRoomAmount } from '@/lib/api-client';
import { formatById } from '@/lib/tournament-formats';
import {
  displayHubStatus,
  formatName,
  registeredPlayers,
  tournamentPodium,
  visibleBracket,
  type HubStatus,
  type TournamentDetail,
} from '@/lib/tournament-hub';
import { tournamentPayoutView, tournamentPrizeView } from '@/lib/tournament-prize';
import { TOURNAMENT_ENTRY_POKE, previewTreasuryPrize } from '@/lib/tournament-schedule';

export default function ResultPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
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
    if (snapshot?.tournaments.some(item => item.id === id)) {
      void client.request({ type: 'tournament.subscribe', tournamentId: id }).then(response => {
        if (response.type === 'tournament.state') setTournament(response.tournament);
      }).catch(() => undefined);
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

  if (!casualRoom && tournament?.id === id) {
    const tournamentPayout = tournament.payout
      ?? (lastTournamentResult?.tournament?.id === id ? lastTournamentResult.payout : undefined);
    return (
      <>
        <ErrorToast error={error} onDismiss={() => setError(null)} />
        <TournamentResults tournament={tournament} payout={tournamentPayout} playerId={playerId} />
      </>
    );
  }

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

const BADGE_TONE: Record<HubStatus, string> = {
  LIVE: 'is-live',
  UPCOMING: 'is-info',
  COMPLETED: 'is-gold',
  CANCELLED: 'is-done',
};

const PLACE_ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd' } as const;

function TournamentResults({
  tournament,
  payout,
  playerId,
}: {
  tournament: TournamentDetail;
  payout?: { symbol?: string; amount: number; cardsAmountRaw?: number; reason?: string };
  playerId?: string | null;
}) {
  const matches = visibleBracket(tournament);
  const podium = tournamentPodium(matches, tournament.winner);
  const settled = tournamentPayoutView(payout);
  const rulesetId = tournament.ruleset || tournament.format || 'gen9ou';
  const formatCard = formatById(rulesetId);
  const players = registeredPlayers(tournament);
  const prizePool = tournament.economics?.prizePool
    ?? previewTreasuryPrize(tournament.entryFee ?? TOURNAMENT_ENTRY_POKE, tournament.maxPlayers).prizePool;
  const prize = tournamentPrizeView(tournament, prizePool);
  const badge = displayHubStatus(tournament, matches);
  const champion = podium.first;
  const viewerPlace = !playerId
    ? undefined
    : playerId === podium.first ? 1 : playerId === podium.second ? 2 : playerId === podium.third ? 3 : undefined;
  const places = [
    { place: 2 as const, id: podium.second, take: settled?.places?.second },
    { place: 1 as const, id: podium.first, take: settled?.places?.first ?? settled?.label },
    { place: 3 as const, id: podium.third, take: settled?.places?.third },
  ];
  const hub = `/tournament/${tournament.id}`;

  return (
    <div className={`pa-page cup-page cup-results cup-accent-${formatCard?.accent ?? 'cup'}`}>
      <nav className="cup-crumbs" aria-label="Tournament">
        <div className="cup-crumbs-left">
          <Link className="cup-back" href={hub}><CupIcon name="arrow-left" />Back to bracket</Link>
          <span className="cup-chip">{formatCard?.title ?? formatName(rulesetId)}</span>
          <span className="cup-chip">{tournament.maxPlayers} players</span>
        </div>
        <div className="cup-crumbs-right">
          {payout ? <span className="cup-pill is-accent">{payoutReasonLabel(payout.reason)}</span> : null}
          <span className={`cup-pill ${BADGE_TONE[badge]}`}>{badge}</span>
        </div>
      </nav>

      <header className="cup-head">
        <div className="cup-head-copy">
          <span className="cup-kicker">Final results</span>
          <h1 className="cup-title">{tournament.title}</h1>
        </div>
      </header>

      <section className={`cup-panel cup-champ${champion ? '' : ' is-pending'}`} aria-label="Champion">
        <div className="cup-champ-sprite">
          {champion ? (
            <>
              <CupIcon name="crown" />
              <ProfileTrainerSprite label={champion} side="left" />
            </>
          ) : (
            <CupIcon name="trophy" />
          )}
        </div>
        <div className="cup-champ-copy">
          <span className="cup-kicker">{champion ? 'Champion' : 'Results pending'}</span>
          <strong className="cup-champ-name">
            {champion ? <TrainerName playerId={champion} /> : 'To be decided'}
          </strong>
          <p className="cup-lead">
            {champion
              ? `${formatCard?.title ?? formatName(rulesetId)} · ${players.length} trainers · single elimination`
              : 'The cup is decided when the final and the 3rd-place match are both done.'}
          </p>
        </div>
        {champion ? (
          <div className="cup-champ-take">
            <small>{settled ? 'Winner takes' : 'Payout'}</small>
            <strong>
              {settled ? <AnimatedAmount value={settled.amount} format={settled.format} /> : 'Pending'}
            </strong>
          </div>
        ) : null}
      </section>

      {viewerPlace ? (
        <p className="cup-you is-champion">
          <CupIcon name={viewerPlace === 1 ? 'crown' : 'trophy'} />
          <span>You finished {PLACE_ORDINAL[viewerPlace]}.</span>
        </p>
      ) : null}

      <div className="cup-results-grid">
        <section className="cup-panel is-accent" aria-label="Podium">
          <header className="cup-panel-head">
            <h2><CupIcon name="trophy" />Podium</h2>
            <span>{prize.label} pool</span>
          </header>
          <div className="cup-podium">
            {places.map(({ place, id, take }) => (
              <div key={place} className={`cup-place is-${place === 1 ? 'first' : place === 2 ? 'second' : 'third'}`}>
                {id ? <ProfileTrainerSprite label={id} side={place === 3 ? 'right' : 'left'} /> : <span className="cup-place-empty" aria-hidden />}
                <b>{id ? <TrainerName playerId={id} /> : 'TBD'}</b>
                <small>{take ?? PLACE_ORDINAL[place]}</small>
                <span className="cup-place-block" aria-label={`${PLACE_ORDINAL[place]} place`}>{place}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="cup-aside">
          <section className="cup-panel" aria-label="Deciding matches">
            <header className="cup-panel-head">
              <h2><CupIcon name="swords" />Deciding matches</h2>
            </header>
            <div className="cup-deciders">
              {podium.final ? (
                <div className="cup-decider">
                  <span><CupIcon name="crown" />Final</span>
                  <MatchSummary match={podium.final} viewerId={playerId} />
                </div>
              ) : null}
              {podium.thirdPlace ? (
                <div className="cup-decider">
                  <span><CupIcon name="flag" />3rd-place match</span>
                  <MatchSummary match={podium.thirdPlace} viewerId={playerId} />
                </div>
              ) : null}
              {!podium.final && !podium.thirdPlace ? (
                <p className="cup-stage-note">The bracket has not reached the final yet.</p>
              ) : null}
            </div>
          </section>

          <section className="cup-panel" aria-label="Settlement">
            <header className="cup-panel-head">
              <h2><CupIcon name="coins" />Settlement</h2>
            </header>
            <dl className="cup-facts">
              <div><dt>Format</dt><dd>{formatCard?.title ?? formatName(rulesetId)}</dd></div>
              <div><dt>Field</dt><dd>{players.length} / {tournament.maxPlayers}</dd></div>
              <div><dt>Prize pool</dt><dd>{prize.label}</dd></div>
              <div><dt>Champion payout</dt><dd>{settled?.label ?? 'Pending'}</dd></div>
              <div><dt>Reason</dt><dd>{payout ? payoutReasonLabel(payout.reason) : '—'}</dd></div>
            </dl>
          </section>
        </div>
      </div>

      <div className="cup-actions">
        <Link className="pa-btn pa-btn-primary" href={hub}>Back to bracket</Link>
        <Link className="pa-btn pa-btn-surface" href="/tournaments">Tournaments</Link>
        <Link className="pa-btn pa-btn-surface" href="/arena">Back to Arena</Link>
      </div>
    </div>
  );
}
