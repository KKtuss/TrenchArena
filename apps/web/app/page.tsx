'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CompetitivePaths, TournamentEconomicsBlock } from '@/components/ui';
import { TeamStrip, TrainerSprite } from '@/components/showdown-visuals';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { ShowdownBattle } from '@/components/showdown-battle';
import { useArena } from '@/lib/arena-context';
import {
  formatPoke,
  formatRoomAmount,
  formatSolLamports,
  formatTournamentEntry,
  formatTournamentPrize,
} from '@/lib/api-client';
import type { BattleView, CasualRoom, LiveFight, TournamentSummary } from '@/lib/protocol';
import { formatCasualRoomLabel } from '@/lib/protocol';
import { readSavedTeam, type SavedTeam } from '@/lib/team';

function formatLabel(format: string): string {
  return format === 'gen9ou' ? 'GEN 9 OU' : format.toUpperCase();
}

function formatRoomLabel(room: CasualRoom): string {
  return formatCasualRoomLabel(room).toUpperCase();
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

function eventStatus(tournament: TournamentSummary): string {
  if (tournament.status === 'completed') return tournament.winner ? 'Crown awarded' : 'Completed';
  if (tournament.status === 'registration') return 'Registration';
  if (tournament.status === 'ready') return 'Ready to start';
  if (tournament.status === 'in-progress' || tournament.status === 'active') return 'Bracket live';
  return tournament.status;
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
  const featured = rooms[0];
  const board = rooms.slice(0, 3);
  const tournaments = snapshot?.tournaments ?? [];
  const flagship = tournaments.find(item => item.status !== 'completed') ?? tournaments[0];
  const minors = tournaments.filter(item => item.id !== flagship?.id).slice(0, 3);
  const chain = chainEconomyEnabled;
  const paidOut = (snapshot?.recentCasualResults ?? []).reduce((sum, room) => {
    if (chain && room.rail !== 'sol_chain') return sum;
    if (!chain && room.rail === 'sol_chain') return sum;
    return sum + (room.payout?.amount ?? 0);
  }, 0);
  const paidOutLabel = paidOut
    ? (chain ? formatSolLamports(paidOut) : formatPoke(paidOut))
    : '—';
  const flagshipPrize = formatTournamentPrize(flagship);
  const liveFight = live?.fight;
  const liveView = live?.view;
  const liveActive = Boolean(liveFight && liveView && (liveFight.status === 'active' || liveFight.status === 'battling'));

  const flywheel = chain
    ? [
      { n: '01', tone: 'cyan', kicker: 'Source', title: 'Creator / Dev Rewards - $CARDS', copy: 'Token trading activity generates creator and developer rewards for the project.' },
      { n: '02', tone: 'sky', kicker: 'Allocate 90%', title: 'Tournament Treasury', copy: 'Ninety percent of those rewards fund the Tournament Treasury that banks competition prizes.' },
      { n: '03', tone: 'amber', kicker: 'Fund', title: 'Prize Pools', copy: 'Cups draw CARDS from the Treasury so players compete without large collateral.' },
      { n: '04', tone: 'coral', kicker: 'Compete', title: 'Competitive Events', copy: 'Fixed POKE burn after fill. Gen brackets on the stadium calendar.' },
      { n: '05', tone: 'green', kicker: 'Reward', title: 'Players', copy: '1st, 2nd, and 3rd split the Treasury prize 50/35/15. Arena fights stay separate and player-funded.' },
    ]
    : [
      { n: '01', tone: 'cyan', kicker: 'Source', title: 'Entry holds', copy: 'Players post POKE entry fees when they register for a cup.' },
      { n: '02', tone: 'sky', kicker: 'Allocate 90%', title: 'Prize pool', copy: 'Ninety percent of held entries form the prize pool, paid 50/35/15.' },
      { n: '03', tone: 'amber', kicker: 'Fund', title: 'Field prize', copy: 'The prize grows with the field — it is not a separate vault balance.' },
      { n: '04', tone: 'coral', kicker: 'Compete', title: 'Competitive Events', copy: 'Low-entry tournaments put Gen brackets on the stadium calendar.' },
      { n: '05', tone: 'green', kicker: 'Reward', title: 'Players', copy: '1st, 2nd, and 3rd split the prize pool 50/35/15. Arena fights stay separate and player-funded.' },
    ];

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

      <section className="pa-fly" id="treasury">
        <header>
          <div>
            <h2><span>◆</span> Tournament flywheel</h2>
            <p>
              {chain
                ? 'Creator and developer rewards fund cups. Arena collateral never enters this loop.'
                : 'Held entry fees fund the champion. Arena collateral never enters this loop.'}
            </p>
          </div>
          <span className="pa-live-pill">
            <i /> {chain ? '90% Treasury · 10% project' : '90% prize · 10% ops'}
          </span>
        </header>
        <div className="pa-fly-grid">
          {flywheel.map(item => (
            <article key={item.n} className={`tone-${item.tone}`}>
              <div className="pa-fly-top"><b>{item.n}</b><small>{item.kicker}</small></div>
              <strong>{item.title}</strong>
              <p>{item.copy}</p>
            </article>
          ))}
        </div>
        <p className="pa-econ-note" style={{ marginTop: '0.85rem' }}>
          Separate track: arena fights take one 2% protocol fee from the gross player-funded pool
          {chain ? ' at match start' : ' at settlement'}. No withdrawal tax.
        </p>
      </section>

      <section className="pa-split">
        <div>
          <header>
            <h2>Live arena board</h2>
            <span>{rooms.length} {rooms.length === 1 ? 'fight' : 'fights'}</span>
          </header>
          {board.length ? board.map(room => (
            <article key={room.id} className="pa-board">
              <div className="pa-board-mark">{room.format === 'gen9ou' ? 'OU' : 'PA'}</div>
              <div>
                <p className="pa-board-trainers">
                  <ProfileTrainerSprite label={room.creatorId} side="left" />
                  <b><TrainerName playerId={room.creatorId} /></b>
                  <span>vs</span>
                  {room.opponentId ? <ProfileTrainerSprite label={room.opponentId} side="right" /> : null}
                  <b>{room.opponentId ? <TrainerName playerId={room.opponentId} /> : 'Open slot'}</b>
                </p>
                <small>{formatRoomLabel(room)} • {room.battleSize} • {room.status}</small>
              </div>
              <div className="pa-board-side">
                <strong>{formatRoomAmount(room.collateral, room.rail)}</strong>
                <small style={{ display: 'block', color: '#8ea0c0' }}>{room.rail === 'sol_chain' ? 'SOL each' : 'mock each'}</small>
                <Link href={roomHref(room)}>{room.status === 'open' ? 'Join' : 'Watch live'}</Link>
              </div>
            </article>
          )) : <p className="pa-empty">No open challenges right now.</p>}
        </div>
        <div id="treasury-audit">
          <header>
            <h2>Funding snapshot</h2>
            <span className="ok">{chain ? 'Chain rail' : 'Mock ledger'}</span>
          </header>
          <div className="pa-vault">
            <div className="pa-vault-grid">
              <div>
                <small>{chain ? 'Flagship treasury prize' : 'Flagship prize pool'}</small>
                <strong>{flagship ? flagshipPrize : '—'}</strong>
                <span>
                  {chain
                    ? (snapshot?.solBalances
                      ? `Live vault ${formatSolLamports(snapshot.solBalances.treasuryLamports)}`
                      : 'Configured CARDS prize for the open cup')
                    : '90% of held entries · provisional until settle'}
                </span>
              </div>
              <div>
                <small>Recent arena payouts</small>
                <strong className="ok">{paidOutLabel}</strong>
                <span>Player-funded wins after protocol fee</span>
              </div>
            </div>
            <div className="pa-legend">
              <span><i className="escrow" /> {chain ? 'Tournament Treasury 90%' : 'Prize pool 90%'}</span>
              <span><i className="ops" /> {chain ? 'Project funds 10%' : 'Ops share 10%'}</span>
              <span><i className="vault" /> Arena pools stay player-funded</span>
            </div>
            <div className="pa-contract">
              <span>
                Arena fee 2%
                {chain ? ' at match start' : ' at settlement'}
                {' · no withdrawal tax'}
              </span>
              <span>{chain ? 'CARDS prizes · POKE burn' : 'Mock ledger'}</span>
            </div>
            <Link href="/treasury">Open Treasury map</Link>
          </div>
        </div>
      </section>

      <section className="pa-radar">
        <header>
          <div>
            <h2><span>◆</span> Tournament radar</h2>
            <p>
              {chain
                ? 'Fixed POKE burn. Competitive CARDS prize from the Tournament Treasury.'
                : 'Entry held at join. Competitive prize from the field pool.'}
            </p>
          </div>
          <Link href="/tournaments">View complete calendar →</Link>
        </header>
        {flagship ? (
          <div className="pa-radar-grid">
            <article className="pa-flagship">
              <div className="pa-flag-top">
                <span>Flagship circuit</span>
                <small>{eventStatus(flagship)}</small>
              </div>
              <h3>{flagship.title}</h3>
              <p>{flagship.winner ? `Champion ${flagship.winner}` : `${formatLabel(flagship.format)} · ${flagship.playerCount}/${flagship.maxPlayers} on the field.`}</p>
              {flagship.playerCount > 0 ? (
                <div className="ps-field" aria-hidden>
                  {Array.from({ length: Math.min(flagship.playerCount, 4) }, (_, index) => (
                    <TrainerSprite key={index} label="" />
                  ))}
                </div>
              ) : null}
              <TournamentEconomicsBlock tournament={flagship} economics={flagship.economics} compact />
              <div className="pa-flag-actions">
                {flagship.status === 'registration' ? (
                  <Link className="pa-btn pa-btn-primary" href={`/tournament/${flagship.id}`}>Register now</Link>
                ) : (
                  <Link className="pa-btn pa-btn-primary" href={`/tournament/${flagship.id}`}>Watch bracket</Link>
                )}
                <Link className="pa-btn pa-btn-surface" href={`/tournament/${flagship.id}`}>Rules</Link>
              </div>
            </article>
            <div className="pa-minors">
              {minors.length ? minors.map(event => (
                <article key={event.id}>
                  <small>{formatLabel(event.format)}</small>
                  <h4>{event.title}</h4>
                  <p>{eventStatus(event)}{event.winner ? ` · ${event.winner}` : ''}</p>
                  <strong>
                    {event.rail === 'sol_chain' ? 'Burn' : 'Entry'}{' '}
                    {formatTournamentEntry(event)}
                  </strong>
                  <span style={{ display: 'block', color: '#8ea0c0', fontSize: '0.7rem' }}>
                    Prize {formatTournamentPrize(event)}
                  </span>
                  <Link href={`/tournament/${event.id}`}>{event.status === 'registration' ? 'Join tier' : 'Watch'}</Link>
                </article>
              )) : <p className="pa-empty">No other cups on the calendar.</p>}
            </div>
          </div>
        ) : <p className="pa-empty">No cup on deck yet.</p>}
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
