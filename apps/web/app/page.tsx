'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import type { CasualRoom, TournamentSummary } from '@/lib/protocol';

function formatLabel(format: string, battleSize?: string): string {
  const pretty = format === 'gen9ou' ? 'Gen 9 OU' : format.toUpperCase();
  return battleSize ? `${pretty} · ${battleSize}` : pretty;
}

function trainerMark(id: string): string {
  const compact = id.replace(/[^a-zA-Z0-9]/g, '');
  if (compact.length < 2) return compact.slice(0, 2).toUpperCase() || 'PA';
  return (compact.slice(0, 1) + compact.slice(-1)).toUpperCase();
}

function roomHref(room: CasualRoom): string {
  if (room.status === 'battling' && room.matchId) return `/battle/${room.matchId}`;
  return `/casual/${room.id}`;
}

function roomAction(room: CasualRoom): string {
  if (room.status === 'open') return 'Join matchup';
  if (room.status === 'battling') return 'Spectate live';
  return 'View matchup';
}

function roomRank(room: CasualRoom): number {
  if (room.status === 'battling') return 0;
  if (room.status === 'ready') return 1;
  if (room.status === 'open') return 2;
  return 3;
}

function eventField(tournament: TournamentSummary): { label: string; value: string; hint?: string } {
  if (tournament.status === 'completed' || tournament.status === 'cancelled' || tournament.status === 'forfeited') {
    return { label: 'Field', value: `${tournament.playerCount} entered` };
  }
  if (tournament.status === 'in-progress' || tournament.status === 'active' || tournament.status === 'ready') {
    return { label: 'Field', value: `${tournament.playerCount} competing` };
  }
  const open = Math.max(0, tournament.maxPlayers - tournament.playerCount);
  return {
    label: 'Registering',
    value: `${tournament.playerCount} / ${tournament.maxPlayers}`,
    hint: open ? `${open} slot${open === 1 ? '' : 's'} left` : 'Field full',
  };
}

function eventStatus(tournament: TournamentSummary): string {
  if (tournament.status === 'completed') return tournament.winner ? 'Crown awarded' : 'Completed';
  if (tournament.status === 'registration') return 'Registration';
  if (tournament.status === 'ready') return 'Ready to start';
  if (tournament.status === 'in-progress' || tournament.status === 'active') return 'Bracket live';
  if (tournament.status === 'draft') return 'Draft';
  return tournament.status;
}

function TeamDots({ filled, total = 6, foe }: { filled: number; total?: number; foe?: boolean }) {
  return (
    <span className={`home-team-dots${foe ? ' home-team-dots-foe' : ''}`} aria-hidden>
      {Array.from({ length: total }, (_, index) => (
        <i key={index} className={index < filled ? 'on' : ''} />
      ))}
    </span>
  );
}

function HeroHud({ room }: { room?: CasualRoom }) {
  if (!room) {
    return (
      <article className="home-hero-hud">
        <div className="home-hero-hud-rail">
          <div>
            <span className="home-live-dot idle" />
            <strong>STADIUM GATES OPEN · GEN 9 OU</strong>
          </div>
          <span className="home-hero-hud-meta">Awaiting first challenge</span>
        </div>
        <div className="home-hero-hud-grid">
          <div className="home-side-card">
            <div className="home-side-head">
              <span className="home-avatar">P1</span>
              <div>
                <strong>Trainer</strong>
                <small>Challenger</small>
              </div>
            </div>
            <div className="home-side-body">
              <span>TEAM PREVIEW</span>
              <TeamDots filled={0} />
            </div>
          </div>
          <div className="home-hero-vs">
            <span className="home-vs-mark">VS</span>
            <span className="home-vs-chip">Rival waiting</span>
          </div>
          <div className="home-side-card home-side-foe">
            <div className="home-side-head">
              <span className="home-avatar home-avatar-foe">P2</span>
              <div>
                <strong>Rival</strong>
                <small>Open slot</small>
              </div>
            </div>
            <div className="home-side-body">
              <span>TEAM PREVIEW</span>
              <TeamDots filled={0} foe />
            </div>
          </div>
        </div>
        <div className="home-hero-hud-foot">
          <span>Find a fight on the arena floor</span>
          <Link href="/arena">View Arena →</Link>
        </div>
      </article>
    );
  }

  const waiting = !room.opponentId;
  return (
    <article className="home-hero-hud">
      <div className="home-hero-hud-rail">
        <div>
          <span className={`home-live-dot${room.status === 'battling' ? '' : ' idle'}`} />
          <strong>
            {room.status === 'battling' ? 'LIVE ON THE FLOOR' : 'OPEN CHALLENGE'}
            {' · '}
            {formatLabel(room.format).toUpperCase()}
          </strong>
          <span className="home-chip">{room.battleSize.toUpperCase()}</span>
        </div>
        <span className="home-prize-chip">STAKE {formatPoke(room.collateral)}</span>
      </div>
      <div className="home-hero-hud-grid">
        <div className="home-side-card">
          <div className="home-side-head">
            <span className="home-avatar">{trainerMark(room.creatorId)}</span>
            <div>
              <strong>{room.creatorId}</strong>
              <small>Challenger</small>
            </div>
          </div>
          <div className="home-side-body">
            <span>TEAM PREVIEW</span>
            <span className="home-side-count">3/6</span>
            <TeamDots filled={3} />
          </div>
        </div>
        <div className="home-hero-vs">
          <span className="home-vs-mark">VS</span>
          <span className="home-vs-chip">{room.status}</span>
          <span className="home-vs-note">{formatLabel(room.format, room.battleSize)}</span>
        </div>
        <div className="home-side-card home-side-foe">
          <div className="home-side-head">
            <span className="home-avatar home-avatar-foe">{waiting ? 'P2' : trainerMark(room.opponentId!)}</span>
            <div>
              <strong>{room.opponentId ?? 'Open slot'}</strong>
              <small>{waiting ? 'Waiting' : 'Opponent'}</small>
            </div>
          </div>
          <div className="home-side-body">
            <span>TEAM PREVIEW</span>
            <span className="home-side-count">{waiting ? '0/6' : '3/6'}</span>
            <TeamDots filled={waiting ? 0 : 3} foe />
          </div>
        </div>
      </div>
      <div className="home-hero-hud-foot">
        <Link href={roomHref(room)}>
          <span className="home-live-dot" />
          {roomAction(room).toUpperCase()}
        </Link>
        <span>Winner {formatPoke(room.economics.winnerPayout)}</span>
      </div>
    </article>
  );
}

function BoardCard({ room }: { room: CasualRoom }) {
  const waiting = !room.opponentId;
  return (
    <article className="home-board-card">
      <div className="home-board-rail">
        <div>
          <span className={`home-live-tag${room.status === 'battling' ? '' : ' idle'}`}>
            {room.status === 'battling' ? 'LIVE' : room.status}
          </span>
          <span>{formatLabel(room.format, room.battleSize)}</span>
        </div>
        <strong>STAKE: {formatPoke(room.collateral)}</strong>
      </div>
      <div className="home-board-axis">
        <div className="home-board-trainer">
          <span className="home-avatar">{trainerMark(room.creatorId)}</span>
          <div>
            <strong>{room.creatorId}</strong>
            <small>{waiting ? 'Waiting for opponent' : 'Locked in'}</small>
          </div>
        </div>
        <div className="home-board-score">
          <strong>{waiting ? 'OPEN' : 'VS'}</strong>
          <small>{room.status}</small>
        </div>
        <div className="home-board-trainer home-board-foe">
          <div>
            <strong>{room.opponentId ?? 'Open slot'}</strong>
            <small>{waiting ? 'Open queue' : 'Locked in'}</small>
          </div>
          <span className="home-avatar home-avatar-foe">{waiting ? 'P2' : trainerMark(room.opponentId!)}</span>
        </div>
      </div>
      <div className="home-board-foot">
        <span>Winner {formatPoke(room.economics.winnerPayout)}</span>
        <Link href={roomHref(room)}>{room.status === 'open' ? 'JOIN ARENA →' : 'SPEC ARENA STREAM →'}</Link>
      </div>
    </article>
  );
}

export default function LandingPage() {
  const { client, snapshot, refreshSnapshot } = useArena();

  useEffect(() => {
    void Promise.all([
      client.request({ type: 'casual.list' }),
      client.request({ type: 'tournament.list' }),
    ]).then(() => refreshSnapshot());
  }, [client, refreshSnapshot]);

  const liveRooms = [...(snapshot?.openCasualRooms ?? [])].sort((a, b) => roomRank(a) - roomRank(b));
  const featuredMatch = liveRooms[0];
  const boardRooms = liveRooms.length > 1 ? liveRooms.slice(0, 2) : liveRooms;

  const tournaments = snapshot?.tournaments ?? [];
  const featuredEvent = tournaments.find(item => item.status !== 'completed') ?? tournaments[0];
  const featuredField = featuredEvent ? eventField(featuredEvent) : null;
  const minorEvents = tournaments.filter(item => item.id !== featuredEvent?.id).slice(0, 3);

  const prizePool = tournaments.reduce((sum, item) => sum + item.economics.prizePool, 0);
  const livePot = liveRooms.reduce((sum, room) => sum + room.economics.totalPot, 0);
  const staked = liveRooms.reduce((sum, room) => sum + room.collateral, 0)
    + tournaments.reduce((sum, item) => sum + item.economics.totalEntries, 0);
  const paidOut = (snapshot?.recentCasualResults ?? []).reduce((sum, room) => sum + (room.payout?.amount ?? 0), 0);
  const fundedCups = tournaments.filter(item => item.status !== 'completed' && item.status !== 'cancelled').length;
  const vault = prizePool + livePot;

  const flywheel = [
    { step: '01. DEPOSIT', lane: 'TOKEN', title: 'POKE Staking', copy: 'Trainers lock POKE as match stake or cup entry.', stat: staked ? formatPoke(staked) : 'Open board' },
    { step: '02. ACCUMULATE', lane: 'TREASURY', title: 'Stadium Treasury', copy: 'Prize liquidity from live pots and cup entries.', stat: vault ? formatPoke(vault) : 'Awaiting stake' },
    { step: '03. ALLOCATE', lane: 'BRACKET', title: 'Tournament Funding', copy: 'Active cups carry the prize pool onto the bracket.', stat: `${fundedCups} cup${fundedCups === 1 ? '' : 's'} funded` },
    { step: '04. COMBAT', lane: 'GEN 9 OU', title: 'Competitive Battle', copy: 'Showdown settles every match on the stadium floor.', stat: `${liveRooms.length} live on board` },
    { step: '05. PAYOUT', lane: 'INSTANT', title: 'Champion Rewards', copy: 'Winners are paid the pot minus the 2% protocol fee.', stat: paidOut ? formatPoke(paidOut) : 'No payouts yet' },
  ];

  return (
    <div className="home-world">
      <section className="home-stadium">
        <p className="home-kicker">
          <span />
          Battle Stadium · Gen 9 OU tier
          <span />
        </p>
        <h1>POKEARENA</h1>
        <HeroHud room={featuredMatch} />
        <p className="home-tag">Battle. Compete. Climb.</p>
        <div className="home-ctas">
          <Link className="home-cta-primary" href={featuredEvent ? `/tournament/${featuredEvent.id}` : '/tournaments'}>
            Enter tournament bracket
          </Link>
          <a className="home-cta-ghost" href="#stadium-loop">Explore treasury & staking</a>
        </div>
        <p className="home-explainer">
          Compete in Gen 9 OU battles funded by the player-backed
          {' '}
          <strong>POKE Stadium Treasury</strong>
          . 90% of cup entries seed prizes. Casual pots pay the winner minus a 2% fee.
        </p>
      </section>

      <section className="home-flywheel" id="stadium-loop">
        <div className="home-section-head">
          <h2>
            <i className="home-diamond" />
            The stadium flywheel · 5-stage economic engine
          </h2>
          <span>
            <span className="home-pulse" />
            Mock POKE live · 2% casual fee · 90% cup prize split
          </span>
        </div>
        <div className="home-flywheel-grid">
          {flywheel.map(item => (
            <article key={item.step}>
              <header>
                <span>{item.step}</span>
                <small>{item.lane}</small>
              </header>
              <strong>{item.title}</strong>
              <p>{item.copy}</p>
              <div>{item.stat}</div>
            </article>
          ))}
        </div>
      </section>

      <div className="home-boards">
        <section>
          <div className="home-section-head">
            <h2>
              <i className="home-dot" />
              Live on the board
            </h2>
            <Link href="/arena">View Arena →</Link>
          </div>
          {boardRooms.length ? (
            boardRooms.map(room => <BoardCard key={room.id} room={room} />)
          ) : (
            <p className="home-empty">No open challenges right now.</p>
          )}
        </section>

        <section>
          <div className="home-section-head">
            <h2>
              <i className="home-dot home-dot-green" />
              Treasury audit
            </h2>
            <span>Mock POKE</span>
          </div>
          <div className="home-treasury">
            <div className="home-treasury-hero">
              <small>Live vault on the board</small>
              <strong>{vault ? formatPoke(vault) : '—'}</strong>
              <p>
                <span>{prizePool ? `${formatPoke(prizePool)} in cups` : 'No cup prize yet'}</span>
                <span>{livePot ? `${formatPoke(livePot)} in open pots` : 'No casual pots'}</span>
              </p>
            </div>
            <div className="home-treasury-grid">
              <div>
                <small>Distributed (recent)</small>
                <strong>{paidOut ? formatPoke(paidOut) : '—'}</strong>
                <span>Casual winner payouts</span>
              </div>
              <div>
                <small>Active tournaments</small>
                <strong>{fundedCups} funded</strong>
                <span>On the radar</span>
              </div>
            </div>
            <div className="home-treasury-meta">
              <div><span>Casual fee</span><strong>2%</strong></div>
              <div><span>Cup prize share</span><strong>90%</strong></div>
              <div><span>Stadium ops</span><strong>10%</strong></div>
            </div>
            <Link href="/tournaments">Open tournament ledger →</Link>
          </div>
        </section>
      </div>

      <section className="home-radar">
        <div className="home-section-head">
          <h2>
            <i className="home-diamond home-diamond-coral" />
            Tournaments radar
          </h2>
          <Link href="/tournaments">View all tournaments →</Link>
        </div>
        {featuredEvent ? (
          <article className="home-major">
            <span className="home-major-bar" aria-hidden />
            <div className="home-major-body">
              <div className="home-major-id">
                <span className="home-major-seal" aria-hidden>♛</span>
                <div>
                  <small>{formatLabel(featuredEvent.format)} · Championship event</small>
                  <h3>{featuredEvent.title}</h3>
                  {featuredEvent.winner ? <p>Champion {featuredEvent.winner}</p> : null}
                </div>
              </div>
              <dl>
                <div>
                  <dt>{featuredField?.label}</dt>
                  <dd>{featuredField?.value}</dd>
                  {featuredField?.hint ? <small>{featuredField.hint}</small> : null}
                </div>
                <div>
                  <dt>Prize pool</dt>
                  <dd>{formatPoke(featuredEvent.economics.prizePool)}</dd>
                </div>
                <div>
                  <dt>Entry</dt>
                  <dd>{formatPoke(featuredEvent.entryFee)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {eventStatus(featuredEvent)}
                    {featuredEvent.status === 'registration' ? <i className="home-pulse" /> : null}
                  </dd>
                </div>
              </dl>
              <div className="home-major-actions">
                <Link className="home-cta-ghost" href={`/tournament/${featuredEvent.id}`}>Watch bracket</Link>
                {featuredEvent.status === 'registration' ? (
                  <Link className="home-cta-register" href={`/tournament/${featuredEvent.id}`}>Register now</Link>
                ) : null}
              </div>
            </div>
          </article>
        ) : (
          <p className="home-empty">No cup on deck yet.</p>
        )}
        {minorEvents.length ? (
          <div className="home-minors">
            {minorEvents.map(event => (
              <article key={event.id}>
                <header>
                  <span>{formatLabel(event.format)}</span>
                  <small>{eventStatus(event)}</small>
                </header>
                <h4>{event.title}</h4>
                <p>{event.winner ? `Champion ${event.winner}` : `${event.playerCount}/${event.maxPlayers} on the field.`}</p>
                <footer>
                  <div>
                    <small>Pool</small>
                    <strong>{formatPoke(event.economics.prizePool)}</strong>
                  </div>
                  <Link href={`/tournament/${event.id}`}>
                    {event.status === 'registration' ? `JOIN ${formatPoke(event.entryFee)} →` : 'WATCH →'}
                  </Link>
                </footer>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
