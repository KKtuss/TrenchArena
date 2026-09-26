'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CompetitivePaths, TournamentEconomicsBlock } from '@/components/ui';
import { TeamStrip, TrainerSprite } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import type { CasualRoom, TournamentSummary } from '@/lib/protocol';
import { readSavedTeam, type SavedTeam } from '@/lib/team';
import { trainerName } from '@/lib/trainers';

function formatLabel(format: string): string {
  return format === 'gen9ou' ? 'GEN 9 OU' : format.toUpperCase();
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

function Dots({ filled, tone }: { filled: number; tone: 'cyan' | 'coral' }) {
  return (
    <span className={`pa-dots pa-dots-${tone}`} aria-hidden>
      {Array.from({ length: 6 }, (_, index) => (
        <i key={index} className={index < filled ? 'on' : ''} />
      ))}
    </span>
  );
}

export default function LandingPage() {
  const { client, playerId, snapshot, refreshSnapshot } = useArena();
  const [saved, setSaved] = useState<SavedTeam | null>(null);

  useEffect(() => {
    void Promise.all([
      client.request({ type: 'casual.list' }),
      client.request({ type: 'tournament.list' }),
    ]).then(() => refreshSnapshot());
  }, [client, refreshSnapshot]);

  useEffect(() => {
    setSaved(readSavedTeam(playerId));
  }, [playerId]);

  const rooms = [...(snapshot?.openCasualRooms ?? [])].sort((a, b) => roomRank(a) - roomRank(b));
  const featured = rooms[0];
  const board = rooms.slice(0, 3);
  const tournaments = snapshot?.tournaments ?? [];
  const flagship = tournaments.find(item => item.status !== 'completed') ?? tournaments[0];
  const minors = tournaments.filter(item => item.id !== flagship?.id).slice(0, 3);
  const paidOut = (snapshot?.recentCasualResults ?? []).reduce((sum, room) => sum + (room.payout?.amount ?? 0), 0);
  const waiting = featured ? !featured.opponentId : true;

  const flywheel = [
    { n: '01', tone: 'cyan', kicker: 'Source', title: 'Creator / Dev Rewards', copy: 'Token trading activity generates creator and developer rewards for the project.' },
    { n: '02', tone: 'sky', kicker: 'Allocate 90%', title: 'Tournament Treasury', copy: 'Ninety percent of those rewards fund the Tournament Treasury that banks competition prizes.' },
    { n: '03', tone: 'amber', kicker: 'Fund', title: 'Prize Pools', copy: 'Cups draw from the Treasury so players compete for substantial prizes without large collateral.' },
    { n: '04', tone: 'coral', kicker: 'Compete', title: 'Competitive Events', copy: 'Low-entry tournaments put Gen 9 OU brackets on the stadium calendar.' },
    { n: '05', tone: 'green', kicker: 'Reward', title: 'Players', copy: 'Champions take Treasury-funded prizes. Casual fights stay separate and player-funded.' },
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
        <p className="pa-kicker"><i /> — Battle Stadium • Gen 9 OU tier —</p>
        <h1>POKEARENA</h1>
        <p className="pa-tag">Battle. Compete. Climb.</p>
        <p className="pa-lead">
          Two competitive paths on one Showdown-synced stadium: stake your own POKE in casual fights, or enter low-cost cups for Treasury-funded prizes.
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

      <section className="pa-duel">
        <div className="pa-duel-rail">
          <div>
            <i className="pa-ping coral" />
            <strong>{featured ? (featured.status === 'battling' ? 'LIVE CASUAL FIGHT' : 'OPEN CASUAL CHALLENGE') : 'CASUAL BOARD OPEN'} • GEN 9 OU</strong>
            <span className="pa-chip">{featured ? featured.battleSize.toUpperCase() : '1V1'}</span>
          </div>
          <div>
            <span className="pa-chip amber">
              {featured ? `EACH ${formatPoke(featured.collateral)}` : flagship ? `ENTRY ${formatPoke(flagship.entryFee)}` : 'BOARD CLEAR'}
            </span>
          </div>
        </div>
        <div className="pa-duel-grid">
          <article className="pa-side cyan">
            <header>
              <div>
                <small>Challenger</small>
                <strong>{featured ? trainerName(featured.creatorId) : 'Open slot'}</strong>
              </div>
              <Dots filled={featured ? 3 : 0} tone="cyan" />
            </header>
            <div className="pa-mon">
              <span className="pa-portrait">
                <TrainerSprite label={featured ? trainerName(featured.creatorId) : 'Open slot'} />
              </span>
              <div>
                <div className="pa-mon-name">
                  <b>{featured ? formatLabel(featured.format) : 'Open slot'}</b>
                  <em>{featured ? 'LOCKED' : 'OPEN'}</em>
                </div>
                <div className="pa-bar"><span style={{ width: featured ? '100%' : '0%' }} /></div>
                <div className="pa-mon-meta"><span>{featured ? featured.status : 'Waiting'}</span><span>Gen 9</span></div>
              </div>
            </div>
            <div className="pa-pills">
              <span className="hot">{featured ? `${formatPoke(featured.collateral)} each` : 'No collateral'}</span>
              <span>Showdown</span>
              <span>OU</span>
            </div>
          </article>
          <div className="pa-vs">
            <span className="pa-bo">{featured ? `${featured.battleSize.toUpperCase()} MATCH` : 'AWAITING MATCH'}</span>
            <div className="pa-score">
              <i>VS</i>
            </div>
            <span className="pa-timer">{featured ? featured.status.toUpperCase() : 'BOARD CLEAR'}</span>
            <p className="pa-ticker">
              {featured
                ? <>{trainerName(featured.creatorId)} vs {featured.opponentId ? trainerName(featured.opponentId) : 'open slot'} · winner {formatPoke(featured.economics.winnerPayout)} after 2% start fee</>
                : 'No live fight on the board. Call a player-funded challenge from the Arena.'}
            </p>
          </div>
          <article className="pa-side coral">
            <header>
              <Dots filled={waiting ? 0 : 3} tone="coral" />
              <div>
                <small>Rival</small>
                <strong>{featured?.opponentId ? trainerName(featured.opponentId) : 'Open slot'}</strong>
              </div>
            </header>
            <div className="pa-mon foe">
              <span className="pa-portrait foe">
                <TrainerSprite label={featured?.opponentId ? trainerName(featured.opponentId) : 'Open slot'} />
              </span>
              <div>
                <div className="pa-mon-name">
                  <b>{waiting ? 'Open slot' : formatLabel(featured.format)}</b>
                  <em className="foe">{waiting ? 'OPEN' : 'READY'}</em>
                </div>
                <div className="pa-bar foe"><span style={{ width: waiting ? '0%' : '100%' }} /></div>
                <div className="pa-mon-meta"><span>{waiting ? 'Open queue' : 'Locked in'}</span><span>Gen 9</span></div>
              </div>
            </div>
            <div className="pa-pills end">
              <span className="hot foe">{featured ? `Winner ${formatPoke(featured.economics.winnerPayout)}` : 'No pool'}</span>
              <span>1v1</span>
            </div>
          </article>
        </div>
        <div className="pa-duel-foot">
          <div>
            {featured ? (
              <Link className="pa-btn pa-btn-primary pa-btn-sm" href={roomHref(featured)}>
                <i className="pa-ping" />
                {featured.status === 'open' ? 'Join fight' : 'Spectate full screen'}
              </Link>
            ) : (
              <Link className="pa-btn pa-btn-primary pa-btn-sm" href="/arena">Find a fight</Link>
            )}
            <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/casual/create">Create challenge</Link>
          </div>
          <span className="pa-cheer">
            {featured ? `Gross pool ${formatPoke(featured.economics.totalPot)}` : 'Casual board clear'}
          </span>
        </div>
      </section>

      <section className="pa-fly">
        <header>
          <div>
            <h2><span>◆</span> Two competitive paths</h2>
            <p>Casual is player-funded collateral. Tournaments are Treasury-funded prizes.</p>
          </div>
          <span className="pa-live-pill"><i /> POKE ledger</span>
        </header>
        <CompetitivePaths />
      </section>

      <section className="pa-fly" id="treasury">
        <header>
          <div>
            <h2><span>◆</span> Tournament flywheel</h2>
            <p>Creator and developer rewards fund cups. Casual collateral never enters this loop.</p>
          </div>
          <span className="pa-live-pill"><i /> 90% Treasury · 10% project</span>
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
          Separate track: casual fights take one 2% protocol fee from the gross player-funded pool at match start. No withdrawal tax.
        </p>
      </section>

      <section className="pa-split">
        <div>
          <header>
            <h2>Live casual board</h2>
            <span>{rooms.length} {rooms.length === 1 ? 'fight' : 'fights'}</span>
          </header>
          {board.length ? board.map(room => (
            <article key={room.id} className="pa-board">
              <div className="pa-board-mark">{room.format === 'gen9ou' ? 'OU' : 'PA'}</div>
              <div>
                <p className="pa-board-trainers">
                  <TrainerSprite label={trainerName(room.creatorId)} />
                  <b>{trainerName(room.creatorId)}</b>
                  <span>vs</span>
                  {room.opponentId ? <TrainerSprite label={trainerName(room.opponentId)} /> : null}
                  <b>{room.opponentId ? trainerName(room.opponentId) : 'Open slot'}</b>
                </p>
                <small>{formatLabel(room.format)} • {room.battleSize} • {room.status}</small>
              </div>
              <div className="pa-board-side">
                <strong>{formatPoke(room.collateral)}</strong>
                <small style={{ display: 'block', color: '#8ea0c0' }}>each</small>
                <Link href={roomHref(room)}>{room.status === 'open' ? 'Join' : 'Watch live'}</Link>
              </div>
            </article>
          )) : <p className="pa-empty">No open challenges right now.</p>}
        </div>
        <div id="treasury-audit">
          <header>
            <h2>Funding snapshot</h2>
            <span className="ok">Live ledger</span>
          </header>
          <div className="pa-vault">
            <div className="pa-vault-grid">
              <div>
                <small>Treasury prize targets</small>
                <strong>{flagship ? formatPoke(flagship.economics.prizePool) : '—'}</strong>
                <span>Treasury prize target on the calendar</span>
              </div>
              <div>
                <small>Recent casual payouts</small>
                <strong className="ok">{paidOut ? formatPoke(paidOut) : '—'}</strong>
                <span>Player-funded wins after start fee</span>
              </div>
            </div>
            <div className="pa-legend">
              <span><i className="escrow" /> Tournament Treasury 90%</span>
              <span><i className="ops" /> Project funds 10%</span>
              <span><i className="vault" /> Casual pools stay player-funded</span>
            </div>
            <div className="pa-contract">
              <span>Casual fee 2% at match start · no withdrawal tax</span>
              <span>Settled in POKE</span>
            </div>
            <Link href="/treasury">Open Treasury map</Link>
          </div>
        </div>
      </section>

      <section className="pa-radar">
        <header>
          <div>
            <h2><span>◆</span> Tournament radar</h2>
            <p>Low entry. Large competitive prize from the Tournament Treasury.</p>
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
              <p>{flagship.winner ? `Champion ${trainerName(flagship.winner)}` : `${formatLabel(flagship.format)} · ${flagship.playerCount}/${flagship.maxPlayers} on the field.`}</p>
              {flagship.playerCount > 0 ? (
                <div className="ps-field" aria-hidden>
                  {Array.from({ length: Math.min(flagship.playerCount, 4) }, (_, index) => (
                    <TrainerSprite key={index} label="" />
                  ))}
                </div>
              ) : null}
              <TournamentEconomicsBlock
                economics={flagship.economics}
                entryFee={flagship.entryFee}
                compact
              />
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
                  <p>{eventStatus(event)}{event.winner ? ` · ${trainerName(event.winner)}` : ''}</p>
                  <strong>Entry {formatPoke(event.entryFee)}</strong>
                  <span style={{ display: 'block', color: '#8ea0c0', fontSize: '0.7rem' }}>
                    Treasury prize {formatPoke(event.economics.prizePool)}
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
          <span className="pa-foot-mark">PA</span>
          <div>
            <strong>PokeArena Protocol</strong>
            <small>Competitive stadium engine for Gen 9 tier play. Showdown synced.</small>
          </div>
        </div>
        <div className="pa-foot-meta">
          <span>◆ POKE</span>
          <span>◆ Gen 9 OU</span>
          <span>◆ Live stadium</span>
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
