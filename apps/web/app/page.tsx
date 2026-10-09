'use client';

import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';

import { CupIcon } from '@/components/cup-icons';
import { CupMeter } from '@/components/cup-meter';
import { FormatStage, Gen1CupArt } from '@/components/gen1-cup-art';
import { CompetitivePaths } from '@/components/ui';
import { TeamStrip, TrainerSprite } from '@/components/showdown-visuals';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { ShowdownBattle } from '@/components/showdown-battle';
import { useArena } from '@/lib/arena-context';
import {
  formatCardsRaw,
  formatPokeFromAtoms,
  formatRoomAmount,
  formatSolLamports,
  formatTournamentEntry,
  formatTournamentPrize,
} from '@/lib/api-client';
import { roomAccent, roomCode, roomStatusLabel, roomStatusPulses, roomStatusTone } from '@/lib/arena-room';
import type { BattleView, CasualRoom, LiveFight, TournamentSummary } from '@/lib/protocol';
import { formatCasualRoomLabel } from '@/lib/protocol';
import { readSavedTeam, type SavedTeam } from '@/lib/team';
import { formatById, type FormatPresentation } from '@/lib/tournament-formats';

function formatRoomLabel(room: CasualRoom): string {
  return formatCasualRoomLabel(room).toUpperCase();
}

function tournamentFormat(tournament: TournamentSummary): FormatPresentation {
  return formatById(tournament.ruleset ?? tournament.format) ?? formatById('gen9ou')!;
}

function tournamentStatus(tournament: TournamentSummary): { label: string; tone: string; pulse: boolean } {
  if (tournament.status === 'completed') {
    return { label: tournament.winner ? 'Crown awarded' : 'Completed', tone: 'is-done', pulse: false };
  }
  if (tournament.status === 'registration') return { label: 'Registration', tone: 'is-open', pulse: true };
  if (tournament.status === 'ready') return { label: 'Ready to start', tone: 'is-info', pulse: false };
  if (tournament.status === 'in-progress' || tournament.status === 'active') {
    return { label: 'Bracket live', tone: 'is-live', pulse: true };
  }
  return { label: tournament.status, tone: 'is-done', pulse: false };
}

function roomHref(room: CasualRoom): string {
  if (room.status === 'battling' && room.matchId) return `/battle/${room.matchId}`;
  return `/casual/${room.id}`;
}

function roomRank(room: CasualRoom): number {
  if (room.status === 'battling') return 0;
  if (room.status === 'ready') return 1;
  if (room.status === 'open') return 2;
  return 3;
}

const EMPTY_EVENTS: unknown[] = [];
const ignoreWatchError = () => undefined;

export default function LandingPage() {
  const { client, playerId, snapshot, refreshSnapshot, connected, chainEconomyEnabled } = useArena();
  const [saved, setSaved] = useState<SavedTeam | null>(null);
  const [live, setLive] = useState<{ fight?: LiveFight; view?: BattleView; events?: unknown[] } | null>(null);

  useEffect(() => {
    if (!connected) return;
    void Promise.all([
      client.request({ type: 'casual.list' }),
      client.request({ type: 'tournament.list' }),
    ]).then(() => refreshSnapshot()).catch(() => undefined);
  }, [client, connected, refreshSnapshot]);

  useEffect(() => {
    if (!connected) {
      setLive(null);
      return;
    }
    let cancelled = false;
    let rotateTimer: number | undefined;
    const unsubscribe = client.onMessage(message => {
      if (message.type !== 'live.update' || cancelled) return;
      setLive({ fight: message.fight, view: message.view, events: message.events ?? EMPTY_EVENTS });
      const active = Boolean(
        message.fight && (message.fight.status === 'active' || message.fight.status === 'battling'),
      );
      window.clearTimeout(rotateTimer);
      if (!active) {
        rotateTimer = window.setTimeout(() => {
          if (!cancelled) void client.request({ type: 'live.watch' }).catch(() => undefined);
        }, 8_000);
      }
    });
    void client.request({ type: 'live.watch' }).catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearTimeout(rotateTimer);
      unsubscribe();
      void client.request({ type: 'live.unwatch' }).catch(() => undefined);
    };
  }, [client, connected]);

  useEffect(() => {
    setSaved(playerId ? readSavedTeam(playerId) : null);
  }, [playerId]);

  const rooms = [...(snapshot?.openCasualRooms ?? [])].sort((a, b) => roomRank(a) - roomRank(b));
  const board = rooms.slice(0, 3);
  const tournaments = snapshot?.tournaments ?? [];
  const flagship = tournaments.find(item => item.status !== 'completed') ?? tournaments[0];
  const minors = tournaments.filter(item => item.id !== flagship?.id).slice(0, 2);
  const chain = chainEconomyEnabled;
  const totals = snapshot?.economyTotals;
  const liveFight = live?.fight;
  const liveView = live?.view;
  const liveActive = Boolean(liveFight && liveView && (liveFight.status === 'active' || liveFight.status === 'battling'));

  return (
    <div className="pa-home">
      <div className="pa-stadium-trainers" aria-hidden>
        <span className="pa-stadium-trainer left">
          <TrainerSprite label="" side="left" />
        </span>
        <span className="pa-stadium-trainer right">
          <TrainerSprite label="" side="right" />
        </span>
      </div>
      <section className="pa-hero">
        <h1>
          <img className="pa-wordmark" src="/brand/pokearena-wordmark.png?v=3" alt="PokeArena" />
        </h1>
        <p className="pa-tag">Battle. Compete. Climb.</p>
        <p className="pa-lead">
          <span className="pa-lead-intro">{chain ? 'Hold POKE to enter.' : 'Connect and compete.'}</span>{' '}
          {chain
            ? 'Wager CARDS in the arena, or enter a tournament and fight for Treasury-funded $CARDS prizes.'
            : 'Wager POKE in the arena, or enter a tournament and fight for a prize funded by the field.'}
        </p>
        {saved?.species.some(Boolean) ? (
          <div className="pa-protocol">
            <span>Your team</span>
            <TeamStrip species={saved.species} />
          </div>
        ) : null}
        <div className="pa-ctas">
          <Link className="pa-btn pa-btn-primary" href="/arena">Fight casually</Link>
          <Link className="pa-btn pa-btn-surface" href={flagship ? `/tournament/${flagship.id}` : '/tournaments'}>
            Enter a tournament
          </Link>
        </div>
      </section>

      <section
        className={`pa-duel is-feed${liveActive ? '' : ' is-idle'}`}
        aria-label={liveActive
          ? 'Live fight feed. Spectator view only. This match is not playable from here.'
          : 'Live fight feed. No match is live right now. Spectator view only.'}
      >
        <div className="pa-feed-bar" role="status">
          {liveActive ? (
            <>
              <span className="pa-feed-rec"><i /> REC</span>
              <strong>Live feed</strong>
              <span>You are spectating a random match. This screen cannot send moves.</span>
            </>
          ) : (
            <>
              <span className="pa-feed-rec is-idle">OFF AIR</span>
              <strong>Live feed</strong>
              <span>No match is live right now. This screen cannot send moves.</span>
            </>
          )}
        </div>
        <div className="pa-duel-rail">
          <div>
            <i className={`pa-ping ${liveActive ? 'coral' : ''}`} />
            <strong>
              {liveActive
                ? liveFight?.source === 'tournament'
                  ? `LIVE FEED • CUP • ${liveFight.title.toUpperCase()}`
                  : `LIVE FEED • CASUAL • ${liveFight?.title.toUpperCase()}`
                : 'LIVE FEED • NO MATCH ON AIR'}
              {' '}• GEN 9 OU
            </strong>
            <span className={`pa-chip ${liveActive ? 'rec' : ''}`}>{liveActive ? 'SPECTATING' : 'STANDBY'}</span>
            <span className="pa-chip">{liveFight?.battleSize?.toUpperCase() ?? '1V1'}</span>
          </div>
          <div>
            <span className="pa-chip amber">{liveActive ? `TURN ${liveView?.turn ?? 1}` : 'IDLE'}</span>
          </div>
        </div>
        {liveActive && liveFight && liveView && playerId ? (
          <div className="pa-duel-stage">
            <div className="pa-feed-scan" aria-hidden />
            <ShowdownBattle
              mode="watch"
              playerId={playerId}
              matchId={liveFight.matchId}
              battleInstanceId={liveView.battleId}
              battleView={liveView}
              events={live?.events ?? EMPTY_EVENTS}
              client={client}
              onError={ignoreWatchError}
            />
          </div>
        ) : (
          <div className="pa-feed-empty">
            <b>No fight is live</b>
            <p>When a casual or cup match is battling, a random one appears here. You cannot send moves from this screen.</p>
          </div>
        )}
        <div className="pa-duel-foot">
          <span className="pa-feed-note">Spectator feed · no moves from this screen</span>
          <span className="pa-cheer">
            {liveActive ? 'You are watching a random live match' : 'Waiting for the next live match'}
          </span>
        </div>
      </section>

      <section className="pa-fly">
        <header>
          <div>
            <h2><span>◆</span> Two competitive paths</h2>
            <p>
              {chain
                ? 'Arena fights wager CARDS. Tournaments burn a fixed POKE fee after fill and pay CARDS from the Treasury.'
                : 'Arena fights wager POKE. Tournaments hold entry fees and pay the champion from the field pool.'}
            </p>
          </div>
          <span className="pa-live-pill">
            <i /> {chain ? 'POKE passport · CARDS wagers' : 'Mock ledger · POKE stakes'}
          </span>
        </header>
        <CompetitivePaths chain={chain} />
      </section>

      <section className="cup-page home-board">
        <article className="cup-panel home-payouts">
          <header className="cup-panel-head">
            <h2><CupIcon name="coins" />Paid &amp; burned</h2>
            <span>Arena SOL · tournament CARDS · POKE burn</span>
          </header>
          <div className="home-payout-grid">
            <div className="cup-stat">
              <span>Arena SOL paid</span>
              <strong>{formatSolLamports(totals?.arenaSolLamports ?? 0)}</strong>
            </div>
            <div className="cup-stat">
              <span>Tournament CARDS paid</span>
              <strong>{formatCardsRaw(totals?.tournamentCardsRaw ?? 0)}</strong>
            </div>
            <div className="cup-stat">
              <span>POKE burned</span>
              <strong>{formatPokeFromAtoms(totals?.burnedPokeAtoms ?? 0)}</strong>
            </div>
          </div>
        </article>
        <div className="cup-section-head">
          <h2>Live arena board</h2>
          <span>{rooms.length} {rooms.length === 1 ? 'fight' : 'fights'}</span>
        </div>
        {board.length ? (
          <div className="arena-board">
            {board.map(room => <HomeFight key={room.id} room={room} playerId={playerId} />)}
          </div>
        ) : <p className="cup-empty">No open challenges right now.</p>}
      </section>

      <section className="cup-page home-radar">
        <div className="cup-section-head">
          <h2>Tournament radar</h2>
          <Link href="/tournaments">View complete calendar</Link>
        </div>
        <p className="cup-lead">
          {chain
            ? 'Fixed POKE burn. Competitive prize from the Tournament Treasury.'
            : 'Entry held at join. Competitive prize from the field pool.'}
        </p>
        {flagship ? (
          <div className="home-radar-grid">
            <RadarCard tournament={flagship} feature />
            {minors.length ? (
              <div className="home-radar-side">
                {minors.map(event => <RadarCard key={event.id} tournament={event} />)}
              </div>
            ) : null}
          </div>
        ) : <p className="cup-empty">No cup on deck yet.</p>}
      </section>

      <footer className="pa-foot">
        <div>
          <div>
            <strong>PokeArena Protocol</strong>
            <small>Competitive stadium engine for Gen 9 tier play. Showdown synced.</small>
          </div>
        </div>
        <div className="pa-foot-meta">
          <span>◆ POKE passport</span>
          <span>◆ Gen 9 OU</span>
          <span>◆ Local prototype</span>
        </div>
        <div className="pa-foot-badges">
          <span>Smogon OU compliant</span>
          <span className="ok">Showdown synced</span>
          <small>PokeArena</small>
        </div>
      </footer>
    </div>
  );
}

function HomeFight({ room, playerId }: { room: CasualRoom; playerId?: string | null }) {
  const mine = Boolean(playerId && (room.creatorId === playerId || room.opponentId === playerId));
  const live = room.status === 'battling';
  const real = room.rail === 'sol_chain';

  return (
    <Link href={roomHref(room)} className={`cup-panel is-accent cup-accent-${roomAccent(room)} arena-fight${mine ? ' is-you' : ''}${live ? ' is-live' : ''}`}>
      <header className="arena-fight-head">
        <span className={`cup-pill ${roomStatusTone(room.status)}`}>
          {roomStatusPulses(room.status) ? <i className="cup-dot is-pulse" aria-hidden /> : null}
          {roomStatusLabel(room.status)}
        </span>
        <span className="cup-chip arena-mark">{formatRoomLabel(room)}</span>
        <span className="cup-chip">{room.battleSize}</span>
        <span className={`cup-chip${real ? ' is-sol' : ''}`}>{real ? 'Real SOL' : 'Mock POKE'}</span>
        {mine ? <span className="cup-pill is-you">You</span> : null}
        <code className="arena-fight-code">#{roomCode(room)}</code>
      </header>
      <div className="arena-fight-body">
        <div className="arena-versus">
          <div className="arena-fighter">
            <span className="arena-fighter-art">
              <ProfileTrainerSprite label={room.creatorId} side="left" />
            </span>
            <div>
              <b><TrainerName playerId={room.creatorId} /></b>
              <small>Challenger</small>
            </div>
          </div>
          <span className="arena-versus-mark" aria-hidden>VS</span>
          <div className={`arena-fighter is-rival${room.opponentId ? '' : ' is-open'}`}>
            <span className="arena-fighter-art">
              {room.opponentId ? <ProfileTrainerSprite label={room.opponentId} side="right" /> : <i aria-hidden>?</i>}
            </span>
            <div>
              <b>{room.opponentId ? <TrainerName playerId={room.opponentId} /> : 'Open slot'}</b>
              <small>{room.opponentId ? 'Rival' : 'Waiting'}</small>
            </div>
          </div>
        </div>
        <div className="cup-stat arena-fight-stake">
          <span><CupIcon name="coins" />Stake each</span>
          <strong>{formatRoomAmount(room.collateral, room.rail)}</strong>
          <small>
            Pool {formatRoomAmount(room.economics.totalPot, room.rail)} · winner {formatRoomAmount(room.economics.winnerPayout, room.rail)} · 2% fee
          </small>
        </div>
      </div>
    </Link>
  );
}

function RadarCard({ tournament, feature = false }: { tournament: TournamentSummary; feature?: boolean }) {
  const format = tournamentFormat(tournament);
  const status = tournamentStatus(tournament);
  const chain = tournament.rail === 'sol_chain';
  const prize = formatTournamentPrize(tournament);
  const entry = formatTournamentEntry(tournament);
  const href = `/tournament/${tournament.id}`;
  const art = (
    <div className="cup-art" style={{ '--cup-art-bg': `url('${format.backdrop}')` } as CSSProperties}>
      <span className={`cup-pill ${status.tone} ${feature ? 'cup-feature-when' : 'cup-slot-when'}`}>
        {status.pulse ? <i className="cup-dot is-pulse" aria-hidden /> : null}
        {status.label}
      </span>
      {feature ? (
        <span className="cup-art-mark" aria-hidden>
          {format.region}
          <small>{format.restriction}</small>
        </span>
      ) : null}
      {format.id === 'gen1cup' ? (
        <Gen1CupArt compact={!feature} />
      ) : (
        <FormatStage compact={!feature} trainer={format.trainer} pokemon={format.pokemon} />
      )}
    </div>
  );

  if (!feature) {
    return (
      <article className={`cup-panel is-accent cup-accent-${format.accent} cup-slot`}>
        {art}
        <div className="cup-slot-body">
          <span className="cup-feature-theme">{format.title}</span>
          <h3>{tournament.title}</h3>
          <dl className="cup-slot-facts">
            <div>
              <dt>{chain ? 'Treasury prize' : 'Prize pool'}</dt>
              <dd className="is-prize">{prize}</dd>
            </div>
            <div>
              <dt>{chain ? 'Burn fee' : 'Entry'}</dt>
              <dd>{entry}</dd>
            </div>
            <div>
              <dt>Field</dt>
              <dd>{tournament.playerCount} / {tournament.maxPlayers}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{tournament.winner ? <TrainerName playerId={tournament.winner} /> : status.label}</dd>
            </div>
          </dl>
          <Link className="pa-btn pa-btn-gold" href={href}>
            {tournament.status === 'registration' ? 'Register now' : 'Watch bracket'}
          </Link>
        </div>
      </article>
    );
  }

  return (
    <article className={`cup-panel is-accent cup-accent-${format.accent} cup-feature`}>
      {art}
      <div className="cup-feature-body">
        <div className="cup-crumbs">
          <span className="cup-kicker">Flagship circuit</span>
          <span className={`cup-pill ${status.tone}`}>
            {status.pulse ? <i className="cup-dot is-pulse" aria-hidden /> : null}
            {status.label}
          </span>
        </div>
        <div className="cup-feature-title">
          <h2 className="cup-title">{tournament.title}</h2>
          <span className="cup-feature-theme">{format.title}</span>
        </div>
        <div className="cup-chips">
          <span className="cup-chip"><CupIcon name="users" />{format.teamModeLabel}</span>
          <span className="cup-chip">{tournament.maxPlayers} players</span>
          <span className="cup-chip">Single elimination</span>
        </div>
        <div className="cup-prize-hero">
          <small><CupIcon name="trophy" />{chain ? 'Treasury prize' : 'Prize pool'}</small>
          <strong>{prize}</strong>
        </div>
        <div className="cup-feature-stats">
          <div className="cup-stat">
            <span><CupIcon name="coins" />{chain ? 'Burn fee' : 'Entry'}</span>
            <strong>{entry}</strong>
          </div>
          <div className="cup-stat">
            <span><CupIcon name="users" />Field</span>
            <strong>{tournament.playerCount} / {tournament.maxPlayers}</strong>
            <CupMeter value={tournament.playerCount} max={tournament.maxPlayers} />
          </div>
          <div className="cup-stat">
            <span><CupIcon name="crown" />{tournament.winner ? 'Champion' : 'Pool'}</span>
            <strong>{tournament.winner ? <TrainerName playerId={tournament.winner} /> : format.restriction}</strong>
          </div>
        </div>
        <p className="cup-note">
          {chain
            ? 'Prize is reserved from the Tournament Treasury, paid 50/35/15.'
            : '90% of held entry fees form the prize pool, paid 50/35/15.'}
        </p>
        <div className="cup-feature-cta">
          <Link className="pa-btn pa-btn-gold" href={href}>
            {tournament.status === 'registration' ? 'Register now' : 'Watch bracket'}
          </Link>
          <Link className="pa-btn pa-btn-surface" href={href}>Rules</Link>
        </div>
      </div>
    </article>
  );
}
